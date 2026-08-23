from __future__ import annotations

import copy
import json
from pathlib import Path

import jsonschema
import pytest

from candlescope_plugin_sdk.platform_v2 import (
    CONTROL_TRANSPORT_V1,
    MANIFEST_SCHEMA_VERSION,
    MANIFEST_SCHEMA_VERSION_V2,
    MANIFEST_SCHEMA_VERSION_V3,
    PLUGIN_PROTOCOL_V2,
    PlatformContractError,
    PluginManifest,
    PythonModuleRuntime,
    manifest_schema,
    manifest_schema_v3,
)


FIXTURES = Path(__file__).parent / "fixtures" / "platform_v3"
V2_EXAMPLE = Path(__file__).parents[1] / "examples" / "platform-v2" / "hello-command.manifest.json"
KINDS = (
    "python-module",
    "native-executable",
    "java-jar",
    "node-module",
    "wasm-component",
)


def _read(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_v2_default_and_wire_protocol_remain_frozen_while_v3_is_explicit() -> None:
    assert MANIFEST_SCHEMA_VERSION == MANIFEST_SCHEMA_VERSION_V2 == 2
    assert MANIFEST_SCHEMA_VERSION_V3 == 3
    assert PLUGIN_PROTOCOL_V2 == "candlescope.plugin/2"
    assert CONTROL_TRANSPORT_V1 == "jsonl/1"
    assert manifest_schema() == manifest_schema(MANIFEST_SCHEMA_VERSION_V2)
    assert manifest_schema_v3() == manifest_schema(MANIFEST_SCHEMA_VERSION_V3)
    with pytest.raises(ValueError, match="unsupported manifest schema version"):
        manifest_schema(4)


@pytest.mark.parametrize("kind", KINDS)
def test_each_v3_runtime_kind_has_strict_schema_model_round_trip(kind: str) -> None:
    value = _read(FIXTURES / f"valid-{kind}.json")
    schema = manifest_schema_v3()

    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.validate(value, schema)
    manifest = PluginManifest.from_wire(value)

    assert manifest.schema_version == 3
    assert manifest.to_wire() == value
    assert manifest.normalized_entrypoints[0].runtime.kind == kind
    assert manifest.normalized_entrypoints[0].source_manifest_version == 3


@pytest.mark.parametrize("kind", KINDS)
def test_each_v3_runtime_kind_has_schema_and_model_negative_fixture(kind: str) -> None:
    value = _read(FIXTURES / f"invalid-{kind}.json")
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(value, manifest_schema_v3())
    with pytest.raises(PlatformContractError):
        PluginManifest.from_wire(value)


def test_v2_python_module_normalizes_without_changing_its_round_trip() -> None:
    value = _read(V2_EXAMPLE)
    manifest = PluginManifest.from_wire(value)
    normalized = manifest.normalized_entrypoints[0]

    assert manifest.to_wire() == value
    assert isinstance(normalized.runtime, PythonModuleRuntime)
    assert normalized.to_wire() == {
        "id": "main",
        "runtime": {
            "kind": "python-module",
            "runtimeId": "python-v2-compat",
            "module": "candlescope_plugin_sdk.platform_v2.examples.hello_command",
        },
        "transport": "jsonl/1",
        "resourceProfile": "minimal",
        "activationEvents": ["onCommand"],
        "sourceManifestVersion": 2,
    }


def test_v3_contribution_localizations_are_explicit_and_strict() -> None:
    value = _read(FIXTURES / "valid-python-module.json")
    value["contributions"] = [
        {
            "id": "run",
            "kind": "command/1",
            "title": "Run",
            "entrypoint": "main",
            "configuration": {
                "requiresUserAction": True,
                "placements": ["commandPalette"],
            },
            "localizations": {"zh-CN": {"title": "运行"}},
        }
    ]
    jsonschema.validate(value, manifest_schema_v3())
    parsed = PluginManifest.from_wire(value)
    assert parsed.contributions[0].localizations == {"zh-CN": {"title": "运行"}}
    assert parsed.to_wire() == value

    embedded = copy.deepcopy(value)
    embedded["contributions"][0]["configuration"]["localizations"] = embedded[
        "contributions"
    ][0].pop("localizations")
    with pytest.raises(PlatformContractError, match="manifest v3"):
        PluginManifest.from_wire(embedded)

    invalid = copy.deepcopy(value)
    invalid["contributions"][0]["localizations"]["zh-CN"]["executable"] = (
        "python.exe"
    )
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(invalid, manifest_schema_v3())


def test_v3_unknown_kind_unknown_field_and_duplicate_entrypoint_fail_closed() -> None:
    base = _read(FIXTURES / "valid-java-jar.json")
    unknown_kind = copy.deepcopy(base)
    unknown_kind["backend"]["entrypoints"][0]["runtime"]["kind"] = "shell-command"
    unknown_field = copy.deepcopy(base)
    unknown_field["backend"]["entrypoints"][0]["runtime"]["command"] = "java -jar x"
    duplicate = copy.deepcopy(base)
    duplicate["backend"]["entrypoints"].append(
        copy.deepcopy(duplicate["backend"]["entrypoints"][0])
    )

    for value in (unknown_kind, unknown_field):
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(value, manifest_schema_v3())
        with pytest.raises(PlatformContractError):
            PluginManifest.from_wire(value)
    with pytest.raises(PlatformContractError, match="ids must be unique"):
        PluginManifest.from_wire(duplicate)
