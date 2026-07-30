from __future__ import annotations

import pytest

from candlescope_plugin_sdk.platform_v2 import (
    BarsReadRequest,
    BarsSubscribeRequest,
    CHART_CONTEXT_V1,
    ChartContextReadRequest,
    ChartContextSnapshot,
    ChartLayerPublishRequest,
    MARKET_BARS_PAGE_V1,
    MARKET_STREAM_V1,
    MarketContext,
    PlatformContractError,
    RENDER_IR_V1,
    RENDER_IR_V2,
    RenderBudget,
    validate_market_bars_page,
    validate_market_stream_event,
    validate_render_ir,
)


def test_market_requests_are_strict_bounded_and_context_explicit() -> None:
    request = BarsReadRequest.from_wire(
        {
            "context": {
                "mode": "live",
                "exchange": "binance",
                "marketType": "spot",
            },
            "series": {"symbol": "btcusdt", "interval": "1m"},
            "startMs": 60_000,
            "endMs": 120_000,
            "limit": 2,
        }
    )
    assert request.context == MarketContext("live", "binance", "spot")
    assert request.series.symbol == "BTCUSDT"

    subscription = BarsSubscribeRequest.from_wire(
        {
            "context": request.context.to_wire(),
            "series": request.series.to_wire(),
            "queueCapacity": 32,
            "maxBatch": 8,
            "maxLatencyMs": 10,
        }
    )
    assert subscription.queue_capacity == 32

    with pytest.raises(PlatformContractError, match="invalid shape"):
        BarsReadRequest.from_wire(
            {
                "context": request.context.to_wire(),
                "series": request.series.to_wire(),
                "privateDataManager": True,
            }
        )
    with pytest.raises(PlatformContractError, match="startMs"):
        BarsReadRequest.from_wire(
            {
                "context": request.context.to_wire(),
                "series": request.series.to_wire(),
                "startMs": 2,
                "endMs": 1,
            }
        )
    with pytest.raises(PlatformContractError, match="queueCapacity"):
        BarsSubscribeRequest.from_wire(
            {
                "context": request.context.to_wire(),
                "series": request.series.to_wire(),
                "queueCapacity": 1_025,
            }
        )


def test_market_page_and_stream_event_validate_public_bar_shape() -> None:
    context = {"mode": "live", "exchange": "binance", "marketType": "spot"}
    series = {"symbol": "BTCUSDT", "interval": "1m"}
    bar = {
        "time": 1_700_000_000,
        "open": 100.0,
        "high": 102.0,
        "low": 99.0,
        "close": 101.0,
        "volume": 10.0,
        "is_closed": True,
    }
    page = validate_market_bars_page(
        {
            "schemaVersion": MARKET_BARS_PAGE_V1,
            "context": context,
            "series": series,
            "data": [bar],
            "coverage": {"verifiedContiguous": True, "allRowsFinal": True},
            "sourceQuality": {"source": "storage", "trustedFinal": True},
            "pagination": {"hasMore": False},
        }
    )
    assert page["data"] == [bar]

    event = validate_market_stream_event(
        {
            "schemaVersion": MARKET_STREAM_V1,
            "subscriptionId": "sub-1",
            "streamId": "stream-1",
            "generation": 1,
            "sequence": 1,
            "eventType": "bar.closed",
            "context": context,
            "series": series,
            "bar": bar,
            "emittedAtMs": 1_700_000_060_000,
        }
    )
    assert event["sequence"] == 1

    with pytest.raises(PlatformContractError, match="eventType"):
        validate_market_stream_event({**event, "eventType": "private.cache.write"})


def test_render_ir_is_marker_only_and_enforces_item_text_and_byte_budgets() -> None:
    assert RenderBudget(1, 2_048, 32) == RenderBudget(
        max_items=1,
        max_bytes=2_048,
        max_text_chars=32,
    )
    render = validate_render_ir(
        {
            "schemaVersion": RENDER_IR_V1,
            "items": [
                {
                    "id": "signal-1",
                    "type": "marker",
                    "time": 1_700_000_000,
                    "position": "aboveBar",
                    "shape": "arrowDown",
                    "color": "#EF4444",
                    "text": "scanner signal",
                    "price": 101.0,
                }
            ],
        },
        budget=RenderBudget(max_items=1, max_bytes=2_048, max_text_chars=32),
    )
    assert render["schemaVersion"] == RENDER_IR_V1

    with pytest.raises(PlatformContractError, match="item budget"):
        validate_render_ir(
            {"schemaVersion": RENDER_IR_V1, "items": render["items"] * 2},
            budget=RenderBudget(max_items=1),
        )
    with pytest.raises(PlatformContractError, match="only supports marker"):
        validate_render_ir(
            {
                "schemaVersion": RENDER_IR_V1,
                "items": [{**render["items"][0], "type": "host-component"}],
            }
        )


