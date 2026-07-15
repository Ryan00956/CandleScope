"""Ordered aggregate-trade normalization and one-minute flow aggregation."""

from __future__ import annotations

import math
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any, Literal

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType


BUCKET_INTERVAL_MS = 60_000
StreamIdentity = tuple[str, str, str]
IngestReason = Literal[
    "accepted",
    "duplicate",
    "out_of_order",
    "not_gap_fill",
    "outside_retention",
]


def _required_identity(value: object, *, label: str, case: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"aggregate trade {label} must be a string")
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"aggregate trade {label} cannot be blank")
    return normalized.lower() if case == "lower" else normalized.upper()


def _required_int(value: object, *, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool):
        raise TypeError(f"aggregate trade {label} must be an integer")
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"aggregate trade {label} must be an integer") from exc
    if str(value).strip() != str(number) and not isinstance(value, int):
        try:
            if float(value) != number:  # type: ignore[arg-type]
                raise ValueError
        except (TypeError, ValueError, OverflowError) as exc:
            raise TypeError(f"aggregate trade {label} must be an integer") from exc
    if number < minimum:
        raise ValueError(f"aggregate trade {label} must be >= {minimum}")
    return number


def _positive_float(value: object, *, label: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"aggregate trade {label} must be numeric")
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"aggregate trade {label} must be numeric") from exc
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"aggregate trade {label} must be finite and positive")
    return number


