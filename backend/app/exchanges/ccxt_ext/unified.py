"""Projection and normalization for CCXT's unified public market data."""

from __future__ import annotations

import json
import math
import time
from collections import OrderedDict
from typing import Any

import ccxt

from app.data_engine.ingestion.models import (
    DataSource,
    MarketEvent,
    RawMessage,
    StreamDescriptor,
    StreamType,
)

from .models import CcxtRawMarketEvent


CCXT_UNIFIED_MARKER = "candlescope.ccxt.unified/1"
_MAX_SEEN_TRADES = 4096
_MAX_KLINE_REVISIONS = 8


class CcxtUnifiedOrderBookOutOfSync(RuntimeError):
    """Raised before publication when CCXT exposes an incoherent book cache."""


class CcxtUnifiedProjector:
    """Turn one CCXT ``watch_*`` result into bounded normalized envelopes.

    CCXT's array-returning methods expose a cache.  CandleScope sets
    ``newUpdates=True`` but still deduplicates here so an adapter that returns
    the complete cache cannot replay it indefinitely after a reconnect.
    """

    def __init__(
        self,
        *,
        exchange_id: str,
        market_type: str,
        descriptor: StreamDescriptor,
    ) -> None:
        self.exchange_id = exchange_id
        self.market_type = market_type
        self.descriptor = descriptor
        self._seen_trades: OrderedDict[tuple[Any, ...], None] = OrderedDict()
        self._kline_rows: OrderedDict[int, list[Any]] = OrderedDict()
        self._kline_fingerprints: dict[int, tuple[Any, ...]] = {}
        self._latest_kline_open: int | None = None
        self._book_revision = 0

    def project(
        self,
        result: Any,
        *,
        received_at_ms: int | None = None,
    ) -> tuple[CcxtRawMarketEvent, ...]:
        received = int(received_at_ms or time.time() * 1000)
        stream_type = self.descriptor.stream_type
        if stream_type == StreamType.KLINE:
            payloads = self._project_klines(result)
        elif stream_type == StreamType.TRADE:
            payloads = self._project_trades(result)
        elif stream_type == StreamType.DEPTH:
            payloads = self._project_order_book(result)
        elif stream_type == StreamType.TICKER:
            payloads = self._project_ticker(result)
        elif stream_type == StreamType.MINI_TICKER:
            payloads = self._project_ticker(result)
        elif stream_type in {StreamType.MARK_PRICE, StreamType.INDEX_PRICE}:
            payloads = self._project_derivatives_summary(result)
        elif stream_type == StreamType.FUNDING_RATE:
            payloads = self._project_single("funding_rate", result)
        elif stream_type == StreamType.OPEN_INTEREST:
            payloads = self._project_single("open_interest", result)
        elif stream_type == StreamType.LIQUIDATION:
            payloads = self._project_many("liquidation", result)
        else:
            raise ValueError(
                f"Unsupported CCXT unified stream: {stream_type.value}",
            )
        return tuple(
            CcxtRawMarketEvent(
                channel=stream_type.value,
                symbol=self.descriptor.symbol,
                payload=payload,
                received_at_ms=received,
                exchange=self.exchange_id,
                market_type=self.market_type,
            )
            for payload in payloads
        )

    def _project_klines(self, result: Any) -> list[dict[str, Any]]:
        if not isinstance(result, (list, tuple)):
            return []
        rows = [
            list(row[:6])
            for row in result
            if isinstance(row, (list, tuple))
            and len(row) >= 6
            and _positive_int(row[0]) is not None
        ]
        if not rows:
            return []
        rows.sort(key=lambda row: int(row[0]))
        # Initial CCXT caches are context, not a live backlog.  The newest two
        # rows are sufficient to publish the latest forming bar and the one
        # closure transition immediately before it.
        rows = rows[-2:]
        newest_open = int(rows[-1][0])
        payloads: list[dict[str, Any]] = []

        if (
            self._latest_kline_open is not None
            and newest_open > self._latest_kline_open
            and self._latest_kline_open in self._kline_rows
        ):
            previous = self._kline_rows[self._latest_kline_open]
            closed = self._kline_payload(previous, is_closed=True)
            if self._remember_kline(closed):
                payloads.append(closed)

        for row in rows:
            open_time = int(row[0])
            payload = self._kline_payload(
                row,
                is_closed=open_time < newest_open,
            )
            self._kline_rows[open_time] = row
            self._kline_rows.move_to_end(open_time)
            if self._remember_kline(payload):
                payloads.append(payload)

        self._latest_kline_open = max(
            newest_open,
            self._latest_kline_open or newest_open,
        )
        while len(self._kline_rows) > _MAX_KLINE_REVISIONS:
            open_time, _row = self._kline_rows.popitem(last=False)
            self._kline_fingerprints.pop(open_time, None)
        return payloads

    def _remember_kline(self, payload: dict[str, Any]) -> bool:
        row = payload["value"]
        open_time = int(row[0])
        fingerprint = (*row[:6], bool(payload["is_closed"]))
        if self._kline_fingerprints.get(open_time) == fingerprint:
            return False
        self._kline_fingerprints[open_time] = fingerprint
        return True

    @staticmethod
    def _kline_payload(row: list[Any], *, is_closed: bool) -> dict[str, Any]:
        return {
            "schema": CCXT_UNIFIED_MARKER,
            "kind": "kline",
            "value": list(row[:6]),
            "is_closed": is_closed,
        }

    def _project_trades(self, result: Any) -> list[dict[str, Any]]:
        if isinstance(result, dict):
            trades = [result]
        elif isinstance(result, (list, tuple)):
            trades = [item for item in result if isinstance(item, dict)]
        else:
            return []
        trades.sort(
            key=lambda item: (
                _non_negative_int(item.get("timestamp")) or 0,
                str(item.get("id") or ""),
            )
        )
        payloads: list[dict[str, Any]] = []
        for index, trade in enumerate(trades):
            key = _trade_key(trade, index=index)
            if key in self._seen_trades:
                continue
            self._seen_trades[key] = None
            payloads.append(
                {
                    "schema": CCXT_UNIFIED_MARKER,
                    "kind": "trade",
                    "value": dict(trade),
                }
            )
        while len(self._seen_trades) > _MAX_SEEN_TRADES:
            self._seen_trades.popitem(last=False)
        return payloads

    def _project_order_book(self, result: Any) -> list[dict[str, Any]]:
        if not isinstance(result, dict):
            return []
        limit = self.descriptor.depth_levels or 0
        bids = _book_levels(result.get("bids"), limit=limit, reverse=True)
        asks = _book_levels(result.get("asks"), limit=limit, reverse=False)
        if not bids or not asks or bids[0][0] >= asks[0][0]:
            raise CcxtUnifiedOrderBookOutOfSync(
                f"CCXT order book is empty or crossed for {self.descriptor.key}",
            )
        # CCXT Pro maintains an order-book cache in place and may return the
        # same mutable bid/ask lists from consecutive watch calls.  A shallow
        # ``dict(result)`` would therefore let a later delta rewrite a message
        # that is already queued for normalization.  Freeze the two sides at
        # the projector boundary so each local revision describes one coherent
        # snapshot.
        book = dict(result)
        book["bids"] = [_copy_book_level(level) for level in bids]
        book["asks"] = [_copy_book_level(level) for level in asks]
        self._book_revision += 1
        return [
            {
                "schema": CCXT_UNIFIED_MARKER,
                "kind": "order_book",
                "value": book,
                "local_revision": self._book_revision,
            }
        ]

    @staticmethod
    def _project_ticker(result: Any) -> list[dict[str, Any]]:
        if not isinstance(result, dict):
            return []
        return [
            {
                "schema": CCXT_UNIFIED_MARKER,
                "kind": "ticker",
                "value": dict(result),
            }
        ]

    @staticmethod
    def _project_derivatives_summary(result: Any) -> list[dict[str, Any]]:
        return CcxtUnifiedProjector._project_single(
            "derivatives_summary",
            result,
        )

    @staticmethod
    def _project_single(kind: str, result: Any) -> list[dict[str, Any]]:
        if not isinstance(result, dict):
            return []
        return [
            {
                "schema": CCXT_UNIFIED_MARKER,
                "kind": kind,
                "value": dict(result),
            }
        ]

    @staticmethod
    def _project_many(kind: str, result: Any) -> list[dict[str, Any]]:
        if isinstance(result, dict):
            values = [result]
        elif isinstance(result, (list, tuple)):
            values = [value for value in result if isinstance(value, dict)]
        else:
            return []
        return [
            {
                "schema": CCXT_UNIFIED_MARKER,
                "kind": kind,
                "value": dict(value),
            }
            for value in values
        ]


