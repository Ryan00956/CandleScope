from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import PluginManifest

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle, build_platform_bundle
from tests.plugin_platform_bundle_testkit import build_platform_sdk_wheel


REPOSITORY_ROOT = Path(__file__).parents[2]
SDK_ROOT = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk"
V3_FIXTURES = SDK_ROOT / "tests" / "fixtures" / "platform_v3"
V3_SCHEMA = (
    SDK_ROOT
    / "src"
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "schemas"
    / "manifest-v3.schema.json"
)

_RUNTIME_PAYLOADS = {
    "native-executable": b"MZ\x90\x00candlescope-phase1-native-fixture\n",
    "java-jar": b"PK\x03\x04candlescope-phase1-jar-fixture\n",
    "node-module": b'process.stdout.write("phase1 fixture\\n");\n',
    "wasm-component": b"\x00asm\x01\x00\x00\x00candlescope-phase1-wasm-fixture",
}


@dataclass(frozen=True, slots=True)
class MultiRuntimeBundleFixture:
    bundle: VerifiedPlatformBundle
    source_directory: Path
    manifest: dict[str, Any]
    runtime_kind: str


def read_v3_manifest(runtime_kind: str) -> dict[str, Any]:
    return json.loads(
        (V3_FIXTURES / f"valid-{runtime_kind}.json").read_text(encoding="utf-8")
    )


def build_v3_runtime_bundle(
    directory: Path,
    runtime_kind: str,
    *,
    manifest: dict[str, Any] | None = None,
    operating_systems: tuple[str, ...] = ("linux", "macos", "windows"),
    architectures: tuple[str, ...] = ("arm64", "x86_64"),
) -> MultiRuntimeBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest_value = read_v3_manifest(runtime_kind) if manifest is None else manifest
    parsed = PluginManifest.from_wire(manifest_value)
    source = directory / "source"
    (source / "schemas").mkdir(parents=True)
    (source / "sbom").mkdir()
    shutil.copyfile(V3_SCHEMA, source / "schemas" / "manifest-v3.schema.json")
    (source / "manifest.json").write_text(
        json.dumps(manifest_value, indent=2), encoding="utf-8"
    )

    components: list[dict[str, str]] = []
    runtime = parsed.normalized_entrypoints[0].runtime
    python_requires: str | None = None
    if runtime_kind == "python-module":
        (source / "wheels").mkdir()
        wheel = build_platform_sdk_wheel(directory / "wheelhouse", manifest_value)
        shutil.copyfile(wheel, source / "wheels" / wheel.name)
        components.append(
            {"type": "library", "name": "candlescope-plugin-sdk", "version": "0.2.0"}
        )
        python_requires = ">=3.11,<3.14"
    else:
        artifact_path = source.joinpath(*Path(runtime.artifact).parts)
        artifact_path.parent.mkdir(parents=True)
        artifact_path.write_bytes(_RUNTIME_PAYLOADS[runtime_kind])
        components.append(
            {
                "type": "application",
                "name": f"phase1-{runtime_kind}-fixture",
                "version": "0.1.0",
            }
        )

    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000031",
        "version": 1,
        "components": components,
    }
    (source / "sbom" / "cyclonedx.json").write_text(
        json.dumps(sbom, indent=2), encoding="utf-8"
    )
    bundle = build_platform_bundle(
        source,
        directory / f"{runtime_kind}.cspkg",
        python_requires=python_requires,
        operating_systems=operating_systems,
        architectures=architectures,
    )
    return MultiRuntimeBundleFixture(bundle, source, manifest_value, runtime_kind)
