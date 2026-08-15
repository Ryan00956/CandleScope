from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import jsonschema
import pytest

from candlescope_plugin_sdk.platform_v2 import (
    ActivationRequest,
    CapabilityGrant,
    ContributionDescriptor,
    HandshakeRequest,
    InvokeRequest,
    PermissionRequest,
    PermissionSet,
    PlatformContractError,
    PluginManifest,
    RuntimeDescriptor,
    RequestContext,
    canonical_sha256,
    descriptor_from_manifest,
    manifest_schema,
)
from candlescope_plugin_sdk.platform_v2.examples.hello_command import hello_manifest


ROOT = Path(__file__).parents[1]
EXAMPLES = ROOT / "examples" / "platform-v2"
PACKAGED_MANIFEST = (
    ROOT
    / "src"
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "examples"
    / "hello-command.manifest.json"
)
PACKAGED_SCHEMA = (
    ROOT / "src" / "candlescope_plugin_sdk" / "platform_v2" / "schemas" / "manifest-v2.schema.json"
)
FROZEN_SCHEMA_FILE_SHA256 = "adf8d3bc735ff75339432e3e5aeefd5a1d1eea19eaac5387669d1b5201787763"
FROZEN_SCHEMA_CANONICAL_SHA256 = (
    "sha256:16bc9cb9f51b66ad2e717cd74798cd5c2e0b6a7d6d0fc2f442ba60f68cb1b5a5"
)
FROZEN_MANIFEST_FILE_SHA256 = "c4ff848d74d831ea13f8a5b6ed5bf3b34213ff9ee8bb1c6ae4e971e6df85b4eb"
FROZEN_MANIFEST_CANONICAL_SHA256 = (
    "sha256:9f472a450c48025b2119ff880515898f7bd7748c06e1c99d2a6491754bc0d688"
)


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _portable_file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def test_manifest_schema_and_python_model_accept_the_same_positive_example() -> None:
    schema = manifest_schema()
    example = _read(EXAMPLES / "hello-command.manifest.json")

    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.validate(example, schema)
    parsed = PluginManifest.from_wire(example)

    assert parsed.to_wire() == example
    assert parsed == hello_manifest()
    assert example == _read(PACKAGED_MANIFEST)
    assert parsed.plugin.id == "candlescope.hello-command"
    assert parsed.contributions[0].kind == "command/1"
    assert _portable_file_sha256(PACKAGED_SCHEMA) == FROZEN_SCHEMA_FILE_SHA256
    assert _portable_file_sha256(PACKAGED_MANIFEST) == FROZEN_MANIFEST_FILE_SHA256
    assert canonical_sha256(schema) == FROZEN_SCHEMA_CANONICAL_SHA256
    assert parsed.canonical_sha256 == FROZEN_MANIFEST_CANONICAL_SHA256


@pytest.mark.parametrize(
    "name",
    [
        "unknown-field.manifest.json",
        "unsupported-activation.manifest.json",
        "missing-permissions.manifest.json",
    ],
)
def test_manifest_schema_and_python_model_reject_the_same_negative_examples(
    name: str,
) -> None:
    schema = manifest_schema()
    example = _read(EXAMPLES / "invalid" / name)

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(example, schema)
    with pytest.raises(PlatformContractError):
        PluginManifest.from_wire(example)


def test_manifest_model_rejects_semantic_duplicate_ids_and_permission_overlap() -> None:
    example = _read(EXAMPLES / "hello-command.manifest.json")
    duplicate_contribution = copy.deepcopy(example)
    duplicate_contribution["contributions"].append(
        {
            "id": "hello",
            "kind": "command/1",
            "title": "Duplicate",
            "entrypoint": "main",
            "configuration": {"different": True},
        }
    )

    with pytest.raises(PlatformContractError, match="contribution ids must be unique"):
        PluginManifest.from_wire(duplicate_contribution)
    with pytest.raises(PlatformContractError, match="overlap"):
        PermissionSet(
            required=(PermissionRequest("market.bars.read"),),
            optional=(PermissionRequest("market.bars.read"),),
        )


def test_manifest_schema_and_model_agree_on_semver_and_safe_asset_paths() -> None:
    schema = manifest_schema()
    base = _read(EXAMPLES / "hello-command.manifest.json")
    invalid_semver = copy.deepcopy(base)
    invalid_semver["plugin"]["version"] = "1.0.0-01"
    invalid_path = copy.deepcopy(base)
    invalid_path["frontend"] = {
        "assetsRoot": "../web",
        "surfaces": [
            {
                "id": "main-view",
                "type": "sandbox",
                "entry": "index.html",
                "slot": "side-panel",
            }
        ],
    }

    for value in (invalid_semver, invalid_path):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(value, schema)
        with pytest.raises(PlatformContractError):
            PluginManifest.from_wire(value)


def test_runtime_descriptor_cannot_add_manifest_contributions_or_permissions() -> None:
    manifest = hello_manifest()
    descriptor = RuntimeDescriptor(
        plugin_id=manifest.plugin.id,
        name=manifest.plugin.name,
        version=manifest.plugin.version,
        publisher=manifest.plugin.publisher,
        entrypoint_id="main",
        contributions=(
            ContributionDescriptor(
                id="admin",
                kind="command/1",
                title="Undeclared admin command",
                entrypoint="main",
            ),
        ),
    )

    with pytest.raises(PlatformContractError):
        manifest.validate_descriptor(descriptor)

    valid = hello_manifest()
    escalated = copy.deepcopy(valid.to_wire())
    escalated["permissions"]["required"] = [{"id": "trade.submit", "scope": {"accounts": ["*"]}}]
    escalated_manifest = PluginManifest.from_wire(escalated)
    with pytest.raises(PlatformContractError, match="required permissions"):
        escalated_manifest.validate_descriptor(hello_manifest_descriptor())


def hello_manifest_descriptor() -> RuntimeDescriptor:
    manifest = hello_manifest()
    return descriptor_from_manifest(manifest, entrypoint_id="main")


def test_host_request_models_have_strict_round_trip_wire_encoders() -> None:
    handshake = HandshakeRequest(
        protocols=("candlescope.plugin/2",),
        host_name="CandleScope",
        host_version="0.4.0",
        entrypoint_id="main",
        host_apis=("candlescope.host-api/1",),
        transports=("jsonl/1",),
    )
    activation = ActivationRequest(
        instance_id="instance-1",
        generation=1,
        capabilities=(
            CapabilityGrant(
                handle="cap-1",
                permission_id="notifications.show",
            ),
        ),
    )
    invocation = InvokeRequest(
        contribution_id="hello",
        input={"name": "CandleScope"},
        request_context=RequestContext(
            contribution_id="hello",
            user_action=True,
            generation=1,
            trace_id="trace-round-trip",
        ),
    )

    assert HandshakeRequest.from_wire(handshake.to_wire()) == handshake
    assert ActivationRequest.from_wire(activation.to_wire()) == activation
    assert InvokeRequest.from_wire(invocation.to_wire()) == invocation
