from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any

import pytest

from candlescope_plugin_sdk import (
    AnalyzeRequest,
    Bar,
    ExecuteBatchRequest,
    MarketContext,
)
from candlescope_plugin_pine_compat import PineCompatRuntimePlugin
from candlescope_plugin_pine_compat import runtime as runtime_module


def _analysis(*features: str) -> dict[str, Any]:
    return {
        "schemaVersion": 5,
        "languageVersion": 5,
        "languageVersionOrigin": "explicit",
        "dialect": "v5",
        "scriptMode": "indicator",
        "diagnostics": [],
        "compatibility": {
            "supported": [
                {"feature": feature, "span": {"line": 2, "column": 1}}
                for feature in features
            ],
            "unsupported": [],
        },
        "executable": True,
        "inputs": [{"callSiteId": 1, "name": "input.int", "title": "Length"}],
    }


def _output(**updates: Any) -> dict[str, Any]:
    value = {
        "schemaVersion": 8,
        "renderMetadataVersion": 1,
        "plots": [{"id": 2, "values": [None, 2.0, 3.0]}],
        "plotChars": [],
        "plotShapes": [],
        "plotArrows": [],
        "plotBars": [],
        "plotCandles": [],
        "bgColors": [],
        "barColors": [],
        "hlines": [],
        "fills": [],
        "labels": [],
        "lines": [],
        "lineFills": [],
        "polylines": [],
        "boxes": [],
        "tables": [],
        "alerts": [],
        "diagnostics": [],
    }
    value.update(updates)
    return value


class FakeEngine:
    ANALYSIS_SCHEMA_VERSION = 5
    RUNTIME_SCHEMA_VERSION = 8
    RENDER_METADATA_VERSION = 1

    def __init__(self, analysis: dict[str, Any], output: dict[str, Any]) -> None:
        self.analysis = analysis
        self.output = output
        self.calls: list[tuple[Any, ...]] = []

    def analyze_script(self, _source: str) -> dict[str, Any]:
        return self.analysis

    def run_script(self, source: str, bars: list[dict[str, Any]], **options: Any) -> dict[str, Any]:
        self.calls.append((source, bars, options))
        return self.output


def _context() -> MarketContext:
    return MarketContext("binance", "futures", "BTCUSDT", "1h")


def _bars(*, closed: bool = True) -> tuple[Bar, ...]:
    return tuple(
        Bar(
            time=1_700_000_000 + index * 60,
            open=1 + index,
            high=2 + index,
            low=0.5 + index,
            close=1.5 + index,
            volume=10,
            is_closed=closed,
        )
        for index in range(3)
    )


def _install_fake(monkeypatch: pytest.MonkeyPatch, engine: FakeEngine) -> None:
    monkeypatch.setattr(runtime_module, "_load_engine", lambda: engine)
    monkeypatch.setattr(runtime_module, "_engine_version", lambda: "0.2.0")


def test_descriptor_advertises_pine_without_source_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeEngine(_analysis("indicator", "plot"), _output())
    _install_fake(monkeypatch, engine)

    descriptor = PineCompatRuntimePlugin().describe()

    assert descriptor.id == "candlescope.pine-compat"
    assert descriptor.languages[0].id == "pine"
    assert descriptor.meta["sourceSnapshot"] is False
    assert descriptor.meta["closedBarsOnly"] is True
    assert descriptor.meta["formingBar"] is False
    assert descriptor.meta["ui"]["languages"]["pine"]["monacoLanguage"] == "pine"


def test_analysis_blocks_unhosted_features_before_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeEngine(_analysis("indicator", "request.security", "plot"), _output())
    _install_fake(monkeypatch, engine)

    result = PineCompatRuntimePlugin().analyze(
        AnalyzeRequest(source="indicator('x')", context=_context())
    )

    assert result.ok is False
    assert result.diagnostics[-1].code == "PINE_HOST_CAPABILITY_UNSUPPORTED"
    assert result.diagnostics[-1].data["blockedFeatures"] == ["request.security"]


