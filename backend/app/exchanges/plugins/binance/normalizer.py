"""Binance raw payload normalizer."""
from __future__ import annotations

import logging
import time

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    MarketEvent,
    RawMessage,
    StreamDescriptor,
    StreamType,
)

logger = logging.getLogger("ingestion.normalizers.binance")


class BinanceNormalizer:
    """Convert Binance WS/REST payloads into MarketEvent objects."""

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

        st = msg.stream_type
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

        logger.warning("No Binance WS parser for stream type: %s", st)
        return None

    def _parse_http(self, msg: RawMessage) -> MarketEvent | None:
        st = msg.stream_type
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

        logger.warning("No Binance HTTP parser for stream type: %s", st)
        return None

    def _event(
        self,
        *,
        event_type: StreamType,
        event_time_ms: int,
        msg: RawMessage,
        data: dict,
        sequence: int | None = None,
    ) -> MarketEvent:
        return MarketEvent(
            event_type=event_type,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=event_time_ms,
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=sequence,
        )

    def _parse_ws_kline(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
        if payload.get("e") != "kline":
            return None

        kline = payload.get("k")
        if not isinstance(kline, dict):
            return None

        data = {
            "interval": str(kline.get("i", self._descriptor.interval)),
            "open_time": int(kline["t"]),
            "close_time": int(kline["T"]),
            "open": float(kline["o"]),
            "high": float(kline["h"]),
            "low": float(kline["l"]),
            "close": float(kline["c"]),
            "volume": float(kline["v"]),
            "quote_volume": float(kline.get("q", 0)),
            "trades": int(kline.get("n", 0)),
            "taker_buy_base": float(kline.get("V", 0)),
            "taker_buy_quote": float(kline.get("Q", 0)),
            "is_closed": bool(kline.get("x", False)),
        }
        return self._event(
            event_type=StreamType.KLINE,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            msg=msg,
            data=data,
            sequence=data["open_time"],
        )

    def _parse_ws_agg_trade(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
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
        return self._event(
            event_type=StreamType.AGG_TRADE,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            msg=msg,
            data=data,
            sequence=data["agg_trade_id"],
        )

    def _parse_ws_trade(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
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
        return self._event(
            event_type=StreamType.TRADE,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            msg=msg,
            data=data,
            sequence=data["trade_id"],
        )

    def _parse_ws_ticker(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
        event_name = str(payload.get("e", ""))
        if "Ticker" not in event_name and "ticker" not in event_name:
            return None

        is_mini = "mini" in event_name.lower()
        if is_mini:
            data = {
                "close_price": float(payload.get("c", 0)),
                "open_price": float(payload.get("o", 0)),
                "high_price": float(payload.get("h", 0)),
                "low_price": float(payload.get("l", 0)),
                "volume": float(payload.get("v", 0)),
                "quote_volume": float(payload.get("q", 0)),
            }
            event_type = StreamType.MINI_TICKER
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
            event_type = StreamType.TICKER

        return self._event(
            event_type=event_type,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            msg=msg,
            data=data,
        )

    def _parse_ws_depth(self, payload: dict, msg: RawMessage) -> MarketEvent | None:
        bids = payload.get("bids") or payload.get("b")
        asks = payload.get("asks") or payload.get("a")
        if bids is None and asks is None:
            return None

        data = {
            "last_update_id": int(payload.get("lastUpdateId", payload.get("u", 0))),
            "bids": [[float(price), float(qty)] for price, qty in (bids or [])],
            "asks": [[float(price), float(qty)] for price, qty in (asks or [])],
        }
        return self._event(
            event_type=StreamType.DEPTH,
            event_time_ms=int(payload.get("E", msg.received_at_ms)),
            msg=msg,
            data=data,
            sequence=data["last_update_id"],
        )

    def _parse_http_kline(self, msg: RawMessage) -> MarketEvent | None:
        row = msg.payload
        if not isinstance(row, (list, tuple)) or len(row) < 11:
            logger.warning("REST kline row too short (%s)", type(row).__name__)
            return None

        close_time_ms = int(row[6])
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
            "is_closed": close_time_ms < int(time.time() * 1000),
        }
        return self._event(
            event_type=StreamType.KLINE,
            event_time_ms=data["open_time"],
            msg=msg,
            data=data,
            sequence=data["open_time"],
        )

    def _parse_http_agg_trade(self, msg: RawMessage) -> MarketEvent | None:
        payload = msg.payload
        if not isinstance(payload, dict):
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
        return self._event(
            event_type=StreamType.AGG_TRADE,
            event_time_ms=data["trade_time_ms"],
            msg=msg,
            data=data,
            sequence=data["agg_trade_id"],
        )

    def _parse_http_trade(self, msg: RawMessage) -> MarketEvent | None:
        payload = msg.payload
        if not isinstance(payload, dict):
            return None

        data = {
            "trade_id": int(payload["id"]),
            "price": float(payload["price"]),
            "quantity": float(payload["qty"]),
            "trade_time_ms": int(payload["time"]),
            "is_buyer_maker": bool(payload.get("isBuyerMaker", False)),
            "buyer_order_id": int(payload.get("buyerOrderId", 0)),
            "seller_order_id": int(payload.get("sellerOrderId", 0)),
        }
        return self._event(
            event_type=StreamType.TRADE,
            event_time_ms=data["trade_time_ms"],
            msg=msg,
            data=data,
            sequence=data["trade_id"],
        )

    def _parse_http_ticker(self, msg: RawMessage) -> MarketEvent | None:
        payload = msg.payload
        if not isinstance(payload, dict):
            return None

        is_mini = self._descriptor.stream_type == StreamType.MINI_TICKER
        if is_mini:
            data = {
                "close_price": float(payload.get("lastPrice", 0)),
                "open_price": float(payload.get("openPrice", 0)),
                "high_price": float(payload.get("highPrice", 0)),
                "low_price": float(payload.get("lowPrice", 0)),
                "volume": float(payload.get("volume", 0)),
                "quote_volume": float(payload.get("quoteVolume", 0)),
            }
            event_type = StreamType.MINI_TICKER
        else:
            data = {
                "price_change": float(payload.get("priceChange", 0)),
                "price_change_pct": float(payload.get("priceChangePercent", 0)),
                "weighted_avg_price": float(payload.get("weightedAvgPrice", 0)),
                "prev_close_price": float(payload.get("prevClosePrice", 0)),
                "last_price": float(payload.get("lastPrice", 0)),
                "last_qty": float(payload.get("lastQty", 0)),
                "bid_price": float(payload.get("bidPrice", 0)),
                "bid_qty": float(payload.get("bidQty", 0)),
                "ask_price": float(payload.get("askPrice", 0)),
                "ask_qty": float(payload.get("askQty", 0)),
                "open_price": float(payload.get("openPrice", 0)),
                "high_price": float(payload.get("highPrice", 0)),
                "low_price": float(payload.get("lowPrice", 0)),
                "volume": float(payload.get("volume", 0)),
                "quote_volume": float(payload.get("quoteVolume", 0)),
                "open_time": int(payload.get("openTime", 0)),
                "close_time": int(payload.get("closeTime", 0)),
                "trades": int(payload.get("count", 0)),
            }
            event_type = StreamType.TICKER

        return self._event(
            event_type=event_type,
            event_time_ms=int(payload.get("closeTime", msg.received_at_ms)),
            msg=msg,
            data=data,
        )

    def _parse_http_depth(self, msg: RawMessage) -> MarketEvent | None:
        payload = msg.payload
        if not isinstance(payload, dict):
            return None

        data = {
            "last_update_id": int(payload.get("lastUpdateId", 0)),
            "bids": [[float(price), float(qty)] for price, qty in payload.get("bids", [])],
            "asks": [[float(price), float(qty)] for price, qty in payload.get("asks", [])],
        }
        return self._event(
            event_type=StreamType.DEPTH,
            event_time_ms=msg.received_at_ms,
            msg=msg,
            data=data,
            sequence=data["last_update_id"],
        )
