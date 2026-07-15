"""Lifecycle, persistence, and fanout for sampled public liquidations.

The service owns one physical ``forceOrder`` feed per market identity.  It is
intentionally independent from the bar event bus and from P1 latest-state
channels: every observed liquidation is append-only even though Binance's
upstream stream is itself a lossy one-second snapshot.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.data_engine.ingestion.models import MarketEvent, StreamDescriptor, StreamType
from app.data_engine.storage.liquidation_store import (
    LiquidationRollupStore,
    SQLiteLiquidationRollupStore,
)
from app.data_engine.storage.liquidation_writer import LiquidationRollupWriter

from .append_hub import AppendBatchHub, AppendBatchSubscription
from .liquidation import (
    LiquidationEngine,
    LiquidationRollup,
    NormalizedLiquidation,
    StreamIdentity,
)
from .models import DeliveryClass, MarketChannel, MarketStreamKey, TransportMode


logger = logging.getLogger("data_engine.market_data.liquidation")


class _IngestionFactory(Protocol):
    async def start_market(
        self,
        descriptor: StreamDescriptor,
        callback: Any,
        *,
        on_gap: Any | None = None,
    ) -> Any: ...


@dataclass(frozen=True, slots=True)
class LiquidationAttachment:
    """One multiplexed live subscription and atomic recent snapshots."""

    subscription: AppendBatchSubscription[NormalizedLiquidation]
    recent: dict[StreamIdentity, tuple[NormalizedLiquidation, ...]]


@dataclass(slots=True)
class _PhysicalLease:
    handle: Any
    consumers: set[str] = field(default_factory=set)
    stop_task: asyncio.Task[Any] | None = None
    stop_state: str = "active"
    reconcile_stop_on_completion: bool = False


@dataclass(slots=True)
class _IngestCommand:
    identity: StreamIdentity
    event: MarketEvent | NormalizedLiquidation


class LiquidationService:
    """Coordinate bounded public-liquidation capture and local rollups."""

    def __init__(
        self,
        ingestion_factory: _IngestionFactory,
        *,
        engine: LiquidationEngine | None = None,
        hub: AppendBatchHub[NormalizedLiquidation] | None = None,
        rollup_store: LiquidationRollupStore | None = None,
        rollup_writer: LiquidationRollupWriter | None = None,
        command_queue_size: int = 8192,
        flush_interval_seconds: float = 0.1,
        finalize_interval_seconds: float = 1.0,
        max_query_limit: int = 5001,
        max_attach_recent: int = 2000,
        max_streams: int | None = None,
        physical_stop_timeout_seconds: float = 2.0,
    ) -> None:
        self._factory = ingestion_factory
        self.engine = engine or LiquidationEngine()
        self.hub = hub or AppendBatchHub[NormalizedLiquidation]()
        if rollup_writer is not None:
            if rollup_store is not None and rollup_writer.store is not rollup_store:
                raise ValueError("liquidation writer and store must use the same backend")
            self.rollup_writer = rollup_writer
            self.rollup_store = rollup_writer.store
        else:
            self.rollup_store = rollup_store or SQLiteLiquidationRollupStore()
            self.rollup_writer = LiquidationRollupWriter(self.rollup_store)

        self._command_queue: asyncio.Queue[_IngestCommand | None] = asyncio.Queue(
            maxsize=max(1, int(command_queue_size)),
        )
        self._flush_interval_seconds = max(
            0.02,
            min(float(flush_interval_seconds), 1.0),
        )
        self._finalize_interval_seconds = max(
            0.1,
            min(float(finalize_interval_seconds), 60.0),
        )
        self._max_query_limit = max(1, min(int(max_query_limit), 5001))
        self._max_attach_recent = max(1, min(int(max_attach_recent), 20_000))
        self._physical_stop_timeout_seconds = max(
            0.01,
            min(float(physical_stop_timeout_seconds), 30.0),
        )
        engine_max_streams = max(1, int(self.engine.diagnostics()["max_streams"]))
        requested_max_streams = (
            engine_max_streams if max_streams is None else max(1, int(max_streams))
        )
        self._max_streams = min(requested_max_streams, engine_max_streams)

        self._physical: dict[StreamIdentity, _PhysicalLease] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._ingest_task: asyncio.Task[None] | None = None
        self._flush_task: asyncio.Task[None] | None = None
        self._finalize_task: asyncio.Task[None] | None = None
        self._background_stop = asyncio.Event()
        self._shutdown_task: asyncio.Task[None] | None = None
        self._pending_stop_finalizers: set[asyncio.Task[None]] = set()
        self._accepting_events = True
        self._closing = False
        self._closed = False
        self._shutdown_degraded = False
        self._last_event_time_ms: dict[StreamIdentity, int] = {}
        self._metrics: dict[str, Any] = {
            "live_commands_enqueued": 0,
            "commands_processed": 0,
            "command_errors": 0,
            "command_queue_high_water": 0,
            "events_after_stop": 0,
            "identity_mismatches": 0,
            "rollup_offer_rejected": 0,
            "rollup_write_failures": 0,
            "hub_append_rejected": 0,
            "wall_clock_finalizations": 0,
            "physical_stops_attempted": 0,
            "physical_stops_succeeded": 0,
            "physical_stop_timeouts": 0,
            "physical_stop_failures": 0,
            "physical_stop_tasks_cancelled": 0,
            "physical_stop_wait_cancellations": 0,
            "physical_stop_tasks_reused": 0,
            "physical_stops_late_succeeded": 0,
            "last_physical_stop_error": None,
        }

    async def ensure_stream(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        consumer_id: str,
    ) -> bool:
        """Acquire one logical lease on a shared physical forceOrder feed."""

        identity = self._validate_identity(key)
        consumer = _consumer_id(consumer_id)
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
                if existing.stop_task is not None and not existing.stop_task.done():
                    raise RuntimeError(
                        "liquidation physical stream stop is still in progress",
                    )
                if consumer in existing.consumers:
                    return False
                existing.consumers.add(consumer)
                return True
            if len(self._physical) >= self._max_streams:
                raise RuntimeError(
                    f"liquidation physical stream limit reached ({self._max_streams})",
                )

            self._start_workers()
            descriptor = _descriptor(identity)

            async def _on_event(event: MarketEvent) -> None:
                await self._enqueue_live(identity, event)

            activated = self.engine.activate_stream(identity)
            try:
                persisted = await self.rollup_store.query_recent_rollups(
                    exchange=identity[0],
                    market_type=identity[1],
                    symbol=identity[2],
                    limit=8,
                )
                self.engine.seed_rollups(
                    identity,
                    (_stored_rollup(row) for row in persisted),
                )
                handle = await self._factory.start_market(descriptor, _on_event)
            except BaseException:
                if activated:
                    self.engine.deactivate_stream(identity)
                raise
            self._physical[identity] = _PhysicalLease(
                handle=handle,
                consumers={consumer},
            )
            return True

    async def release_stream(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        consumer_id: str,
    ) -> bool:
        identity = _normalize_identity(key)
        consumer = _consumer_id(consumer_id)
        async with self._lifecycle_lock:
            entry = self._physical.get(identity)
            if entry is None or consumer not in entry.consumers:
                return False
            if len(entry.consumers) > 1:
                entry.consumers.remove(consumer)
                return True
            if not await self._stop_physical(identity, entry):
                return False
            self._physical.pop(identity, None)
            self.engine.deactivate_stream(identity)
            return True

    def recent(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        limit: int = 500,
    ) -> list[NormalizedLiquidation]:
        self._ensure_readable()
        identity = self._validate_identity(key)
        bounded = _bounded_limit(limit, self._max_attach_recent)
        return list(self.engine.raw_snapshot(identity)[-bounded:])

    async def history(
        self,
        key: MarketStreamKey | StreamIdentity,
        *,
        start_ms: int | None = None,
        end_ms: int | None = None,
        position_side: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Return locally observed 1m rollups in ascending order."""

        self._ensure_readable()
        identity = self._validate_identity(key)
        start = _optional_non_negative_int(start_ms, "start_ms")
        end = _optional_non_negative_int(end_ms, "end_ms")
        if start is not None and end is not None and start > end:
            raise ValueError("start_ms cannot exceed end_ms")
        side = _optional_position_side(position_side)
        bounded = _bounded_limit(limit, self._max_query_limit)
        exchange, market_type, symbol = identity
        recent_tail = start is None and end is None
        if recent_tail:
            persisted = await self.rollup_store.query_recent_rollups(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                position_side=side,
                limit=bounded,
            )
        else:
            persisted = await self.rollup_store.query_rollups(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                start_ms=start,
                end_ms=end,
                position_side=side,
                limit=bounded,
            )
        live: list[dict[str, Any]] = []
        for rollup in self.engine.rollup_snapshot(identity):
            if start is not None and rollup.bucket_start_ms < start:
                continue
            if end is not None and rollup.bucket_start_ms > end:
                continue
            if side is not None and rollup.position_side != side:
                continue
            live.append(_rollup_row(rollup, source="live"))
        merged = _merge_rollups(persisted, live)
        selected = merged[-bounded:] if recent_tail else merged[:bounded]
        return [_public_rollup_row(row) for row in selected]

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
    ) -> LiquidationAttachment:
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
    ) -> LiquidationAttachment:
        self._ensure_readable()
        identities = tuple(dict.fromkeys(self._validate_identity(key) for key in keys))
        if not identities:
            raise ValueError("liquidation attachment requires at least one identity")
        bounded_recent = max(0, min(int(recent_limit), self._max_attach_recent))
        identity_set = frozenset(identities)
        self.hub.flush_all()
        subscription = self.hub.subscribe(
            max_pending_records=max_pending_records,
            predicate=lambda event: event.stream_identity in identity_set,
        )
        recent = {
            identity: (
                self.engine.raw_snapshot(identity)[-bounded_recent:]
                if bounded_recent
                else ()
            )
            for identity in identities
        }
        return LiquidationAttachment(subscription=subscription, recent=recent)

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
            "source_quality": "sampled_best_effort",
            "source_exhaustive": False,
            "sampling_mode": "latest_per_symbol_1000ms",
            "lossy_snapshot": True,
            "backfillable": False,
            "exchange_update_interval_ms": 1000,
            "idempotency_scope": "process_retained_ring",
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
                    "stop_state": entry.stop_state,
                    "last_event_time_ms": self._last_event_time_ms.get(identity),
                }
                for identity, entry in sorted(self._physical.items())
            ],
            "command_queue": {
                "pending": self._command_queue.qsize(),
                "limit": self._command_queue.maxsize,
            },
            "degraded": self._shutdown_degraded
            or bool(self.rollup_writer.diagnostics().get("degraded")),
            "shutdown": {
                "degraded": self._shutdown_degraded,
                "pending_stop_finalizers": len(self._pending_stop_finalizers),
                "physical_stop_timeout_seconds": self._physical_stop_timeout_seconds,
                "last_physical_stop_error": self._metrics["last_physical_stop_error"],
            },
            "engine": self.engine.diagnostics(),
            "hub": self.hub.diagnostics(),
            "rollup_writer": self.rollup_writer.diagnostics(),
            **self._metrics,
        }

    async def shutdown(self) -> None:
        """Stop feeds, drain commands, flush rollups, and close fanout."""

        async with self._lifecycle_lock:
            if self._closed:
                return
            if self._shutdown_task is None:
                self._closing = True
                self._shutdown_task = asyncio.create_task(
                    self._shutdown_impl(),
                    name="liquidation-shutdown",
                )
            task = self._shutdown_task
        await asyncio.shield(task)

    async def _shutdown_impl(self) -> None:
        self._accepting_events = False
        await self._drain_stop_finalizers()
        identities = tuple(self._physical)
        stop_items = tuple(self._physical.items())
        if stop_items:
            await asyncio.gather(*(
                self._stop_physical(identity, entry)
                for identity, entry in stop_items
            ))
        await asyncio.sleep(0)
        await self._drain_stop_finalizers()
        self._physical.clear()
        for identity in identities:
            self.engine.deactivate_stream(identity)

        if self._ingest_task is not None:
            await self._command_queue.join()
            finalized = self.engine.finalize_due(int(time.time() * 1000))
            if finalized:
                self._metrics["wall_clock_finalizations"] += len(finalized)
                await self._persist_rollups(finalized)
            await self._command_queue.put(None)
            await asyncio.shield(self._ingest_task)
            self._background_stop.set()
            await asyncio.shield(self._flush_task)
            await asyncio.shield(self._finalize_task)

        self.hub.flush_all()
        await self.hub.close(flush=False)
        try:
            await self.rollup_writer.close()
        finally:
            await self.rollup_store.close()
        self._closed = True

    async def _stop_physical(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> bool:
        self._metrics["physical_stops_attempted"] += 1
        stop_task = entry.stop_task
        if stop_task is not None and stop_task.done():
            entry.reconcile_stop_on_completion = False
            completed = False
            if not stop_task.cancelled():
                try:
                    completed = stop_task.result() is not False
                except (asyncio.CancelledError, Exception):
                    completed = False
            self._clear_stop_task(
                entry,
                stop_task,
                state="stopped" if completed else "stop_failed",
            )
            if completed:
                self._metrics["physical_stops_late_succeeded"] += 1
                return True
            stop_task = None
        if stop_task is None:
            stop_task = asyncio.create_task(
                entry.handle.stop(),
                name=f"liquidation-stop-{identity[0]}-{identity[1]}-{identity[2]}",
            )
            entry.stop_task = stop_task
            entry.reconcile_stop_on_completion = False
        else:
            self._metrics["physical_stop_tasks_reused"] += 1
        entry.stop_state = "stopping"
        try:
            result = await asyncio.wait_for(
                asyncio.shield(stop_task),
                timeout=self._physical_stop_timeout_seconds,
            )
            if result is False:
                raise RuntimeError("physical stream reported stop failure")
        except TimeoutError:
            self._metrics["physical_stop_timeouts"] += 1
            if stop_task.cancel():
                self._metrics["physical_stop_tasks_cancelled"] += 1
            self._arm_late_stop_reconciliation(identity, entry, stop_task)
            self._record_physical_stop_failure(
                identity,
                f"timed out after {self._physical_stop_timeout_seconds:.3f}s",
            )
            return False
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                self._metrics["physical_stop_wait_cancellations"] += 1
                if stop_task.cancel():
                    self._metrics["physical_stop_tasks_cancelled"] += 1
                self._arm_late_stop_reconciliation(identity, entry, stop_task)
                self._record_physical_stop_failure(
                    identity,
                    "caller cancelled while stop was in progress",
                )
                raise
            self._clear_stop_task(entry, stop_task, state="stop_cancelled")
            self._metrics["physical_stop_failures"] += 1
            self._record_physical_stop_failure(identity, "stop task was cancelled")
            return False
        except Exception as exc:
            self._clear_stop_task(entry, stop_task, state="stop_failed")
            self._metrics["physical_stop_failures"] += 1
            self._record_physical_stop_failure(identity, str(exc))
            return False
        self._clear_stop_task(entry, stop_task, state="stopped")
        self._metrics["physical_stops_succeeded"] += 1
        return True

    def _reconcile_completed_stop_locked(
        self,
        identity: StreamIdentity,
        entry: _PhysicalLease,
    ) -> bool:
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
                f"liquidation-stop-finalize-{identity[0]}-"
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
            if self._physical.get(identity) is entry:
                self._physical.pop(identity, None)
                self.engine.deactivate_stream(identity)
            self._metrics["physical_stops_late_succeeded"] += 1

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
        logger.warning("Liquidation physical stop degraded: %s", message)

    async def _drain_stop_finalizers(self) -> None:
        while self._pending_stop_finalizers:
            pending = tuple(self._pending_stop_finalizers)
            await asyncio.gather(*pending)
            self._pending_stop_finalizers.difference_update(pending)

    def _start_workers(self) -> None:
        if self._ingest_task is not None and not self._ingest_task.done():
            return
        self.rollup_writer.start()
        self._ingest_task = asyncio.create_task(
            self._run_ingest(),
            name="liquidation-ingest",
        )
        self._flush_task = asyncio.create_task(
            self._run_flush(),
            name="liquidation-batch-flush",
        )
        self._finalize_task = asyncio.create_task(
            self._run_finalize(),
            name="liquidation-wall-clock-finalize",
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
                event = (
                    command.event
                    if isinstance(command.event, NormalizedLiquidation)
                    else NormalizedLiquidation.from_market_event(command.event)
                )
                if event.stream_identity != command.identity:
                    self._metrics["identity_mismatches"] += 1
                    raise ValueError(
                        "liquidation identity does not match physical stream",
                    )
                result = self.engine.ingest(event)
                if result.accepted:
                    if not self.hub.append(result.event):
                        self._metrics["hub_append_rejected"] += 1
                    await self._persist_rollups(result.rollups)
                    self._last_event_time_ms[command.identity] = event.trade_time_ms
                self._metrics["commands_processed"] += 1
            except Exception as exc:
                self._metrics["command_errors"] += 1
                logger.warning("Rejected liquidation command: %s", exc)
            finally:
                self._command_queue.task_done()

    async def _persist_rollups(
        self,
        rollups: Iterable[LiquidationRollup],
    ) -> None:
        final_rows: list[dict[str, Any]] = []
        for rollup in rollups:
            row = _rollup_row(rollup, source="websocket")
            if rollup.is_final:
                final_rows.append(row)
            elif not self.rollup_writer.offer(row):
                self._metrics["rollup_offer_rejected"] += 1
        if not final_rows:
            return
        try:
            acknowledgement = await self.rollup_writer.enqueue(final_rows)
        except Exception:
            self._metrics["rollup_write_failures"] += 1
            logger.exception("Failed to enqueue final liquidation rollup")
        else:
            if acknowledgement is not None:
                acknowledgement.add_done_callback(self._on_rollup_write_done)

    def _on_rollup_write_done(self, acknowledgement: asyncio.Future[int]) -> None:
        if acknowledgement.cancelled():
            self._metrics["rollup_write_failures"] += 1
            logger.error("Final liquidation rollup write was cancelled")
            return
        try:
            acknowledgement.result()
        except Exception:
            self._metrics["rollup_write_failures"] += 1
            logger.exception("Failed to persist final liquidation rollup")

    async def _run_flush(self) -> None:
        while not self._background_stop.is_set():
            try:
                await asyncio.wait_for(
                    self._background_stop.wait(),
                    timeout=self._flush_interval_seconds,
                )
            except asyncio.TimeoutError:
                pass
            self.hub.flush_all()
        self.hub.flush_all()

    async def _run_finalize(self) -> None:
        while not self._background_stop.is_set():
            try:
                await asyncio.wait_for(
                    self._background_stop.wait(),
                    timeout=self._finalize_interval_seconds,
                )
            except asyncio.TimeoutError:
                pass
            if self._background_stop.is_set():
                break
            finalized = self.engine.finalize_due(int(time.time() * 1000))
            if finalized:
                self._metrics["wall_clock_finalizations"] += len(finalized)
                await self._persist_rollups(finalized)

    def _validate_identity(
        self,
        key: MarketStreamKey | StreamIdentity,
    ) -> StreamIdentity:
        from app.exchanges import bootstrap_default_adapters, get_exchange_registry

        identity = _normalize_identity(key)
        bootstrap_default_adapters()
        try:
            capabilities = get_exchange_registry().get_plugin(identity[0]).capabilities()
        except KeyError as exc:
            raise ValueError(str(exc)) from exc
        if getattr(capabilities, "capability_schema_version", 1) != 2:
            raise ValueError(
                "liquidation capture requires an authoritative capability schema v2",
            )
        capability = capabilities.channel_capability(
            MarketChannel.LIQUIDATION,
            identity[1],
        )
        supported = (
            capability is not None
            and capability.realtime
            and not capability.history
            and capability.delivery is DeliveryClass.APPEND
            and capability.sequence == "none"
            and capability.resync == "none"
            and capability.supports_transport(TransportMode.WEBSOCKET)
        )
        if not supported:
            raise ValueError(
                f"{identity[0]}:{identity[1]}:liquidation does not support "
                "sampled append-only WebSocket capture",
            )
        return identity

    def _ensure_open(self) -> None:
        if self._closing or self._closed:
            raise RuntimeError("liquidation service is closed")

    def _ensure_readable(self) -> None:
        if self._closed:
            raise RuntimeError("liquidation service is closed")


def _normalize_identity(key: MarketStreamKey | StreamIdentity) -> StreamIdentity:
    if isinstance(key, MarketStreamKey):
        if key.channel is not MarketChannel.LIQUIDATION:
            raise ValueError("liquidation service only accepts liquidation keys")
        if key.params:
            raise ValueError("liquidation keys do not accept params")
        values: tuple[object, object, object] = (
            key.exchange,
            key.market_type,
            key.symbol,
        )
    elif _looks_like_identity(key):
        values = key  # type: ignore[assignment]
    else:
        raise TypeError("liquidation identity must be a key or three-string tuple")
    exchange, market_type, symbol = values
    normalized = (
        _identity_part(exchange, "exchange", lower=True),
        _identity_part(market_type, "market_type", lower=True),
        _identity_part(symbol, "symbol", upper=True),
    )
    if normalized[1] != "futures":
        raise ValueError("liquidation streams require market_type='futures'")
    return normalized


def _looks_like_identity(value: object) -> bool:
    return (
        isinstance(value, tuple)
        and len(value) == 3
        and all(isinstance(item, str) for item in value)
    )


def _identity_part(
    value: object,
    label: str,
    *,
    lower: bool = False,
    upper: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"liquidation {label} cannot be blank")
    normalized = value.strip()
    if lower:
        return normalized.lower()
    if upper:
        return normalized.upper()
    return normalized


def _consumer_id(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("liquidation consumer_id cannot be blank")
    return value.strip()


def _descriptor(identity: StreamIdentity) -> StreamDescriptor:
    exchange, market_type, symbol = identity
    return StreamDescriptor(
        symbol=symbol,
        stream_type=StreamType.LIQUIDATION,
        exchange=exchange,
        market_type=market_type,
    )


def _rollup_row(rollup: LiquidationRollup, *, source: str) -> dict[str, Any]:
    return {
        "exchange": rollup.exchange,
        "market_type": rollup.market_type,
        "symbol": rollup.symbol,
        "bucket_open_ms": rollup.bucket_start_ms,
        "bucket_close_ms": rollup.bucket_end_ms,
        "position_side": rollup.position_side,
        "filled_quantity": rollup.filled_quantity,
        "filled_notional": rollup.filled_notional,
        "event_count": rollup.event_count,
        "max_event_notional": rollup.max_event_notional,
        "first_event_time_ms": rollup.first_event_time_ms,
        "last_event_time_ms": rollup.last_event_time_ms,
        "is_final": rollup.is_final,
        "revision": rollup.revision,
        "source": str(source).strip().lower() or "websocket",
        "received_at_ms": rollup.updated_at_ms,
    }


def _stored_rollup(row: dict[str, Any]) -> LiquidationRollup:
    """Adapt one validated store row back into the reducer baseline model."""

    return LiquidationRollup(
        exchange=str(row["exchange"]),
        market_type=str(row["market_type"]),
        symbol=str(row["symbol"]),
        position_side=str(row["position_side"]),  # type: ignore[arg-type]
        bucket_start_ms=int(row["bucket_open_ms"]),
        bucket_end_ms=int(row["bucket_close_ms"]),
        filled_quantity=float(row["filled_quantity"]),
        filled_notional=float(row["filled_notional"]),
        event_count=int(row["event_count"]),
        max_event_notional=float(row["max_event_notional"]),
        first_event_time_ms=int(row["first_event_time_ms"]),
        last_event_time_ms=int(row["last_event_time_ms"]),
        is_final=bool(row["is_final"]),
        revision=int(row["revision"]),
        updated_at_ms=int(row["received_at_ms"]),
    )


def _merge_rollups(
    persisted: Iterable[dict[str, Any]],
    live: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_key: dict[tuple[int, str], dict[str, Any]] = {}
    for row in persisted:
        key = (int(row["bucket_open_ms"]), str(row["position_side"]))
        by_key[key] = dict(row)
    for row in live:
        key = (int(row["bucket_open_ms"]), str(row["position_side"]))
        current = by_key.get(key)
        if current is not None and bool(current.get("is_final")) and not bool(
            row.get("is_final"),
        ):
            continue
        by_key[key] = dict(row)
    return [by_key[key] for key in sorted(by_key)]


def _public_rollup_row(row: dict[str, Any]) -> dict[str, Any]:
    public = dict(row)
    public.update({
        "period": "1m",
        "bucket_start_ms": int(row["bucket_open_ms"]),
        "bucket_end_ms": int(row["bucket_close_ms"]),
        "position_side": str(row["position_side"]),
        "filled_quantity": float(row["filled_quantity"]),
        "filled_notional": float(row["filled_notional"]),
        "event_count": int(row["event_count"]),
        "max_event_notional": float(row["max_event_notional"]),
        "is_final": bool(row.get("is_final", False)),
        "source_quality": "sampled_best_effort",
        "source_exhaustive": False,
    })
    return public


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


def _optional_position_side(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if not normalized:
        return None
    if normalized not in {"long", "short"}:
        raise ValueError("position_side must be 'long' or 'short'")
    return normalized


__all__ = ["LiquidationAttachment", "LiquidationService"]
