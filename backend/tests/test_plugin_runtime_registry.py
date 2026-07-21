from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app.plugin_runtime.bootstrap import build_runtime_host_from_environment
from app.plugin_runtime.errors import PluginRegistryError
from app.plugin_runtime.registry import (
    DEFAULT_MAX_STDERR_BYTES,
    RUNTIME_REGISTRY_SCHEMA_VERSION,
    RuntimeProcessSpec,
    RuntimeRegistry,
    load_runtime_registry,
)


def _plugin_entry(**overrides: object) -> dict[str, object]:
    entry: dict[str, object] = {
        "id": "hello-runtime",
        "package": "candlescope-plugin-sdk",
        "version": "0.1.0",
        "enabled": True,
        "autoStart": False,
        "required": False,
        "launch": {
            "executable": str(Path(sys.executable).resolve()),
            "args": ["-I", "-u", "-m", "candlescope_plugin_sdk.examples.hello_runtime"],
            "workingDirectory": str(Path(sys.executable).resolve().parent),
        },
    }
    entry.update(overrides)
    return entry


def _write_registry(path: Path, plugins: list[dict[str, object]]) -> None:
    path.write_text(
        json.dumps(
            {
                "schemaVersion": RUNTIME_REGISTRY_SCHEMA_VERSION,
                "plugins": plugins,
            }
        ),
        encoding="utf-8",
    )


def test_load_runtime_registry_resolves_strict_activation_record(
    tmp_path: Path,
) -> None:
    registry_path = tmp_path / "runtime-registry.json"
    _write_registry(registry_path, [_plugin_entry()])

    registry = load_runtime_registry(registry_path)

    assert registry.source == registry_path.resolve()
    assert len(registry.plugins) == 1
    spec = registry.plugins[0]
    assert spec.runtime_id == "hello-runtime"
    assert spec.expected_package == "candlescope-plugin-sdk"
    assert spec.expected_version == "0.1.0"
    assert spec.command[0] == str(Path(sys.executable).resolve())
    assert spec.max_stderr_bytes == DEFAULT_MAX_STDERR_BYTES
    assert spec.auto_start is False


def test_missing_default_registry_can_be_an_empty_registry(tmp_path: Path) -> None:
    missing = tmp_path / "missing.json"

    registry = load_runtime_registry(missing, allow_missing=True)

    assert registry == RuntimeRegistry(source=missing.resolve())
    with pytest.raises(PluginRegistryError, match="does not exist"):
        load_runtime_registry(missing)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (
            {
                "schemaVersion": 2,
                "plugins": [],
            },
            "unsupported runtime registry schema",
        ),
        (
            {
                "schemaVersion": 1,
                "plugins": [_plugin_entry(), _plugin_entry()],
            },
            "duplicate plugin ids",
        ),
        (
            {
                "schemaVersion": 1,
                "plugins": [_plugin_entry(environment={"TOKEN": "secret"})],
            },
            "unsupported fields: environment",
        ),
        (
            {
                "schemaVersion": 1,
                "plugins": [_plugin_entry(launch={"executable": "python"})],
            },
            "executable must be an absolute path",
        ),
        (
            {
                "schemaVersion": 1,
                "plugins": [
                    _plugin_entry(enabled=False, autoStart=True),
                ],
            },
            "disabled runtime.*cannot use autoStart",
        ),
        (
            {
                "schemaVersion": 1,
                "plugins": [
                    _plugin_entry(required=True, autoStart=False),
                ],
            },
            "required runtime.*must be enabled and autoStart",
        ),
    ],
)
def test_registry_rejects_ambiguous_or_unsafe_records(
    tmp_path: Path,
    payload: dict[str, object],
    message: str,
) -> None:
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(PluginRegistryError, match=message):
        load_runtime_registry(path)


@pytest.mark.parametrize(
    "contents",
    [
        '{"schemaVersion":1,"schemaVersion":1,"plugins":[]}',
        '{"schemaVersion":1,"plugins":[],"value":NaN}',
        "not json",
    ],
)
def test_registry_uses_strict_json(tmp_path: Path, contents: str) -> None:
    path = tmp_path / "invalid.json"
    path.write_text(contents, encoding="utf-8")

    with pytest.raises(PluginRegistryError, match="not valid UTF-8 JSON"):
        load_runtime_registry(path)


def test_process_spec_rejects_invalid_direct_construction() -> None:
    with pytest.raises(PluginRegistryError, match="invalid runtime id"):
        RuntimeProcessSpec(
            runtime_id="INVALID",
            expected_package="package",
            expected_version="1.0.0",
            executable=Path(sys.executable).resolve(),
        )


def test_environment_bootstrap_supports_empty_default_and_hard_disable(
    tmp_path: Path,
) -> None:
    empty_default = build_runtime_host_from_environment(
        host_name="CandleScope",
        host_version="0.3.0",
        environ={
            "LOCALAPPDATA": str(tmp_path),
            "XDG_DATA_HOME": str(tmp_path),
        },
    )
    assert empty_default.enabled is True
    assert empty_default.health_summary()["configured"] == 0

    disabled = build_runtime_host_from_environment(
        host_name="CandleScope",
        host_version="0.3.0",
        environ={
            "CANDLESCOPE_PLUGIN_HOST_ENABLED": "off",
            "CANDLESCOPE_RUNTIME_REGISTRY": str(tmp_path / "missing-explicit.json"),
        },
    )
    assert disabled.health_summary()["status"] == "disabled"


def test_environment_bootstrap_fails_closed_for_explicit_missing_registry(
    tmp_path: Path,
) -> None:
    with pytest.raises(PluginRegistryError, match="does not exist"):
        build_runtime_host_from_environment(
            host_name="CandleScope",
            host_version="0.3.0",
            environ={
                "CANDLESCOPE_RUNTIME_REGISTRY": str(tmp_path / "missing.json"),
            },
        )

    with pytest.raises(PluginRegistryError, match="must be one of"):
        build_runtime_host_from_environment(
            host_name="CandleScope",
            host_version="0.3.0",
            environ={"CANDLESCOPE_PLUGIN_HOST_ENABLED": "maybe"},
        )
