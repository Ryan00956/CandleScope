"""Bounded observational trades for exchanges without repairable aggTrade IDs."""

from __future__ import annotations

import math
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType


StreamIdentity = tuple[str, str, str]


def _text(value: object, label: str, *, lower: bool = False, upper: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"observed trade {label} cannot be blank")
    normalized = value.strip()
    return normalized.lower() if lower else normalized.upper() if upper else normalized


def _number(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"observed trade {label} must be numeric")
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"observed trade {label} must be numeric") from exc
    if not math.isfinite(parsed) or parsed <= 0:
        raise ValueError(f"observed trade {label} must be finite and positive")
    return parsed


def _non_negative_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"observed trade {label} must be an integer")
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"observed trade {label} must be an integer") from exc
    if parsed < 0:
        raise ValueError(f"observed trade {label} must be non-negative")
    return parsed


@dataclass(frozen=True, slots=True)
class ObservedTrade:
    """One locally observed unified trade with no cross-reconnect ID claim."""

    exchange: str
    market_type: str
    symbol: str
    observation_sequence: int
    trade_id: str
    exchange_trade_id: str | None
    price: float
    quantity: float
    trade_time_ms: int
    event_time_ms: int
    received_at_ms: int
    aggressor_side: str
    source: DataSource | str

    def __post_init__(self) -> None:
        object.__setattr__(self, "exchange", _text(self.exchange, "exchange", lower=True))
        object.__setattr__(
            self,
            "market_type",
            _text(self.market_type, "market type", lower=True),
        )
        object.__setattr__(self, "symbol", _text(self.symbol, "symbol", upper=True))
        object.__setattr__(
            self,
            "observation_sequence",
            _non_negative_int(self.observation_sequence, "observation sequence"),
        )
        object.__setattr__(self, "trade_id", _text(self.trade_id, "trade id"))
        exchange_trade_id = self.exchange_trade_id
        if exchange_trade_id is not None:
            exchange_trade_id = str(exchange_trade_id).strip() or None
            object.__setattr__(self, "exchange_trade_id", exchange_trade_id)
        object.__setattr__(self, "price", _number(self.price, "price"))
        object.__setattr__(self, "quantity", _number(self.quantity, "quantity"))
        for name in ("trade_time_ms", "event_time_ms", "received_at_ms"):
            object.__setattr__(
                self,
                name,
                _non_negative_int(getattr(self, name), name),
            )
        side = _text(self.aggressor_side, "aggressor side", lower=True)
        if side not in {"buy", "sell"}:
            raise ValueError("observed trade aggressor side must be buy or sell")
        object.__setattr__(self, "aggressor_side", side)
        source = self.source
        if not isinstance(source, DataSource):
            source = DataSource(_text(source, "source", lower=True))
        object.__setattr__(self, "source", source)

    @property
    def stream_identity(self) -> StreamIdentity:
        return self.exchange, self.market_type, self.symbol

    @property
    def quote_quantity(self) -> float:
        return self.price * self.quantity

    @property
    def is_buyer_maker(self) -> bool:
        return self.aggressor_side == "sell"

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            # Kept for the v1 wire shape.  This is explicitly process-local
            # observation order, never an exchange aggregate-trade ID.
            "agg_trade_id": self.observation_sequence,
            "trade_id": self.trade_id,
            "exchange_trade_id": self.exchange_trade_id,
            "price": self.price,
            "quantity": self.quantity,
            "quote_quantity": self.quote_quantity,
            "trade_time_ms": self.trade_time_ms,
            "event_time_ms": self.event_time_ms,
            "received_at_ms": self.received_at_ms,
            "is_buyer_maker": self.is_buyer_maker,
            "aggressor_side": self.aggressor_side,
            "source": self.source.value,
            "first_trade_id": None,
            "last_trade_id": None,
            "record_kind": "trade",
            "continuity_mode": "observational",
        }


@dataclass(slots=True)
class _State:
    records: deque[ObservedTrade]
    seen: OrderedDict[str, None] = field(default_factory=OrderedDict)
    next_sequence: int = 0


