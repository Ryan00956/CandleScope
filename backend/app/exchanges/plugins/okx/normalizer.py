"""OKX raw payload normalizer."""
from __future__ import annotations

import logging

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    MarketEvent,
    RawMessage,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.interval_policy import (
    next_month_bucket,
    parse_interval_ms,
    parse_monthly_count,
)

logger = logging.getLogger("ingestion.normalizers.okx")

_OKX_INTERVALS_TO_INTERNAL = {
    "1s": "1s",
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "2H": "2h",
    "4H": "4h",
    "6H": "6h",
    "6Hutc": "6h",
    "12H": "12h",
    "12Hutc": "12h",
    "1D": "1d",
    "1Dutc": "1d",
    "2Dutc": "1d",
    "3D": "3d",
    "3Dutc": "3d",
    "1W": "1w",
    "1Wutc": "1w",
    "1M": "1M",
    "1Mutc": "1M",
}


class OkxNormalizer:
    """Convert OKX WS/REST payloads into MarketEvent objects."""

    def __init__(self, config: IngestionConfig, descriptor: StreamDescriptor) -> None:
        self._cfg = config
        self._descriptor = descriptor

    def parse(self, msg: RawMessage) -> MarketEvent | None:
        if msg.source == DataSource.WEBSOCKET:
            return self._parse_ws(msg)
        if msg.source in (DataSource.HTTP, DataSource.HTTP_BACKFILL):
            return self._parse_http(msg)
        logger.warning("Unknown data source: %s", msg.source)
        return None

    def _parse_ws(self, msg: RawMessage) -> MarketEvent | None:
        payload = msg.payload
        if not isinstance(payload, dict):
            return None

        rows = payload.get("data")
        if not isinstance(rows, list) or not rows:
            return None

        arg = payload.get("arg") if isinstance(payload.get("arg"), dict) else {}
        channel = str(arg.get("channel", ""))
        if msg.stream_type in (StreamType.TICKER, StreamType.MINI_TICKER):
            return self._parse_ticker_row(rows[0], msg)
        if msg.stream_type != StreamType.KLINE:
            return None
        return self._parse_kline_row(rows[0], msg, channel=channel)

    def _parse_http(self, msg: RawMessage) -> MarketEvent | None:
        if msg.stream_type in (StreamType.TICKER, StreamType.MINI_TICKER):
            return self._parse_ticker_row(msg.payload, msg)
        if msg.stream_type != StreamType.KLINE:
            return None
        return self._parse_kline_row(msg.payload, msg)

    def _parse_ticker_row(self, row: object, msg: RawMessage) -> MarketEvent | None:
        if not isinstance(row, dict):
            return None

        price = float(row.get("last", 0) or 0)
        open_price = float(row.get("open24h", 0) or 0)
        change_pct = ((price - open_price) / open_price) * 100 if open_price > 0 else 0.0
        event_time_ms = int(row.get("ts", msg.received_at_ms) or msg.received_at_ms)
        data = {
            "last_price": price,
            "open_price": open_price,
            "high_price": float(row.get("high24h", 0) or 0),
            "low_price": float(row.get("low24h", 0) or 0),
            "price_change_pct": change_pct,
            "volume": float(row.get("vol24h", 0) or 0),
            "quote_volume": float(row.get("volCcy24h", 0) or 0),
        }
        return MarketEvent(
            event_type=StreamType.TICKER,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=event_time_ms,
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            market_type=self._descriptor.market_type,
        )

    def _parse_kline_row(
        self,
        row: object,
        msg: RawMessage,
        channel: str = "",
    ) -> MarketEvent | None:
        if not isinstance(row, (list, tuple)) or len(row) < 9:
            logger.warning("OKX kline row too short (%s)", type(row).__name__)
            return None

        interval = self._resolve_interval(channel)
        open_time_ms = int(row[0])

        # OKX volume semantics differ by instrument type:
        # row[5] is contract count for futures/swap, while row[6] is base volume.
        market_type = (self._descriptor.market_type or "spot").strip().lower()
        if market_type in ("futures", "swap", "perpetual"):
            volume = float(row[6])
        else:
            volume = float(row[5])

        data = {
            "interval": interval,
            "open_time": open_time_ms,
            "close_time": _interval_close_time_ms(open_time_ms, interval),
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": volume,
            "quote_volume": float(row[7]),
            "trades": 0,
            "taker_buy_base": 0.0,
            "taker_buy_quote": 0.0,
            "is_closed": str(row[8]) == "1",
        }
        return MarketEvent(
            event_type=StreamType.KLINE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=open_time_ms,
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=open_time_ms,
            market_type=self._descriptor.market_type,
        )

    def _resolve_interval(self, channel: str) -> str:
        if channel.startswith("candle"):
            raw_interval = channel[len("candle"):]
            return _OKX_INTERVALS_TO_INTERNAL.get(raw_interval, self._descriptor.interval or "")
        return self._descriptor.interval or ""


def _interval_close_time_ms(open_time_ms: int, interval: str) -> int:
    month_count = parse_monthly_count(interval)
    if month_count is not None:
        return next_month_bucket(open_time_ms // 1000, month_count) * 1000 - 1

    interval_ms = parse_interval_ms(interval) or 0
    if interval_ms <= 0:
        return open_time_ms
    return open_time_ms + interval_ms - 1
