from __future__ import annotations

import hashlib
import json
import stat
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from app.plugin_runtime.bundle import (
    MANIFEST_PATH,
    PluginBundleError,
    build_plugin_bundle,
    inspect_plugin_bundle,
    sha256_file,
    verify_plugin_bundle,
)
from app.plugin_runtime.installer_cli import main as installer_cli_main
from tests.plugin_runtime_bundle_testkit import (
    REPOSITORY_ROOT,
    build_hello_bundle,
    build_hello_wheel,
    hello_manifest,
)


def _zip_info(name: str, *, symlink: bool = False) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    mode = stat.S_IFLNK | 0o777 if symlink else stat.S_IFREG | 0o644
    info.external_attr = mode << 16
    return info


def test_builder_is_deterministic_and_bundle_is_strictly_inspectable(
    tmp_path: Path,
) -> None:
    fixture = build_hello_bundle(tmp_path / "first")
    second = tmp_path / "second.cspkg"
    rebuilt = build_plugin_bundle(
        fixture.manifest_path,
        (fixture.wheel_path,),
        second,
    )

    assert fixture.bundle.path.read_bytes() == rebuilt.path.read_bytes()
    assert fixture.bundle.sha256 == rebuilt.sha256
    inspected = inspect_plugin_bundle(second)
    assert inspected.manifest.runtime_id == "hello-runtime"
    assert inspected.manifest.version == "0.1.0"
    assert inspected.manifest.wheels[0].package == "candlescope-plugin-sdk"

    extracted = inspected.extract_wheels(tmp_path / "extracted")
    assert len(extracted) == 1
    assert sha256_file(extracted[0]) == inspected.manifest.wheels[0].sha256


def test_install_verification_requires_the_callers_expected_bundle_hash(
    tmp_path: Path,
) -> None:
    fixture = build_hello_bundle(tmp_path)

    with pytest.raises(PluginBundleError, match="requires an expected SHA-256"):
        verify_plugin_bundle(fixture.bundle.path, expected_sha256=None)
    with pytest.raises(PluginBundleError, match="SHA-256 mismatch"):
        verify_plugin_bundle(fixture.bundle.path, expected_sha256="0" * 64)


def test_builder_refuses_overwrite_and_wheel_metadata_drift(tmp_path: Path) -> None:
    wheel = build_hello_wheel(tmp_path / "wheelhouse")
    manifest = hello_manifest(wheel)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    output = tmp_path / "plugin.cspkg"
    build_plugin_bundle(manifest_path, (wheel,), output)

    with pytest.raises(PluginBundleError, match="already exists"):
        build_plugin_bundle(manifest_path, (wheel,), output)

    manifest["plugin"]["version"] = "9.9.9"
    manifest["wheels"][0]["version"] = "9.9.9"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(PluginBundleError, match="declares version"):
        build_plugin_bundle(
            manifest_path,
            (wheel,),
            tmp_path / "metadata-drift.cspkg",
        )


@pytest.mark.parametrize(
    ("unsafe_name", "symlink"),
    [
        ("../escape.whl", False),
        ("wheels/CON.whl", False),
        ("wheels/link.whl", True),
    ],
)
def test_bundle_rejects_unsafe_or_symlink_entries(
    tmp_path: Path,
    unsafe_name: str,
    symlink: bool,
) -> None:
    path = tmp_path / "unsafe.cspkg"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(_zip_info(MANIFEST_PATH), b"{}")
        archive.writestr(_zip_info(unsafe_name, symlink=symlink), b"target")

    with pytest.raises(PluginBundleError):
        verify_plugin_bundle(path, expected_sha256=sha256_file(path))


