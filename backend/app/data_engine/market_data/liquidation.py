"""Normalized liquidation events and bounded one-minute rollups.

Binance's public ``forceOrder`` feed is a sampled, best-effort stream.  It has
neither a stable sequence nor a public history endpoint, so this module only
deduplicates exact payload fingerprints retained in memory.  It deliberately
does not claim exchange-level continuity or synthesize zero rows for minutes
without observed events.
"""

from __future__ import annotations

import hashlib
import heapq
import itertools
import json
import math
from collections import OrderedDict, deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from app.data_engine.ingestion.models import DataSource, MarketEvent


BUCKET_INTERVAL_MS = 60_000
SOURCE_QUALITY = "sampled_best_effort"

StreamIdentity = tuple[str, str, str]
PositionSide = Literal["long", "short"]
IngestReason = Literal["accepted", "duplicate"]


def _required_text(value: object, *, label: str, case: str | None = None) -> str:
    if not isinstance(value, str):
        raise TypeError(f"liquidation {label} must be a string")
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"liquidation {label} cannot be blank")
    if case == "lower":
        return normalized.lower()
    if case == "upper":
        return normalized.upper()
    return normalized


def _optional_text(
    value: object,
    *,
    label: str,
    case: str | None = None,
) -> str | None:
    if value is None:
        return None
    return _required_text(value, label=label, case=case)


def _non_negative_int(value: object, *, label: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"liquidation {label} must be an integer")
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"liquidation {label} must be an integer") from exc
    if number < 0:
        raise ValueError(f"liquidation {label} must be non-negative")
    try:
        if Decimal(str(value)) != Decimal(number):
            raise ValueError
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise TypeError(f"liquidation {label} must be an integer") from exc
    return number


def _non_negative_float(value: object, *, label: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"liquidation {label} must be numeric")
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"liquidation {label} must be numeric") from exc
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"liquidation {label} must be finite and non-negative")
    return number


def _decimal_text(value: float) -> str:
    """Return a stable non-exponent payload representation for fingerprints."""

    number = Decimal(str(value))
    if number == 0:
        return "0"
    normalized = format(number.normalize(), "f")
    return normalized.rstrip("0").rstrip(".") if "." in normalized else normalized


def _finite_decimal_product(left: float, right: float) -> tuple[Decimal, float]:
    """Multiply using decimal inputs and guarantee JSON-safe float output."""

    product = Decimal(str(left)) * Decimal(str(right))
    try:
        serialized = float(product)
    except (OverflowError, ValueError) as exc:
        raise ValueError("liquidation executed_notional must serialize finitely") from exc
    if not product.is_finite() or not math.isfinite(serialized):
        raise ValueError("liquidation executed_notional must serialize finitely")
    return product, serialized


