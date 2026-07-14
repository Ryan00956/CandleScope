from __future__ import annotations

import pytest

from app.data_engine.market_data import (
    DeliveryClass,
    MarketChannel,
    MarketStreamKey,
    TransportMode,
)


def test_market_stream_key_normalizes_identity_and_params() -> None:
    key = MarketStreamKey(
        " Binance ",
        " FUTURES ",
        " btcusdt ",
        " DEPTH ",  # type: ignore[arg-type]
        {" speed ": " 100ms ", "levels": 20},  # type: ignore[arg-type]
    )

    assert key.exchange == "binance"
    assert key.market_type == "futures"
    assert key.symbol == "BTCUSDT"
    assert key.channel is MarketChannel.DEPTH
    assert key.params == (("levels", "20"), ("speed", "100ms"))


def test_market_stream_key_hashes_equally_across_param_order() -> None:
    left = MarketStreamKey.build(
        "binance",
        "spot",
        "BTCUSDT",
        MarketChannel.KLINE,
        [("interval", "1m"), ("closed_only", True)],
    )
    right = MarketStreamKey.build(
        "BINANCE",
        "SPOT",
        "btcusdt",
        "kline",
        {"closed_only": "true", "interval": "1m"},
    )

    assert left == right
    assert hash(left) == hash(right)
    assert len({left, right}) == 1


def test_market_stream_key_serialization_and_topic_are_canonical() -> None:
    key = MarketStreamKey.build(
        "okx",
        "swap",
        "btc-usdt-swap",
        MarketChannel.DEPTH,
        levels=20,
        speed="100 ms",
    )

    assert key.topic == "okx:swap:BTC-USDT-SWAP@depth?levels=20&speed=100+ms"
    assert str(key) == key.topic
    assert key.to_dict() == {
        "exchange": "okx",
        "market_type": "swap",
        "symbol": "BTC-USDT-SWAP",
        "channel": "depth",
        "params": {"levels": "20", "speed": "100 ms"},
    }


def test_market_stream_enums_use_canonical_snake_case_values() -> None:
    assert [channel.value for channel in MarketChannel] == [
        "kline",
        "agg_trade",
        "trade",
        "ticker",
        "mini_ticker",
        "depth",
        "mark_price",
        "index_price",
        "funding_rate",
        "open_interest",
        "basis",
        "liquidation",
    ]
    assert [mode.value for mode in TransportMode] == [
        "websocket",
        "rest_poll",
        "rest_snapshot",
        "rest_history",
    ]
    assert [delivery.value for delivery in DeliveryClass] == [
        "latest",
        "append",
        "snapshot",
        "ordered_delta",
    ]


@pytest.mark.parametrize("field", ["exchange", "market_type", "symbol", "channel"])
def test_market_stream_key_rejects_blank_identity_fields(field: str) -> None:
    values = {
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "channel": "ticker",
    }
    values[field] = "   "

    with pytest.raises(ValueError, match="blank"):
        MarketStreamKey(**values)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "params, message",
    [
        ([("", "20")], "param name cannot be blank"),
        ([("levels", "   ")], "param 'levels' cannot be blank"),
        ([("levels", 20), ("levels", 50)], "duplicate market stream param"),
    ],
)
def test_market_stream_key_rejects_blank_or_duplicate_params(
    params: list[tuple[object, object]],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        MarketStreamKey.build("binance", "spot", "BTCUSDT", "depth", params)


def test_market_stream_key_build_rejects_duplicate_mapping_and_keyword_param() -> None:
    with pytest.raises(ValueError, match="duplicate market stream param"):
        MarketStreamKey.build(
            "binance",
            "spot",
            "BTCUSDT",
            "kline",
            {"interval": "1m"},
            interval="5m",
        )


@pytest.mark.parametrize("value", [[5, 10, 20], {"levels": 20}, {20, 50}, object()])
def test_market_stream_key_rejects_unstable_structured_param_values(value: object) -> None:
    with pytest.raises(TypeError, match="must be a string, integer, float, boolean, or enum"):
        MarketStreamKey.build(
            "binance",
            "spot",
            "BTCUSDT",
            "depth",
            params={"levels": value},
        )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_market_stream_key_rejects_non_finite_float_params(value: float) -> None:
    with pytest.raises(ValueError, match="must be finite"):
        MarketStreamKey.build(
            "binance",
            "spot",
            "BTCUSDT",
            "ticker",
            params={"threshold": value},
        )


def test_market_stream_key_rejects_string_items_in_pair_iterables() -> None:
    with pytest.raises(TypeError, match="key/value pair"):
        MarketStreamKey.build(
            "binance",
            "spot",
            "BTCUSDT",
            "depth",
            ["ab"],
        )