def test_bundle_rejects_entries_not_declared_by_manifest(tmp_path: Path) -> None:
    fixture = build_hello_bundle(tmp_path / "source")
    path = tmp_path / "extra.cspkg"
    with (
        zipfile.ZipFile(fixture.bundle.path, "r") as source,
        zipfile.ZipFile(path, "w") as target,
    ):
        for info in source.infolist():
            target.writestr(info, source.read(info))
        target.writestr(_zip_info("unexpected.txt"), b"no")

    with pytest.raises(PluginBundleError, match="do not match") as captured:
        verify_plugin_bundle(path, expected_sha256=sha256_file(path))
    assert captured.value.details == {"extra": ["unexpected.txt"], "missing": []}


def test_bundle_rejects_duplicate_json_keys(tmp_path: Path) -> None:
    path = tmp_path / "duplicate.cspkg"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            _zip_info(MANIFEST_PATH),
            b'{"schemaVersion":1,"schemaVersion":1}',
        )

    with pytest.raises(PluginBundleError, match="duplicate JSON object key"):
        verify_plugin_bundle(path, expected_sha256=sha256_file(path))


def test_extraction_detects_bundle_change_after_inspection(tmp_path: Path) -> None:
    fixture = build_hello_bundle(tmp_path)
    inspected = inspect_plugin_bundle(fixture.bundle.path)
    original = fixture.bundle.path.read_bytes()
    fixture.bundle.path.write_bytes(original + b"changed")

    with pytest.raises(PluginBundleError, match="changed after verification"):
        inspected.extract_wheels(tmp_path / "extracted")


def test_sha256_file_matches_standard_digest(tmp_path: Path) -> None:
    path = tmp_path / "value.bin"
    path.write_bytes(b"candlescope")
    assert sha256_file(path) == f"sha256:{hashlib.sha256(b'candlescope').hexdigest()}"


def test_cli_inspect_emits_pinnable_compact_json(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fixture = build_hello_bundle(tmp_path)

    assert installer_cli_main(["--json", "inspect", str(fixture.bundle.path)]) == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert captured.err == ""
    assert payload["ok"] is True
    assert payload["bundle"]["sha256"] == fixture.bundle.sha256
    assert payload["bundle"]["manifest"]["plugin"]["id"] == "hello-runtime"


def test_documented_hello_manifest_template_builds(tmp_path: Path) -> None:
    wheel = build_hello_wheel(tmp_path / "wheelhouse")
    manifest = (
        REPOSITORY_ROOT
        / "packages"
        / "candlescope-plugin-sdk"
        / "examples"
        / "hello-runtime.manifest.json"
    )

    bundle = build_plugin_bundle(manifest, (wheel,), tmp_path / "hello.cspkg")
    assert bundle.manifest.runtime_id == "hello-runtime"
    assert bundle.manifest.probe.analysis_sha256.endswith("88f3c5b")


def test_failed_wheel_extraction_removes_partial_targets(tmp_path: Path) -> None:
    fixture = build_hello_bundle(tmp_path / "source")
    wheel = fixture.bundle.manifest.wheels[0]
    bad_manifest = replace(
        fixture.bundle.manifest,
        wheels=(replace(wheel, sha256="sha256:" + "0" * 64),),
    )
    inconsistent = replace(fixture.bundle, manifest=bad_manifest)
    destination = tmp_path / "extracted"

    with pytest.raises(PluginBundleError, match="failed SHA-256"):
        inconsistent.extract_wheels(destination)
    assert not any(destination.iterdir())


def test_builder_validates_temporary_bundle_before_force_replace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fixture = build_hello_bundle(tmp_path)
    previous = fixture.bundle.path.read_bytes()

    def write_corrupt_wheel(
        archive: zipfile.ZipFile,
        archive_path: str,
        _source_path: Path,
    ) -> None:
        archive.writestr(archive_path, b"corrupt")

    monkeypatch.setattr(
        "app.plugin_runtime.bundle._write_stored_file",
        write_corrupt_wheel,
    )
    with pytest.raises(PluginBundleError, match="size does not match"):
        build_plugin_bundle(
            fixture.manifest_path,
            (fixture.wheel_path,),
            fixture.bundle.path,
            force=True,
        )

    assert fixture.bundle.path.read_bytes() == previous
