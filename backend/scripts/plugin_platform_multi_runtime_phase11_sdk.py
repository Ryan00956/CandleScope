#!/usr/bin/env python3
"""Run Phase 11 lint/test/build/package smoke for every published SDK."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from datetime import UTC, datetime
from email import policy
from email.parser import Parser
from pathlib import Path
from typing import Any, Mapping


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PYTHON_SDK = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk"
JAVA_SDK = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-java"
NODE_SDK = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-typescript"
WASM_SDK = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-rust-wasm"
WASM_REFERENCE = REPOSITORY_ROOT / "examples" / "plugin-platform-wasm-rust"
CANONICAL_TRANSCRIPT = (
    PYTHON_SDK / "tests" / "fixtures" / "hello_command_transcript_v2.json"
)
SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase11-sdk/1"


class SdkGateError(RuntimeError):
    pass


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def run(
    command: list[str],
    *,
    cwd: Path,
    timeout: float = 600,
    environment: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    if environment:
        env.update(environment)
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
        shell=False,
    )
    if completed.returncode:
        raise SdkGateError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n"
            + completed.stdout[-8000:]
        )
    return completed


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def last_output_line(completed: subprocess.CompletedProcess[str]) -> str:
    lines = completed.stdout.strip().splitlines()
    return lines[-1] if lines else "pass"


def _wheel_archive_check(path: Path) -> dict[str, Any]:
    """Validate wheel metadata and RECORD without an unpinned release dependency."""

    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if not names or len(names) != len(set(names)):
            raise SdkGateError("Python SDK wheel is empty or contains duplicate paths")
        for name in names:
            parts = Path(name.replace("\\", "/")).parts
            if (
                "\\" in name
                or name.startswith("/")
                or any(part in {"", ".", ".."} for part in parts)
            ):
                raise SdkGateError(
                    f"Python SDK wheel contains an unsafe path: {name!r}"
                )

        metadata_names = [
            name for name in names if name.endswith(".dist-info/METADATA")
        ]
        wheel_names = [name for name in names if name.endswith(".dist-info/WHEEL")]
        record_names = [name for name in names if name.endswith(".dist-info/RECORD")]
        if not (len(metadata_names) == len(wheel_names) == len(record_names) == 1):
            raise SdkGateError(
                "Python SDK wheel must contain one METADATA, WHEEL, and RECORD"
            )

        metadata_text = archive.read(metadata_names[0]).decode("utf-8", errors="strict")
        metadata = Parser(policy=policy.default).parsestr(metadata_text)
        expected_metadata = {
            "Name": "candlescope-plugin-sdk",
            "Version": "0.2.0",
            "Requires-Python": ">=3.11",
            "License-Expression": "GPL-3.0-only",
            "Description-Content-Type": "text/markdown",
        }
        for key, expected in expected_metadata.items():
            if metadata.get(key) != expected:
                raise SdkGateError(
                    f"Python SDK wheel metadata {key} is {metadata.get(key)!r}, expected {expected!r}"
                )
        if not metadata.get_payload().strip():
            raise SdkGateError("Python SDK wheel metadata description is empty")

        wheel_lines = set(
            archive.read(wheel_names[0]).decode("utf-8", errors="strict").splitlines()
        )
        for required in (
            "Wheel-Version: 1.0",
            "Root-Is-Purelib: true",
            "Tag: py3-none-any",
        ):
            if required not in wheel_lines:
                raise SdkGateError(f"Python SDK wheel is missing {required!r}")

        rows = list(
            csv.reader(
                io.StringIO(
                    archive.read(record_names[0]).decode("utf-8", errors="strict")
                )
            )
        )
        if any(len(row) != 3 for row in rows):
            raise SdkGateError("Python SDK wheel RECORD contains a malformed row")
        records = {row[0]: (row[1], row[2]) for row in rows}
        if len(records) != len(rows) or set(records) != set(names):
            raise SdkGateError(
                "Python SDK wheel RECORD inventory does not match the archive"
            )
        for name in names:
            encoded_hash, encoded_size = records[name]
            if name == record_names[0]:
                if encoded_hash or encoded_size:
                    raise SdkGateError(
                        "Python SDK wheel RECORD self-entry must be unhashed"
                    )
                continue
            payload = archive.read(name)
            expected_hash = "sha256=" + base64.urlsafe_b64encode(
                hashlib.sha256(payload).digest()
            ).rstrip(b"=").decode("ascii")
            if encoded_hash != expected_hash or encoded_size != str(len(payload)):
                raise SdkGateError(f"Python SDK wheel RECORD mismatch for {name!r}")

        required_members = {
            "candlescope_plugin_sdk/__init__.py",
            "candlescope_plugin_sdk/runtime.py",
            "candlescope_plugin_sdk/server.py",
            "candlescope_plugin_sdk/platform_v2/__init__.py",
            "candlescope_plugin_sdk/platform_v2/schemas/manifest-v2.schema.json",
            "candlescope_plugin_sdk/platform_v2/schemas/manifest-v3.schema.json",
        }
        if missing := sorted(required_members - set(names)):
            raise SdkGateError(
                f"Python SDK wheel is missing required members: {missing}"
            )

    return {
        "result": "pass",
        "metadata": expected_metadata,
        "archiveMembers": len(names),
        "recordEntries": len(records),
        "recordHashesVerified": len(records) - 1,
    }


def _python_sdk(
    test_python: Path,
    build_python: Path,
    ruff: Path,
    root: Path,
) -> dict[str, Any]:
    tests = run([str(test_python), "-m", "pytest", "-q"], cwd=PYTHON_SDK)
    lint = run([str(ruff), "check", "."], cwd=PYTHON_SDK)
    formatting = run([str(ruff), "format", "--check", "."], cwd=PYTHON_SDK)
    toolchain = run(
        [
            str(build_python),
            "-c",
            (
                "import importlib.metadata as m, json, platform; "
                "print(json.dumps({'python': platform.python_version(), "
                "'build': m.version('build'), 'hatchling': m.version('hatchling')}, "
                "sort_keys=True, separators=(',', ':')))"
            ),
        ],
        cwd=PYTHON_SDK,
    )
    wheels: list[Path] = []
    for index in range(2):
        output = root / f"python-wheel-{index}"
        output.mkdir()
        run(
            [
                str(build_python),
                "-m",
                "build",
                "--wheel",
                "--no-isolation",
                "--outdir",
                str(output),
            ],
            cwd=PYTHON_SDK,
            environment={"SOURCE_DATE_EPOCH": "1785715200"},
        )
        values = list(output.glob("candlescope_plugin_sdk-*.whl"))
        if len(values) != 1:
            raise SdkGateError("Python SDK build did not produce exactly one wheel")
        wheels.append(values[0])
    if wheels[0].read_bytes() != wheels[1].read_bytes():
        raise SdkGateError("two clean Python SDK wheel builds differ")
    package_validation = _wheel_archive_check(wheels[0])
    smoke = run(
        [
            str(test_python),
            str(PYTHON_SDK / "scripts" / "package_smoke.py"),
            "--dist-dir",
            str(wheels[0].parent),
            "--python",
            str(test_python),
        ],
        cwd=PYTHON_SDK,
        timeout=300,
    )
    return {
        "result": "pass",
        "toolchain": json.loads(last_output_line(toolchain)),
        "tests": last_output_line(tests),
        "lint": last_output_line(lint),
        "format": last_output_line(formatting),
        "wheelSha256": sha256_path(wheels[0]),
        "wheelSize": wheels[0].stat().st_size,
        "reproducibleBuilds": 2,
        "packageValidation": package_validation,
        "packageSmoke": last_output_line(smoke),
    }


def _java_sdk(python: Path, jdk_home: Path, root: Path) -> dict[str, Any]:
    packages: list[Path] = []
    reports: list[dict[str, Any]] = []
    for index in range(2):
        package = root / f"candlescope-plugin-sdk-java-{index}.jar"
        completed = run(
            [
                str(python),
                "-X",
                "utf8",
                str(JAVA_SDK / "scripts" / "check.py"),
                "--jdk-home",
                str(jdk_home),
                "--python-transcript",
                str(CANONICAL_TRANSCRIPT),
                "--package-output",
                str(package),
                "--json",
            ],
            cwd=REPOSITORY_ROOT,
            timeout=300,
        )
        reports.append(json.loads(completed.stdout.strip().splitlines()[-1]))
        packages.append(package)
    if packages[0].read_bytes() != packages[1].read_bytes() or reports[0] != reports[1]:
        raise SdkGateError("two clean Java SDK package builds differ")
    if reports[0].get("result") != "pass":
        raise SdkGateError("Java SDK package smoke did not pass")
    version = run([str(jdk_home / "bin" / "javac.exe"), "-version"], cwd=JAVA_SDK)
    return {
        **reports[0],
        "compiler": version.stdout.strip(),
        "reproducibleBuilds": 2,
    }


def _node_sdk(python: Path, node: Path) -> dict[str, Any]:
    completed = run(
        [
            str(python),
            str(NODE_SDK / "scripts" / "check.py"),
            "--node",
            str(node),
            "--tsc",
            str(REPOSITORY_ROOT / "frontend/node_modules/typescript/bin/tsc"),
            "--type-roots",
            str(REPOSITORY_ROOT / "frontend/node_modules/@types"),
            "--python-transcript",
            str(CANONICAL_TRANSCRIPT),
        ],
        cwd=REPOSITORY_ROOT,
        timeout=300,
    )
    report = json.loads(completed.stdout.strip().splitlines()[-1])
    if (
        report.get("result") != "pass"
        or report.get("serve", {}).get("stdoutIsolation") is not True
    ):
        raise SdkGateError("TypeScript SDK package smoke did not pass")
    return report


def _wasm_sdk(python: Path, cargo: Path, wasmtime: Path, root: Path) -> dict[str, Any]:
    target = root / "cargo-target"
    env = {"CARGO_TARGET_DIR": str(target)}
    fmt = run([str(cargo), "+1.97.1", "fmt", "--check"], cwd=WASM_SDK)
    clippy = run(
        [str(cargo), "+1.97.1", "clippy", "--locked", "--", "-D", "warnings"],
        cwd=WASM_SDK,
        environment=env,
    )
    tests = run(
        [str(cargo), "+1.97.1", "test", "--locked"],
        cwd=WASM_SDK,
        environment=env,
    )
    build = run(
        [str(cargo), "+1.97.1", "build", "--release", "--locked"],
        cwd=WASM_SDK,
        environment=env,
    )
    package = run(
        [
            str(cargo),
            "+1.97.1",
            "package",
            "--locked",
            "--allow-dirty",
            "--no-verify",
        ],
        cwd=WASM_SDK,
        environment=env,
    )
    crates = list((target / "package").glob("candlescope-plugin-sdk-wasm-*.crate"))
    if len(crates) != 1:
        raise SdkGateError("Rust/WASM SDK package did not produce exactly one crate")
    reference = run(
        [
            str(python),
            str(WASM_REFERENCE / "scripts" / "build_release.py"),
            "--cargo",
            str(cargo),
            "--wasmtime",
            str(wasmtime),
        ],
        cwd=REPOSITORY_ROOT,
        timeout=300,
    )
    report = json.loads(reference.stdout.strip().splitlines()[-1])
    if report.get("result") != "pass" or report.get("transcriptResponses") != 12:
        raise SdkGateError("Rust/WASM reference package smoke did not pass")
    return {
        "result": "pass",
        "format": last_output_line(fmt),
        "clippy": last_output_line(clippy),
        "tests": last_output_line(tests),
        "build": last_output_line(build),
        "package": last_output_line(package),
        "crateSha256": sha256_path(crates[0]),
        "crateSize": crates[0].stat().st_size,
        "reference": report,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-python", type=Path, required=True)
    parser.add_argument("--sdk-python", type=Path, required=True)
    parser.add_argument("--sdk-build-python", type=Path, required=True)
    parser.add_argument("--ruff", type=Path, required=True)
    parser.add_argument("--jdk-home", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--cargo", type=Path, required=True)
    parser.add_argument("--wasmtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    for item in (
        args.backend_python,
        args.sdk_python,
        args.sdk_build_python,
        args.ruff,
        args.node,
        args.cargo,
        args.wasmtime,
        CANONICAL_TRANSCRIPT,
    ):
        item.resolve(strict=True)
    args.jdk_home.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="candlescope-phase11-sdk-") as raw:
        root = Path(raw)
        result = {
            "schemaVersion": SCHEMA_VERSION,
            "result": "pass",
            "generatedAt": datetime.now(UTC)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
            "canonicalTranscriptSha256": strict_transcript_digest(),
            "python": _python_sdk(
                args.sdk_python,
                args.sdk_build_python,
                args.ruff,
                root,
            ),
            "java": _java_sdk(args.backend_python, args.jdk_home, root),
            "typescript": _node_sdk(args.backend_python, args.node),
            "wasm": _wasm_sdk(args.backend_python, args.cargo, args.wasmtime, root),
        }
    atomic_json(args.output.resolve(strict=False), result)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


def strict_transcript_digest() -> str:
    value = json.loads(CANONICAL_TRANSCRIPT.read_text(encoding="utf-8"))
    digest = value.get("expected", {}).get("transcriptSha256")
    if (
        digest
        != "sha256:d98ebd2fc9f5b0695925caf47ecf961eae47a56b5e8ec110f28acc9365afdd38"
    ):
        raise SdkGateError("canonical transcript digest changed")
    return digest


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SdkGateError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(
            json.dumps(
                {"ok": False, "errorType": type(exc).__name__, "message": str(exc)},
                ensure_ascii=False,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
