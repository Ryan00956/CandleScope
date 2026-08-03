from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle, build_platform_bundle


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REFERENCE_ROOT = REPOSITORY_ROOT / "examples" / "plugins" / "ta4j-elliott-adapter"
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
JAVA_PLUGIN_ID = "candlescope.ta4j-elliott"
JAVA_RUNTIME_ID = "temurin-25.0.4.7"


@dataclass(frozen=True, slots=True)
class JavaReferenceBundle:
    bundle: VerifiedPlatformBundle
    source: Path
    manifest: dict[str, object]
    jar: Path


def build_java_reference_bundle(
    directory: Path,
    *,
    version: str = "0.1.0",
    runtime_id: str = JAVA_RUNTIME_ID,
    main_class: str = "io.candlescope.plugins.ta4j.elliott.Main",
    update_marker: str | None = None,
) -> JavaReferenceBundle:
    source = directory / "source"
    for name in ("runtime", "schemas", "probes", "sbom", "licenses"):
        (source / name).mkdir(parents=True, exist_ok=True)
    manifest = json.loads(
        (REFERENCE_ROOT / "manifest.json").read_text(encoding="utf-8")
    )
    manifest["plugin"]["version"] = version
    runtime = manifest["backend"]["entrypoints"][0]["runtime"]
    runtime["runtimeId"] = runtime_id
    runtime["mainClass"] = main_class
    (source / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    jar_name = Path(runtime["artifact"]).name
    jar = source / "runtime" / jar_name
    shutil.copyfile(REFERENCE_ROOT / "runtime" / jar_name, jar)
    shutil.copyfile(SDK_SCHEMA, source / "schemas" / SDK_SCHEMA.name)
    shutil.copyfile(
        REFERENCE_ROOT / "probes" / "ta4j-control.json",
        source / "probes" / "ta4j-control.json",
    )
    shutil.copyfile(
        REFERENCE_ROOT / "sbom" / "cyclonedx.json",
        source / "sbom" / "cyclonedx.json",
    )
    sbom_path = source / "sbom" / "cyclonedx.json"
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    sbom["metadata"]["component"]["version"] = version
    sbom_path.write_text(
        json.dumps(sbom, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for license_path in sorted(
        (REFERENCE_ROOT / "licenses").iterdir(), key=lambda value: value.name
    ):
        if not license_path.is_file() or license_path.is_symlink():
            raise RuntimeError(f"unsafe reference license artifact: {license_path}")
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
        directory / f"ta4j-elliott-adapter-{version}.cspkg",
        operating_systems=("windows",),
        architectures=("x86_64",),
    )
    return JavaReferenceBundle(bundle, source, manifest, jar)


__all__ = [
    "JAVA_PLUGIN_ID",
    "JAVA_RUNTIME_ID",
    "JavaReferenceBundle",
    "build_java_reference_bundle",
]
