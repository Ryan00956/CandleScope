"""Lifecycle, repair, persistence, and fanout for aggregate-trade flow.

The service owns one physical ``aggTrade`` feed per market identity and keeps
exchange callbacks deliberately small: callbacks only append commands to a
bounded FIFO.  One worker is the sole writer to :class:`TradeFlowEngine`, so
live events and REST gap repairs share deterministic ingestion semantics.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

from app.core.executors import run_storage
from app.data_engine.ingestion.models import (
    MarketEvent,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.storage.raw_trade_archive import (
    DisabledRawAggTradeArchive,
    RawAggTradeArchive,
    RawAggTradeArchiveWriter,
    RawAggTradeCoverage,
)
from app.data_engine.storage.trade_flow_store import (
    SQLiteTradeFlowRollupStore,
    TradeFlowRollupStore,
)
from app.data_engine.storage.trade_flow_writer import TradeFlowRollupWriter
from .append_hub import AppendBatchHub, AppendBatchSubscription
from .lifecycle import KeyedAsyncLockPool, drain_cancellation_safe_cleanup
from .models import DeliveryClass, MarketChannel, MarketStreamKey, TransportMode
from .trade_flow import (
    NormalizedAggTrade,
    StreamIdentity,
    TradeFlowBucket,
    TradeFlowEngine,
    TradeFlowGap,
    TradeFlowIngestResult,
)


logger = logging.getLogger("data_engine.market_data.trade_flow")


class _IngestionFactory(Protocol):
    async def start_market(
        self,
        descriptor: StreamDescriptor,
        callback: Any,
        *,
        on_gap: Any | None = None,
    ) -> Any: ...

    async def fetch_market(
        self,
        descriptor: StreamDescriptor,
        *,
        limit: int = 1,
        start_ms: int | None = None,
        end_ms: int | None = None,
        from_id: int | None = None,
        history: bool = False,
    ) -> list[MarketEvent]: ...


@dataclass(frozen=True, slots=True)
class TradeFlowAttachment:
    """One multiplexed raw subscription and its gap-free handoff snapshots."""

    subscription: AppendBatchSubscription[NormalizedAggTrade]
    recent: dict[StreamIdentity, tuple[NormalizedAggTrade, ...]]


@dataclass(slots=True)
class _PhysicalLease:
    handle: Any
    consumers: set[str] = field(default_factory=set)
    idle_stop_task: asyncio.Task[None] | None = None
    stop_task: asyncio.Task[Any] | None = None
    stop_state: str = "active"
    reconcile_stop_on_completion: bool = False


@dataclass(slots=True)
class _IngestCommand:
    identity: StreamIdentity
    event: MarketEvent | NormalizedAggTrade
    gap_fill: bool = False
    acknowledgement: asyncio.Future[TradeFlowIngestResult] | None = None


@dataclass(frozen=True, slots=True)
class _RepairRequest:
    identity: StreamIdentity
    gap: TradeFlowGap
    attempt: int = 1


class _RepairError(RuntimeError):
    pass


class _RepairBudgetExceeded(_RepairError):
    pass


class TradeFlowService:
    """Coordinate append-only aggTrade ingestion independently of K-lines."""

    def __init__(
        self,
        ingestion_factory: _IngestionFactory,
        *,
        engine: TradeFlowEngine | None = None,
        hub: AppendBatchHub[NormalizedAggTrade] | None = None,
        rollup_store: TradeFlowRollupStore | None = None,
        rollup_writer: TradeFlowRollupWriter | None = None,
        raw_archive: RawAggTradeArchive | None = None,
        archive_writer: RawAggTradeArchiveWriter | None = None,
        command_queue_size: int = 8192,
        repair_queue_size: int = 64,
        repair_page_size: int = 1000,
        max_repair_trades_per_gap: int = 10_000,
        max_repair_attempts: int = 3,
        repair_retry_backoff_seconds: float = 0.05,
        flush_interval_seconds: float = 0.05,
        archive_forward_queue_size: int = 8192,
        archive_forward_batch_size: int = 1000,
        max_query_limit: int = 5000,
        max_attach_recent: int = 2000,
        max_streams: int | None = None,
        # The shared ingestion session already gives the underlying WebSocket
        # close operation up to two seconds.  The service-level deadline must
        # leave reconciliation overhead beyond that inner boundary; using the
        # same value turns a successful close into a false timeout/late-success.
        physical_stop_timeout_seconds: float = 3.0,
        physical_idle_grace_seconds: float = 30.0,
    ) -> None:
        self._factory = ingestion_factory
        self.engine = engine or TradeFlowEngine()
        self.hub = hub or AppendBatchHub[NormalizedAggTrade]()

        if rollup_writer is not None:
            if rollup_store is not None and rollup_writer.store is not rollup_store:
                raise ValueError("rollup writer and store must use the same backend")
            self.rollup_writer = rollup_writer
            self.rollup_store = rollup_writer.store
        else:
            self.rollup_store = rollup_store or SQLiteTradeFlowRollupStore()
            self.rollup_writer = TradeFlowRollupWriter(self.rollup_store)

        if archive_writer is not None:
            if raw_archive is not None and archive_writer.archive is not raw_archive:
                raise ValueError("archive writer and archive must use the same backend")
            self.archive_writer = archive_writer
            self.raw_archive = archive_writer.archive
        else:
            self.raw_archive = raw_archive or DisabledRawAggTradeArchive()
            self.archive_writer = RawAggTradeArchiveWriter(self.raw_archive)

        self._command_queue: asyncio.Queue[_IngestCommand | None] = asyncio.Queue(
            maxsize=max(1, int(command_queue_size)),
        )
        self._repair_queue: asyncio.Queue[
            _RepairRequest | None
        ] = asyncio.Queue(maxsize=max(1, int(repair_queue_size)))
        self._archive_queue: asyncio.Queue[NormalizedAggTrade | None] = asyncio.Queue(
            maxsize=max(1, int(archive_forward_queue_size)),
        )
        self._repair_page_size = max(1, min(int(repair_page_size), 1000))
        self._max_repair_trades_per_gap = max(
            1,
            int(max_repair_trades_per_gap),
        )
        self._max_repair_attempts = max(1, int(max_repair_attempts))
        self._repair_retry_backoff_seconds = max(
            0.001,
            float(repair_retry_backoff_seconds),
        )
        self._flush_interval_seconds = max(
            0.02,
            min(float(flush_interval_seconds), 0.1),
        )
        writer_batch_limit = int(
            getattr(self.archive_writer, "_max_rows_per_batch", archive_forward_batch_size),
        )
        self._archive_forward_batch_size = max(
            1,
            min(int(archive_forward_batch_size), writer_batch_limit),
        )
        self._max_query_limit = max(1, min(int(max_query_limit), 5000))
        self._max_attach_recent = max(1, min(int(max_attach_recent), 20_000))
        self._physical_stop_timeout_seconds = max(
            0.01,
            min(float(physical_stop_timeout_seconds), 30.0),
        )
        self._physical_idle_grace_seconds = max(
            0.0,
            min(float(physical_idle_grace_seconds), 300.0),
        )
        engine_max_streams = max(1, int(self.engine.diagnostics()["max_streams"]))
        requested_max_streams = (
            engine_max_streams
            if max_streams is None
            else max(1, int(max_streams))
        )
        # A service must never retain more physical feeds than its engine can
        # retain stream state for.  Otherwise the engine's LRU would silently
        # destroy continuity for still-active feeds.
        self._max_streams = min(requested_max_streams, engine_max_streams)

        self._physical: dict[StreamIdentity, _PhysicalLease] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._identity_locks = KeyedAsyncLockPool[StreamIdentity]()
        self._ingest_task: asyncio.Task[None] | None = None
        self._repair_task: asyncio.Task[None] | None = None
        self._flush_task: asyncio.Task[None] | None = None
        self._archive_task: asyncio.Task[None] | None = None
        self._flush_stop = asyncio.Event()
        self._shutdown_complete = asyncio.Event()
        self._shutdown_task: asyncio.Task[None] | None = None
        self._pending_idle_stop_tasks: set[asyncio.Task[None]] = set()
        self._pending_physical_stop_tasks: set[asyncio.Task[Any]] = set()
        self._pending_stop_finalizers: set[asyncio.Task[None]] = set()
        self._pending_repair_tasks: set[asyncio.Task[None]] = set()
        self._repair_in_flight = 0
        self._degraded_identities: set[StreamIdentity] = set()
        self._shutdown_degraded = False
        self._accepting_events = True
        self._closing = False
        self._closed = False
        self._metrics: dict[str, Any] = {
            "live_commands_enqueued": 0,
            "commands_processed": 0,
            "command_errors": 0,
            "command_queue_high_water": 0,
            "events_after_stop": 0,
            "identity_mismatches": 0,
            "l5_gaps_observed": 0,
            "l5_missing_events_observed": 0,
            "repair_gaps_enqueued": 0,
            "repair_queue_rejected": 0,
            "repairs_started": 0,
            "repairs_succeeded": 0,
            "repairs_failed": 0,
            "repairs_skipped": 0,
            "repair_retries": 0,
            "repairs_exhausted": 0,
            "repair_degraded": 0,
            "repair_budget_exceeded": 0,
            "repair_pages_fetched": 0,
            "repair_rows_fetched": 0,
            "repair_trades_filled": 0,
            "rollup_offer_rejected": 0,
            "rollup_write_failures": 0,
            "archive_forwarded": 0,
            "archive_write_failures": 0,
            "hub_append_rejected": 0,
            "physical_stops_attempted": 0,
            "physical_stops_succeeded": 0,
            "physical_stop_timeouts": 0,
            "physical_stop_failures": 0,
            "physical_stop_tasks_cancelled": 0,
            "physical_stop_wait_cancellations": 0,
            "physical_stop_tasks_reused": 0,
            "physical_stops_late_succeeded": 0,
            "physical_idle_stops_scheduled": 0,
            "physical_idle_stops_cancelled": 0,
            "physical_idle_stops_expired": 0,
            "last_physical_stop_error": None,
            "last_repair_error": None,
        }

    async def ensure_stream(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        consumer_id: str,
    ) -> bool:
        """Acquire an independent logical lease on one physical aggTrade feed."""

        identity = self._validate_identity(key)
        consumer = _consumer_id(consumer_id)
        cleanup_attempted = False
        while True:
            stop_wait: tuple[_PhysicalLease, asyncio.Task[Any]] | None = None
            reservation: _PhysicalLease | None = None
            async with self._identity_locks.hold(identity):
                async with self._lifecycle_lock:
                    self._ensure_open()
                    existing = self._physical.get(identity)
                    if existing is not None:
                        if (
                            existing.stop_task is not None
                            and existing.stop_task.done()
                            and self._reconcile_completed_stop_locked(identity, existing)
                        ):
                            existing = None
                    if existing is not None:
                        if existing.stop_task is not None:
                            stop_wait = (existing, existing.stop_task)
                            cleanup_attempted = True
                        elif existing.stop_state != "active":
                            if cleanup_attempted:
                                raise RuntimeError(
                                    "trade-flow physical stream is unavailable after "
                                    "a failed stop",
                                )
                            stop_wait = (
                                existing,
                                self._start_physical_stop_locked(identity, existing),
                            )
                            cleanup_attempted = True
                        else:
                            self._cancel_idle_stop_locked(existing)
                            if consumer in existing.consumers:
                                return False
                            existing.consumers.add(consumer)
                            return True

                    if existing is None:
                        if len(self._physical) >= self._max_streams:
                            raise RuntimeError(
                                "trade-flow physical stream limit reached "
                                f"({self._max_streams})",
                            )
                        if not self.engine.activate_stream(identity):
                            raise RuntimeError(
                                "trade-flow engine identity is active without a physical lease",
                            )
                        reservation = _PhysicalLease(
                            handle=None,
                            stop_state="starting",
                        )
                        self._physical[identity] = reservation
                        self._start_workers()

                if stop_wait is None:
                    assert reservation is not None

                    async def _on_event(event: MarketEvent) -> None:
                        await self._enqueue_live(identity, event)

                    async def _on_l5_gap(marker: Any) -> None:
                        # L5 detection is diagnostic only.  The engine's exact
                        # agg_trade_id gap is the sole trigger for REST repair.
                        self._metrics["l5_gaps_observed"] += 1
                        self._metrics["l5_missing_events_observed"] += max(
                            0,
                            int(getattr(marker, "expected_count", 0) or 0),
                        )

                    try:
                        handle = await self._factory.start_market(
                            _descriptor(identity),
                            _on_event,
                            on_gap=_on_l5_gap,
                        )
                    except BaseException:
                        await drain_cancellation_safe_cleanup(
                            self._cleanup_start_reservation(identity, reservation),
                            name=(
                                f"trade-flow-start-cleanup-{identity[0]}-"
                                f"{identity[1]}-{identity[2]}"
                            ),
                        )
                        raise

                    try:
                        # Publish the transport into the reservation before the
                        # next await.  Cancellation while acquiring the
                        # lifecycle lock can then stop the real handle instead
                        # of leaving a handle=None ghost lease.
                        reservation.handle = handle
                        async with self._lifecycle_lock:
                            if (
                                not self._closing
                                and not self._closed
                                and self._physical.get(identity) is reservation
                            ):
                                reservation.stop_state = "active"
                                reservation.consumers.add(consumer)
                                return True
                    except BaseException:
                        await drain_cancellation_safe_cleanup(
                            self._cleanup_start_reservation(identity, reservation),
                            name=(
                                f"trade-flow-start-cleanup-{identity[0]}-"
                                f"{identity[1]}-{identity[2]}"
                            ),
                        )
                        raise

                    caller_cancelled = await drain_cancellation_safe_cleanup(
                        self._cleanup_start_reservation(identity, reservation),
                        name=(
                            f"trade-flow-start-cleanup-{identity[0]}-"
                            f"{identity[1]}-{identity[2]}"
                        ),
                    )
                    if caller_cancelled:
                        raise asyncio.CancelledError
                    raise RuntimeError(
                        "trade-flow service closed while stream was starting",
                    )

            # Do not serialize every waiter behind the keyed lock while the
            # shared physical stop performs network I/O.  All callers for this
            # identity can observe and await the same cleanup owner; the keyed
            # lock still protects transitions and same-identity start
            # single-flight above.
            assert stop_wait is not None
            entry, stop_task = stop_wait
            stopped = await self._wait_for_physical_stop(
                identity,
                entry,
                stop_task,
            )
            if stopped:
                continue
            if not stop_task.done():
                raise RuntimeError(
                    "trade-flow physical stream cleanup did not finish "
                    "before the deadline",
                )

    async def release_stream(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        consumer_id: str,
    ) -> bool:
        identity = _normalize_identity(key)
        consumer = _consumer_id(consumer_id)
        async with self._identity_locks.hold(identity):
            async with self._lifecycle_lock:
                entry = self._physical.get(identity)
                if entry is None or consumer not in entry.consumers:
                    return False
                entry.consumers.remove(consumer)
                if entry.consumers:
                    return True
                if not self._closing and self._physical_idle_grace_seconds > 0:
                    self._schedule_idle_stop_locked(identity, entry)
                    return True
                stop_task = self._start_physical_stop_locked(identity, entry)

        return await self._wait_for_physical_stop(identity, entry, stop_task)

    def recent(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        limit: int = 500,
    ) -> list[NormalizedAggTrade]:
        """Return the bounded raw aggTrade ring used by recent/cursor APIs."""

        self._ensure_readable()
        identity = self._validate_identity(key)
        bounded = _bounded_limit(limit, self._max_attach_recent)
        return list(self.engine.raw_tail(identity, bounded))

    async def recent_rollups(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Return the newest 1m rollup tail, including unflushed live rows."""

        self._ensure_readable()
        identity = self._validate_identity(key)
        bounded = _bounded_limit(limit, self._max_query_limit)
        exchange, market_type, symbol = identity
        persisted = await self.rollup_store.query_recent_rollups(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            limit=bounded,
        )
        live = [
            _rollup_row(bucket, source="live")
            for bucket in self.engine.bucket_snapshot(identity)
        ]
        return [
            _public_rollup_row(row)
            for row in _merge_rollups(persisted, live)[-bounded:]
        ]

    async def history(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Return an ascending bounded 1m rollup range."""

        self._ensure_readable()
        identity = self._validate_identity(key)
        start = _optional_non_negative_int(start_ms, "start_ms")
        end = _optional_non_negative_int(end_ms, "end_ms")
        if start is not None and end is not None and start > end:
            raise ValueError("start_ms cannot exceed end_ms")
        bounded = _bounded_limit(limit, self._max_query_limit)
        exchange, market_type, symbol = identity
        persisted = await self.rollup_store.query_rollups(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_ms=start,
            end_ms=end,
            limit=bounded,
        )
        live = []
        for bucket in self.engine.bucket_snapshot(identity):
            if start is not None and bucket.bucket_start_ms < start:
                continue
            if end is not None and bucket.bucket_start_ms > end:
                continue
            live.append(_rollup_row(bucket, source="live"))
        return [
            _public_rollup_row(row)
            for row in _merge_rollups(persisted, live)[:bounded]
        ]

    def attach(
        self,
        keys: (
            MarketStreamKey
            | StreamIdentity
            | Iterable[MarketStreamKey | StreamIdentity]
        ),
        *,
        recent_limit: int = 500,
        max_pending_records: int | None = None,
    ) -> TradeFlowAttachment:
        """Atomically attach one multiplexed subscriber and recent snapshots.

        Pending pre-attachment records are flushed before subscription.  The
        synchronous subscribe-then-snapshot section has no await point, so a
        caller can deduplicate the handoff by ``agg_trade_id`` without gaps.
        """

        if isinstance(keys, MarketStreamKey) or _looks_like_identity(keys):
            return self.attach_many(
                [keys],  # type: ignore[list-item]
                recent_limit=recent_limit,
                max_pending_records=max_pending_records,
            )
        return self.attach_many(
            keys,
            recent_limit=recent_limit,
            max_pending_records=max_pending_records,
        )

    def attach_many(
        self,
        keys: Iterable[MarketStreamKey | StreamIdentity],
        *,
        recent_limit: int = 500,
        max_pending_records: int | None = None,
    ) -> TradeFlowAttachment:
        self._ensure_readable()
        identities = tuple(dict.fromkeys(self._validate_identity(key) for key in keys))
        if not identities:
            raise ValueError("trade-flow attachment requires at least one identity")
        unavailable = [
            identity
            for identity in identities
            if (
                (entry := self._physical.get(identity)) is None
                or entry.stop_state != "active"
                or entry.stop_task is not None
                or not entry.consumers
            )
        ]
        if unavailable:
            raise RuntimeError(
                "trade-flow attachment requires active leased physical streams; "
                f"unavailable for {unavailable}",
            )
        bounded_recent = max(0, min(int(recent_limit), self._max_attach_recent))
        degraded = [
            identity
            for identity in identities
            if self.engine.continuity_degraded(identity)
        ]
        # A repaired/recovered feed can have an old unresolved gap outside the
        # bounded raw tail.  That gap must continue to keep affected rollups and
        # archive coverage incomplete, but it must not permanently brick a new
        # live tape subscription once the exact handoff snapshot is contiguous.
        #
        # This probe and the subscribe-then-snapshot section below are all
        # synchronous, so the ingestion worker cannot advance between them.
        unrecoverable = [
            identity
            for identity in degraded
            if not _is_contiguous_tail(
                self.engine.raw_tail(identity, bounded_recent),
            )
        ]
        if unrecoverable:
            raise RuntimeError(
                "trade-flow attachment requires contiguous retained history; "
                f"unresolved or collapsed gap for {unrecoverable}",
            )
        identity_set = frozenset(identities)

        # AppendBatchHub assigns existing pending records at flush time, not
        # append time.  Flush before subscribing to avoid snapshot/batch overlap.
        self.hub.flush_all()
        subscription = self.hub.subscribe(
            max_pending_records=max_pending_records,
            predicate=lambda trade: trade.stream_identity in identity_set,
        )
        recent = {
            identity: (
                self.engine.raw_tail(identity, bounded_recent)
                if bounded_recent
                else ()
            )
            for identity in identities
        }
        return TradeFlowAttachment(subscription=subscription, recent=recent)

    async def archive_coverage(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        start_time_ms: int | None = None,
        end_time_ms: int | None = None,
        expected_start_agg_trade_id: int | None = None,
        expected_end_agg_trade_id: int | None = None,
    ) -> RawAggTradeCoverage:
        self._ensure_readable()
        exchange, market_type, symbol = self._validate_identity(key)
        start_time = _optional_non_negative_int(start_time_ms, "start_time_ms")
        end_time = _optional_non_negative_int(end_time_ms, "end_time_ms")
        expected_start = _optional_non_negative_int(
            expected_start_agg_trade_id,
            "expected_start_agg_trade_id",
        )
        expected_end = _optional_non_negative_int(
            expected_end_agg_trade_id,
            "expected_end_agg_trade_id",
        )
        if start_time is not None and end_time is not None and start_time > end_time:
            raise ValueError("start_time_ms cannot exceed end_time_ms")
        if (
            expected_start is not None
            and expected_end is not None
            and expected_start > expected_end
        ):
            raise ValueError(
                "expected_start_agg_trade_id cannot exceed "
                "expected_end_agg_trade_id",
            )
        coverage = await run_storage(
            self.raw_archive.coverage,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_time_ms=start_time,
            end_time_ms=end_time,
            expected_start_agg_trade_id=expected_start,
            expected_end_agg_trade_id=expected_end,
        )
        writer_diagnostics = self.archive_writer.diagnostics()
        if writer_diagnostics.get("state") == "failed":
            writer_error = writer_diagnostics.get("last_error")
            errors = [
                item
                for item in (
                    f"archive writer failed: {writer_error}" if writer_error else None,
                    coverage.error,
                )
                if item
            ]
            coverage = replace(
                coverage,
                complete=False,
                status="degraded",
                error="; ".join(errors),
            )
        return coverage

    def diagnostics(self) -> dict[str, Any]:
        if self._closed:
            state = "closed"
        elif self._closing:
            state = "closing"
        elif self._ingest_task is not None:
            state = "running"
        else:
            state = "idle"
        return {
            "state": state,
            "physical_streams": len(self._physical),
            "logical_leases": sum(
                len(entry.consumers) for entry in self._physical.values()
            ),
            "max_streams": self._max_streams,
            "physical": [
                {
                    "exchange": identity[0],
                    "market_type": identity[1],
                    "symbol": identity[2],
                    "consumers": len(entry.consumers),
                    "idle_stop_pending": entry.idle_stop_task is not None,
                    "stop_state": entry.stop_state,
                }
                for identity, entry in sorted(self._physical.items())
            ],
            "command_queue": {
                "pending": self._command_queue.qsize(),
                "limit": self._command_queue.maxsize,
            },
            "repair_queue": {
                "pending": self._repair_queue.qsize(),
                "pending_enqueues": len(self._pending_repair_tasks),
                "in_flight": self._repair_in_flight,
                "limit": self._repair_queue.maxsize,
                "page_size": self._repair_page_size,
                "max_trades_per_gap": self._max_repair_trades_per_gap,
                "max_attempts": self._max_repair_attempts,
            },
            "degraded": bool(self._degraded_identities) or self._shutdown_degraded,
            "degraded_streams": [
                {
                    "exchange": identity[0],
                    "market_type": identity[1],
                    "symbol": identity[2],
                }
                for identity in sorted(self._degraded_identities)
            ],
            "archive_forward_queue": {
                "pending": self._archive_queue.qsize(),
                "limit": self._archive_queue.maxsize,
            },
            "pending_idle_stops": len(self._pending_idle_stop_tasks),
            "physical_idle_grace_seconds": self._physical_idle_grace_seconds,
            "shutdown": {
                "degraded": self._shutdown_degraded,
                "pending_idle_stops": len(self._pending_idle_stop_tasks),
                "pending_physical_stop_tasks": len(
                    self._pending_physical_stop_tasks
                ),
                "pending_stop_finalizers": len(self._pending_stop_finalizers),
                "physical_stop_timeout_seconds": (
                    self._physical_stop_timeout_seconds
                ),
                "last_physical_stop_error": self._metrics[
                    "last_physical_stop_error"
                ],
            },
            "engine": self.engine.diagnostics(),
            "hub": self.hub.diagnostics(),
            "rollup_writer": self.rollup_writer.diagnostics(),
            "archive_writer": self.archive_writer.diagnostics(),
            **self._metrics,
        }

    async def shutdown(self) -> None:
        """Stop feeds, drain repair/ingestion, flush sinks, and close fanout."""

        async with self._lifecycle_lock:
            if self._closed:
                return
            if self._shutdown_task is None:
                self._closing = True
                self._shutdown_task = asyncio.create_task(
                    self._shutdown_impl(),
                    name="trade-flow-shutdown",
                )
            task = self._shutdown_task
        # Caller cancellation/timeouts must not strand a half-closed service.
        # A subsequent shutdown call can await this same cleanup task.
        await asyncio.shield(task)

    async def _shutdown_impl(self) -> None:
        """Perform cleanup once; feed-stop degradation cannot block draining."""

        self._accepting_events = False
        await self._cancel_idle_stops()
        await self._drain_stop_finalizers()
        async with self._lifecycle_lock:
            identities = tuple(self._physical)
        if identities:
            await asyncio.gather(*(
                self._shutdown_identity(identity) for identity in identities
            ))
        await asyncio.sleep(0)
        await self._drain_stop_finalizers()
        async with self._lifecycle_lock:
            for identity, entry in tuple(self._physical.items()):
                self._retire_entry_locked(identity, entry)

        if self._ingest_task is not None:
            await self._command_queue.join()
            await self._drain_repairs()
            await self._command_queue.join()
            if self._archive_task is not None:
                await self._archive_queue.join()

            await self._repair_queue.put(None)
            await asyncio.shield(self._repair_task)
            await self._command_queue.put(None)
            await asyncio.shield(self._ingest_task)
            if self._archive_task is not None:
                await self._archive_queue.put(None)
                await asyncio.shield(self._archive_task)

            self._flush_stop.set()
            await asyncio.shield(self._flush_task)

        self.hub.flush_all()
        await self.hub.close(flush=False)
        await self.rollup_writer.close()
        await self.archive_writer.close()

        self._closed = True
        self._shutdown_complete.set()

    def _schedule_idle_stop_locked(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> None:
        """Arm one cancellable grace timer for an active zero-consumer lease."""

        existing = entry.idle_stop_task
        if existing is not None and not existing.done():
            return
        task = asyncio.create_task(
            self._stop_after_idle_grace(identity, entry),
            name=(
                f"trade-flow-idle-stop-{identity[0]}-"
                f"{identity[1]}-{identity[2]}"
            ),
        )
        entry.idle_stop_task = task
        self._pending_idle_stop_tasks.add(task)
        self._metrics["physical_idle_stops_scheduled"] += 1
        task.add_done_callback(self._pending_idle_stop_tasks.discard)
        task.add_done_callback(self._consume_task_exception)

    def _cancel_idle_stop_locked(
        self,
        entry: _PhysicalLease,
    ) -> asyncio.Task[None] | None:
        task = entry.idle_stop_task
        if task is None:
            return None
        entry.idle_stop_task = None
        self._pending_idle_stop_tasks.discard(task)
        if not task.done() and task.cancel():
            self._metrics["physical_idle_stops_cancelled"] += 1
        return task

    async def _cancel_idle_stops(self) -> None:
        tasks: list[asyncio.Task[None]] = []
        async with self._lifecycle_lock:
            for entry in self._physical.values():
                task = self._cancel_idle_stop_locked(entry)
                if task is not None:
                    tasks.append(task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _stop_after_idle_grace(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> None:
        current = asyncio.current_task()
        assert current is not None
        try:
            await asyncio.sleep(self._physical_idle_grace_seconds)
            async with self._identity_locks.hold(identity):
                async with self._lifecycle_lock:
                    if (
                        self._physical.get(identity) is not entry
                        or entry.idle_stop_task is not current
                    ):
                        return
                    entry.idle_stop_task = None
                    self._pending_idle_stop_tasks.discard(current)
                    if (
                        entry.consumers
                        or entry.stop_task is not None
                        or entry.stop_state != "active"
                    ):
                        return
                    self._metrics["physical_idle_stops_expired"] += 1
                    stop_task = self._start_physical_stop_locked(identity, entry)

            await self._wait_for_physical_stop(identity, entry, stop_task)
        except asyncio.CancelledError:
            return

    async def _shutdown_identity(self, identity: StreamIdentity) -> None:
        async with self._identity_locks.hold(identity):
            async with self._lifecycle_lock:
                entry = self._physical.get(identity)
                if entry is None:
                    return
                entry.consumers.clear()
            await self._stop_physical(identity, entry)

    async def _stop_physical(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> bool:
        """Stop one feed without holding the global lifecycle lock while waiting."""

        async with self._lifecycle_lock:
            if self._physical.get(identity) is not entry:
                return True
            if (
                entry.stop_task is not None
                and entry.stop_task.done()
                and self._reconcile_completed_stop_locked(identity, entry)
            ):
                return True
            stop_task = self._start_physical_stop_locked(identity, entry)
        return await self._wait_for_physical_stop(identity, entry, stop_task)

    async def _cleanup_start_reservation(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> None:
        if entry.handle is None:
            async with self._lifecycle_lock:
                self._retire_entry_locked(identity, entry)
            return
        stopped = await self._stop_physical(identity, entry)
        if stopped:
            async with self._lifecycle_lock:
                self._retire_entry_locked(identity, entry)

    def _start_physical_stop_locked(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> asyncio.Task[Any]:
        """Create or reuse the sole cleanup owner while lifecycle state is locked."""

        stop_task = entry.stop_task
        if stop_task is None:
            self._metrics["physical_stops_attempted"] += 1
            stop_task = asyncio.create_task(
                entry.handle.stop(),
                name=(
                    f"trade-flow-stop-{identity[0]}-"
                    f"{identity[1]}-{identity[2]}"
                ),
            )
            entry.stop_task = stop_task
            entry.reconcile_stop_on_completion = False
            self._pending_physical_stop_tasks.add(stop_task)
            stop_task.add_done_callback(
                self._pending_physical_stop_tasks.discard,
            )
        else:
            self._metrics["physical_stop_tasks_reused"] += 1
        entry.stop_state = "stopping"
        return stop_task

    async def _wait_for_physical_stop(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
        stop_task: asyncio.Task[Any],
    ) -> bool:
        """Bound one caller's wait without cancelling the shared cleanup owner."""

        try:
            result = await asyncio.wait_for(
                asyncio.shield(stop_task),
                timeout=self._physical_stop_timeout_seconds,
            )
            if result is False:
                raise RuntimeError("physical stream reported stop failure")
        except TimeoutError:
            self._metrics["physical_stop_timeouts"] += 1
            self._arm_late_stop_reconciliation(identity, entry, stop_task)
            self._record_physical_stop_failure(
                identity,
                "timed out after "
                f"{self._physical_stop_timeout_seconds:.3f}s",
            )
            return False
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                self._metrics["physical_stop_wait_cancellations"] += 1
                self._arm_late_stop_reconciliation(identity, entry, stop_task)
                self._record_physical_stop_failure(
                    identity,
                    "caller cancelled while stop was in progress",
                )
                raise
            async with self._lifecycle_lock:
                if entry.stop_task is not stop_task:
                    return self._physical.get(identity) is not entry
                self._clear_stop_task(entry, stop_task, state="stop_cancelled")
                self._metrics["physical_stop_failures"] += 1
            self._record_physical_stop_failure(identity, "stop task was cancelled")
            return False
        except Exception as exc:
            async with self._lifecycle_lock:
                if entry.stop_task is not stop_task:
                    return self._physical.get(identity) is not entry
                self._clear_stop_task(entry, stop_task, state="stop_failed")
                self._metrics["physical_stop_failures"] += 1
            self._record_physical_stop_failure(identity, str(exc))
            return False
        else:
            async with self._lifecycle_lock:
                if entry.stop_task is not stop_task:
                    return self._physical.get(identity) is not entry
                self._clear_stop_task(entry, stop_task, state="stopped")
                if self._physical.get(identity) is entry:
                    self._physical.pop(identity, None)
                    self.engine.deactivate_stream(identity)
                self._metrics["physical_stops_succeeded"] += 1
                return True

    def _reconcile_completed_stop_locked(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> bool:
        """Synchronously reconcile a done stop while lifecycle lock is held."""

        stop_task = entry.stop_task
        if stop_task is None or not stop_task.done():
            return False
        entry.reconcile_stop_on_completion = False
        if stop_task.cancelled():
            self._clear_stop_task(entry, stop_task, state="stop_cancelled")
            return False
        try:
            result = stop_task.result()
        except asyncio.CancelledError:
            self._clear_stop_task(entry, stop_task, state="stop_cancelled")
            return False
        except Exception as exc:
            self._clear_stop_task(entry, stop_task, state="stop_failed")
            self._metrics["physical_stop_failures"] += 1
            self._record_physical_stop_failure(identity, f"late failure: {exc}")
            return False
        if result is False:
            self._clear_stop_task(entry, stop_task, state="stop_failed")
            self._metrics["physical_stop_failures"] += 1
            self._record_physical_stop_failure(
                identity,
                "late physical stream reported stop failure",
            )
            return False

        self._clear_stop_task(entry, stop_task, state="stopped")
        if self._physical.get(identity) is entry:
            self._physical.pop(identity, None)
            self.engine.deactivate_stream(identity)
        self._metrics["physical_stops_late_succeeded"] += 1
        return True

    def _arm_late_stop_reconciliation(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
        stop_task: asyncio.Task[Any],
    ) -> None:
        if entry.reconcile_stop_on_completion:
            return
        entry.reconcile_stop_on_completion = True
        stop_task.add_done_callback(
            lambda completed: self._schedule_late_stop_reconciliation(
                identity,
                entry,
                completed,
            ),
        )

    def _schedule_late_stop_reconciliation(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
        stop_task: asyncio.Task[Any],
    ) -> None:
        finalizer = asyncio.create_task(
            self._reconcile_late_physical_stop(identity, entry, stop_task),
            name=(
                f"trade-flow-stop-finalize-{identity[0]}-"
                f"{identity[1]}-{identity[2]}"
            ),
        )
        self._pending_stop_finalizers.add(finalizer)
        finalizer.add_done_callback(self._pending_stop_finalizers.discard)
        finalizer.add_done_callback(self._consume_task_exception)

    async def _reconcile_late_physical_stop(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
        stop_task: asyncio.Task[Any],
    ) -> None:
        """Consume a detached stop result and repair lease truthfulness."""

        async with self._identity_locks.hold(identity):
            async with self._lifecycle_lock:
                if (
                    not entry.reconcile_stop_on_completion
                    or entry.stop_task is not stop_task
                ):
                    self._consume_task_exception(stop_task)
                    return
                entry.reconcile_stop_on_completion = False
                if stop_task.cancelled():
                    self._clear_stop_task(entry, stop_task, state="stop_cancelled")
                    return
                try:
                    result = stop_task.result()
                except asyncio.CancelledError:
                    self._clear_stop_task(entry, stop_task, state="stop_cancelled")
                    return
                except Exception as exc:
                    self._clear_stop_task(entry, stop_task, state="stop_failed")
                    self._metrics["physical_stop_failures"] += 1
                    self._record_physical_stop_failure(identity, f"late failure: {exc}")
                    return
                if result is False:
                    self._clear_stop_task(entry, stop_task, state="stop_failed")
                    self._metrics["physical_stop_failures"] += 1
                    self._record_physical_stop_failure(
                        identity,
                        "late physical stream reported stop failure",
                    )
                    return

                self._clear_stop_task(entry, stop_task, state="stopped")
                self._retire_entry_locked(identity, entry)
                self._metrics["physical_stops_late_succeeded"] += 1

    def _retire_entry_locked(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> bool:
        if self._physical.get(identity) is not entry:
            return False
        self._physical.pop(identity, None)
        self.engine.deactivate_stream(identity)
        return True

    @staticmethod
    def _clear_stop_task(
        entry: _PhysicalLease,
        stop_task: asyncio.Task[Any],
        *,
        state: str,
    ) -> None:
        if entry.stop_task is stop_task:
            entry.stop_task = None
            entry.reconcile_stop_on_completion = False
        entry.stop_state = state

    @staticmethod
    def _consume_task_exception(task: asyncio.Task[Any]) -> None:
        if task.cancelled():
            return
        try:
            task.exception()
        except asyncio.CancelledError:
            return

    def _record_physical_stop_failure(
        self,
        identity: StreamIdentity,
        error: str,
    ) -> None:
        self._shutdown_degraded = True
        message = f"{identity}: {error}"
        self._metrics["last_physical_stop_error"] = message[:500]
        logger.warning("Trade-flow physical stop degraded: %s", message)

    async def _drain_repairs(self) -> None:
        while True:
            pending = tuple(self._pending_repair_tasks)
            if pending:
                await asyncio.gather(*pending)
            await self._repair_queue.join()
            await asyncio.sleep(0)
            if (
                not self._pending_repair_tasks
                and self._repair_queue.empty()
                and self._repair_in_flight == 0
            ):
                return

    async def _drain_stop_finalizers(self) -> None:
        while self._pending_stop_finalizers:
            pending = tuple(self._pending_stop_finalizers)
            await asyncio.gather(*pending)
            self._pending_stop_finalizers.difference_update(pending)

    def _start_workers(self) -> None:
        if self._ingest_task is not None and not self._ingest_task.done():
            return
        self.rollup_writer.start()
        self.archive_writer.start()
        self._ingest_task = asyncio.create_task(
            self._run_ingest(),
            name="trade-flow-ingest",
        )
        self._repair_task = asyncio.create_task(
            self._run_repairs(),
            name="trade-flow-repair",
        )
        self._flush_task = asyncio.create_task(
            self._run_flush(),
            name="trade-flow-batch-flush",
        )
        if self.raw_archive.enabled:
            self._archive_task = asyncio.create_task(
                self._run_archive_forwarding(),
                name="trade-flow-archive-forwarding",
            )

    async def _enqueue_live(
        self,
        identity: StreamIdentity,
        event: MarketEvent,
    ) -> None:
        if not self._accepting_events:
            self._metrics["events_after_stop"] += 1
            return
        await self._command_queue.put(_IngestCommand(identity=identity, event=event))
        self._metrics["live_commands_enqueued"] += 1
        self._metrics["command_queue_high_water"] = max(
            self._metrics["command_queue_high_water"],
            self._command_queue.qsize(),
        )

    async def _run_ingest(self) -> None:
        while True:
            command = await self._command_queue.get()
            if command is None:
                self._command_queue.task_done()
                return
            try:
                trade = (
                    command.event
                    if isinstance(command.event, NormalizedAggTrade)
                    else NormalizedAggTrade.from_market_event(command.event)
                )
                if trade.stream_identity != command.identity:
                    self._metrics["identity_mismatches"] += 1
                    raise ValueError(
                        "aggregate trade identity does not match physical stream",
                    )
                result = (
                    self.engine.ingest_gap_fill(trade)
                    if command.gap_fill
                    else self.engine.ingest(trade)
                )
                if result.accepted:
                    await self._forward_result(result)
                self._metrics["commands_processed"] += 1
            except Exception as exc:
                self._metrics["command_errors"] += 1
                if command.acknowledgement is not None:
                    if not command.acknowledgement.done():
                        command.acknowledgement.set_exception(exc)
                else:
                    logger.warning("Rejected aggregate-trade command: %s", exc)
            else:
                if command.acknowledgement is not None:
                    if not command.acknowledgement.done():
                        command.acknowledgement.set_result(result)
            finally:
                self._command_queue.task_done()

    async def _forward_result(self, result: TradeFlowIngestResult) -> None:
        assert result.trade is not None
        if not result.is_gap_fill:
            if result.detected_gap is not None:
                self.hub.mark_discontinuity(
                    missing_records=result.detected_gap.missing_count,
                )
            if not self.hub.append(result.trade):
                self._metrics["hub_append_rejected"] += 1

        if result.detected_gap is not None:
            request = _RepairRequest(
                identity=result.trade.stream_identity,
                gap=result.detected_gap,
            )
            if _range_is_open(result.unresolved_gaps, result.detected_gap):
                self._schedule_repair(request)
            else:
                self._mark_repair_degraded(request.identity)

        await self._persist_rollups(result)
        if self.raw_archive.enabled:
            await self._archive_queue.put(result.trade)

    async def _persist_rollups(self, result: TradeFlowIngestResult) -> None:
        assert result.trade is not None
        source = result.trade.source.value
        final_rows: list[dict[str, Any]] = []
        for bucket in result.buckets:
            row = _rollup_row(bucket, source=source)
            if bucket.is_final:
                final_rows.append(row)
            elif not self.rollup_writer.offer(row):
                self._metrics["rollup_offer_rejected"] += 1
        if final_rows:
            try:
                acknowledgement = await self.rollup_writer.enqueue(final_rows)
            except Exception:
                self._metrics["rollup_write_failures"] += 1
                logger.exception("Failed to enqueue final trade-flow rollup")
            else:
                if acknowledgement is not None:
                    acknowledgement.add_done_callback(self._on_rollup_write_done)

    def _on_rollup_write_done(self, acknowledgement: asyncio.Future[int]) -> None:
        if acknowledgement.cancelled():
            self._metrics["rollup_write_failures"] += 1
            logger.error("Final trade-flow rollup write was cancelled")
            return
        try:
            acknowledgement.result()
        except Exception:
            self._metrics["rollup_write_failures"] += 1
            logger.exception("Failed to persist final trade-flow rollup")

    def _schedule_repair(
        self,
        request: _RepairRequest,
        *,
        delay_seconds: float = 0.0,
    ) -> None:
        task = asyncio.create_task(
            self._put_repair(request, delay_seconds=delay_seconds),
            name=(
                "trade-flow-repair-enqueue-"
                f"{request.identity[2]}-{request.gap.start_id}-{request.attempt}"
            ),
        )
        self._pending_repair_tasks.add(task)
        task.add_done_callback(self._pending_repair_tasks.discard)

    async def _put_repair(
        self,
        request: _RepairRequest,
        *,
        delay_seconds: float,
    ) -> None:
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)
        if not _range_is_open(
            self.engine.gap_snapshot(request.identity),
            request.gap,
        ):
            self._metrics["repairs_skipped"] += 1
            return
        # Awaiting capacity in a separate task is lossless without blocking the
        # sole ingestion worker that repair acknowledgements depend on.
        await self._repair_queue.put(request)
        self._metrics["repair_gaps_enqueued"] += 1

    def _mark_repair_degraded(self, identity: StreamIdentity) -> None:
        if identity in self._degraded_identities:
            return
        self._degraded_identities.add(identity)
        self._metrics["repair_degraded"] += 1

    async def _run_repairs(self) -> None:
        while True:
            request = await self._repair_queue.get()
            if request is None:
                self._repair_queue.task_done()
                return
            self._repair_in_flight += 1
            try:
                await self._repair_gap(request.identity, request.gap)
            except Exception as exc:
                self._metrics["repairs_failed"] += 1
                self._metrics["last_repair_error"] = str(exc)[:500]
                logger.warning(
                    "aggTrade repair attempt %s failed for %s %s-%s: %s",
                    request.attempt,
                    request.identity,
                    request.gap.start_id,
                    request.gap.end_id,
                    exc,
                )
                retryable = (
                    not isinstance(exc, _RepairBudgetExceeded)
                    and request.attempt < self._max_repair_attempts
                    and _range_is_open(
                        self.engine.gap_snapshot(request.identity),
                        request.gap,
                    )
                )
                if retryable:
                    self._metrics["repair_retries"] += 1
                    retry = _RepairRequest(
                        identity=request.identity,
                        gap=request.gap,
                        attempt=request.attempt + 1,
                    )
                    self._schedule_repair(
                        retry,
                        delay_seconds=(
                            self._repair_retry_backoff_seconds
                            * (2 ** (request.attempt - 1))
                        ),
                    )
                else:
                    self._metrics["repairs_exhausted"] += 1
                    self._mark_repair_degraded(request.identity)
            finally:
                self._repair_in_flight -= 1
                self._repair_queue.task_done()

    async def _repair_gap(
        self,
        identity: StreamIdentity,
        gap: TradeFlowGap,
    ) -> None:
        if not _range_is_open(self.engine.gap_snapshot(identity), gap):
            self._metrics["repairs_skipped"] += 1
            return
        self._metrics["repairs_started"] += 1
        if gap.missing_count > self._max_repair_trades_per_gap:
            self._metrics["repair_budget_exceeded"] += 1
            raise _RepairBudgetExceeded(
                "gap exceeds repair budget "
                f"({gap.missing_count} > {self._max_repair_trades_per_gap})",
            )

        descriptor = _descriptor(identity)
        open_ranges = _open_gap_intersections(
            self.engine.gap_snapshot(identity),
            gap,
        )
        for start_id, end_id in open_ranges:
            cursor = start_id
            while cursor <= end_id:
                page_count = min(
                    self._repair_page_size,
                    end_id - cursor + 1,
                )
                events = await self._factory.fetch_market(
                    descriptor,
                    from_id=cursor,
                    limit=page_count,
                    history=True,
                )
                self._metrics["repair_pages_fetched"] += 1
                self._metrics["repair_rows_fetched"] += len(events)
                trades = [
                    NormalizedAggTrade.from_market_event(event)
                    for event in events
                ]
                expected_ids = list(range(cursor, cursor + page_count))
                actual_ids = [trade.agg_trade_id for trade in trades]
                if actual_ids != expected_ids:
                    raise _RepairError(
                        "REST repair page is not the exact requested ID range "
                        f"(expected {expected_ids[0]}-{expected_ids[-1]}, "
                        f"got {actual_ids})",
                    )
                if any(trade.stream_identity != identity for trade in trades):
                    raise _RepairError(
                        "REST repair page contains a foreign identity",
                    )

                for trade in trades:
                    acknowledgement = asyncio.get_running_loop().create_future()
                    await self._command_queue.put(
                        _IngestCommand(
                            identity=identity,
                            event=trade,
                            gap_fill=True,
                            acknowledgement=acknowledgement,
                        ),
                    )
                    result = await asyncio.shield(acknowledgement)
                    if not result.accepted:
                        raise _RepairError(
                            "engine rejected validated gap-fill trade "
                            f"{trade.agg_trade_id}: {result.reason}",
                        )
                    self._metrics["repair_trades_filled"] += 1
                cursor += page_count

        if _range_is_open(self.engine.gap_snapshot(identity), gap):
            raise _RepairError("engine still reports the repaired ID range incomplete")
        self._metrics["repairs_succeeded"] += 1

    async def _run_flush(self) -> None:
        while not self._flush_stop.is_set():
            try:
                await asyncio.wait_for(
                    self._flush_stop.wait(),
                    timeout=self._flush_interval_seconds,
                )
            except asyncio.TimeoutError:
                pass
            self.hub.flush_all()
        self.hub.flush_all()

    async def _run_archive_forwarding(self) -> None:
        while True:
            first = await self._archive_queue.get()
            if first is None:
                self._archive_queue.task_done()
                return
            trades = [first]
            while len(trades) < self._archive_forward_batch_size:
                try:
                    candidate = self._archive_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if candidate is None:
                    # Shutdown enqueues the sentinel only after join(), so this
                    # is defensive rather than an expected mixed batch.
                    self._archive_queue.task_done()
                    break
                trades.append(candidate)
            try:
                acknowledgement = await self.archive_writer.enqueue(
                    trade.to_dict() for trade in trades
                )
                if acknowledgement is not None:
                    acknowledgement.add_done_callback(
                        self._archive_acknowledged,
                    )
            except Exception:
                self._metrics["archive_write_failures"] += 1
                logger.exception("Failed to enqueue raw aggregate trades")
            finally:
                for _ in trades:
                    self._archive_queue.task_done()

    def _archive_acknowledged(self, acknowledgement: asyncio.Future[int]) -> None:
        if acknowledgement.cancelled():
            self._metrics["archive_write_failures"] += 1
            return
        try:
            accepted = acknowledgement.result()
        except Exception as exc:
            self._metrics["archive_write_failures"] += 1
            logger.error("Failed to archive raw aggregate trades: %s", exc)
        else:
            self._metrics["archive_forwarded"] += accepted

    def _validate_identity(
        self,
        key: MarketStreamKey | StreamIdentity,
    ) -> StreamIdentity:
        # Lazy import keeps ``app.exchanges.models -> market_data.models`` from
        # cycling if this service is re-exported by the market_data package.
        from app.exchanges import bootstrap_default_adapters, get_exchange_registry

        identity = _normalize_identity(key)
        bootstrap_default_adapters()
        try:
            capabilities = get_exchange_registry().get_plugin(identity[0]).capabilities()
        except KeyError as exc:
            raise ValueError(str(exc)) from exc
        if getattr(capabilities, "capability_schema_version", 1) < 2:
            raise ValueError("trade-flow requires an authoritative capability schema v2")
        capability = capabilities.channel_capability(
            MarketChannel.AGG_TRADE,
            identity[1],
        )
        supported = (
            capability is not None
            and capability.realtime
            and capability.history
            and capability.delivery is DeliveryClass.APPEND
            and capability.sequence == "monotonic_id"
            and capability.resync == "snapshot_replay"
            and any(
                capability.supports_transport(transport)
                for transport in (
                    TransportMode.WEBSOCKET,
                    TransportMode.PLUGIN_STREAM,
                )
            )
            and capability.supports_transport(
                TransportMode.REST_HISTORY,
                history=True,
            )
        )
        if not supported:
            raise ValueError(
                f"{identity[0]}:{identity[1]}:agg_trade does not support "
                "append realtime plus ID-based history repair",
            )
        return identity

    def _ensure_open(self) -> None:
        if self._closing or self._closed:
            raise RuntimeError("trade-flow service is closed")

    def _ensure_readable(self) -> None:
        if self._closed:
            raise RuntimeError("trade-flow service is closed")


def _normalize_identity(key: MarketStreamKey | StreamIdentity) -> StreamIdentity:
    if isinstance(key, MarketStreamKey):
        if key.channel is not MarketChannel.AGG_TRADE:
            raise ValueError("trade-flow service only accepts agg_trade keys")
        if key.params:
            raise ValueError("agg_trade keys do not accept params")
        values: tuple[object, object, object] = (
            key.exchange,
            key.market_type,
            key.symbol,
        )
    elif _looks_like_identity(key):
        values = key  # type: ignore[assignment]
    else:
        raise TypeError("trade-flow identity must be a key or three-string tuple")
    exchange, market_type, symbol = values
    return (
        _identity_part(exchange, "exchange", lower=True),
        _identity_part(market_type, "market_type", lower=True),
        _identity_part(symbol, "symbol", upper=True),
    )


def _looks_like_identity(value: object) -> bool:
    return (
        isinstance(value, tuple)
        and len(value) == 3
        and all(isinstance(item, str) for item in value)
    )


def _is_contiguous_tail(records: Iterable[NormalizedAggTrade]) -> bool:
    """Return whether a non-empty attachment tail provides an exact ID anchor."""

    iterator = iter(records)
    try:
        previous = next(iterator).agg_trade_id
    except StopIteration:
        return False
    for trade in iterator:
        if trade.agg_trade_id != previous + 1:
            return False
        previous = trade.agg_trade_id
    return True


def _identity_part(
    value: object,
    label: str,
    *,
    lower: bool = False,
    upper: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"trade-flow {label} cannot be blank")
    normalized = value.strip()
    if lower:
        return normalized.lower()
    if upper:
        return normalized.upper()
    return normalized


def _consumer_id(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("trade-flow consumer_id cannot be blank")
    return value.strip()


def _descriptor(identity: StreamIdentity) -> StreamDescriptor:
    exchange, market_type, symbol = identity
    return StreamDescriptor(
        symbol=symbol,
        stream_type=StreamType.AGG_TRADE,
        exchange=exchange,
        market_type=market_type,
    )


def _rollup_row(bucket: TradeFlowBucket, *, source: str) -> dict[str, Any]:
    """Adapt the engine vocabulary to the database-agnostic store contract."""

    return {
        "exchange": bucket.exchange,
        "market_type": bucket.market_type,
        "symbol": bucket.symbol,
        "bucket_open_ms": bucket.bucket_start_ms,
        "bucket_close_ms": bucket.bucket_end_ms,
        "buy_base_volume": bucket.taker_buy_base,
        "sell_base_volume": bucket.taker_sell_base,
        "buy_quote_volume": bucket.taker_buy_quote,
        "sell_quote_volume": bucket.taker_sell_quote,
        "base_volume_delta": bucket.volume_delta_base,
        "quote_volume_delta": bucket.volume_delta_quote,
        "agg_trade_count": bucket.agg_trade_count,
        "trade_count": bucket.trade_count,
        "buy_trade_count": bucket.buy_trade_count,
        "sell_trade_count": bucket.sell_trade_count,
        "max_agg_trade_quote": bucket.max_trade_notional,
        "first_agg_trade_id": bucket.first_agg_trade_id,
        "last_agg_trade_id": bucket.last_agg_trade_id,
        "is_final": bucket.is_final,
        "is_complete": bucket.is_complete,
        "revision": bucket.revision,
        "source": str(source).strip().lower() or "live",
        "received_at_ms": bucket.updated_at_ms,
    }


def _merge_rollups(
    persisted: Iterable[dict[str, Any]],
    live: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_start: dict[int, dict[str, Any]] = {}
    for row in persisted:
        by_start[int(row["bucket_open_ms"])] = dict(row)
    for row in live:
        key = int(row["bucket_open_ms"])
        current = by_start.get(key)
        if current is not None and bool(current.get("is_final")) and not bool(
            row.get("is_final"),
        ):
            continue
        by_start[key] = dict(row)
    return [by_start[key] for key in sorted(by_start)]


def _public_rollup_row(row: dict[str, Any]) -> dict[str, Any]:
    """Expose engine vocabulary while retaining harmless storage aliases."""

    public = dict(row)
    public.update({
        "period": "1m",
        "bucket_start_ms": int(row["bucket_open_ms"]),
        "bucket_end_ms": int(row["bucket_close_ms"]),
        "taker_buy_base": float(row["buy_base_volume"]),
        "taker_sell_base": float(row["sell_base_volume"]),
        "taker_buy_quote": float(row["buy_quote_volume"]),
        "taker_sell_quote": float(row["sell_quote_volume"]),
        "volume_delta_base": float(row["base_volume_delta"]),
        "volume_delta_quote": float(row["quote_volume_delta"]),
        "max_trade_notional": float(row["max_agg_trade_quote"]),
        "is_final": bool(row.get("is_final", False)),
        "is_complete": bool(row.get("is_complete", False)),
    })
    return public


def _range_is_open(gaps: tuple[TradeFlowGap, ...], target: TradeFlowGap) -> bool:
    return any(
        gap.start_id <= target.end_id and gap.end_id >= target.start_id
        for gap in gaps
    )


def _open_gap_intersections(
    gaps: tuple[TradeFlowGap, ...],
    target: TradeFlowGap,
) -> list[tuple[int, int]]:
    return [
        (max(gap.start_id, target.start_id), min(gap.end_id, target.end_id))
        for gap in gaps
        if gap.start_id <= target.end_id and gap.end_id >= target.start_id
    ]


def _bounded_limit(value: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise ValueError("limit must be a positive integer")
    try:
        bounded = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("limit must be a positive integer") from exc
    if bounded <= 0:
        raise ValueError("limit must be a positive integer")
    return min(bounded, maximum)


def _optional_non_negative_int(value: int | None, label: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a non-negative integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a non-negative integer") from exc
    if parsed < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return parsed


__all__ = ["TradeFlowAttachment", "TradeFlowService"]
