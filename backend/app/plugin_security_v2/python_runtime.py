"""Content-addressed Python runtime used by verified publisher sandboxes."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import sys
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import canonical_sha256

from .errors import security_error
from .storage import atomic_write_json, read_json, security_lock


PYTHON_RUNTIME_SCHEMA_VERSION = 1
_MODULE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$")
SANDBOX_PYTHON_BOOTSTRAP = (
    "import runpy,sys;"
    "site=sys.argv.pop(1);module=sys.argv.pop(1);"
    "sys.path.insert(0,site);"
    "runpy.run_module(module,run_name='__main__',alter_sys=True)"
)
_MAX_RUNTIME_FILES = 8_192
_MAX_RUNTIME_SOURCE_BYTES = 256 * 1024 * 1024


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _assert_source_file(path: Path, *, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
            f"{label} must be a regular non-symlink file",
        )


def _source_inventory(
    python_executable: Path,
) -> tuple[Path, tuple[tuple[Path, str], ...], tuple[tuple[Path, str], ...]]:
    if os.name != "nt":
        raise security_error(
            "PLUGIN_SANDBOX_UNAVAILABLE",
            "the pinned Python sandbox runtime is only available on Windows",
        )
    current = Path(sys.executable).resolve(strict=True)
    executable = python_executable.resolve(strict=True)
    try:
        same_executable = os.path.samefile(current, executable)
    except OSError:
        same_executable = False
    if not same_executable:
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_UNPINNED",
            "sandbox Python must match the current Host executable",
        )
    base = Path(sys.base_prefix).resolve(strict=True)
    base_executable = (base / "python.exe").resolve(strict=True)
    _assert_source_file(executable, label="Host Python executable")
    _assert_source_file(base_executable, label="Host base Python executable")
    dll_directory = base / "DLLs"
    library_directory = base / "Lib"
    if (
        base.is_symlink()
        or dll_directory.is_symlink()
        or library_directory.is_symlink()
        or not dll_directory.is_dir()
        or not library_directory.is_dir()
    ):
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
            "Host Python runtime directories are unavailable or unsafe",
        )

    copied: list[tuple[Path, str]] = [(base_executable, "python.exe")]
    copied.extend(
        (item, item.name)
        for item in sorted(base.glob("*.dll"), key=lambda path: path.name.casefold())
    )
    copied.extend(
        (item, (Path("DLLs") / item.relative_to(dll_directory)).as_posix())
        for item in sorted(dll_directory.rglob("*"), key=lambda path: path.as_posix())
        if item.is_file()
    )
    standard_library: list[tuple[Path, str]] = []
    for item in sorted(library_directory.rglob("*"), key=lambda path: path.as_posix()):
        relative = item.relative_to(library_directory)
        if (
            not item.is_file()
            or "site-packages" in relative.parts
            or "__pycache__" in relative.parts
            or item.suffix.casefold() in {".pyc", ".pyo"}
        ):
            continue
        standard_library.append((item, relative.as_posix()))

    inventory = (*copied, *standard_library)
    if len(inventory) > _MAX_RUNTIME_FILES:
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_LIMIT_EXCEEDED",
            "Host Python runtime contains too many files",
        )
    total = 0
    seen: set[str] = set()
    for source, relative in inventory:
        _assert_source_file(source, label=f"Host Python runtime file {relative}")
        if (
            relative in seen
            or relative.startswith("/")
            or "\\" in relative
            or ".." in Path(relative).parts
        ):
            raise security_error(
                "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
                "Host Python runtime inventory is ambiguous",
            )
        seen.add(relative)
        total += source.stat().st_size
    if total > _MAX_RUNTIME_SOURCE_BYTES:
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_LIMIT_EXCEEDED",
            "Host Python runtime exceeds the source byte limit",
        )
    return base, tuple(copied), tuple(standard_library)


def _source_identity(
    copied: tuple[tuple[Path, str], ...],
    standard_library: tuple[tuple[Path, str], ...],
) -> tuple[str, list[dict[str, Any]]]:
    records = [
        {
            "path": relative,
            "sha256": _sha256(source),
            "size": source.stat().st_size,
            "storage": storage,
        }
        for storage, values in (
            ("file", copied),
            ("stdlib-archive", standard_library),
        )
        for source, relative in values
    ]
    identity = canonical_sha256(
        {
            "schemaVersion": PYTHON_RUNTIME_SCHEMA_VERSION,
            "pythonVersion": (
                f"{sys.version_info.major}.{sys.version_info.minor}."
                f"{sys.version_info.micro}"
            ),
            "files": records,
        }
    )
    return identity, records


def _destination_files(root: Path) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if path.is_symlink():
            raise security_error(
                "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
                "cached Python runtime contains a symlink",
            )
        if not path.is_file() or path.name == "runtime-manifest-v1.json":
            continue
        values.append(
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": _sha256(path),
                "size": path.stat().st_size,
            }
        )
    return values


def _validate_cached_runtime(
    root: Path,
    identity: str,
    source_records: list[dict[str, Any]],
) -> None:
    manifest_path = root / "runtime-manifest-v1.json"
    _assert_source_file(
        manifest_path,
        label="sandbox Python runtime manifest",
    )
    manifest = read_json(
        manifest_path,
        "sandbox Python runtime manifest",
    )
    destination_files = _destination_files(root)
    if (
        not isinstance(manifest, dict)
        or set(manifest)
        != {
            "schemaVersion",
            "identitySha256",
            "pythonVersion",
            "files",
        }
        or manifest["schemaVersion"] != PYTHON_RUNTIME_SCHEMA_VERSION
        or manifest["identitySha256"] != identity
        or manifest["pythonVersion"]
        != f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        or not isinstance(manifest["files"], list)
        or manifest["files"] != destination_files
    ):
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
            "cached Python runtime failed its immutable manifest check",
        )
    if any(
        not isinstance(item, dict)
        or set(item) != {"path", "sha256", "size", "storage"}
        or not isinstance(item["path"], str)
        or not isinstance(item["sha256"], str)
        or not isinstance(item["size"], int)
        for item in source_records
    ):
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
            "sandbox Python source inventory is invalid",
        )
    copied = {
        item["path"]: item for item in source_records if item["storage"] == "file"
    }
    standard_library = [
        item for item in source_records if item["storage"] == "stdlib-archive"
    ]
    if len({item["path"] for item in source_records}) != len(source_records) or len(
        copied
    ) + len(standard_library) != len(source_records):
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
            "sandbox Python source inventory has an unsupported storage class",
        )
    archive_name = f"python{sys.version_info.major}{sys.version_info.minor}.zip"
    destination_by_path = {item["path"]: item for item in destination_files}
    if set(destination_by_path) != {*copied, archive_name} or any(
        destination_by_path[path]["sha256"] != record["sha256"]
        or destination_by_path[path]["size"] != record["size"]
        for path, record in copied.items()
    ):
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
            "cached Python executable or DLL content does not match the Host source",
        )
    try:
        with zipfile.ZipFile(root / archive_name, "r") as archive:
            entries = archive.infolist()
            if archive.comment or [item.filename for item in entries] != [
                item["path"] for item in standard_library
            ]:
                raise security_error(
                    "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
                    "cached Python standard-library archive inventory is invalid",
                )
            for entry, expected in zip(entries, standard_library, strict=True):
                if (
                    entry.is_dir()
                    or entry.compress_type != zipfile.ZIP_STORED
                    or entry.date_time != (1980, 1, 1, 0, 0, 0)
                    or entry.flag_bits != 0
                    or entry.extra
                    or entry.comment
                    or entry.external_attr != 0o444 << 16
                    or entry.file_size != expected["size"]
                ):
                    raise security_error(
                        "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
                        "cached Python standard-library archive metadata is invalid",
                    )
                digest = hashlib.sha256()
                with archive.open(entry, "r") as stream:
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                if f"sha256:{digest.hexdigest()}" != expected["sha256"]:
                    raise security_error(
                        "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
                        "cached Python standard-library content does not match the Host source",
                    )
    except (OSError, zipfile.BadZipFile) as exc:
        raise security_error(
            "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
            "cached Python standard-library archive is invalid",
        ) from exc


@dataclass(frozen=True, slots=True)
class PinnedPythonRuntime:
    root: Path
    executable: Path
    identity_sha256: str

    def command(
        self,
        *,
        site_packages: Path,
        module: str,
    ) -> tuple[Path, tuple[str, ...]]:
        site = site_packages.resolve(strict=True)
        if not site.is_dir() or site.is_symlink() or _MODULE.fullmatch(module) is None:
            raise security_error(
                "PLUGIN_SANDBOX_PYTHON_COMMAND_INVALID",
                "sandbox Python site-packages or module is invalid",
            )
        return (
            self.executable,
            (
                "-I",
                "-u",
                "-c",
                SANDBOX_PYTHON_BOOTSTRAP,
                str(site),
                module,
            ),
        )


def prepare_pinned_python_runtime(
    cache_root: Path | str,
    python_executable: Path | str,
) -> PinnedPythonRuntime:
    root = Path(cache_root).resolve(strict=False)
    executable = Path(python_executable)
    _base, copied, standard_library = _source_inventory(executable)
    identity, source_records = _source_identity(copied, standard_library)
    runtime_root = root / identity.removeprefix("sha256:")[:20]
    lock_path = root / ".python-runtime-v1.lock"
    with security_lock(lock_path, timeout_seconds=180.0):
        if runtime_root.exists():
            if runtime_root.is_symlink() or not runtime_root.is_dir():
                raise security_error(
                    "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID",
                    "cached Python runtime path is unsafe",
                )
            _validate_cached_runtime(runtime_root, identity, source_records)
        else:
            root.mkdir(parents=True, exist_ok=True)
            staging = root / f".runtime-{uuid.uuid4().hex}.part"
            try:
                staging.mkdir()
                for source, relative in copied:
                    destination = staging.joinpath(*relative.split("/"))
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
                archive = (
                    staging
                    / f"python{sys.version_info.major}{sys.version_info.minor}.zip"
                )
                with zipfile.ZipFile(
                    archive,
                    "w",
                    compression=zipfile.ZIP_STORED,
                    allowZip64=False,
                ) as output:
                    for source, relative in standard_library:
                        info = zipfile.ZipInfo(relative, (1980, 1, 1, 0, 0, 0))
                        info.compress_type = zipfile.ZIP_STORED
                        info.external_attr = 0o444 << 16
                        output.writestr(info, source.read_bytes())
                manifest = {
                    "schemaVersion": PYTHON_RUNTIME_SCHEMA_VERSION,
                    "identitySha256": identity,
                    "pythonVersion": (
                        f"{sys.version_info.major}.{sys.version_info.minor}."
                        f"{sys.version_info.micro}"
                    ),
                    "files": _destination_files(staging),
                }
                atomic_write_json(
                    staging / "runtime-manifest-v1.json",
                    manifest,
                    replace_existing=False,
                )
                os.rename(staging, runtime_root)
            except BaseException:
                shutil.rmtree(staging, ignore_errors=True)
                raise
            _validate_cached_runtime(runtime_root, identity, source_records)
    runtime_executable = runtime_root / "python.exe"
    _assert_source_file(runtime_executable, label="cached sandbox Python executable")
    return PinnedPythonRuntime(runtime_root, runtime_executable, identity)