class TradeTapeEngine:
    """Small non-coalescing reducer with bounded replay-dedup state."""

    def __init__(self, *, raw_ring_size: int = 20_000, max_streams: int = 64) -> None:
        self.raw_ring_size = max(1, int(raw_ring_size))
        self.max_streams = max(1, int(max_streams))
        self._states: OrderedDict[StreamIdentity, _State] = OrderedDict()
        self._active: set[StreamIdentity] = set()
        self._metrics = {"accepted": 0, "duplicates": 0, "invalid": 0}

    def activate_stream(self, identity: StreamIdentity) -> bool:
        normalized = _identity(identity)
        if normalized in self._active:
            return False
        self._reserve(normalized)
        self._states.setdefault(normalized, _State(deque(maxlen=self.raw_ring_size)))
        self._active.add(normalized)
        return True

    def deactivate_stream(self, identity: StreamIdentity) -> bool:
        normalized = _identity(identity)
        if normalized not in self._active:
            return False
        self._active.remove(normalized)
        return True

    def ingest(self, event: MarketEvent) -> ObservedTrade | None:
        if event.event_type is not StreamType.TRADE:
            self._metrics["invalid"] += 1
            raise ValueError("trade-tape engine only accepts TRADE MarketEvent values")
        identity = _identity((event.exchange, event.market_type, event.symbol))
        state = self._states.get(identity)
        if state is None or identity not in self._active:
            self._metrics["invalid"] += 1
            raise ValueError("trade-tape stream is not active")
        data = event.data
        side = str(data.get("side") or "").strip().lower()
        if side not in {"buy", "sell"}:
            self._metrics["invalid"] += 1
            raise ValueError("trade-tape requires an explicit aggressor side")
        trade_id = str(data.get("trade_id") or "").strip()
        if not trade_id:
            self._metrics["invalid"] += 1
            raise ValueError("trade-tape requires a stable provider trade id")
        fingerprint = "|".join((trade_id, str(data.get("trade_time_ms")), side))
        if fingerprint in state.seen:
            self._metrics["duplicates"] += 1
            return None
        record = ObservedTrade(
            exchange=identity[0],
            market_type=identity[1],
            symbol=identity[2],
            observation_sequence=state.next_sequence,
            trade_id=trade_id,
            exchange_trade_id=data.get("exchange_trade_id"),
            price=data.get("price"),
            quantity=data.get("quantity"),
            trade_time_ms=data.get("trade_time_ms", event.event_time_ms),
            event_time_ms=event.event_time_ms,
            received_at_ms=event.received_at_ms,
            aggressor_side=side,
            source=event.source,
        )
        state.next_sequence += 1
        state.records.append(record)
        state.seen[fingerprint] = None
        while len(state.seen) > self.raw_ring_size:
            state.seen.popitem(last=False)
        self._states.move_to_end(identity)
        self._metrics["accepted"] += 1
        return record

    def raw_tail(self, identity: StreamIdentity, limit: int) -> tuple[ObservedTrade, ...]:
        state = self._states.get(_identity(identity))
        if state is None or limit <= 0:
            return ()
        return tuple(list(state.records)[-int(limit):])

    def diagnostics(self) -> dict[str, Any]:
        return {
            "mode": "observational_trade_tape",
            "continuity": False,
            "history": False,
            "streams": len(self._states),
            "active_streams": len(self._active),
            "raw_ring_size": self.raw_ring_size,
            "max_streams": self.max_streams,
            **self._metrics,
        }

    def _reserve(self, identity: StreamIdentity) -> None:
        if identity in self._states or len(self._states) < self.max_streams:
            return
        for candidate in tuple(self._states):
            if candidate not in self._active:
                self._states.pop(candidate, None)
                return
        raise RuntimeError(f"trade-tape stream limit reached ({self.max_streams})")


def _identity(value: StreamIdentity) -> StreamIdentity:
    if not isinstance(value, tuple) or len(value) != 3:
        raise TypeError("trade-tape identity must be a three-item tuple")
    return (
        _text(value[0], "exchange", lower=True),
        _text(value[1], "market type", lower=True),
        _text(value[2], "symbol", upper=True),
    )


__all__ = ["ObservedTrade", "StreamIdentity", "TradeTapeEngine"]
