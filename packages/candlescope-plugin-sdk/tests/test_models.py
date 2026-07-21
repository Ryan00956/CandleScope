from __future__ import annotations

import math

import pytest

from candlescope_plugin_sdk import (
    AnalyzeResult,
    Bar,
    Diagnostic,
    ExecuteBatchResult,
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_HISTOGRAM_SERIES_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    FEATURE_RENDER_STRUCTURED_OUTPUT_V1,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    MarketContext,
    ProtocolError,
    RenderCollections,
    RenderOutput,
    RuntimeDescriptor,
)


def _descriptor() -> RuntimeDescriptor:
    return RuntimeDescriptor(
        id="example-runtime",
        name="Example Runtime",
        version="1.2.3",
        package="candlescope-plugin-example",
        languages=(
            LanguageDescriptor(
                id="example",
                name="Example Script",
                extensions=(".example",),
            ),
        ),
        features=(
            FEATURE_BATCH_EXECUTION_V1,
            FEATURE_RENDER_LINE_SERIES_V1,
        ),
        required_host_features=(FEATURE_RENDER_LINE_SERIES_V1,),
        meta={"homepage": "https://example.invalid"},
    )


def test_runtime_descriptor_round_trips_wire_shape() -> None:
    descriptor = _descriptor()

    assert RuntimeDescriptor.from_wire(descriptor.to_wire()) == descriptor
    assert descriptor.to_wire()["requiredHostFeatures"] == [FEATURE_RENDER_LINE_SERIES_V1]


def test_runtime_descriptor_rejects_required_feature_not_declared() -> None:
    with pytest.raises(ProtocolError, match="requiredHostFeatures"):
        RuntimeDescriptor(
            id="broken-runtime",
            name="Broken",
            version="1.0.0",
            package="broken-package",
            languages=(LanguageDescriptor(id="broken", name="Broken"),),
            features=(FEATURE_BATCH_EXECUTION_V1,),
            required_host_features=(FEATURE_RENDER_LINE_SERIES_V1,),
        )


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_bar_rejects_non_finite_market_values(value: float) -> None:
    with pytest.raises(ProtocolError, match="finite"):
        Bar(
            time=1,
            open=1,
            high=2,
            low=0,
            close=value,
            volume=10,
        )


def test_render_output_round_trips_line_series() -> None:
    output = RenderOutput(
        series=(
            LineSeries(
                id="close",
                title="Close",
                points=(LinePoint(1, 10), LinePoint(2, None)),
                style={"color": "#22c55e"},
            ),
        ),
        meta={"runtime": "example-runtime"},
    )

    assert RenderOutput.from_wire(output.to_wire()) == output
    assert output.to_wire()["schema"] == "candlescope.render/1"
    assert "collections" not in output.to_wire()


def test_structured_render_collections_are_additive_and_json_only() -> None:
    output = RenderOutput(
        series=(
            LineSeries(
                id="volume",
                title="Volume",
                points=(LinePoint(1, 10, color="#22c55e"),),
                series_type="histogram",
            ),
        ),
        collections=RenderCollections(
            histograms=(
                {
                    "title": "Volume",
                    "color_up": "#22c55e",
                    "color_down": "#ef4444",
                    "pane": "separate",
                    "data": [{"time": 1, "value": 10, "color": "#22c55e"}],
                },
            ),
            markers=({"pane": "main", "data": [{"time": 1}]},),
            objects={"labels": [{"id": "label_1", "pane": "main"}]},
        ),
    )
    result = ExecuteBatchResult(
        ok=True,
        output=output,
        inputs=({"id": "length", "type": "int", "default": 20},),
    )

    wire = result.to_wire()
    assert wire["output"]["collections"].keys() == {
        "histograms",
        "markers",
        "objects",
    }
    assert wire["output"]["series"][0]["type"] == "histogram"
    assert wire["output"]["series"][0]["data"][0]["color"] == "#22c55e"
    assert ExecuteBatchResult.from_wire(wire) == result


def test_explicit_empty_structured_collections_survive_the_wire() -> None:
    output = RenderOutput(collections=RenderCollections())

    wire = output.to_wire()

    assert wire["collections"] == {}
    assert RenderOutput.from_wire(wire).collections == RenderCollections()


def test_structured_render_collections_reject_private_or_non_json_data() -> None:
    with pytest.raises(ProtocolError, match="unsupported fields"):
        RenderCollections.from_wire({"runtimePrivate": []})
    with pytest.raises(ProtocolError, match="JSON-compatible"):
        RenderCollections(markers=({"bad": object()},))
    with pytest.raises(ProtocolError, match="finite"):
        RenderCollections(markers=({"bad": math.nan},))


def test_new_render_features_are_stable_public_identifiers() -> None:
    assert FEATURE_RENDER_HISTOGRAM_SERIES_V1 == "render.histogram-series/1"
    assert FEATURE_RENDER_STRUCTURED_OUTPUT_V1 == "render.structured-output/1"


def test_successful_batch_result_requires_render_output() -> None:
    with pytest.raises(ProtocolError, match="requires output"):
        ExecuteBatchResult(ok=True)


def test_runtime_failure_is_a_structured_result() -> None:
    diagnostic = Diagnostic(
        code="SOURCE_INVALID",
        severity="error",
        message="Source is invalid.",
    )
    result = ExecuteBatchResult(ok=False, diagnostics=(diagnostic,))

    assert ExecuteBatchResult.from_wire(result.to_wire()) == result
    assert result.to_wire()["output"] is None
    with pytest.raises(ProtocolError, match="requires an error diagnostic"):
        ExecuteBatchResult(ok=False)
    with pytest.raises(ProtocolError, match="must not contain output"):
        ExecuteBatchResult(ok=False, output=RenderOutput(), diagnostics=(diagnostic,))


def test_analysis_result_round_trips_without_runtime_specific_types() -> None:
    result = AnalyzeResult(
        ok=True,
        executable=True,
        inputs=({"id": "length", "type": "int", "default": 20},),
        dependencies=({"kind": "market-context"},),
    )

    assert AnalyzeResult.from_wire(result.to_wire()) == result
    assert (
        MarketContext.from_wire(
            {
                "exchange": "binance",
                "marketType": "spot",
                "symbol": "BTCUSDT",
                "interval": "1m",
            }
        ).to_wire()["marketType"]
        == "spot"
    )
    with pytest.raises(ProtocolError, match="requires an error diagnostic"):
        AnalyzeResult(ok=False, executable=False)
