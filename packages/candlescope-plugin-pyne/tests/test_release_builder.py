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
            "Requires-Python: >=3.11\n"
            "\n"
        ).encode("utf-8"),
        f"{dist_info}/WHEEL": (
            "Wheel-Version: 1.0\n"
            "Generator: CandleScope tests\n"
            "Root-Is-Purelib: true\n"
            "Tag: py3-none-any\n"
            "\n"
        ).encode("utf-8"),
    }
    record_path = f"{dist_info}/RECORD"
    record_output = io.StringIO(newline="")
    writer = csv.writer(record_output, lineterminator="\n")
    for path, data in sorted(entries.items()):
        writer.writerow((path, _record_hash(data), len(data)))
    writer.writerow((record_path, "", ""))
    entries[record_path] = record_output.getvalue().encode("utf-8")
    with zipfile.ZipFile(output, "w") as archive:
        for path, data in sorted(entries.items()):
            archive.writestr(_zip_info(path), data)
    return output


def _wheelhouse(tmp_path: Path) -> tuple[Path, ...]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    return (
        _fake_wheel(tmp_path, "candlescope-plugin-pyne", "0.1.0"),
        _fake_wheel(tmp_path, "candlescope-plugin-sdk", "0.1.0"),
        _fake_wheel(tmp_path, "pyne-runtime", "0.2.0rc1"),
        _fake_wheel(tmp_path, "numpy", "2.3.3"),
    )


def test_wheel_metadata_is_read_from_the_archive_not_the_filename(tmp_path: Path) -> None:
    wheel = _fake_wheel(tmp_path, "candlescope-plugin-pyne", "0.1.0")
    renamed = wheel.with_name("untrusted-name.whl")
    wheel.rename(renamed)

    record = inspect_wheel(renamed)

    assert record.package == "candlescope-plugin-pyne"
    assert record.version == "0.1.0"
    assert record.sha256.startswith("sha256:")


def test_default_lock_rejects_a_same_version_but_different_pyne_wheel(
    tmp_path: Path,
) -> None:
    wheels = _wheelhouse(tmp_path)

    with pytest.raises(ReleaseLockError, match="pinned GitHub Release artifact"):
        collect_locked_wheels(wheels, load_release_lock())


def test_builder_generates_audited_platform_bundle_from_one_locked_wheel_set(
    tmp_path: Path,
) -> None:
    wheels = _wheelhouse(tmp_path / "wheelhouse")
    lock = json.loads(DEFAULT_LOCK_PATH.read_text(encoding="utf-8"))
    lock["wheels"]["pyne-runtime"]["sha256"] = inspect_wheel(wheels[2]).sha256
    lock_path = tmp_path / "release-lock.json"
    lock_path.write_text(json.dumps(lock, indent=2), encoding="utf-8")
    output = tmp_path / "candlescope-pyne-0.1.0.cspkg"

    bundle = build_locked_bundle(wheels, output, lock_path=lock_path)

    assert bundle.path == output.resolve()
    assert bundle.manifest.runtime_id == "candlescope.pyne"
    assert bundle.manifest.package == "candlescope-plugin-pyne"
    assert bundle.manifest.version == "0.1.0"
    assert bundle.manifest.module == "candlescope_plugin_pyne"
    assert [wheel.package for wheel in bundle.manifest.wheels] == [
        "candlescope-plugin-pyne",
        "candlescope-plugin-sdk",
        "pyne-runtime",
        "numpy",
    ]
    assert bundle.manifest.probe.analysis_sha256 == lock["probe"]["analysisSha256"]
    assert bundle.manifest.probe.execution_sha256 == lock["probe"]["executionSha256"]


def test_cli_reports_lock_failures_without_a_traceback(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    wheels = _wheelhouse(tmp_path / "wheelhouse")
    output = tmp_path / "rejected.cspkg"
    argv: list[str] = []
    for wheel in wheels:
        argv.extend(("--wheel", str(wheel)))
    argv.extend(("--output", str(output), "--json"))

    assert main(argv) == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert captured.err == ""
    assert payload["ok"] is False
    assert payload["error"]["code"] == "PYNE_BUNDLE_BUILD_FAILED"
    assert "pinned GitHub Release artifact" in payload["error"]["message"]
    assert not output.exists()
