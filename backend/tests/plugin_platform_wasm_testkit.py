from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle, build_platform_bundle


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REFERENCE_ROOT = REPOSITORY_ROOT / "examples" / "plugin-platform-wasm-rust"
SDK_SCHEMA = (
    REPOSITORY_ROOT
    / "packages"
    / "candlescope-plugin-sdk"
    / "src"
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "schemas"
    / "manifest-v3.schema.json"
)
WASM_PLUGIN_ID = "candlescope.wasm-reference"
WASM_RUNTIME_ID = "wasmtime-47.0.3"


@dataclass(frozen=True, slots=True)
class WasmReferenceBundle:
    bundle: VerifiedPlatformBundle
    source: Path
    manifest: dict[str, object]
    component: Path


def build_wasm_reference_bundle(
    directory: Path,
    *,
    update_marker: str | None = None,
) -> WasmReferenceBundle:
    source = directory / "source"
    for name in ("runtime", "schemas", "probes", "sbom", "licenses"):
        (source / name).mkdir(parents=True, exist_ok=True)
    manifest = json.loads(
        (REFERENCE_ROOT / "manifest.json").read_text(encoding="utf-8")
    )
    (source / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    shutil.copyfile(
        REFERENCE_ROOT / "runtime" / "main.wasm",
        source / "runtime" / "main.wasm",
    )
    shutil.copyfile(SDK_SCHEMA, source / "schemas" / SDK_SCHEMA.name)
    shutil.copyfile(
        REFERENCE_ROOT / "probes" / "wasm-control.json",
        source / "probes" / "wasm-control.json",
    )
    shutil.copyfile(
        REFERENCE_ROOT / "sbom" / "cyclonedx.json",
        source / "sbom" / "cyclonedx.json",
    )
    shutil.copyfile(
        REFERENCE_ROOT / "licenses" / "THIRD_PARTY_NOTICES.txt",
        source / "licenses" / "THIRD_PARTY_NOTICES.txt",
    )
    shutil.copyfile(
        REPOSITORY_ROOT / "LICENSE",
        source / "licenses" / "GPL-3.0-only.txt",
    )
    if update_marker is not None:
        (source / "licenses" / "UPDATE-MARKER.txt").write_text(
            update_marker + "\n", encoding="utf-8", newline="\n"
        )
    bundle = build_platform_bundle(
        source,
        directory / "candlescope-wasm-reference-0.1.0.cspkg",
        operating_systems=("linux", "windows"),
        architectures=("x86_64",),
    )
    return WasmReferenceBundle(
        bundle=bundle,
        source=source,
        manifest=manifest,
        component=source / "runtime" / "main.wasm",
    )


__all__ = [
    "WASM_PLUGIN_ID",
    "WASM_RUNTIME_ID",
    "WasmReferenceBundle",
    "build_wasm_reference_bundle",
]
