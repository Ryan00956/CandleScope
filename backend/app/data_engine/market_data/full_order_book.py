"""Strict, bounded reconstruction of a local full order book.

The state machine consumes an initial REST depth snapshot and ordered diff
events.  It is deliberately independent from the replaceable Partial Top-N
pipeline: gaps, crossed books, and capacity violations invalidate the entire
local book and require a fresh synchronization epoch.
"""

from __future__ import annotations

import enum
import math
from bisect import bisect_left, insort
from collections import OrderedDict, deque
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, TypeAlias

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType


FullOrderBookIdentity: TypeAlias = tuple[str, str, str, int]

_MATERIALIZED_TOP_LEVELS = 1_000
_MAX_LAZY_REVISION_DEPTH = 64
_TRUSTED_LAZY_SNAPSHOT = object()


class FullOrderBookState(str, enum.Enum):
    INACTIVE = "inactive"
    BUFFERING = "buffering"
    AWAITING_BRIDGE = "awaiting_bridge"
    LIVE = "live"
    RESYNC_REQUIRED = "resync_required"

    def __str__(self) -> str:
        return self.value


class FullOrderBookAction(str, enum.Enum):
    BUFFERED = "buffered"
    SNAPSHOT_INSTALLED = "snapshot_installed"
    APPLIED = "applied"
    DUPLICATE = "duplicate"
    STALE = "stale"
    STALE_EPOCH = "stale_epoch"
    RESYNC_REQUIRED = "resync_required"

    def __str__(self) -> str:
        return self.value


class FullOrderBookFailure(str, enum.Enum):
    GAP = "gap"
    CONFLICTING_DUPLICATE = "conflicting_duplicate"
    CROSSED_BOOK = "crossed_book"
    EMPTY_BOOK = "empty_book"
    CAPACITY = "capacity"

    def __str__(self) -> str:
        return self.value


class FullOrderBookError(RuntimeError):
    """Base class for invalid engine lifecycle operations."""


class FullOrderBookStateError(FullOrderBookError):
    """Raised when a caller uses a missing, inactive, or wrong-state stream."""


def _required_text(value: object, *, label: str, case: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"full order-book {label} must be a string")
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"full order-book {label} cannot be blank")
    return normalized.lower() if case == "lower" else normalized.upper()


def _required_int(value: object, *, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool):
        raise TypeError(f"full order-book {label} must be an integer")
    try:
        parsed = int(value)  # type: ignore[arg-type]
        decimal_value = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"full order-book {label} must be an integer") from exc
    if not decimal_value.is_finite() or decimal_value != parsed:
        raise TypeError(f"full order-book {label} must be an integer")
    if parsed < minimum:
        raise ValueError(f"full order-book {label} must be >= {minimum}")
    return parsed


def _finite_float(
    value: object,
    *,
    label: str,
    allow_zero: bool,
) -> float:
    if isinstance(value, bool):
        raise TypeError(f"full order-book {label} must be numeric")
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"full order-book {label} must be numeric") from exc
    minimum_ok = parsed >= 0 if allow_zero else parsed > 0
    if not math.isfinite(parsed) or not minimum_ok:
        qualifier = "non-negative" if allow_zero else "positive"
        raise ValueError(
            f"full order-book {label} must be finite and {qualifier}",
        )
    return parsed


def _source(value: DataSource | str) -> DataSource:
    if isinstance(value, DataSource):
        return value
    try:
        return DataSource(_required_text(value, label="source", case="lower"))
    except ValueError as exc:
        raise ValueError("full order-book source is unsupported") from exc


def _event_type_is_full_depth(event: MarketEvent) -> bool:
    return getattr(event.event_type, "value", event.event_type) == StreamType.FULL_DEPTH.value


def _event_data(event: MarketEvent, *, kind: str) -> Mapping[str, Any]:
    if not _event_type_is_full_depth(event):
        raise ValueError("full order-book engine only accepts FULL_DEPTH MarketEvent values")
    if not isinstance(event.data, Mapping):
        raise TypeError("full order-book MarketEvent data must be an object")
    actual_kind = _required_text(event.data.get("kind"), label="event kind", case="lower")
    if actual_kind != kind:
        raise ValueError(f"full order-book expected {kind!r} event kind")
    return event.data


def _event_update_interval(data: Mapping[str, Any], override: int | None) -> int:
    raw = data.get("update_interval_ms")
    if raw is None and override is None:
        raise ValueError("full order-book event requires update_interval_ms")
    from_event = (
        _required_int(raw, label="update interval", minimum=1)
        if raw is not None
        else None
    )
    from_override = (
        _required_int(override, label="update interval", minimum=1)
        if override is not None
        else None
    )
    if from_event is not None and from_override is not None and from_event != from_override:
        raise ValueError("full order-book update interval conflicts with stream identity")
    return from_event if from_event is not None else from_override  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class FullOrderBookLevel:
    price: float
    quantity: float

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "price",
            _finite_float(self.price, label="level price", allow_zero=False),
        )
        object.__setattr__(
            self,
            "quantity",
            _finite_float(self.quantity, label="level quantity", allow_zero=False),
        )

    @property
    def notional(self) -> float:
        value = self.price * self.quantity
        if not math.isfinite(value):
            raise ValueError("full order-book level notional must be finite")
        return value

    def to_dict(self) -> dict[str, float]:
        return {"price": self.price, "quantity": self.quantity}


@dataclass(frozen=True, slots=True)
class DepthLevelUpdate:
    price: float
    quantity: float

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "price",
            _finite_float(self.price, label="update price", allow_zero=False),
        )
        object.__setattr__(
            self,
            "quantity",
            _finite_float(self.quantity, label="update quantity", allow_zero=True),
        )

    @property
    def deletes_level(self) -> bool:
        return self.quantity == 0

    def to_dict(self) -> dict[str, float]:
        return {"price": self.price, "quantity": self.quantity}


def _pair(value: object, *, update: bool, side: str) -> FullOrderBookLevel | DepthLevelUpdate:
    expected = DepthLevelUpdate if update else FullOrderBookLevel
    if isinstance(value, expected):
        return value
    if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, Sequence):
        raise TypeError(f"full order-book {side} level must be a price/quantity pair")
    if len(value) != 2:
        raise ValueError(f"full order-book {side} level must contain price and quantity")
    return expected(value[0], value[1])  # type: ignore[arg-type,call-arg,return-value]


