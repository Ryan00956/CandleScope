#!/usr/bin/env python3
"""Compile and run the dependency-free Java SDK contract suite."""

from __future__ import annotations

import argparse
import hashlib
import json
import locale
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = ROOT.parents[1]
FIXED_ZIP_TIME = (2026, 8, 3, 0, 0, 0)


def decode_tool_output(payload: bytes) -> str:
    for encoding in ("utf-8", locale.getpreferredencoding(False), "gb18030"):
        try:
            return payload.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return payload.decode("utf-8", errors="replace")


def run_compiler(command: list[str]) -> None:
    completed = subprocess.run(
        command,
        check=False,
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stdout = decode_tool_output(completed.stdout)
    stderr = decode_tool_output(completed.stderr)
    if completed.returncode:
        raise SystemExit(
            f"Java compiler failed ({completed.returncode})\nstdout:\n{stdout}\nstderr:\n{stderr}"
        )
    if stdout.strip() or stderr.strip():
        raise SystemExit(
            f"Java compiler emitted unexpected diagnostics\nstdout:\n{stdout}\nstderr:\n{stderr}"
        )


def tool(home: Path, name: str) -> Path:
    candidate = (home / "bin" / (name + (".exe" if os.name == "nt" else ""))).resolve()
    if not candidate.is_file() or candidate.is_symlink():
        raise SystemExit(f"missing JDK tool: {candidate}")
    return candidate


def deterministic_jar(classes: Path) -> bytes:
    entries = {
        path.relative_to(classes).as_posix(): path.read_bytes()
        for path in sorted(classes.rglob("*.class"), key=lambda value: value.as_posix())
    }
    entries.update(
        {
            "META-INF/MANIFEST.MF": (
                b"Manifest-Version: 1.0\r\n"
                b"Implementation-Title: candlescope-plugin-sdk-java\r\n"
                b"Implementation-Version: 0.1.0\r\n\r\n"
            ),
            "META-INF/LICENSE": (REPOSITORY_ROOT / "LICENSE").read_bytes(),
            "README_zh.md": (ROOT / "README_zh.md").read_bytes(),
        }
    )
    with tempfile.NamedTemporaryFile(suffix=".jar", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(
            temporary,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for name, payload in sorted(entries.items()):
                info = zipfile.ZipInfo(name, date_time=FIXED_ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                info.create_system = 3
                archive.writestr(info, payload)
        return temporary.read_bytes()
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jdk-home", type=Path, required=True)
    parser.add_argument("--python-transcript", type=Path, required=True)
    parser.add_argument("--package-output", type=Path)
    parser.add_argument("--json", action="store_true")
    arguments = parser.parse_args()
    main_sources = sorted(
        ROOT.joinpath("src", "main", "java").rglob("*.java"),
        key=lambda value: value.as_posix(),
    )
    test_sources = sorted(
        ROOT.joinpath("src", "test", "java").rglob("*.java"),
        key=lambda value: value.as_posix(),
    )
    with tempfile.TemporaryDirectory(prefix="candlescope-java-sdk-") as value:
        temporary = Path(value)
        main_classes = temporary / "main-classes"
        test_classes = temporary / "test-classes"
        main_classes.mkdir()
        test_classes.mkdir()
        run_compiler(
            [
                str(tool(arguments.jdk_home.resolve(), "javac")),
                "-encoding",
                "UTF-8",
                "-g:none",
                "-Xlint:all",
                "-Werror",
                "--release",
                "17",
                "-d",
                str(main_classes),
                *(str(source) for source in main_sources),
            ]
        )
        package = deterministic_jar(main_classes)
        package_path = temporary / "candlescope-plugin-sdk-java-0.1.0.jar"
        package_path.write_bytes(package)
        with zipfile.ZipFile(package_path, "r") as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or "META-INF/MANIFEST.MF" not in names:
                raise SystemExit("deterministic Java SDK JAR is malformed")
        run_compiler(
            [
                str(tool(arguments.jdk_home.resolve(), "javac")),
                "-encoding",
                "UTF-8",
                "-g:none",
                "-Xlint:all",
                "-Werror",
                "--release",
                "17",
                "-cp",
                str(package_path),
                "-d",
                str(test_classes),
                *(str(source) for source in test_sources),
            ]
        )
        completed = subprocess.run(
            [
                str(tool(arguments.jdk_home.resolve(), "java")),
                "-cp",
                os.pathsep.join((str(package_path), str(test_classes))),
                "io.candlescope.plugin.sdk.v2.SdkSelfTest",
                str(arguments.python_transcript.resolve()),
            ],
            check=True,
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        main_class_count = len(list(main_classes.rglob("*.class")))
        test_class_count = len(list(test_classes.rglob("*.class")))
        if arguments.package_output is not None:
            output = arguments.package_output.resolve(strict=False)
            output.parent.mkdir(parents=True, exist_ok=True)
            pending = output.with_name(f".{output.name}.tmp")
            pending.write_bytes(package)
            os.replace(pending, output)
    if completed.stdout.strip() != "candlescope-plugin-sdk-java self-test: PASS":
        raise SystemExit(f"unexpected Java SDK result: {completed.stdout!r}")
    package_sha256 = "sha256:" + hashlib.sha256(package).hexdigest()
    if arguments.json:
        print(
            json.dumps(
                {
                    "schemaVersion": "candlescope.plugin-sdk-java-check/1",
                    "result": "pass",
                    "sourceRelease": 17,
                    "mainClasses": main_class_count,
                    "testClasses": test_class_count,
                    "packageSha256": package_sha256,
                    "packageSize": len(package),
                    "deterministicJar": True,
                    "selfTest": completed.stdout.strip(),
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    else:
        print(completed.stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
