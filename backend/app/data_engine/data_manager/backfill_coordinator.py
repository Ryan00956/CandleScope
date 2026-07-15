"""Backfill request coordination for DataManager."""
from __future__ import annotations

import asyncio
import heapq
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.core.executors import run_storage
from app.data_engine.history.calendar import TradingCalendar
from app.data_engine.history.models import (
    BoundaryReason,
    BoundarySide,
    BoundaryState,
    HistoryAvailability,
    HistoryDisposition,
    HistoryPlan,
    HistoryRequest,
    HistorySeriesKey,
    TimeBound,
)
from app.data_engine.history.planner import HistoryRequestPlanner
from app.data_engine.history.service import HistoryAvailabilityService
from app.data_engine.interval_policy import (
    last_closed_bar_open_ms,
    parse_interval_ms,
)
from app.exchanges.models import (
    HistoryAvailabilityPolicy,
    HistoryEmptyPageSemantics,
)
from .models import BarData, DataEvent, DataEventType, SeriesKey, audience_for_backfill_reason

logger = logging.getLogger("data_manager.backfill_coordinator")


BACKFILL_REASON_PRIORITIES: dict[str, int] = {
    "initial_history": 10,
    "visible_load_more": 20,
    "visible_range_gap": 20,
    "visible_seed_gap": 30,
    "related_interval_warmup": 40,
    "tail_gap": 50,
    "full_subscription_warmup": 60,
    "price_daily_open": 70,
    "latest_refresh": 80,
    "query_gap": 100,
    "query_empty": 100,
    "query_tail_gap": 100,
    "query_left_gap": 100,
    "query_shortfall": 100,
    "query_interior_gap": 100,
    "startup_gap_scan": 120,
    "background_gap_audit": 150,
}

# Public API waits are capped at eight seconds, so one minute preserves useful
# late-wait resolution while the count limits protect a long-running process.
_SCHEDULER_OUTCOME_HISTORY_LIMIT = 256
_COORDINATOR_OUTCOME_HISTORY_LIMIT = 512
_REQUEST_ID_ALIAS_HISTORY_LIMIT = 2048
_RETAINED_OUTCOME_TTL_SECONDS = 60.0


def priority_for_reason(reason: str | None, default: int = 100) -> int:
    """Return the scheduler priority for a demand reason."""
    return BACKFILL_REASON_PRIORITIES.get(str(reason or "").strip(), default)


class BackfillEngineLike(Protocol):
    """Minimal engine contract used by BackfillCoordinator."""

    async def run(self, **kwargs: Any) -> Any:
        ...


class BackfillStorageLike(Protocol):
    """Minimal storage contract used by BackfillCoordinator."""

    def get_bounds(self, *args: Any, **kwargs: Any) -> dict:
        ...

    def query_bars(self, **kwargs: Any) -> list[dict]:
        ...


BarsBackfilledCallback = Callable[..., Awaitable[None]]
EventEmitter = Callable[[DataEvent], Awaitable[None]]


@dataclass(slots=True)
class RepairRequest:
    """A single requested historical repair range."""

    symbol: str
    interval: str
    start_ms: int
    end_ms: int
    exchange: str = "binance"
    market_type: str = "spot"
    reason: str = "query_gap"
    priority: int | None = None
    requester: str = "query"
    wait_policy: str = "async"
    metadata: dict[str, Any] = field(default_factory=dict)
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    def __post_init__(self) -> None:
        if self.priority is None:
            self.priority = priority_for_reason(self.reason)
        self.metadata.setdefault("requested_range", {
            "start_ms": int(self.start_ms),
            "end_ms": int(self.end_ms),
        })

    @property
    def series_key(self) -> tuple[str, str, str, str]:
        return (
            self.exchange.lower().strip(),
            self.market_type.lower().strip(),
            self.symbol.upper().strip(),
            self.interval,
        )

    def merged_with(self, other: RepairRequest) -> RepairRequest:
        """Return a range that covers both requests for the same series."""
        metadata = {**self.metadata, **other.metadata}
        planned_ranges = self._merged_history_fetch_ranges(other)
        if planned_ranges:
            metadata["history_fetch_ranges"] = planned_ranges
        metadata.setdefault("merged_request_ids", [])
        metadata["merged_request_ids"] = [
            *metadata["merged_request_ids"],
            self.request_id,
            other.request_id,
        ]
        return RepairRequest(
            symbol=self.symbol,
            interval=self.interval,
            start_ms=min(self.start_ms, other.start_ms),
            end_ms=max(self.end_ms, other.end_ms),
            exchange=self.exchange,
            market_type=self.market_type,
            reason=f"{self.reason}+{other.reason}",
            priority=min(int(self.priority or 100), int(other.priority or 100)),
            requester=self.requester if self.requester == other.requester else "mixed",
            wait_policy=self.wait_policy,
            metadata=metadata,
            request_id=self.request_id,
        )

    def _merged_history_fetch_ranges(
        self,
        other: RepairRequest,
    ) -> list[dict[str, int]]:
        ranges: list[tuple[int, int]] = []
        for request in (self, other):
            raw_ranges = request.metadata.get("history_fetch_ranges")
            if not isinstance(raw_ranges, list):
                raw_ranges = [{"start_ms": request.start_ms, "end_ms": request.end_ms}]
            for raw in raw_ranges:
                if not isinstance(raw, dict):
                    continue
                try:
                    start_ms = int(raw["start_ms"])
                    end_ms = int(raw["end_ms"])
                except (KeyError, TypeError, ValueError):
                    continue
                if start_ms <= end_ms:
                    ranges.append((start_ms, end_ms))
        if not ranges:
            return []
        ranges.sort()
        merged: list[tuple[int, int]] = [ranges[0]]
        for start_ms, end_ms in ranges[1:]:
            previous_start, previous_end = merged[-1]
            if start_ms <= previous_end:
                merged[-1] = (previous_start, max(previous_end, end_ms))
            else:
                merged.append((start_ms, end_ms))
        return [
            {"start_ms": start_ms, "end_ms": end_ms}
            for start_ms, end_ms in merged
        ]


HistoryPolicyResolver = Callable[[RepairRequest], Any]


@dataclass(slots=True)
class RepairOutcome:
    request: RepairRequest
    status: Any
    report: Any | None = None
    attempts: int = 0
    bars_loaded: int = 0
    verified_contiguous: bool | None = None
    remaining_missing_bars: int | None = None
    error: str | None = None
    terminal_reason: str | None = None
    exhausted_before_ms: int | None = None
    retryable: bool = False


@dataclass(slots=True)
class _PreparedHistoryRequest:
    request: RepairRequest | None
    plan: HistoryPlan | None = None
    context: Any | None = None


@dataclass(slots=True)
class ScanReport:
    scanned: int = 0
    repaired: int = 0
    queued: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "repaired": self.repaired,
            "queued": self.queued,
            "failed": self.failed,
            "errors": list(self.errors),
        }


@dataclass(slots=True)
class _SeriesState:
    active: str | None = None
    pending: list[str] = field(default_factory=list)


@dataclass(slots=True)
class _FetchChunk:
    chunk_id: str
    parent_id: str
    request: RepairRequest
    sequence: int


@dataclass(slots=True)
class _RequestState:
    request: RepairRequest
    future: asyncio.Future[RepairOutcome]
    chunk_ids: list[str]
    completed: int = 0
    attempts: int = 0
    bars_loaded: int = 0
    outcomes: list[RepairOutcome] = field(default_factory=list)
    failed: RepairOutcome | None = None
    stale: bool = False

    @property
    def total(self) -> int:
        return len(self.chunk_ids)

    @property
    def pending_count(self) -> int:
        return max(0, self.total - self.completed - (1 if self.failed else 0))


@dataclass(slots=True)
class _TokenBucket:
    """Local scheduler dispatch bucket, separate from exchange REST quotas."""

    key: str
    capacity: int = 60
    refill_per_second: float = 60.0
    tokens: float = 60.0
    updated_at: float = field(default_factory=time.monotonic)
    cooldown_until_ms: int = 0

    def try_acquire(self, now_ms: int, cost: int = 1) -> bool:
        if now_ms < self.cooldown_until_ms:
            return False
        now = time.monotonic()
        elapsed = max(0.0, now - self.updated_at)
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_per_second)
        self.updated_at = now
        if self.tokens < cost:
            return False
        self.tokens -= cost
        return True

    def next_available_delay(self, now_ms: int, cost: int = 1) -> float:
        if now_ms < self.cooldown_until_ms:
            return max(0.01, (self.cooldown_until_ms - now_ms) / 1000)
        if self.tokens >= cost:
            return 0.01
        if self.refill_per_second <= 0:
            return 1.0
        return max(0.01, (cost - self.tokens) / self.refill_per_second)

    def snapshot(self) -> dict[str, Any]:
        return {
            "scope": "scheduler_dispatch",
            "tokens": round(self.tokens, 2),
            "capacity": self.capacity,
            "refill_per_second": self.refill_per_second,
            "cooldown_until_ms": self.cooldown_until_ms,
        }