def _levels(
    values: object,
    *,
    update: bool,
    side: str,
    allow_empty: bool,
) -> tuple[FullOrderBookLevel, ...] | tuple[DepthLevelUpdate, ...]:
    if isinstance(values, (str, bytes, Mapping)) or not isinstance(values, Iterable):
        raise TypeError(f"full order-book {side}s must be an iterable")
    parsed = tuple(_pair(value, update=update, side=side) for value in values)
    if not parsed and not allow_empty:
        raise ValueError(f"full order-book {side}s cannot be empty")
    if len({item.price for item in parsed}) != len(parsed):
        raise ValueError(f"full order-book {side}s contain duplicate prices")
    return parsed


def _canonical_seed_levels(
    values: object,
    *,
    side: str,
) -> tuple[FullOrderBookLevel, ...]:
    parsed = _levels(values, update=False, side=side, allow_empty=False)
    return tuple(
        sorted(
            parsed,
            key=lambda level: level.price,
            reverse=side == "bid",
        ),
    )


class _BookRevision:
    """Immutable revision chain with an eagerly bounded top-of-book view.

    The engine keeps its mutable reconstruction state private.  Published
    snapshots retain only the delta from their predecessor plus the first
    ``_MATERIALIZED_TOP_LEVELS`` immutable level objects.  A complete sorted
    book is materialized only when a caller explicitly asks for more than the
    bounded view (for example, grouped projection across the whole source).
    """

    __slots__ = (
        "_ask_updates",
        "_asks_cache",
        "_bid_updates",
        "_bids_cache",
        "_depth",
        "_parent",
        "ask_count",
        "bid_count",
        "top_asks",
        "top_bids",
    )

    def __init__(
        self,
        *,
        parent: _BookRevision | None,
        bid_updates: tuple[tuple[float, FullOrderBookLevel | None], ...],
        ask_updates: tuple[tuple[float, FullOrderBookLevel | None], ...],
        top_bids: tuple[FullOrderBookLevel, ...],
        top_asks: tuple[FullOrderBookLevel, ...],
        bid_count: int,
        ask_count: int,
        base_bids: tuple[FullOrderBookLevel, ...] | None = None,
        base_asks: tuple[FullOrderBookLevel, ...] | None = None,
    ) -> None:
        self._parent = parent
        self._bid_updates = bid_updates
        self._ask_updates = ask_updates
        self.top_bids = top_bids
        self.top_asks = top_asks
        self.bid_count = bid_count
        self.ask_count = ask_count
        self._bids_cache = base_bids
        self._asks_cache = base_asks
        self._depth = 0 if parent is None else parent._depth + 1

    @classmethod
    def from_book(
        cls,
        bids: Mapping[float, FullOrderBookLevel],
        asks: Mapping[float, FullOrderBookLevel],
        bid_prices: Sequence[float],
        ask_prices: Sequence[float],
    ) -> _BookRevision:
        full_bids = tuple(bids[price] for price in reversed(bid_prices))
        full_asks = tuple(asks[price] for price in ask_prices)
        return cls(
            parent=None,
            bid_updates=(),
            ask_updates=(),
            top_bids=full_bids[:_MATERIALIZED_TOP_LEVELS],
            top_asks=full_asks[:_MATERIALIZED_TOP_LEVELS],
            bid_count=len(full_bids),
            ask_count=len(full_asks),
            base_bids=full_bids,
            base_asks=full_asks,
        )

    def child(
        self,
        delta: DepthDelta,
        bids: Mapping[float, FullOrderBookLevel],
        asks: Mapping[float, FullOrderBookLevel],
        bid_prices: Sequence[float],
        ask_prices: Sequence[float],
    ) -> _BookRevision:
        parent: _BookRevision | None = self
        if self._bids_cache is not None and self._asks_cache is not None:
            # A consumer already paid for this revision's full projection.  Use
            # it as the next immutable base and release the older chain.
            parent = _BookRevision(
                parent=None,
                bid_updates=(),
                ask_updates=(),
                top_bids=self.top_bids,
                top_asks=self.top_asks,
                bid_count=self.bid_count,
                ask_count=self.ask_count,
                base_bids=self._bids_cache,
                base_asks=self._asks_cache,
            )
        elif self._depth >= _MAX_LAZY_REVISION_DEPTH:
            # Bound retained delta history even when no full-depth consumer is
            # attached.  This is one compaction per 64 revisions, never one
            # full sort/materialization per exchange diff.
            parent = _BookRevision(
                parent=None,
                bid_updates=(),
                ask_updates=(),
                top_bids=self.top_bids,
                top_asks=self.top_asks,
                bid_count=self.bid_count,
                ask_count=self.ask_count,
                base_bids=self.materialize("bids"),
                base_asks=self.materialize("asks"),
            )

        return _BookRevision(
            parent=parent,
            bid_updates=tuple(
                (update.price, bids.get(update.price)) for update in delta.bids
            ),
            ask_updates=tuple(
                (update.price, asks.get(update.price)) for update in delta.asks
            ),
            top_bids=tuple(
                bids[price]
                for price in reversed(bid_prices[-_MATERIALIZED_TOP_LEVELS:])
            ),
            top_asks=tuple(
                asks[price] for price in ask_prices[:_MATERIALIZED_TOP_LEVELS]
            ),
            bid_count=len(bids),
            ask_count=len(asks),
        )

    def materialize(
        self,
        side: str,
    ) -> tuple[FullOrderBookLevel, ...]:
        cache_name = "_bids_cache" if side == "bids" else "_asks_cache"
        cached = getattr(self, cache_name)
        if cached is not None:
            return cached

        trail: list[_BookRevision] = []
        cursor: _BookRevision = self
        while getattr(cursor, cache_name) is None:
            trail.append(cursor)
            parent = cursor._parent
            if parent is None:
                raise RuntimeError("full order-book revision has no materialized base")
            cursor = parent

        levels = {
            level.price: level
            for level in getattr(cursor, cache_name)
        }
        updates_name = "_bid_updates" if side == "bids" else "_ask_updates"
        for revision in reversed(trail):
            for price, level in getattr(revision, updates_name):
                if level is None:
                    levels.pop(price, None)
                else:
                    levels[price] = level
        materialized = tuple(
            sorted(
                levels.values(),
                key=lambda level: level.price,
                reverse=side == "bids",
            ),
        )
        setattr(self, cache_name, materialized)
        return materialized


