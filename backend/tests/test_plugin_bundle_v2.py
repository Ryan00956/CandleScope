from __future__ import annotations

import copy
import json
import platform
import stat
import zipfile
from pathlib import Path

import pytest

from candlescope_plugin_sdk.platform_v2 import canonical_dumps, loads_strict

from app.plugin_installer_v2.bundle import (
    BUNDLE_DESCRIPTOR_PATH,
    PlatformBundleError,
    build_platform_bundle,
    inspect_platform_bundle,
    sha256_file,
    verify_platform_bundle,
)
from app.plugin_runtime.bundle import inspect_plugin_bundle
from scripts.candlescope_plugin import main as plugin_cli_main
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle
from tests.plugin_runtime_bundle_testkit import build_hello_bundle


def _zip_info(
    name: str,
    *,
    symlink: bool = False,
    compression: int = zipfile.ZIP_STORED,
) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = compression
    info.create_system = 3
    mode = stat.S_IFLNK | 0o777 if symlink else stat.S_IFREG | 0o644
    info.external_attr = mode << 16
    return info


def _rewrite(
    source: Path,
    target: Path,
    *,
    replacements: dict[str, bytes] | None = None,
    additions: tuple[tuple[zipfile.ZipInfo, bytes], ...] = (),
) -> Path:
    replacements = replacements or {}
    with (
        zipfile.ZipFile(source, "r") as existing,
        zipfile.ZipFile(target, "w") as output,
    ):
        for info in existing.infolist():
            output.writestr(info, replacements.get(info.filename, existing.read(info)))
        for info, data in additions:
            output.writestr(info, data)
    return target


def test_v2_builder_is_deterministic_and_binds_every_payload(tmp_path: Path) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "first")
    rebuilt = build_platform_bundle(
        fixture.source_directory, tmp_path / "rebuilt.cspkg"
    )

    assert fixture.bundle.path.read_bytes() == rebuilt.path.read_bytes()
    assert fixture.bundle.sha256 == rebuilt.sha256
    assert fixture.bundle.manifest.plugin.id == "candlescope.hello-command"
    assert {item.kind for item in fixture.bundle.envelope.contents} == {
        "manifest",
        "wheel",
        "schema",
        "probe",
        "sbom",
    }
    assert fixture.bundle.envelope.probe_assets == (
        ("hello-transcript", "probes/hello-transcript.json"),
    )
    with zipfile.ZipFile(rebuilt.path, "r") as archive:
        descriptor = archive.read(BUNDLE_DESCRIPTOR_PATH)
        assert descriptor == (canonical_dumps(loads_strict(descriptor)) + "\n").encode()


def test_v1_and_v2_parsers_never_guess_an_upgrade(tmp_path: Path) -> None:
    legacy = build_hello_bundle(tmp_path / "legacy")
    platform_bundle = build_hello_platform_bundle(tmp_path / "platform")

    with pytest.raises(PlatformBundleError, match="bundle.json is absent"):
        inspect_platform_bundle(legacy.bundle.path)
    with pytest.raises(Exception, match="schemaVersion|unsupported fields"):
        inspect_plugin_bundle(platform_bundle.bundle.path)


@pytest.mark.parametrize(
    ("name", "info", "payload", "match"),
    [
        ("traversal", _zip_info("../escape.txt"), b"x", "unsafe|canonical"),
        ("case-conflict", _zip_info("MANIFEST.JSON"), b"{}", "case-conflicting"),
        ("symlink", _zip_info("web/link", symlink=True), b"target", "symbolic links"),
        ("extra", _zip_info("unexpected.txt"), b"x", "digest table"),
        (
            "zip-bomb",
            _zip_info("web/bomb.bin", compression=zipfile.ZIP_DEFLATED),
            b"0" * (2 * 1024 * 1024),
            "compression ratio",
        ),
    ],
    ids=("traversal", "case-conflict", "symlink", "extra", "zip-bomb"),
)
def test_v2_bundle_rejects_unsafe_extra_and_bomb_entries(
    tmp_path: Path,
    name: str,
    info: zipfile.ZipInfo,
    payload: bytes,
    match: str,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "source")
    attacked = _rewrite(
        fixture.bundle.path,
        tmp_path / f"{name}.cspkg",
        additions=((info, payload),),
    )
    with pytest.raises(PlatformBundleError, match=match):
        verify_platform_bundle(attacked, expected_sha256=sha256_file(attacked))


