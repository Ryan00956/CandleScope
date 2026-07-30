"""Build the platform-specific Pine compatibility bundle from locked wheels."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from email.parser import BytesParser
from pathlib import Path
from typing import Any


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PACKAGE_ROOT.parents[1]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE_ROOT = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
DEFAULT_LOCK_PATH = PACKAGE_ROOT / "release" / "release-lock.json"
EXPECTED_WHEEL_ORDER = (
    "candlescope-plugin-pine-compat",
    "candlescope-plugin-sdk",
    "pine-compat-runtime",
)
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")

for source_root in (SDK_SOURCE_ROOT, BACKEND_ROOT):
    if str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))

from app.plugin_runtime.bundle import VerifiedBundle, build_plugin_bundle  # noqa: E402
from app.plugin_runtime.errors import PluginBundleError  # noqa: E402


class ReleaseLockError(ValueError):
    """The release lock and supplied wheelhouse do not describe one release."""


@dataclass(frozen=True, slots=True)
class WheelRecord:
    path: Path
    package: str
    version: str
    sha256: str


def _normalize_package(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value.strip()).lower()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def load_release_lock(path: Path = DEFAULT_LOCK_PATH) -> dict[str, Any]:
    try:
        lock = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReleaseLockError(f"unable to read release lock: {exc}") from exc
    if not isinstance(lock, dict) or lock.get("schemaVersion") != 1:
        raise ReleaseLockError("release lock schemaVersion must be 1")
    plugin = lock.get("plugin")
    python = lock.get("python")
    wheels = lock.get("wheels")
    probe = lock.get("probe")
    if not all(isinstance(item, dict) for item in (plugin, python, wheels, probe)):
        raise ReleaseLockError("release lock sections are invalid")
    if plugin != {
        "id": "candlescope.pine-compat",
        "package": "candlescope-plugin-pine-compat",
        "version": "0.2.0",
    }:
        raise ReleaseLockError("release lock plugin identity is not the Phase 8 contract")
    assert isinstance(wheels, dict)
    if tuple(wheels) != EXPECTED_WHEEL_ORDER:
        raise ReleaseLockError(
            "release lock wheels must be ordered as bridge, SDK, and Pine engine"
        )
    for package, expected in wheels.items():
        if not isinstance(expected, dict) or not isinstance(expected.get("version"), str):
            raise ReleaseLockError(f"release lock wheel {package!r} is invalid")
    engine = wheels["pine-compat-runtime"]
    if not isinstance(engine.get("sha256"), str) or not _SHA256.fullmatch(engine["sha256"]):
        raise ReleaseLockError("release lock Pine engine wheel requires a SHA-256")
    for key in ("analysisSha256", "executionSha256"):
        value = probe.get(key)
        if not isinstance(value, str) or not _SHA256.fullmatch(value):
            raise ReleaseLockError(f"release lock probe.{key} is invalid")
    return lock


def inspect_wheel(path: Path | str) -> WheelRecord:
    wheel_path = Path(path).expanduser().resolve(strict=False)
    if not wheel_path.is_file() or wheel_path.suffix != ".whl":
        raise ReleaseLockError(f"input is not a wheel: {wheel_path}")
    try:
        with zipfile.ZipFile(wheel_path, "r") as archive:
            metadata_paths = [
                name
                for name in archive.namelist()
                if name.count("/") == 1 and name.endswith(".dist-info/METADATA")
            ]
            if len(metadata_paths) != 1:
                raise ReleaseLockError(
                    f"wheel {wheel_path.name!r} must contain one dist-info/METADATA"
                )
            metadata = BytesParser().parsebytes(archive.read(metadata_paths[0]))
    except (OSError, zipfile.BadZipFile, KeyError) as exc:
        raise ReleaseLockError(f"unable to inspect wheel {wheel_path.name!r}: {exc}") from exc
    package = metadata.get("Name")
    version = metadata.get("Version")
    if not isinstance(package, str) or not package.strip():
        raise ReleaseLockError(f"wheel {wheel_path.name!r} has no package name")
    if not isinstance(version, str) or not version.strip():
        raise ReleaseLockError(f"wheel {wheel_path.name!r} has no version")
    return WheelRecord(
        path=wheel_path,
        package=_normalize_package(package),
        version=version.strip(),
        sha256=_sha256_file(wheel_path),
    )


def collect_locked_wheels(
    wheel_paths: list[Path | str] | tuple[Path | str, ...],
    lock: dict[str, Any],
) -> tuple[WheelRecord, ...]:
    records: dict[str, WheelRecord] = {}
    for raw_path in wheel_paths:
        record = inspect_wheel(raw_path)
        if record.package in records:
            raise ReleaseLockError(f"duplicate wheel package: {record.package}")
        records[record.package] = record
    missing = sorted(set(EXPECTED_WHEEL_ORDER) - set(records))
    extra = sorted(set(records) - set(EXPECTED_WHEEL_ORDER))
    if missing or extra:
        raise ReleaseLockError(f"wheel set mismatch: missing={missing}, extra={extra}")
    locked = lock["wheels"]
    for package in EXPECTED_WHEEL_ORDER:
        if records[package].version != locked[package]["version"]:
            raise ReleaseLockError(
                f"{package} version mismatch: expected {locked[package]['version']}, "
                f"found {records[package].version}"
            )
    if records["pine-compat-runtime"].sha256 != locked["pine-compat-runtime"]["sha256"]:
        raise ReleaseLockError(
            "pine-compat-runtime wheel SHA-256 does not match the pinned GitHub Release asset"
        )
    return tuple(records[package] for package in EXPECTED_WHEEL_ORDER)


def _manifest(lock: dict[str, Any], wheels: tuple[WheelRecord, ...]) -> dict[str, Any]:
    plugin = lock["plugin"]
    return {
        "schemaVersion": 1,
        "plugin": {
            "id": plugin["id"],
            "name": "Pine Compatibility Runtime",
            "version": plugin["version"],
            "package": plugin["package"],
            "protocol": "candlescope.script-runtime/1",
        },
        "python": dict(lock["python"]),
        "wheels": [
            {
                "path": f"wheels/{record.path.name}",
                "package": record.package,
                "version": record.version,
            }
            for record in wheels
        ],
        "probe": dict(lock["probe"]),
    }


def build_locked_bundle(
    wheel_paths: list[Path | str] | tuple[Path | str, ...],
    output_path: Path | str,
    *,
    lock_path: Path = DEFAULT_LOCK_PATH,
    force: bool = False,
) -> VerifiedBundle:
    lock = load_release_lock(lock_path)
    wheels = collect_locked_wheels(wheel_paths, lock)
    with tempfile.TemporaryDirectory(prefix="candlescope-pine-compat-bundle-") as raw:
        manifest_path = Path(raw) / "manifest.json"
        manifest_path.write_text(
            json.dumps(_manifest(lock, wheels), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return build_plugin_bundle(
            manifest_path,
            tuple(record.path for record in wheels),
            output_path,
            force=force,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build a locked candlescope.pine-compat .cspkg"
    )
    parser.add_argument(
        "--wheel",
        action="append",
        required=True,
        type=Path,
        help="Repeat exactly three times: bridge, SDK, and Pine engine wheels.",
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        bundle = build_locked_bundle(args.wheel, args.output, force=args.force)
    except (PluginBundleError, ReleaseLockError) as exc:
        payload = {
            "ok": False,
            "error": {"code": "PINE_COMPAT_BUNDLE_BUILD_FAILED", "message": str(exc)},
        }
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1
    payload = {
        "ok": True,
        "path": str(bundle.path),
        "sha256": bundle.sha256,
        "size": bundle.size,
        "runtimeId": bundle.manifest.runtime_id,
        "version": bundle.manifest.version,
        "wheels": [wheel.to_wire() for wheel in bundle.manifest.wheels],
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    else:
        print(f"built {bundle.path}")
        print(f"sha256 {bundle.sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