class _LazyBookSide(Sequence[FullOrderBookLevel]):
    """Immutable sequence facade over one atomic book revision."""

    __slots__ = ("_depth", "_revision", "_side")

    def __init__(
        self,
        revision: _BookRevision,
        side: str,
        depth: int | None,
    ) -> None:
        self._revision = revision
        self._side = side
        self._depth = depth

    def __len__(self) -> int:
        count = (
            self._revision.bid_count
            if self._side == "bids"
            else self._revision.ask_count
        )
        return count if self._depth is None else min(count, self._depth)

    def __getitem__(self, index: int | slice) -> FullOrderBookLevel | tuple[FullOrderBookLevel, ...]:
        return self._view()[index]

    def __iter__(self):
        return iter(self._view())

    @property
    def best(self) -> FullOrderBookLevel:
        top = self._revision.top_bids if self._side == "bids" else self._revision.top_asks
        return top[0]

    def top(self, limit: int) -> tuple[FullOrderBookLevel, ...]:
        bounded = min(max(0, int(limit)), len(self))
        top = self._revision.top_bids if self._side == "bids" else self._revision.top_asks
        if bounded <= len(top):
            return top[:bounded]
        return self._view()[:bounded]

    def _view(self) -> tuple[FullOrderBookLevel, ...]:
        length = len(self)
        top = self._revision.top_bids if self._side == "bids" else self._revision.top_asks
        if length <= len(top):
            return top[:length]
        return self._revision.materialize(self._side)[:length]


@dataclass(frozen=True, slots=True)
class FullOrderBookSeed:
    """Validated REST depth snapshot used to initialize one sync epoch."""

    exchange: str
    market_type: str
    symbol: str
    update_interval_ms: int
    snapshot_limit: int
    last_update_id: int
    bids: tuple[FullOrderBookLevel, ...]
    asks: tuple[FullOrderBookLevel, ...]
    event_time_ms: int
    received_at_ms: int
    source: DataSource | str

    def __post_init__(self) -> None:
        object.__setattr__(self, "exchange", _required_text(self.exchange, label="exchange", case="lower"))
        object.__setattr__(self, "market_type", _required_text(self.market_type, label="market type", case="lower"))
        object.__setattr__(self, "symbol", _required_text(self.symbol, label="symbol", case="upper"))
        object.__setattr__(self, "update_interval_ms", _required_int(self.update_interval_ms, label="update interval", minimum=1))
        limit = _required_int(self.snapshot_limit, label="snapshot limit", minimum=1)
        object.__setattr__(self, "snapshot_limit", limit)
        object.__setattr__(self, "last_update_id", _required_int(self.last_update_id, label="last update id", minimum=1))
        object.__setattr__(self, "event_time_ms", _required_int(self.event_time_ms, label="event time", minimum=0))
        object.__setattr__(self, "received_at_ms", _required_int(self.received_at_ms, label="received at", minimum=0))
        object.__setattr__(self, "source", _source(self.source))
        bids = _canonical_seed_levels(self.bids, side="bid")
        asks = _canonical_seed_levels(self.asks, side="ask")
        if len(bids) > limit or len(asks) > limit:
            raise ValueError("full order-book seed rows exceed snapshot_limit")
        if bids[0].price >= asks[0].price:
            raise ValueError("full order-book seed must not be crossed or locked")
        object.__setattr__(self, "bids", bids)
        object.__setattr__(self, "asks", asks)

    @property
    def stream_identity(self) -> FullOrderBookIdentity:
        return self.exchange, self.market_type, self.symbol, self.update_interval_ms

    @classmethod
    def from_market_event(
        cls,
        event: MarketEvent,
        *,
        update_interval_ms: int | None = None,
    ) -> FullOrderBookSeed:
        data = _event_data(event, kind="snapshot")
        last_update_id = data.get("last_update_id", event.sequence)
        if event.sequence is not None and last_update_id is not None:
            if _required_int(event.sequence, label="event sequence", minimum=1) != _required_int(last_update_id, label="last update id", minimum=1):
                raise ValueError("full order-book snapshot ID conflicts with event sequence")
        return cls(
            exchange=event.exchange,
            market_type=event.market_type,
            symbol=event.symbol,
            update_interval_ms=_event_update_interval(data, update_interval_ms),
            snapshot_limit=data.get("snapshot_limit"),  # type: ignore[arg-type]
            last_update_id=last_update_id,  # type: ignore[arg-type]
            bids=data.get("bids"),  # type: ignore[arg-type]
            asks=data.get("asks"),  # type: ignore[arg-type]
            event_time_ms=event.event_time_ms,
            received_at_ms=event.received_at_ms,
            source=event.source,
        )


@dataclass(frozen=True, slots=True)
class DepthDelta:
    """One ordered absolute-quantity diff event (zero quantity deletes).

    Binance USD-M links events through ``pu``. Binance Spot does not publish
    that field and instead exposes overlapping ``U``/``u`` update ranges.
    """

    exchange: str
    market_type: str
    symbol: str
    update_interval_ms: int
    first_update_id: int
    final_update_id: int
    previous_final_update_id: int | None
    bids: tuple[DepthLevelUpdate, ...]
    asks: tuple[DepthLevelUpdate, ...]
    event_time_ms: int
    transaction_time_ms: int | None
    received_at_ms: int
    source: DataSource | str

    def __post_init__(self) -> None:
        object.__setattr__(self, "exchange", _required_text(self.exchange, label="exchange", case="lower"))
        object.__setattr__(self, "market_type", _required_text(self.market_type, label="market type", case="lower"))
        object.__setattr__(self, "symbol", _required_text(self.symbol, label="symbol", case="upper"))
        object.__setattr__(self, "update_interval_ms", _required_int(self.update_interval_ms, label="update interval", minimum=1))
        first_id = _required_int(self.first_update_id, label="first update id", minimum=1)
        final_id = _required_int(self.final_update_id, label="final update id", minimum=1)
        previous_id: int | None
        if self.exchange == "binance" and self.market_type == "spot":
            if self.previous_final_update_id is not None:
                raise ValueError(
                    "Binance Spot full order-book deltas must not claim a previous update link",
                )
            previous_id = None
        else:
            previous_id = _required_int(
                self.previous_final_update_id,
                label="previous final update id",
                minimum=0,
            )
        if first_id > final_id:
            raise ValueError("full order-book first update id cannot exceed final update id")
        if previous_id is not None and previous_id >= final_id:
            raise ValueError("full order-book previous update id must precede final update id")
        object.__setattr__(self, "first_update_id", first_id)
        object.__setattr__(self, "final_update_id", final_id)
        object.__setattr__(self, "previous_final_update_id", previous_id)
        object.__setattr__(self, "event_time_ms", _required_int(self.event_time_ms, label="event time", minimum=0))
        if self.transaction_time_ms is not None:
            object.__setattr__(self, "transaction_time_ms", _required_int(self.transaction_time_ms, label="transaction time", minimum=0))
        object.__setattr__(self, "received_at_ms", _required_int(self.received_at_ms, label="received at", minimum=0))
        object.__setattr__(self, "source", _source(self.source))
        object.__setattr__(self, "bids", _levels(self.bids, update=True, side="bid", allow_empty=True))
        object.__setattr__(self, "asks", _levels(self.asks, update=True, side="ask", allow_empty=True))

    @property
    def stream_identity(self) -> FullOrderBookIdentity:
        return self.exchange, self.market_type, self.symbol, self.update_interval_ms

    @property
    def level_update_count(self) -> int:
        return len(self.bids) + len(self.asks)

    @property
    def signature(self) -> tuple[Any, ...]:
        return (
            self.first_update_id,
            self.final_update_id,
            self.previous_final_update_id,
            tuple((item.price, item.quantity) for item in self.bids),
            tuple((item.price, item.quantity) for item in self.asks),
        )

    @classmethod
    def from_market_event(
        cls,
        event: MarketEvent,
        *,
        update_interval_ms: int | None = None,
    ) -> DepthDelta:
        data = _event_data(event, kind="delta")
        final_id = data.get("final_update_id", data.get("last_update_id", event.sequence))
        if event.sequence is not None and final_id is not None:
            if _required_int(event.sequence, label="event sequence", minimum=1) != _required_int(final_id, label="final update id", minimum=1):
                raise ValueError("full order-book delta ID conflicts with event sequence")
        return cls(
            exchange=event.exchange,
            market_type=event.market_type,
            symbol=event.symbol,
            update_interval_ms=_event_update_interval(data, update_interval_ms),
            first_update_id=data.get("first_update_id"),  # type: ignore[arg-type]
            final_update_id=final_id,  # type: ignore[arg-type]
            previous_final_update_id=data.get("previous_final_update_id"),  # type: ignore[arg-type]
            bids=data.get("bids", ()),  # type: ignore[arg-type]
            asks=data.get("asks", ()),  # type: ignore[arg-type]
            event_time_ms=data.get("event_time_ms", event.event_time_ms),  # type: ignore[arg-type]
            transaction_time_ms=data.get("transaction_time_ms"),  # type: ignore[arg-type]
            received_at_ms=event.received_at_ms,
            source=event.source,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "update_interval_ms": self.update_interval_ms,
            "first_update_id": self.first_update_id,
            "final_update_id": self.final_update_id,
            "previous_final_update_id": self.previous_final_update_id,
            "bids": [[item.price, item.quantity] for item in self.bids],
            "asks": [[item.price, item.quantity] for item in self.asks],
            "event_time_ms": self.event_time_ms,
            "transaction_time_ms": self.transaction_time_ms,
            "received_at_ms": self.received_at_ms,
            "source": self.source.value,
        }


