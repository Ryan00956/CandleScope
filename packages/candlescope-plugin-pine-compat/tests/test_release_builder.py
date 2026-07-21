from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import stat
import zipfile
from pathlib import Path

import pytest

from scripts.build_bundle import (
    DEFAULT_LOCK_PATH,
    ReleaseLockError,
    build_locked_bundle,
    collect_locked_wheels,
    inspect_wheel,
    load_release_lock,
    main,
)


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def _record_hash(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={digest.decode('ascii')}"


def _fake_wheel(directory: Path, package: str, version: str) -> Path:
    normalized = package.replace("-", "_")
    output = directory / f"{normalized}-{version}-py3-none-any.whl"
    dist_info = f"{normalized}-{version}.dist-info"
    entries = {
        f"{normalized}/__init__.py": b"\n",
        f"{dist_info}/METADATA": (
            "Metadata-Version: 2.4\n"
            f"Name: {package}\n"
            f"Version: {version}\n"
            "Requires-Python: >=3.11\n\n"
        ).encode(),
        f"{dist_info}/WHEEL": (
            "Wheel-Version: 1.0\nGenerator: CandleScope tests\n"
            "Root-Is-Purelib: true\nTag: py3-none-any\n\n"
        ).encode(),
    }
    record_path = f"{dist_info}/RECORD"
    record_output = io.StringIO(newline="")
    writer = csv.writer(record_output, lineterminator="\n")
    for path, data in sorted(entries.items()):
        writer.writerow((path, _record_hash(data), len(data)))
    writer.writerow((record_path, "", ""))
    entries[record_path] = record_output.getvalue().encode()
    with zipfile.ZipFile(output, "w") as archive:
        for path, data in sorted(entries.items()):
            archive.writestr(_zip_info(path), data)
    return output


def _wheelhouse(path: Path) -> tuple[Path, ...]:
    path.mkdir(parents=True, exist_ok=True)
    return (
        _fake_wheel(path, "candlescope-plugin-pine-compat", "0.2.0"),
        _fake_wheel(path, "candlescope-plugin-sdk", "0.2.0"),
        _fake_wheel(path, "pine-compat-runtime", "0.2.0"),
    )


def test_builder_rejects_same_version_unpinned_engine_wheel(tmp_path: Path) -> None:
    with pytest.raises(ReleaseLockError, match="pinned GitHub Release asset"):
        collect_locked_wheels(_wheelhouse(tmp_path), load_release_lock())


def test_builder_generates_three_wheel_phase8_bundle(tmp_path: Path) -> None:
    wheels = _wheelhouse(tmp_path / "wheels")
    lock = json.loads(DEFAULT_LOCK_PATH.read_text(encoding="utf-8"))
    lock["wheels"]["pine-compat-runtime"]["sha256"] = inspect_wheel(wheels[2]).sha256
    lock_path = tmp_path / "release-lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")

    bundle = build_locked_bundle(
        wheels,
        tmp_path / "pine.cspkg",
        lock_path=lock_path,
    )

    assert bundle.manifest.runtime_id == "candlescope.pine-compat"
    assert bundle.manifest.module == "candlescope_plugin_pine_compat"
    assert [item.package for item in bundle.manifest.wheels] == [
        "candlescope-plugin-pine-compat",
        "candlescope-plugin-sdk",
        "pine-compat-runtime",
    ]
    assert bundle.manifest.probe.analysis_sha256 == lock["probe"]["analysisSha256"]


def test_cli_reports_lock_failure_without_traceback(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    wheels = _wheelhouse(tmp_path / "wheels")
    argv: list[str] = []
    for wheel in wheels:
        argv.extend(("--wheel", str(wheel)))
    argv.extend(("--output", str(tmp_path / "bad.cspkg"), "--json"))

    assert main(argv) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "PINE_COMPAT_BUNDLE_BUILD_FAILED"
    assert "pinned GitHub Release asset" in payload["error"]["message"]
