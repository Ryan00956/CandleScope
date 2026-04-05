"""
L4: Normalize Layer — unified data format conversion.

Responsibilities:
  * Convert raw exchange payloads → ``MarketEvent``
  * Support multiple stream types: kline, aggTrade, trade, ticker, depth
  * Abstract away format differences between WS and REST responses
  * Tag each event with its ``DataSource``
  * Reject / log malformed payloads without crashing the pipeline

This layer does NOT produce domain-specific types (like KlineBar).
It outputs the generic ``MarketEvent`` with standardized ``data`` dicts.
Downstream consumers interpret the ``data`` based on ``event_type``.

Standardized ``data`` schemas per StreamType:

  KLINE::
    {
      "interval": "1m",
      "open_time": 1672531200000,
      "close_time": 1672531259999,
      "open": 16500.0,
      "high": 16510.0,
      "low": 16490.0,
      "close": 16505.0,
      "volume": 100.5,
      "quote_volume": 1658250.0,
      "trades": 350,
      "taker_buy_base": 60.3,
      "taker_buy_quote": 995000.0,
      "is_closed": true
    }

  AGG_TRADE::
    {
      "agg_trade_id": 123456,
      "price": 16500.0,
      "quantity": 0.5,
      "first_trade_id": 100,
      "last_trade_id": 105,
      "trade_time_ms": 1672531200123,
      "is_buyer_maker": false
    }

  TRADE::
    {
      "trade_id": 12345,
      "price": 16500.0,
      "quantity": 0.5,
      "trade_time_ms": 1672531200123,
      "is_buyer_maker": false,
      "buyer_order_id": 111,
      "seller_order_id": 222
    }

  TICKER::
    {
      "price_change": 100.0,
      "price_change_pct": 0.61,
      "weighted_avg_price": 16480.0,
      "prev_close_price": 16400.0,
      "last_price": 16500.0,
      "last_qty": 0.1,
      "bid_price": 16499.0,
      "bid_qty": 5.0,
      "ask_price": 16501.0,
      "ask_qty": 3.0,
      "open_price": 16400.0,
      "high_price": 16600.0,
      "low_price": 16300.0,
      "volume": 50000.0,
      "quote_volume": 825000000.0,
      "open_time": 1672444800000,
      "close_time": 1672531199999,
      "trades": 100000
    }

  MINI_TICKER::
    {
      "close_price": 16500.0,
      "open_price": 16400.0,
      "high_price": 16600.0,
      "low_price": 16300.0,
      "volume": 50000.0,
      "quote_volume": 825000000.0
    }

  DEPTH::
    {
      "last_update_id": 123456789,
      "bids": [[16499.0, 5.0], [16498.0, 3.0], ...],
      "asks": [[16501.0, 2.0], [16502.0, 4.0], ...]
    }
"""
from __future__ import annotations

import logging
import time
from typing import Callable, Awaitable

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import (
    StreamDescriptor,
    StreamType,
    DataSource,
    RawMessage,
    MarketEvent,
)

logger = logging.getLogger("ingestion.L4_Normalize")

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
    "12H": "12h",
    "1D": "1d",
    "3D": "3d",
    "1W": "1w",
    "1M": "1M",
}


