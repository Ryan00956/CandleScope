from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from candlescope_plugin_sdk import (
    AnalyzeRequest,
    Bar,
    ExecuteBatchRequest,
    MarketContext,
)

from candlescope_plugin_pyne import (
    EXPECTED_PYNE_VERSION,
    PLUGIN_VERSION,
    RUNTIME_ID,
    PyneRuntimePlugin,
)
from candlescope_plugin_pyne import runtime as runtime_module


REPOSITORY_ROOT = Path(__file__).parents[3]
PHASE0_FIXTURE = json.loads(
    (
        REPOSITORY_ROOT
        / "backend"
        / "tests"
        / "fixtures"
        / "plugin_runtime"
        / "pyne_transport_v1.json"
    ).read_text(encoding="utf-8")
)
SOURCE = PHASE0_FIXTURE["script"]


def _context() -> MarketContext:
    return MarketContext(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
    )


def _bars() -> tuple[Bar, ...]:
    return tuple(Bar(**item) for item in PHASE0_FIXTURE["bars"])


def _execute_request(
    *,
    source: str = SOURCE,
    options: dict[str, Any] | None = None,
) -> ExecuteBatchRequest:
    return ExecuteBatchRequest(
        source=source,
        context=_context(),
        bars=_bars(),
        params={},
        options=options or {},
    )


def test_descriptor_is_public_versioned_and_reports_the_engine_boundary() -> None:
    descriptor = PyneRuntimePlugin().describe()

    assert descriptor.id == RUNTIME_ID == "candlescope.pyne"
    assert descriptor.package == "candlescope-plugin-pyne"
    assert descriptor.version == PLUGIN_VERSION == "0.3.0.dev0"
    assert [language.id for language in descriptor.languages] == ["pyne"]
    assert descriptor.meta["expectedEngineVersion"] == EXPECTED_PYNE_VERSION
    assert descriptor.meta["executorBoundary"] == "sidecar-inline"
    assert descriptor.meta["renderCoverage"] == [
        "lines",
        "histograms",
        "markers",
        "hlines",
        "fills",
        "bgcolors",
        "labels",
        "barcolors",
        "signals",
        "strategy",
        "objects",
        "object_events",
    ]
    assert descriptor.meta["unsupportedRenderKinds"] == []


def test_descriptor_rejects_an_unpinned_installed_engine_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module.pyne_runtime, "__version__", "9.9.9")

    with pytest.raises(RuntimeError, match="requires pyne-runtime 0.3.0rc2"):
        PyneRuntimePlugin().describe()


def test_analyze_maps_pyne_errors_and_migration_hints() -> None:
    plugin = PyneRuntimePlugin()
    valid = plugin.analyze(AnalyzeRequest(source=SOURCE, context=_context()))
    invalid = plugin.analyze(AnalyzeRequest(source="if (", context=_context()))
    migration = plugin.analyze(
        AnalyzeRequest(source="if close > open:\n    plot(close)\n", context=_context())
    )

    assert valid.ok is True
    assert valid.executable is True
    assert invalid.ok is False
    assert invalid.executable is False
    assert invalid.diagnostics[0].code == "PYNE_SYNTAX_ERROR"
    assert invalid.diagnostics[0].severity == "error"
    assert invalid.diagnostics[0].span == {"line": 1, "column": 4}
    assert migration.ok is True
    assert migration.executable is True
    assert [item.code for item in migration.diagnostics] == ["PYNE_MIGRATION_HINT"]
    assert migration.diagnostics[0].severity == "warning"
    assert migration.diagnostics[0].data["docsUrl"].startswith("https://github.com/")


@pytest.mark.parametrize(
    "options",
    [
        {"securityMode": "invalid"},
        {"securityMode": 1},
        {"securityMode": "safe", "security_mode": "unsafe"},
    ],
)
def test_invalid_security_options_fail_closed(options: dict[str, Any]) -> None:
    plugin = PyneRuntimePlugin()

    analysis = plugin.analyze(AnalyzeRequest(source=SOURCE, context=_context(), options=options))
    execution = plugin.execute_batch(_execute_request(options=options))

    assert analysis.ok is False
    assert analysis.diagnostics[0].code == "PYNE_BRIDGE_OPTIONS_INVALID"
    assert execution.ok is False
    assert execution.diagnostics[0].code == "PYNE_BRIDGE_OPTIONS_INVALID"


