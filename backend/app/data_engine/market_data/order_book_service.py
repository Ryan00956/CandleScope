"""Lifecycle and latest-wins fanout for partial Top-N order-book snapshots.

This service deliberately models a partial order book as replaceable state.  It
does not persist raw depth, expose history, or claim full-depth sequence
reconstruction.  Each immutable key (including mode, levels, and exchange
update interval) owns at most one physical feed shared by logical consumers.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.data_engine.ingestion.models import MarketEvent, StreamDescriptor, StreamType

from .events import HubRecord, MarketStateEvent
from .hub import MarketEventHub, MarketHubSubscription
from .models import MarketChannel, MarketStreamKey
from .order_book import OrderBookEngine, OrderBookIdentity


logger = logging.getLogger("data_engine.market_data.order_book")

_REQUIRED_PARAMS = frozenset({"mode", "depth_levels", "update_interval_ms"})
_BINANCE_PARTIAL_LEVELS = frozenset({5, 10, 20})
_BINANCE_UPDATE_INTERVALS_MS = {
    "spot": frozenset({100, 1000}),
    "futures": frozenset({100, 250, 500}),
}


class _IngestionFactory(Protocol):
    async def start_market(
        self,
        descriptor: StreamDescriptor,
        callback: Any,
        *,
        on_gap: Any | None = None,
    ) -> Any: ...


@dataclass(frozen=True, slots=True)
class OrderBookAttachment:
    """A live subscription plus current snapshots captured at attachment.

    Subscription is installed before the synchronous current-state read, so
    there is no unbounded handoff gap.  A caller should still deduplicate by
    ``revision`` because the same latest revision may appear in both views if
    publishing is driven from outside the owning event loop.
    """

    subscription: MarketHubSubscription
    current: dict[MarketStreamKey, HubRecord]


@dataclass(slots=True)
class _PhysicalLease:
    handle: Any
    generation: object
    consumers: set[str] = field(default_factory=set)
    stop_task: asyncio.Task[Any] | None = None
    stop_state: str = "active"
    reconcile_stop_on_completion: bool = False


@dataclass(frozen=True, slots=True)
class _PendingEvent:
    event: MarketEvent
    generation: object


class OrderBookService:
    """Own shared partial-depth feeds and publish bounded latest snapshots."""

    def __init__(
        self,
        ingestion_factory: _IngestionFactory,
        *,
        engine: OrderBookEngine | None = None,
        hub: MarketEventHub | None = None,
        max_streams: int = 64,
        event_queue_size: int = 256,
        default_max_pending: int = 32,
        max_snapshot_age_ms: int = 5_000,
        physical_stop_timeout_seconds: float = 5.0,
    ) -> None:
        self._factory = ingestion_factory
        self._max_streams = max(1, int(max_streams))
        self.engine = engine or OrderBookEngine(max_streams=self._max_streams)
        self.hub = hub or MarketEventHub(
            max_states=self._max_streams,
            default_max_pending=default_max_pending,
        )
        self._max_snapshot_age_ms = max(1, int(max_snapshot_age_ms))
        self._physical_stop_timeout_seconds = max(
            0.01,
            min(float(physical_stop_timeout_seconds), 30.0),
        )
        self._event_queue: asyncio.Queue[MarketStreamKey | None] = asyncio.Queue(
            maxsize=max(1, int(event_queue_size)),
        )
        self._pending_events: dict[MarketStreamKey, _PendingEvent] = {}
        self._physical: dict[MarketStreamKey, _PhysicalLease] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._worker: asyncio.Task[None] | None = None
        self._shutdown_task: asyncio.Task[None] | None = None
        self._pending_stop_finalizers: set[asyncio.Task[None]] = set()
        self._last_event_time_ms: dict[MarketStreamKey, int] = {}
        self._last_published_at_ms: dict[MarketStreamKey, int] = {}
        self._activation_started_at_ms: dict[MarketStreamKey, int] = {}
        self._stream_generations: dict[MarketStreamKey, object] = {}
        self._accepting_events = True
        self._closing = False
        self._closed = False
        self._shutdown_degraded = False
        self._metrics: dict[str, Any] = {
            "events_offered": 0,
            "events_coalesced": 0,
            "events_queue_rejected": 0,
            "events_after_stop": 0,
            "events_inactive_generation": 0,
            "events_processed": 0,
            "events_invalid": 0,
            "events_duplicate": 0,
            "events_stale": 0,
            "identity_mismatches": 0,
            "hub_publish_rejected": 0,
            "event_queue_high_water": 0,
            "snapshot_stale_reads": 0,
            "snapshot_wait_timeouts": 0,
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
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        """Acquire an idempotent logical lease on one immutable depth feed."""

        validated = self._validate_key(key)
        consumer = _consumer_id(consumer_id)
        async with self._lifecycle_lock:
            self._ensure_open()
            existing = self._physical.get(validated)
            if existing is not None:
                if (
                    existing.stop_task is not None
                    and existing.stop_task.done()
                    and self._reconcile_completed_stop_locked(validated, existing)
                ):
                    existing = None
            if existing is not None:
                if existing.stop_task is not None and not existing.stop_task.done():
                    raise RuntimeError("order-book physical stream stop is still in progress")
                if existing.stop_state != "active":
                    if not await self._stop_physical(validated, existing):
                        raise RuntimeError(
                            "order-book physical stream is unavailable after a failed stop",
                        )
                    self._physical.pop(validated, None)
                    self._activation_started_at_ms.pop(validated, None)
                    self._last_event_time_ms.pop(validated, None)
                    self._last_published_at_ms.pop(validated, None)
                    if self._stream_generations.get(validated) is existing.generation:
                        self._stream_generations.pop(validated, None)
                    self.engine.deactivate_stream(_identity(validated))
                    existing = None
                else:
                    if consumer in existing.consumers:
                        return False
                    existing.consumers.add(consumer)
                    return True
            if len(self._physical) >= self._max_streams:
                raise RuntimeError(
                    f"order-book physical stream limit reached ({self._max_streams})",
                )

            identity = _identity(validated)
            activated = self.engine.activate_stream(identity)
            if not activated:
                raise RuntimeError(
                    "order-book engine identity is active without a physical lease",
                )
            self._start_worker()
            self._activation_started_at_ms[validated] = int(time.time() * 1000)
            generation = object()
            self._stream_generations[validated] = generation

            async def _on_event(event: MarketEvent) -> None:
                # Deliberately no await: browser delivery and engine processing
                # can never backpressure the ingestion callback.
                self._offer_event(validated, event, generation=generation)

            try:
                handle = await self._factory.start_market(
                    _descriptor(validated),
                    _on_event,
                )
            except BaseException:
                self._activation_started_at_ms.pop(validated, None)
                self._last_event_time_ms.pop(validated, None)
                self._last_published_at_ms.pop(validated, None)
                if self._stream_generations.get(validated) is generation:
                    self._stream_generations.pop(validated, None)
                if activated:
                    self.engine.deactivate_stream(identity)
                raise
            self._physical[validated] = _PhysicalLease(
                handle=handle,
                generation=generation,
                consumers={consumer},
            )
            return True

    async def release_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        validated = self._validate_key(key)
        consumer = _consumer_id(consumer_id)
        async with self._lifecycle_lock:
            entry = self._physical.get(validated)
            if entry is None or consumer not in entry.consumers:
                return False
            if len(entry.consumers) > 1:
                entry.consumers.remove(consumer)
                return True
            if not await self._stop_physical(validated, entry):
                return False
            self._physical.pop(validated, None)
            self._activation_started_at_ms.pop(validated, None)
            self._last_event_time_ms.pop(validated, None)
            self._last_published_at_ms.pop(validated, None)
            if self._stream_generations.get(validated) is entry.generation:
                self._stream_generations.pop(validated, None)
            self.engine.deactivate_stream(_identity(validated))
            return True

    def current(
        self,
        key: MarketStreamKey,
        *,
        max_age_ms: int | None = None,
    ) -> HubRecord | None:
        """Return a fresh process-local snapshot; stale cached state fails closed."""

        self._ensure_readable()
        validated = self._validate_key(key)
        physical = self._physical.get(validated)
        if physical is None or physical.stop_state != "active":
            return None
        records = self.hub.snapshot([validated])
        if not records:
            return None
        record = records[0]
        if not self._is_fresh(record, max_age_ms=max_age_ms):
            self._metrics["snapshot_stale_reads"] += 1
            return None
        return record

    async def wait_for_snapshot(
        self,
        key: MarketStreamKey,
        *,
        timeout_seconds: float = 2.0,
        max_age_ms: int | None = None,
    ) -> HubRecord:
        """Wait for a fresh snapshot with an atomic subscribe/current handoff."""

        self._ensure_readable()
        validated = self._validate_key(key)
        timeout = float(timeout_seconds)
        if timeout <= 0:
            raise ValueError("timeout_seconds must be positive")
        subscription = self.hub.subscribe([validated], replay=False)
        try:
            current = self.current(validated, max_age_ms=max_age_ms)
            if current is not None:
                return current

            deadline = asyncio.get_running_loop().time() + timeout
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    self._metrics["snapshot_wait_timeouts"] += 1
                    raise asyncio.TimeoutError("order-book snapshot wait timed out")
                try:
                    record = await asyncio.wait_for(
                        subscription.receive(),
                        timeout=remaining,
                    )
                except TimeoutError:
                    self._metrics["snapshot_wait_timeouts"] += 1
                    raise
                if record is None:
                    raise RuntimeError("order-book snapshot subscription closed")
                if self._is_fresh(record, max_age_ms=max_age_ms):
                    return record
                self._metrics["snapshot_stale_reads"] += 1
        finally:
            await subscription.close()

    async def transient_snapshot(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
        timeout_seconds: float = 2.0,
        max_age_ms: int | None = None,
    ) -> HubRecord:
        """Lease, wait for, and release an initial HTTP-style snapshot safely."""

        acquired = await self.ensure_stream(key, consumer_id=consumer_id)
        try:
            return await self.wait_for_snapshot(
                key,
                timeout_seconds=timeout_seconds,
                max_age_ms=max_age_ms,
            )
        finally:
            if acquired:
                await self.release_stream(key, consumer_id=consumer_id)

    def attach(
        self,
        keys: MarketStreamKey | Iterable[MarketStreamKey],
        *,
        max_pending: int | None = None,
        max_age_ms: int | None = None,
    ) -> OrderBookAttachment:
        """Atomically subscribe before reading replaceable current state."""

        self._ensure_readable()
        if isinstance(keys, MarketStreamKey):
            requested = (self._validate_key(keys),)
        else:
            requested = tuple(dict.fromkeys(self._validate_key(key) for key in keys))
        if not requested:
            raise ValueError("order-book attachment requires at least one key")
        subscription = self.hub.subscribe(
            requested,
            max_pending=max_pending,
            replay=False,
        )
        current = {
            key: record
            for key in requested
            if (record := self.current(key, max_age_ms=max_age_ms)) is not None
        }
        return OrderBookAttachment(subscription=subscription, current=current)

    def diagnostics(self) -> dict[str, Any]:
        if self._closed:
            state = "closed"
        elif self._closing:
            state = "closing"
        elif self._worker is not None:
            state = "running"
        else:
            state = "idle"
        now_ms = int(time.time() * 1000)
        return {
            "state": state,
            "mode": "partial_top_n",
            "delivery": "latest_wins",
            "persistence": False,
            "rest_history": False,
            "full_depth_reconstruction": False,
            "physical_streams": len(self._physical),
            "logical_leases": sum(len(entry.consumers) for entry in self._physical.values()),
            "max_streams": self._max_streams,
            "max_snapshot_age_ms": self._max_snapshot_age_ms,
            "physical": [
                {
                    "key": key.to_dict(),
                    "topic": key.topic,
                    "consumers": len(entry.consumers),
                    "stop_state": entry.stop_state,
                    "last_event_time_ms": self._last_event_time_ms.get(key),
                    "last_published_at_ms": self._last_published_at_ms.get(key),
                    "snapshot_age_ms": (
                        max(0, now_ms - self._last_published_at_ms[key])
                        if key in self._last_published_at_ms
                        else None
                    ),
                }
                for key, entry in sorted(self._physical.items(), key=lambda item: item[0].topic)
            ],
            "event_queue": {
                "pending_keys": self._event_queue.qsize(),
                "latest_slots": len(self._pending_events),
                "limit": self._event_queue.maxsize,
            },
            "degraded": self._shutdown_degraded or any(
                entry.stop_state != "active" for entry in self._physical.values()
            ),
            "shutdown": {
                "degraded": self._shutdown_degraded,
                "pending_stop_finalizers": len(self._pending_stop_finalizers),
                "physical_stop_timeout_seconds": self._physical_stop_timeout_seconds,
                "last_physical_stop_error": self._metrics["last_physical_stop_error"],
            },
            "engine": self.engine.diagnostics(),
            "hub": self.hub.diagnostics(),
            **self._metrics,
        }

    async def shutdown(self) -> None:
        """Stop feeds, drain the coalescing mailbox, and close all subscribers."""

        async with self._lifecycle_lock:
            if self._closed:
                return
            if self._shutdown_task is None:
                self._closing = True
                self._shutdown_task = asyncio.create_task(
                    self._shutdown_impl(),
                    name="order-book-shutdown",
                )
            task = self._shutdown_task
        await asyncio.shield(task)

    async def _shutdown_impl(self) -> None:
        self._accepting_events = False
        stop_items = tuple(self._physical.items())
        if stop_items:
            await asyncio.gather(*(
                self._stop_physical(key, entry)
                for key, entry in stop_items
            ))
        await asyncio.sleep(0)
        for key in tuple(self._physical):
            self.engine.deactivate_stream(_identity(key))
        self._physical.clear()
        self._activation_started_at_ms.clear()
        self._stream_generations.clear()
        self._last_event_time_ms.clear()
        self._last_published_at_ms.clear()

        if self._worker is not None:
            await self._event_queue.join()
            await self._event_queue.put(None)
            await asyncio.shield(self._worker)
        await self.hub.close()
        self._closed = True

    def _start_worker(self) -> None:
        if self._worker is None:
            self._worker = asyncio.create_task(
                self._run_worker(),
                name="order-book-latest-worker",
            )

    def _offer_event(
        self,
        key: MarketStreamKey,
        event: MarketEvent,
        *,
        generation: object,
    ) -> None:
        if not self._accepting_events:
            self._metrics["events_after_stop"] += 1
            return
        if self._stream_generations.get(key) is not generation:
            self._metrics["events_inactive_generation"] += 1
            return
        if not self._event_matches_key(key, event):
            self._metrics["identity_mismatches"] += 1
            return
        self._metrics["events_offered"] += 1
        if key in self._pending_events:
            self._pending_events[key] = _PendingEvent(event, generation)
            self._metrics["events_coalesced"] += 1
            return
        try:
            self._event_queue.put_nowait(key)
        except asyncio.QueueFull:
            self._metrics["events_queue_rejected"] += 1
            return
        self._pending_events[key] = _PendingEvent(event, generation)
        self._metrics["event_queue_high_water"] = max(
            self._metrics["event_queue_high_water"],
            self._event_queue.qsize(),
        )

    async def _run_worker(self) -> None:
        while True:
            key = await self._event_queue.get()
            try:
                if key is None:
                    return
                pending = self._pending_events.pop(key, None)
                if pending is None:
                    continue
                if self._stream_generations.get(key) is not pending.generation:
                    self._metrics["events_inactive_generation"] += 1
                    continue
                self._process_event(key, pending.event)
            finally:
                self._event_queue.task_done()

    def _process_event(self, key: MarketStreamKey, event: MarketEvent) -> None:
        params = dict(key.params)
        self._metrics["events_processed"] += 1
        try:
            result = self.engine.process(
                event,
                depth_levels=int(params["depth_levels"]),
                update_interval_ms=int(params["update_interval_ms"]),
            )
        except (TypeError, ValueError):
            self._metrics["events_invalid"] += 1
            logger.warning("Rejected invalid partial order-book snapshot for %s", key.topic)
            return
        except Exception:
            self._metrics["events_invalid"] += 1
            logger.exception("Partial order-book engine failed for %s", key.topic)
            return

        if not result.accepted or result.snapshot is None:
            reason = str(result.reason).strip().lower()
            metric = {
                "duplicate_update_id": "events_duplicate",
                "stale_update_id": "events_stale",
            }.get(reason, "events_invalid")
            self._metrics[metric] += 1
            return

        snapshot = result.snapshot
        payload = snapshot.to_dict()
        state = MarketStateEvent(
            key=key,
            event_time_ms=snapshot.event_time_ms,
            received_at_ms=snapshot.received_at_ms,
            source=event.source,
            data=payload,
            sequence=snapshot.last_update_id,
        )
        record = self.hub.publish(state)
        if record is None:
            self._metrics["hub_publish_rejected"] += 1
            return
        self._last_event_time_ms[key] = snapshot.event_time_ms
        self._last_published_at_ms[key] = snapshot.received_at_ms

    async def _stop_physical(
        self,
        key: MarketStreamKey,
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
            self._clear_stop_task(entry, stop_task, state="stopped" if completed else "stop_failed")
            if completed:
                self._metrics["physical_stops_late_succeeded"] += 1
                return True
            stop_task = None
        if stop_task is None:
            stop_task = asyncio.create_task(
                entry.handle.stop(),
                name=f"order-book-stop-{key.exchange}-{key.market_type}-{key.symbol}",
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
            self._shutdown_degraded = self._shutdown_degraded or self._closing
            if stop_task.cancel():
                self._metrics["physical_stop_tasks_cancelled"] += 1
            self._arm_late_stop_reconciliation(key, entry, stop_task)
            self._record_stop_failure(
                key,
                f"timed out after {self._physical_stop_timeout_seconds:.3f}s",
            )
            return False
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                self._metrics["physical_stop_wait_cancellations"] += 1
                if stop_task.cancel():
                    self._metrics["physical_stop_tasks_cancelled"] += 1
                self._arm_late_stop_reconciliation(key, entry, stop_task)
                self._record_stop_failure(key, "caller cancelled while stop was in progress")
                raise
            self._clear_stop_task(entry, stop_task, state="stop_cancelled")
            self._metrics["physical_stop_failures"] += 1
            self._record_stop_failure(key, "stop task was cancelled")
            return False
        except Exception as exc:
            self._clear_stop_task(entry, stop_task, state="stop_failed")
            self._metrics["physical_stop_failures"] += 1
            self._record_stop_failure(key, str(exc))
            return False
        self._clear_stop_task(entry, stop_task, state="stopped")
        self._metrics["physical_stops_succeeded"] += 1
        return True

    def _reconcile_completed_stop_locked(
        self,
        key: MarketStreamKey,
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
            self._record_stop_failure(key, f"late failure: {exc}")
            return False
        if result is False:
            self._clear_stop_task(entry, stop_task, state="stop_failed")
            self._metrics["physical_stop_failures"] += 1
            self._record_stop_failure(key, "late physical stream reported stop failure")
            return False
        self._clear_stop_task(entry, stop_task, state="stopped")
        if self._physical.get(key) is entry:
            self._physical.pop(key, None)
            self._activation_started_at_ms.pop(key, None)
            self._last_event_time_ms.pop(key, None)
            self._last_published_at_ms.pop(key, None)
            if self._stream_generations.get(key) is entry.generation:
                self._stream_generations.pop(key, None)
            self.engine.deactivate_stream(_identity(key))
        self._metrics["physical_stops_late_succeeded"] += 1
        return True

    def _arm_late_stop_reconciliation(
        self,
        key: MarketStreamKey,
        entry: _PhysicalLease,
        stop_task: asyncio.Task[Any],
    ) -> None:
        if entry.reconcile_stop_on_completion:
            return
        entry.reconcile_stop_on_completion = True
        stop_task.add_done_callback(
            lambda completed: self._schedule_late_stop_reconciliation(
                key,
                entry,
                completed,
            ),
        )

    def _schedule_late_stop_reconciliation(
        self,
        key: MarketStreamKey,
        entry: _PhysicalLease,
        stop_task: asyncio.Task[Any],
    ) -> None:
        finalizer = asyncio.create_task(
            self._reconcile_late_physical_stop(key, entry, stop_task),
            name=f"order-book-stop-finalize-{key.exchange}-{key.market_type}-{key.symbol}",
        )
        self._pending_stop_finalizers.add(finalizer)
        finalizer.add_done_callback(self._pending_stop_finalizers.discard)
        finalizer.add_done_callback(self._consume_task_exception)

    async def _reconcile_late_physical_stop(
        self,
        key: MarketStreamKey,
        entry: _PhysicalLease,
        stop_task: asyncio.Task[Any],
    ) -> None:
        async with self._lifecycle_lock:
            if not entry.reconcile_stop_on_completion or entry.stop_task is not stop_task:
                self._consume_task_exception(stop_task)
                return
            self._reconcile_completed_stop_locked(key, entry)

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

    def _record_stop_failure(self, key: MarketStreamKey, detail: str) -> None:
        self._metrics["last_physical_stop_error"] = f"{key.topic}: {detail}"
        logger.warning("Order-book physical stop failed for %s: %s", key.topic, detail)

    @staticmethod
    def _consume_task_exception(task: asyncio.Task[Any]) -> None:
        if task.cancelled():
            return
        try:
            task.exception()
        except (asyncio.CancelledError, Exception):
            return

    def _is_fresh(self, record: HubRecord, *, max_age_ms: int | None) -> bool:
        age_limit = (
            self._max_snapshot_age_ms
            if max_age_ms is None
            else max(1, int(max_age_ms))
        )
        activation_started_at_ms = self._activation_started_at_ms.get(
            record.event.key,
            0,
        )
        return (
            record.event.received_at_ms >= activation_started_at_ms
            and int(time.time() * 1000) - record.event.received_at_ms <= age_limit
        )

    def _event_matches_key(self, key: MarketStreamKey, event: MarketEvent) -> bool:
        if event.event_type is not StreamType.DEPTH:
            return False
        if (
            event.exchange.strip().lower(),
            event.market_type.strip().lower(),
            event.symbol.strip().upper(),
        ) != (key.exchange, key.market_type, key.symbol):
            return False
        params = dict(key.params)
        try:
            return (
                int(event.data["depth_levels"]) == int(params["depth_levels"])
                and int(event.data["update_interval_ms"])
                == int(params["update_interval_ms"])
            )
        except (KeyError, TypeError, ValueError):
            return False

    @staticmethod
    def _validate_key(key: MarketStreamKey) -> MarketStreamKey:
        if not isinstance(key, MarketStreamKey):
            raise TypeError("order-book stream key must be a MarketStreamKey")
        if key.channel is not MarketChannel.DEPTH:
            raise ValueError("order-book service only accepts depth keys")
        params = dict(key.params)
        if frozenset(params) != _REQUIRED_PARAMS:
            raise ValueError(
                "partial order-book key requires exactly mode, depth_levels, "
                "and update_interval_ms params",
            )
        if params["mode"] != "partial":
            raise ValueError("order-book service only supports mode='partial'")
        depth_levels = _canonical_positive_int(params["depth_levels"], "depth_levels")
        update_interval_ms = _canonical_positive_int(
            params["update_interval_ms"],
            "update_interval_ms",
        )
        if depth_levels not in _BINANCE_PARTIAL_LEVELS:
            raise ValueError("partial order-book depth_levels must be one of 5, 10, or 20")
        if key.exchange == "binance":
            allowed_intervals = _BINANCE_UPDATE_INTERVALS_MS.get(key.market_type)
            if allowed_intervals is None:
                raise ValueError(
                    "Binance partial order-book service requires market_type "
                    "to be 'spot' or 'futures'",
                )
            if update_interval_ms not in allowed_intervals:
                supported = ", ".join(str(value) for value in sorted(allowed_intervals))
                raise ValueError(
                    f"Binance {key.market_type} update_interval_ms must be one of "
                    f"{supported}",
                )
        return key

    def _ensure_open(self) -> None:
        if self._closing or self._closed:
            raise RuntimeError("order-book service is closed")

    def _ensure_readable(self) -> None:
        if self._closing or self._closed:
            raise RuntimeError("order-book service is closed")


def _identity(key: MarketStreamKey) -> OrderBookIdentity:
    params = dict(key.params)
    return (
        key.exchange,
        key.market_type,
        key.symbol,
        int(params["depth_levels"]),
        int(params["update_interval_ms"]),
    )


def _descriptor(key: MarketStreamKey) -> StreamDescriptor:
    params = dict(key.params)
    return StreamDescriptor(
        symbol=key.symbol,
        stream_type=StreamType.DEPTH,
        depth_levels=int(params["depth_levels"]),
        update_interval_ms=int(params["update_interval_ms"]),
        exchange=key.exchange,
        market_type=key.market_type,
    )


def _consumer_id(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("consumer_id cannot be blank")
    return value.strip()


def _canonical_positive_int(value: str, label: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a positive integer") from exc
    if parsed <= 0 or str(parsed) != value:
        raise ValueError(f"{label} must be a canonical positive integer")
    return parsed
