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

logger = logging.getLogger("ingestion.normalizers.template")


class TemplateNormalizer:
    """Convert raw exchange payloads into MarketEvent objects."""

    def __init__(self, config: IngestionConfig, descriptor: StreamDescriptor) -> None:
        self._cfg = config
        self._descriptor = descriptor

    def parse(self, msg: RawMessage) -> MarketEvent | None:
        if msg.stream_type == StreamType.KLINE:
            return self._parse_kline(msg)
        if msg.stream_type in (StreamType.TICKER, StreamType.MINI_TICKER):
            return self._parse_ticker(msg)
        logger.warning("No template parser for stream type: %s", msg.stream_type)
        return None

    def _parse_kline(self, msg: RawMessage) -> MarketEvent | None:
        row = msg.payload
        if not isinstance(row, dict):
            return None

        open_time = int(row.get("open_time", row.get("t", 0)) or 0)
        interval = self._descriptor.interval or str(row.get("interval", ""))
        data = {
            "interval": interval,
            "open_time": open_time,
            "close_time": int(row.get("close_time", row.get("T", open_time)) or open_time),
            "open": float(row.get("open", row.get("o", 0)) or 0),
            "high": float(row.get("high", row.get("h", 0)) or 0),
            "low": float(row.get("low", row.get("l", 0)) or 0),
            "close": float(row.get("close", row.get("c", 0)) or 0),
            "volume": float(row.get("volume", row.get("v", 0)) or 0),
            "quote_volume": float(row.get("quote_volume", row.get("q", 0)) or 0),
            "trades": int(row.get("trades", row.get("n", 0)) or 0),
            "taker_buy_base": float(row.get("taker_buy_base", 0) or 0),
            "taker_buy_quote": float(row.get("taker_buy_quote", 0) or 0),
            "is_closed": bool(row.get("is_closed", True)),
        }
        return MarketEvent(
            event_type=StreamType.KLINE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=open_time or msg.received_at_ms,
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=open_time,
        )

    def _parse_ticker(self, msg: RawMessage) -> MarketEvent | None:
        row = msg.payload
        if not isinstance(row, dict):
            return None

        price = float(row.get("last_price", row.get("price", row.get("last", 0))) or 0)
        open_price = float(row.get("open_price", row.get("open", 0)) or 0)
        change_pct = ((price - open_price) / open_price) * 100 if open_price > 0 else 0.0
        data = {
            "last_price": price,
            "open_price": open_price,
            "high_price": float(row.get("high_price", row.get("high", 0)) or 0),
            "low_price": float(row.get("low_price", row.get("low", 0)) or 0),
            "price_change_pct": change_pct,
            "volume": float(row.get("volume", 0) or 0),
            "quote_volume": float(row.get("quote_volume", 0) or 0),
        }
        return MarketEvent(
            event_type=StreamType.TICKER,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(row.get("ts", msg.received_at_ms) or msg.received_at_ms),
            received_at_ms=msg.received_at_ms,
            source=DataSource.WEBSOCKET if msg.source == DataSource.WEBSOCKET else msg.source,
            data=data,
            stream_key=self._descriptor.key,
        )
