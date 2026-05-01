from __future__ import annotations

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.ingestion.normalize import NormalizeLayer
from app.data_engine.ingestion.normalizers import BinanceNormalizer, OkxNormalizer


def _msg(
    payload: dict | list,
    *,
    source: DataSource,
    stream_type: StreamType,
    received_at_ms: int = 123_456,
) -> RawMessage:
    return RawMessage(
        payload=payload,
        source=source,
        stream_type=stream_type,
        received_at_ms=received_at_ms,
    )


def test_binance_ws_kline_normalizer() -> None:
    descriptor = StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
    normalizer = BinanceNormalizer(IngestionConfig(), descriptor)
    event = normalizer.parse(
        _msg(
            {
                "e": "kline",
                "E": 60_010,
                "s": "BTCUSDT",
                "k": {
                    "t": 60_000,
                    "T": 119_999,
                    "i": "1m",
                    "o": "1",
                    "h": "3",
                    "l": "0.5",
                    "c": "2",
                    "v": "10",
                    "q": "20",
                    "n": 4,
                    "V": "6",
                    "Q": "12",
                    "x": False,
                },
            },
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.KLINE,
        )
    )

    assert event is not None
    assert event.event_type == StreamType.KLINE
    assert event.exchange == "binance"
    assert event.event_time_ms == 60_010
    assert event.sequence == 60_000
    assert event.data["open_time"] == 60_000
    assert event.data["close_time"] == 119_999
    assert event.data["is_closed"] is False
    assert event.data["taker_buy_base"] == 6


def test_okx_ws_ticker_normalizer() -> None:
    descriptor = StreamDescriptor("BTC-USDT", StreamType.TICKER, exchange="okx")
    normalizer = OkxNormalizer(IngestionConfig(), descriptor)
    event = normalizer.parse(
        _msg(
            {
                "arg": {"channel": "tickers"},
                "data": [{
                    "last": "105",
                    "open24h": "100",
                    "high24h": "110",
                    "low24h": "90",
                    "vol24h": "12",
                    "volCcy24h": "1260",
                    "ts": "123456",
                }],
            },
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.TICKER,
        )
    )

    assert event is not None
    assert event.event_type == StreamType.TICKER
    assert event.exchange == "okx"
    assert event.event_time_ms == 123_456
    assert event.data["last_price"] == 105
    assert event.data["price_change_pct"] == 5
    assert event.data["quote_volume"] == 1260


def test_okx_futures_kline_uses_base_currency_volume() -> None:
    descriptor = StreamDescriptor(
        "BTC-USDT-SWAP",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
        market_type="futures",
    )
    normalizer = OkxNormalizer(IngestionConfig(), descriptor)
    event = normalizer.parse(
        _msg(
            [60_000, "1", "3", "0.5", "2", "999999", "12.5", "25", "1"],
            source=DataSource.HTTP_BACKFILL,
            stream_type=StreamType.KLINE,
        )
    )

    assert event is not None
    assert event.data["volume"] == 12.5
    assert event.data["quote_volume"] == 25
    assert event.data["close_time"] == 119_999
    assert event.data["is_closed"] is True


def test_normalize_layer_dispatches_by_exchange() -> None:
    descriptor = StreamDescriptor(
        "BTC-USDT",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
    )
    layer = NormalizeLayer(IngestionConfig(), descriptor)
    event = layer.parse_raw(
        _msg(
            ["60000", "1", "3", "0.5", "2", "9", "10", "18", "1"],
            source=DataSource.HTTP,
            stream_type=StreamType.KLINE,
        )
    )

    assert event is not None
    assert event.exchange == "okx"
    assert event.stream_key == "okx:BTC-USDT@kline_1m"
    assert event.data["volume"] == 9
    assert layer.snapshot()["normalizer"] == "OkxNormalizer"
