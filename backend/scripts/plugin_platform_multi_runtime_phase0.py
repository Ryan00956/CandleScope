"""Freeze the pre-multi-runtime Plugin Platform contract and lifecycle.

This Phase 0 gate is deliberately outside production startup. It validates the
current schema-v2/Python contract, checks the reviewed future contract fixture,
and exercises a real platform-v2 bundle through install, repeat, check, update,
and rollback in a temporary product root.
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
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
CONTRACT_PATH = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "phase0_contract_v1.json"
)
MANIFEST_SCHEMA_PATH = (
    SDK_SOURCE
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "schemas"
    / "manifest-v2.schema.json"
)
HELLO_MANIFEST_PATH = (
    REPOSITORY_ROOT
    / "packages"
    / "candlescope-plugin-sdk"
    / "examples"
    / "platform-v2"
    / "hello-command.manifest.json"
)
HELLO_TRANSCRIPT_PATH = (
    REPOSITORY_ROOT
    / "packages"
    / "candlescope-plugin-sdk"
    / "tests"
    / "fixtures"
    / "hello_command_transcript_v2.json"
)
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase0-gate/1"
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase0-contract/1"

RUNTIME_KINDS = (
    {"kind": "python-module", "firstPhase": 1, "status": "compatibility"},
    {"kind": "native-executable", "firstPhase": 3, "status": "planned"},
    {"kind": "java-jar", "firstPhase": 5, "status": "planned"},
    {"kind": "node-module", "firstPhase": 7, "status": "planned"},
    {"kind": "wasm-component", "firstPhase": 8, "status": "planned"},
)
ARTIFACT_ROLES = (
    "java-jar",
    "license-notice",
    "native-executable",
    "node-bundle",
    "probe",
    "python-wheel",
    "sbom",
    "schema",
    "source-map",
    "wasm-component",
    "web-asset",
)
TRUST_ALIASES = {
    "first-party-pinned": "first-party-pinned",
    "local-developer": "developer-local",
    "local-trusted": "trusted-local",
    "ui-only-untrusted": "ui-only-untrusted",
    "verified-publisher": "marketplace-sandboxed",
}
FEATURE_FLAGS = (
    "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED",
    "CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED",
)
ERROR_NAMESPACES = (
    "PLUGIN_MULTI_RUNTIME_",
    "PLUGIN_RUNTIME_PROVIDER_",
    "PLUGIN_RUNTIME_REGISTRY_",
)


class Phase0GateError(RuntimeError):
    """The frozen Phase 0 contract or lifecycle drifted."""


def _ensure_import_paths() -> None:
    for path in (SDK_SOURCE, BACKEND_ROOT):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _strict_json(path: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    value = loads_strict(path.read_bytes())
    if not isinstance(value, dict):
        raise Phase0GateError(f"{path} must contain one JSON object")
    return value


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


def capture_static_contract() -> dict[str, Any]:
    """Capture repository facts that Phase 1 must preserve or explicitly migrate."""

    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import (
        CONTROL_TRANSPORT_V1,
        HOST_API_V1,
        MANIFEST_SCHEMA_VERSION,
        PLUGIN_PROTOCOL_V2,
        PluginManifest,
        canonical_sha256,
    )

    schema_bytes = MANIFEST_SCHEMA_PATH.read_bytes()
    manifest_bytes = HELLO_MANIFEST_PATH.read_bytes()
    transcript_bytes = HELLO_TRANSCRIPT_PATH.read_bytes()
    schema = _strict_json(MANIFEST_SCHEMA_PATH)
    manifest_wire = _strict_json(HELLO_MANIFEST_PATH)
    transcript = _strict_json(HELLO_TRANSCRIPT_PATH)
    manifest = PluginManifest.from_wire(manifest_wire)
    entrypoint = manifest.backend_entrypoints[0]
    entrypoint_schema = schema["$defs"]["entrypoint"]
    expected = transcript["expected"]
    return {
        "protocol": {
            "plugin": PLUGIN_PROTOCOL_V2,
            "hostApi": HOST_API_V1,
            "controlTransport": CONTROL_TRANSPORT_V1,
        },
        "manifestV2": {
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "path": MANIFEST_SCHEMA_PATH.relative_to(REPOSITORY_ROOT).as_posix(),
            "rawSha256": _sha256_bytes(schema_bytes),
            "canonicalSha256": canonical_sha256(schema),
            "entrypointRequired": entrypoint_schema["required"],
            "entrypointProperties": sorted(entrypoint_schema["properties"]),
        },
        "referencePythonPlugin": {
            "pluginId": manifest.plugin.id,
            "version": manifest.plugin.version,
            "path": HELLO_MANIFEST_PATH.relative_to(REPOSITORY_ROOT).as_posix(),
            "rawSha256": _sha256_bytes(manifest_bytes),
            "canonicalSha256": manifest.canonical_sha256,
            "entrypoint": {
                "id": entrypoint.id,
                "pythonModule": entrypoint.python_module,
                "resourceProfile": entrypoint.resource_profile,
                "activationEvents": list(entrypoint.activation_events),
            },
            "normalizationTarget": {
                "id": entrypoint.id,
                "runtime": {
                    "kind": "python-module",
                    "runtimeId": "python-v2-compat",
                    "module": entrypoint.python_module,
                },
                "transport": CONTROL_TRANSPORT_V1,
                "resourceProfile": entrypoint.resource_profile,
                "activationEvents": list(entrypoint.activation_events),
                "sourceManifestVersion": 2,
            },
        },
        "referenceWire": {
            "path": HELLO_TRANSCRIPT_PATH.relative_to(REPOSITORY_ROOT).as_posix(),
            "rawSha256": _sha256_bytes(transcript_bytes),
            "canonicalSha256": canonical_sha256(transcript),
            "schemaVersion": transcript["schemaVersion"],
            "requestCount": len(transcript["requests"]),
            "responseSha256": expected["responseSha256"],
            "transcriptSha256": expected["transcriptSha256"],
            "hostCallRequestSha256": expected["hostCallRequestSha256"],
            "hostCallResponseSha256": expected["hostCallResponseSha256"],
        },
    }


def future_contract() -> dict[str, Any]:
    """Return reviewed Phase 1+ names without enabling any production path."""

    return {
        "manifestSchemaVersion": 3,
        "runtimeKinds": list(RUNTIME_KINDS),
        "artifactRoles": list(ARTIFACT_ROLES),
        "trustAliases": dict(TRUST_ALIASES),
        "featureFlags": [
            {"name": name, "default": False, "wiredInPhase0": False}
            for name in FEATURE_FLAGS
        ],
        "errorNamespaces": list(ERROR_NAMESPACES),
        "invariants": [
            "schema-v2-remains-frozen",
            "candlescope.plugin/2-remains-the-control-protocol",
            "v1-script-runtime-compatibility-remains-a-distinct-registry",
            "unknown-runtime-kinds-fail-closed",
            "shell-command-strings-are-not-entrypoints",
            "runtime-or-publisher-changes-do-not-inherit-grants",
            "trusted-local-does-not-imply-secrets-accounts-or-live-trading",
        ],
    }


def ta4j_contract() -> dict[str, Any]:
    """Return the upstream identity reviewed on 2026-08-03."""

    return {
        "repository": "https://github.com/ta4j/ta4j",
        "stableTag": "0.23.0",
        "annotatedTagObject": "0f3a703b651864953c78f2e7f1b91a30778b0625",
        "peeledCommit": "896d7138a9d1818fe6725b89b433ba7860b8f654",
        "releasedOn": "2026-07-13",
        "javaRelease": 25,
        "mavenWrapper": "3.9.16",
        "license": "MIT",
        "adapterEntrypoint": "org.ta4j.core.indicators.elliott.ElliottWaveAnalysisRunner",
        "sourceEvidence": [
            "git ls-remote refs/tags/0.23.0",
            "pom.xml@0.23.0",
            "README.md@0.23.0",
            "CHANGELOG.md@0.23.0",
            "license-header.txt@0.23.0",
        ],
    }


def reference_lifecycle_contract() -> dict[str, Any]:
    """Freeze stable lifecycle semantics while excluding temporary IDs and paths."""

    return {
        "bundle": {
            "contentKinds": ["manifest", "probe", "sbom", "schema", "wheel"],
            "v1ManifestSha256": (
                "sha256:aee90ba2b5b2708f9615c981f061c5a9533e3f9e565ae0f03def62162b372f35"
            ),
            "v1Sha256": (
                "sha256:876120fde99c355c279cca97891e6a1f8a58455125856bd682f6977f167594b2"
            ),
            "v2ManifestSha256": (
                "sha256:ef075f852819aead0885e15523fdc1fd30cc2fbeede318d0c1d66807364944d9"
            ),
            "v2Sha256": (
                "sha256:ccc8492b72de9c5ae8f21e8d493c065123a3f1b683bffbb739b9f367a7f2d7af"
            ),
        },
        "firstInstall": {
            "changed": True,
            "reusedInstallation": False,
            "state": "active",
            "enabled": True,
            "activationReady": True,
        },
        "activation": {
            "pluginId": "candlescope.hello-command",
            "name": "Hello Command",
            "version": "0.1.0",
            "publisher": "candlescope",
            "state": "active",
            "enabled": True,
            "restartRequired": True,
            "requiredPermissions": [],
            "entrypoints": [
                {
                    "id": "main",
                    "module": (
                        "candlescope_plugin_sdk.platform_v2.examples.hello_command"
                    ),
                    "executableRole": "managed-python",
                    "workingDirectory": ".",
                }
            ],
        },
        "freshProcessProbe": {
            "state": "active",
            "entrypointModes": ["activated"],
            "semanticProbes": [
                {
                    "id": "hello-transcript",
                    "entrypointId": "main",
                    "sha256": (
                        "sha256:"
                        "d98ebd2fc9f5b0695925caf47ecf961eae47a56b5e8ec110f28acc9365afdd38"
                    ),
                }
            ],
        },
        "quickRepeat": {
            "changed": False,
            "reusedInstallation": True,
            "sameActivation": True,
        },
        "upgrade": {
            "changed": True,
            "version": "0.2.0",
            "activationChanged": True,
        },
        "rollback": {
            "removed": False,
            "activationChanged": True,
            "restoredVersion": "0.1.0",
            "restoredExactActivation": True,
            "restoredActivationMatchesFirst": True,
            "finalProbeState": "active",
            "finalEntrypointModes": ["activated"],
        },
    }


def expected_contract() -> dict[str, Any]:
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "frozenOn": "2026-08-03",
        "frozenV2": capture_static_contract(),
        "referenceLifecycle": reference_lifecycle_contract(),
        "futureContract": future_contract(),
        "ta4j": ta4j_contract(),
    }


def validate_frozen_contract() -> dict[str, Any]:
    """Fail closed if the reviewed fixture differs from repository reality."""

    fixture = _strict_json(CONTRACT_PATH)
    expected = expected_contract()
    if fixture != expected:
        _ensure_import_paths()
        from candlescope_plugin_sdk.platform_v2 import canonical_sha256

        raise Phase0GateError(
            "multi-runtime Phase 0 contract drift: "
            f"fixture={canonical_sha256(fixture)} "
            f"current={canonical_sha256(expected)}"
        )
    return fixture


def _normalized_activation(record: Any, installation: Path) -> dict[str, Any]:
    entrypoints: list[dict[str, Any]] = []
    for entrypoint in record.entrypoints:
        try:
            working_directory = entrypoint.working_directory.relative_to(installation)
            executable = entrypoint.executable.relative_to(installation)
        except ValueError as exc:
            raise Phase0GateError(
                "entrypoint launch path escaped the immutable installation"
            ) from exc
        if not executable.parts or executable.parts[0] != "venv":
            raise Phase0GateError(
                "schema-v2 entrypoint no longer uses its managed Python environment"
            )
        entrypoints.append(
            {
                "id": entrypoint.id,
                "module": entrypoint.module,
                "executableRole": "managed-python",
                "workingDirectory": working_directory.as_posix() or ".",
            }
        )
    return {
        "pluginId": record.plugin_id,
        "name": record.name,
        "version": record.version,
        "publisher": record.publisher,
        "bundleSha256": record.bundle_sha256,
        "manifestSha256": record.manifest_sha256,
        "state": record.state,
        "enabled": record.enabled,
        "restartRequired": record.restart_required,
        "requiredPermissions": list(record.required_permissions),
        "entrypoints": entrypoints,
    }


def exercise_reference_python_lifecycle() -> dict[str, Any]:
    """Exercise the real schema-v2 Python bundle in an isolated product root."""

    _ensure_import_paths()
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle

    with tempfile.TemporaryDirectory(
        prefix="candlescope-multi-runtime-phase0-"
    ) as temporary:
        root = Path(temporary)
        first_bundle = build_hello_platform_bundle(root / "bundle-v1", version="0.1.0")
        second_bundle = build_hello_platform_bundle(root / "bundle-v2", version="0.2.0")
        installer = PlatformPluginInstaller(root=root / "product")
        first = installer.install(
            first_bundle.bundle.path,
            expected_sha256=first_bundle.bundle.sha256,
            enabled=True,
        )
        first_record = load_activation_registry(installer.registry_path).by_id()[
            first.plugin_id
        ]
        normalized_first = _normalized_activation(first_record, first.installation_path)
        checked = installer.check(first.plugin_id)
        repeated = installer.install(
            first_bundle.bundle.path,
            expected_sha256=first_bundle.bundle.sha256,
            enabled=True,
        )
        upgraded = installer.install(
            second_bundle.bundle.path,
            expected_sha256=second_bundle.bundle.sha256,
            enabled=True,
        )
        rolled_back = installer.rollback(first.plugin_id)
        restored = load_activation_registry(installer.registry_path).by_id()[
            first.plugin_id
        ]
        restored_installation = (
            installer.installs_directory / restored.plugin_id / restored.installation_id
        )
        normalized_restored = _normalized_activation(restored, restored_installation)
        final_check = installer.check(first.plugin_id)
        return {
            "bundle": {
                "v1Sha256": first_bundle.bundle.sha256,
                "v2Sha256": second_bundle.bundle.sha256,
                "v1ManifestSha256": first_bundle.bundle.manifest_sha256,
                "v2ManifestSha256": second_bundle.bundle.manifest_sha256,
                "contentKinds": sorted(
                    {item.kind for item in first_bundle.bundle.envelope.contents}
                ),
            },
            "firstInstall": {
                "changed": first.changed,
                "reusedInstallation": first.reused_installation,
                "state": first.state,
                "enabled": first.enabled,
                "activationReady": first.activation_ready,
            },
            "activation": normalized_first,
            "freshProcessProbe": {
                "state": checked.state,
                "entrypointModes": [
                    item["mode"] for item in checked.probe["entrypoints"]
                ],
                "semanticProbes": checked.probe["semanticProbes"],
            },
            "quickRepeat": {
                "changed": repeated.changed,
                "reusedInstallation": repeated.reused_installation,
                "sameActivation": repeated.activation_id == first.activation_id,
            },
            "upgrade": {
                "changed": upgraded.changed,
                "version": second_bundle.manifest["plugin"]["version"],
                "activationChanged": upgraded.activation_id != first.activation_id,
            },
            "rollback": {
                "removed": rolled_back.removed,
                "activationChanged": (
                    rolled_back.from_activation_id != rolled_back.to_activation_id
                ),
                "restoredVersion": restored.version,
                "restoredExactActivation": (
                    rolled_back.to_activation_id == first.activation_id
                ),
                "restoredActivation": normalized_restored,
                "finalProbeState": final_check.state,
                "finalEntrypointModes": [
                    item["mode"] for item in final_check.probe["entrypoints"]
                ],
            },
        }


def _lifecycle_projection(value: dict[str, Any]) -> dict[str, Any]:
    activation = dict(value["activation"])
    activation.pop("bundleSha256")
    activation.pop("manifestSha256")
    rollback = value["rollback"]
    return {
        "bundle": value["bundle"],
        "firstInstall": value["firstInstall"],
        "activation": activation,
        "freshProcessProbe": value["freshProcessProbe"],
        "quickRepeat": value["quickRepeat"],
        "upgrade": value["upgrade"],
        "rollback": {
            "removed": rollback["removed"],
            "activationChanged": rollback["activationChanged"],
            "restoredVersion": rollback["restoredVersion"],
            "restoredExactActivation": rollback["restoredExactActivation"],
            "restoredActivationMatchesFirst": (
                rollback["restoredActivation"] == value["activation"]
            ),
            "finalProbeState": rollback["finalProbeState"],
            "finalEntrypointModes": rollback["finalEntrypointModes"],
        },
    }


def validate_lifecycle(
    value: dict[str, Any], expected: dict[str, Any] | None = None
) -> None:
    """Validate semantic invariants without freezing temporary paths or IDs."""

    expected = reference_lifecycle_contract() if expected is None else expected
    actual_projection = _lifecycle_projection(value)
    # Phase 0 froze the exact SDK-containing bundle bytes that existed at that
    # commit. Additive SDK files in later phases necessarily create a new
    # content-addressed bundle generation. Preserve those historical digests in
    # the Phase 0 fixture, while keeping this gate authoritative for the stable
    # v2 lifecycle semantics. Every later generation must pin its own exact
    # digests in that phase's independent contract.
    actual_projection["bundle"] = {
        "contentKinds": actual_projection["bundle"]["contentKinds"]
    }
    expected_projection = dict(expected)
    expected_projection["bundle"] = {"contentKinds": expected["bundle"]["contentKinds"]}
    if actual_projection != expected_projection:
        raise Phase0GateError("reference Python lifecycle contract drifted")


def run_gate() -> dict[str, Any]:
    contract = validate_frozen_contract()
    lifecycle = exercise_reference_python_lifecycle()
    validate_lifecycle(lifecycle, contract["referenceLifecycle"])
    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "gitHead": _git_head(),
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
        },
        "contract": {
            "schemaVersion": contract["schemaVersion"],
            "manifestV2CanonicalSha256": contract["frozenV2"]["manifestV2"][
                "canonicalSha256"
            ],
            "referenceManifestCanonicalSha256": contract["frozenV2"][
                "referencePythonPlugin"
            ]["canonicalSha256"],
            "referenceWireCanonicalSha256": contract["frozenV2"]["referenceWire"][
                "canonicalSha256"
            ],
            "newFeatureFlagsEnabled": [],
        },
        "lifecycle": lifecycle,
        "result": "pass",
    }


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path = path.expanduser().resolve(strict=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False, sort_keys=True)
        + "\n"
    ).encode("utf-8")
    with tempfile.NamedTemporaryFile(
        mode="wb", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as stream:
        temporary = Path(stream.name)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the Plugin Platform multi-runtime Phase 0 gate."
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--print-contract",
        action="store_true",
        help="print current reviewed contract instead of running the lifecycle",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        value = expected_contract() if args.print_contract else run_gate()
        if args.output is not None:
            _write_json_atomic(args.output, value)
        print(
            json.dumps(
                value,
                ensure_ascii=False,
                indent=2,
                allow_nan=False,
                sort_keys=True,
            )
        )
    except (OSError, Phase0GateError) as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "PLUGIN_MULTI_RUNTIME_PHASE0_GATE_FAILED",
                        "message": str(exc),
                    },
                },
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
