"""Fail-closed Phase 1 contract and compatibility gate.

The gate builds deterministic schema-v2 and schema-v3 bundles from repository
sources. It executes only the established schema-v2 Python reference plugin;
every schema-v3 installation attempt must stop before state creation or code
execution.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_ROOT = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk"
SDK_SOURCE = SDK_ROOT / "src"
FIXTURE_ROOT = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_multi_runtime"
)
CONTRACT_PATH = FIXTURE_ROOT / "phase1_contract_v2.json"
HISTORICAL_CONTRACT_PATH = FIXTURE_ROOT / "phase1_contract_v1.json"
HISTORICAL_CONTRACT_FILE_SHA256 = (
    "9364ad74467a98ff789d1cf5d4217517c3cb80d05a9b94bc8a0953737a39e8ff"
)
V3_SCHEMA_PATH = (
    SDK_SOURCE
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "schemas"
    / "manifest-v3.schema.json"
)
V3_FIXTURE_DIRECTORY = SDK_ROOT / "tests" / "fixtures" / "platform_v3"
OLD_REGISTRY_FIXTURE = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "activation_registry_v2.json"
)
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase1-contract/2"
HISTORICAL_CONTRACT_SCHEMA_VERSION = (
    "candlescope.plugin-platform.multi-runtime.phase1-contract/1"
)
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase1-gate/1"
RUNTIME_KINDS = (
    "python-module",
    "native-executable",
    "java-jar",
    "node-module",
    "wasm-component",
)


class Phase1GateError(RuntimeError):
    """The reviewed Phase 1 contract or runtime boundary drifted."""


def _ensure_import_paths() -> None:
    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from plugin_sdk_isolation import pin_in_repo_plugin_sdk

    pin_in_repo_plugin_sdk(BACKEND_ROOT)


def _strict_json(path: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    value = loads_strict(path.read_bytes())
    if not isinstance(value, dict):
        raise Phase1GateError(f"{path} must contain a JSON object")
    return value


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _git_head() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "unavailable"


def capture_contract() -> dict[str, Any]:
    """Rebuild every exact digest owned by the Phase 1 generation."""

    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import (
        CONTROL_TRANSPORT_V1,
        MANIFEST_SCHEMA_VERSION,
        MANIFEST_SCHEMA_VERSION_V3,
        PLUGIN_PROTOCOL_V2,
        PluginManifest,
        canonical_sha256,
    )
    from scripts import plugin_platform_multi_runtime_phase0 as phase0
    from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle
    from tests.plugin_platform_multi_runtime_testkit import build_v3_runtime_bundle

    phase0_contract = phase0.validate_frozen_contract()
    schema = _strict_json(V3_SCHEMA_PATH)
    fixture_digests: dict[str, str] = {}
    for runtime_kind in RUNTIME_KINDS:
        manifest = PluginManifest.from_wire(
            _strict_json(V3_FIXTURE_DIRECTORY / f"valid-{runtime_kind}.json")
        )
        if manifest.normalized_entrypoints[0].runtime.kind != runtime_kind:
            raise Phase1GateError(f"{runtime_kind} fixture normalized incorrectly")
        fixture_digests[runtime_kind] = manifest.canonical_sha256

    with tempfile.TemporaryDirectory(
        prefix="candlescope-multi-runtime-phase1-contract-"
    ) as raw:
        root = Path(raw)
        v2_bundles: dict[str, dict[str, str]] = {}
        for version in ("0.1.0", "0.2.0"):
            bundle = build_hello_platform_bundle(
                root / f"v2-{version}", version=version
            ).bundle
            v2_bundles[version] = {
                "sha256": bundle.sha256,
                "manifestSha256": bundle.manifest_sha256,
            }
        v3_bundles: dict[str, dict[str, Any]] = {}
        for runtime_kind in RUNTIME_KINDS:
            bundle = build_v3_runtime_bundle(
                root / f"v3-{runtime_kind}", runtime_kind
            ).bundle
            v3_bundles[runtime_kind] = {
                "sha256": bundle.sha256,
                "manifestSha256": bundle.manifest_sha256,
                "artifactRoles": sorted(
                    {item.role for item in bundle.envelope.artifacts}
                ),
            }

    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "migratedOn": "2026-08-26",
        "previousContractSha256": "sha256:" + HISTORICAL_CONTRACT_FILE_SHA256,
        "protocol": {
            "plugin": PLUGIN_PROTOCOL_V2,
            "controlTransport": CONTROL_TRANSPORT_V1,
        },
        "frozenV2": {
            "manifestSchemaVersion": MANIFEST_SCHEMA_VERSION,
            "manifestSchemaCanonicalSha256": phase0_contract["frozenV2"]["manifestV2"][
                "canonicalSha256"
            ],
            "referenceManifestCanonicalSha256": phase0_contract["frozenV2"][
                "referencePythonPlugin"
            ]["canonicalSha256"],
            "referenceWireCanonicalSha256": phase0_contract["frozenV2"][
                "referenceWire"
            ]["canonicalSha256"],
            "historicalPhase0BundleSha256": {
                "0.1.0": phase0_contract["referenceLifecycle"]["bundle"]["v1Sha256"],
                "0.2.0": phase0_contract["referenceLifecycle"]["bundle"]["v2Sha256"],
            },
            "phase1SdkBundleGeneration": v2_bundles,
        },
        "manifestV3": {
            "schemaVersion": MANIFEST_SCHEMA_VERSION_V3,
            "schemaId": schema["$id"],
            "schemaRawSha256": _sha256_bytes(V3_SCHEMA_PATH.read_bytes()),
            "schemaCanonicalSha256": canonical_sha256(schema),
            "runtimeKinds": list(RUNTIME_KINDS),
            "validFixtureCanonicalSha256": fixture_digests,
        },
        "bundleV3": {
            "schemaVersion": 3,
            "format": "candlescope.plugin-bundle/3",
            "referenceBundles": v3_bundles,
        },
        "activationRegistry": {
            "readSchemaVersions": [2, 3],
            "writeSchemaVersion": 3,
            "losslessV2RollbackExport": True,
            "entrypointFields": [
                "artifactSha256",
                "id",
                "launch",
                "runtimeId",
                "runtimeKind",
            ],
            "v2RuntimeKind": "python-module",
            "v2RuntimeId": "python-v2-compat",
        },
        "executionBoundary": {
            "featureFlag": "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED",
            "default": False,
            "featureOffError": "PLUGIN_MULTI_RUNTIME_FEATURE_DISABLED",
            "providerUnavailableError": "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
            "schemaV3ProvidersAvailable": [],
        },
    }


def validate_historical_contract_v1() -> dict[str, Any]:
    """Keep the original Phase 1 fixture byte-stable. Do not rewrite it."""

    raw = HISTORICAL_CONTRACT_PATH.read_bytes().replace(b"\r\n", b"\n")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != HISTORICAL_CONTRACT_FILE_SHA256:
        raise Phase1GateError(
            "historical Phase 1 contract v1 was rewritten: "
            f"expected={HISTORICAL_CONTRACT_FILE_SHA256} current={digest}"
        )
    historical = _strict_json(HISTORICAL_CONTRACT_PATH)
    if historical.get("schemaVersion") != HISTORICAL_CONTRACT_SCHEMA_VERSION:
        raise Phase1GateError("historical Phase 1 contract lost schemaVersion /1")
    return historical


def validate_contract() -> dict[str, Any]:
    validate_historical_contract_v1()
    fixture = _strict_json(CONTRACT_PATH)
    current = capture_contract()
    if fixture != current:
        _ensure_import_paths()
        from candlescope_plugin_sdk.platform_v2 import canonical_sha256

        raise Phase1GateError(
            "multi-runtime Phase 1 contract drift: "
            f"fixture={canonical_sha256(fixture)} current={canonical_sha256(current)}"
        )
    return fixture


def exercise_phase1_boundary() -> dict[str, Any]:
    """Run v2 code and prove that schema-v3 code remains inspect-only."""

    _ensure_import_paths()
    from app.plugin_installer_v2.errors import (
        MultiRuntimeFeatureDisabledError,
        RuntimeProviderUnavailableError,
    )
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle
    from tests.plugin_platform_multi_runtime_testkit import build_v3_runtime_bundle

    with tempfile.TemporaryDirectory(
        prefix="candlescope-multi-runtime-phase1-gate-"
    ) as raw:
        root = Path(raw)
        java = build_v3_runtime_bundle(root / "java", "java-jar")
        disabled_root = root / "disabled-product"
        disabled = PlatformPluginInstaller(
            root=disabled_root,
            multi_runtime_enabled=False,
        )
        try:
            disabled.install(
                java.bundle.path,
                expected_sha256=java.bundle.sha256,
                enabled=True,
            )
        except MultiRuntimeFeatureDisabledError as exc:
            disabled_error = exc.code
        else:
            raise Phase1GateError("schema-v3 install unexpectedly bypassed feature-off")
        if disabled_root.exists():
            raise Phase1GateError("feature-off schema-v3 install created product state")

        enabled_root = root / "enabled-product"
        enabled = PlatformPluginInstaller(
            root=enabled_root,
            multi_runtime_enabled=True,
        )
        try:
            enabled.install(java.bundle.path, expected_sha256=java.bundle.sha256)
        except RuntimeProviderUnavailableError as exc:
            unavailable_error = exc.code
        else:
            raise Phase1GateError("schema-v3 install unexpectedly found a Provider")
        if enabled_root.exists():
            raise Phase1GateError("provider-unavailable install created product state")

        python_bundle = build_hello_platform_bundle(root / "python-v2")
        v2 = PlatformPluginInstaller(
            root=root / "v2-product",
            multi_runtime_enabled=False,
        )
        first = v2.install(
            python_bundle.bundle.path,
            expected_sha256=python_bundle.bundle.sha256,
            enabled=True,
        )
        repeated = v2.install(
            python_bundle.bundle.path,
            expected_sha256=python_bundle.bundle.sha256,
            enabled=True,
        )
        checked = v2.check(first.plugin_id)
        registry = load_activation_registry(v2.registry_path)
        activation = registry.by_id()[first.plugin_id]

        old_value = _strict_json(OLD_REGISTRY_FIXTURE)
        old_entrypoint = old_value["plugins"][0]["entrypoints"][0]
        old_working = (root / "old-installation").resolve()
        old_entrypoint["workingDirectory"] = str(old_working)
        old_entrypoint["executable"] = str(
            (old_working / "venv" / "Scripts" / "python.exe").resolve()
        )
        old_path = root / "platform-registry-v2.json"
        old_bytes = json.dumps(old_value, sort_keys=True).encode("utf-8")
        old_path.write_bytes(old_bytes)
        migrated = load_activation_registry(old_path)
        if old_path.read_bytes() != old_bytes:
            raise Phase1GateError("old activation registry was mutated while loading")

        return {
            "schemaV3": {
                "inspectedKind": java.bundle.manifest.normalized_entrypoints[
                    0
                ].runtime.kind,
                "featureOffError": disabled_error,
                "providerUnavailableError": unavailable_error,
                "productStateCreated": False,
            },
            "schemaV2": {
                "pluginId": first.plugin_id,
                "checkState": checked.state,
                "quickRepeat": repeated.activation_id == first.activation_id,
                "registrySchemaVersion": registry.schema_version,
                "runtimeKind": activation.entrypoints[0].runtime_kind,
                "runtimeId": activation.entrypoints[0].runtime_id,
                "artifactSha256": activation.entrypoints[0].artifact_sha256,
            },
            "registryMigration": {
                "sourceSchemaVersion": old_value["schemaVersion"],
                "loadedSchemaVersion": migrated.schema_version,
                "writeSchemaVersion": migrated.to_wire()["schemaVersion"],
                "rollbackExportSchemaVersion": migrated.to_schema_v2_wire()[
                    "schemaVersion"
                ],
                "sourceFileUnchanged": True,
            },
        }


def run_gate() -> dict[str, Any]:
    contract = validate_contract()
    boundary = exercise_phase1_boundary()
    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "gitHead": _git_head(),
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
        },
        "contractSha256": _contract_sha256(contract),
        "boundary": boundary,
        "result": "pass",
    }


def _contract_sha256(value: dict[str, Any]) -> str:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import canonical_sha256

    return canonical_sha256(value)


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve(strict=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.part"
    data = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
        + "\n"
    ).encode("utf-8")
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the multi-runtime Phase 1 gate")
    parser.add_argument("--print-contract", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        payload = capture_contract() if args.print_contract else run_gate()
        if args.output is not None:
            _write_json_atomic(args.output, payload)
        print(
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                allow_nan=False,
                separators=(",", ":"),
            )
        )
        return 0
    except (OSError, Phase1GateError, RuntimeError) as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "PLUGIN_MULTI_RUNTIME_PHASE1_GATE_FAILED",
                        "message": str(exc)[:2048],
                    },
                },
                ensure_ascii=False,
                sort_keys=True,
                allow_nan=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