def test_execute_maps_the_frozen_script_to_public_structured_render_ir() -> None:
    result = PyneRuntimePlugin().execute_batch(_execute_request())

    assert result.ok is True
    assert result.output is not None
    assert len(result.output.series) == 1
    line = result.output.series[0]
    assert line.id == "plot_1"
    assert line.title == "Double Close"
    assert line.pane == "separate"
    assert line.scale == "right"
    assert line.style == {
        "color": "#22c55e",
        "lineWidth": 2,
        "lineStyle": 0,
    }
    assert [point.value for point in line.points] == [202, 204, 206, 208, 210]
    assert result.output.meta == {"title": "Plugin Baseline", "overlay": False}
    assert result.meta == {
        "title": "Plugin Baseline",
        "overlay": False,
        "securityMode": "safe",
    }
    assert result.output.collections is not None
    structured = result.output.collections.to_wire()
    assert sorted(structured) == ["hlines", "lines", "markers"]
    assert structured["hlines"] == [
        {
            "price": 210.0,
            "title": "Threshold",
            "color": "#f59e0b",
            "linestyle": "dashed",
            "linewidth": 1,
            "pane": "separate",
        }
    ]
    assert len(structured["markers"][0]["data"]) == 5


def test_execute_preserves_a_meta_only_structured_result() -> None:
    result = PyneRuntimePlugin().execute_batch(
        _execute_request(source='indicator("Empty", overlay=false)\n')
    )

    assert result.ok is True
    assert result.output is not None
    assert result.output.collections is not None
    assert result.output.collections.to_wire() == {}
    assert result.output.meta == {"title": "Empty", "overlay": False}


def test_unknown_engine_output_collection_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runtime_module.pyne_runtime,
        "execute_pyne_script",
        lambda **_: SimpleNamespace(
            ok=True,
            lines=[],
            output={"privateObjects": [{"value": 1}]},
            meta={},
        ),
    )

    result = PyneRuntimePlugin().execute_batch(_execute_request())

    assert result.ok is False
    assert result.diagnostics[0].code == "PYNE_BRIDGE_OUTPUT_INVALID"
    assert "unsupported fields" in (result.diagnostics[0].hint or "")


def test_execute_injects_exact_chart_context_and_uses_inline_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_execute(**kwargs: Any) -> SimpleNamespace:
        captured.update(kwargs)
        return SimpleNamespace(ok=True, lines=[], output={}, meta={})

    monkeypatch.setattr(runtime_module.pyne_runtime, "execute_pyne_script", fake_execute)

    result = PyneRuntimePlugin().execute_batch(
        _execute_request(options={"securityMode": "research"})
    )

    assert result.ok is True
    assert captured["executor_mode"] == "inline"
    settings = captured["settings"]
    assert settings.executor_mode == "inline"
    assert settings.security_mode == "research"
    assert settings.syminfo.ticker == "BTCUSDT"
    assert settings.syminfo.tickerid == "BINANCE:BTCUSDT"
    assert settings.syminfo.prefix == "BINANCE"
    assert settings.syminfo.type == "spot"
    assert settings.timeframe.period == "1m"
    assert "isClosed" not in captured["ohlcv"][0]


def test_runtime_failure_is_returned_as_a_structured_diagnostic() -> None:
    result = PyneRuntimePlugin().execute_batch(_execute_request(source="raise ValueError('x')"))

    assert result.ok is False
    assert result.output is None
    assert result.diagnostics[0].code == "PYNE_RUNTIME_ERROR"
    assert result.diagnostics[0].severity == "error"


def test_malformed_engine_output_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        runtime_module.pyne_runtime,
        "execute_pyne_script",
        lambda **_: SimpleNamespace(
            ok=True, lines=[{"id": "bad", "data": [1]}], output={}, meta={}
        ),
    )

    result = PyneRuntimePlugin().execute_batch(_execute_request())

    assert result.ok is False
    assert result.diagnostics[0].code == "PYNE_BRIDGE_OUTPUT_INVALID"
    assert "point 0" in (result.diagnostics[0].hint or "")


def test_series_ids_are_normalized_and_deduplicated(monkeypatch: pytest.MonkeyPatch) -> None:
    lines = [
        {"id": "Bad ID", "name": "First", "data": []},
        {"id": "bad id", "name": "Second", "data": []},
    ]
    monkeypatch.setattr(
        runtime_module.pyne_runtime,
        "execute_pyne_script",
        lambda **_: SimpleNamespace(
            ok=True,
            lines=lines,
            output={"lines": lines},
            meta={},
        ),
    )

    result = PyneRuntimePlugin().execute_batch(_execute_request())

    assert result.ok is True
    assert result.output is not None
    assert [item.id for item in result.output.series] == ["bad-id", "bad-id-2"]
