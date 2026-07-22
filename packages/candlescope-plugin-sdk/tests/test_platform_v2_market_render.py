from __future__ import annotations

import pytest

from candlescope_plugin_sdk.platform_v2 import (
    BarsReadRequest,
    BarsSubscribeRequest,
    MARKET_BARS_PAGE_V1,
    MARKET_STREAM_V1,
    MarketContext,
    PlatformContractError,
    RENDER_IR_V1,
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
