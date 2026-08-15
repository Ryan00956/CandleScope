from __future__ import annotations

from pathlib import Path

from candlescope_plugin_sdk.platform_v2.constants import ACTIVATION_EVENTS

from app.backtest.strategy.isolated import IsolatedStrategyProvider
from app.backtest.strategy.registry import build_default_strategy_registry


LEGAL_ACTIVATION_EVENTS = frozenset(
    {
        "onCommand",
        "onView",
        "onSchedule",
        "onMarketSubscription",
        "onStartup",
    }
)
REPO = Path(__file__).resolve().parents[2]
SDK_CONSTANTS = (
    REPO
    / "packages"
    / "candlescope-plugin-sdk"
    / "src"
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "constants.py"
)
WORKBENCH_MANIFEST = (
    REPO
    / "packages"
    / "candlescope-plugin-pyne-workbench"
    / "src"
    / "candlescope_plugin_pyne_workbench"
    / "manifest.json"
)
PINE_MATRIX = REPO / "docs" / "BACKTEST_PINE_STRATEGY_MATRIX_zh.md"


def test_frozen_activation_events_exclude_on_backtest_run() -> None:
    assert ACTIVATION_EVENTS == LEGAL_ACTIVATION_EVENTS
    assert "onBacktestRun" not in SDK_CONSTANTS.read_text(encoding="utf-8")
    assert "onBacktestRun" not in WORKBENCH_MANIFEST.read_text(encoding="utf-8")


def test_plugin_platform_hello_wheel_excludes_python_strategy_author_types() -> None:
    from tests.plugin_platform_bundle_testkit import build_platform_sdk_wheel

    import zipfile
    import tempfile

    with tempfile.TemporaryDirectory() as raw:
        wheel = build_platform_sdk_wheel(Path(raw), {"plugin": {"version": "0.2.0"}})
        names = zipfile.ZipFile(wheel).namelist()
    assert not any("strategy_provider_v1" in name for name in names)


def test_host_loads_strategies_from_internal_registry_not_plugin_activation() -> None:
    registry = build_default_strategy_registry()
    isolated = (
        REPO / "backend" / "app" / "backtest" / "strategy" / "isolated.py"
    ).read_text(encoding="utf-8")
    assert IsolatedStrategyProvider is not None
    assert "onBacktestRun" not in isolated
    assert "build_default_strategy_registry" in isolated
    assert all(not item.startswith("plugin-activation:") for item in registry.revision_ids())


def test_pine_strategy_matrix_was_not_expanded() -> None:
    text = PINE_MATRIX.read_text(encoding="utf-8")
    assert "PHASE11_SUBSET_FROZEN" in text
    assert "barstate.isconfirmed" in text
    assert "strategy.entry(..., strategy.long)" in text
    assert "pyramiding=0" in text
    assert "request.security" not in text.split("## 支持", 1)[1].split("## 明确不支持", 1)[0]
