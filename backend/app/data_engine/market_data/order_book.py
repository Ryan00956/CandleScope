"""Validated partial Top-N order-book snapshots and bounded latest state.

This module deliberately models replaceable snapshots, not an incrementally
reconstructed full book.  Update IDs are only used to reject stale replacement
snapshots within one process; they do not imply gap-free source continuity.
"""

from __future__ import annotations

import math
from collections import OrderedDict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, TypeAlias

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType


SUPPORTED_DEPTH_LEVELS = frozenset({5, 10, 20})

OrderBookIdentity: TypeAlias = tuple[str, str, str, int, int]
OrderBookSide: TypeAlias = Literal["bid", "ask"]
OrderBookIngestReason: TypeAlias = Literal[
    "accepted",
    "duplicate_update_id",
    "stale_update_id",
]


def _required_text(value: object, *, label: str, case: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"order-book {label} must be a string")
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"order-book {label} cannot be blank")
    return normalized.lower() if case == "lower" else normalized.upper()


def _required_int(value: object, *, label: str, minimum: int) -> int:
    if isinstance(value, bool):
        raise TypeError(f"order-book {label} must be an integer")
    try:
        number = int(value)  # type: ignore[arg-type]
        decimal_value = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"order-book {label} must be an integer") from exc
    if not decimal_value.is_finite() or decimal_value != number:
        raise TypeError(f"order-book {label} must be an integer")
    if number < minimum:
        raise ValueError(f"order-book {label} must be >= {minimum}")
    return number


def _positive_float(value: object, *, label: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"order-book {label} must be numeric")
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"order-book {label} must be numeric") from exc
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"order-book {label} must be finite and positive")
    return number


def _depth_levels(value: object) -> int:
    levels = _required_int(value, label="depth levels", minimum=1)
    if levels not in SUPPORTED_DEPTH_LEVELS:
        supported = ", ".join(str(item) for item in sorted(SUPPORTED_DEPTH_LEVELS))
        raise ValueError(f"order-book depth levels must be one of: {supported}")
    return levels


@dataclass(frozen=True, slots=True)
class OrderBookLevel:
    """One live price level in a partial snapshot.

    Zero quantity is intentionally rejected.  It is a deletion instruction in
    delta protocols, while this module accepts only complete replacement
    snapshots containing currently live levels.
    """

    price: float
    quantity: float
    _notional: float = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        price = _positive_float(self.price, label="level price")
        quantity = _positive_float(self.quantity, label="level quantity")
        notional = price * quantity
        if not math.isfinite(notional) or notional <= 0:
            raise ValueError(
                "order-book level notional must serialize finitely and positively",
            )
        object.__setattr__(self, "price", price)
        object.__setattr__(self, "quantity", quantity)
        object.__setattr__(self, "_notional", notional)

    @property
    def notional(self) -> float:
        return self._notional

    def to_dict(self) -> dict[str, float]:
        return {
            "price": self.price,
            "quantity": self.quantity,
            "notional": self.notional,
        }


def _coerce_level(value: object, *, side: OrderBookSide) -> OrderBookLevel:
    if isinstance(value, OrderBookLevel):
        return value
    if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, Sequence):
        raise TypeError(f"order-book {side} level must be a price/quantity pair")
    if len(value) != 2:
        raise ValueError(f"order-book {side} level must contain price and quantity")
    return OrderBookLevel(price=value[0], quantity=value[1])  # type: ignore[arg-type]


def _canonical_levels(
    values: object,
    *,
    side: OrderBookSide,
    maximum: int,
) -> tuple[OrderBookLevel, ...]:
    if isinstance(values, (str, bytes, Mapping)) or not isinstance(values, Iterable):
        raise TypeError(f"order-book {side}s must be an iterable of levels")
    levels = tuple(_coerce_level(value, side=side) for value in values)
    if not levels:
        raise ValueError(f"order-book {side}s cannot be empty")
    if len(levels) > maximum:
        raise ValueError(
            f"order-book {side}s exceed requested depth {maximum}",
        )
    prices = {level.price for level in levels}
    if len(prices) != len(levels):
        raise ValueError(f"order-book {side}s contain duplicate prices")
    return tuple(
        sorted(
            levels,
            key=lambda level: level.price,
            reverse=side == "bid",
        ),
    )


