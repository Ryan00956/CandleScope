from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import shutil
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    PlatformJsonLineServer,
    PluginManifest,
    canonical_sha256,
)
from candlescope_plugin_sdk.platform_v2.examples.hello_command import HelloCommandPlugin

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle, build_platform_bundle


REPOSITORY_ROOT = Path(__file__).parents[2]
SDK_SOURCE = (
    REPOSITORY_ROOT
    / "packages"
    / "candlescope-plugin-sdk"
    / "src"
    / "candlescope_plugin_sdk"
)
EXAMPLE_MANIFEST = (
    REPOSITORY_ROOT
    / "packages"
    / "candlescope-plugin-sdk"
    / "examples"
    / "platform-v2"
    / "hello-command.manifest.json"
)
TRANSCRIPT = (
    REPOSITORY_ROOT
    / "packages"
    / "candlescope-plugin-sdk"
    / "tests"
    / "fixtures"
    / "hello_command_transcript_v2.json"
)
MANIFEST_SCHEMA = SDK_SOURCE / "platform_v2" / "schemas" / "manifest-v2.schema.json"


@dataclass(frozen=True, slots=True)
class PlatformBundleFixture:
    bundle: VerifiedPlatformBundle
    source_directory: Path
    wheel_path: Path
    manifest: dict[str, Any]


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def _record_hash(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={digest.decode('ascii')}"


def build_platform_sdk_wheel(
    directory: Path,
    manifest: dict[str, Any],
    *,
    sdk_version: str = "0.2.0",
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"candlescope_plugin_sdk-{sdk_version}-py3-none-any.whl"
    output = directory / filename
    entries: dict[str, bytes] = {}
    for source in sorted(SDK_SOURCE.rglob("*")):
        if not source.is_file() or source.suffix not in {".py", ".json"}:
            continue
        relative = source.relative_to(SDK_SOURCE).as_posix()
        data = source.read_bytes()
        if relative == "__init__.py":
            data = data.replace(
                b'__version__ = "0.2.0"', f'__version__ = "{sdk_version}"'.encode()
            )
        if relative == "platform_v2/examples/hello-command.manifest.json":
            data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        entries[f"candlescope_plugin_sdk/{relative}"] = data

    dist_info = f"candlescope_plugin_sdk-{sdk_version}.dist-info"
    entries[f"{dist_info}/METADATA"] = (
        "Metadata-Version: 2.4\n"
        "Name: candlescope-plugin-sdk\n"
        f"Version: {sdk_version}\n"
        "Requires-Python: >=3.11\n"
        "\n"
    ).encode("utf-8")
    entries[f"{dist_info}/WHEEL"] = (
        "Wheel-Version: 1.0\n"
        "Generator: CandleScope platform v2 tests\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
        "\n"
    ).encode("utf-8")
    record_path = f"{dist_info}/RECORD"
    record_output = io.StringIO(newline="")
    writer = csv.writer(record_output, lineterminator="\n")
    for path, data in sorted(entries.items()):
        writer.writerow((path, _record_hash(data), len(data)))
    writer.writerow((record_path, "", ""))
    entries[record_path] = record_output.getvalue().encode("utf-8")
    with zipfile.ZipFile(output, "w", allowZip64=True) as archive:
        for path, data in sorted(entries.items()):
            archive.writestr(_zip_info(path), data)
    return output


def hello_platform_manifest(
    *,
    version: str = "0.1.0",
    bad_second_entrypoint: bool = False,
    required_permission: bool = False,
) -> dict[str, Any]:
    manifest = json.loads(EXAMPLE_MANIFEST.read_text(encoding="utf-8"))
    manifest["plugin"]["version"] = version
    if bad_second_entrypoint:
        manifest["backend"]["entrypoints"].append(
            {
                "id": "broken",
                "pythonModule": "candlescope_missing_plugin.entrypoint",
                "resourceProfile": "minimal",
                "activationEvents": ["onCommand"],
            }
        )
    if required_permission:
        manifest["permissions"]["required"] = [
            {"id": "market.bars.read", "scope": {"symbols": ["BTCUSDT"]}}
        ]
        manifest["probes"] = []
    return manifest


def _transcript_for_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    transcript = json.loads(TRANSCRIPT.read_text(encoding="utf-8"))
    plugin = HelloCommandPlugin()
    plugin._manifest = PluginManifest.from_wire(manifest)
    server = PlatformJsonLineServer(plugin)
    responses: list[dict[str, Any]] = []
    for request in transcript["requests"]:
        responses.extend(server.handle_message(request))
    transcript["expected"]["responseSha256"] = [
        canonical_sha256(item) for item in responses
    ]
    transcript["expected"]["transcriptSha256"] = canonical_sha256(responses)
    manifest["probes"][0]["sha256"] = transcript["expected"]["transcriptSha256"]
    return transcript


def build_hello_platform_bundle(
    directory: Path,
    *,
    version: str = "0.1.0",
    bad_second_entrypoint: bool = False,
    required_permission: bool = False,
    operating_systems: tuple[str, ...] = ("linux", "macos", "windows"),
    architectures: tuple[str, ...] = ("arm64", "x86_64"),
) -> PlatformBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = hello_platform_manifest(
        version=version,
        bad_second_entrypoint=bad_second_entrypoint,
        required_permission=required_permission,
    )
    transcript = _transcript_for_manifest(manifest) if manifest["probes"] else None
    source = directory / "source"
    (source / "wheels").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "probes").mkdir()
    (source / "sbom").mkdir()
    wheel = build_platform_sdk_wheel(directory / "wheelhouse", manifest)
    wheel_path = source / "wheels" / wheel.name
    shutil.copyfile(wheel, wheel_path)
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    shutil.copyfile(MANIFEST_SCHEMA, source / "schemas" / "manifest-v2.schema.json")
    if transcript is not None:
        (source / "probes" / "hello-transcript.json").write_text(
            json.dumps(transcript, indent=2), encoding="utf-8"
        )
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000001",
        "version": 1,
        "components": [
            {
                "type": "library",
                "name": "candlescope-plugin-sdk",
                "version": "0.2.0",
            }
        ],
    }
    (source / "sbom" / "cyclonedx.json").write_text(
        json.dumps(sbom, indent=2), encoding="utf-8"
    )
    bundle = build_platform_bundle(
        source,
        directory / f"hello-command-{version}.cspkg",
        operating_systems=operating_systems,
        architectures=architectures,
    )
    return PlatformBundleFixture(bundle, source, wheel_path, manifest)
