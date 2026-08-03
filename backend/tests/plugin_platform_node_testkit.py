from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle, build_platform_bundle


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REFERENCE_ROOT = REPOSITORY_ROOT / "examples" / "plugin-platform-node-typescript"
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
NODE_PLUGIN_ID = "candlescope.node-hello"
NODE_RUNTIME_ID = "node-24.19.0"


@dataclass(frozen=True, slots=True)
class NodeReferenceBundle:
    bundle: VerifiedPlatformBundle
    source: Path
    manifest: dict[str, object]
    main: Path


def build_node_reference_bundle(
    directory: Path,
    *,
    update_marker: str | None = None,
) -> NodeReferenceBundle:
    source = directory / "source"
    for name in ("runtime", "source-maps", "schemas", "probes", "sbom", "licenses"):
        (source / name).mkdir(parents=True, exist_ok=True)
    manifest = json.loads(
        (REFERENCE_ROOT / "manifest.json").read_text(encoding="utf-8")
    )
    (source / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for name in ("main.mjs", "sdk.mjs"):
        shutil.copyfile(REFERENCE_ROOT / "runtime" / name, source / "runtime" / name)
    shutil.copyfile(
        REFERENCE_ROOT / "source-maps" / "main.mjs.map",
        source / "source-maps" / "main.mjs.map",
    )
    shutil.copyfile(SDK_SCHEMA, source / "schemas" / SDK_SCHEMA.name)
    shutil.copyfile(
        REFERENCE_ROOT / "probes" / "node-control.json",
        source / "probes" / "node-control.json",
    )
    shutil.copyfile(
        REFERENCE_ROOT / "sbom" / "cyclonedx.json",
        source / "sbom" / "cyclonedx.json",
    )
    for license_path in sorted(
        (REFERENCE_ROOT / "licenses").iterdir(), key=lambda value: value.name
    ):
        if not license_path.is_file() or license_path.is_symlink():
            raise RuntimeError(
                f"unsafe Node reference license artifact: {license_path}"
            )
        shutil.copyfile(license_path, source / "licenses" / license_path.name)
    shutil.copyfile(
        REPOSITORY_ROOT / "LICENSE", source / "licenses" / "GPL-3.0-only.txt"
    )
    if update_marker is not None:
        (source / "licenses" / "UPDATE-MARKER.txt").write_text(
            update_marker + "\n", encoding="utf-8", newline="\n"
        )
    bundle = build_platform_bundle(
        source,
        directory / "candlescope-node-hello-0.1.0.cspkg",
        operating_systems=("windows",),
        architectures=("x86_64",),
    )
    return NodeReferenceBundle(
        bundle=bundle,
        source=source,
        manifest=manifest,
        main=source / "runtime" / "main.mjs",
    )


__all__ = [
    "NODE_PLUGIN_ID",
    "NODE_RUNTIME_ID",
    "NodeReferenceBundle",
    "build_node_reference_bundle",
]