def _resolve_event_parameter(
    data: Mapping[str, Any],
    name: str,
    override: int | None,
    *,
    validator: Any,
) -> int:
    payload_value = data.get(name)
    if payload_value is None and override is None:
        raise ValueError(f"order-book MarketEvent requires {name}")
    payload_normalized = validator(payload_value) if payload_value is not None else None
    override_normalized = validator(override) if override is not None else None
    if (
        payload_normalized is not None
        and override_normalized is not None
        and payload_normalized != override_normalized
    ):
        raise ValueError(f"order-book {name} conflicts with explicit stream metadata")
    return payload_normalized if payload_normalized is not None else override_normalized  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class OrderBookSnapshot:
    """One canonical, immutable partial Top-N order-book snapshot."""

    exchange: str
    market_type: str
    symbol: str
    depth_levels: int
    update_interval_ms: int
    last_update_id: int
    bids: tuple[OrderBookLevel, ...]
    asks: tuple[OrderBookLevel, ...]
    event_time_ms: int
    received_at_ms: int
    source: DataSource | str
    _bid_base_quantity: float = field(init=False, repr=False, compare=False)
    _ask_base_quantity: float = field(init=False, repr=False, compare=False)
    _bid_notional: float = field(init=False, repr=False, compare=False)
    _ask_notional: float = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "exchange",
            _required_text(self.exchange, label="exchange", case="lower"),
        )
        object.__setattr__(
            self,
            "market_type",
            _required_text(self.market_type, label="market type", case="lower"),
        )
        object.__setattr__(
            self,
            "symbol",
            _required_text(self.symbol, label="symbol", case="upper"),
        )
        depth_levels = _depth_levels(self.depth_levels)
        object.__setattr__(self, "depth_levels", depth_levels)
        object.__setattr__(
            self,
            "update_interval_ms",
            _required_int(
                self.update_interval_ms,
                label="update interval",
                minimum=1,
            ),
        )
        object.__setattr__(
            self,
            "last_update_id",
            _required_int(self.last_update_id, label="last update id", minimum=1),
        )
        for name in ("event_time_ms", "received_at_ms"):
            object.__setattr__(
                self,
                name,
                _required_int(getattr(self, name), label=name, minimum=0),
            )

        source = self.source
        if not isinstance(source, DataSource):
            try:
                source = DataSource(
                    _required_text(source, label="source", case="lower"),
                )
            except ValueError as exc:
                raise ValueError("order-book source is unsupported") from exc
        object.__setattr__(self, "source", source)

        bids = _canonical_levels(self.bids, side="bid", maximum=depth_levels)
        asks = _canonical_levels(self.asks, side="ask", maximum=depth_levels)
        if bids[0].price >= asks[0].price:
            raise ValueError("order-book snapshot must not be crossed or locked")
        object.__setattr__(self, "bids", bids)
        object.__setattr__(self, "asks", asks)

        try:
            bid_base = math.fsum(level.quantity for level in bids)
            ask_base = math.fsum(level.quantity for level in asks)
            bid_notional = math.fsum(level.notional for level in bids)
            ask_notional = math.fsum(level.notional for level in asks)
        except OverflowError as exc:
            raise ValueError(
                "order-book aggregate metrics must serialize finitely",
            ) from exc
        if not all(
            math.isfinite(value)
            for value in (bid_base, ask_base, bid_notional, ask_notional)
        ):
            raise ValueError("order-book aggregate metrics must serialize finitely")
        object.__setattr__(self, "_bid_base_quantity", bid_base)
        object.__setattr__(self, "_ask_base_quantity", ask_base)
        object.__setattr__(self, "_bid_notional", bid_notional)
        object.__setattr__(self, "_ask_notional", ask_notional)

    @property
    def stream_identity(self) -> OrderBookIdentity:
        return (
            self.exchange,
            self.market_type,
            self.symbol,
            self.depth_levels,
            self.update_interval_ms,
        )

    @property
    def top_bid(self) -> float:
        return self.bids[0].price

    @property
    def top_ask(self) -> float:
        return self.asks[0].price

    @property
    def mid_price(self) -> float:
        # This equivalent form cannot overflow while both endpoints are finite.
        return self.top_bid + self.spread / 2

    @property
    def spread(self) -> float:
        return self.top_ask - self.top_bid

    @property
    def spread_bps(self) -> float:
        return self.spread / self.mid_price * 10_000

    @property
    def bid_base_quantity(self) -> float:
        return self._bid_base_quantity

    @property
    def ask_base_quantity(self) -> float:
        return self._ask_base_quantity

    @property
    def bid_notional(self) -> float:
        return self._bid_notional

    @property
    def ask_notional(self) -> float:
        return self._ask_notional

    @property
    def notional_imbalance(self) -> float:
        # Scale before summing so two large but individually finite sides do
        # not overflow.  Both sides are strictly positive by construction.
        scale = max(self.bid_notional, self.ask_notional)
        bid = self.bid_notional / scale
        ask = self.ask_notional / scale
        return (bid - ask) / (bid + ask)

    @classmethod
    def from_market_event(
        cls,
        event: MarketEvent,
        *,
        depth_levels: int | None = None,
        update_interval_ms: int | None = None,
    ) -> OrderBookSnapshot:
        event_type = getattr(event.event_type, "value", event.event_type)
        if event_type != StreamType.DEPTH.value:
            raise ValueError("order-book engine only accepts DEPTH MarketEvent values")
        data = event.data
        if not isinstance(data, Mapping):
            raise TypeError("order-book MarketEvent data must be an object")
        resolved_depth = _resolve_event_parameter(
            data,
            "depth_levels",
            depth_levels,
            validator=_depth_levels,
        )
        resolved_interval = _resolve_event_parameter(
            data,
            "update_interval_ms",
            update_interval_ms,
            validator=lambda value: _required_int(
                value,
                label="update interval",
                minimum=1,
            ),
        )
        update_id = data.get("last_update_id", event.sequence)
        if data.get("last_update_id") is not None and event.sequence is not None:
            payload_id = _required_int(
                data["last_update_id"],
                label="last update id",
                minimum=1,
            )
            sequence_id = _required_int(
                event.sequence,
                label="event sequence",
                minimum=1,
            )
            if payload_id != sequence_id:
                raise ValueError(
                    "order-book last_update_id conflicts with MarketEvent sequence",
                )
        return cls(
            exchange=event.exchange,
            market_type=event.market_type,
            symbol=event.symbol,
            depth_levels=resolved_depth,
            update_interval_ms=resolved_interval,
            last_update_id=update_id,  # type: ignore[arg-type]
            bids=data.get("bids"),  # type: ignore[arg-type]
            asks=data.get("asks"),  # type: ignore[arg-type]
            event_time_ms=event.event_time_ms,
            received_at_ms=event.received_at_ms,
            source=event.source,
        )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe payload without claiming full-book continuity."""

        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "depth_levels": self.depth_levels,
            "update_interval_ms": self.update_interval_ms,
            "last_update_id": self.last_update_id,
            "bids": [[level.price, level.quantity] for level in self.bids],
            "asks": [[level.price, level.quantity] for level in self.asks],
            "top_bid": self.top_bid,
            "top_ask": self.top_ask,
            "mid_price": self.mid_price,
            "spread": self.spread,
            "spread_bps": self.spread_bps,
            "bid_base_quantity": self.bid_base_quantity,
            "ask_base_quantity": self.ask_base_quantity,
            "bid_notional": self.bid_notional,
            "ask_notional": self.ask_notional,
            "notional_imbalance": self.notional_imbalance,
            "event_time_ms": self.event_time_ms,
            "received_at_ms": self.received_at_ms,
            "source": self.source.value,
            "delivery": "snapshot",
            "partial": True,
            "full_book": False,
            "sequence_continuity": False,
        }


@dataclass(frozen=True, slots=True)
class OrderBookIngestResult:
    accepted: bool
    reason: OrderBookIngestReason
    snapshot: OrderBookSnapshot | None


def _normalize_identity(identity: OrderBookIdentity) -> OrderBookIdentity:
    if not isinstance(identity, tuple) or len(identity) != 5:
        raise TypeError("order-book identity must be a five-item tuple")
    exchange, market_type, symbol, levels, update_interval_ms = identity
    return (
        _required_text(exchange, label="exchange", case="lower"),
        _required_text(market_type, label="market type", case="lower"),
        _required_text(symbol, label="symbol", case="upper"),
        _depth_levels(levels),
        _required_int(
            update_interval_ms,
            label="update interval",
            minimum=1,
        ),
    )


class OrderBookEngine:
    """Keep one latest partial snapshot for each bounded stream identity."""

    def __init__(self, *, max_streams: int = 64) -> None:
        self._max_streams = _required_int(
            max_streams,
            label="max streams",
            minimum=1,
        )
        self._states: OrderedDict[OrderBookIdentity, OrderBookSnapshot | None] = (
            OrderedDict()
        )
        self._active_streams: set[OrderBookIdentity] = set()
        self._metrics = {
            "ingest_attempts": 0,
            "snapshots_accepted": 0,
            "duplicate_update_ids_rejected": 0,
            "stale_update_ids_rejected": 0,
            "invalid_snapshots_rejected": 0,
            "capacity_rejections": 0,
            "streams_evicted": 0,
            "stream_activations": 0,
            "stream_deactivations": 0,
        }

    def activate_stream(self, identity: OrderBookIdentity) -> bool:
        normalized = _normalize_identity(identity)
        if normalized in self._active_streams:
            return False
        self._reserve_capacity(normalized)
        self._states.setdefault(normalized, None)
        self._active_streams.add(normalized)
        self._metrics["stream_activations"] += 1
        return True

    def deactivate_stream(self, identity: OrderBookIdentity) -> bool:
        normalized = _normalize_identity(identity)
        if normalized not in self._active_streams:
            return False
        self._active_streams.remove(normalized)
        self._metrics["stream_deactivations"] += 1
        return True

    def process(
        self,
        event: MarketEvent,
        *,
        depth_levels: int | None = None,
        update_interval_ms: int | None = None,
    ) -> OrderBookIngestResult:
        try:
            snapshot = OrderBookSnapshot.from_market_event(
                event,
                depth_levels=depth_levels,
                update_interval_ms=update_interval_ms,
            )
        except (TypeError, ValueError):
            self._metrics["ingest_attempts"] += 1
            self._metrics["invalid_snapshots_rejected"] += 1
            raise
        return self.ingest(snapshot)

    def ingest(self, snapshot: OrderBookSnapshot) -> OrderBookIngestResult:
        self._metrics["ingest_attempts"] += 1
        if not isinstance(snapshot, OrderBookSnapshot):
            self._metrics["invalid_snapshots_rejected"] += 1
            raise TypeError("order-book engine ingest requires OrderBookSnapshot")

        identity = snapshot.stream_identity
        current = self._states.get(identity)
        if current is not None:
            if snapshot.last_update_id == current.last_update_id:
                self._metrics["duplicate_update_ids_rejected"] += 1
                return OrderBookIngestResult(False, "duplicate_update_id", None)
            if snapshot.last_update_id < current.last_update_id:
                self._metrics["stale_update_ids_rejected"] += 1
                return OrderBookIngestResult(False, "stale_update_id", None)

        self._reserve_capacity(identity)
        self._states[identity] = snapshot
        self._states.move_to_end(identity)
        self._metrics["snapshots_accepted"] += 1
        return OrderBookIngestResult(True, "accepted", snapshot)

    def snapshot(self, identity: OrderBookIdentity) -> OrderBookSnapshot | None:
        return self._states.get(_normalize_identity(identity))

    def snapshots(self) -> tuple[OrderBookSnapshot, ...]:
        return tuple(snapshot for snapshot in self._states.values() if snapshot is not None)

    def diagnostics(self) -> dict[str, Any]:
        return {
            "delivery": "snapshot",
            "partial": True,
            "full_book": False,
            "sequence_continuity": False,
            "streams": len(self._states),
            "active_streams": len(self._active_streams),
            "snapshots": sum(value is not None for value in self._states.values()),
            "max_streams": self._max_streams,
            "supported_depth_levels": sorted(SUPPORTED_DEPTH_LEVELS),
            "stream_states": [
                {
                    "exchange": identity[0],
                    "market_type": identity[1],
                    "symbol": identity[2],
                    "depth_levels": identity[3],
                    "update_interval_ms": identity[4],
                    "active": identity in self._active_streams,
                    "last_update_id": (
                        snapshot.last_update_id if snapshot is not None else None
                    ),
                }
                for identity, snapshot in self._states.items()
            ],
            **self._metrics,
        }

    def _reserve_capacity(self, identity: OrderBookIdentity) -> None:
        if identity in self._states or len(self._states) < self._max_streams:
            return
        for candidate in tuple(self._states):
            if candidate in self._active_streams:
                continue
            self._states.pop(candidate, None)
            self._metrics["streams_evicted"] += 1
            return
        self._metrics["capacity_rejections"] += 1
        raise RuntimeError(
            f"order-book engine active stream limit reached ({self._max_streams})",
        )


__all__ = [
    "SUPPORTED_DEPTH_LEVELS",
    "OrderBookEngine",
    "OrderBookIdentity",
    "OrderBookIngestReason",
    "OrderBookIngestResult",
    "OrderBookLevel",
    "OrderBookSide",
    "OrderBookSnapshot",
]