def test_v2_bundle_rejects_outer_and_inner_hash_drift(tmp_path: Path) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "source")
    with pytest.raises(PlatformBundleError, match="SHA-256 mismatch"):
        verify_platform_bundle(fixture.bundle.path, expected_sha256="0" * 64)

    tampered = _rewrite(
        fixture.bundle.path,
        tmp_path / "tampered.cspkg",
        replacements={"manifest.json": b'{"schemaVersion":2}\n'},
    )
    with pytest.raises(
        PlatformBundleError, match="SHA-256 verification|size does not match"
    ):
        verify_platform_bundle(tampered, expected_sha256=sha256_file(tampered))


def test_v2_bundle_rejects_noncanonical_descriptor_and_platform_mismatch(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "source")
    with zipfile.ZipFile(fixture.bundle.path, "r") as archive:
        descriptor = loads_strict(archive.read(BUNDLE_DESCRIPTOR_PATH))
    noncanonical = _rewrite(
        fixture.bundle.path,
        tmp_path / "noncanonical.cspkg",
        replacements={
            BUNDLE_DESCRIPTOR_PATH: json.dumps(descriptor, indent=2).encode("utf-8")
        },
    )
    with pytest.raises(PlatformBundleError, match="canonical JSON"):
        verify_platform_bundle(noncanonical, expected_sha256=sha256_file(noncanonical))

    mismatch = copy.deepcopy(descriptor)
    current = {"Windows": "windows", "Linux": "linux", "Darwin": "macos"}.get(
        platform.system(), platform.system().lower()
    )
    mismatch["compatibility"]["operatingSystems"] = sorted(
        {"windows", "linux", "macos"} - {current}
    )
    mismatched = _rewrite(
        fixture.bundle.path,
        tmp_path / "platform-mismatch.cspkg",
        replacements={
            BUNDLE_DESCRIPTOR_PATH: (canonical_dumps(mismatch) + "\n").encode("utf-8")
        },
    )
    with pytest.raises(PlatformBundleError, match="current platform"):
        verify_platform_bundle(mismatched, expected_sha256=sha256_file(mismatched))


def test_v2_builder_rejects_duplicate_manifest_ids(tmp_path: Path) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "source")
    manifest_path = fixture.source_directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["contributions"].append(copy.deepcopy(manifest["contributions"][0]))
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(PlatformBundleError, match="public SDK contract"):
        build_platform_bundle(fixture.source_directory, tmp_path / "duplicate.cspkg")


def test_v2_builder_rejects_sbom_that_omits_a_bundled_wheel(tmp_path: Path) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "source")
    sbom_path = fixture.source_directory / "sbom" / "cyclonedx.json"
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    sbom["components"] = []
    sbom_path.write_text(json.dumps(sbom), encoding="utf-8")

    with pytest.raises(PlatformBundleError, match="does not cover every bundled wheel"):
        build_platform_bundle(
            fixture.source_directory, tmp_path / "incomplete-sbom.cspkg"
        )


def test_v2_bundle_binds_declared_static_web_entry(tmp_path: Path) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "source")
    manifest_path = fixture.source_directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["frontend"] = {
        "assetsRoot": "web",
        "surfaces": [
            {
                "id": "main-view",
                "type": "declarative",
                "entry": "index.html",
                "slot": "main",
            }
        ],
    }
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    web = fixture.source_directory / "web"
    web.mkdir()
    (web / "index.html").write_text(
        "<!doctype html><title>Hello</title>", encoding="utf-8"
    )

    bundle = build_platform_bundle(
        fixture.source_directory, tmp_path / "with-web.cspkg"
    )
    assert any(
        item.path == "web/index.html" and item.kind == "web"
        for item in bundle.envelope.contents
    )


def test_v2_cli_inspect_emits_a_pinnable_digest(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    fixture = build_hello_platform_bundle(tmp_path)
    assert plugin_cli_main(["v2", "--json", "inspect", str(fixture.bundle.path)]) == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert captured.err == ""
    assert payload["ok"] is True
    assert payload["bundle"]["sha256"] == fixture.bundle.sha256
    assert payload["bundle"]["manifest"]["plugin"]["id"] == "candlescope.hello-command"