@dataclass(frozen=True, slots=True)
class NormalizedLiquidation:
    """Validated contract-market liquidation snapshot suitable for fanout and rollup."""

    exchange: str
    market_type: str
    symbol: str
    order_side: str
    order_type: str
    time_in_force: str
    original_quantity: float
    order_price: float
    average_price: float
    order_status: str
    last_filled_quantity: float
    filled_quantity: float
    trade_time_ms: int
    event_time_ms: int
    received_at_ms: int
    source: DataSource | str
    pair_symbol: str | None = None
    symbol_type: str | None = None
    _executed_notional_decimal: Decimal = field(
        init=False,
        repr=False,
        compare=False,
    )
    _executed_notional: float = field(init=False, repr=False, compare=False)
    _fingerprint: str = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "exchange",
            _required_text(self.exchange, label="exchange", case="lower"),
        )
        market_type = _required_text(
            self.market_type,
            label="market type",
            case="lower",
        )
        if not _is_contract_market_type(market_type):
            raise ValueError(
                "liquidation events require a contract market type; "
                "market_type='futures', 'future', or 'swap'"
            )
        object.__setattr__(self, "market_type", market_type)
        object.__setattr__(
            self,
            "symbol",
            _required_text(self.symbol, label="symbol", case="upper"),
        )

        order_side = _required_text(
            self.order_side,
            label="order side",
            case="upper",
        )
        if order_side not in {"BUY", "SELL"}:
            raise ValueError("liquidation order side must be BUY or SELL")
        object.__setattr__(self, "order_side", order_side)
        for name, label in (
            ("order_type", "order type"),
            ("time_in_force", "time in force"),
            ("order_status", "order status"),
        ):
            object.__setattr__(
                self,
                name,
                _required_text(getattr(self, name), label=label, case="upper"),
            )

        for name, label in (
            ("original_quantity", "original quantity"),
            ("order_price", "order price"),
            ("average_price", "average price"),
            ("last_filled_quantity", "last filled quantity"),
            ("filled_quantity", "filled quantity"),
        ):
            object.__setattr__(
                self,
                name,
                _non_negative_float(getattr(self, name), label=label),
            )
        for name, label in (
            ("trade_time_ms", "trade time"),
            ("event_time_ms", "event time"),
            ("received_at_ms", "received at"),
        ):
            object.__setattr__(
                self,
                name,
                _non_negative_int(getattr(self, name), label=label),
            )

        source = self.source
        if not isinstance(source, DataSource):
            try:
                source = DataSource(
                    _required_text(source, label="source", case="lower"),
                )
            except ValueError as exc:
                raise ValueError("liquidation source is unsupported") from exc
        object.__setattr__(self, "source", source)
        object.__setattr__(
            self,
            "pair_symbol",
            _optional_text(self.pair_symbol, label="pair symbol", case="upper"),
        )
        object.__setattr__(
            self,
            "symbol_type",
            _optional_text(self.symbol_type, label="symbol type", case="upper"),
        )

        decimal_notional, notional = _finite_decimal_product(
            self.average_price,
            self.filled_quantity,
        )
        object.__setattr__(self, "_executed_notional_decimal", decimal_notional)
        object.__setattr__(self, "_executed_notional", notional)
        object.__setattr__(self, "_fingerprint", self._build_fingerprint())

    @property
    def stream_identity(self) -> StreamIdentity:
        return self.exchange, self.market_type, self.symbol

    @property
    def position_side(self) -> PositionSide:
        # A forced SELL closes a long; a forced BUY closes a short.
        return "long" if self.order_side == "SELL" else "short"

    @property
    def executed_notional(self) -> float:
        return self._executed_notional

    @property
    def fingerprint(self) -> str:
        return self._fingerprint

    @property
    def source_quality(self) -> str:
        return SOURCE_QUALITY

    @classmethod
    def from_market_event(cls, event: MarketEvent) -> NormalizedLiquidation:
        event_type = getattr(event.event_type, "value", event.event_type)
        if event_type not in {"forceOrder", "liquidation"}:
            raise ValueError(
                "liquidation engine only accepts forceOrder MarketEvent values",
            )
        data = event.data
        if not isinstance(data, dict):
            raise TypeError("liquidation MarketEvent data must be an object")
        normalized = cls(
            exchange=event.exchange,
            market_type=event.market_type,
            symbol=event.symbol,
            order_side=data.get("order_side", data.get("side")),
            order_type=data.get("order_type"),
            time_in_force=data.get("time_in_force"),
            original_quantity=data.get(
                "original_quantity",
                data.get("quantity"),
            ),
            order_price=data.get("order_price", data.get("price")),
            average_price=data.get("average_price"),
            order_status=data.get("order_status", data.get("status")),
            last_filled_quantity=data.get("last_filled_quantity"),
            filled_quantity=data.get(
                "filled_quantity",
                data.get("accumulated_filled_quantity"),
            ),
            trade_time_ms=data.get("trade_time_ms", event.event_time_ms),
            event_time_ms=event.event_time_ms,
            received_at_ms=event.received_at_ms,
            source=event.source,
            pair_symbol=data.get("pair_symbol"),
            symbol_type=data.get("symbol_type"),
        )
        projected_side = data.get("position_side")
        if projected_side is not None and (
            str(projected_side).strip().lower() != normalized.position_side
        ):
            raise ValueError(
                "liquidation position_side conflicts with derived order side",
            )
        return normalized

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "pair_symbol": self.pair_symbol,
            "symbol_type": self.symbol_type,
            "order_side": self.order_side,
            "position_side": self.position_side,
            "order_type": self.order_type,
            "time_in_force": self.time_in_force,
            "original_quantity": self.original_quantity,
            "order_price": self.order_price,
            "average_price": self.average_price,
            "order_status": self.order_status,
            "last_filled_quantity": self.last_filled_quantity,
            "filled_quantity": self.filled_quantity,
            "executed_notional": self.executed_notional,
            "trade_time_ms": self.trade_time_ms,
            "event_time_ms": self.event_time_ms,
            "received_at_ms": self.received_at_ms,
            "source": self.source.value,
            "source_quality": self.source_quality,
            "source_exhaustive": False,
            "fingerprint": self.fingerprint,
        }

    def _build_fingerprint(self) -> str:
        # received_at/source are transport metadata, not exchange payload
        # identity.  E/T and every retained identifying forceOrder field are
        # included so an exact reconnect replay can be rejected consistently.
        payload = (
            self.exchange,
            self.market_type,
            self.symbol,
            self.pair_symbol,
            self.symbol_type,
            self.order_side,
            self.order_type,
            self.time_in_force,
            _decimal_text(self.original_quantity),
            _decimal_text(self.order_price),
            _decimal_text(self.average_price),
            self.order_status,
            _decimal_text(self.last_filled_quantity),
            _decimal_text(self.filled_quantity),
            self.trade_time_ms,
            self.event_time_ms,
        )
        canonical = json.dumps(
            payload,
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()


@dataclass(frozen=True, slots=True)
class LiquidationRollup:
    """One observed minute/direction liquidation aggregate."""

    exchange: str
    market_type: str
    symbol: str
    position_side: PositionSide
    bucket_start_ms: int
    bucket_end_ms: int
    filled_quantity: float
    filled_notional: float
    event_count: int
    max_event_notional: float
    first_event_time_ms: int
    last_event_time_ms: int
    is_final: bool
    revision: int
    updated_at_ms: int

    @property
    def stream_identity(self) -> StreamIdentity:
        return self.exchange, self.market_type, self.symbol

    @property
    def bucket_open_ms(self) -> int:
        return self.bucket_start_ms

    @property
    def bucket_close_ms(self) -> int:
        return self.bucket_end_ms

    @property
    def source_quality(self) -> str:
        return SOURCE_QUALITY

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "period": "1m",
            "position_side": self.position_side,
            "bucket_start_ms": self.bucket_start_ms,
            "bucket_end_ms": self.bucket_end_ms,
            "filled_quantity": self.filled_quantity,
            "filled_notional": self.filled_notional,
            "event_count": self.event_count,
            "max_event_notional": self.max_event_notional,
            "first_event_time_ms": self.first_event_time_ms,
            "last_event_time_ms": self.last_event_time_ms,
            "is_final": self.is_final,
            "revision": self.revision,
            "updated_at_ms": self.updated_at_ms,
            "source_quality": self.source_quality,
            "source_exhaustive": False,
        }


