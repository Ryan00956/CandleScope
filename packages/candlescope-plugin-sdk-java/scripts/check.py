#!/usr/bin/env python3
"""Compile and run the dependency-free Java SDK contract suite."""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def tool(home: Path, name: str) -> Path:
    candidate = (home / "bin" / (name + (".exe" if os.name == "nt" else ""))).resolve()
    if not candidate.is_file() or candidate.is_symlink():
        raise SystemExit(f"missing JDK tool: {candidate}")
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jdk-home", type=Path, required=True)
    parser.add_argument("--python-transcript", type=Path, required=True)
    arguments = parser.parse_args()
    sources = sorted(
        [
            *ROOT.joinpath("src", "main", "java").rglob("*.java"),
            *ROOT.joinpath("src", "test", "java").rglob("*.java"),
        ],
        key=lambda value: value.as_posix(),
    )
    with tempfile.TemporaryDirectory(prefix="candlescope-java-sdk-") as value:
        classes = Path(value) / "classes"
        classes.mkdir()
        subprocess.run(
            [
                str(tool(arguments.jdk_home.resolve(), "javac")),
                "-encoding",
                "UTF-8",
                "-g:none",
                "--release",
                "17",
                "-d",
                str(classes),
                *(str(source) for source in sources),
            ],
            check=True,
            cwd=ROOT,
        )
        completed = subprocess.run(
            [
                str(tool(arguments.jdk_home.resolve(), "java")),
                "-cp",
                str(classes),
                "io.candlescope.plugin.sdk.v2.SdkSelfTest",
                str(arguments.python_transcript.resolve()),
            ],
            check=True,
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    if completed.stdout.strip() != "candlescope-plugin-sdk-java self-test: PASS":
        raise SystemExit(f"unexpected Java SDK result: {completed.stdout!r}")
    print(completed.stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