class _BackfillScheduler:
    """Priority scheduler used behind BackfillCoordinator's public API."""

    def __init__(
        self,
        *,
        execute: Callable[[RepairRequest], Awaitable[RepairOutcome]],
        future_for: Callable[[RepairRequest], asyncio.Future[RepairOutcome]],
        complete: Callable[[RepairRequest, RepairOutcome], None],
        on_queued: Callable[[RepairRequest], None],
        max_concurrency: int = 4,
        chunk_bars: int = 1000,
    ) -> None:
        self._execute = execute
        self._future_for = future_for
        self._complete = complete
        self._on_queued = on_queued
        self._max_concurrency = max(1, max_concurrency)
        self._chunk_bars = max(1, chunk_bars)

        self._series: dict[tuple[str, str, str, str], _SeriesState] = {}
        self._requests: dict[str, _RequestState] = {}
        self._chunks: dict[str, _FetchChunk] = {}
        self._ready: list[tuple[int, int, int, str]] = []
        self._tasks: dict[str, asyncio.Task] = {}
        self._buckets: dict[str, _TokenBucket] = {}
        self._coverage: dict[tuple[str, str, str, str], list[dict[str, int]]] = {}
        self._outcomes: dict[str, RepairOutcome] = {}
        self._max_retained_outcomes = _SCHEDULER_OUTCOME_HISTORY_LIMIT
        self._seq = 0
        self._shutdown = False
        self._drain_timer: asyncio.TimerHandle | None = None
        self._next_drain_at: float | None = None

        self.submitted = 0
        self.deduped = 0
        self.merged = 0
        self.rate_limited_skips = 0

    def submit(self, request: RepairRequest) -> tuple[str, asyncio.Future[RepairOutcome]]:
        if self._shutdown:
            raise RuntimeError("BackfillCoordinator is shut down")

        self.submitted += 1
        series_key = request.series_key
        series = self._series.setdefault(series_key, _SeriesState())

        active_state = self._requests.get(series.active or "")
        if active_state is not None and self._covers(active_state.request, request):
            self.deduped += 1
            return active_state.request.request_id, active_state.future

        for request_id in list(series.pending):
            state = self._requests.get(request_id)
            if state is None or state.stale:
                continue
            if self._covers(state.request, request):
                self.deduped += 1
                return state.request.request_id, state.future
            if state.completed == 0 and self._should_merge(state.request, request):
                state.request = state.request.merged_with(request)
                self._replace_pending_chunks(state)
                self._on_queued(state.request)
                self.merged += 1
                return state.request.request_id, state.future

        future = self._future_for(request)
        state = _RequestState(
            request=request,
            future=future,
            chunk_ids=[],
        )
        self._requests[request.request_id] = state
        series.pending.append(request.request_id)
        self._on_queued(request)
        self._replace_pending_chunks(state)
        self._drain()
        return request.request_id, future

    async def shutdown(self) -> None:
        self._shutdown = True
        self._cancel_drain_timer()
        for task in list(self._tasks.values()):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

        for state in list(self._requests.values()):
            if state.future.done():
                continue
            outcome = RepairOutcome(
                request=state.request,
                status="failed",
                error="cancelled",
            )
            state.future.set_result(outcome)

        self._ready.clear()
        self._chunks.clear()
        self._requests.clear()
        self._series.clear()
        self._tasks.clear()

    def snapshot(self) -> dict[str, Any]:
        active: list[dict[str, Any]] = []
        pending: list[dict[str, Any]] = []
        for series_key, series in self._series.items():
            series_label = ":".join(series_key)
            if series.active:
                state = self._requests.get(series.active)
                if state is not None:
                    active.append(self._state_snapshot(series_label, state, active=True))
            for request_id in series.pending:
                state = self._requests.get(request_id)
                if state is not None and not state.stale:
                    pending.append(self._state_snapshot(series_label, state, active=False))

        return {
            "submitted": self.submitted,
            "deduped": self.deduped,
            "merged": self.merged,
            "active": active,
            "pending": pending,
            "ready_chunks": len(self._ready),
            "running_chunks": len(self._tasks),
            "next_drain_in_ms": self._next_drain_in_ms(),
            "rate_limited_skips": self.rate_limited_skips,
            "buckets": {
                key: bucket.snapshot()
                for key, bucket in sorted(self._buckets.items())
            },
            "scheduler_buckets": {
                key: bucket.snapshot()
                for key, bucket in sorted(self._buckets.items())
            },
            "coverage": {
                ":".join(series): {"covered_ranges": ranges, "missing_ranges": []}
                for series, ranges in sorted(self._coverage.items())
            },
            "recent_outcomes": {
                request_id: self._outcome_snapshot(outcome)
                for request_id, outcome in list(self._outcomes.items())[-20:]
            },
        }

    def _replace_pending_chunks(self, state: _RequestState) -> None:
        for chunk_id in state.chunk_ids:
            self._chunks.pop(chunk_id, None)
        state.chunk_ids = []
        state.completed = 0
        state.failed = None
        state.outcomes = []
        state.attempts = 0
        state.bars_loaded = 0

        for chunk in self._split_request(state.request):
            self._chunks[chunk.chunk_id] = chunk
            state.chunk_ids.append(chunk.chunk_id)
            self._push_ready(chunk)

    def _split_request(self, request: RepairRequest) -> list[_FetchChunk]:
        interval_ms = parse_interval_ms(request.interval) or 60_000
        chunk_span = interval_ms * self._chunk_bars
        chunks: list[_FetchChunk] = []
        sequence = 0
        for planned_start, planned_end in self._planned_ranges(request):
            start = planned_start
            while start <= planned_end:
                chunk_end = min(planned_end, start + chunk_span - interval_ms)
                chunk_request = RepairRequest(
                    symbol=request.symbol,
                    interval=request.interval,
                    start_ms=start,
                    end_ms=chunk_end,
                    exchange=request.exchange,
                    market_type=request.market_type,
                    reason=request.reason,
                    priority=request.priority,
                    requester=request.requester,
                    wait_policy=request.wait_policy,
                    metadata={
                        **request.metadata,
                        "parent_request_id": request.request_id,
                        "chunk_sequence": sequence,
                    },
                    request_id=request.request_id,
                )
                chunks.append(_FetchChunk(
                    chunk_id=f"{request.request_id}:{sequence}",
                    parent_id=request.request_id,
                    request=chunk_request,
                    sequence=sequence,
                ))
                sequence += 1
                start = chunk_end + interval_ms
        if self._newest_first(request):
            return list(reversed(chunks))
        return chunks

    @staticmethod
    def _planned_ranges(request: RepairRequest) -> list[tuple[int, int]]:
        raw_ranges = request.metadata.get("history_fetch_ranges")
        if not isinstance(raw_ranges, list):
            return [(int(request.start_ms), int(request.end_ms))]
        ranges: list[tuple[int, int]] = []
        for raw in raw_ranges:
            if not isinstance(raw, dict):
                continue
            try:
                start_ms = max(int(request.start_ms), int(raw["start_ms"]))
                end_ms = min(int(request.end_ms), int(raw["end_ms"]))
            except (KeyError, TypeError, ValueError):
                continue
            if start_ms <= end_ms:
                ranges.append((start_ms, end_ms))
        return ranges or [(int(request.start_ms), int(request.end_ms))]

    @staticmethod
    def _newest_first(request: RepairRequest) -> bool:
        return request.reason in {
            "initial_history",
            "visible_load_more",
            "visible_range_gap",
            "visible_seed_gap",
            "tail_gap",
            "latest_refresh",
        }

    def _push_ready(self, chunk: _FetchChunk) -> None:
        self._seq += 1
        heapq.heappush(
            self._ready,
            (
                int(chunk.request.priority or 100),
                int(chunk.request.metadata.get("created_at_ms", 0) or 0),
                self._seq,
                chunk.chunk_id,
            ),
        )

    def _drain(self) -> None:
        if self._shutdown:
            return
        skipped: list[tuple[int, int, int, str]] = []
        next_delay: float | None = None
        try:
            while len(self._tasks) < self._max_concurrency and self._ready:
                item = heapq.heappop(self._ready)
                chunk = self._chunks.get(item[3])
                if chunk is None:
                    continue
                state = self._requests.get(chunk.parent_id)
                if state is None or state.stale or state.failed is not None:
                    self._chunks.pop(chunk.chunk_id, None)
                    continue
                series = self._series.setdefault(chunk.request.series_key, _SeriesState())
                if series.active is not None:
                    skipped.append(item)
                    continue
                bucket = self._bucket_for(chunk.request)
                now_ms = int(time.time() * 1000)
                if not bucket.try_acquire(now_ms):
                    self.rate_limited_skips += 1
                    delay = bucket.next_available_delay(now_ms)
                    next_delay = delay if next_delay is None else min(next_delay, delay)
                    skipped.append(item)
                    continue

                series.active = chunk.parent_id
                if chunk.parent_id in series.pending:
                    series.pending.remove(chunk.parent_id)
                task = asyncio.create_task(
                    self._run_chunk(chunk),
                    name=(
                        "backfill-chunk:"
                        f"{chunk.request.exchange}:{chunk.request.market_type}:"
                        f"{chunk.request.symbol}@{chunk.request.interval}:"
                        f"{chunk.sequence}"
                    ),
                )
                self._tasks[chunk.chunk_id] = task
        finally:
            for item in skipped:
                heapq.heappush(self._ready, item)
            if next_delay is not None and self._ready:
                self._schedule_drain(next_delay)
            elif not self._ready:
                self._cancel_drain_timer()

    def _schedule_drain(self, delay: float) -> None:
        if self._shutdown:
            return
        delay = max(float(delay), 0.01)
        loop = asyncio.get_running_loop()
        when = loop.time() + delay
        if (
            self._drain_timer is not None
            and not self._drain_timer.cancelled()
            and self._next_drain_at is not None
            and self._next_drain_at <= when
        ):
            return
        self._cancel_drain_timer()
        self._next_drain_at = when
        self._drain_timer = loop.call_later(delay, self._run_scheduled_drain)

    def _run_scheduled_drain(self) -> None:
        self._drain_timer = None
        self._next_drain_at = None
        self._drain()

    def _cancel_drain_timer(self) -> None:
        if self._drain_timer is not None and not self._drain_timer.cancelled():
            self._drain_timer.cancel()
        self._drain_timer = None
        self._next_drain_at = None

    def _next_drain_in_ms(self) -> int | None:
        if self._next_drain_at is None:
            return None
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        return max(0, int((self._next_drain_at - loop.time()) * 1000))

    async def _run_chunk(self, chunk: _FetchChunk) -> None:
        try:
            try:
                outcome = await self._execute(chunk.request)
            except asyncio.CancelledError:
                outcome = RepairOutcome(
                    request=chunk.request,
                    status="failed",
                    error="cancelled",
                )
            except Exception as exc:
                logger.exception("Backfill chunk failed for %s", chunk.chunk_id)
                outcome = RepairOutcome(
                    request=chunk.request,
                    status="failed",
                    error=str(exc),
                )
            self._finish_chunk(chunk, outcome)
        finally:
            self._tasks.pop(chunk.chunk_id, None)
            self._drain()

    def _finish_chunk(self, chunk: _FetchChunk, outcome: RepairOutcome) -> None:
        self._chunks.pop(chunk.chunk_id, None)
        state = self._requests.get(chunk.parent_id)
        series = self._series.get(chunk.request.series_key)
        if series is not None and series.active == chunk.parent_id:
            series.active = None

        if state is None or state.future.done():
            return

        state.completed += 1
        state.attempts += int(outcome.attempts or 0)
        state.bars_loaded += int(outcome.bars_loaded or 0)
        state.outcomes.append(outcome)
        if self._is_failed(outcome.status):
            state.failed = outcome
            self._discard_remaining_chunks(state)
        elif (
            self._newest_first(state.request)
            and self._is_left_terminal_outcome(outcome)
        ):
            # Newest-first requests must not continue scheduling successively
            # older chunks after the provider has confirmed the left edge.
            self._discard_remaining_chunks(state)
            state.completed = state.total

        if not self._is_failed(outcome.status):
            self._coverage.setdefault(chunk.request.series_key, []).append({
                "start_ms": chunk.request.start_ms,
                "end_ms": chunk.request.end_ms,
            })

        if state.failed is not None or state.completed >= state.total:
            final = self._aggregate_outcome(state)
            self._retain_outcome(state.request.request_id, final)
            self._complete(state.request, final)
            self._requests.pop(state.request.request_id, None)
            if series is not None and not series.pending and series.active is None:
                self._series.pop(chunk.request.series_key, None)
        elif series is not None and state.request.request_id not in series.pending:
            # Remaining chunks are already in the global queue. Keep the parent
            # visible in pending diagnostics while it waits for the next turn.
            series.pending.append(state.request.request_id)

    def _retain_outcome(self, request_id: str, outcome: RepairOutcome) -> None:
        self._outcomes[request_id] = outcome
        while len(self._outcomes) > self._max_retained_outcomes:
            oldest_request_id = next(iter(self._outcomes))
            self._outcomes.pop(oldest_request_id, None)

    def _discard_remaining_chunks(self, state: _RequestState) -> None:
        for chunk_id in state.chunk_ids:
            self._chunks.pop(chunk_id, None)
        state.stale = True

    def _aggregate_outcome(self, state: _RequestState) -> RepairOutcome:
        if state.failed is not None:
            return RepairOutcome(
                request=state.request,
                status=state.failed.status,
                report=state.failed.report,
                attempts=state.attempts or state.failed.attempts,
                bars_loaded=state.bars_loaded,
                verified_contiguous=False,
                remaining_missing_bars=state.failed.remaining_missing_bars,
                error=state.failed.error,
                terminal_reason=state.failed.terminal_reason,
                exhausted_before_ms=state.failed.exhausted_before_ms,
                retryable=state.failed.retryable,
            )

        last = state.outcomes[-1] if state.outcomes else None
        verified_values = [
            outcome.verified_contiguous
            for outcome in state.outcomes
            if outcome.verified_contiguous is not None
        ]
        missing_values = [
            outcome.remaining_missing_bars
            for outcome in state.outcomes
            if outcome.remaining_missing_bars is not None
        ]
        return RepairOutcome(
            request=state.request,
            status=last.status if last is not None else "completed",
            report=last.report if last is not None else None,
            attempts=state.attempts,
            bars_loaded=state.bars_loaded,
            verified_contiguous=(
                all(verified_values) if verified_values else None
            ),
            remaining_missing_bars=(
                sum(int(value or 0) for value in missing_values)
                if missing_values
                else None
            ),
            error=None,
            terminal_reason=(
                next(
                    (
                        outcome.terminal_reason
                        for outcome in reversed(state.outcomes)
                        if outcome.terminal_reason
                    ),
                    None,
                )
            ),
            exhausted_before_ms=(
                next(
                    (
                        outcome.exhausted_before_ms
                        for outcome in reversed(state.outcomes)
                        if outcome.exhausted_before_ms is not None
                    ),
                    None,
                )
            ),
            retryable=any(outcome.retryable for outcome in state.outcomes),
        )

    def _bucket_for(self, request: RepairRequest) -> _TokenBucket:
        key = f"{request.exchange.lower().strip()}:{request.market_type.lower().strip()}"
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _TokenBucket(key=key)
            self._buckets[key] = bucket
        return bucket

    @staticmethod
    def _is_left_terminal_outcome(outcome: RepairOutcome) -> bool:
        return (
            not outcome.retryable
            and outcome.terminal_reason in {
                "provider_exhausted",
                BoundaryReason.SOURCE_EXHAUSTED.value,
                BoundaryReason.DATA_START.value,
                BoundaryReason.LISTING.value,
                BoundaryReason.UPSTREAM_START.value,
                BoundaryReason.PROVIDER_RETENTION.value,
            }
        )

    def _state_snapshot(
        self,
        series: str,
        state: _RequestState,
        *,
        active: bool,
    ) -> dict[str, Any]:
        payload = {
            "series": series,
            "request_id": state.request.request_id,
            "reason": state.request.reason,
            "priority": state.request.priority,
            "requester": state.request.requester,
            "range_start_ms": state.request.start_ms,
            "range_end_ms": state.request.end_ms,
            "total_chunks": state.total,
            "completed_chunks": state.completed,
            "pending_chunks": state.pending_count,
            "active": active,
        }
        metadata = state.request.metadata or {}
        for key in ("focus_scope", "subscription_tier", "current_interval"):
            if key in metadata:
                payload[key] = metadata[key]
        return payload

    @staticmethod
    def _outcome_snapshot(outcome: RepairOutcome) -> dict[str, Any]:
        return {
            "status": BackfillCoordinator._status_value(outcome.status),
            "reason": outcome.request.reason,
            "priority": outcome.request.priority,
            "requester": outcome.request.requester,
            "range_start_ms": outcome.request.start_ms,
            "range_end_ms": outcome.request.end_ms,
            "attempts": outcome.attempts,
            "bars_loaded": outcome.bars_loaded,
            "verified_contiguous": outcome.verified_contiguous,
            "remaining_missing_bars": outcome.remaining_missing_bars,
            "error": outcome.error,
            "terminal_reason": outcome.terminal_reason,
            "exhausted_before_ms": outcome.exhausted_before_ms,
            "retryable": outcome.retryable,
        }

    @staticmethod
    def _covers(existing: RepairRequest, new: RepairRequest) -> bool:
        return existing.start_ms <= new.start_ms and existing.end_ms >= new.end_ms

    @classmethod
    def _should_merge(cls, existing: RepairRequest, new: RepairRequest) -> bool:
        interval_ms = parse_interval_ms(existing.interval) or 60_000
        tolerance = interval_ms * 3
        return (
            existing.series_key == new.series_key
            and existing.start_ms <= new.end_ms + tolerance
            and new.start_ms <= existing.end_ms + tolerance
        )

    @staticmethod
    def _is_failed(status: Any) -> bool:
        return BackfillCoordinator._status_value(status) == "failed"


