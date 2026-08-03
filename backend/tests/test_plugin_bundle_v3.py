from __future__ import annotations

import copy
import platform
import stat
import zipfile
from pathlib import Path

import pytest

from candlescope_plugin_sdk.platform_v2 import canonical_dumps, loads_strict

from app.plugin_installer_v2.bundle import (
    BUNDLE_DESCRIPTOR_PATH,
    BUNDLE_FORMAT_V3,
    BUNDLE_SCHEMA_VERSION_V3,
    PlatformBundleError,
    build_platform_bundle,
    inspect_platform_bundle,
    sha256_file,
    verify_platform_bundle,
)
from tests.plugin_platform_multi_runtime_testkit import build_v3_runtime_bundle


RUNTIME_KINDS = (
    "python-module",
    "native-executable",
    "java-jar",
    "node-module",
    "wasm-component",
)
EXPECTED_RUNTIME_ROLES = {
    "native-executable": "native-executable",
    "java-jar": "java-jar",
    "node-module": "node-bundle",
    "wasm-component": "wasm-component",
}


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
    descriptor_mutation: object | None = None,
    additions: tuple[tuple[zipfile.ZipInfo, bytes], ...] = (),
) -> Path:
    with (
        zipfile.ZipFile(source, "r") as existing,
        zipfile.ZipFile(target, "w") as output,
    ):
        descriptor = loads_strict(existing.read(BUNDLE_DESCRIPTOR_PATH))
        if descriptor_mutation is not None:
            descriptor_mutation(descriptor)
        for info in existing.infolist():
            data = existing.read(info)
            if info.filename == BUNDLE_DESCRIPTOR_PATH:
                data = (canonical_dumps(descriptor) + "\n").encode("utf-8")
            output.writestr(info, data)
        for info, data in additions:
            output.writestr(info, data)
    return target


@pytest.mark.parametrize("runtime_kind", RUNTIME_KINDS)
def test_v3_build_and_inspect_inventory_for_every_runtime_kind(
    tmp_path: Path, runtime_kind: str
) -> None:
    fixture = build_v3_runtime_bundle(tmp_path / runtime_kind, runtime_kind)
    inspected = inspect_platform_bundle(fixture.bundle.path)

    assert inspected.envelope.schema_version == BUNDLE_SCHEMA_VERSION_V3
    assert inspected.envelope.format == BUNDLE_FORMAT_V3
    assert inspected.manifest.schema_version == 3
    assert inspected.manifest.normalized_entrypoints[0].runtime.kind == runtime_kind
    assert {item.path for item in inspected.envelope.artifacts} == {
        item.path
        for item in inspected.envelope.contents
        if item.path != "manifest.json"
    }
    if runtime_kind == "python-module":
        assert any(item.role == "python-wheel" for item in inspected.envelope.artifacts)
    else:
        assert EXPECTED_RUNTIME_ROLES[runtime_kind] in {
            item.role for item in inspected.envelope.artifacts
        }


def test_v3_builder_is_deterministic(tmp_path: Path) -> None:
    first = build_v3_runtime_bundle(tmp_path / "first", "java-jar")
    rebuilt = build_platform_bundle(
        first.source_directory,
        tmp_path / "rebuilt.cspkg",
        python_requires=None,
    )
    assert rebuilt.path.read_bytes() == first.bundle.path.read_bytes()
    assert rebuilt.sha256 == first.bundle.sha256


@pytest.mark.parametrize(
    ("name", "mutate", "match"),
    [
        (
            "duplicate-artifact",
            lambda value: value["artifacts"].append(
                copy.deepcopy(value["artifacts"][-1])
            ),
            "path-sorted|duplicate",
        ),
        (
            "wrong-role",
            lambda value: value["artifacts"][0].update({"role": "source-map"}),
            "role does not match|wrongly typed",
        ),
        (
            "path-escape",
            lambda value: value["artifacts"][0].update({"path": "../escape.jar"}),
            "unsafe|canonical",
        ),
    ],
)
def test_v3_artifact_inventory_fails_closed(
    tmp_path: Path,
    name: str,
    mutate: object,
    match: str,
) -> None:
    fixture = build_v3_runtime_bundle(tmp_path / "source", "java-jar")
    attacked = _rewrite(
        fixture.bundle.path,
        tmp_path / f"{name}.cspkg",
        descriptor_mutation=mutate,
    )
    with pytest.raises(PlatformBundleError, match=match):
        verify_platform_bundle(attacked, expected_sha256=sha256_file(attacked))


def test_v3_runtime_artifact_platform_mismatch_fails_closed(tmp_path: Path) -> None:
    fixture = build_v3_runtime_bundle(tmp_path / "source", "java-jar")
    current = {"Windows": "windows", "Linux": "linux", "Darwin": "macos"}.get(
        platform.system(), platform.system().lower()
    )

    def mismatch(value: dict[str, object]) -> None:
        runtime_artifact = next(
            item for item in value["artifacts"] if item["role"] == "java-jar"
        )
        runtime_artifact["os"] = sorted({"windows", "linux", "macos"} - {current})

    attacked = _rewrite(
        fixture.bundle.path,
        tmp_path / "platform-mismatch.cspkg",
        descriptor_mutation=mismatch,
    )
    with pytest.raises(PlatformBundleError, match="runtime artifact.*current platform"):
        verify_platform_bundle(attacked, expected_sha256=sha256_file(attacked))


@pytest.mark.parametrize(
    ("name", "info", "payload", "match"),
    [
        ("symlink", _zip_info("runtime/link", symlink=True), b"target", "symbolic"),
        (
            "zip-bomb",
            _zip_info("runtime/bomb.bin", compression=zipfile.ZIP_DEFLATED),
            b"0" * (2 * 1024 * 1024),
            "compression ratio",
        ),
    ],
    ids=("symlink", "zip-bomb"),
)
def test_v3_archive_symlink_and_compression_bomb_regression(
    tmp_path: Path,
    name: str,
    info: zipfile.ZipInfo,
    payload: bytes,
    match: str,
) -> None:
    fixture = build_v3_runtime_bundle(tmp_path / "source", "java-jar")
    attacked = _rewrite(
        fixture.bundle.path,
        tmp_path / f"{name}.cspkg",
        additions=((info, payload),),
    )
    with pytest.raises(PlatformBundleError, match=match):
        verify_platform_bundle(attacked, expected_sha256=sha256_file(attacked))


@pytest.mark.parametrize("invalid", ("duplicate-key", "nan"))
def test_v3_builder_rejects_non_strict_manifest_json(
    tmp_path: Path, invalid: str
) -> None:
    fixture = build_v3_runtime_bundle(tmp_path / "source", "java-jar")
    manifest_path = fixture.source_directory / "manifest.json"
    text = manifest_path.read_text(encoding="utf-8")
    if invalid == "duplicate-key":
        text = text.replace(
            '"schemaVersion": 3,',
            '"schemaVersion": 3,\n  "schemaVersion": 3,',
            1,
        )
    else:
        text = text.replace('"name": "Java v3 Fixture"', '"name": NaN', 1)
    manifest_path.write_text(text, encoding="utf-8")

    with pytest.raises(PlatformBundleError, match="strict bounded UTF-8 JSON"):
        build_platform_bundle(
            fixture.source_directory,
            tmp_path / f"invalid-{invalid}.cspkg",
            python_requires=None,
        )