@dataclass(frozen=True, slots=True)
class FullOrderBookSnapshot:
    """One immutable atomic projection of a strictly synchronized local book."""

    exchange: str
    market_type: str
    symbol: str
    update_interval_ms: int
    epoch: int
    last_update_id: int
    snapshot_limit: int
    bids: Sequence[FullOrderBookLevel]
    asks: Sequence[FullOrderBookLevel]
    book_bid_levels: int
    book_ask_levels: int
    projection_depth: int | None
    event_time_ms: int
    received_at_ms: int
    source: DataSource
    revision: int
    _materialization_token: object | None = field(
        default=None,
        repr=False,
        compare=False,
    )

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
            "epoch",
            _required_int(self.epoch, label="epoch", minimum=1),
        )
        object.__setattr__(
            self,
            "last_update_id",
            _required_int(
                self.last_update_id,
                label="last update id",
                minimum=1,
            ),
        )
        object.__setattr__(
            self,
            "snapshot_limit",
            _required_int(
                self.snapshot_limit,
                label="snapshot limit",
                minimum=1,
            ),
        )
        trusted_lazy = (
            self._materialization_token is _TRUSTED_LAZY_SNAPSHOT
            and isinstance(self.bids, _LazyBookSide)
            and isinstance(self.asks, _LazyBookSide)
        )
        if trusted_lazy:
            bids = self.bids
            asks = self.asks
        else:
            bids = _canonical_seed_levels(self.bids, side="bid")
            asks = _canonical_seed_levels(self.asks, side="ask")
        best_bid = bids.best if trusted_lazy else bids[0]
        best_ask = asks.best if trusted_lazy else asks[0]
        if best_bid.price >= best_ask.price:
            raise ValueError("full order-book snapshot must not be crossed or locked")
        object.__setattr__(self, "bids", bids)
        object.__setattr__(self, "asks", asks)
        bid_count = _required_int(
            self.book_bid_levels,
            label="book bid levels",
            minimum=1,
        )
        ask_count = _required_int(
            self.book_ask_levels,
            label="book ask levels",
            minimum=1,
        )
        if bid_count < len(bids) or ask_count < len(asks):
            raise ValueError("full order-book projection exceeds complete book counts")
        object.__setattr__(self, "book_bid_levels", bid_count)
        object.__setattr__(self, "book_ask_levels", ask_count)
        if self.projection_depth is None:
            if bid_count != len(bids) or ask_count != len(asks):
                raise ValueError(
                    "full order-book full projection must contain every local level",
                )
        else:
            projection_depth = _required_int(
                self.projection_depth,
                label="projection depth",
                minimum=1,
            )
            if len(bids) > projection_depth or len(asks) > projection_depth:
                raise ValueError("full order-book projection exceeds requested depth")
            object.__setattr__(self, "projection_depth", projection_depth)
        object.__setattr__(
            self,
            "event_time_ms",
            _required_int(self.event_time_ms, label="event time", minimum=0),
        )
        object.__setattr__(
            self,
            "received_at_ms",
            _required_int(self.received_at_ms, label="received at", minimum=0),
        )
        object.__setattr__(self, "source", _source(self.source))
        object.__setattr__(
            self,
            "revision",
            _required_int(self.revision, label="revision", minimum=1),
        )

    @property
    def stream_identity(self) -> FullOrderBookIdentity:
        return self.exchange, self.market_type, self.symbol, self.update_interval_ms

    @property
    def full_projection(self) -> bool:
        return self.projection_depth is None

    @property
    def top_bid(self) -> float:
        if isinstance(self.bids, _LazyBookSide):
            return self.bids.best.price
        return self.bids[0].price

    @property
    def top_ask(self) -> float:
        if isinstance(self.asks, _LazyBookSide):
            return self.asks.best.price
        return self.asks[0].price

    @property
    def spread(self) -> float:
        return self.top_ask - self.top_bid

    @property
    def mid_price(self) -> float:
        return self.top_bid + self.spread / 2

    @property
    def spread_bps(self) -> float:
        return self.spread / self.mid_price * 10_000

    def to_dict(self) -> dict[str, Any]:
        payload = self.to_event_data()
        payload["bids"] = [[item.price, item.quantity] for item in self.bids]
        payload["asks"] = [[item.price, item.quantity] for item in self.asks]
        payload.pop("_canonical_level_order", None)
        return payload

    def to_event_data(self) -> dict[str, Any]:
        """Return hub-safe metadata while retaining lazy immutable level views."""

        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "mode": "full_depth_reconstructed",
            "update_interval_ms": self.update_interval_ms,
            "epoch": self.epoch,
            "last_update_id": self.last_update_id,
            "snapshot_limit": self.snapshot_limit,
            "revision": self.revision,
            "projection_depth": self.projection_depth,
            "full_projection": self.full_projection,
            "book_bid_levels": self.book_bid_levels,
            "book_ask_levels": self.book_ask_levels,
            "bids": self.bids,
            "asks": self.asks,
            "top_bid": self.top_bid,
            "top_ask": self.top_ask,
            "mid_price": self.mid_price,
            "spread": self.spread,
            "spread_bps": self.spread_bps,
            "event_time_ms": self.event_time_ms,
            "received_at_ms": self.received_at_ms,
            "source": self.source.value,
            "local_sequence_continuity": True,
            "exchange_full_depth_exhaustive": False,
            "_canonical_level_order": True,
        }


