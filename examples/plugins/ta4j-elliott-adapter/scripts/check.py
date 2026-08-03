#!/usr/bin/env python3
"""Compile and run the independent ta4j adapter semantic suite offline."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

from build_release import (
    ADAPTER_ROOT,
    SDK_ROOT,
    checked_dependencies,
    compile_sources,
    dependency_legal_name,
    digest,
    java_tool,
)


TEST_MAIN = "io.candlescope.plugins.ta4j.elliott.AdapterSelfTest"


def validate_release_legal_artifacts(
    lock: dict[str, object], dependencies: list[Path]
) -> list[str]:
    adapter = dict(lock["adapter"])
    release = ADAPTER_ROOT / str(adapter["releaseJar"])
    if not release.is_file() or release.is_symlink():
        raise SystemExit(f"fixed Adapter release JAR is unavailable: {release}")
    actual_release = digest(release)
    expected_release = (
        str(adapter["releaseJarSha256"]),
        int(adapter["releaseJarSize"]),
    )
    if actual_release != expected_release:
        raise SystemExit(
            "fixed Adapter release JAR identity changed: "
            f"expected={expected_release}, actual={actual_release}"
        )

    expected_payloads: dict[str, bytes] = {}
    for path in sorted(
        (ADAPTER_ROOT / "licenses").iterdir(), key=lambda value: value.name
    ):
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"unsafe Adapter legal artifact: {path}")
        expected_payloads[f"META-INF/licenses/{path.name}"] = path.read_bytes()
    repository_license = ADAPTER_ROOT.parents[2] / "LICENSE"
    expected_payloads["META-INF/licenses/GPL-3.0-only.txt"] = (
        repository_license.read_bytes()
    )
    for dependency in dependencies:
        with zipfile.ZipFile(dependency, "r") as upstream:
            for record in upstream.infolist():
                relocated = dependency_legal_name(dependency, record.filename)
                if relocated is not None:
                    expected_payloads[relocated] = upstream.read(record)

    with zipfile.ZipFile(release, "r") as archive:
        for name, expected in expected_payloads.items():
            try:
                actual = archive.read(name)
            except KeyError as error:
                raise SystemExit(f"release JAR omits legal artifact: {name}") from error
            if actual != expected:
                raise SystemExit(f"release JAR changed legal artifact bytes: {name}")
    return sorted(expected_payloads)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jdk-home", type=Path, required=True)
    parser.add_argument("--dependency-cache", type=Path, required=True)
    parser.add_argument("--actual-output", type=Path)
    arguments = parser.parse_args()

    lock = json.loads(
        (ADAPTER_ROOT / "supply-chain.lock.json").read_text(encoding="utf-8")
    )
    dependencies = checked_dependencies(arguments.dependency_cache.resolve(), lock)
    legal_artifacts = validate_release_legal_artifacts(lock, dependencies)
    javac = java_tool(arguments.jdk_home.resolve(), "javac")
    java = java_tool(arguments.jdk_home.resolve(), "java")
    with tempfile.TemporaryDirectory(prefix="candlescope-ta4j-check-") as value:
        classes = Path(value) / "classes"
        compile_sources(
            javac,
            classes,
            [
                SDK_ROOT / "src" / "main" / "java",
                ADAPTER_ROOT / "src" / "main" / "java",
                ADAPTER_ROOT / "src" / "test" / "java",
            ],
            classpath=dependencies,
            release=25,
        )
        completed = subprocess.run(
            (
                str(java),
                "-Dfile.encoding=UTF-8",
                "-Djava.awt.headless=true",
                "-Xms32m",
                "-Xmx512m",
                "-cp",
                os.pathsep.join((str(classes), *(str(path) for path in dependencies))),
                TEST_MAIN,
            ),
            cwd=ADAPTER_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            timeout=90,
            check=False,
        )
    if completed.returncode:
        raise SystemExit(
            f"adapter self-test failed ({completed.returncode}): {completed.stderr[-4000:]}"
        )
    if len(completed.stdout.encode("utf-8")) > 256 * 1024:
        raise SystemExit("adapter self-test stdout exceeds its evidence limit")
    report = json.loads(completed.stdout)
    if arguments.actual_output is not None:
        arguments.actual_output.write_text(
            json.dumps(
                report,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
    golden = json.loads(
        (ADAPTER_ROOT / "evidence" / "golden-corpus.json").read_text(encoding="utf-8")
    )
    if report.get("schemaVersion") != "candlescope.ta4j-adapter-self-test/1":
        raise SystemExit("adapter self-test returned another schema")
    if report.get("casesSha256") != golden.get("casesSha256"):
        raise SystemExit(
            "adapter golden corpus digest changed: "
            f"expected={golden.get('casesSha256')}, "
            f"actual={report.get('casesSha256')}"
        )
    actual_cases = report.get("cases")
    expected_cases = golden.get("cases")
    if not isinstance(actual_cases, list) or not isinstance(expected_cases, list):
        raise SystemExit("adapter golden cases have an invalid shape")
    projected = [
        {key: actual[key] for key in expected}
        for actual, expected in zip(actual_cases, expected_cases, strict=True)
    ]
    if projected != expected_cases:
        raise SystemExit("adapter golden case projection changed")
    if report.get("boundaries") != {
        "maxBarsAnalyzed": 5000,
        "overMaxBarsRejected": True,
        "numericType": "DecimalNum",
        "maxTimestampSeconds": 253_402_297_199,
    }:
        raise SystemExit("adapter numeric/history/timestamp boundaries changed")
    report["legalArtifacts"] = legal_artifacts
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
