#!/usr/bin/env python3
"""Build the ta4j reference adapter as a deterministic, offline fat JAR."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


HERE = Path(__file__).resolve().parent
ADAPTER_ROOT = HERE.parent
REPOSITORY_ROOT = HERE.parents[3]
SDK_ROOT = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-java"
LOCK_PATH = ADAPTER_ROOT / "supply-chain.lock.json"
FIXED_ZIP_TIME = (2026, 8, 3, 0, 0, 0)
EXCLUDED_DEPENDENCY_PATHS = {
    "META-INF/MANIFEST.MF",
    "module-info.class",
}


def digest(path: Path) -> tuple[str, int]:
    value = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
            size += len(chunk)
    return f"sha256:{value.hexdigest()}", size


def checked_dependencies(cache: Path, lock: dict[str, object]) -> list[Path]:
    result: list[Path] = []
    for raw in lock["dependencies"]:
        item = dict(raw)
        path = cache / str(item["file"])
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"missing immutable dependency: {path}")
        actual = digest(path)
        expected = (str(item["sha256"]), int(item["size"]))
        if actual != expected:
            raise SystemExit(
                f"dependency mismatch for {path.name}: expected={expected}, actual={actual}"
            )
        result.append(path)
    return result


def java_tool(jdk_home: Path, name: str) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    path = (jdk_home / "bin" / f"{name}{suffix}").resolve()
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"JDK tool is unavailable: {path}")
    return path


def compile_sources(
    javac: Path,
    destination: Path,
    roots: list[Path],
    *,
    classpath: list[Path],
    release: int,
) -> None:
    sources = sorted(
        (source for root in roots for source in root.rglob("*.java")),
        key=lambda value: value.as_posix(),
    )
    if not sources:
        raise SystemExit("no Java sources were selected")
    destination.mkdir(parents=True, exist_ok=True)
    command = [
        str(javac),
        "-encoding",
        "UTF-8",
        "-g:none",
        "-parameters",
        "--release",
        str(release),
        "-d",
        str(destination),
    ]
    if classpath:
        command.extend(("-classpath", os.pathsep.join(str(path) for path in classpath)))
    command.extend(str(source) for source in sources)
    subprocess.run(command, check=True, cwd=REPOSITORY_ROOT)


def safe_dependency_name(raw: str) -> str | None:
    name = PurePosixPath(raw).as_posix()
    if (
        not name
        or name.endswith("/")
        or name.startswith("/")
        or "\\" in raw
        or ".." in PurePosixPath(name).parts
    ):
        return None
    upper = name.upper()
    if name in EXCLUDED_DEPENDENCY_PATHS:
        return None
    if upper.startswith("META-INF/VERSIONS/") and upper.endswith("/MODULE-INFO.CLASS"):
        return None
    if upper.startswith("META-INF/") and upper.endswith((".SF", ".RSA", ".DSA", ".EC")):
        return None
    if upper.startswith("META-INF/LICENSE") or upper.startswith("META-INF/NOTICE"):
        return None
    return name


def dependency_legal_name(dependency: Path, raw: str) -> str | None:
    """Relocate root dependency LICENSE/NOTICE files without losing attribution."""
    name = PurePosixPath(raw).as_posix()
    if (
        not name
        or name.endswith("/")
        or name.startswith("/")
        or "\\" in raw
        or ".." in PurePosixPath(name).parts
    ):
        return None
    parts = PurePosixPath(name).parts
    if len(parts) != 2 or parts[0].casefold() != "meta-inf":
        return None
    leaf = parts[1]
    upper = leaf.upper()
    if not (
        upper == "LICENSE"
        or upper.startswith("LICENSE.")
        or upper == "NOTICE"
        or upper.startswith("NOTICE.")
    ):
        return None
    return f"META-INF/licenses/upstream/{dependency.name}/{leaf}"


def zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def build_jar(
    output: Path,
    classes: Path,
    dependencies: list[Path],
    lock: dict[str, object],
) -> tuple[str, int]:
    entries: dict[str, bytes] = {}
    origins: dict[str, str] = {}

    def add(name: str, payload: bytes, origin: str) -> None:
        folded = name.casefold()
        previous = next((item for item in entries if item.casefold() == folded), None)
        if previous is not None:
            if entries[previous] == payload and name.startswith("META-INF/services/"):
                return
            raise SystemExit(
                f"fat JAR path collision: {name} ({origins[previous]} vs {origin})"
            )
        entries[name] = payload
        origins[name] = origin

    main_class = str(dict(lock["adapter"])["mainClass"])
    manifest = (
        "Manifest-Version: 1.0\r\n"
        f"Main-Class: {main_class}\r\n"
        "Implementation-Title: CandleScope ta4j Elliott Adapter\r\n"
        f"Implementation-Version: {dict(lock['adapter'])['version']}\r\n"
        "Multi-Release: true\r\n"
        "\r\n"
    ).encode("utf-8")
    add("META-INF/MANIFEST.MF", manifest, "adapter")
    for source in sorted(classes.rglob("*.class"), key=lambda value: value.as_posix()):
        add(source.relative_to(classes).as_posix(), source.read_bytes(), "adapter")
    for dependency in dependencies:
        with zipfile.ZipFile(dependency, "r") as archive:
            for record in sorted(archive.infolist(), key=lambda value: value.filename):
                if (
                    record.is_dir()
                    or stat.S_IFMT(record.external_attr >> 16) == stat.S_IFDIR
                ):
                    continue
                if record.flag_bits & 1:
                    raise SystemExit(
                        f"encrypted dependency entry: {dependency.name}:{record.filename}"
                    )
                legal_name = dependency_legal_name(dependency, record.filename)
                if legal_name is not None:
                    add(legal_name, archive.read(record), dependency.name)
                    continue
                name = safe_dependency_name(record.filename)
                if name is None:
                    continue
                add(name, archive.read(record), dependency.name)
    for license_path in sorted(
        (ADAPTER_ROOT / "licenses").iterdir(), key=lambda value: value.name
    ):
        if not license_path.is_file() or license_path.is_symlink():
            raise SystemExit(f"unsafe Adapter license artifact: {license_path}")
        add(
            f"META-INF/licenses/{license_path.name}",
            license_path.read_bytes(),
            "adapter",
        )
    add(
        "META-INF/licenses/GPL-3.0-only.txt",
        (REPOSITORY_ROOT / "LICENSE").read_bytes(),
        "adapter",
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    with zipfile.ZipFile(
        temporary,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        allowZip64=True,
    ) as archive:
        for name in sorted(entries):
            archive.writestr(zip_info(name), entries[name])
    os.replace(temporary, output)
    return digest(output)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jdk-home", type=Path, required=True)
    parser.add_argument("--dependency-cache", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=ADAPTER_ROOT / "runtime" / "ta4j-elliott-adapter-0.1.0.jar",
    )
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    dependencies = checked_dependencies(arguments.dependency_cache.resolve(), lock)
    javac = java_tool(arguments.jdk_home.resolve(), "javac")
    with tempfile.TemporaryDirectory(prefix="candlescope-ta4j-build-") as value:
        classes = Path(value) / "classes"
        compile_sources(
            javac,
            classes,
            [
                SDK_ROOT / "src" / "main" / "java",
                ADAPTER_ROOT / "src" / "main" / "java",
            ],
            classpath=dependencies,
            release=25,
        )
        output = arguments.output.resolve()
        output_sha256, output_size = build_jar(output, classes, dependencies, lock)
    adapter_lock = dict(lock["adapter"])
    expected_output = (
        str(adapter_lock["releaseJarSha256"]),
        int(adapter_lock["releaseJarSize"]),
    )
    if (output_sha256, output_size) != expected_output:
        output.unlink(missing_ok=True)
        raise SystemExit(
            "release JAR is not reproducible: "
            f"expected={expected_output}, actual={(output_sha256, output_size)}"
        )
    report = {
        "schemaVersion": "candlescope.ta4j-elliott-build/1",
        "sourceDate": "2026-08-03T00:00:00Z",
        "compiler": dict(lock["compiler"]),
        "dependencySha256": {path.name: digest(path)[0] for path in dependencies},
        "output": {
            "path": output.name,
            "sha256": output_sha256,
            "size": output_size,
        },
    }
    text = json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