@dataclass(frozen=True, slots=True)
class FullOrderBookApplyResult:
    accepted: bool
    action: FullOrderBookAction
    state: FullOrderBookState
    epoch: int
    last_update_id: int | None
    reason: str | None = None
    failure: FullOrderBookFailure | None = None
    snapshot: FullOrderBookSnapshot | None = None

    @property
    def live(self) -> bool:
        return self.state is FullOrderBookState.LIVE

    def to_dict(self) -> dict[str, Any]:
        return {
            "accepted": self.accepted,
            "action": self.action.value,
            "state": self.state.value,
            "epoch": self.epoch,
            "last_update_id": self.last_update_id,
            "reason": self.reason,
            "failure": self.failure.value if self.failure is not None else None,
            "live": self.live,
            "snapshot": self.snapshot.to_dict() if self.snapshot is not None else None,
        }


@dataclass(slots=True)
class _StreamState:
    epoch: int
    status: FullOrderBookState
    bids: dict[float, FullOrderBookLevel] = field(default_factory=dict)
    asks: dict[float, FullOrderBookLevel] = field(default_factory=dict)
    bid_prices: list[float] = field(default_factory=list)
    ask_prices: list[float] = field(default_factory=list)
    book_revision: _BookRevision | None = None
    buffered: deque[DepthDelta] = field(default_factory=deque)
    buffered_updates: int = 0
    last_update_id: int | None = None
    last_delta_signature: tuple[Any, ...] | None = None
    snapshot_limit: int | None = None
    event_time_ms: int = 0
    received_at_ms: int = 0
    source: DataSource = DataSource.MOCK
    revision: int = 0
    failure: FullOrderBookFailure | None = None
    failure_detail: str | None = None


def _normalize_identity(identity: FullOrderBookIdentity) -> FullOrderBookIdentity:
    if not isinstance(identity, tuple) or len(identity) != 4:
        raise TypeError("full order-book identity must be a four-item tuple")
    exchange, market_type, symbol, update_interval_ms = identity
    return (
        _required_text(exchange, label="exchange", case="lower"),
        _required_text(market_type, label="market type", case="lower"),
        _required_text(symbol, label="symbol", case="upper"),
        _required_int(update_interval_ms, label="update interval", minimum=1),
    )


