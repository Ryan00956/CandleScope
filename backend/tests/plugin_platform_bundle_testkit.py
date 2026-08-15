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
SCHEDULED_MANIFEST = (
    SDK_SOURCE / "platform_v2" / "examples" / "scheduled-notification.manifest.json"
)
MARKET_SCANNER_MANIFEST = (
    SDK_SOURCE / "platform_v2" / "examples" / "market-scanner.manifest.json"
)
SANDBOX_VIEW_MANIFEST = (
    SDK_SOURCE / "platform_v2" / "examples" / "sandbox-view.manifest.json"
)
SANDBOX_VIEW_WEB = SDK_SOURCE / "platform_v2" / "examples" / "sandbox-view-web"
INTEGRATION_GATEWAY_MANIFEST = (
    SDK_SOURCE / "platform_v2" / "examples" / "integration-gateway.manifest.json"
)
MOCK_EXCHANGE_PROVIDER_MANIFEST = (
    SDK_SOURCE / "platform_v2" / "examples" / "mock-exchange-provider.manifest.json"
)
PAPER_BROKER_MANIFEST = (
    SDK_SOURCE / "platform_v2" / "examples" / "paper-broker.manifest.json"
)


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
    manifest_resource: str = "platform_v2/examples/hello-command.manifest.json",
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"candlescope_plugin_sdk-{sdk_version}-py3-none-any.whl"
    output = directory / filename
    entries: dict[str, bytes] = {}
    for source in sorted(SDK_SOURCE.rglob("*")):
        if not source.is_file() or source.suffix not in {".py", ".json"}:
            continue
        relative = source.relative_to(SDK_SOURCE).as_posix()
        if relative == "strategy_provider_v1" or relative.startswith(
            "strategy_provider_v1/"
        ):
            continue
        data = source.read_bytes()
        if relative == "__init__.py":
            data = data.replace(
                b'__version__ = "0.2.0"', f'__version__ = "{sdk_version}"'.encode()
            )
        if relative == manifest_resource:
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
    required_symbols: tuple[str, ...] = ("BTCUSDT",),
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
            {
                "id": "market.bars.read",
                "scope": {"symbols": list(required_symbols)},
            }
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
    required_symbols: tuple[str, ...] = ("BTCUSDT",),
    operating_systems: tuple[str, ...] = ("linux", "macos", "windows"),
    architectures: tuple[str, ...] = ("arm64", "x86_64"),
) -> PlatformBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = hello_platform_manifest(
        version=version,
        bad_second_entrypoint=bad_second_entrypoint,
        required_permission=required_permission,
        required_symbols=required_symbols,
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


def build_scheduled_notification_bundle(
    directory: Path,
    *,
    interval_seconds: float = 60.0,
    run_on_startup: bool = False,
) -> PlatformBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(SCHEDULED_MANIFEST.read_text(encoding="utf-8"))
    job = next(item for item in manifest["contributions"] if item["kind"] == "job/1")
    job["configuration"]["schedule"]["intervalSeconds"] = interval_seconds
    job["configuration"]["runOnStartup"] = run_on_startup
    manifest["permissions"]["required"][1]["scope"]["maxRunsPerHour"] = min(
        3600, 3600 / interval_seconds
    )
    source = directory / "source"
    (source / "wheels").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "sbom").mkdir()
    wheel = build_platform_sdk_wheel(
        directory / "wheelhouse",
        manifest,
        manifest_resource="platform_v2/examples/scheduled-notification.manifest.json",
    )
    wheel_path = source / "wheels" / wheel.name
    shutil.copyfile(wheel, wheel_path)
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    shutil.copyfile(MANIFEST_SCHEMA, source / "schemas" / "manifest-v2.schema.json")
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000002",
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
        directory / "scheduled-notification-0.1.0.cspkg",
    )
    return PlatformBundleFixture(bundle, source, wheel_path, manifest)