@dataclass(frozen=True, slots=True)
class NormalizedAggTrade:
    """Validated exchange-agnostic aggregate trade suitable for replay."""

    exchange: str
    market_type: str
    symbol: str
    agg_trade_id: int
    price: float
    quantity: float
    trade_time_ms: int
    event_time_ms: int
    received_at_ms: int
    is_buyer_maker: bool
    source: DataSource | str
    first_trade_id: int | None = None
    last_trade_id: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "exchange",
            _required_identity(self.exchange, label="exchange", case="lower"),
        )
        object.__setattr__(
            self,
            "market_type",
            _required_identity(self.market_type, label="market type", case="lower"),
        )
        object.__setattr__(
            self,
            "symbol",
            _required_identity(self.symbol, label="symbol", case="upper"),
        )
        object.__setattr__(
            self,
            "agg_trade_id",
            _required_int(self.agg_trade_id, label="id"),
        )
        object.__setattr__(self, "price", _positive_float(self.price, label="price"))
        object.__setattr__(
            self,
            "quantity",
            _positive_float(self.quantity, label="quantity"),
        )
        for name in ("trade_time_ms", "event_time_ms", "received_at_ms"):
            object.__setattr__(
                self,
                name,
                _required_int(getattr(self, name), label=name),
            )
        if not isinstance(self.is_buyer_maker, bool):
            raise TypeError("aggregate trade is_buyer_maker must be a boolean")
        source = self.source
        if not isinstance(source, DataSource):
            source = DataSource(str(source).strip().lower())
        object.__setattr__(self, "source", source)

        first_id = self.first_trade_id
        last_id = self.last_trade_id
        if first_id is not None:
            first_id = _required_int(first_id, label="first trade id")
            object.__setattr__(self, "first_trade_id", first_id)
        if last_id is not None:
            last_id = _required_int(last_id, label="last trade id")
            object.__setattr__(self, "last_trade_id", last_id)
        if first_id is not None and last_id is not None and first_id > last_id:
            raise ValueError("aggregate trade first trade id cannot exceed last trade id")

    @property
    def stream_identity(self) -> StreamIdentity:
        return self.exchange, self.market_type, self.symbol

    @property
    def quote_quantity(self) -> float:
        return self.price * self.quantity

    @property
    def aggressor_side(self) -> Literal["buy", "sell"]:
        # Binance m=true means the buyer was resting, so the aggressor sold.
        return "sell" if self.is_buyer_maker else "buy"

    @classmethod
    def from_market_event(cls, event: MarketEvent) -> NormalizedAggTrade:
        if event.event_type != StreamType.AGG_TRADE:
            raise ValueError("trade-flow engine only accepts aggTrade MarketEvent values")
        data = event.data
        return cls(
            exchange=event.exchange,
            market_type=event.market_type,
            symbol=event.symbol,
            agg_trade_id=data.get("agg_trade_id", event.sequence),
            price=data.get("price"),
            quantity=data.get("quantity"),
            trade_time_ms=data.get("trade_time_ms", event.event_time_ms),
            event_time_ms=event.event_time_ms,
            received_at_ms=event.received_at_ms,
            is_buyer_maker=data.get("is_buyer_maker"),
            source=event.source,
            first_trade_id=data.get("first_trade_id"),
            last_trade_id=data.get("last_trade_id"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "agg_trade_id": self.agg_trade_id,
            "price": self.price,
            "quantity": self.quantity,
            "quote_quantity": self.quote_quantity,
            "trade_time_ms": self.trade_time_ms,
            "event_time_ms": self.event_time_ms,
            "received_at_ms": self.received_at_ms,
            "is_buyer_maker": self.is_buyer_maker,
            "aggressor_side": self.aggressor_side,
            "source": self.source.value,
            "first_trade_id": self.first_trade_id,
            "last_trade_id": self.last_trade_id,
        }


@dataclass(frozen=True, slots=True)
class TradeFlowGap:
    """One unresolved inclusive aggregate-trade ID range."""

    start_id: int
    end_id: int
    left_trade_time_ms: int
    right_trade_time_ms: int

    @property
    def missing_count(self) -> int:
        return self.end_id - self.start_id + 1

    def affects_bucket(self, bucket_start_ms: int) -> bool:
        first = min(self.left_trade_time_ms, self.right_trade_time_ms)
        last = max(self.left_trade_time_ms, self.right_trade_time_ms)
        return (
            first // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS
            <= bucket_start_ms
            <= last // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS
        )

    def to_dict(self) -> dict[str, int]:
        return {
            "start_id": self.start_id,
            "end_id": self.end_id,
            "missing_count": self.missing_count,
            "left_trade_time_ms": self.left_trade_time_ms,
            "right_trade_time_ms": self.right_trade_time_ms,
        }


@dataclass(frozen=True, slots=True)
class TradeFlowBucket:
    """One minute of aggressor-side trade flow.

    Only per-bucket delta contributions are exposed.  An absolute CVD series
    must be derived later as a prefix sum over a contiguous complete range.
    """

    exchange: str
    market_type: str
    symbol: str
    bucket_start_ms: int
    bucket_end_ms: int
    taker_buy_base: float
    taker_sell_base: float
    taker_buy_quote: float
    taker_sell_quote: float
    volume_delta_base: float
    volume_delta_quote: float
    buy_agg_trade_count: int
    sell_agg_trade_count: int
    agg_trade_count: int
    buy_trade_count: int
    sell_trade_count: int
    trade_count: int
    max_trade_notional: float
    first_agg_trade_id: int
    last_agg_trade_id: int
    is_final: bool
    is_complete: bool
    updated_at_ms: int
    revision: int

    @property
    def stream_identity(self) -> StreamIdentity:
        return self.exchange, self.market_type, self.symbol

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "period": "1m",
            "bucket_start_ms": self.bucket_start_ms,
            "bucket_end_ms": self.bucket_end_ms,
            "taker_buy_base": self.taker_buy_base,
            "taker_sell_base": self.taker_sell_base,
            "taker_buy_quote": self.taker_buy_quote,
            "taker_sell_quote": self.taker_sell_quote,
            "volume_delta_base": self.volume_delta_base,
            "volume_delta_quote": self.volume_delta_quote,
            "buy_agg_trade_count": self.buy_agg_trade_count,
            "sell_agg_trade_count": self.sell_agg_trade_count,
            "agg_trade_count": self.agg_trade_count,
            "buy_trade_count": self.buy_trade_count,
            "sell_trade_count": self.sell_trade_count,
            "trade_count": self.trade_count,
            "max_trade_notional": self.max_trade_notional,
            "first_agg_trade_id": self.first_agg_trade_id,
            "last_agg_trade_id": self.last_agg_trade_id,
            "is_final": self.is_final,
            "is_complete": self.is_complete,
            "updated_at_ms": self.updated_at_ms,
            "revision": self.revision,
        }