class FullOrderBookEngine:
    """Hard-bounded multi-stream full-book synchronization state machine."""

    def __init__(
        self,
        *,
        max_streams: int = 32,
        max_levels_per_side: int = 5_000,
        max_buffered_deltas_per_stream: int = 4_096,
        max_updates_per_delta: int = 10_000,
        max_buffered_level_updates: int = 200_000,
    ) -> None:
        self._max_streams = _required_int(max_streams, label="max streams", minimum=1)
        self._max_levels_per_side = _required_int(max_levels_per_side, label="max levels per side", minimum=1)
        self._max_buffered_deltas = _required_int(max_buffered_deltas_per_stream, label="max buffered deltas", minimum=1)
        self._max_updates_per_delta = _required_int(max_updates_per_delta, label="max updates per delta", minimum=1)
        self._max_buffered_level_updates = _required_int(max_buffered_level_updates, label="max buffered level updates", minimum=1)
        self._streams: OrderedDict[FullOrderBookIdentity, _StreamState] = OrderedDict()
        self._active: set[FullOrderBookIdentity] = set()
        self._next_epoch = 0
        self._metrics = {
            "streams_activated": 0,
            "streams_deactivated": 0,
            "streams_evicted": 0,
            "syncs_started": 0,
            "snapshots_received": 0,
            "snapshots_installed": 0,
            "deltas_received": 0,
            "deltas_buffered": 0,
            "deltas_replayed": 0,
            "deltas_applied": 0,
            "deltas_duplicate": 0,
            "deltas_stale": 0,
            "stale_epochs": 0,
            "invalid_inputs": 0,
            "gaps": 0,
            "conflicting_duplicates": 0,
            "crossed_books": 0,
            "empty_books": 0,
            "capacity_failures": 0,
            "buffered_old_discarded": 0,
        }

    def activate_stream(self, identity: FullOrderBookIdentity) -> bool:
        normalized = _normalize_identity(identity)
        if normalized in self._active:
            return False
        self._reserve_capacity(normalized)
        state = self._streams.get(normalized)
        if state is None:
            state = _StreamState(self._allocate_epoch(), FullOrderBookState.BUFFERING)
            self._streams[normalized] = state
        else:
            self._reset(state, epoch=self._allocate_epoch(), status=FullOrderBookState.BUFFERING)
        self._active.add(normalized)
        self._streams.move_to_end(normalized)
        self._metrics["streams_activated"] += 1
        return True

    def deactivate_stream(self, identity: FullOrderBookIdentity) -> bool:
        normalized = _normalize_identity(identity)
        if normalized not in self._active:
            return False
        self._active.remove(normalized)
        state = self._streams[normalized]
        self._reset(state, epoch=self._allocate_epoch(), status=FullOrderBookState.INACTIVE)
        self._metrics["streams_deactivated"] += 1
        return True

    def epoch(self, identity: FullOrderBookIdentity) -> int | None:
        state = self._streams.get(_normalize_identity(identity))
        return state.epoch if state is not None else None

    def state(self, identity: FullOrderBookIdentity) -> FullOrderBookState | None:
        state = self._streams.get(_normalize_identity(identity))
        return state.status if state is not None else None

    def begin_sync(self, identity: FullOrderBookIdentity) -> int:
        normalized, state = self._active_state(identity)
        self._reset(state, epoch=self._allocate_epoch(), status=FullOrderBookState.BUFFERING)
        self._streams.move_to_end(normalized)
        self._metrics["syncs_started"] += 1
        return state.epoch

    def apply_delta(
        self,
        identity: FullOrderBookIdentity,
        event: MarketEvent | DepthDelta,
        *,
        epoch: int,
    ) -> FullOrderBookApplyResult:
        normalized, state = self._active_state(identity)
        if not self._epoch_matches(state, epoch):
            return self._stale_epoch_result(state)
        try:
            delta = event if isinstance(event, DepthDelta) else DepthDelta.from_market_event(event, update_interval_ms=normalized[3])
        except (TypeError, ValueError):
            self._metrics["invalid_inputs"] += 1
            raise
        if delta.stream_identity != normalized:
            self._metrics["invalid_inputs"] += 1
            raise ValueError("full order-book delta identity conflicts with target stream")
        self._metrics["deltas_received"] += 1
        if delta.level_update_count > self._max_updates_per_delta:
            return self._fail(state, FullOrderBookFailure.CAPACITY, "delta level update limit exceeded")
        if state.status is FullOrderBookState.RESYNC_REQUIRED:
            return self._result(state, False, FullOrderBookAction.RESYNC_REQUIRED, reason=state.failure_detail, failure=state.failure)
        if state.status is FullOrderBookState.BUFFERING:
            result = self._buffer_delta(state, delta)
        elif state.status is FullOrderBookState.AWAITING_BRIDGE:
            result = self._apply_bridge(normalized, state, delta)
        elif state.status is FullOrderBookState.LIVE:
            result = self._apply_live(normalized, state, delta)
        else:
            raise FullOrderBookStateError("full order-book stream is not synchronizing")
        self._streams.move_to_end(normalized)
        return result

    def install_snapshot(
        self,
        identity: FullOrderBookIdentity,
        event: MarketEvent | FullOrderBookSeed,
        *,
        epoch: int,
    ) -> FullOrderBookApplyResult:
        normalized, state = self._active_state(identity)
        if not self._epoch_matches(state, epoch):
            return self._stale_epoch_result(state)
        if state.status is FullOrderBookState.RESYNC_REQUIRED:
            return self._result(state, False, FullOrderBookAction.RESYNC_REQUIRED, reason=state.failure_detail, failure=state.failure)
        if state.status is not FullOrderBookState.BUFFERING:
            raise FullOrderBookStateError("full order-book snapshot requires buffering state")
        try:
            seed = event if isinstance(event, FullOrderBookSeed) else FullOrderBookSeed.from_market_event(event, update_interval_ms=normalized[3])
        except (TypeError, ValueError):
            self._metrics["invalid_inputs"] += 1
            raise
        if seed.stream_identity != normalized:
            self._metrics["invalid_inputs"] += 1
            raise ValueError("full order-book snapshot identity conflicts with target stream")
        self._metrics["snapshots_received"] += 1
        if seed.snapshot_limit > self._max_levels_per_side or len(seed.bids) > self._max_levels_per_side or len(seed.asks) > self._max_levels_per_side:
            return self._fail(state, FullOrderBookFailure.CAPACITY, "REST snapshot exceeds local level capacity")

        bids = {item.price: item for item in seed.bids}
        asks = {item.price: item for item in seed.asks}
        bid_prices = sorted(bids)
        ask_prices = sorted(asks)
        buffered = tuple(state.buffered)
        kept = tuple(
            item
            for item in buffered
            if self._delta_follows_snapshot(item, seed.last_update_id)
        )
        self._metrics["buffered_old_discarded"] += len(buffered) - len(kept)
        last_id = seed.last_update_id
        last_signature: tuple[Any, ...] | None = None
        last_event_time = seed.event_time_ms
        last_received = seed.received_at_ms
        last_source = seed.source

        if kept:
            first = kept[0]
            if not self._bridges_snapshot(first, seed.last_update_id):
                return self._fail(state, FullOrderBookFailure.GAP, "first buffered delta does not bridge REST snapshot")
            failure = self._mutate_book(
                bids,
                asks,
                first,
                bid_prices=bid_prices,
                ask_prices=ask_prices,
            )
            if failure is not None:
                return self._fail(state, failure[0], failure[1])
            last_id = first.final_update_id
            last_signature = first.signature
            last_event_time = first.event_time_ms
            last_received = first.received_at_ms
            last_source = first.source
            for delta in kept[1:]:
                link_error = self._link_error(last_id, delta)
                if link_error is not None:
                    return self._fail(state, FullOrderBookFailure.GAP, link_error)
                failure = self._mutate_book(
                    bids,
                    asks,
                    delta,
                    bid_prices=bid_prices,
                    ask_prices=ask_prices,
                )
                if failure is not None:
                    return self._fail(state, failure[0], failure[1])
                last_id = delta.final_update_id
                last_signature = delta.signature
                last_event_time = delta.event_time_ms
                last_received = delta.received_at_ms
                last_source = delta.source

        state.bids = bids
        state.asks = asks
        state.bid_prices = bid_prices
        state.ask_prices = ask_prices
        state.book_revision = _BookRevision.from_book(
            bids,
            asks,
            bid_prices,
            ask_prices,
        )
        state.buffered.clear()
        state.buffered_updates = 0
        state.last_update_id = last_id
        state.last_delta_signature = last_signature
        state.snapshot_limit = seed.snapshot_limit
        state.event_time_ms = last_event_time
        state.received_at_ms = last_received
        state.source = last_source
        state.revision = 1 if kept else 0
        state.status = FullOrderBookState.LIVE if kept else FullOrderBookState.AWAITING_BRIDGE
        state.failure = None
        state.failure_detail = None
        self._metrics["snapshots_installed"] += 1
        self._metrics["deltas_replayed"] += len(kept)
        snapshot = self._project(normalized, state, depth=None) if kept else None
        return self._result(state, True, FullOrderBookAction.SNAPSHOT_INSTALLED, snapshot=snapshot)

    def snapshot(
        self,
        identity: FullOrderBookIdentity,
        *,
        depth: int | None = None,
    ) -> FullOrderBookSnapshot | None:
        normalized = _normalize_identity(identity)
        state = self._streams.get(normalized)
        if state is None or normalized not in self._active or state.status is not FullOrderBookState.LIVE:
            return None
        if depth is not None:
            depth = _required_int(depth, label="projection depth", minimum=1)
            if depth > self._max_levels_per_side:
                raise ValueError("full order-book projection depth exceeds configured capacity")
        return self._project(normalized, state, depth=depth)

    def diagnostics(self) -> dict[str, Any]:
        return {
            "mode": "full_depth_reconstructed",
            "streams": len(self._streams),
            "active_streams": len(self._active),
            "limits": {
                "streams": self._max_streams,
                "levels_per_side": self._max_levels_per_side,
                "buffered_deltas_per_stream": self._max_buffered_deltas,
                "updates_per_delta": self._max_updates_per_delta,
                "buffered_level_updates_per_stream": self._max_buffered_level_updates,
            },
            "stream_states": [
                {
                    "exchange": identity[0],
                    "market_type": identity[1],
                    "symbol": identity[2],
                    "update_interval_ms": identity[3],
                    "active": identity in self._active,
                    "state": state.status.value,
                    "epoch": state.epoch,
                    "last_update_id": state.last_update_id,
                    "bid_levels": len(state.bids),
                    "ask_levels": len(state.asks),
                    "buffered_deltas": len(state.buffered),
                    "buffered_level_updates": state.buffered_updates,
                    "revision": state.revision,
                    "failure": state.failure.value if state.failure is not None else None,
                    "failure_detail": state.failure_detail,
                }
                for identity, state in self._streams.items()
            ],
            **self._metrics,
        }

    def _buffer_delta(self, state: _StreamState, delta: DepthDelta) -> FullOrderBookApplyResult:
        if state.buffered:
            previous = state.buffered[-1]
            if delta.final_update_id < previous.final_update_id:
                return self._stale_result(state)
            if delta.final_update_id == previous.final_update_id:
                if delta.signature == previous.signature:
                    return self._duplicate_result(state)
                return self._fail(state, FullOrderBookFailure.CONFLICTING_DUPLICATE, "same final update ID has conflicting payload")
            link_error = self._link_error(previous.final_update_id, delta)
            if link_error is not None:
                return self._fail(state, FullOrderBookFailure.GAP, link_error)
        if len(state.buffered) >= self._max_buffered_deltas:
            return self._fail(state, FullOrderBookFailure.CAPACITY, "buffered delta count limit exceeded")
        if state.buffered_updates + delta.level_update_count > self._max_buffered_level_updates:
            return self._fail(state, FullOrderBookFailure.CAPACITY, "buffered level update limit exceeded")
        state.buffered.append(delta)
        state.buffered_updates += delta.level_update_count
        self._metrics["deltas_buffered"] += 1
        return self._result(state, True, FullOrderBookAction.BUFFERED)

    def _apply_bridge(
        self,
        identity: FullOrderBookIdentity,
        state: _StreamState,
        delta: DepthDelta,
    ) -> FullOrderBookApplyResult:
        assert state.last_update_id is not None
        if not self._delta_follows_snapshot(delta, state.last_update_id):
            return self._stale_result(state)
        if not self._bridges_snapshot(delta, state.last_update_id):
            return self._fail(state, FullOrderBookFailure.GAP, "delta does not bridge REST snapshot")
        failure = self._mutate_book(
            state.bids,
            state.asks,
            delta,
            bid_prices=state.bid_prices,
            ask_prices=state.ask_prices,
        )
        if failure is not None:
            return self._fail(state, failure[0], failure[1])
        state.status = FullOrderBookState.LIVE
        state.last_update_id = delta.final_update_id
        state.last_delta_signature = delta.signature
        state.event_time_ms = delta.event_time_ms
        state.received_at_ms = delta.received_at_ms
        state.source = delta.source
        state.revision = 1
        assert state.book_revision is not None
        state.book_revision = state.book_revision.child(
            delta,
            state.bids,
            state.asks,
            state.bid_prices,
            state.ask_prices,
        )
        self._metrics["deltas_applied"] += 1
        return self._result(
            state,
            True,
            FullOrderBookAction.APPLIED,
            snapshot=self._project(identity, state, depth=None),
        )

    def _apply_live(
        self,
        identity: FullOrderBookIdentity,
        state: _StreamState,
        delta: DepthDelta,
    ) -> FullOrderBookApplyResult:
        assert state.last_update_id is not None
        if delta.final_update_id < state.last_update_id:
            return self._stale_result(state)
        if delta.final_update_id == state.last_update_id:
            if delta.signature == state.last_delta_signature:
                return self._duplicate_result(state)
            return self._fail(state, FullOrderBookFailure.CONFLICTING_DUPLICATE, "same final update ID has conflicting payload")
        link_error = self._link_error(state.last_update_id, delta)
        if link_error is not None:
            return self._fail(state, FullOrderBookFailure.GAP, link_error)
        failure = self._mutate_book(
            state.bids,
            state.asks,
            delta,
            bid_prices=state.bid_prices,
            ask_prices=state.ask_prices,
        )
        if failure is not None:
            return self._fail(state, failure[0], failure[1])
        state.last_update_id = delta.final_update_id
        state.last_delta_signature = delta.signature
        state.event_time_ms = delta.event_time_ms
        state.received_at_ms = delta.received_at_ms
        state.source = delta.source
        state.revision += 1
        assert state.book_revision is not None
        state.book_revision = state.book_revision.child(
            delta,
            state.bids,
            state.asks,
            state.bid_prices,
            state.ask_prices,
        )
        self._metrics["deltas_applied"] += 1
        return self._result(
            state,
            True,
            FullOrderBookAction.APPLIED,
            snapshot=self._project(identity, state, depth=None),
        )

    def _mutate_book(
        self,
        bids: dict[float, FullOrderBookLevel],
        asks: dict[float, FullOrderBookLevel],
        delta: DepthDelta,
        *,
        bid_prices: list[float],
        ask_prices: list[float],
    ) -> tuple[FullOrderBookFailure, str] | None:
        self._mutate_side(bids, bid_prices, delta.bids)
        self._mutate_side(asks, ask_prices, delta.asks)
        if len(bids) > self._max_levels_per_side or len(asks) > self._max_levels_per_side:
            return FullOrderBookFailure.CAPACITY, "local book level capacity exceeded"
        if not bids or not asks:
            return FullOrderBookFailure.EMPTY_BOOK, "local book lost one complete side"
        if bid_prices[-1] >= ask_prices[0]:
            return FullOrderBookFailure.CROSSED_BOOK, "local book became crossed or locked"
        return None

    @staticmethod
    def _delta_follows_snapshot(delta: DepthDelta, snapshot_id: int) -> bool:
        if delta.exchange == "binance" and delta.market_type == "spot":
            # Spot's documented bootstrap discards every u <= lastUpdateId.
            return delta.final_update_id > snapshot_id
        return delta.final_update_id >= snapshot_id

    @staticmethod
    def _mutate_side(
        levels: dict[float, FullOrderBookLevel],
        prices: list[float],
        updates: Sequence[DepthLevelUpdate],
    ) -> None:
        for update in updates:
            existing = update.price in levels
            if update.deletes_level:
                if not existing:
                    continue
                levels.pop(update.price)
                index = bisect_left(prices, update.price)
                if index >= len(prices) or prices[index] != update.price:
                    raise RuntimeError("full order-book price index diverged from levels")
                prices.pop(index)
                continue
            if not existing:
                insort(prices, update.price)
            levels[update.price] = FullOrderBookLevel(
                update.price,
                update.quantity,
            )

    @staticmethod
    def _bridges_snapshot(delta: DepthDelta, snapshot_id: int) -> bool:
        target_id = (
            snapshot_id + 1
            if delta.exchange == "binance" and delta.market_type == "spot"
            else snapshot_id
        )
        return delta.first_update_id <= target_id <= delta.final_update_id

    @staticmethod
    def _link_error(previous_id: int, delta: DepthDelta) -> str | None:
        if delta.exchange == "binance" and delta.market_type == "spot":
            if delta.first_update_id > previous_id + 1:
                return "delta U is greater than previous applied u + 1"
            return None
        if delta.previous_final_update_id != previous_id:
            return "delta pu does not equal previous applied u"
        return None

    def _project(
        self,
        identity: FullOrderBookIdentity,
        state: _StreamState,
        *,
        depth: int | None,
    ) -> FullOrderBookSnapshot:
        assert state.last_update_id is not None
        assert state.snapshot_limit is not None
        assert state.book_revision is not None
        bids = _LazyBookSide(state.book_revision, "bids", depth)
        asks = _LazyBookSide(state.book_revision, "asks", depth)
        return FullOrderBookSnapshot(
            exchange=identity[0],
            market_type=identity[1],
            symbol=identity[2],
            update_interval_ms=identity[3],
            epoch=state.epoch,
            last_update_id=state.last_update_id,
            snapshot_limit=state.snapshot_limit,
            bids=bids,
            asks=asks,
            book_bid_levels=len(state.bids),
            book_ask_levels=len(state.asks),
            projection_depth=depth,
            event_time_ms=state.event_time_ms,
            received_at_ms=state.received_at_ms,
            source=state.source,
            revision=state.revision,
            _materialization_token=_TRUSTED_LAZY_SNAPSHOT,
        )

    def _result(
        self,
        state: _StreamState,
        accepted: bool,
        action: FullOrderBookAction,
        *,
        reason: str | None = None,
        failure: FullOrderBookFailure | None = None,
        snapshot: FullOrderBookSnapshot | None = None,
    ) -> FullOrderBookApplyResult:
        return FullOrderBookApplyResult(
            accepted=accepted,
            action=action,
            state=state.status,
            epoch=state.epoch,
            last_update_id=state.last_update_id,
            reason=reason,
            failure=failure,
            snapshot=snapshot,
        )

    def _duplicate_result(self, state: _StreamState) -> FullOrderBookApplyResult:
        self._metrics["deltas_duplicate"] += 1
        return self._result(state, False, FullOrderBookAction.DUPLICATE, reason="duplicate final update ID")

    def _stale_result(self, state: _StreamState) -> FullOrderBookApplyResult:
        self._metrics["deltas_stale"] += 1
        return self._result(state, False, FullOrderBookAction.STALE, reason="delta final update ID is older than local state")

    def _stale_epoch_result(self, state: _StreamState) -> FullOrderBookApplyResult:
        self._metrics["stale_epochs"] += 1
        return self._result(state, False, FullOrderBookAction.STALE_EPOCH, reason="event belongs to a stale synchronization epoch")

    def _fail(
        self,
        state: _StreamState,
        failure: FullOrderBookFailure,
        detail: str,
    ) -> FullOrderBookApplyResult:
        metric = {
            FullOrderBookFailure.GAP: "gaps",
            FullOrderBookFailure.CONFLICTING_DUPLICATE: "conflicting_duplicates",
            FullOrderBookFailure.CROSSED_BOOK: "crossed_books",
            FullOrderBookFailure.EMPTY_BOOK: "empty_books",
            FullOrderBookFailure.CAPACITY: "capacity_failures",
        }[failure]
        self._metrics[metric] += 1
        state.status = FullOrderBookState.RESYNC_REQUIRED
        state.bids.clear()
        state.asks.clear()
        state.bid_prices.clear()
        state.ask_prices.clear()
        state.book_revision = None
        state.buffered.clear()
        state.buffered_updates = 0
        state.last_update_id = None
        state.last_delta_signature = None
        state.snapshot_limit = None
        state.revision = 0
        state.failure = failure
        state.failure_detail = detail
        return self._result(state, False, FullOrderBookAction.RESYNC_REQUIRED, reason=detail, failure=failure)

    def _active_state(
        self,
        identity: FullOrderBookIdentity,
    ) -> tuple[FullOrderBookIdentity, _StreamState]:
        normalized = _normalize_identity(identity)
        state = self._streams.get(normalized)
        if state is None or normalized not in self._active:
            raise FullOrderBookStateError("full order-book stream is not active")
        return normalized, state

    @staticmethod
    def _epoch_matches(state: _StreamState, epoch: int) -> bool:
        return _required_int(epoch, label="epoch", minimum=1) == state.epoch

    def _allocate_epoch(self) -> int:
        self._next_epoch += 1
        return self._next_epoch

    @staticmethod
    def _reset(
        state: _StreamState,
        *,
        epoch: int,
        status: FullOrderBookState,
    ) -> None:
        state.epoch = epoch
        state.status = status
        state.bids.clear()
        state.asks.clear()
        state.bid_prices.clear()
        state.ask_prices.clear()
        state.book_revision = None
        state.buffered.clear()
        state.buffered_updates = 0
        state.last_update_id = None
        state.last_delta_signature = None
        state.snapshot_limit = None
        state.event_time_ms = 0
        state.received_at_ms = 0
        state.source = DataSource.MOCK
        state.revision = 0
        state.failure = None
        state.failure_detail = None

    def _reserve_capacity(self, identity: FullOrderBookIdentity) -> None:
        if identity in self._streams or len(self._streams) < self._max_streams:
            return
        for candidate in tuple(self._streams):
            if candidate in self._active:
                continue
            self._streams.pop(candidate, None)
            self._metrics["streams_evicted"] += 1
            return
        raise FullOrderBookStateError(
            f"full order-book active stream limit reached ({self._max_streams})",
        )


__all__ = [
    "DepthDelta",
    "DepthLevelUpdate",
    "FullOrderBookAction",
    "FullOrderBookApplyResult",
    "FullOrderBookEngine",
    "FullOrderBookError",
    "FullOrderBookFailure",
    "FullOrderBookIdentity",
    "FullOrderBookLevel",
    "FullOrderBookSeed",
    "FullOrderBookSnapshot",
    "FullOrderBookState",
    "FullOrderBookStateError",
]
