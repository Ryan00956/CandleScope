"""Backfill request coordination for DataManager."""
from __future__ import annotations

import asyncio
import heapq
import json
import logging
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.core.executors import run_storage
from app.data_engine.history.calendar import (
    TradingCalendar,
    expected_bucket_end_ms,
    latest_closed_expected_open_ms,
)
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
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    last_closed_bar_open_ms,
    parse_interval_ms,
)
from app.data_engine.interval_resolution import IntervalPurpose, IntervalResolver
from app.data_engine.interval_work_plan import (
    IntervalWorkPlan,
    resolve_interval_work_plan,
)
from app.data_engine.kline_quality import (
    repair_requires_trusted_finality,
    source_is_trusted_final,
)
from app.exchanges.models import (
    HistoryAvailabilityPolicy,
    HistoryEmptyPageSemantics,
)
from app.exchanges.rate_limits import RateLimitDeferred
from .models import BarData, DataEvent, DataEventType, SeriesKey, audience_for_backfill_reason

logger = logging.getLogger("data_manager.backfill_coordinator")


BACKFILL_REASON_PRIORITIES: dict[str, int] = {
    "initial_history": 10,
    "visible_load_more": 20,
    "visible_range_gap": 20,
    "visible_seed_gap": 25,
    "tail_gap": 25,
    "latest_refresh": 30,
    "query_gap": 35,
    "query_empty": 35,
    "query_tail_gap": 35,
    "query_left_gap": 35,
    "query_shortfall": 35,
    "query_interior_gap": 35,
    "price_daily_open": 70,
    "active_history_hydration": 90,
    "related_interval_warmup": 100,
    "full_subscription_warmup": 110,
    "startup_gap_scan": 140,
    "background_gap_audit": 160,
}

_BACKGROUND_BACKFILL_REASONS = frozenset({
    "active_history_hydration",
    "related_interval_warmup",
    "full_subscription_warmup",
    "startup_gap_scan",
    "background_gap_audit",
})

# Public API waits are capped at eight seconds, so one minute preserves useful
# late-wait resolution while the count limits protect a long-running process.
_SCHEDULER_OUTCOME_HISTORY_LIMIT = 256
_COORDINATOR_OUTCOME_HISTORY_LIMIT = 512
_REQUEST_ID_ALIAS_HISTORY_LIMIT = 2048
_RETAINED_OUTCOME_TTL_SECONDS = 60.0
_LEDGER_STALE_AFTER_MS = 15 * 60 * 1000
_MAX_MERGED_REQUEST_IDS = 32
_MAX_MERGED_REASON_PARTS = 8
_MAX_DERIVED_REPAIR_TARGETS = 32
_LEDGER_COMPACTION_INTERVAL_SECONDS = 60 * 60
_TERMINAL_LEDGER_RETRY_MS = 24 * 60 * 60 * 1000
_TAIL_AUDIT_LOOKBACK_BARS = 1_000
_LEDGER_RECONCILE_MAX_PAGES_PER_RANGE = 20
_LEDGER_RECONCILE_MAX_TOTAL_PAGES = 40
_LEDGER_RECONCILIATION_SNAPSHOT_KEY = "_ledger_reconciliation_snapshot"


def priority_for_reason(reason: str | None, default: int = 100) -> int:
    """Return the scheduler priority for a demand reason."""
    return BACKFILL_REASON_PRIORITIES.get(str(reason or "").strip(), default)


def _decode_metadata_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return dict(decoded) if isinstance(decoded, dict) else {}


def _merge_derived_repair_targets(*values: Any) -> list[dict[str, Any]]:
    """Normalize and stably dedupe derived-series completion targets."""
    merged: dict[tuple[str, int, int], dict[str, Any]] = {}
    for value in values:
        if not isinstance(value, (list, tuple)):
            continue
        for raw in value:
            if not isinstance(raw, dict):
                continue
            interval = str(raw.get("interval") or "").strip()
            try:
                start_ms = int(raw["start_ms"])
                end_ms = int(raw["end_ms"])
            except (KeyError, TypeError, ValueError):
                continue
            if not interval or start_ms > end_ms:
                continue
            identity = (interval, start_ms, end_ms)
            merged.setdefault(identity, {
                "interval": interval,
                "start_ms": start_ms,
                "end_ms": end_ms,
            })
    return list(merged.values())[-_MAX_DERIVED_REPAIR_TARGETS:]


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
        if (
            repair_requires_trusted_finality(self.metadata, reason=self.reason)
            or repair_requires_trusted_finality(other.metadata, reason=other.reason)
        ):
            metadata["requires_trusted_finality"] = True
        derived_targets = _merge_derived_repair_targets(
            self.metadata.get("derived_repair_targets"),
            other.metadata.get("derived_repair_targets"),
        )
        if derived_targets:
            metadata["derived_repair_targets"] = derived_targets
        else:
            metadata.pop("derived_repair_targets", None)
        planned_ranges = self._merged_history_fetch_ranges(other)
        if planned_ranges:
            metadata["history_fetch_ranges"] = planned_ranges
        raw_merged_ids = metadata.get("merged_request_ids")
        merged_ids = list(raw_merged_ids) if isinstance(raw_merged_ids, list) else []
        merged_ids.extend((self.request_id, other.request_id))
        metadata["merged_request_ids"] = list(dict.fromkeys(
            str(item) for item in merged_ids if item
        ))[-_MAX_MERGED_REQUEST_IDS:]
        reason_parts: list[str] = []
        for raw_reason in (self.reason, other.reason):
            for part in str(raw_reason or "").split("+"):
                normalized = part.strip()
                if normalized and normalized not in reason_parts:
                    reason_parts.append(normalized)
                if len(reason_parts) >= _MAX_MERGED_REASON_PARTS:
                    break
            if len(reason_parts) >= _MAX_MERGED_REASON_PARTS:
                break
        merged_reason = "+".join(reason_parts) or "query_gap"
        return RepairRequest(
            symbol=self.symbol,
            interval=self.interval,
            start_ms=min(self.start_ms, other.start_ms),
            end_ms=max(self.end_ms, other.end_ms),
            exchange=self.exchange,
            market_type=self.market_type,
            reason=merged_reason,
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
    retry_at_ms: int | None = None
    suppressed: bool = False
    ledger_status: str | None = None
    suppression: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class RepairReconcileSummary:
    """Small reconciliation payload retained after a repair completes."""

    bars_received: int = 0
    bars_written: int = 0
    bars_skipped: int = 0
    bars_deduplicated: int = 0
    custom_bars_generated: int = 0
    custom_bars_written: int = 0
    bars_cached: int = 0
    write_errors: int = 0
    failed_batch_count: int = 0
    written_range_count: int = 0
    elapsed_ms: int = 0


@dataclass(frozen=True, slots=True)
class RepairWrittenRangeSummary:
    exchange: str
    market_type: str
    symbol: str
    interval: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True, slots=True)
class RepairReportSummary:
    """Report statistics retained without FetchResult bar payloads."""

    status: Any
    errors: tuple[str, ...]
    error_count: int
    reconcile_result: RepairReconcileSummary | None
    fetch_result_count: int
    fetched_bar_count: int
    written_range_count: int
    written_ranges: tuple[RepairWrittenRangeSummary, ...]
    elapsed_ms: int


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
    ledger_scanned: int = 0
    ledger_resolved: int = 0
    ledger_requeued: int = 0
    ledger_compacted: int = 0
    ledger_skipped: int = 0
    ledger_failed: int = 0

    def to_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "repaired": self.repaired,
            "queued": self.queued,
            "failed": self.failed,
            "errors": list(self.errors),
            "ledger_scanned": self.ledger_scanned,
            "ledger_resolved": self.ledger_resolved,
            "ledger_requeued": self.ledger_requeued,
            "ledger_compacted": self.ledger_compacted,
            "ledger_skipped": self.ledger_skipped,
            "ledger_failed": self.ledger_failed,
        }


@dataclass(slots=True)
class LedgerReconciliationReport:
    """Result of verifying stale ledger decisions against stored K-lines."""

    scanned: int = 0
    resolved: int = 0
    requeued: int = 0
    compacted: int = 0
    skipped: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)


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
    queue_sequence: int = 0
    eligible_at_monotonic: float = 0.0
    retry_at_ms: int | None = None
    defer_reason: str | None = None
    rate_limit_bucket: str | None = None
    defer_count: int = 0