@dataclass(frozen=True, slots=True)
class TradeFlowIngestResult:
    accepted: bool
    reason: IngestReason
    trade: NormalizedAggTrade | None = None
    buckets: tuple[TradeFlowBucket, ...] = ()
    detected_gap: TradeFlowGap | None = None
    unresolved_gaps: tuple[TradeFlowGap, ...] = ()
    is_gap_fill: bool = False


@dataclass(slots=True)
class _BucketAccumulator:
    start_ms: int
    buy_base: float = 0.0
    sell_base: float = 0.0
    buy_quote: float = 0.0
    sell_quote: float = 0.0
    buy_agg_count: int = 0
    sell_agg_count: int = 0
    buy_count: int = 0
    sell_count: int = 0
    max_notional: float = 0.0
    first_id: int | None = None
    last_id: int | None = None
    updated_at_ms: int = 0
    revision: int = 0
    is_final: bool = False

    def add(self, trade: NormalizedAggTrade) -> None:
        quote = trade.quote_quantity
        underlying_count = 1
        if trade.first_trade_id is not None and trade.last_trade_id is not None:
            underlying_count = trade.last_trade_id - trade.first_trade_id + 1
        if trade.is_buyer_maker:
            self.sell_base += trade.quantity
            self.sell_quote += quote
            self.sell_agg_count += 1
            self.sell_count += underlying_count
        else:
            self.buy_base += trade.quantity
            self.buy_quote += quote
            self.buy_agg_count += 1
            self.buy_count += underlying_count
        self.max_notional = max(self.max_notional, quote)
        self.first_id = (
            trade.agg_trade_id if self.first_id is None else min(self.first_id, trade.agg_trade_id)
        )
        self.last_id = (
            trade.agg_trade_id if self.last_id is None else max(self.last_id, trade.agg_trade_id)
        )
        self.updated_at_ms = max(self.updated_at_ms, trade.received_at_ms)


@dataclass(slots=True)
class _StreamState:
    raw_trades: deque[NormalizedAggTrade]
    buckets: OrderedDict[int, _BucketAccumulator] = field(default_factory=OrderedDict)
    # Recent IDs mirror the bounded raw ring.  Older live duplicates are
    # rejected by the monotonic high-water mark, while an already-filled gap
    # ID is no longer part of an open gap.  Keeping every ID for every retained
    # minute would make memory grow with trade rate rather than configured
    # bounds.
    seen_ids: OrderedDict[int, None] = field(default_factory=OrderedDict)
    gaps: list[TradeFlowGap] = field(default_factory=list)
    # Once exact gap tracking is deliberately collapsed, affected retained
    # buckets must never become complete merely because the precise ranges are
    # gone.  This set is bounded by the retained bucket window.
    permanently_incomplete_buckets: set[int] = field(default_factory=set)
    highest_id: int | None = None
    highest_trade_time_ms: int | None = None
    active_bucket_start_ms: int | None = None
    bootstrap_incomplete_buckets: set[int] = field(default_factory=set)
    # The optional initial-minute prefix can be larger than the raw ring, so it
    # has its own temporary exact dedupe set until bootstrap is confirmed.
    bootstrap_seen_ids: set[int] = field(default_factory=set)


