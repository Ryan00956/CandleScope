#!/usr/bin/env python3
"""Build the reviewed aho-corasick Adapter twice, offline and byte-identically."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
ADAPTER_ROOT = HERE.parent
REPOSITORY_ROOT = HERE.parents[3]
LOCK_PATH = ADAPTER_ROOT / "supply-chain.lock.json"
TARGET = "x86_64-pc-windows-msvc"
BINARY_NAME = "candlescope-aho-corasick-adapter.exe"
EXPECTED_RUSTC = "rustc 1.97.1 (8bab26f4f 2026-07-14)"
EXPECTED_CARGO = "cargo 1.97.1 (c980f4866 2026-06-30)"
CANONICAL_REPOSITORY_ROOT = "/candlescope/source"
CANONICAL_CARGO_HOME = "/cargo/home"


def digest(path: Path) -> tuple[str, int]:
    value = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
            size += len(chunk)
    return f"sha256:{value.hexdigest()}", size


def checked_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"JSON root must be an object: {path}")
    return value


def tool_version(executable: str) -> str:
    result = subprocess.run(
        [executable, "--version"],
        cwd=ADAPTER_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def verify_file(path: Path, expected: dict[str, Any], label: str) -> None:
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"missing immutable {label}: {path}")
    actual = digest(path)
    wanted = (str(expected["sha256"]), int(expected["size"]))
    if actual != wanted:
        raise SystemExit(f"{label} mismatch: expected={wanted}, actual={actual}")


def cargo_home() -> Path:
    raw = os.environ.get("CARGO_HOME")
    return Path(raw).expanduser().resolve() if raw else Path.home() / ".cargo"


def verify_registry_cache(lock: dict[str, Any]) -> None:
    cache_root = cargo_home() / "registry" / "cache"
    for dependency in lock["dependencies"]:
        filename = str(dependency["file"])
        candidates = sorted(cache_root.glob(f"*/{filename}"))
        matching = [path for path in candidates if digest(path) == (
            str(dependency["sha256"]),
            int(dependency["size"]),
        )]
        if len(matching) != 1:
            raise SystemExit(
                f"immutable crate cache entry is missing or ambiguous: {filename}"
            )


def verify_inputs(lock: dict[str, Any]) -> None:
    if lock.get("schemaVersion") != "candlescope.aho-corasick-build-lock/1":
        raise SystemExit("unsupported supply-chain lock schema")
    if lock.get("target") != TARGET or lock.get("networkAccessDuringBuild") is not False:
        raise SystemExit("supply-chain lock target or offline policy changed")
    if tool_version("rustc") != EXPECTED_RUSTC or tool_version("cargo") != EXPECTED_CARGO:
        raise SystemExit("Rust toolchain is not the reviewed 1.97.1 release")
    for item in lock["inputs"]:
        relative = Path(*str(item["path"]).split("/"))
        base = REPOSITORY_ROOT if item.get("root") == "repository" else ADAPTER_ROOT
        verify_file(base / relative, item, f"build input {item['path']}")
    verify_registry_cache(lock)


def build_environment() -> dict[str, str]:
    environment = os.environ.copy()
    # Host-provided flags would invalidate the reviewed build. Cargo's encoded
    # form preserves each argument without shell parsing, retains MSVC /Brepro,
    # and removes checkout/user paths from panic-location strings.
    environment.pop("RUSTFLAGS", None)
    environment.pop("CARGO_ENCODED_RUSTFLAGS", None)
    rustflags = [
        "-C",
        "link-arg=/Brepro",
        f"--remap-path-prefix={REPOSITORY_ROOT}={CANONICAL_REPOSITORY_ROOT}",
        f"--remap-path-prefix={cargo_home()}={CANONICAL_CARGO_HOME}",
    ]
    environment.update(
        {
            "CARGO_INCREMENTAL": "0",
            "CARGO_ENCODED_RUSTFLAGS": "\x1f".join(rustflags),
            "CARGO_NET_OFFLINE": "true",
            "SOURCE_DATE_EPOCH": "1767225600",
        }
    )
    return environment


def build_once(cargo: str, target_dir: Path) -> Path:
    environment = build_environment()
    subprocess.run(
        [
            cargo,
            "build",
            "--locked",
            "--offline",
            "--release",
            "--target",
            TARGET,
            "--target-dir",
            str(target_dir),
        ],
        cwd=ADAPTER_ROOT,
        env=environment,
        check=True,
    )
    output = target_dir / TARGET / "release" / BINARY_NAME
    if not output.is_file() or output.is_symlink():
        raise SystemExit(f"Cargo did not produce the expected executable: {output}")
    return output


def publish(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    shutil.copyfile(source, temporary)
    os.replace(temporary, destination)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=ADAPTER_ROOT / "runtime" / "adapter.exe",
    )
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    lock = checked_json(LOCK_PATH)
    verify_inputs(lock)
    cargo = shutil.which("cargo")
    if cargo is None:
        raise SystemExit("cargo is unavailable")
    with tempfile.TemporaryDirectory(prefix="candlescope-aho-build-a-") as first_value:
        with tempfile.TemporaryDirectory(prefix="candlescope-aho-build-b-") as second_value:
            first = build_once(cargo, Path(first_value))
            second = build_once(cargo, Path(second_value))
            first_digest = digest(first)
            second_digest = digest(second)
            if first_digest != second_digest:
                raise SystemExit(
                    "release executable is not byte-reproducible across isolated target dirs: "
                    f"first={first_digest}, second={second_digest}"
                )
            expected = lock["releaseArtifact"]
            wanted = (str(expected["sha256"]), int(expected["size"]))
            if first_digest != wanted:
                raise SystemExit(
                    f"release executable changed from the reviewed lock: expected={wanted}, "
                    f"actual={first_digest}"
                )
            output = arguments.output.expanduser().resolve()
            publish(first, output)
    report = {
        "schemaVersion": "candlescope.aho-corasick-build-report/1",
        "networkAccessDuringBuild": False,
        "reproducibleBuilds": 2,
        "sourceDateEpoch": 1767225600,
        "target": TARGET,
        "toolchain": {"cargo": EXPECTED_CARGO, "rustc": EXPECTED_RUSTC},
        "output": {
            "path": output.name,
            "sha256": first_digest[0],
            "size": first_digest[1],
        },
    }
    text = json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if arguments.report is not None:
        report_path = arguments.report.expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