class NormalizeLayer:
    """Converts ``RawMessage`` → ``MarketEvent``."""

    def __init__(
        self,
        config: IngestionConfig,
        descriptor: StreamDescriptor,
    ) -> None:
        self._cfg = config
        self._descriptor = descriptor
        self._metrics = LayerMetrics("L4_Normalize")

        # Upstream callback
        self._on_event: Callable[[MarketEvent], Awaitable[None]] | None = None

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "layer": "L4_Normalize",
            "stream_key": self._descriptor.key,
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Register callback ────────────────────────────

    def on_event(self, callback: Callable[[MarketEvent], Awaitable[None]]) -> None:
        """Register upstream callback (consumed by L5 Continuity)."""
        self._on_event = callback

    # ── Public: Ingest (called by L3) ────────────────────────

    async def ingest(self, msg: RawMessage) -> None:
        """Normalize a raw message and forward the resulting MarketEvent."""
        self._metrics.inc("messages_received")
        try:
            event = self._parse(msg)
        except Exception as exc:
            self._metrics.inc("parse_errors")
            logger.warning(
                "Failed to parse raw message: %s — payload: %s",
                exc, _truncate(msg.payload),
            )
            return

        if event is None:
            # Valid parse but nothing to emit (e.g. non-matching WS event)
            self._metrics.inc("messages_skipped")
            return

        self._metrics.inc("events_emitted")
        self._metrics.mark("last_event_at")

        if self._on_event:
            await self._on_event(event)

    # ── Public: Parse without callback (for L5 backfill etc.) ──

    def parse_raw(self, msg: RawMessage) -> MarketEvent | None:
        """Parse a raw message into a MarketEvent without triggering callbacks."""
        return self._parse(msg)

    # ── Internal: Parse dispatch ─────────────────────────────

    def _parse(self, msg: RawMessage) -> MarketEvent | None:
        """Dispatch to the right parser based on stream_type + source."""
        st = msg.stream_type

        if msg.source == DataSource.WEBSOCKET:
            return self._parse_ws(msg)
        if msg.source in (DataSource.HTTP, DataSource.HTTP_BACKFILL):
            return self._parse_http(msg)

        logger.warning("Unknown data source: %s", msg.source)
        return None

    # ═══════════════════════════════════════════════════════════
    #  WebSocket parsers
    # ═══════════════════════════════════════════════════════════

    def _parse_ws(self, msg: RawMessage) -> MarketEvent | None:
        st = msg.stream_type
        payload = msg.payload

        if not isinstance(payload, dict):
            return None

        if self._descriptor.exchange == "okx":
            return self._parse_okx_ws(msg)

        if st == StreamType.KLINE:
            return self._parse_ws_kline(payload, msg)
        if st == StreamType.AGG_TRADE:
            return self._parse_ws_agg_trade(payload, msg)
        if st == StreamType.TRADE:
            return self._parse_ws_trade(payload, msg)
        if st in (StreamType.TICKER, StreamType.MINI_TICKER):
            return self._parse_ws_ticker(payload, msg)
        if st == StreamType.DEPTH:
            return self._parse_ws_depth(payload, msg)

        logger.warning("No WS parser for stream type: %s", st)
        return None

    # ── WS: Kline ────────────────────────────────────────────

    def _parse_ws_kline(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance WS kline event.

        Binance format::
            {"e": "kline", "E": 1672531200123, "s": "BTCUSDT",
             "k": {"t": ..., "T": ..., "o": ..., ...}}
        """
        if payload.get("e") != "kline":
            return None

        k = payload.get("k")
        if not isinstance(k, dict):
            return None

        data = {
            "interval": str(k.get("i", self._descriptor.interval)),
            "open_time": int(k["t"]),
            "close_time": int(k["T"]),
            "open": float(k["o"]),
            "high": float(k["h"]),
            "low": float(k["l"]),
            "close": float(k["c"]),
            "volume": float(k["v"]),
            "quote_volume": float(k.get("q", 0)),
            "trades": int(k.get("n", 0)),
            "taker_buy_base": float(k.get("V", 0)),
            "taker_buy_quote": float(k.get("Q", 0)),
            "is_closed": bool(k.get("x", False)),
        }

        return MarketEvent(
            event_type=StreamType.KLINE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=data["open_time"],
        )

    # ── WS: AggTrade ─────────────────────────────────────────

    def _parse_ws_agg_trade(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance WS aggTrade event.

        Binance format::
            {"e": "aggTrade", "E": ..., "s": "BTCUSDT",
             "a": 123, "p": "16500.00", "q": "0.5", ...}
        """
        if payload.get("e") != "aggTrade":
            return None

        data = {
            "agg_trade_id": int(payload["a"]),
            "price": float(payload["p"]),
            "quantity": float(payload["q"]),
            "first_trade_id": int(payload["f"]),
            "last_trade_id": int(payload["l"]),
            "trade_time_ms": int(payload["T"]),
            "is_buyer_maker": bool(payload.get("m", False)),
        }

        return MarketEvent(
            event_type=StreamType.AGG_TRADE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=data["agg_trade_id"],
        )

    # ── WS: Trade ────────────────────────────────────────────

    def _parse_ws_trade(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance WS trade event.

        Binance format::
            {"e": "trade", "E": ..., "s": "BTCUSDT",
             "t": 12345, "p": "16500.00", "q": "0.5", ...}
        """
        if payload.get("e") != "trade":
            return None

        data = {
            "trade_id": int(payload["t"]),
            "price": float(payload["p"]),
            "quantity": float(payload["q"]),
            "trade_time_ms": int(payload["T"]),
            "is_buyer_maker": bool(payload.get("m", False)),
            "buyer_order_id": int(payload.get("b", 0)),
            "seller_order_id": int(payload.get("a", 0)),
        }

        return MarketEvent(
            event_type=StreamType.TRADE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=data["trade_id"],
        )

    # ── WS: Ticker / MiniTicker ──────────────────────────────

    def _parse_ws_ticker(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance WS 24hr ticker or miniTicker event.

        24hr ticker: {"e": "24hrTicker", ...}
        miniTicker:  {"e": "24hrMiniTicker", ...}
        """
        event_name = payload.get("e", "")
        if "Ticker" not in event_name and "ticker" not in event_name:
            return None

        is_mini = "mini" in event_name.lower() or "Mini" in event_name

        if is_mini:
            data = {
                "close_price": float(payload.get("c", 0)),
                "open_price": float(payload.get("o", 0)),
                "high_price": float(payload.get("h", 0)),
                "low_price": float(payload.get("l", 0)),
                "volume": float(payload.get("v", 0)),
                "quote_volume": float(payload.get("q", 0)),
            }
            st = StreamType.MINI_TICKER
        else:
            data = {
                "price_change": float(payload.get("p", 0)),
                "price_change_pct": float(payload.get("P", 0)),
                "weighted_avg_price": float(payload.get("w", 0)),
                "prev_close_price": float(payload.get("x", 0)),
                "last_price": float(payload.get("c", 0)),
                "last_qty": float(payload.get("Q", 0)),
                "bid_price": float(payload.get("b", 0)),
                "bid_qty": float(payload.get("B", 0)),
                "ask_price": float(payload.get("a", 0)),
                "ask_qty": float(payload.get("A", 0)),
                "open_price": float(payload.get("o", 0)),
                "high_price": float(payload.get("h", 0)),
                "low_price": float(payload.get("l", 0)),
                "volume": float(payload.get("v", 0)),
                "quote_volume": float(payload.get("q", 0)),
                "open_time": int(payload.get("O", 0)),
                "close_time": int(payload.get("C", 0)),
                "trades": int(payload.get("n", 0)),
            }
            st = StreamType.TICKER

        return MarketEvent(
            event_type=st,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
        )

    # ── WS: Depth ────────────────────────────────────────────

    def _parse_ws_depth(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance WS partial book depth event.

        Binance format::
            {"lastUpdateId": 123, "bids": [["16499.0", "5.0"], ...],
             "asks": [["16501.0", "2.0"], ...]}
        """
        # Depth updates may have "e": "depthUpdate" or no "e" field
        bids = payload.get("bids") or payload.get("b")
        asks = payload.get("asks") or payload.get("a")
        if bids is None and asks is None:
            return None

        data = {
            "last_update_id": int(payload.get("lastUpdateId", payload.get("u", 0))),
            "bids": [[float(p), float(q)] for p, q in (bids or [])],
            "asks": [[float(p), float(q)] for p, q in (asks or [])],
        }

        return MarketEvent(
            event_type=StreamType.DEPTH,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=data["last_update_id"],
        )

    # ═══════════════════════════════════════════════════════════
    #  HTTP REST parsers
    # ═══════════════════════════════════════════════════════════

    def _parse_http(self, msg: RawMessage) -> MarketEvent | None:
        st = msg.stream_type

        if self._descriptor.exchange == "okx":
            return self._parse_okx_http(msg)

        if st == StreamType.KLINE:
            return self._parse_http_kline(msg)
        if st == StreamType.AGG_TRADE:
            return self._parse_http_agg_trade(msg)
        if st == StreamType.TRADE:
            return self._parse_http_trade(msg)
        if st in (StreamType.TICKER, StreamType.MINI_TICKER):
            return self._parse_http_ticker(msg)
        if st == StreamType.DEPTH:
            return self._parse_http_depth(msg)

        logger.warning("No HTTP parser for stream type: %s", st)
        return None

    # ── HTTP: Kline ──────────────────────────────────────────

    def _parse_http_kline(self, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance REST kline row (array of 12 elements)."""
        row = msg.payload
        if not isinstance(row, (list, tuple)) or len(row) < 11:
            logger.warning("REST kline row too short (%s)", type(row).__name__)
            return None

        close_time_ms = int(row[6])
        # Determine if this bar is truly closed: compare close_time against
        # current time.  The last bar returned by REST is often still forming
        # (active), so we must NOT mark it as closed — otherwise downstream
        # dedup (L5) will cache its open_time and silently drop subsequent
        # updates for the same bar, killing real-time price ticks during
        # HTTP-fallback mode.
        now_ms = int(time.time() * 1000)
        is_closed = close_time_ms < now_ms

        data = {
            "interval": self._descriptor.interval or "",
            "open_time": int(row[0]),
            "close_time": close_time_ms,
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
            "quote_volume": float(row[7]),
            "trades": int(row[8]),
            "taker_buy_base": float(row[9]),
            "taker_buy_quote": float(row[10]),
            "is_closed": is_closed,
        }

        return MarketEvent(
            event_type=StreamType.KLINE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=data["open_time"],
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=data["open_time"],
        )

    # ── HTTP: AggTrade ───────────────────────────────────────

    def _parse_http_agg_trade(self, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance REST aggTrade object.

        Format::
            {"a": 123, "p": "16500.00", "q": "0.5", "f": 100, "l": 105,
             "T": 1672531200123, "m": false, "M": true}
        """
        p = msg.payload
        if not isinstance(p, dict):
            return None

        data = {
            "agg_trade_id": int(p["a"]),
            "price": float(p["p"]),
            "quantity": float(p["q"]),
            "first_trade_id": int(p["f"]),
            "last_trade_id": int(p["l"]),
            "trade_time_ms": int(p["T"]),
            "is_buyer_maker": bool(p.get("m", False)),
        }

        return MarketEvent(
            event_type=StreamType.AGG_TRADE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=data["trade_time_ms"],
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=data["agg_trade_id"],
        )

    # ── HTTP: Trade ──────────────────────────────────────────

    def _parse_http_trade(self, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance REST trade object.

        Format::
            {"id": 12345, "price": "16500.00", "qty": "0.5",
             "time": 1672531200123, "isBuyerMaker": false, ...}
        """
        p = msg.payload
        if not isinstance(p, dict):
            return None

        data = {
            "trade_id": int(p["id"]),
            "price": float(p["price"]),
            "quantity": float(p["qty"]),
            "trade_time_ms": int(p["time"]),
            "is_buyer_maker": bool(p.get("isBuyerMaker", False)),
            "buyer_order_id": int(p.get("buyerOrderId", 0)),
            "seller_order_id": int(p.get("sellerOrderId", 0)),
        }

        return MarketEvent(
            event_type=StreamType.TRADE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=data["trade_time_ms"],
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=data["trade_id"],
        )

    # ── HTTP: Ticker ─────────────────────────────────────────

    def _parse_http_ticker(self, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance REST 24hr ticker object.

        Handles both TICKER and MINI_TICKER based on descriptor stream_type.
        The REST endpoint is the same (/api/v3/ticker/24hr), but we return
        the correct event_type and data schema based on the descriptor.
        """
        p = msg.payload
        if not isinstance(p, dict):
            return None

        is_mini = self._descriptor.stream_type == StreamType.MINI_TICKER

        if is_mini:
            data = {
                "close_price": float(p.get("lastPrice", 0)),
                "open_price": float(p.get("openPrice", 0)),
                "high_price": float(p.get("highPrice", 0)),
                "low_price": float(p.get("lowPrice", 0)),
                "volume": float(p.get("volume", 0)),
                "quote_volume": float(p.get("quoteVolume", 0)),
            }
            st = StreamType.MINI_TICKER
        else:
            data = {
                "price_change": float(p.get("priceChange", 0)),
                "price_change_pct": float(p.get("priceChangePercent", 0)),
                "weighted_avg_price": float(p.get("weightedAvgPrice", 0)),
                "prev_close_price": float(p.get("prevClosePrice", 0)),
                "last_price": float(p.get("lastPrice", 0)),
                "last_qty": float(p.get("lastQty", 0)),
                "bid_price": float(p.get("bidPrice", 0)),
                "bid_qty": float(p.get("bidQty", 0)),
                "ask_price": float(p.get("askPrice", 0)),
                "ask_qty": float(p.get("askQty", 0)),
                "open_price": float(p.get("openPrice", 0)),
                "high_price": float(p.get("highPrice", 0)),
                "low_price": float(p.get("lowPrice", 0)),
                "volume": float(p.get("volume", 0)),
                "quote_volume": float(p.get("quoteVolume", 0)),
                "open_time": int(p.get("openTime", 0)),
                "close_time": int(p.get("closeTime", 0)),
                "trades": int(p.get("count", 0)),
            }
            st = StreamType.TICKER

        return MarketEvent(
            event_type=st,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(p.get("closeTime", msg.received_at_ms)),
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
        )

    # ── HTTP: Depth ──────────────────────────────────────────

    def _parse_http_depth(self, msg: RawMessage) -> MarketEvent | None:
        """Parse Binance REST depth snapshot.

        Format::
            {"lastUpdateId": 123, "bids": [["16499.0", "5.0"], ...],
             "asks": [["16501.0", "2.0"], ...]}
        """
        p = msg.payload
        if not isinstance(p, dict):
            return None

        data = {
            "last_update_id": int(p.get("lastUpdateId", 0)),
            "bids": [[float(price), float(qty)] for price, qty in p.get("bids", [])],
            "asks": [[float(price), float(qty)] for price, qty in p.get("asks", [])],
        }

        return MarketEvent(
            event_type=StreamType.DEPTH,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=msg.received_at_ms,
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=data["last_update_id"],
        )

    def _parse_okx_ws(self, msg: RawMessage) -> MarketEvent | None:
        if msg.stream_type != StreamType.KLINE:
            return None

        payload = msg.payload
        if not isinstance(payload, dict):
            return None

        rows = payload.get("data")
        if not isinstance(rows, list) or not rows:
            return None

        arg = payload.get("arg") if isinstance(payload.get("arg"), dict) else {}
        channel = str(arg.get("channel", ""))
        return self._parse_okx_kline_row(rows[0], msg, channel=channel)

    def _parse_okx_http(self, msg: RawMessage) -> MarketEvent | None:
        if msg.stream_type != StreamType.KLINE:
            return None
        return self._parse_okx_kline_row(msg.payload, msg)

    def _parse_okx_kline_row(
        self,
        row: object,
        msg: RawMessage,
        channel: str = "",
    ) -> MarketEvent | None:
        if not isinstance(row, (list, tuple)) or len(row) < 9:
            logger.warning("OKX kline row too short (%s)", type(row).__name__)
            return None

        if channel.startswith("candle"):
            raw_interval = channel[len("candle"):]
            interval = _OKX_INTERVALS_TO_INTERNAL.get(raw_interval, self._descriptor.interval or "")
        else:
            interval = self._descriptor.interval or ""

        open_time_ms = int(row[0])
        data = {
            "interval": interval,
            "open_time": open_time_ms,
            "close_time": _interval_close_time_ms(open_time_ms, interval),
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
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
        )


# ─── Helpers ─────────────────────────────────────────────────

def _truncate(obj, max_len: int = 200) -> str:
    s = str(obj)
    return s if len(s) <= max_len else s[:max_len] + "…"


def _interval_close_time_ms(open_time_ms: int, interval: str) -> int:
    interval_ms = _interval_to_ms(interval)
    if interval_ms <= 0:
        return open_time_ms
    return open_time_ms + interval_ms - 1


def _interval_to_ms(interval: str) -> int:
    normalized = str(interval or "").strip()
    if len(normalized) < 2:
        return 0
    unit = normalized[-1]
    try:
        amount = int(normalized[:-1])
    except ValueError:
        return 0
    return amount * {
        "s": 1000,
        "m": 60_000,
        "h": 3_600_000,
        "d": 86_400_000,
        "w": 604_800_000,
        "M": 2_592_000_000,
    }.get(unit, 0)