@dataclass(frozen=True, slots=True)
class LiquidationIngestResult:
    accepted: bool
    reason: IngestReason
    event: NormalizedLiquidation
    rollups: tuple[LiquidationRollup, ...] = ()

    @property
    def changed_rollups(self) -> tuple[LiquidationRollup, ...]:
        return self.rollups


@dataclass(slots=True)
class _BucketAccumulator:
    start_ms: int
    position_side: PositionSide
    filled_quantity: Decimal = Decimal(0)
    filled_notional: Decimal = Decimal(0)
    event_count: int = 0
    max_event_notional: Decimal = Decimal(0)
    first_event_time_ms: int | None = None
    last_event_time_ms: int | None = None
    updated_at_ms: int = 0
    revision: int = 0
    is_final: bool = False

    def add(self, event: NormalizedLiquidation) -> None:
        quantity = Decimal(str(event.filled_quantity))
        notional = event._executed_notional_decimal
        self.filled_quantity += quantity
        self.filled_notional += notional
        self.event_count += 1
        self.max_event_notional = max(self.max_event_notional, notional)
        self.first_event_time_ms = (
            event.trade_time_ms
            if self.first_event_time_ms is None
            else min(self.first_event_time_ms, event.trade_time_ms)
        )
        self.last_event_time_ms = (
            event.trade_time_ms
            if self.last_event_time_ms is None
            else max(self.last_event_time_ms, event.trade_time_ms)
        )
        self.updated_at_ms = max(self.updated_at_ms, event.received_at_ms)
        self.revision += 1


