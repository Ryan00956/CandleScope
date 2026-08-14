from __future__ import annotations

import sys
import types

if "pyne_runtime" not in sys.modules:
    _stub = types.ModuleType("pyne_runtime")
    _stub.__version__ = "0.3.0rc2"
    _stub.REQUEST_SECURITY_API = "request.security"
    _stub.REQUEST_SECURITY_LOWER_TF_API = "request.security.lower"
    _stub.PYNE_OUTPUT_SCHEMA_VERSION = 2
    sys.modules["pyne_runtime"] = _stub

from candlescope_plugin_sdk.platform_v2 import PluginManifest
from candlescope_plugin_sdk.platform_v2.json_codec import loads_strict
from candlescope_plugin_pyne_workbench import pyne_workbench_manifest
from candlescope_plugin_pyne_workbench.strategy_entrypoint import (
    CONTRIBUTION_ID,
    ENTRYPOINT_ID,
    create_provider,
)


def test_strategy_contribution_is_isolated_from_live_market_reads() -> None:
    manifest = pyne_workbench_manifest()
    assert isinstance(manifest, PluginManifest)
    kinds = {item.kind for item in manifest.contributions}
    assert "strategy-provider/1" in kinds
    contribution = next(item for item in manifest.contributions if item.id == CONTRIBUTION_ID)
    assert contribution.entrypoint == ENTRYPOINT_ID
    assert any(item.id == ENTRYPOINT_ID for item in manifest.backend_entrypoints)
    required = {item.id for item in manifest.permissions.required}
    optional = {item.id for item in manifest.permissions.optional}
    assert "market.bars.read" in required
    assert "backtest.observations.consume" in optional
    provider = create_provider()
    assert provider.describe().input_modes == ("BAR_CLOSE",)


def test_manifest_bytes_still_parse_with_new_activation_event() -> None:
    from importlib.resources import files

    raw = files("candlescope_plugin_pyne_workbench").joinpath("manifest.json").read_bytes()
    parsed = PluginManifest.from_wire(loads_strict(raw))
    events = {
        event
        for entry in parsed.backend_entrypoints
        for event in entry.activation_events
    }
    assert "onBacktestRun" in events
