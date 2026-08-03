from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from app.plugin_installer_v2.errors import PlatformInstallerError
from app.plugin_installer_v2.registry import (
    ActivationRecord,
    ActivationRegistry,
    EntrypointActivation,
    load_activation_registry,
)


FIXTURE = (
    Path(__file__).parent
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "activation_registry_v2.json"
)
SHA_A = "sha256:" + "1" * 64
SHA_B = "sha256:" + "2" * 64


def _activation(
    tmp_path: Path,
    entrypoint: EntrypointActivation,
) -> ActivationRecord:
    return ActivationRecord(
        plugin_id="candlescope.registry-fixture",
        name="Registry Fixture",
        version="0.1.0",
        publisher="candlescope",
        installation_id="1" * 64,
        bundle_sha256=SHA_A,
        manifest_sha256=SHA_B,
        activation_id="activation-registry-fixture",
        activated_at="2026-08-03T00:00:00Z",
        state="active",
        enabled=True,
        restart_required=True,
        required_permissions=(),
        entrypoints=(entrypoint,),
    )


def test_schema_v2_registry_loads_read_only_and_serializes_as_schema_v3(
    tmp_path: Path,
) -> None:
    original = FIXTURE.read_text(encoding="utf-8")
    working = (tmp_path / "installation").resolve()
    python = (working / "venv" / "Scripts" / "python.exe").resolve()
    value = json.loads(original)
    value["plugins"][0]["entrypoints"][0]["executable"] = str(python)
    value["plugins"][0]["entrypoints"][0]["workingDirectory"] = str(working)
    registry_path = tmp_path / "platform-registry-v2.json"
    registry_path.write_text(json.dumps(value), encoding="utf-8")
    before = registry_path.read_bytes()

    migrated = load_activation_registry(registry_path)
    record = migrated.plugins[0]

    assert registry_path.read_bytes() == before
    assert migrated.schema_version == 3
    assert record.entrypoints[0].runtime_kind == "python-module"
    assert record.entrypoints[0].runtime_id == "python-v2-compat"
    assert record.entrypoints[0].artifact_sha256 == record.bundle_sha256
    wire = migrated.to_wire()
    assert wire["schemaVersion"] == 3
    assert wire["plugins"][0]["schemaVersion"] == 3
    assert wire["plugins"][0]["entrypoints"][0] == {
        "id": "main",
        "runtimeKind": "python-module",
        "runtimeId": "python-v2-compat",
        "artifactSha256": SHA_A,
        "launch": {
            "kind": "python-module",
            "executable": str(python),
            "workingDirectory": str(working),
            "module": "legacy_plugin.runtime",
        },
    }
    assert ActivationRegistry.from_wire(wire) == migrated
    assert migrated.to_schema_v2_wire() == value


@pytest.mark.parametrize(
    "runtime_kind",
    (
        "python-module",
        "native-executable",
        "java-jar",
        "node-module",
        "wasm-component",
    ),
)
def test_schema_v3_activation_typed_launch_round_trip(
    tmp_path: Path, runtime_kind: str
) -> None:
    working = (tmp_path / runtime_kind).resolve()
    executable = (working / "runtime" / "managed.exe").resolve()
    common = {
        "id": "main",
        "executable": executable,
        "module": None,
        "working_directory": working,
        "runtime_kind": runtime_kind,
        "runtime_id": "native-host"
        if runtime_kind == "native-executable"
        else "managed-1",
        "artifact_sha256": SHA_A,
    }
    if runtime_kind == "python-module":
        common.update(
            {
                "module": "fixture.runtime",
                "runtime_id": "python-v2-compat",
                "arguments": ("-X", "utf8"),
            }
        )
    else:
        common["artifact"] = (working / "content" / "runtime" / "artifact").resolve()
        common["arguments"] = ("--fixture",)
    if runtime_kind == "java-jar":
        common["main_class"] = "io.candlescope.fixture.Main"
    elif runtime_kind == "wasm-component":
        common["export_name"] = "fixture:run"
        common["wasi_profile"] = "wasi-preview2"
    entrypoint = EntrypointActivation(**common)
    registry = ActivationRegistry(plugins=(_activation(tmp_path, entrypoint),))

    assert ActivationRegistry.from_wire(registry.to_wire()) == registry
    assert (
        registry.to_wire()["plugins"][0]["entrypoints"][0]["runtimeKind"]
        == runtime_kind
    )


def test_schema_v3_activation_unknown_fields_kind_and_relative_paths_fail_closed(
    tmp_path: Path,
) -> None:
    working = tmp_path.resolve()
    entrypoint = EntrypointActivation(
        "main",
        (working / "python.exe").resolve(),
        "fixture.runtime",
        working,
        artifact_sha256=SHA_A,
    )
    wire = ActivationRegistry(plugins=(_activation(tmp_path, entrypoint),)).to_wire()
    unknown_field = copy.deepcopy(wire)
    unknown_field["plugins"][0]["entrypoints"][0]["launch"]["shell"] = "cmd.exe"
    unknown_kind = copy.deepcopy(wire)
    unknown_kind["plugins"][0]["entrypoints"][0]["runtimeKind"] = "shell-command"
    relative = copy.deepcopy(wire)
    relative["plugins"][0]["entrypoints"][0]["launch"]["executable"] = "python.exe"

    for value in (unknown_field, unknown_kind, relative):
        with pytest.raises(PlatformInstallerError):
            ActivationRegistry.from_wire(value)


def test_schema_v2_rollback_export_rejects_non_compat_runtime(tmp_path: Path) -> None:
    working = tmp_path.resolve()
    native = EntrypointActivation(
        id="main",
        executable=(working / "native.exe").resolve(),
        module=None,
        working_directory=working,
        runtime_kind="native-executable",
        runtime_id="native-host",
        artifact_sha256=SHA_A,
        artifact=(working / "content" / "runtime" / "native.exe").resolve(),
    )
    registry = ActivationRegistry(plugins=(_activation(tmp_path, native),))

    with pytest.raises(PlatformInstallerError, match="losslessly"):
        registry.to_schema_v2_wire()