class GapLedgerLike(Protocol):
    """Optional persistent state sink for gap lifecycle transitions."""

    def upsert_detected(self, request: RepairRequest, *, status: str = "queued") -> None:
        ...

    def mark_started(self, request: RepairRequest, *, attempt: int) -> None:
        ...

    def mark_retry_wait(
        self,
        request: RepairRequest,
        *,
        attempt: int,
        error: str | None,
        next_retry_at: int,
    ) -> None:
        ...

    def mark_verifying(self, request: RepairRequest) -> None:
        ...

    def mark_resolved(
        self,
        request: RepairRequest,
        *,
        status: str,
        missing_count: int | None = None,
        error: str | None = None,
    ) -> None:
        ...

    def get_status(self, request: RepairRequest) -> dict[str, Any] | None:
        ...


class BackfillCoordinator:
    """Serializes backfill work and owns cache reload after repair."""

    def __init__(
        self,
        *,
        storage: BackfillStorageLike,
        bars_backfilled: BarsBackfilledCallback,
        emit_event: EventEmitter,
        engine: BackfillEngineLike | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        max_retries: int = 3,
        base_delay_seconds: float = 5.0,
        gap_ledger: GapLedgerLike | None = None,
        max_concurrency: int = 4,
        chunk_bars: int = 1000,
        history_service: HistoryAvailabilityService | None = None,
        history_policy_resolver: HistoryPolicyResolver | None = None,
    ) -> None:
        self._storage = storage
        self._bars_backfilled = bars_backfilled
        self._emit_event = emit_event
        self._engine = engine
        self._loop = loop
        self._max_retries = max(1, max_retries)
        self._base_delay_seconds = base_delay_seconds
        self._gap_ledger = gap_ledger
        self._history_service = history_service
        self._history_policy_resolver = history_policy_resolver

        self._futures: dict[str, asyncio.Future[RepairOutcome]] = {}
        self._outcomes: dict[str, RepairOutcome] = {}
        self._outcome_expires_at: dict[str, float] = {}
        self._request_id_aliases: dict[str, str] = {}
        self._request_id_alias_expires_at: dict[str, float | None] = {}
        self._max_retained_outcomes = _COORDINATOR_OUTCOME_HISTORY_LIMIT
        self._max_request_id_aliases = _REQUEST_ID_ALIAS_HISTORY_LIMIT
        self._retained_outcome_ttl_seconds = _RETAINED_OUTCOME_TTL_SECONDS
        self._shutdown = False
        self._scheduler = _BackfillScheduler(
            execute=self._run_with_retries,
            future_for=self._future_for,
            complete=self._complete,
            on_queued=self._ledger_upsert_detected,
            max_concurrency=max_concurrency,
            chunk_bars=chunk_bars,
        )

    def set_engine(self, engine: BackfillEngineLike) -> None:
        self._engine = engine

    def trigger(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
        *,
        reason: str = "query_gap",
        priority: int | None = None,
        requester: str = "query",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Synchronous QueryEngine-compatible callback."""
        return self.request(RepairRequest(
            symbol=symbol,
            interval=interval,
            start_ms=int(start_ms),
            end_ms=int(end_ms),
            exchange=exchange,
            market_type=market_type,
            reason=reason,
            priority=priority,
            requester=requester,
            metadata=metadata or {},
        ))

    def request(self, request: RepairRequest) -> str:
        """Submit a repair request and return its request id."""
        if self._loop is None:
            try:
                self._loop = asyncio.get_running_loop()
            except RuntimeError:
                raise RuntimeError("BackfillCoordinator requires an event loop")

        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None

        if running_loop is self._loop:
            return self._request_in_loop(request)[0]

        self._loop.call_soon_threadsafe(self._request_in_loop, request)
        return request.request_id

    async def request_and_wait(self, request: RepairRequest) -> RepairOutcome:
        request_id, future = self._request_in_loop(request)
        return await future

    async def wait_for_request(self, request_id: str) -> RepairOutcome | None:
        """Wait for an already-submitted repair request by id."""
        while not self._shutdown:
            self._prune_retained_state()
            canonical_id = self._canonical_request_id(request_id)
            outcome = self._outcomes.get(canonical_id)
            if outcome is not None:
                return outcome
            future = self._futures.get(canonical_id)
            if future is not None:
                return await asyncio.shield(future)
            await asyncio.sleep(0.01)
        return None

    async def startup_scan(
        self,
        targets: list[tuple[str, str, str]],
        intervals: tuple[str, ...],
        *,
        delay_seconds: float = 5.0,
    ) -> ScanReport:
        """Scan configured startup targets and repair stale tails."""
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)

        report = ScanReport()
        now_ms = int(time.time() * 1000)

        for exchange, market_type, symbol in targets:
            for interval in intervals:
                if self._shutdown:
                    return report
                try:
                    bounds = self._storage.get_bounds(
                        symbol,
                        interval,
                        exchange=exchange,
                        market_type=market_type,
                    )
                    latest = bounds.get("latest_open_time")
                    if not latest:
                        continue

                    interval_ms = parse_interval_ms(interval) or 60_000
                    if now_ms - int(latest) <= interval_ms * 3:
                        continue

                    report.scanned += 1
                    outcome = await self.request_and_wait(RepairRequest(
                        symbol=symbol,
                        interval=interval,
                        start_ms=int(latest),
                        end_ms=now_ms,
                        exchange=exchange,
                        market_type=market_type,
                        reason="startup_gap_scan",
                        priority=priority_for_reason("startup_gap_scan"),
                        requester="startup_scan",
                    ))
                    if self._is_failed(outcome.status):
                        report.failed += 1
                        if outcome.error:
                            report.errors.append(outcome.error)
                    else:
                        report.repaired += 1
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    report.failed += 1
                    report.errors.append(
                        f"{exchange}:{market_type}:{symbol}@{interval}: {exc}"
                    )
                    logger.warning(
                        "Startup gap scan failed for %s:%s:%s@%s: %s",
                        exchange,
                        market_type,
                        symbol,
                        interval,
                        exc,
                    )

        return report

    async def audit_storage_gaps(
        self,
        targets: list[tuple[str, str, str]],
        intervals: tuple[str, ...],
        *,
        scan_limit: int = 50_000,
        max_gaps: int = 100,
        repair: bool = True,
    ) -> ScanReport:
        """Scan tracked series for stored interior gaps and optionally queue repairs."""
        return await self.audit_storage_series(
            (
                (exchange, market_type, symbol, interval)
                for exchange, market_type, symbol in targets
                for interval in intervals
            ),
            scan_limit=scan_limit,
            max_gaps=max_gaps,
            repair=repair,
        )

    async def audit_storage_series(
        self,
        series: Iterable[tuple[str, str, str, str]],
        *,
        scan_limit: int = 50_000,
        max_gaps: int = 100,
        repair: bool = True,
    ) -> ScanReport:
        """Scan exact stored/active series and optionally queue gap repairs."""
        report = ScanReport()
        scanner = getattr(self._storage, "scan_gaps", None)
        if not callable(scanner):
            report.errors.append("storage does not support gap scanning")
            return report

        queued = 0
        seen_series: set[tuple[str, str, str, str]] = set()
        for raw_exchange, raw_market_type, raw_symbol, raw_interval in series:
            exchange = str(raw_exchange or "binance").strip().lower()
            market_type = str(raw_market_type or "spot").strip().lower()
            symbol = str(raw_symbol or "").strip().upper()
            interval = str(raw_interval or "").strip()
            if not symbol or not interval:
                continue
            series_key = (exchange, market_type, symbol, interval)
            if series_key in seen_series:
                continue
            seen_series.add(series_key)

            if self._shutdown:
                return report
            if queued >= max_gaps:
                return report
            try:
                scan = await run_storage(
                    scanner,
                    symbol=symbol,
                    interval=interval,
                    exchange=exchange,
                    market_type=market_type,
                    limit=scan_limit,
                )
                report.scanned += 1
                for gap in scan.get("gaps", []):
                    if queued >= max_gaps:
                        return report
                    request = RepairRequest(
                        symbol=symbol,
                        interval=interval,
                        start_ms=int(gap["start_ms"]),
                        end_ms=int(gap["end_ms"]),
                        exchange=exchange,
                        market_type=market_type,
                        reason="background_gap_audit",
                        priority=priority_for_reason("background_gap_audit"),
                        requester="background_audit",
                        metadata={
                            "origin": "background_gap_audit",
                            "gap_type": gap.get("reason", "unknown"),
                        },
                    )
                    if self._should_skip_audited_gap(request):
                        continue
                    if repair:
                        self.request(request)
                        queued += 1
                        report.queued += 1
                    else:
                        report.repaired += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                report.failed += 1
                report.errors.append(
                    f"{exchange}:{market_type}:{symbol}@{interval}: {exc}"
                )
                logger.warning(
                    "Background gap audit failed for %s:%s:%s@%s: %s",
                    exchange,
                    market_type,
                    symbol,
                    interval,
                    exc,
                )

        return report

    async def shutdown(self) -> None:
        """Cancel active and pending repairs."""
        self._shutdown = True
        await self._scheduler.shutdown()

    def snapshot(self) -> dict:
        snapshot = self._scheduler.snapshot()
        snapshot["gap_ledger_open"] = self._ledger_open_snapshot()
        return snapshot

    def _request_in_loop(
        self,
        request: RepairRequest,
    ) -> tuple[str, asyncio.Future[RepairOutcome]]:
        if self._shutdown:
            raise RuntimeError("BackfillCoordinator is shut down")

        self._prune_retained_state()
        prepared = self._prepare_history_request(request)
        if prepared.request is None:
            future = self._future_for(request)
            outcome = self._history_no_fetch_outcome(request, prepared.plan)
            self._complete(request, outcome)
            return request.request_id, future

        canonical_id, future = self._scheduler.submit(prepared.request)
        if canonical_id != request.request_id:
            self._request_id_aliases[request.request_id] = canonical_id
            self._request_id_alias_expires_at[request.request_id] = None
            self._prune_retained_state()
        return canonical_id, future

    def _prepare_history_request(
        self,
        request: RepairRequest,
    ) -> _PreparedHistoryRequest:
        plan, context = self._plan_history_request(request)
        if plan is None:
            # Alternate embeddings may omit the availability service.  Still
            # enforce the universal closed-bar edge before a request reaches
            # the fetch engine; otherwise a forming-only task is guaranteed to
            # normalize to zero historical bars and be retried as a failure.
            now_ms = int(time.time() * 1000)
            last_closed_ms = last_closed_bar_open_ms(now_ms, request.interval)
            if last_closed_ms is None or request.end_ms <= last_closed_ms:
                return _PreparedHistoryRequest(request=request)
            history_request = HistoryRequest(
                series=self._history_series_key(request),
                interval=request.interval,
                start_ms=request.start_ms,
                end_ms=request.end_ms,
            )
            plan = HistoryRequestPlanner().plan(
                history_request,
                HistoryAvailability(calendar_id="crypto.24x7.utc"),
                now_ms=now_ms,
            )
        if not plan.has_fetch_work:
            return _PreparedHistoryRequest(request=None, plan=plan, context=context)

        fetch_ranges = [
            {"start_ms": item.start_ms, "end_ms": item.end_ms}
            for item in plan.fetch_ranges
        ]
        prepared = RepairRequest(
            symbol=request.symbol,
            interval=request.interval,
            start_ms=plan.fetch_ranges[0].start_ms,
            end_ms=plan.fetch_ranges[-1].end_ms,
            exchange=request.exchange,
            market_type=request.market_type,
            reason=request.reason,
            priority=request.priority,
            requester=request.requester,
            wait_policy=request.wait_policy,
            metadata={
                **request.metadata,
                "history_fetch_ranges": fetch_ranges,
                "history_calendar_id": plan.calendar_id,
                "history_exclusions": [
                    {
                        "start_ms": item.time_range.start_ms,
                        "end_ms": item.time_range.end_ms,
                        "disposition": item.disposition.value,
                        "reason": item.reason.value,
                    }
                    for item in plan.exclusions
                ],
            },
            request_id=request.request_id,
        )
        return _PreparedHistoryRequest(
            request=prepared,
            plan=plan,
            context=context,
        )

    def _plan_history_request(
        self,
        request: RepairRequest,
    ) -> tuple[HistoryPlan | None, Any | None]:
        if self._history_service is None and self._history_policy_resolver is None:
            return None, None

        history_request = HistoryRequest(
            series=self._history_series_key(request),
            interval=request.interval,
            start_ms=request.start_ms,
            end_ms=request.end_ms,
        )
        context: Any | None = None
        if self._history_policy_resolver is not None:
            try:
                resolved = self._history_policy_resolver(request)
            except Exception as exc:
                logger.warning(
                    "History policy resolution failed for %s:%s:%s@%s: %s",
                    request.exchange,
                    request.market_type,
                    request.symbol,
                    request.interval,
                    exc,
                )
                return HistoryRequestPlanner.fail_closed(
                    history_request,
                    reason=BoundaryReason.AVAILABILITY_UNKNOWN,
                ), None
            if (
                isinstance(resolved, tuple)
                and len(resolved) == 2
                and isinstance(resolved[0], HistoryPlan)
            ):
                return resolved[0], resolved[1]
            context = resolved

        availability = self._context_availability(context)
        if availability is None:
            if self._history_policy_resolver is not None:
                return HistoryRequestPlanner.fail_closed(
                    history_request,
                    reason=BoundaryReason.AVAILABILITY_UNKNOWN,
                ), context
            availability = HistoryAvailability(calendar_id="crypto.24x7.utc")

        if self._history_service is not None:
            availability = self._history_service.resolve_availability(
                history_request.series,
                availability,
            )

        calendar = self._context_calendar(context, availability)
        if calendar is not None:
            return HistoryRequestPlanner(calendar).plan(
                history_request,
                availability,
            ), context
        if self._history_service is not None:
            return self._history_service.plan(
                history_request,
                availability,
                calendar_id=availability.calendar_id,
            ), context
        return HistoryRequestPlanner.fail_closed(
            history_request,
            reason=BoundaryReason.CALENDAR_UNKNOWN,
            calendar_id=availability.calendar_id,
        ), context

    @staticmethod
    def _history_series_key(request: RepairRequest) -> HistorySeriesKey:
        return HistorySeriesKey(
            exchange=request.exchange,
            market_type=request.market_type,
            symbol=request.symbol,
            channel="kline",
            variant=request.interval,
        )

    @staticmethod
    def _context_availability(context: Any | None) -> HistoryAvailability | None:
        if isinstance(context, HistoryAvailability):
            return context
        availability = getattr(context, "availability", None)
        if isinstance(availability, HistoryAvailability):
            return availability
        policy = (
            context
            if isinstance(context, HistoryAvailabilityPolicy)
            else getattr(context, "policy", None)
        )
        if not isinstance(policy, HistoryAvailabilityPolicy):
            return None
        return HistoryAvailability(
            upstream_start=(
                TimeBound(
                    policy.available_from_ms,
                    BoundaryReason.UPSTREAM_START,
                )
                if policy.available_from_ms is not None
                else None
            ),
            upstream_end=(
                TimeBound(
                    policy.available_to_ms,
                    BoundaryReason.UPSTREAM_END,
                )
                if policy.available_to_ms is not None
                else None
            ),
            rolling_retention_ms=policy.max_age_ms,
            calendar_id=policy.calendar_id,
        )

    def _context_calendar(
        self,
        context: Any | None,
        availability: HistoryAvailability | None = None,
    ) -> TradingCalendar | None:
        calendar = getattr(context, "calendar", None)
        if isinstance(calendar, TradingCalendar):
            return calendar
        if self._history_service is None:
            return None
        calendar_id = (
            availability.calendar_id
            if availability is not None
            else None
        )
        return self._history_service.calendars.get(calendar_id)

    @staticmethod
    def _history_no_fetch_outcome(
        request: RepairRequest,
        plan: HistoryPlan | None,
    ) -> RepairOutcome:
        if plan is None:
            return RepairOutcome(
                request=request,
                status="completed",
                retryable=True,
                error="history planning produced no request",
            )
        exclusion = next(
            (
                item
                for item in plan.exclusions
                if item.disposition is HistoryDisposition.TERMINAL
            ),
            plan.exclusions[0] if plan.exclusions else None,
        )
        reason = exclusion.reason.value if exclusion is not None else None
        lower_reasons = {
            BoundaryReason.DATA_START,
            BoundaryReason.LISTING,
            BoundaryReason.UPSTREAM_START,
            BoundaryReason.PROVIDER_RETENTION,
            BoundaryReason.SOURCE_EXHAUSTED,
        }
        exhausted_before_ms = (
            exclusion.bound.value_ms
            if exclusion is not None
            and exclusion.bound is not None
            and exclusion.reason in lower_reasons
            else None
        )
        retryable = plan.retryable or plan.unknown
        terminal_reason = (
            reason
            if plan.terminal or plan.disposition is HistoryDisposition.NOT_EXPECTED
            else None
        )
        return RepairOutcome(
            request=request,
            status="completed",
            verified_contiguous=(None if retryable else True),
            remaining_missing_bars=(None if retryable else 0),
            terminal_reason=terminal_reason,
            exhausted_before_ms=exhausted_before_ms,
            retryable=retryable,
            error=("history availability is unknown" if plan.unknown else None),
        )

    def _canonical_request_id(self, request_id: str) -> str:
        canonical_id = request_id
        seen: set[str] = set()
        while canonical_id not in seen:
            seen.add(canonical_id)
            next_id = self._request_id_aliases.get(canonical_id)
            if next_id is None:
                break
            canonical_id = next_id
        return canonical_id

    def _prune_retained_state(self, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        expired_outcomes = [
            request_id
            for request_id, expires_at in self._outcome_expires_at.items()
            if expires_at <= current
        ]
        for request_id in expired_outcomes:
            self._drop_retained_outcome(request_id)

        expired_aliases = [
            request_id
            for request_id, expires_at in self._request_id_alias_expires_at.items()
            if expires_at is not None and expires_at <= current
        ]
        for request_id in expired_aliases:
            self._drop_request_id_alias(request_id)

        while len(self._outcomes) > self._max_retained_outcomes:
            self._drop_retained_outcome(next(iter(self._outcomes)))
        while len(self._request_id_aliases) > self._max_request_id_aliases:
            self._drop_request_id_alias(next(iter(self._request_id_aliases)))

    def _drop_retained_outcome(self, request_id: str) -> None:
        self._outcomes.pop(request_id, None)
        self._outcome_expires_at.pop(request_id, None)
        aliases = [
            alias_id
            for alias_id in self._request_id_aliases
            if self._canonical_request_id(alias_id) == request_id
        ]
        for alias_id in aliases:
            self._drop_request_id_alias(alias_id)

    def _drop_request_id_alias(self, request_id: str) -> None:
        self._request_id_aliases.pop(request_id, None)
        self._request_id_alias_expires_at.pop(request_id, None)

    def _retain_completed_outcome(
        self,
        request: RepairRequest,
        outcome: RepairOutcome,
    ) -> None:
        now = time.monotonic()
        expires_at = now + self._retained_outcome_ttl_seconds
        self._outcomes[request.request_id] = outcome
        self._outcome_expires_at[request.request_id] = expires_at
        aliases = [
            alias_id
            for alias_id in self._request_id_aliases
            if self._canonical_request_id(alias_id) == request.request_id
        ]
        for alias_id in aliases:
            self._request_id_alias_expires_at[alias_id] = expires_at
        self._prune_retained_state(now)

    def _future_for(self, request: RepairRequest) -> asyncio.Future[RepairOutcome]:
        future = self._futures.get(request.request_id)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            self._futures[request.request_id] = future
        return future

    async def _run_with_retries(self, request: RepairRequest) -> RepairOutcome:
        prepared = self._prepare_history_request(request)
        if prepared.request is None:
            return self._history_no_fetch_outcome(request, prepared.plan)
        request = prepared.request
        history_context = prepared.context

        if self._engine is None:
            return RepairOutcome(
                request=request,
                status="failed",
                error="BackfillEngine is not configured",
            )

        last_error: str | None = None
        report: Any | None = None

        for attempt in range(1, self._max_retries + 1):
            try:
                self._ledger_mark_started(request, attempt=attempt)
                report = await self._engine.run(
                    symbol=request.symbol,
                    intervals=[request.interval],
                    range_start_ms=request.start_ms,
                    range_end_ms=request.end_ms,
                    exchange=request.exchange,
                    market_type=request.market_type,
                    metadata={
                        **request.metadata,
                        "reason": request.reason,
                        "priority": request.priority,
                        "requester": request.requester,
                        "request_id": request.request_id,
                    },
                )
                if self._is_failed(report.status) and attempt < self._max_retries:
                    delay = self._backoff(attempt)
                    self._ledger_mark_retry_wait(
                        request,
                        attempt=attempt,
                        error="; ".join(report.errors) if report.errors else None,
                        delay_seconds=delay,
                    )
                    await asyncio.sleep(delay)
                    continue

                bars_loaded = 0
                verification: dict[str, Any] = {
                    "verified_contiguous": None,
                    "remaining_missing_bars": None,
                }
                if not self._is_failed(report.status):
                    self._ledger_mark_verifying(request)
                    verification = await self._verify_request_range(
                        request,
                        context=history_context,
                    )
                    self._ledger_mark_verified(request, report, verification)
                    bars_loaded = await self._load_backfilled_to_cache(
                        request,
                        report,
                        verification,
                    )
                    await self._emit_completion_if_needed(
                        request,
                        report,
                        bars_loaded,
                        verification,
                    )

                if self._is_failed(report.status):
                    await self._emit_failed(request, report)
                    self._ledger_mark_failed(
                        request,
                        "; ".join(report.errors) if report.errors else None,
                    )

                terminal_reason: str | None = None
                exhausted_before_ms: int | None = None
                if not self._is_failed(report.status):
                    terminal_reason, exhausted_before_ms = (
                        await self._record_confirmed_left_boundary(
                            request,
                            report,
                            context=history_context,
                        )
                    )

                return RepairOutcome(
                    request=request,
                    status=report.status,
                    report=report,
                    attempts=attempt,
                    bars_loaded=bars_loaded,
                    verified_contiguous=verification.get("verified_contiguous"),
                    remaining_missing_bars=verification.get("remaining_missing_bars"),
                    error="; ".join(report.errors) if report.errors else None,
                    terminal_reason=terminal_reason,
                    exhausted_before_ms=exhausted_before_ms,
                    retryable=self._report_retryable(report),
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                last_error = str(exc)
                logger.error(
                    "Backfill task error for %s@%s attempt %d/%d: %s",
                    request.symbol,
                    request.interval,
                    attempt,
                    self._max_retries,
                    exc,
                    exc_info=True,
                )
                if attempt < self._max_retries:
                    delay = self._backoff(attempt)
                    self._ledger_mark_retry_wait(
                        request,
                        attempt=attempt,
                        error=last_error,
                        delay_seconds=delay,
                    )
                    await asyncio.sleep(delay)

        await self._emit_failed(request, report, last_error)
        self._ledger_mark_failed(request, last_error)
        return RepairOutcome(
            request=request,
            status="failed",
            report=report,
            attempts=self._max_retries,
            error=last_error,
        )

    async def _load_backfilled_to_cache(
        self,
        request: RepairRequest,
        report: Any,
        verification: dict[str, Any] | None = None,
    ) -> int:
        if self._total_bars_written(report) <= 0:
            return 0

        total_loaded = 0
        for written_range in self._written_ranges_for_request(request, report):
            rows = await run_storage(
                self._storage.query_bars,
                symbol=written_range["symbol"],
                interval=written_range["interval"],
                start_ms=written_range["start_ms"],
                end_ms=written_range["end_ms"],
                order="ASC",
                exchange=written_range["exchange"],
                market_type=written_range["market_type"],
            )
            bars = [
                BarData.from_storage_row(
                    row,
                    exchange=written_range["exchange"],
                    market_type=written_range["market_type"],
                )
                for row in rows
            ]

            if not bars:
                continue

            await self._bars_backfilled(
                written_range["symbol"],
                written_range["interval"],
                bars,
                exchange=written_range["exchange"],
                market_type=written_range["market_type"],
                event_detail={
                    "request_id": request.request_id,
                    "status": self._status_value(report.status),
                    "reason": request.reason,
                    "priority": request.priority,
                    "requester": request.requester,
                    "range_start_ms": written_range["start_ms"],
                    "range_end_ms": written_range["end_ms"],
                    "request_start_ms": request.start_ms,
                    "request_end_ms": request.end_ms,
                    "verified_contiguous": (
                        verification or {}
                    ).get("verified_contiguous"),
                    "remaining_missing_bars": (
                        verification or {}
                    ).get("remaining_missing_bars"),
                },
            )
            total_loaded += len(bars)

        return total_loaded

    async def _emit_completion_if_needed(
        self,
        request: RepairRequest,
        report: Any,
        bars_loaded: int,
        verification: dict[str, Any] | None = None,
    ) -> None:
        if bars_loaded > 0:
            return
        await self._emit_event(DataEvent(
            event_type=DataEventType.BACKFILL_COMPLETED,
            key=SeriesKey(
                request.symbol,
                request.interval,
                exchange=request.exchange,
                market_type=request.market_type,
            ),
            audience=audience_for_backfill_reason(request.reason),
            detail={
                "request_id": request.request_id,
                "status": self._status_value(report.status),
                "reason": request.reason,
                "priority": request.priority,
                "requester": request.requester,
                "bars_count": 0,
                "range_start_ms": request.start_ms,
                "range_end_ms": request.end_ms,
                "request_start_ms": request.start_ms,
                "request_end_ms": request.end_ms,
                "verified_contiguous": (
                    verification or {}
                ).get("verified_contiguous"),
                "remaining_missing_bars": (
                    verification or {}
                ).get("remaining_missing_bars"),
            },
        ))

    async def _emit_failed(
        self,
        request: RepairRequest,
        report: Any | None = None,
        error: str | None = None,
    ) -> None:
        await self._emit_event(DataEvent(
            event_type=DataEventType.BACKFILL_FAILED,
            key=SeriesKey(
                request.symbol,
                request.interval,
                exchange=request.exchange,
                market_type=request.market_type,
            ),
            detail={
                "request_id": request.request_id,
                "status": self._status_value(report.status) if report is not None else "failed",
                "reason": request.reason,
                "priority": request.priority,
                "requester": request.requester,
                "errors": report.errors if report is not None else ([error] if error else []),
            },
        ))

    async def _verify_request_range(
        self,
        request: RepairRequest,
        *,
        context: Any | None = None,
    ) -> dict[str, Any]:
        query_bars = getattr(self._storage, "query_bars", None)
        if not callable(query_bars):
            return {
                "verified_contiguous": None,
                "remaining_missing_bars": None,
            }

        interval_ms = parse_interval_ms(request.interval)
        if interval_ms is None or interval_ms <= 0 or request.start_ms > request.end_ms:
            return {
                "verified_contiguous": None,
                "remaining_missing_bars": None,
            }

        try:
            rows = await run_storage(
                query_bars,
                symbol=request.symbol,
                interval=request.interval,
                start_ms=request.start_ms,
                end_ms=request.end_ms,
                order="ASC",
                exchange=request.exchange,
                market_type=request.market_type,
            )
        except Exception as exc:
            logger.warning(
                "Backfill verification query failed for %s:%s:%s@%s %d-%d: %s",
                request.exchange,
                request.market_type,
                request.symbol,
                request.interval,
                request.start_ms,
                request.end_ms,
                exc,
            )
            return {
                "verified_contiguous": None,
                "remaining_missing_bars": None,
            }

        actual = {int(row["open_time"]) for row in rows}
        calendar = self._context_calendar(
            context,
            self._context_availability(context),
        )
        if calendar is None and self._history_service is not None:
            calendar = self._history_service.calendars.get(
                request.metadata.get("history_calendar_id")
            )
        if calendar is not None:
            try:
                expected_opens = set(calendar.expected_opens(
                    request.start_ms,
                    request.end_ms,
                    request.interval,
                ))
            except Exception as exc:
                logger.warning(
                    "Calendar verification failed for %s:%s:%s@%s: %s",
                    request.exchange,
                    request.market_type,
                    request.symbol,
                    request.interval,
                    exc,
                )
                return {
                    "verified_contiguous": None,
                    "remaining_missing_bars": None,
                }
        else:
            expected_opens: set[int] = set()
            current = int(request.start_ms)
            while current <= request.end_ms:
                expected_opens.add(current)
                current += interval_ms

        missing = len(expected_opens - actual)

        return {
            "verified_contiguous": missing == 0,
            "remaining_missing_bars": missing,
            "expected_bars": len(expected_opens),
            "actual_bars": len(actual),
        }

    def _ledger_upsert_detected(self, request: RepairRequest) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.upsert_detected(request, status="queued")
        except Exception:
            logger.exception("Gap ledger upsert failed for %s", request.request_id)

    def _ledger_mark_started(self, request: RepairRequest, *, attempt: int) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.mark_started(request, attempt=attempt)
        except Exception:
            logger.exception("Gap ledger start update failed for %s", request.request_id)

    def _ledger_mark_retry_wait(
        self,
        request: RepairRequest,
        *,
        attempt: int,
        error: str | None,
        delay_seconds: float,
    ) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.mark_retry_wait(
                request,
                attempt=attempt,
                error=error,
                next_retry_at=int(time.time() * 1000 + delay_seconds * 1000),
            )
        except Exception:
            logger.exception("Gap ledger retry update failed for %s", request.request_id)

    def _ledger_mark_verifying(self, request: RepairRequest) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.mark_verifying(request)
        except Exception:
            logger.exception("Gap ledger verifying update failed for %s", request.request_id)

    def _ledger_mark_verified(
        self,
        request: RepairRequest,
        report: Any,
        verification: dict[str, Any],
    ) -> None:
        if self._gap_ledger is None:
            return
        remaining = verification.get("remaining_missing_bars")
        if verification.get("verified_contiguous") is True:
            status = "filled"
            if remaining is None:
                remaining = 0
        elif self._total_bars_written(report) <= 0:
            status = "source_empty"
        else:
            status = "partial"

        try:
            self._gap_ledger.mark_resolved(
                request,
                status=status,
                missing_count=remaining,
                error=None,
            )
        except Exception:
            logger.exception("Gap ledger verified update failed for %s", request.request_id)

    def _ledger_mark_failed(self, request: RepairRequest, error: str | None) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.mark_resolved(
                request,
                status="failed",
                error=error,
            )
        except Exception:
            logger.exception("Gap ledger failure update failed for %s", request.request_id)

    def _should_skip_audited_gap(self, request: RepairRequest) -> bool:
        if self._gap_ledger is None:
            return False
        get_status = getattr(self._gap_ledger, "get_status", None)
        if not callable(get_status):
            return False
        try:
            status = get_status(request)
        except Exception:
            logger.exception("Gap ledger status lookup failed for %s", request.request_id)
            return False
        if not status:
            return False
        if status.get("status") != "source_empty":
            return False
        next_retry_at = status.get("next_retry_at")
        if next_retry_at is None:
            return True
        return int(next_retry_at) > int(time.time() * 1000)

    def _ledger_open_snapshot(self) -> list[dict[str, Any]]:
        if self._gap_ledger is None:
            return []
        list_open = getattr(self._gap_ledger, "list_open", None)
        if not callable(list_open):
            return []
        try:
            return list_open(limit=50)
        except Exception:
            logger.exception("Gap ledger open snapshot failed")
            return []

    def _complete(self, request: RepairRequest, outcome: RepairOutcome) -> None:
        self._retain_completed_outcome(request, outcome)
        future = self._futures.pop(request.request_id, None)
        if future is not None and not future.done():
            future.set_result(outcome)

    @staticmethod
    def _total_bars_written(report: Any) -> int:
        reconcile_result = getattr(report, "reconcile_result", None)
        if reconcile_result is None:
            return 0
        return int(getattr(reconcile_result, "bars_written", 0) or 0) + int(
            getattr(reconcile_result, "custom_bars_written", 0) or 0
        )

    @staticmethod
    def _report_fetch_results(report: Any) -> list[Any]:
        return list(getattr(report, "fetch_results", None) or [])

    @classmethod
    def _report_exhausted_before_ms(cls, report: Any) -> int | None:
        values = [
            int(value)
            for result in cls._report_fetch_results(report)
            if (value := getattr(result, "exhausted_before_ms", None)) is not None
        ]
        return min(values) if values else None

    @classmethod
    def _report_retryable(cls, report: Any) -> bool:
        return any(
            bool(getattr(result, "retryable", False))
            for result in cls._report_fetch_results(report)
        )

    async def _record_confirmed_left_boundary(
        self,
        request: RepairRequest,
        report: Any,
        *,
        context: Any | None,
    ) -> tuple[str | None, int | None]:
        """Persist only policy-authorised, non-retryable empty-page evidence."""
        empty_results = [
            result
            for result in self._report_fetch_results(report)
            if bool(getattr(result, "source_complete", False))
        ]
        if not empty_results:
            return None, None
        if self._report_retryable(report) or bool(getattr(report, "errors", None)):
            return None, None

        semantics = self._context_empty_page_semantics(context)
        if semantics is HistoryEmptyPageSemantics.UNKNOWN:
            return None, None

        boundary_ms = await self._left_boundary_value(
            request,
            report,
            context=context,
            allow_without_local_edge=(
                semantics is HistoryEmptyPageSemantics.TERMINAL_EXHAUSTION
            ),
        )
        if boundary_ms is None:
            return None, None

        if self._history_service is None:
            if semantics is HistoryEmptyPageSemantics.TERMINAL_EXHAUSTION:
                return "provider_exhausted", boundary_ms
            return None, None

        availability = self._context_availability(context)
        revision = availability.revision if availability is not None else ""
        try:
            if semantics is HistoryEmptyPageSemantics.TERMINAL_EXHAUSTION:
                record = self._history_service.record_boundary(
                    self._history_series_key(request),
                    BoundarySide.LEFT,
                    value_ms=boundary_ms,
                    reason=BoundaryReason.SOURCE_EXHAUSTED,
                    state=BoundaryState.CONFIRMED,
                    revision=revision,
                )
            else:
                record = self._history_service.record_boundary(
                    self._history_series_key(request),
                    BoundarySide.LEFT,
                    value_ms=boundary_ms,
                    reason=BoundaryReason.SOURCE_EXHAUSTED,
                    state=BoundaryState.CANDIDATE,
                    revision=revision,
                    promote_after=2,
                )
        except (RuntimeError, ValueError) as exc:
            logger.warning(
                "History boundary evidence rejected for %s:%s:%s@%s: %s",
                request.exchange,
                request.market_type,
                request.symbol,
                request.interval,
                exc,
            )
            return None, None

        if record.bound.state is not BoundaryState.CONFIRMED:
            return None, None
        return "provider_exhausted", record.bound.value_ms

    @staticmethod
    def _context_empty_page_semantics(
        context: Any | None,
    ) -> HistoryEmptyPageSemantics:
        value = getattr(context, "empty_page_semantics", None)
        if value is None:
            policy = (
                context
                if isinstance(context, HistoryAvailabilityPolicy)
                else getattr(context, "policy", None)
            )
            value = getattr(policy, "empty_page_semantics", None)
        try:
            return HistoryEmptyPageSemantics(value)
        except (TypeError, ValueError):
            return HistoryEmptyPageSemantics.UNKNOWN

    async def _left_boundary_value(
        self,
        request: RepairRequest,
        report: Any,
        *,
        context: Any | None,
        allow_without_local_edge: bool,
    ) -> int | None:
        reported = self._report_exhausted_before_ms(report)
        earliest: int | None = None
        get_bounds = getattr(self._storage, "get_bounds", None)
        if callable(get_bounds):
            try:
                bounds = await run_storage(
                    get_bounds,
                    request.symbol,
                    request.interval,
                    exchange=request.exchange,
                    market_type=request.market_type,
                )
                raw_earliest = (bounds or {}).get("earliest_open_time")
                if raw_earliest is not None:
                    earliest = int(raw_earliest)
            except Exception as exc:
                logger.warning(
                    "History boundary bounds lookup failed for %s:%s:%s@%s: %s",
                    request.exchange,
                    request.market_type,
                    request.symbol,
                    request.interval,
                    exc,
                )

        if reported is not None and (earliest is None or reported <= earliest):
            return reported
        if earliest is not None:
            if request.start_ms <= earliest <= request.end_ms:
                return earliest
            if request.end_ms < earliest and self._request_touches_left_edge(
                request,
                earliest,
                context=context,
            ):
                return earliest
        if not allow_without_local_edge:
            return None
        if request.reason not in {
            "initial_history",
            "visible_load_more",
            "query_left_gap",
            "query_shortfall",
        }:
            return None

        calendar = self._context_calendar(
            context,
            self._context_availability(context),
        )
        if calendar is not None:
            last = calendar.last_expected_open(
                request.start_ms,
                request.end_ms,
                request.interval,
            )
            if last is None:
                return None
            return calendar.next_expected_open(last, request.interval)
        interval_ms = parse_interval_ms(request.interval)
        return request.end_ms + interval_ms if interval_ms else None

    def _request_touches_left_edge(
        self,
        request: RepairRequest,
        earliest_ms: int,
        *,
        context: Any | None,
    ) -> bool:
        calendar = self._context_calendar(
            context,
            self._context_availability(context),
        )
        if calendar is not None:
            previous = calendar.previous_expected_open(
                earliest_ms,
                request.interval,
            )
            last = calendar.last_expected_open(
                request.start_ms,
                request.end_ms,
                request.interval,
            )
            return previous is not None and last == previous
        interval_ms = parse_interval_ms(request.interval)
        if interval_ms is None:
            return False
        return request.end_ms == earliest_ms - interval_ms

    def _written_ranges_for_request(
        self,
        request: RepairRequest,
        report: Any,
    ) -> list[dict[str, Any]]:
        raw_ranges = self._raw_written_ranges(report)
        ranges = [
            written_range
            for raw in raw_ranges
            if (written_range := self._normalize_written_range(raw)) is not None
            and written_range["exchange"] == request.exchange.lower().strip()
            and written_range["market_type"] == request.market_type.lower().strip()
            and written_range["symbol"] == request.symbol.upper().strip()
            and written_range["interval"] == request.interval
        ]
        if ranges:
            return ranges
        return [{
            "exchange": request.exchange.lower().strip(),
            "market_type": request.market_type.lower().strip(),
            "symbol": request.symbol.upper().strip(),
            "interval": request.interval,
            "start_ms": request.start_ms,
            "end_ms": request.end_ms,
        }]

    @staticmethod
    def _raw_written_ranges(report: Any) -> list[Any]:
        report_ranges = getattr(report, "written_ranges", None)
        if report_ranges:
            return list(report_ranges)
        reconcile_result = getattr(report, "reconcile_result", None)
        reconcile_ranges = (
            getattr(reconcile_result, "written_ranges", None)
            if reconcile_result is not None
            else None
        )
        return list(reconcile_ranges or [])

    @classmethod
    def _normalize_written_range(cls, raw: Any) -> dict[str, Any] | None:
        start_ms = cls._range_value(raw, "start_ms")
        end_ms = cls._range_value(raw, "end_ms")
        if start_ms is None or end_ms is None:
            return None
        return {
            "exchange": str(cls._range_value(raw, "exchange", "binance")).lower().strip(),
            "market_type": str(cls._range_value(raw, "market_type", "spot")).lower().strip(),
            "symbol": str(cls._range_value(raw, "symbol", "")).upper().strip(),
            "interval": cls._range_value(raw, "interval", ""),
            "start_ms": int(start_ms),
            "end_ms": int(end_ms),
        }

    @staticmethod
    def _range_value(raw: Any, key: str, default: Any = None) -> Any:
        if isinstance(raw, dict):
            return raw.get(key, default)
        return getattr(raw, key, default)

    def _backoff(self, attempt: int) -> float:
        return self._base_delay_seconds * (3 ** (attempt - 1))

    @staticmethod
    def _status_value(status: Any) -> str:
        return getattr(status, "value", str(status))

    @classmethod
    def _is_failed(cls, status: Any) -> bool:
        return cls._status_value(status) == "failed"
