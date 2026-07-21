from __future__ import annotations

from types import SimpleNamespace

from candlescope_plugin_sdk import (
    ExecuteBatchResult,
    LinePoint,
    LineSeries,
    RenderCollections,
    RenderOutput,
)

from app.indicator.serialization import (
    serialize_plugin_runtime_result,
    serialize_pyne_result,
)


def _phase0_records() -> tuple[list[dict], list[dict], list[dict]]:
    times = [1700000000, 1700000060, 1700000120, 1700000180, 1700000240]
    values = [202.0, 204.0, 206.0, 208.0, 210.0]
    points = [
        {"time": timestamp, "value": value}
        for timestamp, value in zip(times, values, strict=True)
    ]
    raw_lines = [
        {
            "id": "plot_1",
            "title": "Double Close",
            "color": "#22c55e",
            "linewidth": 2,
            "style": "solid",
            "pane": "separate",
            "data": points,
        }
    ]
    hlines = [
        {
            "price": 210.0,
            "title": "Threshold",
            "color": "#f59e0b",
            "linestyle": "dashed",
            "linewidth": 1,
            "pane": "separate",
        }
    ]
    marker_points = [
        {
            "time": timestamp,
            "shape": "circle",
            "color": "#3b82f6",
            "text": "UP",
            "position": "above",
            "size": "normal",
            "pane": "separate",
        }
        for timestamp in times
    ]
    markers = [
        {
            "shape": "circle",
            "text": "UP",
            "position": "above",
            "size": "normal",
            "color": "#3b82f6",
            "pane": "separate",
            "data": marker_points,
        }
    ]
    return raw_lines, hlines, markers


def test_structured_render_ir_rebuilds_the_frozen_pyne_envelope_exactly() -> None:
    raw_lines, hlines, markers = _phase0_records()
    flat_lines = [
        {
            "id": "plot_1",
            "name": "Double Close",
            "color": "#22c55e",
            "type": "line",
            "pane": "separate",
            "lineWidth": 2,
            "lineStyle": 0,
            "data": raw_lines[0]["data"],
        }
    ]
    output_meta = {"title": "Plugin Baseline", "overlay": False}
    result_meta = {**output_meta, "securityMode": "safe"}
    raw_output = {
        "meta": output_meta,
        "lines": raw_lines,
        "hlines": hlines,
        "markers": markers,
    }
    legacy = SimpleNamespace(
        ok=True,
        error=None,
        code=None,
        line=None,
        column=None,
        hint=None,
        lines=flat_lines,
        output=raw_output,
        param_schema=[],
        meta=result_meta,
    )
    plugin = ExecuteBatchResult(
        ok=True,
        output=RenderOutput(
            series=(
                LineSeries(
                    id="plot_1",
                    title="Double Close",
                    pane="separate",
                    points=tuple(
                        LinePoint(point["time"], point["value"])
                        for point in raw_lines[0]["data"]
                    ),
                    style={
                        "color": "#22c55e",
                        "lineWidth": 2,
                        "lineStyle": 0,
                    },
                ),
            ),
            collections=RenderCollections(
                lines=tuple(raw_lines),
                hlines=tuple(hlines),
                markers=tuple(markers),
            ),
            meta=output_meta,
        ),
        meta=result_meta,
    )

    assert serialize_plugin_runtime_result(plugin) == serialize_pyne_result(legacy)


def test_structured_render_ir_preserves_parameters_and_fill_compatibility() -> None:
    result = ExecuteBatchResult(
        ok=True,
        output=RenderOutput(
            collections=RenderCollections(
                fills=(
                    {
                        "plot1_id": "fast",
                        "plot2_id": "slow",
                        "color": "rgba(1,2,3,0.2)",
                        "title": "Band",
                        "pane": "separate",
                    },
                ),
            ),
        ),
        inputs=({"id": "length", "type": "int", "default": 20},),
    )

    payload = serialize_plugin_runtime_result(result)

    assert payload["result"]["fills"] == payload["legacyFills"]
    assert payload["param_schema"] == [{"id": "length", "type": "int", "default": 20}]
    assert payload["fills"][0]["seriesIds"] == ["fast", "slow"]


def test_empty_structured_collections_preserve_a_meta_only_legacy_result() -> None:
    output_meta = {"title": "Empty", "overlay": False}
    result_meta = {**output_meta, "securityMode": "safe"}
    legacy = SimpleNamespace(
        ok=True,
        error=None,
        code=None,
        line=None,
        column=None,
        hint=None,
        lines=[],
        output={"meta": output_meta},
        param_schema=[],
        meta=result_meta,
    )
    plugin = ExecuteBatchResult(
        ok=True,
        output=RenderOutput(
            collections=RenderCollections(),
            meta=output_meta,
        ),
        meta=result_meta,
    )

    assert serialize_plugin_runtime_result(plugin) == serialize_pyne_result(legacy)


def test_structured_histogram_preserves_identity_width_and_per_bar_color() -> None:
    color_data = [{"time": 1700000000, "color": "#ef4444"}]
    result = ExecuteBatchResult(
        ok=True,
        output=RenderOutput(
            collections=RenderCollections(
                histograms=(
                    {
                        "id": "pine-plot-7",
                        "title": "Momentum",
                        "color_up": "#22c55e",
                        "pane": "separate",
                        "linewidth": 4,
                        "linestyle": "dotted",
                        "colorData": color_data,
                        "per_bar_color": True,
                        "data": [{"time": 1700000000, "value": 2.5}],
                    },
                ),
            ),
        ),
    )

    payload = serialize_plugin_runtime_result(result)

    assert payload["lines"] == [
        {
            "id": "pine-plot-7",
            "name": "Momentum",
            "color": "#22c55e",
            "type": "histogram",
            "pane": "separate",
            "lineWidth": 4,
            "lineStyle": 1,
            "colorData": color_data,
            "per_bar_color": True,
            "data": [{"time": 1700000000, "value": 2.5}],
        }
    ]
    assert payload["series"][0]["localId"] == "pine-plot-7"
    assert payload["series"][0]["style"]["lineWidth"] == 4
    assert payload["series"][0]["style"]["colorData"] == color_data