def test_execute_preserves_exact_context_and_render_mapping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeEngine(
        _analysis("indicator", "syminfo.tickerid", "timeframe.period", "plot"),
        _output(),
    )
    _install_fake(monkeypatch, engine)

    result = PineCompatRuntimePlugin().execute_batch(
        ExecuteBatchRequest(
            source='//@version=5\nindicator("SMA", overlay=true)\nplot(close)',
            context=_context(),
            bars=_bars(),
            params={"1": 2},
        )
    )

    assert result.ok is True
    assert result.output is not None and result.output.collections is not None
    assert result.output.collections.lines[0]["id"] == "pine-plot-2"
    assert [point["time"] for point in result.output.collections.lines[0]["data"]] == [
        1_700_000_060,
        1_700_000_120,
    ]
    assert engine.calls[0][1][0]["time"] == 1_700_000_000_000
    assert engine.calls[0][2] == {
        "input_overrides": {1: 2},
        "chart_symbol": "BINANCE:BTCUSDT.P",
        "chart_timeframe": "60",
    }


def test_forming_bar_and_unmapped_native_output_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeEngine(_analysis("indicator", "plot"), _output())
    _install_fake(monkeypatch, engine)
    forming = PineCompatRuntimePlugin().execute_batch(
        ExecuteBatchRequest(source="indicator('x')", context=_context(), bars=_bars(closed=False))
    )
    engine.output = _output(labels=[{"id": 1}])
    unmapped = PineCompatRuntimePlugin().execute_batch(
        ExecuteBatchRequest(source="indicator('x')", context=_context(), bars=_bars())
    )

    assert forming.diagnostics[0].code == "PINE_CLOSED_BARS_REQUIRED"
    assert unmapped.diagnostics[0].code == "PINE_HOST_OUTPUT_UNSUPPORTED"


def _shadow_projection(result: Any) -> dict[str, Any]:
    assert result.ok and result.output is not None and result.output.collections is not None
    collections = result.output.collections.to_wire()
    series = []
    for item in collections.get("lines", []):
        series.append(
            {
                "id": item["id"],
                "title": item["title"],
                "type": "line",
                "pane": item["pane"],
                "color": item["color"],
                "values": [point["value"] for point in item["data"]],
            }
        )
    for item in collections.get("histograms", []):
        series.append(
            {
                "id": item["id"],
                "title": item["title"],
                "type": "histogram",
                "pane": item["pane"],
                "color": item["color_up"],
                "values": [point["value"] for point in item["data"]],
            }
        )
    markers = [
        {
            "id": item["id"],
            "title": item["title"],
            "pane": item["pane"],
            "shape": item["shape"],
            "position": item["position"],
            "color": item["color"],
            "times": [point["time"] for point in item["data"]],
        }
        for item in collections.get("markers", [])
    ]
    inputs = [
        {key: item[key] for key in ("id", "type", "title", "current") if key in item}
        for item in result.inputs
    ]
    return {"series": series, "markers": markers, "inputs": inputs}


def test_public_v020_matches_frozen_legacy_adapter_shadow_fixture() -> None:
    try:
        importlib.import_module("pine_compat")
    except ImportError:
        pytest.skip("public pine-compat-runtime wheel is not installed")
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "phase8_shadow_v020.json").read_text(
            encoding="utf-8"
        )
    )
    context = MarketContext.from_wire(fixture["context"])
    bars = tuple(Bar.from_wire(item) for item in fixture["bars"])
    plugin = PineCompatRuntimePlugin()

    for case in fixture["cases"]:
        result = plugin.execute_batch(
            ExecuteBatchRequest(
                source=case["source"],
                context=context,
                bars=bars,
                params=case["params"],
            )
        )
        assert _shadow_projection(result) == case["expected"], case["id"]