def test_chart_render_v2_supports_bounded_analysis_geometry() -> None:
    render = validate_render_ir(
        {
            "schemaVersion": RENDER_IR_V2,
            "items": [
                {
                    "id": "wave-path",
                    "type": "polyline",
                    "points": [
                        {"time": 100, "price": 10.0},
                        {"time": 200, "price": 12.0},
                        {"time": 300, "price": 11.0},
                    ],
                    "color": "#3B82F6",
                    "width": 2,
                    "style": "solid",
                },
                {
                    "id": "wave-label",
                    "type": "label",
                    "time": 200,
                    "price": 12.0,
                    "text": "(3)",
                    "color": "#FFFFFF",
                    "backgroundColor": "#1D4ED8CC",
                    "position": "above",
                },
                {
                    "id": "invalidation",
                    "type": "price-line",
                    "price": 9.5,
                    "color": "#EF4444",
                    "width": 1,
                    "style": "dashed",
                    "text": "invalid",
                },
                {
                    "id": "target",
                    "type": "band",
                    "startTime": 300,
                    "endTime": 600,
                    "lowerPrice": 13.0,
                    "upperPrice": 14.0,
                    "fillColor": "#22C55E22",
                    "borderColor": "#22C55E",
                },
            ],
        },
        budget=RenderBudget(
            max_items=4,
            max_points=3,
            max_bytes=8_192,
            max_text_chars=16,
        ),
    )
    assert render["schemaVersion"] == RENDER_IR_V2
    assert [item["type"] for item in render["items"]] == [
        "polyline",
        "label",
        "price-line",
        "band",
    ]

    with pytest.raises(PlatformContractError, match="point budget"):
        validate_render_ir(
            {
                "schemaVersion": RENDER_IR_V2,
                "items": [
                    {
                        **render["items"][0],
                        "id": "first",
                    },
                    {
                        **render["items"][0],
                        "id": "second",
                    },
                ],
            },
            budget=RenderBudget(max_points=5),
        )
    with pytest.raises(PlatformContractError, match="2 to 10000 points"):
        validate_render_ir(
            {
                "schemaVersion": RENDER_IR_V2,
                "items": [
                    {
                        **render["items"][0],
                        "points": [{"time": index, "price": 10} for index in range(10_001)],
                    }
                ],
            },
            budget=RenderBudget(
                max_points=20_000,
                max_bytes=1024 * 1024,
            ),
        )
    with pytest.raises(PlatformContractError, match="strictly increasing"):
        validate_render_ir(
            {
                "schemaVersion": RENDER_IR_V2,
                "items": [
                    {
                        **render["items"][0],
                        "points": [
                            {"time": 200, "price": 10},
                            {"time": 100, "price": 11},
                        ],
                    }
                ],
            }
        )


def test_chart_context_and_v2_publish_requests_are_typed_and_exact() -> None:
    context = MarketContext("live", "binance", "spot")
    series = BarsReadRequest.from_wire(
        {
            "context": context.to_wire(),
            "series": {"symbol": "BTCUSDT", "interval": "1m"},
        }
    ).series
    snapshot = ChartContextSnapshot.from_wire(
        {
            "schemaVersion": CHART_CONTEXT_V1,
            "chartId": "main-chart",
            "revision": 7,
            "active": True,
            "context": context.to_wire(),
            "series": series.to_wire(),
            "updatedAtMs": 1_700_000_000_000,
        }
    )
    assert snapshot.active is True
    assert ChartContextReadRequest().to_wire() == {"chartId": "main-chart"}
    publish = ChartLayerPublishRequest(
        layer_id="waves",
        chart_id=snapshot.chart_id,
        chart_revision=snapshot.revision,
        context=context,
        series=series,
        revision=1,
        render={
            "schemaVersion": RENDER_IR_V2,
            "items": [
                {
                    "id": "path",
                    "type": "polyline",
                    "points": [
                        {"time": 100, "price": 10},
                        {"time": 200, "price": 12},
                    ],
                    "color": "#3B82F6",
                    "width": 2,
                    "style": "solid",
                }
            ],
        },
    )
    assert publish.to_wire()["chartRevision"] == 7

    with pytest.raises(PlatformContractError, match="inactive"):
        ChartContextSnapshot.from_wire(
            {
                **snapshot.to_wire(),
                "active": False,
            }
        )