@dataclass(frozen=True, slots=True)
class _DemandLease:
    owner_id: str
    scope: str | None = None
    generation: int | None = None


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
    demand_leases: dict[str, _DemandLease] = field(default_factory=dict)
    persistent_interest: bool = False
    cancel_requested: bool = False
    cancel_reason: str | None = None
    progress_revision: int = 0

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
        finalize: Callable[[RepairRequest, RepairOutcome], Awaitable[None]],
        on_queued: Callable[[RepairRequest], None],
        on_progress: Callable[[RepairRequest, dict[str, Any]], None] | None = None,
        max_concurrency: int = 4,
        chunk_bars: int = 1000,
    ) -> None:
        self._execute = execute
        self._future_for = future_for
        self._complete = complete
        self._finalize = finalize
        self._on_queued = on_queued
        self._on_progress = on_progress
        self._max_concurrency = max(1, max_concurrency)
        self._chunk_bars = max(1, chunk_bars)
        self._interval_resolver = IntervalResolver()

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
        self._last_foreground_activity_at = 0.0
        self._active_foreground_chunks: set[str] = set()
        self._active_background_chunks: set[str] = set()
        self._last_dispatch_owner: dict[tuple[int, bool], str] = {}

        self.submitted = 0
        self.deduped = 0
        self.merged = 0
        self.rate_limited_skips = 0
        self.exchange_rate_limit_deferrals = 0
        self.priority_promotions = 0
        self.cancelled_pending = 0
        self.cancelled_after_chunk = 0
        self.background_dispatches = 0
        self.covered_chunks_skipped = 0
        self.fairness_rotations = 0

    def submit(self, request: RepairRequest) -> tuple[str, asyncio.Future[RepairOutcome]]:
        if self._shutdown:
            raise RuntimeError("BackfillCoordinator is shut down")
        if repair_requires_trusted_finality(
            request.metadata,
            reason=request.reason,
        ):
            # Normalize legacy reason-only demand into the durable merge-safe
            # contract before any covering/dedupe decision is made.
            request.metadata["requires_trusted_finality"] = True

        self.submitted += 1
        if not self._is_background(request):
            self._last_foreground_activity_at = time.monotonic()
        series_key = request.series_key
        series = self._series.setdefault(series_key, _SeriesState())

        active_state = self._requests.get(series.active or "")
        if (
            active_state is not None
            and not active_state.stale
            and not active_state.cancel_requested
            and self._can_coalesce(active_state.request, request)
            and self._covers(active_state.request, request)
            and not self._requires_stronger_finality(
                active_state.request,
                request,
            )
        ):
            self._merge_request_interest(active_state, request)
            self.deduped += 1
            # A background parent can become foreground demand here.  That
            # changes the global background-slot admission decision even when
            # this exact series is already active, so re-evaluate the queue.
            self._drain()
            return active_state.request.request_id, active_state.future

        for request_id in list(series.pending):
            state = self._requests.get(request_id)
            if state is None or state.stale:
                continue
            if self._can_coalesce(state.request, request) and self._covers(
                state.request,
                request,
            ):
                stronger_finality = self._requires_stronger_finality(
                    state.request,
                    request,
                )
                if stronger_finality and state.completed > 0:
                    # Completed chunks ran under the weaker contract and no
                    # longer exist to upgrade in place.  Keep this ordinary
                    # parent and enqueue a full authoritative successor.
                    continue
                upgraded_finality = self._merge_request_interest(state, request)
                if upgraded_finality:
                    # Persist the stronger contract for crash recovery.  The
                    # original queued ledger snapshot predates this upgrade.
                    self._on_queued(state.request)
                    self._publish_progress(
                        state,
                        status="trusted_finality_upgraded",
                    )
                self.deduped += 1
                # Pending background work may have just been promoted to
                # foreground demand.  It is now runnable in a spare slot and
                # must not wait for an unrelated active chunk to finish.
                self._drain()
                return state.request.request_id, state.future
            if state.completed == 0 and self._should_merge(state.request, request):
                state.request = state.request.merged_with(request)
                incoming_leases = self._demand_leases_from_request(request)
                state.demand_leases.update(incoming_leases)
                if not incoming_leases:
                    state.persistent_interest = True
                self._replace_pending_chunks(state)
                self._on_queued(state.request)
                self._publish_progress(state, status="merged")
                self.merged += 1
                # _replace_pending_chunks rebuilds the ready work.  A merge
                # may occur while the only active task is stalled upstream,
                # so explicitly wake the scheduler for the replacement.
                self._drain()
                return state.request.request_id, state.future

        future = self._future_for(request)
        demand_leases = self._demand_leases_from_request(request)
        state = _RequestState(
            request=request,
            future=future,
            chunk_ids=[],
            demand_leases=demand_leases,
            persistent_interest=not bool(demand_leases),
        )
        self._requests[request.request_id] = state
        series.pending.append(request.request_id)
        self._on_queued(request)
        self._replace_pending_chunks(state)
        self._publish_progress(state, status="queued")
        self._drain()
        return request.request_id, future

    def _merge_request_interest(
        self,
        state: _RequestState,
        request: RepairRequest,
    ) -> bool:
        self._merge_derived_targets_into_state(state, request)
        incoming_leases = self._demand_leases_from_request(request)
        state.demand_leases.update(incoming_leases)
        if not incoming_leases:
            state.persistent_interest = True
        current_requires_trusted_finality = repair_requires_trusted_finality(
            state.request.metadata,
            reason=state.request.reason,
        )
        incoming_requires_trusted_finality = repair_requires_trusted_finality(
            request.metadata,
            reason=request.reason,
        )
        requires_trusted_finality = (
            current_requires_trusted_finality
            or incoming_requires_trusted_finality
        )
        upgraded_finality = (
            incoming_requires_trusted_finality
            and not current_requires_trusted_finality
        )
        if requires_trusted_finality:
            state.request.metadata["requires_trusted_finality"] = True
        reasons = [
            part.strip()
            for raw in (state.request.reason, request.reason)
            for part in str(raw or "").split("+")
            if part.strip()
        ]
        state.request.reason = "+".join(dict.fromkeys(reasons))
        if state.request.requester != request.requester:
            state.request.requester = "mixed"
        incoming_priority = int(request.priority or 100)
        current_priority = int(state.request.priority or 100)
        promoted = incoming_priority < current_priority
        if promoted:
            state.request.priority = incoming_priority
            self.priority_promotions += 1
        chunk_ids: Iterable[str] = state.chunk_ids
        if promoted and self._newest_first(state.request):
            chunk_ids = reversed(state.chunk_ids)
        if promoted:
            # Priority queues do not support an in-place key update.  Remove
            # each old heap item before inserting the promoted chunk; leaving
            # both entries inflates ready diagnostics and can repeatedly skip
            # the same physical chunk while its series is active.
            promoted_chunk_ids = {
                chunk_id
                for chunk_id in state.chunk_ids
                if chunk_id not in self._tasks and chunk_id in self._chunks
            }
            if promoted_chunk_ids:
                self._ready = [
                    item for item in self._ready if item[3] not in promoted_chunk_ids
                ]
                heapq.heapify(self._ready)
        for chunk_id in chunk_ids:
            if chunk_id in self._tasks and not self._is_background(state.request):
                self._active_background_chunks.discard(chunk_id)
                self._active_foreground_chunks.add(chunk_id)
            chunk = self._chunks.get(chunk_id)
            if chunk is None:
                continue
            chunk.request.reason = state.request.reason
            chunk.request.requester = state.request.requester
            if requires_trusted_finality:
                chunk.request.metadata["requires_trusted_finality"] = True
            if promoted:
                chunk.request.priority = incoming_priority
            if promoted and chunk_id not in self._tasks:
                self._push_ready(chunk)
        if promoted:
            self._publish_progress(state, status="priority_promoted")
        return upgraded_finality

    @staticmethod
    def _demand_leases_from_request(
        request: RepairRequest,
    ) -> dict[str, _DemandLease]:
        metadata = request.metadata or {}
        owner_id = str(metadata.get("demand_owner_id") or "").strip()
        if not owner_id:
            return {}
        scope_raw = metadata.get("demand_scope")
        scope = str(scope_raw).strip() if scope_raw is not None else None
        generation_raw = metadata.get("demand_generation")
        try:
            generation = int(generation_raw) if generation_raw is not None else None
        except (TypeError, ValueError):
            generation = None
        lease = _DemandLease(
            owner_id=owner_id,
            scope=scope or None,
            generation=generation,
        )
        return {owner_id: lease}

    @staticmethod
    def _requires_stronger_finality(
        current: RepairRequest,
        incoming: RepairRequest,
    ) -> bool:
        """Return whether an active ordinary repair cannot satisfy incoming."""
        return (
            repair_requires_trusted_finality(
                incoming.metadata,
                reason=incoming.reason,
            )
            and not repair_requires_trusted_finality(
                current.metadata,
                reason=current.reason,
            )
        )

    def _merge_derived_targets_into_state(
        self,
        state: _RequestState,
        request: RepairRequest,
    ) -> None:
        targets = _merge_derived_repair_targets(
            state.request.metadata.get("derived_repair_targets"),
            request.metadata.get("derived_repair_targets"),
        )
        if not targets:
            return
        state.request.metadata["derived_repair_targets"] = targets
        # Active chunks carry their own metadata copy.  Update it in place so
        # a late deduped custom consumer is present on the completion emitted
        # by work that is already running.
        for chunk_id in state.chunk_ids:
            chunk = self._chunks.get(chunk_id)
            if chunk is not None:
                chunk.request.metadata["derived_repair_targets"] = [
                    dict(target) for target in targets
                ]

    def acquire_demand(
        self,
        request_id: str,
        *,
        owner_id: str,
        scope: str | None = None,
        generation: int | None = None,
    ) -> bool:
        state = self._requests.get(request_id)
        normalized_owner = str(owner_id or "").strip()
        if state is None or state.stale or not normalized_owner:
            return False
        state.demand_leases[normalized_owner] = _DemandLease(
            owner_id=normalized_owner,
            scope=str(scope).strip() if scope is not None and str(scope).strip() else None,
            generation=int(generation) if generation is not None else None,
        )
        self._publish_progress(state, status="demand_acquired")
        return True

    async def release_demand(
        self,
        request_id: str,
        *,
        owner_id: str,
        cancel_if_unobserved: bool,
        reason: str = "demand_released",
    ) -> bool:
        state = self._requests.get(request_id)
        if state is None:
            return False
        state.demand_leases.pop(str(owner_id or "").strip(), None)
        if (
            state.demand_leases
            or state.persistent_interest
            or not cancel_if_unobserved
        ):
            self._publish_progress(state, status="demand_released")
            return False
        return await self._request_cancel(state, reason=reason)

    async def supersede_scope(self, scope: str, generation: int) -> int:
        normalized_scope = str(scope or "").strip()
        if not normalized_scope:
            return 0
        superseded = 0
        pending_finalizers: list[
            tuple[_RequestState, RepairOutcome, _SeriesState | None]
        ] = []
        for state in list(self._requests.values()):
            old_owners = [
                owner_id
                for owner_id, lease in state.demand_leases.items()
                if lease.scope == normalized_scope
                and lease.generation is not None
                and lease.generation < int(generation)
            ]
            if not old_owners:
                continue
            for owner_id in old_owners:
                state.demand_leases.pop(owner_id, None)
            if not state.demand_leases and not state.persistent_interest:
                started, final, series = self._begin_request_cancel(
                    state,
                    reason=f"scope_superseded:{normalized_scope}:{generation}",
                )
                if started:
                    superseded += 1
                if final is not None:
                    pending_finalizers.append((state, final, series))
        if pending_finalizers:
            await asyncio.gather(*(
                self._finish_pending_cancellation(state, final, series)
                for state, final, series in pending_finalizers
            ))
        return superseded

    async def revoke_owner(self, owner_id: str, *, reason: str) -> int:
        normalized_owner = str(owner_id or "").strip()
        if not normalized_owner:
            return 0
        revoked = 0
        pending_finalizers: list[
            tuple[_RequestState, RepairOutcome, _SeriesState | None]
        ] = []
        for state in list(self._requests.values()):
            if normalized_owner not in state.demand_leases:
                continue
            state.demand_leases.pop(normalized_owner, None)
            revoked += 1
            if not state.demand_leases and not state.persistent_interest:
                _started, final, series = self._begin_request_cancel(
                    state,
                    reason=reason,
                )
                if final is not None:
                    pending_finalizers.append((state, final, series))
            else:
                self._publish_progress(state, status="demand_revoked")
        if pending_finalizers:
            await asyncio.gather(*(
                self._finish_pending_cancellation(state, final, series)
                for state, final, series in pending_finalizers
            ))
        return revoked

    async def _request_cancel(self, state: _RequestState, *, reason: str) -> bool:
        started, final, series = self._begin_request_cancel(state, reason=reason)
        if final is not None:
            await self._finish_pending_cancellation(state, final, series)
        return started

    def _begin_request_cancel(
        self,
        state: _RequestState,
        *,
        reason: str,
    ) -> tuple[bool, RepairOutcome | None, _SeriesState | None]:
        """Synchronously revoke scheduler ownership before durable finalization."""
        if state.cancel_requested or state.future.done():
            return False, None, None
        state.cancel_requested = True
        state.cancel_reason = reason
        self._discard_remaining_chunks(state)
        series = self._series.get(state.request.series_key)
        is_active = bool(series is not None and series.active == state.request.request_id)
        if is_active:
            self.cancelled_after_chunk += 1
            self._publish_progress(state, status="cancelling_after_chunk")
            return True, None, series

        if series is not None and state.request.request_id in series.pending:
            series.pending.remove(state.request.request_id)
        self.cancelled_pending += 1
        final = self._cancelled_outcome(state)
        return True, final, series

    async def _finish_pending_cancellation(
        self,
        state: _RequestState,
        final: RepairOutcome,
        series: _SeriesState | None,
    ) -> None:
        """Durably finalize a cancellation after all target states are inert."""
        try:
            try:
                await self._finalize(state.request, final)
            except Exception:
                logger.exception(
                    "Backfill cancellation finalization failed for %s",
                    state.request.request_id,
                )
        finally:
            # Cancellation of the caller is allowed to interrupt durable
            # finalization, but it must never leave a stale scheduler state or
            # unresolved shared future behind.
            self._retain_outcome(state.request.request_id, final)
            self._complete(state.request, final)
            self._publish_progress(state, status="cancelled", terminal=True)
            self._requests.pop(state.request.request_id, None)
            series_key = state.request.series_key
            if (
                series is not None
                and self._series.get(series_key) is series
                and not series.pending
                and series.active is None
            ):
                self._series.pop(series_key, None)
            self._drain()

    @staticmethod
    def _cancelled_outcome(state: _RequestState) -> RepairOutcome:
        return RepairOutcome(
            request=state.request,
            status="cancelled",
            attempts=state.attempts,
            bars_loaded=state.bars_loaded,
            verified_contiguous=False,
            error=state.cancel_reason or "demand_released",
            terminal_reason="demand_released",
            retryable=True,
        )

    def _publish_progress(
        self,
        state: _RequestState,
        *,
        status: str,
        terminal: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        callback = self._on_progress
        if callback is None:
            return
        payload: dict[str, Any] = {
            "request_id": state.request.request_id,
            "revision": state.progress_revision,
            "status": status,
            "terminal": bool(terminal),
            "completed_chunks": state.completed,
            "total_chunks": state.total,
            "pending_chunks": state.pending_count,
            "bars_loaded": state.bars_loaded,
            "priority": state.request.priority,
            "demand_count": len(state.demand_leases),
            "persistent_interest": state.persistent_interest,
            "cancel_requested": state.cancel_requested,
            "updated_at_ms": int(time.time() * 1000),
        }
        if details:
            payload.update(details)
        callback(state.request, payload)

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
        now_monotonic = time.monotonic()
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

        deferred = [
            {
                "chunk_id": chunk.chunk_id,
                "request_id": chunk.parent_id,
                "series": ":".join(chunk.request.series_key),
                "priority": chunk.request.priority,
                "sequence": chunk.sequence,
                "retry_at_ms": chunk.retry_at_ms,
                "retry_in_ms": max(
                    0,
                    int((chunk.eligible_at_monotonic - now_monotonic) * 1000),
                ),
                "reason": chunk.defer_reason,
                "bucket_key": chunk.rate_limit_bucket,
                "defer_count": chunk.defer_count,
                "fairness_owner": self._fairness_owner(chunk.request),
            }
            for chunk in self._chunks.values()
            if chunk.eligible_at_monotonic > now_monotonic
        ]

        return {
            "submitted": self.submitted,
            "deduped": self.deduped,
            "merged": self.merged,
            "priority_promotions": self.priority_promotions,
            "cancelled_pending": self.cancelled_pending,
            "cancelled_after_chunk": self.cancelled_after_chunk,
            "background_dispatches": self.background_dispatches,
            "covered_chunks_skipped": self.covered_chunks_skipped,
            "fairness_rotations": self.fairness_rotations,
            "running_background_chunks": self._running_background_count(),
            "active": active,
            "pending": pending,
            "ready_chunks": len(self._ready),
            "running_chunks": len(self._tasks),
            "max_concurrency": self._max_concurrency,
            "next_drain_in_ms": self._next_drain_in_ms(),
            "rate_limited_skips": self.rate_limited_skips,
            "exchange_rate_limit_deferrals": self.exchange_rate_limit_deferrals,
            "deferred_chunks": len(deferred),
            "deferred": sorted(
                deferred,
                key=lambda item: (int(item["retry_at_ms"] or 0), item["chunk_id"]),
            ),
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
        replaced_chunk_ids = set(state.chunk_ids)
        for chunk_id in replaced_chunk_ids:
            self._chunks.pop(chunk_id, None)
        if replaced_chunk_ids:
            self._ready = [
                item for item in self._ready if item[3] not in replaced_chunk_ids
            ]
            heapq.heapify(self._ready)
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
        work_plan = self._source_aware_chunk_plan(request, self._chunk_bars)
        target_chunk_bars = max(1, int(work_plan.effective_target_bars or 1))
        chunk_span = interval_ms * target_chunk_bars
        chunks: list[_FetchChunk] = []
        sequence = 0
        for planned_start, planned_end in self._planned_ranges(request):
            start = planned_start
            while start <= planned_end:
                chunk_end = min(planned_end, start + chunk_span - interval_ms)
                actual_target_bars = max(1, (chunk_end - start) // interval_ms + 1)
                chunk_work_plan = self._source_aware_chunk_plan(
                    request,
                    actual_target_bars,
                    source_row_budget=work_plan.source_row_budget,
                )
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
                        **chunk_work_plan.to_metadata(),
                        "parent_request_id": request.request_id,
                        "chunk_sequence": sequence,
                        "ledger_range": {
                            "start_ms": int(request.start_ms),
                            "end_ms": int(request.end_ms),
                        },
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

    def _source_aware_chunk_plan(
        self,
        request: RepairRequest,
        requested_target_bars: int,
        *,
        source_row_budget: int | None = None,
    ) -> IntervalWorkPlan:
        budget = self._chunk_bars if source_row_budget is None else source_row_budget
        try:
            plan = resolve_interval_work_plan(
                self._interval_resolver,
                exchange=request.exchange,
                market_type=request.market_type,
                interval=request.interval,
                requested_target_bars=max(1, int(requested_target_bars)),
                source_row_budget=budget,
                source_padding_bars=3,
                purpose=IntervalPurpose.HISTORY,
            )
            if plan.effective_target_bars > 0:
                return plan
            # One derived candle can legitimately exceed the ordinary source
            # page size (for example a monthly target sourced from minutes).
            # Admit exactly one target with an explicit, finite source budget
            # instead of falling back to the old unbounded target chunk.
            minimum_budget = max(1, (plan.source_padding_bars + 1) * plan.source_factor)
            return resolve_interval_work_plan(
                self._interval_resolver,
                exchange=request.exchange,
                market_type=request.market_type,
                interval=request.interval,
                requested_target_bars=1,
                source_row_budget=minimum_budget,
                source_padding_bars=plan.source_padding_bars,
                purpose=IntervalPurpose.HISTORY,
            )
        except Exception:
            logger.debug(
                "Source-aware chunk planning fell back to native sizing for %s@%s",
                request.symbol,
                request.interval,
                exc_info=True,
            )
            requested = max(1, int(requested_target_bars))
            return IntervalWorkPlan(
                requested_target_bars=requested,
                effective_target_bars=requested,
                base_interval=request.interval,
                source_factor=1,
                source_padding_bars=0,
                planned_source_rows=requested,
                source_row_budget=budget,
                budget_limited=False,
                derived=False,
            )

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
        reasons = {
            part.strip()
            for part in str(request.reason or "").split("+")
            if part.strip()
        }
        return bool(reasons & {
            "initial_history",
            "active_history_hydration",
            "visible_load_more",
            "visible_range_gap",
            "visible_seed_gap",
            "tail_gap",
            "latest_refresh",
        })

    def _push_ready(
        self,
        chunk: _FetchChunk,
        *,
        preserve_sequence: bool = False,
    ) -> None:
        if not preserve_sequence or chunk.queue_sequence <= 0:
            self._seq += 1
            chunk.queue_sequence = self._seq
        heapq.heappush(
            self._ready,
            (
                int(chunk.request.priority or 100),
                int(chunk.request.metadata.get("created_at_ms", 0) or 0),
                chunk.queue_sequence,
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
                now_monotonic = time.monotonic()
                if chunk.eligible_at_monotonic > now_monotonic:
                    delay = chunk.eligible_at_monotonic - now_monotonic
                    next_delay = delay if next_delay is None else min(next_delay, delay)
                    skipped.append(item)
                    continue
                series = self._series.setdefault(chunk.request.series_key, _SeriesState())
                if series.active is not None:
                    skipped.append(item)
                    continue
                if self._is_background(chunk.request) and (
                    self._running_background_count() >= 1
                    or self._has_foreground_work(skipped)
                ):
                    skipped.append(item)
                    continue
                fairness_lane = (
                    int(chunk.request.priority or 100),
                    self._is_background(chunk.request),
                )
                fairness_owner = self._fairness_owner(chunk.request)
                if (
                    self._last_dispatch_owner.get(fairness_lane) == fairness_owner
                    and self._has_fairness_alternative(chunk, lane=fairness_lane)
                ):
                    self.fairness_rotations += 1
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

                chunk.eligible_at_monotonic = 0.0
                chunk.retry_at_ms = None
                chunk.defer_reason = None
                chunk.rate_limit_bucket = None
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
                self._last_dispatch_owner[fairness_lane] = fairness_owner
                if self._is_background(chunk.request):
                    self._active_background_chunks.add(chunk.chunk_id)
                    self.background_dispatches += 1
                else:
                    self._active_foreground_chunks.add(chunk.chunk_id)
                task.add_done_callback(
                    lambda _task, chunk_id=chunk.chunk_id: (
                        self._active_foreground_chunks.discard(chunk_id),
                        self._active_background_chunks.discard(chunk_id),
                    )
                )
        finally:
            for item in skipped:
                heapq.heappush(self._ready, item)
            if next_delay is not None and self._ready:
                self._schedule_drain(next_delay)
            elif not self._ready:
                self._cancel_drain_timer()

    @staticmethod
    def _is_background(request: RepairRequest) -> bool:
        reasons = {
            part.strip()
            for part in str(request.reason or "").split("+")
            if part.strip()
        }
        return bool(reasons) and reasons.issubset(_BACKGROUND_BACKFILL_REASONS)

    def _running_background_count(self) -> int:
        return len(self._active_background_chunks)

    @staticmethod
    def _fairness_owner(request: RepairRequest) -> str:
        """Return a stable app/window/cell owner for equal-priority rotation."""
        metadata = request.metadata or {}
        structured = [
            str(metadata.get(key) or "").strip()
            for key in ("app_id", "workspace_id", "window_id", "cell_id")
        ]
        if any(structured):
            return "/".join(value or "_" for value in structured)
        demand_scope = str(metadata.get("demand_scope") or "").strip()
        if demand_scope:
            return demand_scope
        return f"{request.requester}:{':'.join(request.series_key)}"

    def _has_fairness_alternative(
        self,
        current: _FetchChunk,
        *,
        lane: tuple[int, bool],
    ) -> bool:
        current_owner = self._fairness_owner(current.request)
        now = time.monotonic()
        for item in self._ready:
            if int(item[0]) != lane[0]:
                continue
            candidate = self._chunks.get(item[3])
            if candidate is None or candidate.eligible_at_monotonic > now:
                continue
            if self._is_background(candidate.request) != lane[1]:
                continue
            state = self._requests.get(candidate.parent_id)
            if state is None or state.stale or state.failed is not None:
                continue
            series = self._series.get(candidate.request.series_key)
            if series is not None and series.active is not None:
                continue
            if self._fairness_owner(candidate.request) != current_owner:
                return True
        return False

    def _has_foreground_active(self) -> bool:
        return bool(self._active_foreground_chunks)

    def _has_foreground_work(
        self,
        extra: Iterable[tuple[int, int, int, str]] = (),
    ) -> bool:
        if self._has_foreground_active():
            return True
        for item in (*self._ready, *tuple(extra)):
            chunk = self._chunks.get(item[3])
            if chunk is None or self._is_background(chunk.request):
                continue
            state = self._requests.get(chunk.parent_id)
            if state is not None and not state.stale and state.failed is None:
                return True
        return False

    def has_foreground_work(self) -> bool:
        """Return whether unresolved user-visible work owns the scheduler.

        Rate-deferred foreground chunks still count: speculative warmup must
        not consume another exchange or worker budget merely because the
        visible request is waiting for its exact Retry-After deadline.
        """

        return self._has_foreground_work()

    def foreground_idle_seconds(self) -> float:
        if self.has_foreground_work():
            return 0.0
        if self._last_foreground_activity_at <= 0:
            return float("inf")
        return max(0.0, time.monotonic() - self._last_foreground_activity_at)

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
        foreground_chunk = not self._is_background(chunk.request)
        if foreground_chunk:
            self._active_foreground_chunks.add(chunk.chunk_id)
        else:
            self._active_background_chunks.add(chunk.chunk_id)
        try:
            try:
                outcome = await self._execute(chunk.request)
            except RateLimitDeferred as exc:
                await self._defer_chunk(chunk, exc)
                return
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
            await self._finish_chunk(chunk, outcome)
        finally:
            if foreground_chunk or not self._is_background(chunk.request):
                self._last_foreground_activity_at = time.monotonic()
            self._active_foreground_chunks.discard(chunk.chunk_id)
            self._active_background_chunks.discard(chunk.chunk_id)
            self._tasks.pop(chunk.chunk_id, None)
            self._drain()

    async def _defer_chunk(
        self,
        chunk: _FetchChunk,
        exc: RateLimitDeferred,
    ) -> None:
        """Return quota-blocked work to the ready heap without completing it."""

        state = self._requests.get(chunk.parent_id)
        series = self._series.get(chunk.request.series_key)
        if series is not None and series.active == chunk.parent_id:
            series.active = None

        if state is None:
            self._chunks.pop(chunk.chunk_id, None)
            if series is not None and not series.pending and series.active is None:
                self._series.pop(chunk.request.series_key, None)
            return

        # Cancellation wins every race with deferral. Never let a revoked
        # request reappear when an old quota timer fires.
        if state.cancel_requested:
            self._chunks.pop(chunk.chunk_id, None)
            if series is not None and chunk.parent_id in series.pending:
                series.pending.remove(chunk.parent_id)
            await self._finish_pending_cancellation(
                state,
                self._cancelled_outcome(state),
                series,
            )
            return

        if state.stale or state.failed is not None:
            self._chunks.pop(chunk.chunk_id, None)
            return

        now_monotonic = time.monotonic()
        eligible_at = exc.retry_at_monotonic or (
            now_monotonic + exc.retry_after_seconds
        )
        eligible_at = max(now_monotonic + 0.01, eligible_at)
        retry_at_ms = exc.retry_at_ms or (
            int(time.time() * 1000)
            + max(1, int((eligible_at - now_monotonic) * 1000))
        )
        chunk.eligible_at_monotonic = eligible_at
        chunk.retry_at_ms = int(retry_at_ms)
        chunk.defer_reason = exc.reason
        chunk.rate_limit_bucket = exc.bucket_key
        chunk.defer_count += 1
        self.exchange_rate_limit_deferrals += 1
        if series is None:
            series = self._series.setdefault(
                chunk.request.series_key,
                _SeriesState(),
            )
        if chunk.parent_id not in series.pending:
            series.pending.append(chunk.parent_id)
        self._push_ready(chunk, preserve_sequence=True)
        state.progress_revision += 1
        self._publish_progress(
            state,
            status="rate_limit_deferred",
            details={
                "retry_at_ms": chunk.retry_at_ms,
                "retry_in_ms": max(
                    0,
                    int((eligible_at - now_monotonic) * 1000),
                ),
                "rate_limit_bucket": chunk.rate_limit_bucket,
                "rate_limit_reason": chunk.defer_reason,
                "deferred_chunk_sequence": chunk.sequence,
                "defer_count": chunk.defer_count,
            },
        )
        self._schedule_drain(eligible_at - now_monotonic)

    async def _finish_chunk(self, chunk: _FetchChunk, outcome: RepairOutcome) -> None:
        self._chunks.pop(chunk.chunk_id, None)
        state = self._requests.get(chunk.parent_id)
        series = self._series.get(chunk.request.series_key)
        if state is None:
            if series is not None and series.active == chunk.parent_id:
                series.active = None
            if series is not None and not series.pending and series.active is None:
                self._series.pop(chunk.request.series_key, None)
            return

        skipped_covered = self._discard_chunks_covered_by_report(
            state,
            outcome,
            current_chunk_id=chunk.chunk_id,
        )
        state.completed += 1
        state.attempts += int(outcome.attempts or 0)
        state.bars_loaded += int(outcome.bars_loaded or 0)
        state.outcomes.append(outcome)
        state.progress_revision += 1
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

        if state.cancel_requested:
            self._discard_remaining_chunks(state)
            state.completed = state.total

        self._publish_progress(
            state,
            status=("cancelled" if state.cancel_requested else "chunk_completed"),
            details={
                "completed_chunk_sequence": chunk.sequence,
                "completed_chunk_start_ms": chunk.request.start_ms,
                "completed_chunk_end_ms": chunk.request.end_ms,
                "completed_chunk_target_bars": int(
                    (
                        chunk.request.metadata.get("interval_work_plan")
                        or {}
                    ).get("effective_target_bars", 0)
                    or 0
                ),
                "completed_chunk_source_rows": int(
                    (
                        chunk.request.metadata.get("interval_work_plan")
                        or {}
                    ).get("planned_source_rows", 0)
                    or 0
                ),
                "covered_chunks_skipped": skipped_covered,
            },
        )

        # Scheduler coverage is a continuity claim, not merely evidence that
        # an HTTP/reconcile attempt returned without raising.  A partial
        # verification must stay visible to later demand and ledger recovery.
        if outcome.verified_contiguous is True:
            self._coverage.setdefault(chunk.request.series_key, []).append({
                "start_ms": chunk.request.start_ms,
                "end_ms": chunk.request.end_ms,
            })

        if state.failed is not None or state.completed >= state.total:
            final = (
                self._cancelled_outcome(state)
                if state.cancel_requested
                else self._aggregate_outcome(state)
            )
            try:
                if self._shutdown:
                    # A cancellation raised by ``_execute`` is consumed in
                    # ``_run_chunk``.  Starting a new durable finalizer after
                    # that point would no longer be interrupted by the one
                    # shutdown cancellation and could hang shutdown forever.
                    final = RepairOutcome(
                        request=state.request,
                        status="failed",
                        report=final.report,
                        attempts=final.attempts,
                        bars_loaded=final.bars_loaded,
                        verified_contiguous=False,
                        remaining_missing_bars=final.remaining_missing_bars,
                        error="cancelled",
                        retryable=True,
                    )
                else:
                    try:
                        await self._finalize(state.request, final)
                    except asyncio.CancelledError:
                        # Scheduler shutdown may interrupt an awaited durable
                        # finalizer.  Complete the shared waiter before dropping
                        # ownership; otherwise the parent disappears from
                        # ``_requests`` and no shutdown path can resolve it.
                        final = RepairOutcome(
                            request=state.request,
                            status="failed",
                            report=final.report,
                            attempts=final.attempts,
                            bars_loaded=final.bars_loaded,
                            verified_contiguous=False,
                            remaining_missing_bars=final.remaining_missing_bars,
                            error="cancelled",
                            retryable=True,
                        )
                    except Exception as exc:
                        logger.exception(
                            "Backfill parent finalization failed for %s",
                            state.request.request_id,
                        )
                        final = RepairOutcome(
                            request=state.request,
                            status="failed",
                            report=final.report,
                            attempts=final.attempts,
                            bars_loaded=final.bars_loaded,
                            verified_contiguous=False,
                            remaining_missing_bars=final.remaining_missing_bars,
                            error=f"parent finalization failed: {exc}",
                            retryable=True,
                        )
                self._retain_outcome(state.request.request_id, final)
                self._complete(state.request, final)
                self._publish_progress(
                    state,
                    status=("cancelled" if state.cancel_requested else "completed"),
                    terminal=True,
                )
            finally:
                self._requests.pop(state.request.request_id, None)
                # The finalizing parent remains the active series owner until
                # its durable ledger state and shared result are committed.
                # Submissions during that window must dedupe to this request,
                # not start a second physical repair for the same range.
                if series is not None and series.active == chunk.parent_id:
                    series.active = None
                if series is not None and not series.pending and series.active is None:
                    self._series.pop(chunk.request.series_key, None)
        else:
            if series is not None and series.active == chunk.parent_id:
                series.active = None
            if series is not None and state.request.request_id not in series.pending:
                # Remaining chunks are already in the global queue. Keep the parent
                # visible in pending diagnostics while it waits for the next turn.
                series.pending.append(state.request.request_id)

    def _discard_chunks_covered_by_report(
        self,
        state: _RequestState,
        outcome: RepairOutcome,
        *,
        current_chunk_id: str,
    ) -> int:
        """Drop queued pages already covered by a broad archive import.

        Archive objects intentionally write beyond the planner's current
        1,000-source-row chunk.  The exact target-interval written ranges are
        durable evidence that later queued chunks no longer need another
        fetch/reconcile/materialize pass.
        """
        if self._is_failed(outcome.status) or outcome.report is None:
            return 0
        normalized = [
            value
            for raw in list(
                getattr(outcome.report, "written_ranges", None) or []
            )
            if (value := self._normalize_summary_written_range(raw)) is not None
            and value["exchange"] == state.request.exchange.lower().strip()
            and value["market_type"] == state.request.market_type.lower().strip()
            and value["symbol"] == state.request.symbol.upper().strip()
            and value["interval"] == state.request.interval
        ]
        if not normalized:
            return 0
        interval_ms = parse_interval_ms(state.request.interval) or 1
        ordered = sorted(
            (int(item["start_ms"]), int(item["end_ms"]))
            for item in normalized
        )
        merged: list[tuple[int, int]] = []
        for start_ms, end_ms in ordered:
            if not merged or start_ms > merged[-1][1] + interval_ms:
                merged.append((start_ms, end_ms))
            else:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end_ms))

        removed: set[str] = set()
        for chunk_id in state.chunk_ids:
            if chunk_id == current_chunk_id or chunk_id in self._tasks:
                continue
            pending = self._chunks.get(chunk_id)
            if pending is None or pending.parent_id != state.request.request_id:
                continue
            if any(
                start_ms <= pending.request.start_ms
                and pending.request.end_ms <= end_ms
                for start_ms, end_ms in merged
            ):
                removed.add(chunk_id)
                self._chunks.pop(chunk_id, None)
        if not removed:
            return 0
        state.chunk_ids = [
            chunk_id for chunk_id in state.chunk_ids if chunk_id not in removed
        ]
        self._ready = [item for item in self._ready if item[3] not in removed]
        heapq.heapify(self._ready)
        self.covered_chunks_skipped += len(removed)
        coverage = self._coverage.setdefault(state.request.series_key, [])
        coverage.extend(
            {"start_ms": start_ms, "end_ms": end_ms}
            for start_ms, end_ms in merged
        )
        return len(removed)

    @staticmethod
    def _normalize_summary_written_range(raw: Any) -> dict[str, Any] | None:
        def _value(key: str, default: Any = None) -> Any:
            if isinstance(raw, dict):
                return raw.get(key, default)
            return getattr(raw, key, default)

        start_ms = _value("start_ms")
        end_ms = _value("end_ms")
        if start_ms is None or end_ms is None:
            return None
        return {
            "exchange": str(_value("exchange", "binance")).lower().strip(),
            "market_type": str(_value("market_type", "spot")).lower().strip(),
            "symbol": str(_value("symbol", "")).upper().strip(),
            "interval": _value("interval", ""),
            "start_ms": int(start_ms),
            "end_ms": int(end_ms),
        }

    def _retain_outcome(self, request_id: str, outcome: RepairOutcome) -> None:
        self._outcomes[request_id] = outcome
        while len(self._outcomes) > self._max_retained_outcomes:
            oldest_request_id = next(iter(self._outcomes))
            self._outcomes.pop(oldest_request_id, None)

    def _discard_remaining_chunks(self, state: _RequestState) -> None:
        discarded: set[str] = set()
        for chunk_id in state.chunk_ids:
            if chunk_id not in self._tasks:
                self._chunks.pop(chunk_id, None)
                discarded.add(chunk_id)
        if discarded:
            self._ready = [
                item for item in self._ready if item[3] not in discarded
            ]
            heapq.heapify(self._ready)
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
        all_chunks_verified = (
            len(state.outcomes) == state.total
            and not state.stale
            and all(
                outcome.verified_contiguous is True
                for outcome in state.outcomes
            )
        )
        any_chunk_failed_verification = any(
            outcome.verified_contiguous is False
            for outcome in state.outcomes
        )
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
                True
                if all_chunks_verified
                else (False if any_chunk_failed_verification else None)
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
        now_monotonic = time.monotonic()
        deferred = [
            chunk
            for chunk_id in state.chunk_ids
            if (chunk := self._chunks.get(chunk_id)) is not None
            and chunk.eligible_at_monotonic > now_monotonic
        ]
        payload = {
            "series": series,
            "request_id": state.request.request_id,
            "reason": state.request.reason,
            "priority": state.request.priority,
            "requester": state.request.requester,
            "fairness_owner": self._fairness_owner(state.request),
            "range_start_ms": state.request.start_ms,
            "range_end_ms": state.request.end_ms,
            "total_chunks": state.total,
            "completed_chunks": state.completed,
            "pending_chunks": state.pending_count,
            "active": active,
            "progress_revision": state.progress_revision,
            "demand_count": len(state.demand_leases),
            "persistent_interest": state.persistent_interest,
            "cancel_requested": state.cancel_requested,
            "deferred_chunks": len(deferred),
            "retry_at_ms": min(
                (
                    int(chunk.retry_at_ms)
                    for chunk in deferred
                    if chunk.retry_at_ms is not None
                ),
                default=None,
            ),
            "rate_limit_buckets": sorted({
                str(chunk.rate_limit_bucket)
                for chunk in deferred
                if chunk.rate_limit_bucket
            }),
        }
        metadata = state.request.metadata or {}
        for key in (
            "focus_scope",
            "subscription_tier",
            "current_interval",
            "demand_scope",
            "demand_generation",
            "interval_work_plan",
        ):
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
            and cls._can_coalesce(existing, new)
            and existing.start_ms <= new.end_ms + tolerance
            and new.start_ms <= existing.end_ms + tolerance
        )

    @staticmethod
    def _can_coalesce(existing: RepairRequest, new: RepairRequest) -> bool:
        """Keep active hydration from widening or owning foreground work.

        Other background parents retain their established foreground-promotion
        behavior. ``active_history_hydration`` is a dedicated cache-fill lane:
        it may dedupe/merge only with the same lane, never with a viewport
        parent whose response latency must remain bounded to visible demand.
        """

        def _is_active_hydration(request: RepairRequest) -> bool:
            return "active_history_hydration" in {
                part.strip()
                for part in str(request.reason or "").split("+")
                if part.strip()
            }

        return _is_active_hydration(existing) == _is_active_hydration(new)

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
        self._gap_audit_cursors: dict[tuple[str, str, str, str], int] = {}
        self._gap_audit_tail_cursors: dict[tuple[str, str, str, str], int] = {}
        self._gap_audit_series_rotation = 0
        self._ledger_pending_upserts: OrderedDict[str, RepairRequest] = OrderedDict()
        self._ledger_pending_operations: deque[tuple[Callable[..., Any], tuple[Any, ...]]] = deque()
        self._ledger_write_task: asyncio.Task | None = None
        self._ledger_open_cache: list[dict[str, Any]] = []
        self._ledger_health_cache: dict[str, Any] = {}
        self._ledger_suppression_cache: dict[
            tuple[str, str, str, str],
            tuple[dict[str, Any], ...],
        ] = {}
        self._ledger_last_compaction_at: float | None = None
        self._ledger_open_cache_updated_at = 0.0
        self._ledger_open_refresh_task: asyncio.Task | None = None

        self._futures: dict[str, asyncio.Future[RepairOutcome]] = {}
        self._outcomes: dict[str, RepairOutcome] = {}
        self._outcome_expires_at: dict[str, float] = {}
        self._request_id_aliases: dict[str, str] = {}
        self._request_id_alias_expires_at: dict[str, float | None] = {}
        self._max_retained_outcomes = _COORDINATOR_OUTCOME_HISTORY_LIMIT
        self._max_request_id_aliases = _REQUEST_ID_ALIAS_HISTORY_LIMIT
        self._retained_outcome_ttl_seconds = _RETAINED_OUTCOME_TTL_SECONDS
        self._progress_snapshots: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._progress_waiters: dict[
            str,
            set[asyncio.Future[dict[str, Any]]],
        ] = {}
        self._scope_generations: OrderedDict[str, int] = OrderedDict()
        self._revoked_demand_owners: OrderedDict[str, str] = OrderedDict()
        self._shutdown = False
        self._scheduler = _BackfillScheduler(
            execute=self._run_with_retries,
            future_for=self._future_for,
            complete=self._complete,
            finalize=self._ledger_finalize_parent,
            on_queued=self._ledger_upsert_detected,
            on_progress=self._note_progress,
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
        _request_id, future = self._request_in_loop(request)
        return await asyncio.shield(future)

    def progress_for_request(self, request_id: str) -> dict[str, Any] | None:
        canonical_id = self._canonical_request_id(request_id)
        snapshot = self._progress_snapshots.get(canonical_id)
        return dict(snapshot) if snapshot is not None else None

    async def wait_for_progress(
        self,
        request_id: str,
        *,
        after_revision: int = 0,
    ) -> dict[str, Any] | None:
        """Wait for the next physical chunk revision, not the whole parent."""
        canonical_id = self._canonical_request_id(request_id)
        snapshot = self._progress_snapshots.get(canonical_id)
        if snapshot is not None and (
            int(snapshot.get("revision", 0)) > int(after_revision)
            or bool(snapshot.get("terminal"))
        ):
            return dict(snapshot)
        if canonical_id in self._outcomes:
            return dict(snapshot) if snapshot is not None else None

        waiter: asyncio.Future[dict[str, Any]] = (
            asyncio.get_running_loop().create_future()
        )
        waiters = self._progress_waiters.setdefault(canonical_id, set())
        waiters.add(waiter)
        snapshot = self._progress_snapshots.get(canonical_id)
        if snapshot is not None and (
            int(snapshot.get("revision", 0)) > int(after_revision)
            or bool(snapshot.get("terminal"))
        ):
            waiter.set_result(dict(snapshot))
        try:
            while True:
                observed = await waiter
                if (
                    int(observed.get("revision", 0)) > int(after_revision)
                    or bool(observed.get("terminal"))
                ):
                    return observed
        finally:
            waiters.discard(waiter)
            if not waiters:
                self._progress_waiters.pop(canonical_id, None)

    async def acquire_demand(
        self,
        request_id: str,
        *,
        owner_id: str,
        scope: str | None = None,
        generation: int | None = None,
    ) -> bool:
        canonical_id = self._canonical_request_id(request_id)
        normalized_scope = str(scope or "").strip() or None
        normalized_generation = (
            max(0, int(generation))
            if generation is not None
            else None
        )
        stale_generation = bool(
            normalized_scope is not None
            and normalized_generation is not None
            and (
                current := self._scope_generations.get(normalized_scope)
            ) is not None
            and normalized_generation < current
        )
        acquired = self._scheduler.acquire_demand(
            canonical_id,
            owner_id=owner_id,
            scope=normalized_scope,
            generation=normalized_generation,
        )
        if acquired and stale_generation:
            # Close the race where generation N schedules its repair after
            # generation N+1 already advanced the pane scope. Acquiring then
            # immediately releasing lets the scheduler cancel the otherwise
            # unowned request with the same pending/chunk-boundary semantics.
            await self._scheduler.release_demand(
                canonical_id,
                owner_id=owner_id,
                cancel_if_unobserved=True,
                reason=(
                    f"scope_stale:{normalized_scope}:{normalized_generation}"
                ),
            )
            return False
        return acquired

    async def release_demand(
        self,
        request_id: str,
        *,
        owner_id: str,
        cancel_if_unobserved: bool = True,
        reason: str = "demand_released",
    ) -> bool:
        canonical_id = self._canonical_request_id(request_id)
        return await self._scheduler.release_demand(
            canonical_id,
            owner_id=owner_id,
            cancel_if_unobserved=cancel_if_unobserved,
            reason=reason,
        )

    async def advance_demand_scope(self, scope: str, generation: int) -> int:
        normalized_scope = str(scope or "").strip()
        if not normalized_scope:
            return 0
        normalized_generation = max(0, int(generation))
        current = self._scope_generations.get(normalized_scope)
        if current is not None and normalized_generation <= current:
            return 0
        self._scope_generations.pop(normalized_scope, None)
        self._scope_generations[normalized_scope] = normalized_generation
        while len(self._scope_generations) > _REQUEST_ID_ALIAS_HISTORY_LIMIT:
            self._scope_generations.popitem(last=False)
        return await self._scheduler.supersede_scope(
            normalized_scope,
            normalized_generation,
        )

    async def revoke_demand_owner(
        self,
        owner_id: str,
        *,
        reason: str = "demand_owner_revoked",
    ) -> int:
        normalized_owner = str(owner_id or "").strip()
        if not normalized_owner:
            return 0
        self._revoked_demand_owners.pop(normalized_owner, None)
        self._revoked_demand_owners[normalized_owner] = str(reason or "demand_owner_revoked")
        while len(self._revoked_demand_owners) > _REQUEST_ID_ALIAS_HISTORY_LIMIT:
            self._revoked_demand_owners.popitem(last=False)
        return await self._scheduler.revoke_owner(
            normalized_owner,
            reason=str(reason or "demand_owner_revoked"),
        )

    def is_demand_generation_current(self, scope: str, generation: int) -> bool:
        normalized_scope = str(scope or "").strip()
        if not normalized_scope:
            return True
        current = self._scope_generations.get(normalized_scope)
        return current is None or int(generation) >= current

    def has_foreground_work(self) -> bool:
        """Expose scheduler foreground ownership to speculative producers."""

        return self._scheduler.has_foreground_work()

    def foreground_idle_seconds(self) -> float:
        """Return continuous scheduler idle time since foreground ownership."""

        return self._scheduler.foreground_idle_seconds()

    def _note_progress(
        self,
        request: RepairRequest,
        progress: dict[str, Any],
    ) -> None:
        request_id = request.request_id
        snapshot = dict(progress)
        previous = self._progress_snapshots.get(request_id)
        should_notify = bool(snapshot.get("terminal")) or previous is None or (
            int(snapshot.get("revision", 0))
            > int(previous.get("revision", 0))
        )
        self._progress_snapshots.pop(request_id, None)
        self._progress_snapshots[request_id] = snapshot
        while len(self._progress_snapshots) > self._max_retained_outcomes:
            self._progress_snapshots.popitem(last=False)
        if not should_notify:
            return
        waiters = self._progress_waiters.pop(request_id, set())
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(dict(snapshot))

    async def refresh_suppressions(self) -> int:
        """Refresh the non-blocking submission cache from durable ledger state."""
        if self._gap_ledger is None:
            self._ledger_suppression_cache = {}
            return 0
        list_suppressions = getattr(self._gap_ledger, "list_suppressions", None)
        if not callable(list_suppressions):
            self._ledger_suppression_cache = {}
            return 0
        now_ms = int(time.time() * 1000)
        try:
            rows = await run_storage(list_suppressions, now_ms=now_ms)
        except Exception:
            logger.exception("Gap ledger suppression refresh failed")
            return sum(len(rows) for rows in self._ledger_suppression_cache.values())

        grouped: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
        for raw in rows or ():
            if not isinstance(raw, dict):
                continue
            try:
                start_ms = int(raw["start_ms"])
                end_ms = int(raw["end_ms"])
            except (KeyError, TypeError, ValueError):
                continue
            if start_ms > end_ms:
                continue
            status = str(raw.get("status") or "")
            if status not in {"source_empty", "failed", "unavailable"}:
                continue
            retry_at_raw = raw.get("next_retry_at")
            try:
                retry_at_ms = (
                    int(retry_at_raw) if retry_at_raw is not None else None
                )
            except (TypeError, ValueError):
                continue
            if status != "source_empty" and retry_at_ms is None:
                continue
            if retry_at_ms is not None and retry_at_ms <= now_ms:
                continue
            key = (
                str(raw.get("exchange") or "binance").strip().lower(),
                str(raw.get("market_type") or "spot").strip().lower(),
                str(raw.get("symbol") or "").strip().upper(),
                str(raw.get("interval") or "").strip(),
            )
            if not key[2] or not key[3]:
                continue
            observation_raw = raw.get("resolved_at") or raw.get("last_checked_at")
            try:
                observed_at_ms = (
                    int(observation_raw) if observation_raw is not None else None
                )
            except (TypeError, ValueError):
                observed_at_ms = None
            cache_request = RepairRequest(
                exchange=key[0],
                market_type=key[1],
                symbol=key[2],
                interval=key[3],
                start_ms=start_ms,
                end_ms=end_ms,
                reason="suppression_cache",
                requester="suppression_cache",
                metadata=_decode_metadata_object(raw.get("metadata_json")),
            )
            calendar, calendar_resolved = self._calendar_for_reconciliation(
                cache_request
            )
            grouped.setdefault(key, []).append({
                "suppressed": True,
                "source": "gap_ledger",
                "ledger_id": raw.get("id"),
                "ledger_status": status,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "reason": str(
                    raw.get("last_error")
                    or raw.get("reason")
                    or f"gap_ledger_{status}"
                ),
                "retry_at_ms": retry_at_ms,
                # It may become eligible after retry_at_ms, but there is no
                # useful immediate retry while this record is current.
                "retryable": False,
                "terminal": True,
                "observed_at_ms": observed_at_ms,
                # Private, in-memory-only fields keep synchronous submission
                # checks free of policy/SQLite resolution while preserving
                # session-calendar closed-bar semantics.
                "_calendar": calendar,
                "_calendar_resolved": calendar_resolved,
            })
        self._ledger_suppression_cache = {
            key: tuple(sorted(values, key=lambda row: (
                int(row["end_ms"]) - int(row["start_ms"]),
                -int(row.get("ledger_id") or 0),
            )))
            for key, values in grouped.items()
        }
        return sum(len(values) for values in self._ledger_suppression_cache.values())

    def get_repair_suppression(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> dict[str, Any] | None:
        """Return an exact/covering current cooldown without SQLite I/O."""
        key = (
            str(exchange or "binance").strip().lower(),
            str(market_type or "spot").strip().lower(),
            str(symbol or "").strip().upper(),
            str(interval or "").strip(),
        )
        requested_start = int(start_ms)
        requested_end = int(end_ms)
        now_ms = int(time.time() * 1000)
        for record in self._ledger_suppression_cache.get(key, ()):
            retry_at_ms = record.get("retry_at_ms")
            if retry_at_ms is not None and int(retry_at_ms) <= now_ms:
                continue
            if (
                int(record["start_ms"]) <= requested_start
                and int(record["end_ms"]) >= requested_end
            ):
                if record.get("ledger_status") == "source_empty":
                    request = RepairRequest(
                        exchange=key[0],
                        market_type=key[1],
                        symbol=key[2],
                        interval=key[3],
                        start_ms=requested_start,
                        end_ms=requested_end,
                        reason="suppression_lookup",
                        requester="suppression_lookup",
                    )
                    target = self._target_open_range_with_calendar(
                        request,
                        calendar=record.get("_calendar"),
                        calendar_resolved=bool(record.get("_calendar_resolved")),
                    )
                    # Unknown calendars and still-forming windows remain
                    # fail-closed.  Once the range has closed, however, a
                    # source-empty observation made before that close is stale
                    # evidence and must not suppress the first closed repair.
                    if target is not None and target[2] <= now_ms:
                        observed_at_ms = record.get("observed_at_ms")
                        if (
                            observed_at_ms is None
                            or target[2] > int(observed_at_ms)
                        ):
                            continue
                return {
                    **{
                        name: value
                        for name, value in record.items()
                        if not name.startswith("_")
                    },
                    "requested_start_ms": requested_start,
                    "requested_end_ms": requested_end,
                }
        return None

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

        # A restart loses the in-memory scheduler but not its durable ledger.
        # Recheck stale rows against exact storage before either closing or
        # requeueing them; never infer work solely from the saved status.
        ledger_report = await self.reconcile_gap_ledger(limit=100)
        report.ledger_scanned += ledger_report.scanned
        report.ledger_resolved += ledger_report.resolved
        report.ledger_requeued += ledger_report.requeued
        report.ledger_compacted += ledger_report.compacted
        report.ledger_skipped += ledger_report.skipped
        report.ledger_failed += ledger_report.failed
        report.errors.extend(ledger_report.errors)

        for exchange, market_type, symbol in targets:
            for interval in intervals:
                if self._shutdown:
                    return report
                try:
                    bounds = await run_storage(
                        self._storage.get_bounds,
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
        exact_series = [
                (exchange, market_type, symbol, interval)
                for exchange, market_type, symbol in targets
                for interval in intervals
        ]
        return await self.audit_storage_series(
            exact_series,
            scan_limit=scan_limit,
            max_gaps=max_gaps,
            repair=repair,
            tail_series=exact_series,
        )

    async def audit_storage_series(
        self,
        series: Iterable[tuple[str, str, str, str]],
        *,
        scan_limit: int = 50_000,
        max_gaps: int = 100,
        repair: bool = True,
        tail_series: Iterable[tuple[str, str, str, str]] | None = None,
    ) -> ScanReport:
        """Scan exact series and optionally queue repairs.

        Inventory-only series are scanned for interior continuity.  Only the
        explicit ``tail_series`` set is extended to the current closed-bar
        edge, preventing abandoned storage series from causing a catch-up
        storm merely because they still exist on disk.
        """
        report = ScanReport()
        scanner = getattr(self._storage, "scan_gaps", None)
        if not callable(scanner):
            report.errors.append("storage does not support gap scanning")
            return report

        queued = 0
        seen_series: set[tuple[str, str, str, str]] = set()
        normalized_series: list[tuple[str, str, str, str]] = []
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
            normalized_series.append(series_key)

        normalized_tail_series: set[tuple[str, str, str, str]] = set()
        for raw in tail_series or ():
            try:
                raw_exchange, raw_market_type, raw_symbol, raw_interval = raw
            except (TypeError, ValueError):
                continue
            tail_key = (
                str(raw_exchange or "binance").strip().lower(),
                str(raw_market_type or "spot").strip().lower(),
                str(raw_symbol or "").strip().upper(),
                str(raw_interval or "").strip(),
            )
            if tail_key[2] and tail_key[3]:
                normalized_tail_series.add(tail_key)

        async def _queue_scan_gaps(
            scan: dict[str, Any],
            *,
            exchange: str,
            market_type: str,
            symbol: str,
            interval: str,
            lane: str,
        ) -> int | None:
            nonlocal queued
            priority = priority_for_reason(
                "tail_gap" if lane == "tail" else "background_gap_audit"
            )
            for gap in scan.get("gaps", []):
                if not isinstance(gap, dict):
                    continue
                if queued >= max_gaps:
                    return int(gap["start_ms"])
                request = RepairRequest(
                    symbol=symbol,
                    interval=interval,
                    start_ms=int(gap["start_ms"]),
                    end_ms=int(gap["end_ms"]),
                    exchange=exchange,
                    market_type=market_type,
                    reason="background_gap_audit",
                    priority=priority,
                    requester="background_audit",
                    metadata={
                        "origin": "background_gap_audit",
                        "audit_lane": lane,
                        "gap_type": gap.get("reason", "unknown"),
                    },
                )
                if await self._should_skip_audited_gap(request):
                    continue
                if repair:
                    canonical_id = self.request(request)
                    # Scheduler dedupe/merge returns the already-owned parent
                    # id.  It did not consume another queue slot, so it must
                    # not consume this audit's gap budget either.
                    if canonical_id == request.request_id:
                        queued += 1
                        report.queued += 1
                else:
                    report.repaired += 1
            return None

        def _next_audit_cursor(
            raw_cursor_ms: int,
            interval_value: str,
            calendar: TradingCalendar | None,
        ) -> int:
            if calendar is not None:
                next_open_ms = calendar.next_expected_open(
                    int(raw_cursor_ms),
                    interval_value,
                )
                if next_open_ms is None:
                    raise ValueError(
                        f"no next expected open for interval: {interval_value}"
                    )
                return next_open_ms
            interval_width_ms = parse_interval_ms(interval_value)
            if interval_width_ms is None or interval_width_ms <= 0:
                raise ValueError(f"unsupported interval: {interval_value}")
            bucket_start_ms = compute_bucket_start_ms(
                int(raw_cursor_ms),
                interval_width_ms,
                interval=interval_value,
            )
            return compute_bucket_end_ms(
                bucket_start_ms,
                interval_width_ms,
                interval=interval_value,
            )

        if normalized_series:
            start_index = self._gap_audit_series_rotation % len(normalized_series)
            normalized_series = (
                normalized_series[start_index:] + normalized_series[:start_index]
            )
        else:
            start_index = 0

        processed_series = 0
        for exchange, market_type, symbol, interval in normalized_series:
            series_key = (exchange, market_type, symbol, interval)
            if self._shutdown:
                return report
            if queued >= max_gaps:
                break
            try:
                processed_series += 1
                calendar_request = RepairRequest(
                    symbol=symbol,
                    interval=interval,
                    start_ms=0,
                    end_ms=0,
                    exchange=exchange,
                    market_type=market_type,
                    reason="background_gap_audit",
                    requester="background_audit",
                )
                audit_calendar, calendar_resolved = (
                    self._calendar_for_reconciliation(calendar_request)
                )
                if not calendar_resolved:
                    raise ValueError("history calendar is unavailable")
                if series_key in normalized_tail_series:
                    audit_now_ms = int(time.time() * 1000)
                    closed_end_ms = (
                        latest_closed_expected_open_ms(
                            audit_calendar,
                            audit_now_ms,
                            interval,
                        )
                        if audit_calendar is not None
                        else last_closed_bar_open_ms(audit_now_ms, interval)
                    )
                    if closed_end_ms is None:
                        raise ValueError(f"unsupported interval: {interval}")
                    get_bounds = getattr(self._storage, "get_bounds", None)
                    if callable(get_bounds):
                        try:
                            bounds = await run_storage(
                                get_bounds,
                                symbol,
                                interval,
                                exchange=exchange,
                                market_type=market_type,
                            )
                            latest_open_ms = (
                                bounds.get("latest_open_time")
                                if isinstance(bounds, dict)
                                else None
                            )
                            if (
                                latest_open_ms is not None
                                and int(latest_open_ms) <= int(closed_end_ms)
                            ):
                                interval_ms = parse_interval_ms(interval)
                                if interval_ms is None or interval_ms <= 0:
                                    raise ValueError(
                                        f"unsupported interval: {interval}"
                                    )
                                raw_tail_start_ms = max(
                                    0,
                                    int(closed_end_ms)
                                    - interval_ms * (_TAIL_AUDIT_LOOKBACK_BARS - 1),
                                )
                                tail_start_ms = (
                                    audit_calendar.first_expected_open(
                                        raw_tail_start_ms,
                                        int(closed_end_ms),
                                        interval,
                                    )
                                    if audit_calendar is not None
                                    else compute_bucket_start_ms(
                                        raw_tail_start_ms,
                                        interval_ms,
                                        interval=interval,
                                    )
                                )
                                if tail_start_ms is None:
                                    raise ValueError(
                                        "tail audit range has no expected bars"
                                    )
                                earliest_open_ms = bounds.get("earliest_open_time")
                                if earliest_open_ms is not None:
                                    bounded_start_ms = max(
                                        int(tail_start_ms),
                                        int(earliest_open_ms),
                                    )
                                    if audit_calendar is not None:
                                        tail_start_ms = audit_calendar.first_expected_open(
                                            bounded_start_ms,
                                            int(closed_end_ms),
                                            interval,
                                        )
                                        if tail_start_ms is None:
                                            raise ValueError(
                                                "bounded tail audit range has no expected bars"
                                            )
                                    else:
                                        tail_start_ms = bounded_start_ms
                                tail_cursor_ms = self._gap_audit_tail_cursors.get(
                                    series_key
                                )
                                if (
                                    tail_cursor_ms is not None
                                    and tail_start_ms <= tail_cursor_ms <= closed_end_ms
                                ):
                                    tail_start_ms = tail_cursor_ms
                                elif tail_cursor_ms is not None:
                                    # The rolling lookback or storage bounds moved
                                    # past an old checkpoint.  Restart within the
                                    # current exact tail window, never outside it.
                                    self._gap_audit_tail_cursors.pop(series_key, None)
                                tail_scan = await run_storage(
                                    scanner,
                                    symbol=symbol,
                                    interval=interval,
                                    start_ms=int(tail_start_ms),
                                    end_ms=int(closed_end_ms),
                                    exchange=exchange,
                                    market_type=market_type,
                                    limit=_TAIL_AUDIT_LOOKBACK_BARS,
                                )
                                report.scanned += 1
                                if not isinstance(tail_scan, dict):
                                    raise ValueError(
                                        "storage tail scan returned a malformed result"
                                    )
                                if tail_scan.get("error"):
                                    raise ValueError(str(tail_scan["error"]))
                                first_unprocessed_tail_gap_ms = await _queue_scan_gaps(
                                    tail_scan,
                                    exchange=exchange,
                                    market_type=market_type,
                                    symbol=symbol,
                                    interval=interval,
                                    lane="tail",
                                )
                                if first_unprocessed_tail_gap_ms is not None:
                                    self._gap_audit_tail_cursors[series_key] = (
                                        first_unprocessed_tail_gap_ms
                                    )
                                else:
                                    resume_from_ms = tail_scan.get("resume_from_ms")
                                    if (
                                        tail_scan.get("truncated")
                                        and resume_from_ms is not None
                                    ):
                                        resume_value = _next_audit_cursor(
                                            int(resume_from_ms),
                                            interval,
                                            audit_calendar,
                                        )
                                        if resume_value <= tail_start_ms:
                                            resume_value = _next_audit_cursor(
                                                tail_start_ms,
                                                interval,
                                                audit_calendar,
                                            )
                                        if resume_value <= closed_end_ms:
                                            self._gap_audit_tail_cursors[series_key] = (
                                                resume_value
                                            )
                                        else:
                                            self._gap_audit_tail_cursors.pop(
                                                series_key,
                                                None,
                                            )
                                    else:
                                        self._gap_audit_tail_cursors.pop(
                                            series_key,
                                            None,
                                        )
                                if queued >= max_gaps:
                                    continue
                        except asyncio.CancelledError:
                            raise
                        except Exception as tail_exc:
                            report.failed += 1
                            report.errors.append(
                                f"{exchange}:{market_type}:{symbol}@{interval} "
                                f"tail: {tail_exc}"
                            )
                            logger.warning(
                                "Background tail audit failed for %s:%s:%s@%s: %s",
                                exchange,
                                market_type,
                                symbol,
                                interval,
                                tail_exc,
                            )

                cursor_ms = self._gap_audit_cursors.get(
                    (exchange, market_type, symbol, interval)
                )
                scan_kwargs: dict[str, Any] = {
                    "symbol": symbol,
                    "interval": interval,
                    "exchange": exchange,
                    "market_type": market_type,
                    "limit": scan_limit,
                }
                if cursor_ms is not None:
                    scan_kwargs["start_ms"] = cursor_ms
                scan = await run_storage(scanner, **scan_kwargs)
                if not isinstance(scan, dict):
                    raise ValueError("storage gap scan returned a malformed result")
                if scan.get("error"):
                    raise ValueError(str(scan["error"]))
                report.scanned += 1
                first_unprocessed_gap_ms = await _queue_scan_gaps(
                    scan,
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    interval=interval,
                    lane="interior",
                )

                if first_unprocessed_gap_ms is not None:
                    # The page may contain more gaps than this audit's global
                    # queue budget.  Resume at the first untouched gap, not at
                    # the page tail, or that work is skipped forever.
                    self._gap_audit_cursors[series_key] = first_unprocessed_gap_ms
                else:
                    resume_from_ms = scan.get("resume_from_ms")
                    if scan.get("truncated") and resume_from_ms is not None:
                        resume_value = _next_audit_cursor(
                            int(resume_from_ms),
                            interval,
                            audit_calendar,
                        )
                        if cursor_ms is not None and resume_value <= cursor_ms:
                            resume_value = _next_audit_cursor(
                                cursor_ms,
                                interval,
                                audit_calendar,
                            )
                        self._gap_audit_cursors[series_key] = resume_value
                    else:
                        self._gap_audit_cursors.pop(series_key, None)
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

        if normalized_series:
            self._gap_audit_series_rotation = (
                start_index + max(1, processed_series)
            ) % len(normalized_series)

        ledger_report = await self.reconcile_gap_ledger(
            limit=max_gaps,
            scan_limit=scan_limit,
        )
        report.ledger_scanned += ledger_report.scanned
        report.ledger_resolved += ledger_report.resolved
        report.ledger_requeued += ledger_report.requeued
        report.ledger_compacted += ledger_report.compacted
        report.ledger_skipped += ledger_report.skipped
        report.ledger_failed += ledger_report.failed
        if ledger_report.errors:
            report.errors.extend(ledger_report.errors)
        return report

    async def reconcile_gap_ledger(
        self,
        *,
        ranges: Iterable[RepairRequest] | None = None,
        limit: int = 100,
        scan_limit: int = 50_000,
        stale_after_ms: int = _LEDGER_STALE_AFTER_MS,
    ) -> LedgerReconciliationReport:
        """Close stale ledger decisions only after an exact storage recheck.

        A past repair can populate storage before this process knows about it,
        leaving a legacy ``source_empty`` or ``failed`` row behind.  This
        method never trusts the caller or the ledger by itself: every target
        range is normalised to target-bar opens, must be fully closed, and is
        then scanned for head/interior/tail gaps before any ledger mutation.

        With ``ranges=None`` it reconciles inactive ledger rows.  Internal
        callers may supply exact known ranges (for example, after importing
        authoritative history); overlapping inactive rows are still closed
        only if their entire range is covered by the verified scan.
        """
        report = LedgerReconciliationReport()
        if self._gap_ledger is None:
            return report
        await self.refresh_suppressions()

        compact_source_empty = getattr(
            self._gap_ledger,
            "compact_source_empty_drift",
            None,
        )
        compaction_now = time.monotonic()
        if (
            callable(compact_source_empty)
            and (
                self._ledger_last_compaction_at is None
                or compaction_now - self._ledger_last_compaction_at
                >= _LEDGER_COMPACTION_INTERVAL_SECONDS
            )
        ):
            try:
                report.compacted = max(0, int(await run_storage(
                    compact_source_empty,
                    limit=max(10_000, int(limit) * 1_000),
                ) or 0))
            except Exception:
                logger.exception("Gap ledger source-empty compaction failed")
            finally:
                self._ledger_last_compaction_at = compaction_now

        mark_covered = getattr(self._gap_ledger, "mark_covered_resolved", None)
        if not callable(mark_covered):
            report.errors.append("gap ledger does not support coverage reconciliation")
            report.failed += 1
            return report

        if ranges is None:
            list_reconcilable = getattr(self._gap_ledger, "list_reconcilable", None)
            if not callable(list_reconcilable):
                return report
            try:
                lookup_now_ms = int(time.time() * 1000)
                rows = await run_storage(
                    list_reconcilable,
                    limit=max(1, int(limit)),
                    stale_before_ms=(
                        lookup_now_ms - max(0, int(stale_after_ms))
                    ),
                    due_before_ms=lookup_now_ms,
                )
            except Exception as exc:
                report.failed += 1
                report.errors.append(f"gap ledger reconciliation lookup failed: {exc}")
                logger.exception("Gap ledger reconciliation lookup failed")
                return report
            candidates: list[tuple[RepairRequest, int | None]] = []
            for row in rows:
                if not isinstance(row, dict):
                    report.failed += 1
                    report.errors.append("gap ledger returned a malformed row")
                    continue
                try:
                    candidates.append((
                        self._repair_request_from_ledger_row(row),
                        int(row["id"]) if row.get("id") is not None else None,
                    ))
                except (KeyError, TypeError, ValueError) as exc:
                    report.failed += 1
                    report.errors.append(f"invalid gap-ledger row: {exc}")
                    await self._defer_ledger_reconciliation(
                        row_id=(
                            int(row["id"])
                            if row.get("id") is not None
                            else None
                        ),
                        reason=f"invalid gap-ledger row: {exc}",
                        row_snapshot=row,
                    )
        else:
            candidates = [(request, None) for request in ranges]

        scanner = getattr(self._storage, "scan_gaps", None)
        if not callable(scanner):
            report.failed += 1
            report.errors.append("storage does not support gap scanning")
            for raw_request, ledger_row_id in candidates:
                if ledger_row_id is not None:
                    await self._defer_ledger_reconciliation(
                        request=raw_request,
                        row_id=ledger_row_id,
                        reason="storage does not support gap scanning",
                    )
            return report

        now_ms = int(time.time() * 1000)
        remaining_page_budget = _LEDGER_RECONCILE_MAX_TOTAL_PAGES
        seen_ranges: set[tuple[tuple[str, str, str, str], int, int]] = set()
        for raw_request, ledger_row_id in candidates:
            if self._shutdown:
                break
            try:
                request = self._canonical_reconciliation_request(raw_request)
            except (AttributeError, TypeError, ValueError) as exc:
                report.failed += 1
                report.errors.append(f"invalid gap-ledger range: {exc}")
                if ledger_row_id is not None:
                    await self._defer_ledger_reconciliation(
                        request=raw_request,
                        row_id=ledger_row_id,
                        reason=f"invalid gap-ledger range: {exc}",
                    )
                continue
            if request is None:
                report.skipped += 1
                if ledger_row_id is not None:
                    await self._defer_ledger_reconciliation(
                        request=raw_request,
                        row_id=ledger_row_id,
                        reason="unsupported ledger interval",
                    )
                continue
            range_key = (request.series_key, request.start_ms, request.end_ms)
            if range_key in seen_ranges:
                continue
            seen_ranges.add(range_key)
            if not self._request_range_is_fully_closed(request, now_ms):
                report.skipped += 1
                if ledger_row_id is not None:
                    await self._defer_ledger_reconciliation(
                        request=request,
                        row_id=ledger_row_id,
                        reason="ledger range is not fully closed",
                    )
                continue

            if remaining_page_budget <= 0:
                report.skipped += 1
                if ledger_row_id is not None:
                    await self._defer_ledger_reconciliation(
                        request=request,
                        row_id=ledger_row_id,
                        reason="global ledger reconciliation page budget exhausted",
                    )
                continue

            try:
                scan = await self._scan_reconciliation_range(
                    scanner,
                    request,
                    scan_limit=max(1, int(scan_limit)),
                    max_pages=min(
                        _LEDGER_RECONCILE_MAX_PAGES_PER_RANGE,
                        remaining_page_budget,
                    ),
                )
                scanned_pages = int(scan.get("pages", 1) or 1)
                report.scanned += scanned_pages
                remaining_page_budget = max(
                    0,
                    remaining_page_budget - scanned_pages,
                )
                if not isinstance(scan, dict) or scan.get("error"):
                    report.skipped += 1
                    if ledger_row_id is not None:
                        checkpoint_ms = scan.get("checkpoint_ms")
                        if checkpoint_ms is not None:
                            await self._checkpoint_ledger_reconciliation(
                                row_id=ledger_row_id,
                                cursor_ms=int(checkpoint_ms),
                                scanned_bars=int(
                                    scan.get(
                                        "verified_unique_bars",
                                        scan.get("scanned_bars", 0),
                                    )
                                    or 0
                                ),
                                reason=str(
                                    scan.get("error") or "malformed storage scan"
                                ),
                                row_snapshot=self._reconciliation_snapshot(request),
                            )
                        else:
                            await self._defer_ledger_reconciliation(
                                request=request,
                                row_id=ledger_row_id,
                                reason=str(
                                    scan.get("error") or "malformed storage scan"
                                ),
                            )
                    continue
                if scan.get("truncated"):
                    report.skipped += 1
                    if ledger_row_id is not None:
                        await self._checkpoint_ledger_reconciliation(
                            row_id=ledger_row_id,
                            cursor_ms=int(
                                scan.get("checkpoint_ms", request.start_ms)
                            ),
                            scanned_bars=int(
                                scan.get(
                                    "verified_unique_bars",
                                    scan.get("scanned_bars", 0),
                                )
                                or 0
                            ),
                            reason="exact storage scan page budget exhausted",
                            row_snapshot=self._reconciliation_snapshot(request),
                        )
                    continue
                gap_count = int(scan.get("gap_count", 0) or 0)
                scanned_bars = int(scan.get("scanned_bars", 0) or 0)
                if (
                    gap_count == 0
                    and scanned_bars > 0
                    and repair_requires_trusted_finality(
                        request.metadata,
                        reason=request.reason,
                    )
                ):
                    _plan, history_context = self._plan_history_request(request)
                    trusted_verification = await self._verify_request_range(
                        request,
                        context=history_context,
                    )
                    verified_trusted = trusted_verification.get(
                        "verified_contiguous"
                    )
                    if verified_trusted is None:
                        report.skipped += 1
                        if ledger_row_id is not None:
                            await self._defer_ledger_reconciliation(
                                request=request,
                                row_id=ledger_row_id,
                                reason=(
                                    "storage cannot verify trusted-finality "
                                    "provenance during ledger reconciliation"
                                ),
                            )
                        continue
                    if verified_trusted is False:
                        gap_count = max(
                            1,
                            int(
                                trusted_verification.get(
                                    "remaining_missing_bars",
                                    1,
                                )
                                or 1
                            ),
                        )
                if gap_count == 0 and scanned_bars > 0:
                    checkpoint = request.metadata.get(
                        "reconciliation_checkpoint"
                    )
                    used_checkpoint = False
                    if isinstance(checkpoint, dict):
                        try:
                            used_checkpoint = (
                                int(checkpoint.get("cursor_ms"))
                                > int(request.start_ms)
                            )
                        except (TypeError, ValueError):
                            used_checkpoint = False
                    if used_checkpoint or int(scan.get("pages", 1) or 1) > 1:
                        verifier = getattr(
                            self._storage,
                            "verify_contiguous_range",
                            None,
                        )
                        verification_error: str | None = None
                        if not callable(verifier):
                            verification_error = (
                                "storage cannot exactly revalidate a persisted "
                                "reconciliation checkpoint"
                            )
                        else:
                            try:
                                exact = await run_storage(
                                    verifier,
                                    symbol=request.symbol,
                                    interval=request.interval,
                                    start_ms=request.start_ms,
                                    end_ms=request.end_ms,
                                    exchange=request.exchange,
                                    market_type=request.market_type,
                                )
                                if (
                                    not isinstance(exact, dict)
                                    or exact.get("verified_contiguous") is not True
                                ):
                                    verification_error = (
                                        str(exact.get("error") or "")
                                        if isinstance(exact, dict)
                                        else ""
                                    ) or (
                                        "storage changed during checkpointed "
                                        "reconciliation"
                                    )
                            except Exception as exc:
                                verification_error = (
                                    "checkpoint count verification failed: "
                                    f"{exc}"
                                )
                        if verification_error is not None:
                            if ledger_row_id is not None:
                                await self._defer_ledger_reconciliation(
                                    request=request,
                                    row_id=ledger_row_id,
                                    reason=verification_error,
                                    clear_checkpoint=True,
                                )
                            report.skipped += 1
                            continue
                    coverage = request.metadata.get("canonical_coverage_range")
                    if not isinstance(coverage, dict):
                        report.skipped += 1
                        continue
                    resolved = await run_storage(
                        mark_covered,
                        request,
                        coverage_start_ms=int(coverage["start_ms"]),
                        coverage_end_ms=int(coverage["end_ms"]),
                        row_snapshot=self._reconciliation_snapshot(request),
                    )
                    report.resolved += max(0, int(resolved or 0))
                    continue

                prior_status = str(request.metadata.get("ledger_status") or "")
                if gap_count > 0 and prior_status in {
                    "queued",
                    "repairing",
                    "verifying",
                    "partial",
                    "retry_wait",
                    "failed",
                    "unavailable",
                    "not_expected",
                }:
                    if ledger_row_id is not None:
                        claimed = await self._defer_ledger_reconciliation(
                            request=request,
                            row_id=ledger_row_id,
                            reason="storage gap confirmed; scheduling recovery",
                            delay_ms=1,
                            clear_checkpoint=True,
                        )
                        if not claimed:
                            report.skipped += 1
                            continue
                    recovery_metadata = dict(request.metadata)
                    recovery_metadata.pop("reconciliation_checkpoint", None)
                    recovery_metadata.pop(
                        _LEDGER_RECONCILIATION_SNAPSHOT_KEY,
                        None,
                    )
                    try:
                        recovery_count = max(
                            0,
                            int(
                                recovery_metadata.get(
                                    "ledger_recovery_count",
                                    0,
                                )
                                or 0
                            ),
                        )
                    except (TypeError, ValueError):
                        recovery_count = 0
                    recovery_metadata["ledger_recovery_count"] = min(
                        recovery_count + 1,
                        32,
                    )
                    recovery = RepairRequest(
                        symbol=request.symbol,
                        interval=request.interval,
                        start_ms=request.start_ms,
                        end_ms=request.end_ms,
                        exchange=request.exchange,
                        market_type=request.market_type,
                        reason="ledger_recovery",
                        priority=priority_for_reason("query_gap"),
                        requester="ledger_reconcile",
                        metadata={
                            **recovery_metadata,
                            "origin": "stale_ledger_recovery",
                        },
                        request_id=request.request_id,
                    )
                    self.request(recovery)
                    report.requeued += 1
                    continue
                if ledger_row_id is not None:
                    await self._defer_ledger_reconciliation(
                        request=request,
                        row_id=ledger_row_id,
                        reason="storage range remains non-contiguous",
                        delay_ms=(
                            86_400_000
                            if prior_status == "source_empty"
                            else _LEDGER_STALE_AFTER_MS
                        ),
                        clear_checkpoint=True,
                    )
                report.skipped += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                report.failed += 1
                report.errors.append(
                    f"{request.exchange}:{request.market_type}:"
                    f"{request.symbol}@{request.interval}: {exc}"
                )
                logger.warning(
                    "Gap ledger storage reconciliation failed for %s:%s:%s@%s: %s",
                    request.exchange,
                    request.market_type,
                    request.symbol,
                    request.interval,
                    exc,
                )
                if ledger_row_id is not None:
                    await self._defer_ledger_reconciliation(
                        request=request,
                        row_id=ledger_row_id,
                        reason=f"storage reconciliation failed: {exc}",
                    )
        await self.refresh_suppressions()
        return report

    async def _scan_reconciliation_range(
        self,
        scanner: Callable[..., Any],
        request: RepairRequest,
        *,
        scan_limit: int,
        max_pages: int = _LEDGER_RECONCILE_MAX_PAGES_PER_RANGE,
    ) -> dict[str, Any]:
        """Page an exact ledger range until continuity is proven or disproven."""
        cursor_ms = int(request.start_ms)
        total_scanned = 0
        total_unique_scanned = 0
        checkpoint_scanned = 0
        pages = 0
        interval_ms = parse_interval_ms(request.interval) or 60_000
        calendar, calendar_resolved = self._calendar_for_reconciliation(request)
        if not calendar_resolved:
            return {
                "error": "history calendar became unavailable during reconciliation",
                "truncated": False,
                "gap_count": 0,
                "scanned_bars": 0,
                "pages": 0,
            }
        raw_checkpoint = request.metadata.get("reconciliation_checkpoint")
        if isinstance(raw_checkpoint, dict):
            try:
                checkpoint_ms = int(raw_checkpoint["cursor_ms"])
            except (KeyError, TypeError, ValueError):
                checkpoint_ms = cursor_ms
            if request.start_ms <= checkpoint_ms <= request.end_ms:
                canonical_checkpoint = (
                    calendar.first_expected_open(
                        checkpoint_ms,
                        request.end_ms,
                        request.interval,
                    )
                    if calendar is not None
                    else compute_bucket_start_ms(
                        checkpoint_ms,
                        interval_ms,
                        interval=request.interval,
                    )
                )
                if (
                    canonical_checkpoint is not None
                    and request.start_ms <= canonical_checkpoint <= request.end_ms
                ):
                    cursor_ms = canonical_checkpoint
                    if cursor_ms > request.start_ms:
                        try:
                            checkpoint_scanned = max(
                                0,
                                int(raw_checkpoint.get("scanned_bars", 0) or 0),
                            )
                        except (TypeError, ValueError):
                            checkpoint_scanned = 0
        while pages < max(1, int(max_pages)):
            scan = await run_storage(
                scanner,
                symbol=request.symbol,
                interval=request.interval,
                start_ms=cursor_ms,
                end_ms=request.end_ms,
                exchange=request.exchange,
                market_type=request.market_type,
                limit=max(1, int(scan_limit)),
            )
            pages += 1
            if not isinstance(scan, dict):
                return {
                    "error": "storage gap scan returned a malformed result",
                    "truncated": False,
                    "gap_count": 0,
                    "scanned_bars": total_scanned,
                    "pages": pages,
                    "checkpoint_ms": cursor_ms,
                    "verified_unique_bars": (
                        checkpoint_scanned + total_unique_scanned
                    ),
                }
            if scan.get("error"):
                return {
                    **scan,
                    "scanned_bars": total_scanned + int(
                        scan.get("scanned_bars", 0) or 0
                    ),
                    "pages": pages,
                    "checkpoint_ms": cursor_ms,
                    "verified_unique_bars": (
                        checkpoint_scanned + total_unique_scanned
                    ),
                }
            page_scanned = max(0, int(scan.get("scanned_bars", 0) or 0))
            total_scanned += page_scanned
            total_unique_scanned += page_scanned
            raw_gap_count = scan.get("gap_count")
            gap_count = int(
                raw_gap_count
                if raw_gap_count is not None
                else len(scan.get("gaps", []) or [])
            )
            if gap_count > 0:
                return {
                    **scan,
                    "gap_count": gap_count,
                    "scanned_bars": total_scanned,
                    "truncated": False,
                    "pages": pages,
                    "verified_unique_bars": (
                        checkpoint_scanned + total_unique_scanned
                    ),
                }
            if not scan.get("truncated"):
                return {
                    **scan,
                    "gap_count": 0,
                    "scanned_bars": total_scanned,
                    "truncated": False,
                    "pages": pages,
                    "verified_unique_bars": (
                        checkpoint_scanned + total_unique_scanned
                    ),
                }
            resume_from_ms = scan.get("resume_from_ms")
            if resume_from_ms is None:
                return {
                    **scan,
                    "error": "truncated storage scan did not provide a resume cursor",
                    "scanned_bars": total_scanned,
                    "truncated": True,
                    "pages": pages,
                    "checkpoint_ms": cursor_ms,
                    "verified_unique_bars": (
                        checkpoint_scanned + total_unique_scanned
                    ),
                }
            resume_value = int(resume_from_ms)
            if calendar is not None:
                next_cursor_ms = calendar.next_expected_open(
                    resume_value,
                    request.interval,
                )
            else:
                resume_bucket_ms = compute_bucket_start_ms(
                    resume_value,
                    interval_ms,
                    interval=request.interval,
                )
                # Storage exposes an inclusive last-open cursor.  Exact scans
                # resume at the next canonical UTC bucket in legacy mode.
                next_cursor_ms = compute_bucket_end_ms(
                    resume_bucket_ms,
                    interval_ms,
                    interval=request.interval,
                )
            if next_cursor_ms is None:
                return {
                    **scan,
                    "error": "storage scan resume cursor has no next expected open",
                    "gap_count": 0,
                    "scanned_bars": total_scanned,
                    "truncated": True,
                    "pages": pages,
                    "checkpoint_ms": cursor_ms,
                    "verified_unique_bars": (
                        checkpoint_scanned + total_unique_scanned
                    ),
                }
            if next_cursor_ms <= cursor_ms:
                return {
                    **scan,
                    "error": "storage scan resume cursor did not advance",
                    "gap_count": 0,
                    "scanned_bars": total_scanned,
                    "truncated": True,
                    "pages": pages,
                    "checkpoint_ms": cursor_ms,
                    "verified_unique_bars": (
                        checkpoint_scanned + total_unique_scanned
                    ),
                }
            if next_cursor_ms > request.end_ms:
                return {
                    **scan,
                    "error": "storage scan resume cursor exceeded the requested range",
                    "gap_count": 0,
                    "scanned_bars": total_scanned,
                    "truncated": True,
                    "pages": pages,
                    "checkpoint_ms": cursor_ms,
                    "verified_unique_bars": (
                        checkpoint_scanned + total_unique_scanned
                    ),
                }
            cursor_ms = next_cursor_ms

        return {
            "gap_count": 0,
            "scanned_bars": total_scanned,
            "truncated": True,
            "pages": pages,
            "checkpoint_ms": cursor_ms,
            "verified_unique_bars": checkpoint_scanned + total_unique_scanned,
        }

    async def _checkpoint_ledger_reconciliation(
        self,
        *,
        row_id: int,
        cursor_ms: int,
        scanned_bars: int,
        reason: str,
        delay_ms: int = _LEDGER_STALE_AFTER_MS,
        row_snapshot: dict[str, Any] | None = None,
    ) -> None:
        """Lease and persist progress for a bounded exact-storage scan."""
        if self._gap_ledger is None:
            return
        checkpoint = getattr(
            self._gap_ledger,
            "checkpoint_reconciliation_row",
            None,
        )
        next_retry_at = int(time.time() * 1000) + max(1, int(delay_ms))
        if callable(checkpoint):
            try:
                persisted = await run_storage(
                    checkpoint,
                    int(row_id),
                    cursor_ms=int(cursor_ms),
                    scanned_bars=max(0, int(scanned_bars)),
                    next_retry_at=next_retry_at,
                    error=reason,
                    row_snapshot=row_snapshot,
                )
                if persisted:
                    return
            except Exception:
                logger.exception("Gap ledger reconciliation checkpoint failed")
        await self._defer_ledger_reconciliation(
            row_id=row_id,
            reason=reason,
            delay_ms=delay_ms,
            row_snapshot=row_snapshot,
        )

    async def _clear_ledger_reconciliation_checkpoint(
        self,
        row_id: int,
        *,
        row_snapshot: dict[str, Any] | None = None,
    ) -> bool:
        if self._gap_ledger is None:
            return False
        clear = getattr(
            self._gap_ledger,
            "clear_reconciliation_checkpoint_row",
            None,
        )
        if not callable(clear):
            return True
        try:
            return bool(await run_storage(
                clear,
                int(row_id),
                row_snapshot=row_snapshot,
            ))
        except Exception:
            logger.exception("Gap ledger reconciliation checkpoint cleanup failed")
            return False

    async def _defer_ledger_reconciliation(
        self,
        *,
        request: RepairRequest | None = None,
        row_id: int | None = None,
        reason: str,
        delay_ms: int = _LEDGER_STALE_AFTER_MS,
        row_snapshot: dict[str, Any] | None = None,
        clear_checkpoint: bool = False,
    ) -> bool:
        """Lease a skipped candidate so it cannot starve the next ledger rows."""
        if self._gap_ledger is None:
            return False
        if row_snapshot is None:
            row_snapshot = self._reconciliation_snapshot(request)
        next_retry_at = int(time.time() * 1000) + max(1, int(delay_ms))
        defer_row = getattr(self._gap_ledger, "defer_reconciliation_row", None)
        if row_id is not None and callable(defer_row):
            try:
                return bool(await run_storage(
                    defer_row,
                    row_id,
                    next_retry_at=next_retry_at,
                    error=reason,
                    row_snapshot=row_snapshot,
                    clear_checkpoint=clear_checkpoint,
                ))
            except Exception:
                logger.exception("Gap ledger row defer failed")
        mark_checked = getattr(self._gap_ledger, "mark_reconciled_checked", None)
        if request is not None and callable(mark_checked):
            try:
                await run_storage(
                    mark_checked,
                    request,
                    next_retry_at=next_retry_at,
                )
                return True
            except Exception:
                logger.exception("Gap ledger reconciliation defer failed")
        return False

    async def shutdown(self) -> None:
        """Cancel active and pending repairs."""
        self._shutdown = True
        await self._scheduler.shutdown()
        for request_id, waiters in list(self._progress_waiters.items()):
            snapshot = dict(self._progress_snapshots.get(request_id) or {})
            snapshot.update({
                "request_id": request_id,
                "status": "cancelled",
                "terminal": True,
            })
            for waiter in waiters:
                if not waiter.done():
                    waiter.set_result(dict(snapshot))
        self._progress_waiters.clear()
        ledger_task = self._ledger_write_task
        if ledger_task is not None:
            await asyncio.gather(ledger_task, return_exceptions=True)
        refresh_task = self._ledger_open_refresh_task
        if refresh_task is not None:
            await asyncio.gather(refresh_task, return_exceptions=True)

    def snapshot(self) -> dict:
        snapshot = self._scheduler.snapshot()
        snapshot["gap_ledger_open"] = self._ledger_open_snapshot()
        snapshot["gap_ledger_health"] = dict(self._ledger_health_cache)
        return snapshot

    async def snapshot_async(self) -> dict:
        """Return an exact snapshot without performing SQLite on the loop."""
        snapshot = self._scheduler.snapshot()
        if self._gap_ledger is None:
            snapshot["gap_ledger_open"] = []
            snapshot["gap_ledger_health"] = {
                "open_total": 0,
                "by_status": {},
                "age_buckets": {},
            }
            return snapshot
        list_open = getattr(self._gap_ledger, "list_open", None)
        if not callable(list_open):
            snapshot["gap_ledger_open"] = []
            return snapshot
        try:
            rows = await run_storage(list_open, limit=50)
            self._ledger_open_cache = [
                dict(row)
                for row in rows
                if isinstance(row, dict)
            ]
            self._ledger_open_cache_updated_at = time.monotonic()
        except Exception:
            logger.exception("Gap ledger open snapshot failed")
        health_summary = getattr(self._gap_ledger, "health_summary", None)
        if callable(health_summary):
            try:
                health = await run_storage(health_summary, sample_limit=50)
                if isinstance(health, dict):
                    self._ledger_health_cache = dict(health)
            except Exception:
                logger.exception("Gap ledger health summary failed")
        if not self._ledger_health_cache:
            self._ledger_health_cache = {
                "open_total": len(self._ledger_open_cache),
                "by_status": {},
                "age_buckets": {},
                "sample_limit": 50,
            }
        snapshot["gap_ledger_open"] = [dict(row) for row in self._ledger_open_cache]
        snapshot["gap_ledger_health"] = dict(self._ledger_health_cache)
        return snapshot

    def _request_in_loop(
        self,
        request: RepairRequest,
    ) -> tuple[str, asyncio.Future[RepairOutcome]]:
        if self._shutdown:
            raise RuntimeError("BackfillCoordinator is shut down")

        self._prune_retained_state()
        rejected_reason = self._demand_rejection_reason(request)
        if rejected_reason is not None:
            future = self._future_for(request)
            outcome = RepairOutcome(
                request=request,
                status="cancelled",
                verified_contiguous=False,
                error=rejected_reason,
                terminal_reason="demand_superseded",
                retryable=False,
            )
            self._complete(request, outcome)
            self._note_progress(request, {
                "request_id": request.request_id,
                "revision": 0,
                "status": "cancelled",
                "terminal": True,
                "completed_chunks": 0,
                "total_chunks": 0,
                "pending_chunks": 0,
                "bars_loaded": 0,
                "priority": request.priority,
                "demand_count": 0,
                "cancel_requested": True,
                "updated_at_ms": int(time.time() * 1000),
            })
            return request.request_id, future
        suppression = self.get_repair_suppression(
            request.symbol,
            request.interval,
            request.start_ms,
            request.end_ms,
            request.exchange,
            request.market_type,
        )
        if suppression is not None:
            future = self._future_for(request)
            outcome = RepairOutcome(
                request=request,
                status="suppressed",
                verified_contiguous=False,
                terminal_reason=f"gap_ledger_{suppression['ledger_status']}",
                retryable=False,
                retry_at_ms=suppression.get("retry_at_ms"),
                suppressed=True,
                ledger_status=str(suppression["ledger_status"]),
                suppression=dict(suppression),
            )
            self._complete(request, outcome)
            return request.request_id, future
        prepared = self._prepare_history_request(request)
        if prepared.request is None:
            self._ledger_mark_history_deferred(request, prepared.plan)
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

    def _demand_rejection_reason(self, request: RepairRequest) -> str | None:
        metadata = request.metadata or {}
        owner_id = str(metadata.get("demand_owner_id") or "").strip()
        if owner_id and owner_id in self._revoked_demand_owners:
            return self._revoked_demand_owners[owner_id]
        scope = str(metadata.get("demand_scope") or "").strip()
        generation_raw = metadata.get("demand_generation")
        if not scope or generation_raw is None:
            return None
        try:
            generation = int(generation_raw)
        except (TypeError, ValueError):
            return "invalid_demand_generation"
        current = self._scope_generations.get(scope)
        if current is not None and generation < current:
            return f"scope_superseded:{scope}:{generation}<{current}"
        return None

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
                await self._ledger_mark_started(request, attempt=attempt)
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
                    await self._ledger_mark_retry_wait(
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
                verification_incomplete = False
                terminal_reason: str | None = None
                exhausted_before_ms: int | None = None
                boundary_checked = False
                requires_trusted_finality = repair_requires_trusted_finality(
                    request.metadata,
                    reason=request.reason,
                )
                if not self._is_failed(report.status):
                    await self._ledger_mark_verifying(request)
                    verification = await self._verify_request_range(
                        request,
                        context=history_context,
                        include_rows=True,
                    )
                    verification_incomplete = bool(
                        verification.get("verified_contiguous") is False
                    )
                    if verification_incomplete and not requires_trusted_finality:
                        terminal_reason, exhausted_before_ms = (
                            await self._record_confirmed_left_boundary(
                                request,
                                report,
                                context=history_context,
                            )
                        )
                        boundary_checked = True
                    confirmed_terminal = terminal_reason is not None
                    if (
                        verification_incomplete
                        and not confirmed_terminal
                        and attempt < self._max_retries
                    ):
                        delay = self._backoff(attempt)
                        remaining = verification.get("remaining_missing_bars")
                        await self._ledger_mark_retry_wait(
                            request,
                            attempt=attempt,
                            error=(
                                "backfill verification incomplete"
                                f" ({remaining} rows remain)"
                            ),
                            delay_seconds=delay,
                        )
                        await asyncio.sleep(delay)
                        continue
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

                if (
                    not self._is_failed(report.status)
                    and not boundary_checked
                    and not (
                        verification_incomplete
                        and requires_trusted_finality
                    )
                ):
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
                    report=self._summarize_report(report),
                    attempts=attempt,
                    bars_loaded=bars_loaded,
                    verified_contiguous=verification.get("verified_contiguous"),
                    remaining_missing_bars=verification.get("remaining_missing_bars"),
                    error="; ".join(report.errors) if report.errors else None,
                    terminal_reason=terminal_reason,
                    exhausted_before_ms=exhausted_before_ms,
                    retryable=(
                        (
                            verification_incomplete
                            and terminal_reason is None
                        )
                        or self._report_retryable(report)
                    ),
                )
            except RateLimitDeferred as exc:
                await self._ledger_mark_retry_wait(
                    request,
                    attempt=attempt,
                    error=(
                        f"rate_limit_deferred:{exc.bucket_key}:{exc.reason}"
                    ),
                    delay_seconds=exc.retry_after_seconds,
                )
                raise
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
                    await self._ledger_mark_retry_wait(
                        request,
                        attempt=attempt,
                        error=last_error,
                        delay_seconds=delay,
                    )
                    await asyncio.sleep(delay)

        await self._emit_failed(request, report, last_error)
        return RepairOutcome(
            request=request,
            status="failed",
            report=self._summarize_report(report),
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
        derived_targets = _merge_derived_repair_targets(
            request.metadata.get("derived_repair_targets"),
        )
        verified_rows = (
            (verification or {}).get("_rows")
            if isinstance(verification, dict)
            else None
        )
        for written_range in self._written_ranges_for_request(request, report):
            if isinstance(verified_rows, list):
                range_start = int(written_range["start_ms"])
                range_end = int(written_range["end_ms"])
                rows = [
                    row
                    for row in verified_rows
                    if range_start <= int(row["open_time"]) <= range_end
                ]
            else:
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
                    **(
                        {"derived_repair_targets": derived_targets}
                        if derived_targets else {}
                    ),
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
        derived_targets = _merge_derived_repair_targets(
            request.metadata.get("derived_repair_targets"),
        )
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
                **(
                    {"derived_repair_targets": derived_targets}
                    if derived_targets else {}
                ),
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
        include_rows: bool = False,
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

        physical_actual = {int(row["open_time"]) for row in rows}
        requires_trusted_finality = repair_requires_trusted_finality(
            request.metadata,
            reason=request.reason,
        )
        trusted_rows = [
            row for row in rows
            if source_is_trusted_final(row.get("source"))
        ]
        actual = (
            {int(row["open_time"]) for row in trusted_rows}
            if requires_trusted_finality
            else physical_actual
        )
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

        result = {
            "verified_contiguous": missing == 0,
            "remaining_missing_bars": missing,
            "expected_bars": len(expected_opens),
            "actual_bars": len(physical_actual),
        }
        if requires_trusted_finality:
            result.update({
                "verified_bars": len(actual),
                "requires_trusted_finality": True,
                "untrusted_final_bars": len(
                    expected_opens & (physical_actual - actual)
                ),
            })
        if include_rows:
            # Private handoff to cache reload: verification already paid for
            # this exact storage range, so do not immediately query it again.
            result["_rows"] = trusted_rows if requires_trusted_finality else rows
        return result

    def _ledger_upsert_detected(self, request: RepairRequest) -> None:
        if self._gap_ledger is None:
            return
        # Persist exactly one durable row for the scheduler parent.  Chunk
        # requests inherit this immutable identity and may update progress,
        # but only the aggregate parent completion writes a terminal state.
        request.metadata["ledger_range"] = {
            "start_ms": int(request.start_ms),
            "end_ms": int(request.end_ms),
        }
        # Scheduler submission is synchronous, but SQLite is not.  Coalesce
        # merged requests by id and let one short-lived writer drain them.
        self._ledger_pending_upserts[request.request_id] = request
        self._ledger_pending_upserts.move_to_end(request.request_id)
        self._ensure_ledger_writer()

    def _ensure_ledger_writer(self) -> None:
        task = self._ledger_write_task
        if task is not None and not task.done():
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            self._drain_ledger_writes_sync()
            return
        self._ledger_write_task = asyncio.create_task(
            self._drain_ledger_writes(),
            name="backfill-gap-ledger-writer",
        )

    def _drain_ledger_writes_sync(self) -> None:
        while self._ledger_pending_upserts or self._ledger_pending_operations:
            if self._ledger_pending_upserts:
                requests = list(self._ledger_pending_upserts.values())
                self._ledger_pending_upserts.clear()
                self._persist_ledger_upserts(requests)
            while self._ledger_pending_operations:
                func, args = self._ledger_pending_operations.popleft()
                func(*args)

    async def _drain_ledger_writes(self) -> None:
        while self._ledger_pending_upserts or self._ledger_pending_operations:
            if self._ledger_pending_upserts:
                requests = list(self._ledger_pending_upserts.values())
                self._ledger_pending_upserts.clear()
                try:
                    await run_storage(self._persist_ledger_upserts, requests)
                except Exception:
                    logger.exception("Gap ledger queued upsert batch failed")
            while self._ledger_pending_operations:
                func, args = self._ledger_pending_operations.popleft()
                try:
                    await run_storage(func, *args)
                except Exception:
                    logger.exception("Gap ledger deferred write failed")

    def _persist_ledger_upserts(self, requests: list[RepairRequest]) -> None:
        if self._gap_ledger is None or not requests:
            return
        upsert_many = getattr(self._gap_ledger, "upsert_detected_many", None)
        if callable(upsert_many):
            upsert_many(requests, status="queued")
            return
        for request in requests:
            self._gap_ledger.upsert_detected(request, status="queued")

    async def _ledger_mark_started(self, request: RepairRequest, *, attempt: int) -> None:
        if self._gap_ledger is None:
            return
        try:
            # The synchronous scheduler callback only enqueues the durable
            # "queued" row.  Preserve lifecycle ordering before marking it
            # repairing, while keeping all SQLite work off the event loop.
            queued_write = self._ledger_write_task
            if queued_write is not None and not queued_write.done():
                await asyncio.shield(queued_write)
            await run_storage(self._gap_ledger.mark_started, request, attempt=attempt)
        except Exception:
            logger.exception("Gap ledger start update failed for %s", request.request_id)

    async def _ledger_mark_retry_wait(
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
            await run_storage(
                self._gap_ledger.mark_retry_wait,
                request,
                attempt=attempt,
                error=error,
                next_retry_at=int(time.time() * 1000 + delay_seconds * 1000),
            )
        except Exception:
            logger.exception("Gap ledger retry update failed for %s", request.request_id)

    async def _ledger_mark_verifying(self, request: RepairRequest) -> None:
        if self._gap_ledger is None:
            return
        try:
            await run_storage(self._gap_ledger.mark_verifying, request)
        except Exception:
            logger.exception("Gap ledger verifying update failed for %s", request.request_id)

    async def _ledger_finalize_parent(
        self,
        request: RepairRequest,
        outcome: RepairOutcome,
    ) -> None:
        """Commit one terminal ledger decision after all parent chunks settle."""
        if self._gap_ledger is None:
            return
        if self._is_failed(outcome.status):
            status = "failed"
            missing_count = outcome.remaining_missing_bars
        elif outcome.verified_contiguous is True:
            status = "filled"
            missing_count = 0
        elif (
            outcome.verified_contiguous is False
            and (
                outcome.terminal_reason is None
                or outcome.retryable
            )
        ):
            status = "partial"
            missing_count = outcome.remaining_missing_bars
        else:
            reconcile = getattr(outcome.report, "reconcile_result", None)
            written = int(getattr(reconcile, "bars_written", 0) or 0)
            has_loaded_data = written > 0 or int(outcome.bars_loaded or 0) > 0
            if (
                outcome.terminal_reason is not None
                and not outcome.retryable
            ):
                status = "unavailable" if has_loaded_data else "source_empty"
            elif (
                outcome.verified_contiguous is None
                or outcome.retryable
                or self._status_value(outcome.status) == "partial"
            ):
                status = "partial"
            elif not has_loaded_data:
                status = "source_empty"
            else:
                status = "partial"
            missing_count = outcome.remaining_missing_bars

        verified_coverage: tuple[int, int] | None = None
        if status == "filled":
            target_range = self._target_open_range(request)
            if target_range is not None:
                start_open_ms, _end_open_ms, end_exclusive_ms = target_range
                verified_coverage = (start_open_ms, end_exclusive_ms - 1)

        def _persist() -> None:
            finalize_parent = getattr(self._gap_ledger, "finalize_parent", None)
            if callable(finalize_parent):
                finalize_parent(
                    request,
                    status=status,
                    missing_count=missing_count,
                    error=(
                        outcome.terminal_reason
                        if status == "unavailable"
                        else outcome.error
                    ),
                    attempts=int(outcome.attempts or 0),
                    coverage_start_ms=(
                        verified_coverage[0]
                        if verified_coverage is not None
                        else None
                    ),
                    coverage_end_ms=(
                        verified_coverage[1]
                        if verified_coverage is not None
                        else None
                    ),
                    next_retry_at=(
                        int(time.time() * 1000) + _TERMINAL_LEDGER_RETRY_MS
                        if status == "unavailable"
                        else None
                    ),
                )
                return
            if status == "unavailable":
                mark_deferred = getattr(self._gap_ledger, "mark_deferred", None)
                if callable(mark_deferred):
                    mark_deferred(
                        request,
                        status="unavailable",
                        reason=outcome.terminal_reason,
                        next_retry_at=(
                            int(time.time() * 1000) + _TERMINAL_LEDGER_RETRY_MS
                        ),
                    )
                else:
                    self._gap_ledger.mark_resolved(
                        request,
                        status="partial",
                        missing_count=missing_count,
                        error=outcome.terminal_reason or outcome.error,
                    )
            else:
                self._gap_ledger.mark_resolved(
                    request,
                    status=status,
                    missing_count=missing_count,
                    error=outcome.error,
                )
            mark_attempts = getattr(self._gap_ledger, "mark_attempts", None)
            if callable(mark_attempts):
                mark_attempts(request, attempts=int(outcome.attempts or 0))
            if status == "filled":
                mark_covered = getattr(self._gap_ledger, "mark_covered_resolved", None)
                if callable(mark_covered) and verified_coverage is not None:
                    mark_covered(
                        request,
                        coverage_start_ms=verified_coverage[0],
                        coverage_end_ms=verified_coverage[1],
                    )

        try:
            await run_storage(_persist)
        except Exception:
            logger.exception(
                "Gap ledger parent finalization failed for %s",
                request.request_id,
            )
        else:
            await self.refresh_suppressions()

    @staticmethod
    def _repair_request_from_ledger_row(row: dict[str, Any]) -> RepairRequest:
        """Build a non-scheduled verification request from a ledger row."""
        symbol = str(row.get("symbol") or "").strip().upper()
        interval = str(row.get("interval") or "").strip()
        if not symbol or not interval:
            raise ValueError("ledger row is missing symbol or interval")
        ledger_id = row.get("id")
        metadata: dict[str, Any] = {
            "origin": "ledger_storage_reconciliation",
            "ledger_id": ledger_id,
            "ledger_status": row.get("status"),
            _LEDGER_RECONCILIATION_SNAPSHOT_KEY: {
                "id": ledger_id,
                "status": row.get("status"),
                "last_seen_at": row.get("last_seen_at"),
                "metadata_json": row.get("metadata_json"),
                "repair_ticket": row.get("repair_ticket"),
            },
        }
        raw_metadata = row.get("metadata_json")
        decoded_metadata = _decode_metadata_object(raw_metadata)
        if repair_requires_trusted_finality(
            decoded_metadata,
            reason=row.get("reason"),
        ):
            metadata["requires_trusted_finality"] = True
        checkpoint = decoded_metadata.get("reconciliation_checkpoint")
        if isinstance(checkpoint, dict):
            metadata["reconciliation_checkpoint"] = dict(checkpoint)
        recovery_count = decoded_metadata.get("ledger_recovery_count")
        try:
            metadata["ledger_recovery_count"] = min(
                32,
                max(0, int(recovery_count or 0)),
            )
        except (TypeError, ValueError):
            pass
        return RepairRequest(
            symbol=symbol,
            interval=interval,
            start_ms=int(row["start_ms"]),
            end_ms=int(row["end_ms"]),
            exchange=str(row.get("exchange") or "binance").strip().lower(),
            market_type=str(row.get("market_type") or "spot").strip().lower(),
            reason="ledger_reconcile",
            requester="ledger_reconcile",
            metadata=metadata,
            request_id=f"ledger-reconcile-{ledger_id}",
        )

    @staticmethod
    def _reconciliation_snapshot(
        request: RepairRequest | None,
    ) -> dict[str, Any] | None:
        if request is None:
            return None
        raw = request.metadata.get(_LEDGER_RECONCILIATION_SNAPSHOT_KEY)
        return dict(raw) if isinstance(raw, dict) else None

    def _calendar_for_reconciliation(
        self,
        request: RepairRequest,
    ) -> tuple[TradingCalendar | None, bool]:
        """Resolve a calendar, distinguishing legacy UTC fallback from unknown.

        Embeddings that provide no history policy retain the historical
        always-open UTC behavior.  Once a policy/service is configured, a
        failed or unknown calendar must fail closed rather than silently
        reinterpret a session series on UTC boundaries.
        """
        if self._history_service is None and self._history_policy_resolver is None:
            return None, True
        plan, context = self._plan_history_request(request)
        availability = self._context_availability(context)
        calendar = self._context_calendar(context, availability)
        if calendar is None and self._history_service is not None and plan is not None:
            calendar = self._history_service.calendars.get(plan.calendar_id)
        return calendar, calendar is not None

    @staticmethod
    def _target_open_range_with_calendar(
        request: RepairRequest,
        *,
        calendar: TradingCalendar | None,
        calendar_resolved: bool,
    ) -> tuple[int, int, int] | None:
        """Return first/last target opens and the last exclusive close edge."""
        interval_ms = parse_interval_ms(request.interval)
        if interval_ms is None or interval_ms <= 0:
            return None
        if not calendar_resolved:
            return None
        if calendar is not None:
            start_ms = calendar.first_expected_open(
                int(request.start_ms),
                int(request.end_ms),
                request.interval,
            )
            end_ms = calendar.last_expected_open(
                int(request.start_ms),
                int(request.end_ms),
                request.interval,
            )
            if start_ms is None or end_ms is None or end_ms < start_ms:
                return None
            end_exclusive_ms = expected_bucket_end_ms(
                calendar,
                end_ms,
                request.interval,
            )
            if end_exclusive_ms <= end_ms:
                return None
            return start_ms, end_ms, end_exclusive_ms
        start_ms = compute_bucket_start_ms(
            int(request.start_ms),
            interval_ms,
            interval=request.interval,
        )
        end_ms = compute_bucket_start_ms(
            int(request.end_ms),
            interval_ms,
            interval=request.interval,
        )
        if end_ms < start_ms:
            return None
        end_exclusive_ms = compute_bucket_end_ms(
            end_ms,
            interval_ms,
            interval=request.interval,
        )
        return start_ms, end_ms, end_exclusive_ms

    def _target_open_range(
        self,
        request: RepairRequest,
    ) -> tuple[int, int, int] | None:
        calendar, calendar_resolved = self._calendar_for_reconciliation(request)
        return self._target_open_range_with_calendar(
            request,
            calendar=calendar,
            calendar_resolved=calendar_resolved,
        )

    def _canonical_reconciliation_request(
        self,
        request: RepairRequest,
    ) -> RepairRequest | None:
        """Return the target-open version of a range for strict storage scans."""
        target_range = self._target_open_range(request)
        if target_range is None:
            return None
        start_ms, end_ms, end_exclusive_ms = target_range
        metadata = dict(getattr(request, "metadata", {}) or {})
        metadata["canonical_target_range"] = {
            "start_ms": start_ms,
            "end_ms": end_ms,
        }
        metadata["canonical_coverage_range"] = {
            "start_ms": start_ms,
            "end_ms": end_exclusive_ms - 1,
        }
        return RepairRequest(
            symbol=request.symbol,
            interval=request.interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=request.exchange,
            market_type=request.market_type,
            reason=request.reason,
            priority=request.priority,
            requester=request.requester,
            wait_policy=request.wait_policy,
            metadata=metadata,
            request_id=request.request_id,
        )

    def _request_range_is_fully_closed(
        self,
        request: RepairRequest,
        now_ms: int,
    ) -> bool:
        """Whether every target bucket represented by ``request`` is closed."""
        target_range = self._target_open_range(request)
        if target_range is None:
            return False
        _, _, end_exclusive_ms = target_range
        return end_exclusive_ms <= int(now_ms)

    async def _should_skip_audited_gap(self, request: RepairRequest) -> bool:
        if self._gap_ledger is None:
            return False
        now_ms = int(time.time() * 1000)
        get_covering = getattr(self._gap_ledger, "get_covering_status", None)
        get_status = getattr(self._gap_ledger, "get_status", None)
        if not callable(get_covering) and not callable(get_status):
            return False
        try:
            if callable(get_covering):
                status = await run_storage(
                    get_covering,
                    exchange=request.exchange,
                    market_type=request.market_type,
                    symbol=request.symbol,
                    interval=request.interval,
                    start_ms=request.start_ms,
                    end_ms=request.end_ms,
                    now_ms=now_ms,
                )
            else:
                status = await run_storage(get_status, request)
        except Exception:
            logger.exception("Gap ledger status lookup failed for %s", request.request_id)
            return False
        if not status:
            return False
        status_value = str(status.get("status") or "")

        next_retry_at = status.get("next_retry_at")
        retry_is_future = (
            next_retry_at is not None and int(next_retry_at) > now_ms
        )

        if status_value in {"failed", "unavailable"}:
            return retry_is_future

        if status_value in {
            "queued",
            "repairing",
            "verifying",
            "partial",
            "retry_wait",
        }:
            if retry_is_future:
                return True
            last_activity = next(
                (
                    status.get(key)
                    for key in (
                        "last_checked_at",
                        "last_seen_at",
                        "first_seen_at",
                    )
                    if status.get(key) is not None
                ),
                None,
            )
            if last_activity is None:
                return True
            return now_ms - int(last_activity) < _LEDGER_STALE_AFTER_MS

        if status_value == "not_expected":
            # A forming range becomes actionable naturally once the entire
            # recorded target window has closed.  Never let its old ledger
            # marker suppress that later audit.
            return not self._request_range_is_fully_closed(request, now_ms)

        if status_value != "source_empty":
            return False

        # A source-empty record is only a safe suppression while the exact
        # range remains closed.  Older versions could write this state after
        # asking the provider for a forming daily bar; once that bar closes it
        # must re-enter the normal audit path even if the 24-hour cooldown has
        # not elapsed yet.
        if not self._request_range_is_fully_closed(request, now_ms):
            return True
        resolved_at = status.get("resolved_at") or status.get("last_checked_at")
        if resolved_at is not None:
            if not self._request_range_is_fully_closed(request, int(resolved_at)):
                return False
        if next_retry_at is None:
            return True
        return int(next_retry_at) > now_ms

    def _ledger_mark_history_deferred(
        self,
        request: RepairRequest,
        plan: HistoryPlan | None,
    ) -> None:
        """Persist explicit forming/unavailable decisions without source-empty.

        Fetch planning happens before the scheduler, so no queued ledger row
        exists for a no-fetch outcome unless we create one here.  Keeping these
        semantics distinct prevents a transient/forming request from becoming
        a durable source-empty hole.
        """
        if self._gap_ledger is None or plan is None:
            return
        if plan.disposition not in {
            HistoryDisposition.NOT_EXPECTED,
            HistoryDisposition.RETRYABLE,
            HistoryDisposition.UNKNOWN,
        }:
            return
        def _persist() -> None:
            self._gap_ledger.upsert_detected(request, status="queued")
            mark_deferred = getattr(self._gap_ledger, "mark_deferred", None)
            if not callable(mark_deferred):
                return
            if plan.disposition is HistoryDisposition.NOT_EXPECTED:
                exclusion = plan.exclusions[0] if plan.exclusions else None
                mark_deferred(
                    request,
                    status="not_expected",
                    reason=(exclusion.reason.value if exclusion is not None else None),
                )
                return
            mark_deferred(
                request,
                status="unavailable",
                reason=("history availability is unknown" if plan.unknown else None),
                next_retry_at=(
                    int(plan.retry_at_ms)
                    if plan.retry_at_ms is not None
                    else int(time.time() * 1000) + _LEDGER_STALE_AFTER_MS
                ),
            )

        self._ledger_pending_operations.append((_persist, ()))
        self._ensure_ledger_writer()

    def _ledger_open_snapshot(self) -> list[dict[str, Any]]:
        if self._gap_ledger is None:
            return []
        list_open = getattr(self._gap_ledger, "list_open", None)
        if not callable(list_open):
            return []
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            try:
                return list_open(limit=50)
            except Exception:
                logger.exception("Gap ledger open snapshot failed")
                return []

        now = time.monotonic()
        refresh_task = self._ledger_open_refresh_task
        if (
            now - self._ledger_open_cache_updated_at >= 1.0
            and (refresh_task is None or refresh_task.done())
        ):
            self._ledger_open_refresh_task = asyncio.create_task(
                self._refresh_ledger_open_cache(list_open),
                name="backfill-gap-ledger-snapshot-refresh",
            )
        return [dict(row) for row in self._ledger_open_cache]

    async def _refresh_ledger_open_cache(self, list_open: Callable[..., Any]) -> None:
        try:
            rows = await run_storage(list_open, limit=50)
            self._ledger_open_cache = [
                dict(row)
                for row in rows
                if isinstance(row, dict)
            ]
            self._ledger_open_cache_updated_at = time.monotonic()
        except Exception:
            logger.exception("Gap ledger open snapshot failed")

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

    @classmethod
    def _summarize_report(cls, report: Any | None) -> RepairReportSummary | None:
        """Drop fetched bar payloads before outcomes enter retained history."""
        if report is None:
            return None
        reconcile = getattr(report, "reconcile_result", None)
        reconcile_summary = None
        if reconcile is not None:
            failed_batches = list(getattr(reconcile, "failed_batches", None) or [])
            written_ranges = list(getattr(reconcile, "written_ranges", None) or [])
            reconcile_summary = RepairReconcileSummary(
                bars_received=int(getattr(reconcile, "bars_received", 0) or 0),
                bars_written=int(getattr(reconcile, "bars_written", 0) or 0),
                bars_skipped=int(getattr(reconcile, "bars_skipped", 0) or 0),
                bars_deduplicated=int(getattr(reconcile, "bars_deduplicated", 0) or 0),
                custom_bars_generated=int(
                    getattr(reconcile, "custom_bars_generated", 0) or 0
                ),
                custom_bars_written=int(
                    getattr(reconcile, "custom_bars_written", 0) or 0
                ),
                bars_cached=int(getattr(reconcile, "bars_cached", 0) or 0),
                write_errors=int(getattr(reconcile, "write_errors", 0) or 0),
                failed_batch_count=len(failed_batches),
                written_range_count=len(written_ranges),
                elapsed_ms=int(getattr(reconcile, "elapsed_ms", 0) or 0),
            )

        fetch_results = cls._report_fetch_results(report)
        errors = [str(error) for error in getattr(report, "errors", None) or []]
        report_ranges = cls._raw_written_ranges(report)
        range_summaries: list[RepairWrittenRangeSummary] = []
        for raw_range in report_ranges[:256]:
            normalized = cls._normalize_written_range(raw_range)
            if normalized is None:
                continue
            range_summaries.append(RepairWrittenRangeSummary(
                exchange=normalized["exchange"],
                market_type=normalized["market_type"],
                symbol=normalized["symbol"],
                interval=normalized["interval"],
                start_ms=normalized["start_ms"],
                end_ms=normalized["end_ms"],
            ))
        return RepairReportSummary(
            status=getattr(report, "status", "unknown"),
            errors=tuple(error[:500] for error in errors[:20]),
            error_count=len(errors),
            reconcile_result=reconcile_summary,
            fetch_result_count=len(fetch_results),
            fetched_bar_count=sum(
                int(getattr(result, "bars_count", 0) or len(getattr(result, "bars", ()) or ()))
                for result in fetch_results
            ),
            written_range_count=len(report_ranges),
            written_ranges=tuple(range_summaries),
            elapsed_ms=int(getattr(report, "elapsed_ms", 0) or 0),
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
        # A report that explicitly describes writes for other intervals is
        # authoritative: it did not write this request's target series.  The
        # full-request fallback exists only for legacy reports that carry no
        # written-range metadata at all.
        if raw_ranges:
            return []
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