class TradeFlowEngine:
    """Bounded multi-stream aggTrade reducer with explicit gap-fill semantics."""

    def __init__(
        self,
        *,
        raw_ring_size: int = 20_000,
        max_buckets_per_stream: int = 1440,
        max_gaps_per_stream: int = 256,
        max_streams: int = 64,
        initial_bucket_complete: bool = False,
    ) -> None:
        self._raw_ring_size = max(1, int(raw_ring_size))
        self._max_buckets_per_stream = max(2, int(max_buckets_per_stream))
        self._max_gaps_per_stream = max(1, int(max_gaps_per_stream))
        self._max_streams = max(1, int(max_streams))
        self._initial_bucket_complete = bool(initial_bucket_complete)
        self._streams: OrderedDict[StreamIdentity, _StreamState] = OrderedDict()
        self._active_streams: set[StreamIdentity] = set()
        self._metrics = {
            "accepted": 0,
            "duplicates_rejected": 0,
            "out_of_order_rejected": 0,
            "not_gap_fill_rejected": 0,
            "outside_retention_rejected": 0,
            "gaps_detected": 0,
            "gaps_resolved": 0,
            "gap_overflow_events": 0,
            "precise_gaps_collapsed": 0,
            "gaps_suppressed_permanent": 0,
            "gaps_evicted_before_retention": 0,
            "permanent_incomplete_buckets_marked": 0,
            "gap_trades_filled": 0,
            "bootstrap_trades_filled": 0,
            "raw_ring_evicted": 0,
            "buckets_evicted": 0,
            "streams_evicted": 0,
            "bootstrap_buckets_confirmed": 0,
        }

    def activate_stream(self, identity: StreamIdentity) -> bool:
        """Reserve one stream state so LRU pressure cannot evict a live feed."""

        normalized = self._normalize_identity(identity)
        if normalized in self._active_streams:
            return False
        self._state_for(normalized)
        self._active_streams.add(normalized)
        return True

    def deactivate_stream(self, identity: StreamIdentity) -> bool:
        """Release an active reservation while retaining its bounded history."""

        normalized = self._normalize_identity(identity)
        if normalized not in self._active_streams:
            return False
        self._active_streams.remove(normalized)
        return True

    def ingest(self, event: MarketEvent | NormalizedAggTrade) -> TradeFlowIngestResult:
        """Accept an in-order live trade; reject duplicates and regressions."""

        return self._ingest(self._normalize(event), gap_fill=False)

    def ingest_gap_fill(
        self,
        event: MarketEvent | NormalizedAggTrade,
    ) -> TradeFlowIngestResult:
        """Insert one older trade only when its ID belongs to an open gap."""

        return self._ingest(self._normalize(event), gap_fill=True)

    def ingest_bootstrap(
        self,
        event: MarketEvent | NormalizedAggTrade,
    ) -> TradeFlowIngestResult:
        """Insert an explicitly fetched prefix for the initial partial minute.

        This is the only path, besides a known open gap, that accepts an older
        ID.  The bucket remains incomplete until the caller separately invokes
        :meth:`confirm_bootstrap_complete` after validating the fetched range.
        """

        trade = self._normalize(event)
        identity = trade.stream_identity
        state = self._streams.get(identity)
        if state is None or state.highest_id is None or trade.agg_trade_id > state.highest_id:
            return self._ingest(trade, gap_fill=False)
        if (
            trade.agg_trade_id == state.highest_id
            or trade.agg_trade_id in state.seen_ids
            or trade.agg_trade_id in state.bootstrap_seen_ids
        ):
            self._metrics["duplicates_rejected"] += 1
            return self._rejected(state, "duplicate")
        gap_index = self._gap_index(state, trade.agg_trade_id)
        if gap_index is not None:
            return self._accept_gap_fill(identity, state, trade, gap_index)

        bucket_start = trade.trade_time_ms // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS
        if bucket_start not in state.bootstrap_incomplete_buckets:
            self._metrics["not_gap_fill_rejected"] += 1
            return self._rejected(state, "not_gap_fill")
        if self._outside_retention(state, trade.trade_time_ms):
            self._metrics["outside_retention_rejected"] += 1
            return self._rejected(state, "outside_retention")

        self._add_trade(state, trade)
        state.bootstrap_seen_ids.add(trade.agg_trade_id)
        changed = {bucket_start}
        self._touch_buckets(state, changed)
        self._metrics["accepted"] += 1
        self._metrics["bootstrap_trades_filled"] += 1
        return TradeFlowIngestResult(
            accepted=True,
            reason="accepted",
            trade=trade,
            buckets=self._changed_snapshots(identity, state, changed),
            unresolved_gaps=tuple(state.gaps),
        )

    def raw_snapshot(
        self,
        identity: StreamIdentity,
        *,
        ordered: bool = True,
    ) -> tuple[NormalizedAggTrade, ...]:
        state = self._streams.get(self._normalize_identity(identity))
        if state is None:
            return ()
        records = tuple(state.raw_trades)
        if ordered:
            records = tuple(sorted(records, key=lambda item: item.agg_trade_id))
        return records

    def bucket_snapshot(self, identity: StreamIdentity) -> tuple[TradeFlowBucket, ...]:
        normalized = self._normalize_identity(identity)
        state = self._streams.get(normalized)
        if state is None:
            return ()
        return tuple(
            self._snapshot_bucket(normalized, state, accumulator)
            for accumulator in state.buckets.values()
        )

    def gap_snapshot(self, identity: StreamIdentity) -> tuple[TradeFlowGap, ...]:
        state = self._streams.get(self._normalize_identity(identity))
        return () if state is None else tuple(state.gaps)

    def continuity_degraded(self, identity: StreamIdentity) -> bool:
        """Return whether retained raw history has an unresolved/collapsed gap."""

        state = self._streams.get(self._normalize_identity(identity))
        return bool(
            state is not None
            and (state.gaps or state.permanently_incomplete_buckets)
        )

    def confirm_bootstrap_complete(
        self,
        identity: StreamIdentity,
        *,
        bucket_start_ms: int | None = None,
    ) -> tuple[TradeFlowBucket, ...]:
        """Confirm that retained history covers the initial partial minute.

        Live attachment normally starts midway through a minute, so the first
        bucket fails closed as incomplete.  A history/bootstrap coordinator
        calls this method only after it has supplied the missing prefix.
        """

        normalized = self._normalize_identity(identity)
        state = self._streams.get(normalized)
        if state is None:
            return ()
        if bucket_start_ms is None:
            confirmed = set(state.bootstrap_incomplete_buckets)
        else:
            canonical_start = (
                _required_int(bucket_start_ms, label="bucket start")
                // BUCKET_INTERVAL_MS
                * BUCKET_INTERVAL_MS
            )
            confirmed = {canonical_start} & state.bootstrap_incomplete_buckets
        if not confirmed:
            return ()
        state.bootstrap_incomplete_buckets.difference_update(confirmed)
        if not state.bootstrap_incomplete_buckets:
            state.bootstrap_seen_ids.clear()
        self._touch_buckets(state, confirmed)
        self._metrics["bootstrap_buckets_confirmed"] += len(confirmed)
        return self._changed_snapshots(normalized, state, confirmed)

    def diagnostics(self) -> dict[str, Any]:
        unresolved = sum(len(state.gaps) for state in self._streams.values())
        missing = sum(
            gap.missing_count
            for state in self._streams.values()
            for gap in state.gaps
        )
        return {
            "streams": len(self._streams),
            "active_streams": len(self._active_streams),
            "raw_trades": sum(len(state.raw_trades) for state in self._streams.values()),
            "tracked_recent_ids": sum(
                len(state.seen_ids) for state in self._streams.values()
            ),
            "bootstrap_seen_ids": sum(
                len(state.bootstrap_seen_ids) for state in self._streams.values()
            ),
            "buckets": sum(len(state.buckets) for state in self._streams.values()),
            "unresolved_gaps": unresolved,
            "missing_trade_ids": missing,
            "permanently_incomplete_buckets": sum(
                len(state.permanently_incomplete_buckets)
                for state in self._streams.values()
            ),
            "raw_ring_size_per_stream": self._raw_ring_size,
            "max_buckets_per_stream": self._max_buckets_per_stream,
            "max_gaps_per_stream": self._max_gaps_per_stream,
            "max_streams": self._max_streams,
            **self._metrics,
        }

    def _ingest(
        self,
        trade: NormalizedAggTrade,
        *,
        gap_fill: bool,
    ) -> TradeFlowIngestResult:
        identity = trade.stream_identity
        state = self._state_for(identity)
        if trade.agg_trade_id == state.highest_id or trade.agg_trade_id in state.seen_ids:
            self._metrics["duplicates_rejected"] += 1
            return self._rejected(state, "duplicate")

        is_older = state.highest_id is not None and trade.agg_trade_id < state.highest_id
        if is_older:
            gap_index = self._gap_index(state, trade.agg_trade_id)
            if not gap_fill:
                self._metrics["out_of_order_rejected"] += 1
                return self._rejected(state, "out_of_order")
            if gap_index is None:
                self._metrics["not_gap_fill_rejected"] += 1
                return self._rejected(state, "not_gap_fill")
            if self._outside_retention(state, trade.trade_time_ms):
                self._metrics["outside_retention_rejected"] += 1
                return self._rejected(state, "outside_retention")
            return self._accept_gap_fill(identity, state, trade, gap_index)

        if gap_fill and state.highest_id is not None:
            self._metrics["not_gap_fill_rejected"] += 1
            return self._rejected(state, "not_gap_fill")

        if (
            state.highest_trade_time_ms is not None
            and trade.trade_time_ms < state.highest_trade_time_ms
        ):
            self._metrics["out_of_order_rejected"] += 1
            return self._rejected(state, "out_of_order")

        detected_gap = None
        if state.highest_id is not None and trade.agg_trade_id > state.highest_id + 1:
            detected_gap = TradeFlowGap(
                start_id=state.highest_id + 1,
                end_id=trade.agg_trade_id - 1,
                left_trade_time_ms=state.highest_trade_time_ms or trade.trade_time_ms,
                right_trade_time_ms=trade.trade_time_ms,
            )
            self._metrics["gaps_detected"] += 1

        current_bucket_start = trade.trade_time_ms // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS
        changed = {current_bucket_start}
        previous_active = state.active_bucket_start_ms
        first_trade = state.highest_id is None
        if detected_gap is not None:
            changed.update(self._affected_existing_buckets(state, detected_gap))
            changed.add(current_bucket_start)
            self._track_live_gap(
                state,
                detected_gap,
                current_bucket_start=current_bucket_start,
            )
        self._add_trade(state, trade)
        state.highest_id = trade.agg_trade_id
        state.highest_trade_time_ms = trade.trade_time_ms
        state.active_bucket_start_ms = current_bucket_start
        if first_trade and not self._initial_bucket_complete:
            state.bootstrap_incomplete_buckets.add(state.active_bucket_start_ms)
            state.bootstrap_seen_ids.add(trade.agg_trade_id)
        if previous_active is not None and previous_active != state.active_bucket_start_ms:
            changed.add(previous_active)
            for start, accumulator in state.buckets.items():
                if start < state.active_bucket_start_ms and not accumulator.is_final:
                    accumulator.is_final = True
                    changed.add(start)
        self._touch_buckets(state, changed)
        self._evict_buckets(state)
        self._metrics["accepted"] += 1
        return TradeFlowIngestResult(
            accepted=True,
            reason="accepted",
            trade=trade,
            buckets=self._changed_snapshots(identity, state, changed),
            detected_gap=detected_gap,
            unresolved_gaps=tuple(state.gaps),
        )

    def _accept_gap_fill(
        self,
        identity: StreamIdentity,
        state: _StreamState,
        trade: NormalizedAggTrade,
        gap_index: int,
    ) -> TradeFlowIngestResult:
        gap = state.gaps.pop(gap_index)
        first_time = min(gap.left_trade_time_ms, gap.right_trade_time_ms)
        last_time = max(gap.left_trade_time_ms, gap.right_trade_time_ms)
        if not first_time <= trade.trade_time_ms <= last_time:
            state.gaps.insert(gap_index, gap)
            self._metrics["out_of_order_rejected"] += 1
            return self._rejected(state, "out_of_order")
        changed = self._affected_existing_buckets(state, gap)
        fragments: list[TradeFlowGap] = []
        if gap.start_id <= trade.agg_trade_id - 1:
            fragments.append(
                TradeFlowGap(
                    start_id=gap.start_id,
                    end_id=trade.agg_trade_id - 1,
                    left_trade_time_ms=gap.left_trade_time_ms,
                    right_trade_time_ms=trade.trade_time_ms,
                ),
            )
        if trade.agg_trade_id + 1 <= gap.end_id:
            fragments.append(
                TradeFlowGap(
                    start_id=trade.agg_trade_id + 1,
                    end_id=gap.end_id,
                    left_trade_time_ms=trade.trade_time_ms,
                    right_trade_time_ms=gap.right_trade_time_ms,
                ),
            )
        if len(state.gaps) + len(fragments) > self._max_gaps_per_stream:
            self._collapse_precise_gaps(state, fragments)
            changed.update(state.permanently_incomplete_buckets)
        else:
            state.gaps.extend(fragments)
            state.gaps.sort(key=lambda item: item.start_id)
        if not fragments:
            self._metrics["gaps_resolved"] += 1

        bucket_start = trade.trade_time_ms // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS
        changed.add(bucket_start)
        self._add_trade(state, trade)
        self._touch_buckets(state, changed)
        self._evict_buckets(state)
        self._metrics["accepted"] += 1
        self._metrics["gap_trades_filled"] += 1
        return TradeFlowIngestResult(
            accepted=True,
            reason="accepted",
            trade=trade,
            buckets=self._changed_snapshots(identity, state, changed),
            unresolved_gaps=tuple(state.gaps),
            is_gap_fill=True,
        )

    def _add_trade(self, state: _StreamState, trade: NormalizedAggTrade) -> None:
        if len(state.raw_trades) >= self._raw_ring_size:
            self._metrics["raw_ring_evicted"] += 1
        state.raw_trades.append(trade)
        bucket_start = trade.trade_time_ms // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS
        accumulator = state.buckets.get(bucket_start)
        if accumulator is None:
            accumulator = _BucketAccumulator(
                start_ms=bucket_start,
                is_final=(
                    state.active_bucket_start_ms is not None
                    and bucket_start < state.active_bucket_start_ms
                ),
            )
            state.buckets[bucket_start] = accumulator
            state.buckets = OrderedDict(sorted(state.buckets.items()))
        accumulator.add(trade)
        state.seen_ids[trade.agg_trade_id] = None
        while len(state.seen_ids) > self._raw_ring_size:
            state.seen_ids.popitem(last=False)

    def _snapshot_bucket(
        self,
        identity: StreamIdentity,
        state: _StreamState,
        accumulator: _BucketAccumulator,
    ) -> TradeFlowBucket:
        exchange, market_type, symbol = identity
        assert accumulator.first_id is not None
        assert accumulator.last_id is not None
        return TradeFlowBucket(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            bucket_start_ms=accumulator.start_ms,
            bucket_end_ms=accumulator.start_ms + BUCKET_INTERVAL_MS,
            taker_buy_base=round(accumulator.buy_base, 12),
            taker_sell_base=round(accumulator.sell_base, 12),
            taker_buy_quote=round(accumulator.buy_quote, 12),
            taker_sell_quote=round(accumulator.sell_quote, 12),
            volume_delta_base=round(accumulator.buy_base - accumulator.sell_base, 12),
            volume_delta_quote=round(accumulator.buy_quote - accumulator.sell_quote, 12),
            buy_agg_trade_count=accumulator.buy_agg_count,
            sell_agg_trade_count=accumulator.sell_agg_count,
            agg_trade_count=accumulator.buy_agg_count + accumulator.sell_agg_count,
            buy_trade_count=accumulator.buy_count,
            sell_trade_count=accumulator.sell_count,
            trade_count=accumulator.buy_count + accumulator.sell_count,
            max_trade_notional=round(accumulator.max_notional, 12),
            first_agg_trade_id=accumulator.first_id,
            last_agg_trade_id=accumulator.last_id,
            is_final=accumulator.is_final,
            is_complete=(
                accumulator.start_ms not in state.bootstrap_incomplete_buckets
                and accumulator.start_ms
                not in state.permanently_incomplete_buckets
                and not any(
                    gap.affects_bucket(accumulator.start_ms) for gap in state.gaps
                )
            ),
            updated_at_ms=accumulator.updated_at_ms,
            revision=accumulator.revision,
        )

    def _changed_snapshots(
        self,
        identity: StreamIdentity,
        state: _StreamState,
        changed: set[int],
    ) -> tuple[TradeFlowBucket, ...]:
        return tuple(
            self._snapshot_bucket(identity, state, state.buckets[start])
            for start in sorted(changed)
            if start in state.buckets
        )

    def _state_for(self, identity: StreamIdentity) -> _StreamState:
        state = self._streams.get(identity)
        if state is not None:
            self._streams.move_to_end(identity)
            return state
        if len(self._streams) >= self._max_streams:
            evictable = next(
                (
                    candidate
                    for candidate in self._streams
                    if candidate not in self._active_streams
                ),
                None,
            )
            if evictable is None:
                raise RuntimeError(
                    "trade-flow engine stream limit reached; all retained "
                    "states are active",
                )
            self._streams.pop(evictable)
            self._metrics["streams_evicted"] += 1
        state = _StreamState(raw_trades=deque(maxlen=self._raw_ring_size))
        self._streams[identity] = state
        return state

    def _evict_buckets(self, state: _StreamState) -> None:
        while len(state.buckets) > self._max_buckets_per_stream:
            start, _accumulator = state.buckets.popitem(last=False)
            state.permanently_incomplete_buckets.discard(start)
            if start in state.bootstrap_incomplete_buckets:
                state.bootstrap_incomplete_buckets.discard(start)
                state.bootstrap_seen_ids.clear()
            self._metrics["buckets_evicted"] += 1
        if state.buckets and state.gaps:
            oldest_retained_start = next(iter(state.buckets))
            retained_gaps = [
                gap
                for gap in state.gaps
                if max(gap.left_trade_time_ms, gap.right_trade_time_ms)
                // BUCKET_INTERVAL_MS
                * BUCKET_INTERVAL_MS
                >= oldest_retained_start
            ]
            removed = len(state.gaps) - len(retained_gaps)
            if removed:
                state.gaps = retained_gaps
                self._metrics["gaps_evicted_before_retention"] += removed

    def _track_live_gap(
        self,
        state: _StreamState,
        gap: TradeFlowGap,
        *,
        current_bucket_start: int,
    ) -> None:
        affected = self._affected_existing_buckets(state, gap)
        affected.add(current_bucket_start)
        if affected & state.permanently_incomplete_buckets:
            newly_marked = affected - state.permanently_incomplete_buckets
            state.permanently_incomplete_buckets.update(affected)
            self._metrics["permanent_incomplete_buckets_marked"] += len(newly_marked)
            self._metrics["gaps_suppressed_permanent"] += 1
            return
        if len(state.gaps) >= self._max_gaps_per_stream:
            self._collapse_precise_gaps(state, [gap], extra_starts=affected)
            return
        state.gaps.append(gap)

    def _collapse_precise_gaps(
        self,
        state: _StreamState,
        additional: list[TradeFlowGap],
        *,
        extra_starts: set[int] | None = None,
    ) -> None:
        precise = [*state.gaps, *additional]
        affected = set(extra_starts or ())
        for gap in precise:
            affected.update(self._affected_existing_buckets(state, gap))
        newly_marked = affected - state.permanently_incomplete_buckets
        state.permanently_incomplete_buckets.update(affected)
        state.gaps.clear()
        self._metrics["gap_overflow_events"] += 1
        self._metrics["precise_gaps_collapsed"] += len(precise)
        self._metrics["permanent_incomplete_buckets_marked"] += len(newly_marked)

    @staticmethod
    def _touch_buckets(state: _StreamState, starts: set[int]) -> None:
        for start in starts:
            accumulator = state.buckets.get(start)
            if accumulator is not None:
                accumulator.revision += 1

    @staticmethod
    def _gap_index(state: _StreamState, trade_id: int) -> int | None:
        for index, gap in enumerate(state.gaps):
            if gap.start_id <= trade_id <= gap.end_id:
                return index
        return None

    @staticmethod
    def _affected_existing_buckets(state: _StreamState, gap: TradeFlowGap) -> set[int]:
        return {
            start
            for start in state.buckets
            if gap.affects_bucket(start)
        }

    @staticmethod
    def _outside_retention(state: _StreamState, trade_time_ms: int) -> bool:
        if not state.buckets:
            return False
        earliest = next(iter(state.buckets))
        return trade_time_ms // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS < earliest

    @staticmethod
    def _normalize(event: MarketEvent | NormalizedAggTrade) -> NormalizedAggTrade:
        if isinstance(event, NormalizedAggTrade):
            return event
        if isinstance(event, MarketEvent):
            return NormalizedAggTrade.from_market_event(event)
        raise TypeError("trade-flow engine requires MarketEvent or NormalizedAggTrade")

    @staticmethod
    def _normalize_identity(identity: StreamIdentity) -> StreamIdentity:
        if not isinstance(identity, tuple) or len(identity) != 3:
            raise TypeError("trade-flow identity must be (exchange, market_type, symbol)")
        exchange, market_type, symbol = identity
        return (
            _required_identity(exchange, label="exchange", case="lower"),
            _required_identity(market_type, label="market type", case="lower"),
            _required_identity(symbol, label="symbol", case="upper"),
        )

    @staticmethod
    def _rejected(state: _StreamState, reason: IngestReason) -> TradeFlowIngestResult:
        return TradeFlowIngestResult(
            accepted=False,
            reason=reason,
            unresolved_gaps=tuple(state.gaps),
        )