@dataclass(slots=True)
class _StreamState:
    raw_events: deque[NormalizedLiquidation]
    raw_event_inversions: int = 0
    fingerprints: OrderedDict[str, None] = field(default_factory=OrderedDict)
    buckets: dict[tuple[int, PositionSide], _BucketAccumulator] = field(
        default_factory=dict,
    )


class LiquidationEngine:
    """Bounded multi-stream reducer for sampled liquidation observations."""

    def __init__(
        self,
        *,
        raw_ring_size: int = 5_000,
        max_buckets_per_stream: int = 2_880,
        max_streams: int = 64,
    ) -> None:
        self._raw_ring_size = max(1, int(raw_ring_size))
        self._max_buckets_per_stream = max(1, int(max_buckets_per_stream))
        self._max_streams = max(1, int(max_streams))
        self._streams: OrderedDict[StreamIdentity, _StreamState] = OrderedDict()
        self._active_streams: set[StreamIdentity] = set()
        self._metrics = {
            "accepted": 0,
            "duplicates_rejected": 0,
            "seeded_rollups": 0,
            "raw_events_evicted": 0,
            "rollup_rows_evicted": 0,
            "streams_evicted": 0,
            "rollups_finalized": 0,
        }

    def activate_stream(self, identity: StreamIdentity) -> bool:
        normalized = _normalize_identity(identity)
        if normalized in self._active_streams:
            return False
        state = self._streams.get(normalized)
        if state is None:
            self._reserve_stream_capacity(exclude=normalized)
            state = self._new_state()
            self._streams[normalized] = state
        self._streams.move_to_end(normalized)
        self._active_streams.add(normalized)
        return True

    def deactivate_stream(self, identity: StreamIdentity) -> bool:
        normalized = _normalize_identity(identity)
        if normalized not in self._active_streams:
            return False
        self._active_streams.remove(normalized)
        return True

    def ingest(
        self,
        event: MarketEvent | NormalizedLiquidation,
    ) -> LiquidationIngestResult:
        normalized = (
            event
            if isinstance(event, NormalizedLiquidation)
            else NormalizedLiquidation.from_market_event(event)
        )
        identity = normalized.stream_identity
        state = self._streams.get(identity)
        if state is None:
            self._reserve_stream_capacity(exclude=identity)
            state = self._new_state()
            self._streams[identity] = state
        self._streams.move_to_end(identity)

        if normalized.fingerprint in state.fingerprints:
            self._metrics["duplicates_rejected"] += 1
            return LiquidationIngestResult(
                accepted=False,
                reason="duplicate",
                event=normalized,
            )

        self._append_raw(state, normalized)
        bucket_start = (
            normalized.trade_time_ms // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS
        )
        bucket_key = (bucket_start, normalized.position_side)
        accumulator = state.buckets.get(bucket_key)
        if accumulator is None:
            accumulator = _BucketAccumulator(
                start_ms=bucket_start,
                position_side=normalized.position_side,
            )
            state.buckets[bucket_key] = accumulator
        accumulator.add(normalized)

        changed: dict[
            tuple[StreamIdentity, int, PositionSide], LiquidationRollup
        ] = {
            (identity, bucket_start, normalized.position_side): self._snapshot(
                identity,
                accumulator,
            ),
        }
        for rollup in self.finalize_due(
            max(normalized.trade_time_ms, normalized.event_time_ms),
        ):
            changed[(rollup.stream_identity, rollup.bucket_start_ms, rollup.position_side)] = (
                rollup
            )
        self._evict_rollup_rows(state)
        self._metrics["accepted"] += 1
        return LiquidationIngestResult(
            accepted=True,
            reason="accepted",
            event=normalized,
            rollups=tuple(
                sorted(
                    changed.values(),
                    key=_rollup_sort_key,
                ),
            ),
        )

    def seed_rollups(
        self,
        identity: StreamIdentity,
        rollups: Iterable[LiquidationRollup],
    ) -> int:
        """Restore persisted aggregate baselines before a live feed starts.

        Raw force-order snapshots are intentionally not replayed, but seeding
        recent rollups prevents a process restart in the middle of a minute
        from replacing the already durable observed totals with a fresh
        partial accumulator.
        """

        normalized = _normalize_identity(identity)
        state = self._streams.get(normalized)
        if state is None:
            self._reserve_stream_capacity(exclude=normalized)
            state = self._new_state()
            self._streams[normalized] = state
        restored = 0
        for rollup in rollups:
            if not isinstance(rollup, LiquidationRollup):
                raise TypeError("seeded liquidation rollups must be LiquidationRollup values")
            if rollup.stream_identity != normalized:
                raise ValueError("seeded liquidation rollup identity mismatch")
            if rollup.position_side not in {"long", "short"}:
                raise ValueError("seeded liquidation position_side is invalid")
            if rollup.bucket_start_ms < 0 or rollup.bucket_start_ms % BUCKET_INTERVAL_MS:
                raise ValueError("seeded liquidation bucket must be minute-aligned")
            if rollup.bucket_end_ms != rollup.bucket_start_ms + BUCKET_INTERVAL_MS:
                raise ValueError("seeded liquidation bucket end is invalid")
            if rollup.event_count < 0 or rollup.revision < 0:
                raise ValueError("seeded liquidation counts must be non-negative")
            if rollup.first_event_time_ms > rollup.last_event_time_ms:
                raise ValueError("seeded liquidation event-time range is invalid")
            numeric = (
                rollup.filled_quantity,
                rollup.filled_notional,
                rollup.max_event_notional,
            )
            if any(not math.isfinite(value) or value < 0 for value in numeric):
                raise ValueError("seeded liquidation totals must be finite and non-negative")

            key = (rollup.bucket_start_ms, rollup.position_side)
            current = state.buckets.get(key)
            if current is not None and (
                current.updated_at_ms > rollup.updated_at_ms
                or (
                    current.updated_at_ms == rollup.updated_at_ms
                    and current.revision >= rollup.revision
                )
            ):
                continue
            state.buckets[key] = _BucketAccumulator(
                start_ms=rollup.bucket_start_ms,
                position_side=rollup.position_side,
                filled_quantity=Decimal(str(rollup.filled_quantity)),
                filled_notional=Decimal(str(rollup.filled_notional)),
                event_count=rollup.event_count,
                max_event_notional=Decimal(str(rollup.max_event_notional)),
                first_event_time_ms=rollup.first_event_time_ms,
                last_event_time_ms=rollup.last_event_time_ms,
                updated_at_ms=rollup.updated_at_ms,
                revision=rollup.revision,
                is_final=rollup.is_final,
            )
            restored += 1
        self._evict_rollup_rows(state)
        self._streams.move_to_end(normalized)
        self._metrics["seeded_rollups"] += restored
        return restored

    def finalize_due(self, now_ms: int) -> tuple[LiquidationRollup, ...]:
        """Finalize every observed row whose minute ended before ``now_ms``.

        The current minute boundary is used as the watermark.  Empty minutes
        remain absent; this feed cannot distinguish a true zero from missing
        upstream observations.
        """

        now = _non_negative_int(now_ms, label="finalize time")
        boundary = now // BUCKET_INTERVAL_MS * BUCKET_INTERVAL_MS
        finalized: list[LiquidationRollup] = []
        for identity, state in self._streams.items():
            for accumulator in state.buckets.values():
                if accumulator.is_final:
                    continue
                if accumulator.start_ms + BUCKET_INTERVAL_MS > boundary:
                    continue
                accumulator.is_final = True
                accumulator.revision += 1
                accumulator.updated_at_ms = max(accumulator.updated_at_ms, now)
                finalized.append(self._snapshot(identity, accumulator))
        self._metrics["rollups_finalized"] += len(finalized)
        return tuple(sorted(finalized, key=_rollup_sort_key))

    def raw_snapshot(
        self,
        identity: StreamIdentity,
        *,
        ordered: bool = True,
    ) -> tuple[NormalizedLiquidation, ...]:
        state = self._streams.get(_normalize_identity(identity))
        if state is None:
            return ()
        records = tuple(state.raw_events)
        if ordered and state.raw_event_inversions:
            records = tuple(
                sorted(
                    records,
                    key=lambda item: (
                        item.trade_time_ms,
                        item.event_time_ms,
                        item.fingerprint,
                    ),
                ),
            )
        return records

    def raw_tail(
        self,
        identity: StreamIdentity,
        limit: int,
    ) -> tuple[NormalizedLiquidation, ...]:
        """Return the newest ordered events without sorting the whole ring."""
        state = self._streams.get(_normalize_identity(identity))
        if state is None:
            return ()
        bounded = max(0, int(limit))
        if bounded == 0:
            return ()
        if bounded >= len(state.raw_events):
            return self.raw_snapshot(identity)

        def _key(item: NormalizedLiquidation) -> tuple[int, int, str]:
            return item.trade_time_ms, item.event_time_ms, item.fingerprint

        if state.raw_event_inversions == 0:
            return tuple(
                itertools.islice(
                    state.raw_events,
                    len(state.raw_events) - bounded,
                    None,
                ),
            )
        newest = heapq.nlargest(bounded, state.raw_events, key=_key)
        newest.sort(key=_key)
        return tuple(newest)

    def rollup_snapshot(
        self,
        identity: StreamIdentity,
    ) -> tuple[LiquidationRollup, ...]:
        normalized = _normalize_identity(identity)
        state = self._streams.get(normalized)
        if state is None:
            return ()
        return tuple(
            sorted(
                (
                    self._snapshot(normalized, accumulator)
                    for accumulator in state.buckets.values()
                ),
                key=_rollup_sort_key,
            ),
        )

    # ``bucket_snapshot`` mirrors TradeFlowEngine's vocabulary and keeps a
    # service implementation independent of the concrete reducer.
    bucket_snapshot = rollup_snapshot

    def diagnostics(self) -> dict[str, Any]:
        return {
            "source_quality": SOURCE_QUALITY,
            "source_exhaustive": False,
            "sampling_mode": "latest_per_symbol_1000ms",
            "streams": len(self._streams),
            "active_streams": len(self._active_streams),
            "max_streams": self._max_streams,
            "raw_records": sum(len(state.raw_events) for state in self._streams.values()),
            "rollup_rows": sum(len(state.buckets) for state in self._streams.values()),
            "provisional_rollup_rows": sum(
                1
                for state in self._streams.values()
                for accumulator in state.buckets.values()
                if not accumulator.is_final
            ),
            "limits": {
                "raw_ring_per_stream": self._raw_ring_size,
                "rollup_rows_per_stream": self._max_buckets_per_stream,
                "streams": self._max_streams,
            },
            "stream_states": [
                {
                    "exchange": identity[0],
                    "market_type": identity[1],
                    "symbol": identity[2],
                    "active": identity in self._active_streams,
                    "raw_records": len(state.raw_events),
                    "rollup_rows": len(state.buckets),
                }
                for identity, state in self._streams.items()
            ],
            **self._metrics,
        }

    def _new_state(self) -> _StreamState:
        return _StreamState(raw_events=deque())

    def _reserve_stream_capacity(self, *, exclude: StreamIdentity) -> None:
        if exclude in self._streams or len(self._streams) < self._max_streams:
            return
        for identity in tuple(self._streams):
            if identity in self._active_streams:
                continue
            self._streams.pop(identity, None)
            self._metrics["streams_evicted"] += 1
            return
        raise RuntimeError(
            f"liquidation engine active stream limit reached ({self._max_streams})",
        )

    def _append_raw(
        self,
        state: _StreamState,
        event: NormalizedLiquidation,
    ) -> None:
        if len(state.raw_events) >= self._raw_ring_size:
            if len(state.raw_events) >= 2:
                first = state.raw_events[0]
                second = state.raw_events[1]
                if (
                    first.trade_time_ms,
                    first.event_time_ms,
                    first.fingerprint,
                ) > (
                    second.trade_time_ms,
                    second.event_time_ms,
                    second.fingerprint,
                ):
                    state.raw_event_inversions -= 1
            evicted = state.raw_events.popleft()
            state.fingerprints.pop(evicted.fingerprint, None)
            self._metrics["raw_events_evicted"] += 1
        if state.raw_events:
            previous = state.raw_events[-1]
            previous_key = (
                previous.trade_time_ms,
                previous.event_time_ms,
                previous.fingerprint,
            )
            event_key = (
                event.trade_time_ms,
                event.event_time_ms,
                event.fingerprint,
            )
            if previous_key > event_key:
                state.raw_event_inversions += 1
        state.raw_events.append(event)
        state.fingerprints[event.fingerprint] = None

    def _evict_rollup_rows(self, state: _StreamState) -> None:
        while len(state.buckets) > self._max_buckets_per_stream:
            oldest = min(state.buckets, key=lambda item: (item[0], item[1]))
            state.buckets.pop(oldest, None)
            self._metrics["rollup_rows_evicted"] += 1

    @staticmethod
    def _snapshot(
        identity: StreamIdentity,
        accumulator: _BucketAccumulator,
    ) -> LiquidationRollup:
        assert accumulator.first_event_time_ms is not None
        assert accumulator.last_event_time_ms is not None
        filled_quantity = float(accumulator.filled_quantity)
        filled_notional = float(accumulator.filled_notional)
        max_notional = float(accumulator.max_event_notional)
        if not all(
            math.isfinite(item)
            for item in (filled_quantity, filled_notional, max_notional)
        ):
            raise ValueError("liquidation rollup must serialize finite values")
        return LiquidationRollup(
            exchange=identity[0],
            market_type=identity[1],
            symbol=identity[2],
            position_side=accumulator.position_side,
            bucket_start_ms=accumulator.start_ms,
            bucket_end_ms=accumulator.start_ms + BUCKET_INTERVAL_MS,
            filled_quantity=filled_quantity,
            filled_notional=filled_notional,
            event_count=accumulator.event_count,
            max_event_notional=max_notional,
            first_event_time_ms=accumulator.first_event_time_ms,
            last_event_time_ms=accumulator.last_event_time_ms,
            is_final=accumulator.is_final,
            revision=accumulator.revision,
            updated_at_ms=accumulator.updated_at_ms,
        )


def _normalize_identity(identity: StreamIdentity) -> StreamIdentity:
    if not isinstance(identity, tuple) or len(identity) != 3:
        raise TypeError("liquidation identity must be a three-string tuple")
    exchange, market_type, symbol = identity
    normalized = (
        _required_text(exchange, label="exchange", case="lower"),
        _required_text(market_type, label="market type", case="lower"),
        _required_text(symbol, label="symbol", case="upper"),
    )
    if not _is_contract_market_type(normalized[1]):
        raise ValueError("liquidation identities require a contract market type")
    return normalized


def _is_contract_market_type(market_type: str) -> bool:
    return market_type.split(".", 1)[0] in {"futures", "future", "swap"}


def _rollup_sort_key(
    rollup: LiquidationRollup,
) -> tuple[str, str, str, int, str]:
    return (
        rollup.exchange,
        rollup.market_type,
        rollup.symbol,
        rollup.bucket_start_ms,
        rollup.position_side,
    )


__all__ = [
    "BUCKET_INTERVAL_MS",
    "SOURCE_QUALITY",
    "IngestReason",
    "LiquidationEngine",
    "LiquidationIngestResult",
    "LiquidationRollup",
    "NormalizedLiquidation",
    "PositionSide",
    "StreamIdentity",
]