def build_market_scanner_bundle(directory: Path) -> PlatformBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MARKET_SCANNER_MANIFEST.read_text(encoding="utf-8"))
    source = directory / "source"
    (source / "wheels").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "sbom").mkdir()
    wheel = build_platform_sdk_wheel(
        directory / "wheelhouse",
        manifest,
        manifest_resource="platform_v2/examples/market-scanner.manifest.json",
    )
    wheel_path = source / "wheels" / wheel.name
    shutil.copyfile(wheel, wheel_path)
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    shutil.copyfile(MANIFEST_SCHEMA, source / "schemas" / "manifest-v2.schema.json")
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000003",
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
        directory / "market-scanner-0.1.0.cspkg",
    )
    return PlatformBundleFixture(bundle, source, wheel_path, manifest)


def build_sandbox_view_bundle(directory: Path) -> PlatformBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(SANDBOX_VIEW_MANIFEST.read_text(encoding="utf-8"))
    source = directory / "source"
    (source / "wheels").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "sbom").mkdir()
    shutil.copytree(SANDBOX_VIEW_WEB, source / "web")
    wheel = build_platform_sdk_wheel(
        directory / "wheelhouse",
        manifest,
        manifest_resource="platform_v2/examples/sandbox-view.manifest.json",
    )
    wheel_path = source / "wheels" / wheel.name
    shutil.copyfile(wheel, wheel_path)
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    shutil.copyfile(MANIFEST_SCHEMA, source / "schemas" / "manifest-v2.schema.json")
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000004",
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
        directory / "sandbox-view-0.1.0.cspkg",
    )
    return PlatformBundleFixture(bundle, source, wheel_path, manifest)


def build_integration_gateway_bundle(directory: Path) -> PlatformBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(INTEGRATION_GATEWAY_MANIFEST.read_text(encoding="utf-8"))
    source = directory / "source"
    (source / "wheels").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "sbom").mkdir()
    wheel = build_platform_sdk_wheel(
        directory / "wheelhouse",
        manifest,
        manifest_resource="platform_v2/examples/integration-gateway.manifest.json",
    )
    wheel_path = source / "wheels" / wheel.name
    shutil.copyfile(wheel, wheel_path)
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    shutil.copyfile(MANIFEST_SCHEMA, source / "schemas" / "manifest-v2.schema.json")
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000005",
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
        directory / "integration-gateway-0.1.0.cspkg",
    )
    return PlatformBundleFixture(bundle, source, wheel_path, manifest)


def build_mock_exchange_provider_bundle(directory: Path) -> PlatformBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MOCK_EXCHANGE_PROVIDER_MANIFEST.read_text(encoding="utf-8"))
    source = directory / "source"
    (source / "wheels").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "sbom").mkdir()
    wheel = build_platform_sdk_wheel(
        directory / "wheelhouse",
        manifest,
        manifest_resource="platform_v2/examples/mock-exchange-provider.manifest.json",
    )
    wheel_path = source / "wheels" / wheel.name
    shutil.copyfile(wheel, wheel_path)
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    shutil.copyfile(MANIFEST_SCHEMA, source / "schemas" / "manifest-v2.schema.json")
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000006",
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
        directory / "mock-exchange-provider-0.1.0.cspkg",
    )
    return PlatformBundleFixture(bundle, source, wheel_path, manifest)


def build_paper_broker_bundle(directory: Path) -> PlatformBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(PAPER_BROKER_MANIFEST.read_text(encoding="utf-8"))
    source = directory / "source"
    (source / "wheels").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "sbom").mkdir()
    wheel = build_platform_sdk_wheel(
        directory / "wheelhouse",
        manifest,
        manifest_resource="platform_v2/examples/paper-broker.manifest.json",
    )
    wheel_path = source / "wheels" / wheel.name
    shutil.copyfile(wheel, wheel_path)
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    shutil.copyfile(MANIFEST_SCHEMA, source / "schemas" / "manifest-v2.schema.json")
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000007",
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
        directory / "paper-broker-0.1.0.cspkg",
    )
    return PlatformBundleFixture(bundle, source, wheel_path, manifest)