class CcxtUnifiedNormalizer:
    """Convert CCXT unified envelopes into CandleScope ``MarketEvent`` values."""

    def __init__(self, descriptor: StreamDescriptor) -> None:
        self._descriptor = descriptor

    def parse(self, msg: RawMessage) -> MarketEvent | None:
        payload = msg.payload
        if not isinstance(payload, dict) or payload.get("schema") != CCXT_UNIFIED_MARKER:
            return None
        kind = str(payload.get("kind") or "")
        if kind == "kline" and self._descriptor.stream_type == StreamType.KLINE:
            return self._parse_kline(payload, msg)
        if kind == "trade" and self._descriptor.stream_type == StreamType.TRADE:
            return self._parse_trade(payload, msg)
        if kind == "order_book" and self._descriptor.stream_type == StreamType.DEPTH:
            return self._parse_order_book(payload, msg)
        if kind == "ticker" and self._descriptor.stream_type in {
            StreamType.TICKER,
            StreamType.MINI_TICKER,
        }:
            return self._parse_ticker(payload, msg)
        if kind == "derivatives_summary" and self._descriptor.stream_type in {
            StreamType.MARK_PRICE,
            StreamType.INDEX_PRICE,
        }:
            return self._parse_derivatives_summary(payload, msg)
        if kind == "funding_rate" and self._descriptor.stream_type == StreamType.FUNDING_RATE:
            return self._parse_funding_rate(payload, msg)
        if kind == "open_interest" and self._descriptor.stream_type == StreamType.OPEN_INTEREST:
            return self._parse_open_interest(payload, msg)
        if kind == "liquidation" and self._descriptor.stream_type == StreamType.LIQUIDATION:
            return self._parse_liquidation(payload, msg)
        if kind == "premium_index" and self._descriptor.stream_type == StreamType.PREMIUM_INDEX:
            return self._parse_index_kline(payload, msg)
        return None

    def _event(
        self,
        *,
        event_type: StreamType,
        event_time_ms: int,
        msg: RawMessage,
        data: dict[str, Any],
        sequence: int | None = None,
    ) -> MarketEvent:
        source = (
            DataSource.PLUGIN
            if msg.source == DataSource.WEBSOCKET
            else msg.source
        )
        return MarketEvent(
            event_type=event_type,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=event_time_ms,
            received_at_ms=msg.received_at_ms,
            source=source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=sequence,
            market_type=self._descriptor.market_type,
        )

    def _parse_kline(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        row = payload.get("value")
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            return None
        try:
            open_time = int(row[0])
            interval_ms = _timeframe_ms(self._descriptor.interval)
            data = {
                "interval": self._descriptor.interval or "",
                "open_time": open_time,
                "close_time": open_time + interval_ms - 1,
                "open": _finite_float(row[1]),
                "high": _finite_float(row[2]),
                "low": _finite_float(row[3]),
                "close": _finite_float(row[4]),
                "volume": _finite_float(row[5]),
                # CCXT's unified OHLCV base schema does not promise enhanced
                # exchange fields.  Keep their numeric storage defaults while
                # the capability document marks them unavailable.
                "quote_volume": 0.0,
                "trades": 0,
                "taker_buy_base": 0.0,
                "taker_buy_quote": 0.0,
                "is_closed": bool(
                    payload.get(
                        "is_closed",
                        open_time + interval_ms <= msg.received_at_ms,
                    )
                ),
            }
        except (TypeError, ValueError):
            return None
        return self._event(
            event_type=StreamType.KLINE,
            event_time_ms=open_time,
            msg=msg,
            data=data,
            sequence=open_time,
        )

    def _parse_trade(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        trade = payload.get("value")
        if not isinstance(trade, dict):
            return None
        timestamp = _non_negative_int(trade.get("timestamp")) or msg.received_at_ms
        raw_id = trade.get("id")
        trade_id: int | str
        numeric_id = _non_negative_int(raw_id)
        if numeric_id is not None:
            trade_id = numeric_id
        elif raw_id not in (None, ""):
            trade_id = str(raw_id)
        else:
            trade_id = _synthetic_trade_id(trade)
        side = str(trade.get("side") or "").strip().lower()
        try:
            data = {
                "trade_id": trade_id,
                "exchange_trade_id": None if raw_id is None else str(raw_id),
                "price": _finite_float(trade.get("price")),
                "quantity": _finite_float(trade.get("amount")),
                "trade_time_ms": timestamp,
                "side": side,
                "is_buyer_maker": side == "sell",
            }
        except (TypeError, ValueError):
            return None
        # Exchange trade identifiers are not assumed to be contiguous even
        # when they happen to be numeric.  Projector-level dedup remains safe;
        # CandleScope's +1 gap detector is deliberately disabled.
        return self._event(
            event_type=StreamType.TRADE,
            event_time_ms=timestamp,
            msg=msg,
            data=data,
            sequence=None,
        )

    def _parse_order_book(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        book = payload.get("value")
        revision = _positive_int(payload.get("local_revision"))
        depth_levels = self._descriptor.depth_levels
        if (
            not isinstance(book, dict)
            or revision is None
            or type(depth_levels) is not int
            or depth_levels not in {5, 10, 20}
        ):
            return None
        bids = _book_levels(book.get("bids"), limit=depth_levels, reverse=True)
        asks = _book_levels(book.get("asks"), limit=depth_levels, reverse=False)
        if not bids or not asks or bids[0][0] >= asks[0][0]:
            return None
        timestamp = _non_negative_int(book.get("timestamp")) or msg.received_at_ms
        data = {
            "last_update_id": revision,
            "exchange_nonce": book.get("nonce"),
            "depth_levels": depth_levels,
            "update_interval_ms": self._descriptor.update_interval_ms or 1000,
            "bids": bids,
            "asks": asks,
            "source_quality": "ccxt_managed_snapshot",
        }
        return self._event(
            event_type=StreamType.DEPTH,
            event_time_ms=timestamp,
            msg=msg,
            data=data,
            sequence=revision,
        )

    def _parse_ticker(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        ticker = payload.get("value")
        if not isinstance(ticker, dict):
            return None
        timestamp = _non_negative_int(ticker.get("timestamp")) or msg.received_at_ms
        last = _optional_float(ticker.get("last"))
        close = _optional_float(ticker.get("close"))
        if last is None and close is None:
            return None
        data = {
            "last_price": last if last is not None else close,
            "close_price": close if close is not None else last,
            "open_price": _optional_float(ticker.get("open")) or 0.0,
            "high_price": _optional_float(ticker.get("high")) or 0.0,
            "low_price": _optional_float(ticker.get("low")) or 0.0,
            "volume": _optional_float(ticker.get("baseVolume")) or 0.0,
            "quote_volume": _optional_float(ticker.get("quoteVolume")) or 0.0,
            "bid_price": _optional_float(ticker.get("bid")) or 0.0,
            "ask_price": _optional_float(ticker.get("ask")) or 0.0,
            "price_change": _optional_float(ticker.get("change")) or 0.0,
            "price_change_pct": _optional_float(ticker.get("percentage")) or 0.0,
            "weighted_avg_price": _optional_float(ticker.get("vwap")) or 0.0,
        }
        return self._event(
            event_type=self._descriptor.stream_type,
            event_time_ms=timestamp,
            msg=msg,
            data=data,
        )

    def _parse_derivatives_summary(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        value = payload.get("value")
        if not isinstance(value, dict):
            return None
        info = value.get("info") if isinstance(value.get("info"), dict) else {}
        mark_price = _first_float(value, info, "markPrice", "mark_price", "markPx", "p")
        index_price = _first_float(value, info, "indexPrice", "index_price", "idxPx", "i")
        funding_rate = _first_float(value, info, "fundingRate", "funding_rate", "r")
        if mark_price is None and index_price is None and funding_rate is None:
            return None
        timestamp = (
            _first_int(value, info, "timestamp", "E", "ts")
            or msg.received_at_ms
        )
        data: dict[str, Any] = {}
        if mark_price is not None:
            data["mark_price"] = mark_price
        if index_price is not None:
            data["index_price"] = index_price
        if funding_rate is not None:
            data["funding_rate"] = funding_rate
        next_funding = _first_int(
            value,
            info,
            "nextFundingTimestamp",
            "nextFundingTime",
            "nextFundingTimeMs",
            "T",
        )
        if next_funding is not None:
            data["next_funding_time_ms"] = next_funding
        return self._event(
            event_type=self._descriptor.stream_type,
            event_time_ms=timestamp,
            msg=msg,
            data=data,
        )

    def _parse_funding_rate(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        value = payload.get("value")
        if not isinstance(value, dict):
            return None
        info = value.get("info") if isinstance(value.get("info"), dict) else {}
        funding_rate = _first_float(value, info, "fundingRate", "funding_rate")
        if funding_rate is None:
            return None
        timestamp = (
            _first_int(
                value,
                info,
                "fundingTimestamp",
                "fundingTime",
                "timestamp",
                "ts",
            )
            or msg.received_at_ms
        )
        data: dict[str, Any] = {"funding_rate": funding_rate}
        next_funding = _first_int(
            value,
            info,
            "nextFundingTimestamp",
            "nextFundingTime",
        )
        if next_funding is not None:
            data["next_funding_time_ms"] = next_funding
        mark_price = _first_float(value, info, "markPrice", "markPx")
        if mark_price is not None:
            data["mark_price"] = mark_price
        return self._event(
            event_type=StreamType.FUNDING_RATE,
            event_time_ms=timestamp,
            msg=msg,
            data=data,
            sequence=timestamp,
        )

    def _parse_open_interest(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        value = payload.get("value")
        if not isinstance(value, dict):
            return None
        info = value.get("info") if isinstance(value.get("info"), dict) else {}
        amount = _first_float(
            value,
            info,
            "openInterestAmount",
            "openInterest",
            "open_interest",
            "oi",
        )
        if amount is None:
            return None
        timestamp = _first_int(value, info, "timestamp", "ts") or msg.received_at_ms
        data: dict[str, Any] = {"open_interest": amount}
        notional = _first_float(
            value,
            info,
            "openInterestValue",
            "open_interest_value",
            "oiCcy",
        )
        if notional is not None:
            data["open_interest_value"] = notional
        return self._event(
            event_type=StreamType.OPEN_INTEREST,
            event_time_ms=timestamp,
            msg=msg,
            data=data,
            sequence=timestamp,
        )

    def _parse_liquidation(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        value = payload.get("value")
        if not isinstance(value, dict):
            return None
        info = value.get("info") if isinstance(value.get("info"), dict) else {}
        timestamp = _first_int(value, info, "timestamp", "ts", "T") or msg.received_at_ms
        price = _first_float(value, info, "price", "average", "bkPx", "ap", "p")
        quantity = _first_float(
            value,
            info,
            "contracts",
            "amount",
            "baseValue",
            "sz",
            "q",
        )
        if price is None or quantity is None:
            return None
        side = str(value.get("side") or info.get("side") or info.get("S") or "").lower()
        data = {
            "side": side,
            "price": price,
            "quantity": quantity,
            "trade_time_ms": timestamp,
            "source_quality": "ccxt_unified_public_liquidation",
        }
        return self._event(
            event_type=StreamType.LIQUIDATION,
            event_time_ms=timestamp,
            msg=msg,
            data=data,
        )

    def _parse_index_kline(
        self,
        payload: dict[str, Any],
        msg: RawMessage,
    ) -> MarketEvent | None:
        row = payload.get("value")
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            return None
        try:
            open_time = int(row[0])
            interval_ms = _timeframe_ms(self._descriptor.interval)
            data = {
                "interval": self._descriptor.interval or "",
                "open_time_ms": open_time,
                "close_time_ms": open_time + interval_ms - 1,
                "premium_index_open": _finite_float(row[1]),
                "premium_index_high": _finite_float(row[2]),
                "premium_index_low": _finite_float(row[3]),
                "premium_index_close": _finite_float(row[4]),
            }
        except (TypeError, ValueError):
            return None
        return self._event(
            event_type=StreamType.PREMIUM_INDEX,
            event_time_ms=open_time,
            msg=msg,
            data=data,
            sequence=open_time,
        )


def make_unified_payload(
    kind: str,
    value: Any,
    **metadata: Any,
) -> dict[str, Any]:
    """Build a testable REST/provider envelope with the public schema marker."""

    return {
        "schema": CCXT_UNIFIED_MARKER,
        "kind": str(kind),
        "value": value,
        **metadata,
    }


def _trade_key(trade: dict[str, Any], *, index: int) -> tuple[Any, ...]:
    raw_id = trade.get("id")
    if raw_id not in (None, ""):
        return ("id", str(raw_id))
    return (
        "row",
        trade.get("timestamp"),
        trade.get("price"),
        trade.get("amount"),
        trade.get("side"),
        index,
    )


def _synthetic_trade_id(trade: dict[str, Any]) -> str:
    canonical = json.dumps(
        {
            "timestamp": trade.get("timestamp"),
            "price": trade.get("price"),
            "amount": trade.get("amount"),
            "side": trade.get("side"),
        },
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )
    return f"ccxt:{canonical}"


def _timeframe_ms(interval: str | None) -> int:
    if not interval:
        raise ValueError("CCXT K-line interval is required")
    seconds = ccxt.Exchange.parse_timeframe(interval)
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        raise ValueError(f"Unsupported CCXT timeframe: {interval}")
    return int(seconds * 1000)


def _book_levels(
    value: Any,
    *,
    limit: int,
    reverse: bool,
) -> list[list[float]]:
    if not isinstance(value, (list, tuple)):
        return []
    by_price: dict[float, float] = {}
    for raw in value:
        if not isinstance(raw, (list, tuple)) or len(raw) < 2:
            continue
        try:
            price = _finite_float(raw[0])
            quantity = _finite_float(raw[1])
        except (TypeError, ValueError):
            continue
        if price <= 0 or quantity <= 0:
            continue
        by_price[price] = quantity
    prices = sorted(by_price, reverse=reverse)[:limit]
    return [[price, by_price[price]] for price in prices]


def _copy_book_level(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return list(value)
    return value


def _finite_float(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("value must be finite")
    return number


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return _finite_float(value)
    except (TypeError, ValueError):
        return None


def _non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _positive_int(value: Any) -> int | None:
    number = _non_negative_int(value)
    return number if number is not None and number > 0 else None


def _first_float(*mappings_and_keys: Any) -> float | None:
    mappings = [item for item in mappings_and_keys if isinstance(item, dict)]
    keys = [item for item in mappings_and_keys if isinstance(item, str)]
    for mapping in mappings:
        for key in keys:
            value = _optional_float(mapping.get(key))
            if value is not None:
                return value
    return None


def _first_int(*mappings_and_keys: Any) -> int | None:
    mappings = [item for item in mappings_and_keys if isinstance(item, dict)]
    keys = [item for item in mappings_and_keys if isinstance(item, str)]
    for mapping in mappings:
        for key in keys:
            value = _non_negative_int(mapping.get(key))
            if value is not None:
                return value
    return None
