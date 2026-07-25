"""Ordered actor lifecycle for reconstructed Full Order Books.

The service subscribes to the diff-depth WebSocket first, buffers every delta
through two explicit bounded queues, and only then aligns an asynchronous REST
snapshot.  Any loss, sequence gap, crossed book, or lifecycle epoch mismatch
makes the public state stale and starts a new bootstrap.  A stale book is never
returned by ``current`` or ``wait_for_live``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.data_engine.ingestion.models import (
    DataSource,
    MarketEvent,
    StreamDescriptor,
    StreamType,
)
from app.exchanges import RateLimitAdmission, RateLimitDeferred

from .events import HubRecord, MarketStateEvent
from .hub import MarketEventHub, MarketHubSubscription
from .models import MarketChannel, MarketStreamKey


logger = logging.getLogger("data_engine.market_data.full_order_book")

FullOrderBookIdentity = tuple[str, str, str, int]

_REQUIRED_PARAMS = frozenset({"mode", "snapshot_limit", "update_interval_ms"})
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
        on_health: Any | None = None,
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
        defer_on_rate_limit: bool = False,
    ) -> list[MarketEvent]: ...


class _FullOrderBookEngine(Protocol):
    def activate_stream(self, identity: FullOrderBookIdentity) -> bool: ...

    def deactivate_stream(self, identity: FullOrderBookIdentity) -> bool: ...

    def begin_sync(self, identity: FullOrderBookIdentity) -> int: ...

    def apply_delta(
        self,
        identity: FullOrderBookIdentity,
        event: MarketEvent,
        *,
        epoch: int,
    ) -> Any: ...

    def install_snapshot(
        self,
        identity: FullOrderBookIdentity,
        event: MarketEvent,
        *,
        epoch: int,
    ) -> Any: ...

    def diagnostics(self) -> dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class FullOrderBookAttachment:
    """A replaying state subscription plus live snapshots at attach time."""

    subscription: MarketHubSubscription
    current: dict[MarketStreamKey, HubRecord]


class FullOrderBookRateLimited(RuntimeError):
    """Raised by bounded HTTP waiters while the upstream circuit is open."""

    def __init__(self, *, retry_at_ms: int, bucket_key: str | None = None) -> None:
        self.retry_at_ms = int(retry_at_ms)
        self.bucket_key = bucket_key
        super().__init__("full order-book upstream is rate limited")


@dataclass(frozen=True, slots=True)
class _DeltaEnvelope:
    event: MarketEvent
    generation: int
    resync_version: int


@dataclass(slots=True)
class _FullBookActor:
    key: MarketStreamKey
    identity: FullOrderBookIdentity
    generation: int
    queue: asyncio.Queue[_DeltaEnvelope]
    consumers: set[str] = field(default_factory=set)
    handle: Any = None
    actor_task: asyncio.Task[None] | None = None
    stop_task: asyncio.Task[Any] | None = None
    stop_state: str = "active"
    reconcile_stop_on_completion: bool = False
    accepting: bool = True
    state: str = "starting"
    stale_reason: str = "initial_sync"
    resync_version: int = 1
    resync_requested: bool = True
    engine_epoch: int | None = None
    backoff_seconds: float = 0.0
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    last_delta_at_ms: int | None = None
    last_live_at_ms: int | None = None
    last_update_id: int | None = None
    snapshot_attempts: int = 0
    resyncs: int = 0
    upstream_health: str = "unknown"
    upstream_broken: bool = False
    rate_limit_retry_at_ms: int | None = None
    rate_limit_bucket: str | None = None
    rate_limit_reason: str | None = None


class FullOrderBookService:
    """Own one strict ordered actor per physical Full Depth identity."""

    def __init__(
        self,
        ingestion_factory: _IngestionFactory,
        *,
        engine: _FullOrderBookEngine | None = None,
        hub: MarketEventHub | None = None,
        max_streams: int = 16,
        upstream_queue_size: int = 4096,
        snapshot_limit: int = 1000,
        snapshot_timeout_seconds: float = 5.0,
        resync_backoff_seconds: float = 0.1,
        max_resync_backoff_seconds: float = 5.0,
        physical_stop_timeout_seconds: float = 5.0,
        default_max_pending: int = 16,
    ) -> None:
        self._factory = ingestion_factory
        self._max_streams = _positive_int(max_streams, "max_streams")
        self._upstream_queue_size = _positive_int(
            upstream_queue_size,
            "upstream_queue_size",
        )
        self._snapshot_limit = _positive_int(snapshot_limit, "snapshot_limit")
        if self._snapshot_limit != 1000:
            raise ValueError("Full Order Book snapshot_limit must be 1000")
        self._snapshot_timeout_seconds = _positive_float(
            snapshot_timeout_seconds,
            "snapshot_timeout_seconds",
        )
        self._initial_resync_backoff_seconds = _non_negative_float(
            resync_backoff_seconds,
            "resync_backoff_seconds",
        )
        self._max_resync_backoff_seconds = _positive_float(
            max_resync_backoff_seconds,
            "max_resync_backoff_seconds",
        )
        if self._max_resync_backoff_seconds < self._initial_resync_backoff_seconds:
            raise ValueError(
                "max_resync_backoff_seconds cannot be less than resync_backoff_seconds",
            )
        self._physical_stop_timeout_seconds = max(
            0.01,
            min(
                _positive_float(
                    physical_stop_timeout_seconds,
                    "physical_stop_timeout_seconds",
                ),
                30.0,
            ),
        )
        if engine is None:
            from .full_order_book import FullOrderBookEngine

            engine = FullOrderBookEngine(
                max_streams=self._max_streams,
                max_buffered_deltas_per_stream=self._upstream_queue_size,
            )
        self.engine = engine
        self.hub = hub or MarketEventHub(
            max_states=self._max_streams,
            default_max_pending=default_max_pending,
        )
        self._physical: dict[MarketStreamKey, _FullBookActor] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._shutdown_task: asyncio.Task[None] | None = None
        self._snapshot_tasks: set[asyncio.Task[Any]] = set()
        self._discarded_snapshot_tasks: set[asyncio.Task[Any]] = set()
        self._pending_stop_finalizers: set[asyncio.Task[None]] = set()
        self._next_generation = 0
        self._accepting = True
        self._closing = False
        self._closed = False
        self._shutdown_degraded = False
        self._metrics: dict[str, Any] = {
            "deltas_offered": 0,
            "deltas_enqueued": 0,
            "deltas_processed": 0,
            "deltas_invalid": 0,
            "deltas_old_epoch_discarded": 0,
            "deltas_inactive_generation": 0,
            "upstream_queue_overflows": 0,
            "upstream_queue_high_water": 0,
            "resync_requests": 0,
            "resyncs_started": 0,
            "resyncs_succeeded": 0,
            "resyncs_failed": 0,
            "snapshot_fetch_attempts": 0,
            "snapshot_fetch_deferred": 0,
            "snapshot_fetch_timeouts": 0,
            "snapshot_fetch_errors": 0,
            "snapshot_results_discarded": 0,
            "snapshot_shutdown_timeouts": 0,
            "engine_buffered": 0,
            "engine_duplicates": 0,
            "engine_stale": 0,
            "engine_resync_required": 0,
            "live_snapshots_published": 0,
            "stale_states_published": 0,
            "hub_publish_rejected": 0,
            "ingestion_gaps": 0,
            "upstream_health_breaks": 0,
            "upstream_health_connected": 0,
            "deltas_discarded_while_rate_limited": 0,
            "events_after_stop": 0,
            "physical_stops_attempted": 0,
            "physical_stops_succeeded": 0,
            "physical_stop_timeouts": 0,
            "physical_stop_failures": 0,
            "physical_stops_late_succeeded": 0,
            "last_physical_stop_error": None,
        }

    async def ensure_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
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
                    raise RuntimeError(
                        "full order-book physical stream stop is still in progress",
                    )
                if existing.stop_state != "active":
                    if not await self._stop_physical(validated, existing):
                        raise RuntimeError(
                            "full order-book physical stream is unavailable after a failed stop",
                        )
                    await self._retire_actor(validated, existing)
                    existing = None
                else:
                    if consumer in existing.consumers:
                        return False
                    existing.consumers.add(consumer)
                    return True
            if len(self._physical) >= self._max_streams:
                raise RuntimeError(
                    f"full order-book physical stream limit reached ({self._max_streams})",
                )

            identity = _engine_identity(validated)
            if not self.engine.activate_stream(identity):
                raise RuntimeError(
                    "full order-book engine identity is active without a physical actor",
                )
            self._next_generation += 1
            actor = _FullBookActor(
                key=validated,
                identity=identity,
                generation=self._next_generation,
                queue=asyncio.Queue(maxsize=self._upstream_queue_size),
                consumers={consumer},
                backoff_seconds=self._initial_resync_backoff_seconds,
            )
            self._physical[validated] = actor
            self._publish_stale(actor, "initial_sync")
            actor.actor_task = asyncio.create_task(
                self._run_actor(actor),
                name=(
                    f"full-book-actor-{validated.exchange}-"
                    f"{validated.market_type}-{validated.symbol}"
                ),
            )

            async def _on_delta(event: MarketEvent) -> None:
                self._offer_delta(actor, event, generation=actor.generation)

            async def _on_gap(_gap: Any) -> None:
                self._metrics["ingestion_gaps"] += 1
                self._request_resync(
                    actor,
                    "ingestion_gap",
                    generation=actor.generation,
                    force_new_version=True,
                )

            async def _on_health(health: Any, _reason: str) -> None:
                if (
                    not self._accepting
                    or not actor.accepting
                    or self._physical.get(actor.key) is not actor
                ):
                    self._metrics["events_after_stop"] += 1
                    return
                value = str(getattr(health, "value", health)).strip().lower()
                actor.upstream_health = value or "unknown"
                if value == "connected":
                    if actor.upstream_broken:
                        self._metrics["upstream_health_connected"] += 1
                    actor.upstream_broken = False
                    return
                if value not in {"reconnecting", "unhealthy", "disconnected"}:
                    return
                if actor.upstream_broken:
                    return
                actor.upstream_broken = True
                self._metrics["upstream_health_breaks"] += 1
                self._request_resync(
                    actor,
                    f"ingestion_{value}",
                    generation=actor.generation,
                    force_new_version=True,
                )

            try:
                actor.handle = await self._factory.start_market(
                    _descriptor(validated),
                    _on_delta,
                    on_gap=_on_gap,
                    on_health=_on_health,
                )
            except BaseException:
                await self._retire_actor(validated, actor)
                raise
            actor.wake.set()
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
            actor = self._physical.get(validated)
            if actor is None or consumer not in actor.consumers:
                return False
            if len(actor.consumers) > 1:
                actor.consumers.remove(consumer)
                return True
            await self._quiesce_actor(actor, reason="released")
            if not await self._stop_physical(validated, actor):
                return False
            await self._retire_actor(validated, actor)
            return True

    def current(
        self,
        key: MarketStreamKey,
        *,
        require_live: bool = True,
    ) -> HubRecord | None:
        self._ensure_readable()
        validated = self._validate_key(key)
        actor = self._physical.get(validated)
        if actor is None:
            return None
        records = self.hub.snapshot([validated])
        if not records:
            return None
        record = records[0]
        is_live = (
            actor.state == "live"
            and bool(record.event.data.get("live"))
            and record.event.data.get("generation") == actor.generation
            and record.event.data.get("resync_version") == actor.resync_version
        )
        if require_live and not is_live:
            return None
        return record

    async def wait_for_live(
        self,
        key: MarketStreamKey,
        *,
        timeout_seconds: float = 5.0,
    ) -> HubRecord:
        self._ensure_readable()
        validated = self._validate_key(key)
        if validated not in self._physical:
            raise RuntimeError("full order-book stream is not leased")
        timeout = _positive_float(timeout_seconds, "timeout_seconds")
        subscription = self.hub.subscribe([validated], replay=True)
        try:
            current = self.current(validated, require_live=True)
            if current is not None:
                return current
            stale = self.current(validated, require_live=False)
            self._raise_if_rate_limited(stale)
            deadline = asyncio.get_running_loop().time() + timeout
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError("full order-book live wait timed out")
                record = await asyncio.wait_for(
                    subscription.receive(),
                    timeout=remaining,
                )
                if record is None:
                    raise RuntimeError("full order-book state subscription closed")
                self._raise_if_rate_limited(record)
                if self._is_current_live_record(validated, record):
                    return record
        finally:
            await subscription.close()

    @staticmethod
    def _raise_if_rate_limited(record: HubRecord | None) -> None:
        if record is None or not bool(record.event.data.get("rate_limited")):
            return
        retry_at_ms = record.event.data.get("retry_at_ms")
        if retry_at_ms is None or int(retry_at_ms) <= int(time.time() * 1000):
            return
        raise FullOrderBookRateLimited(
            retry_at_ms=int(retry_at_ms),
            bucket_key=record.event.data.get("rate_limit_bucket"),
        )

    def attach(
        self,
        keys: MarketStreamKey | Iterable[MarketStreamKey],
        *,
        max_pending: int | None = None,
    ) -> FullOrderBookAttachment:
        self._ensure_readable()
        if isinstance(keys, MarketStreamKey):
            requested = (self._validate_key(keys),)
        else:
            requested = tuple(dict.fromkeys(self._validate_key(key) for key in keys))
        if not requested:
            raise ValueError("full order-book attachment requires at least one key")
        # Replay is intentional: during resync the latest record is an explicit
        # stale state.  Consumers must never keep treating the prior live book
        # as current merely because they attached after the gap notification.
        subscription = self.hub.subscribe(
            requested,
            max_pending=max_pending,
            replay=True,
        )
        current = {
            key: record
            for key in requested
            if (record := self.current(key, require_live=True)) is not None
        }
        return FullOrderBookAttachment(subscription=subscription, current=current)

    def diagnostics(self) -> dict[str, Any]:
        if self._closed:
            state = "closed"
        elif self._closing:
            state = "closing"
        elif self._physical:
            state = "running"
        else:
            state = "idle"
        now_ms = int(time.time() * 1000)
        return {
            "state": state,
            "delivery": "reconstructed_atomic_snapshot",
            "source_delivery": "ordered_delta",
            "fail_closed_on_gap": True,
            "persistence": False,
            "backfillable": False,
            "physical_streams": len(self._physical),
            "logical_leases": sum(
                len(actor.consumers) for actor in self._physical.values()
            ),
            "limits": {
                "streams": self._max_streams,
                "upstream_queue_per_stream": self._upstream_queue_size,
                "snapshot_limit": self._snapshot_limit,
                "snapshot_timeout_seconds": self._snapshot_timeout_seconds,
                "initial_resync_backoff_seconds": (
                    self._initial_resync_backoff_seconds
                ),
                "max_resync_backoff_seconds": self._max_resync_backoff_seconds,
            },
            "actors": [
                {
                    "key": key.to_dict(),
                    "generation": actor.generation,
                    "resync_version": actor.resync_version,
                    "engine_epoch": actor.engine_epoch,
                    "state": actor.state,
                    "stale_reason": actor.stale_reason,
                    "consumers": len(actor.consumers),
                    "queue_pending": actor.queue.qsize(),
                    "queue_limit": actor.queue.maxsize,
                    "last_delta_at_ms": actor.last_delta_at_ms,
                    "last_live_at_ms": actor.last_live_at_ms,
                    "last_delta_age_ms": (
                        max(0, now_ms - actor.last_delta_at_ms)
                        if actor.last_delta_at_ms is not None
                        else None
                    ),
                    "last_update_id": actor.last_update_id,
                    "snapshot_attempts": actor.snapshot_attempts,
                    "resyncs": actor.resyncs,
                    "upstream_health": actor.upstream_health,
                    "upstream_broken": actor.upstream_broken,
                    "rate_limited": bool(
                        actor.rate_limit_retry_at_ms is not None
                        and actor.rate_limit_retry_at_ms > now_ms
                    ),
                    "retry_at_ms": actor.rate_limit_retry_at_ms,
                    "rate_limit_bucket": actor.rate_limit_bucket,
                    "rate_limit_reason": actor.rate_limit_reason,
                    "stop_state": actor.stop_state,
                }
                for key, actor in sorted(
                    self._physical.items(),
                    key=lambda item: item[0].topic,
                )
            ],
            "snapshot_tasks": len(self._snapshot_tasks),
            "hub": self.hub.diagnostics(),
            "engine": self.engine.diagnostics(),
            "shutdown": {
                "degraded": self._shutdown_degraded,
                "pending_stop_finalizers": len(self._pending_stop_finalizers),
                "physical_stop_timeout_seconds": self._physical_stop_timeout_seconds,
                "last_physical_stop_error": self._metrics["last_physical_stop_error"],
            },
            **self._metrics,
        }

    async def shutdown(self) -> None:
        async with self._lifecycle_lock:
            if self._closed:
                return
            if self._shutdown_task is None:
                self._closing = True
                self._shutdown_task = asyncio.create_task(
                    self._shutdown_impl(),
                    name="full-order-book-shutdown",
                )
            task = self._shutdown_task
        await asyncio.shield(task)

    async def _shutdown_impl(self) -> None:
        self._accepting = False
        actors = tuple(self._physical.items())
        if actors:
            await asyncio.gather(*(
                self._quiesce_actor(actor, reason="shutdown")
                for _key, actor in actors
            ))
            await asyncio.gather(*(
                self._stop_physical(key, actor)
                for key, actor in actors
            ))
        for key, actor in tuple(self._physical.items()):
            await self._retire_actor(key, actor)
        snapshot_tasks = tuple(self._snapshot_tasks)
        for task in snapshot_tasks:
            task.cancel()
        if snapshot_tasks:
            _done, pending = await asyncio.wait(
                snapshot_tasks,
                timeout=self._physical_stop_timeout_seconds,
            )
            if pending:
                self._metrics["snapshot_shutdown_timeouts"] += len(pending)
                self._shutdown_degraded = True
                for task in pending:
                    task.cancel()
        await self.hub.close()
        self._closed = True

    async def _run_actor(self, actor: _FullBookActor) -> None:
        try:
            while not actor.stop_event.is_set():
                try:
                    if actor.handle is None:
                        # Initial sync is already requested, so the generic
                        # wake helper would return immediately and spin while
                        # start_market() is still awaiting network setup.
                        actor.wake.clear()
                        if actor.handle is None and not actor.stop_event.is_set():
                            await actor.wake.wait()
                        continue
                    if actor.resync_requested or actor.state != "live":
                        await self._bootstrap(actor)
                        continue
                    envelope = await self._next_delta(actor)
                    if envelope is None:
                        continue
                    self._apply_delta(actor, envelope)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception(
                        "Full order-book actor iteration failed for %s",
                        actor.key.topic,
                    )
                    if actor.stop_event.is_set():
                        return
                    await self._sync_failed(actor, "actor_failure")
        except asyncio.CancelledError:
            raise
        finally:
            self._drain_actor_queue(actor)

    async def _bootstrap(self, actor: _FullBookActor) -> None:
        admission = await self._snapshot_rate_limit_admission(actor)
        if admission is not None and not admission.allowed:
            await self._rate_limit_deferred(actor, admission)
            return

        recovered_from_rate_limit = actor.rate_limit_retry_at_ms is not None
        actor.rate_limit_retry_at_ms = None
        actor.rate_limit_bucket = None
        actor.rate_limit_reason = None
        # Deltas observed while an IP circuit was open cannot be bridged to a
        # snapshot obtained after recovery. Start a clean continuity epoch.
        if recovered_from_rate_limit:
            self._drain_actor_queue(actor)
            # Replace the replayed circuit-open record before starting REST.
            # Otherwise a bounded waiter attaching during this recovery
            # window can receive a stale 429 even though admission succeeded.
            self._publish_stale(actor, "upstream_recovering")
        version = actor.resync_version
        actor.resync_requested = False
        actor.state = "resyncing"
        actor.resyncs += 1
        self._metrics["resyncs_started"] += 1
        self._discard_other_versions(actor, version)
        engine_epoch = self.engine.begin_sync(actor.identity)
        actor.engine_epoch = engine_epoch
        actor.snapshot_attempts += 1
        self._metrics["snapshot_fetch_attempts"] += 1

        fetch_task = asyncio.create_task(
            self._factory.fetch_market(
                _descriptor(actor.key),
                limit=self._snapshot_limit,
                history=False,
                defer_on_rate_limit=True,
            ),
            name=(
                f"full-book-snapshot-{actor.key.exchange}-"
                f"{actor.key.market_type}-{actor.key.symbol}-e{engine_epoch}"
            ),
        )
        self._snapshot_tasks.add(fetch_task)
        fetch_task.add_done_callback(self._snapshot_tasks.discard)
        fetch_task.add_done_callback(self._discarded_snapshot_tasks.discard)
        fetch_task.add_done_callback(self._consume_task_exception)
        fetch_task.add_done_callback(lambda _task: actor.wake.set())
        deadline = (
            asyncio.get_running_loop().time() + self._snapshot_timeout_seconds
        )
        try:
            # Give the independent REST request one scheduling turn
            # immediately. Deltas remain confined to the actor queue and are
            # drained before installation, so I/O starts promptly without an
            # ordering race. Keep this await inside the cleanup guard.
            await asyncio.sleep(0)
            while not fetch_task.done():
                if self._bootstrap_invalidated(actor, version):
                    self._discard_snapshot_task(fetch_task)
                    return
                if not self._drain_deltas_to_engine(actor, version, engine_epoch):
                    self._discard_snapshot_task(fetch_task)
                    return
                if fetch_task.done():
                    break
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    self._metrics["snapshot_fetch_timeouts"] += 1
                    self._discard_snapshot_task(fetch_task)
                    await self._sync_failed(actor, "snapshot_timeout")
                    return
                await self._wait_for_actor_wake(actor, timeout=remaining)

            self._snapshot_tasks.discard(fetch_task)
            if self._bootstrap_invalidated(actor, version):
                self._consume_task_exception(fetch_task)
                self._metrics["snapshot_results_discarded"] += 1
                return
            if not self._drain_deltas_to_engine(actor, version, engine_epoch):
                self._consume_task_exception(fetch_task)
                return
            if fetch_task.cancelled():
                self._metrics["snapshot_fetch_errors"] += 1
                await self._sync_failed(actor, "snapshot_fetch_cancelled")
                return
            try:
                events = fetch_task.result()
                snapshot = self._snapshot_event(actor, events)
            except RateLimitDeferred as exc:
                await self._rate_limit_deferred(actor, exc.admission)
                return
            except (TypeError, ValueError) as exc:
                self._metrics["snapshot_fetch_errors"] += 1
                await self._sync_failed(actor, f"snapshot_invalid:{type(exc).__name__}")
                return
            except Exception as exc:
                self._metrics["snapshot_fetch_errors"] += 1
                logger.warning(
                    "Full order-book snapshot fetch failed for %s: %s",
                    actor.key.topic,
                    exc,
                )
                await self._sync_failed(actor, "snapshot_fetch_error")
                return

            if self._bootstrap_invalidated(actor, version):
                self._metrics["snapshot_results_discarded"] += 1
                return
            # No callback can interleave with this synchronous final drain and
            # install, so every already-delivered delta is included atomically.
            if not self._drain_deltas_to_engine(actor, version, engine_epoch):
                return
            try:
                result = self.engine.install_snapshot(
                    actor.identity,
                    snapshot,
                    epoch=engine_epoch,
                )
            except (TypeError, ValueError):
                await self._sync_failed(actor, "snapshot_install_invalid")
                return
            outcome = self._handle_engine_result(actor, result)
            if outcome == "live":
                return
            if outcome == "resync":
                return

            bridge_deadline = (
                asyncio.get_running_loop().time() + self._snapshot_timeout_seconds
            )
            while not self._bootstrap_invalidated(actor, version):
                envelope = await self._next_delta(
                    actor,
                    version=version,
                    deadline=bridge_deadline,
                )
                if envelope is None:
                    if asyncio.get_running_loop().time() >= bridge_deadline:
                        await self._sync_failed(actor, "bridge_timeout")
                    return
                outcome = self._apply_delta(actor, envelope)
                if outcome in {"live", "resync"}:
                    return
        finally:
            if not fetch_task.done():
                self._discard_snapshot_task(fetch_task)

    async def _snapshot_rate_limit_admission(
        self,
        actor: _FullBookActor,
    ) -> RateLimitAdmission | None:
        inspect = getattr(self._factory, "market_rate_limit_admission", None)
        if not callable(inspect):
            return None
        try:
            return await inspect(
                _descriptor(actor.key),
                limit=self._snapshot_limit,
                history=False,
            )
        except RateLimitDeferred as exc:
            return exc.admission
        except Exception:
            # The physical fetch remains the authoritative check.  Failure of
            # this optional fast-path must not kill the ordered actor.
            logger.warning(
                "Full order-book quota inspection failed for %s",
                actor.key.topic,
                exc_info=True,
            )
            return None

    async def _rate_limit_deferred(
        self,
        actor: _FullBookActor,
        admission: RateLimitAdmission,
    ) -> None:
        retry_at_ms = admission.retry_at_ms or (
            int(time.time() * 1000)
            + max(1, int(admission.retry_after_seconds * 1000))
        )
        actor.rate_limit_retry_at_ms = int(retry_at_ms)
        actor.rate_limit_bucket = admission.bucket_key
        actor.rate_limit_reason = admission.reason
        self._metrics["snapshot_fetch_deferred"] += 1
        self._drain_actor_queue(actor)
        self._request_resync(
            actor,
            "upstream_rate_limited",
            generation=actor.generation,
        )
        if admission.retry_at_monotonic is not None:
            # Monotonic time is authoritative for local scheduling. Wall
            # clock ``retry_at_ms`` is transport metadata only and may jump.
            retry_at_monotonic = admission.retry_at_monotonic
        else:
            delay = max(
                0.001,
                (retry_at_ms - int(time.time() * 1000)) / 1000,
            )
            retry_at_monotonic = time.monotonic() + delay
        # Some Windows event loops can deliver a short timer slightly before
        # its monotonic deadline. Re-check here so an early wake does not
        # become another admission/defer cycle and another public stale event.
        while not actor.stop_event.is_set():
            remaining = retry_at_monotonic - time.monotonic()
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(
                    actor.stop_event.wait(),
                    timeout=max(0.001, remaining),
                )
            except TimeoutError:
                continue

    def _drain_deltas_to_engine(
        self,
        actor: _FullBookActor,
        version: int,
        engine_epoch: int,
    ) -> bool:
        while True:
            try:
                envelope = actor.queue.get_nowait()
            except asyncio.QueueEmpty:
                return True
            if (
                envelope.generation != actor.generation
                or envelope.resync_version != version
            ):
                self._metrics["deltas_old_epoch_discarded"] += 1
                continue
            self._metrics["deltas_processed"] += 1
            try:
                result = self.engine.apply_delta(
                    actor.identity,
                    envelope.event,
                    epoch=engine_epoch,
                )
            except (TypeError, ValueError):
                self._metrics["deltas_invalid"] += 1
                self._request_resync(
                    actor,
                    "invalid_delta",
                    generation=actor.generation,
                )
                return False
            if self._handle_engine_result(actor, result) == "resync":
                return False

    def _apply_delta(
        self,
        actor: _FullBookActor,
        envelope: _DeltaEnvelope,
    ) -> str:
        if (
            envelope.generation != actor.generation
            or envelope.resync_version != actor.resync_version
        ):
            self._metrics["deltas_old_epoch_discarded"] += 1
            return "ignored"
        if actor.engine_epoch is None:
            self._request_resync(
                actor,
                "missing_engine_epoch",
                generation=actor.generation,
            )
            return "resync"
        self._metrics["deltas_processed"] += 1
        try:
            result = self.engine.apply_delta(
                actor.identity,
                envelope.event,
                epoch=actor.engine_epoch,
            )
        except (TypeError, ValueError):
            self._metrics["deltas_invalid"] += 1
            self._request_resync(
                actor,
                "invalid_delta",
                generation=actor.generation,
            )
            return "resync"
        return self._handle_engine_result(actor, result)

    def _handle_engine_result(self, actor: _FullBookActor, result: Any) -> str:
        action = str(getattr(result.action, "value", result.action)).strip().lower()
        state = str(getattr(result.state, "value", result.state)).strip().lower()
        if action == "resync_required" or state == "resync_required":
            self._metrics["engine_resync_required"] += 1
            reason = str(result.reason or "engine_resync_required")
            self._request_resync(actor, reason, generation=actor.generation)
            return "resync"
        if state == "live" and result.snapshot is not None:
            self._publish_live(actor, result.snapshot)
            return "live"
        if action == "buffered":
            self._metrics["engine_buffered"] += 1
        elif action == "duplicate":
            self._metrics["engine_duplicates"] += 1
        elif action in {"stale", "stale_epoch"}:
            self._metrics["engine_stale"] += 1
            if action == "stale_epoch":
                self._request_resync(
                    actor,
                    "engine_stale_epoch",
                    generation=actor.generation,
                )
                return "resync"
        return "buffering"

    def _offer_delta(
        self,
        actor: _FullBookActor,
        event: MarketEvent,
        *,
        generation: int,
    ) -> None:
        if not self._accepting or not actor.accepting:
            self._metrics["events_after_stop"] += 1
            return
        if self._physical.get(actor.key) is not actor or actor.generation != generation:
            self._metrics["deltas_inactive_generation"] += 1
            return
        if not self._event_matches(actor, event, kind="delta"):
            self._metrics["deltas_invalid"] += 1
            self._request_resync(
                actor,
                "invalid_upstream_delta",
                generation=generation,
                force_new_version=True,
            )
            return
        self._metrics["deltas_offered"] += 1
        if (
            actor.rate_limit_retry_at_ms is not None
            and actor.rate_limit_retry_at_ms > int(time.time() * 1000)
        ):
            # Without a contemporaneous REST snapshot these deltas can never
            # establish a valid bridge. Keeping minutes of them only converts
            # an upstream cooldown into a local queue-overflow incident.
            self._metrics["deltas_discarded_while_rate_limited"] += 1
            actor.last_delta_at_ms = event.received_at_ms
            return
        envelope = _DeltaEnvelope(event, generation, actor.resync_version)
        try:
            actor.queue.put_nowait(envelope)
        except asyncio.QueueFull:
            self._metrics["upstream_queue_overflows"] += 1
            # Capacity pressure is a continuity break, never a silent drop.
            # Invalidate and synchronously clear the old epoch, then retain the
            # delta that exposed the overflow as the first candidate for the
            # next REST alignment epoch.
            self._request_resync(
                actor,
                "upstream_queue_overflow",
                generation=generation,
                force_new_version=True,
            )
            envelope = _DeltaEnvelope(event, generation, actor.resync_version)
            actor.queue.put_nowait(envelope)
        self._metrics["deltas_enqueued"] += 1
        self._metrics["upstream_queue_high_water"] = max(
            self._metrics["upstream_queue_high_water"],
            actor.queue.qsize(),
        )
        actor.last_delta_at_ms = event.received_at_ms
        actor.wake.set()

    def _request_resync(
        self,
        actor: _FullBookActor,
        reason: str,
        *,
        generation: int,
        force_new_version: bool = False,
    ) -> None:
        if not self._accepting or not actor.accepting:
            self._metrics["events_after_stop"] += 1
            return
        if self._physical.get(actor.key) is not actor or actor.generation != generation:
            self._metrics["deltas_inactive_generation"] += 1
            return
        if force_new_version or not actor.resync_requested:
            actor.resync_version += 1
            actor.resync_requested = True
            self._metrics["resync_requests"] += 1
            if force_new_version:
                self._discard_other_versions(actor, actor.resync_version)
        self._publish_stale(actor, reason)
        actor.wake.set()

    def _publish_stale(self, actor: _FullBookActor, reason: str) -> None:
        actor.state = "stale"
        actor.stale_reason = str(reason)
        current = self.hub.snapshot([actor.key])
        previous = current[0] if current else None
        now_ms = int(time.time() * 1000)
        if previous is not None:
            event_time_ms = max(now_ms, previous.event.event_time_ms + 1)
            received_at_ms = max(now_ms, previous.event.received_at_ms + 1)
            payload = dict(previous.event.data)
            sequence = previous.event.sequence
        else:
            event_time_ms = now_ms
            received_at_ms = now_ms
            payload = {
                "exchange": actor.key.exchange,
                "market_type": actor.key.market_type,
                "symbol": actor.key.symbol,
                "update_interval_ms": actor.identity[3],
                "snapshot_limit": self._snapshot_limit,
                "bids": [],
                "asks": [],
            }
            sequence = None
        last_live_update_id = actor.last_update_id
        last_live_source = payload.get("source")
        last_live_event_time_ms = payload.get("event_time_ms")
        last_live_received_at_ms = payload.get("received_at_ms")
        last_live_epoch = payload.get("epoch")
        payload.update({
            "bids": [],
            "asks": [],
            "last_update_id": None,
            "last_live_update_id": last_live_update_id,
            "epoch": None,
            "last_live_epoch": last_live_epoch,
            "source": None,
            "last_live_source": last_live_source,
            "event_time_ms": None,
            "last_live_event_time_ms": last_live_event_time_ms,
            "received_at_ms": None,
            "last_live_received_at_ms": last_live_received_at_ms,
            "top_bid": None,
            "top_ask": None,
            "mid_price": None,
            "spread": None,
            "spread_bps": None,
            "book_bid_levels": 0,
            "book_ask_levels": 0,
            "projection_depth": 0,
            "full_projection": False,
            "revision": None,
            "local_sequence_continuity": False,
        })
        payload.update({
            "state": "stale",
            "live": False,
            "stale": True,
            "stale_reason": actor.stale_reason,
            "rate_limited": bool(
                actor.rate_limit_retry_at_ms is not None
                and actor.rate_limit_retry_at_ms > now_ms
            ),
            "retry_at_ms": actor.rate_limit_retry_at_ms,
            "rate_limit_bucket": actor.rate_limit_bucket,
            "rate_limit_reason": actor.rate_limit_reason,
            "generation": actor.generation,
            "resync_version": actor.resync_version,
            "engine_epoch": actor.engine_epoch,
            "full_book": True,
            "sequence_continuity": False,
        })
        record = self.hub.publish(MarketStateEvent(
            key=actor.key,
            event_time_ms=event_time_ms,
            received_at_ms=received_at_ms,
            source=DataSource.WEBSOCKET,
            data=payload,
            sequence=sequence,
        ))
        if record is None:
            self._metrics["hub_publish_rejected"] += 1
        else:
            self._metrics["stale_states_published"] += 1

    def _publish_live(self, actor: _FullBookActor, snapshot: Any) -> None:
        completed_resync = actor.state != "live"
        to_event_data = getattr(snapshot, "to_event_data", None)
        payload = (
            to_event_data()
            if callable(to_event_data)
            else snapshot.to_dict()
        )
        payload.update({
            "state": "live",
            "live": True,
            "stale": False,
            "stale_reason": None,
            "rate_limited": False,
            "retry_at_ms": None,
            "rate_limit_bucket": None,
            "rate_limit_reason": None,
            "generation": actor.generation,
            "resync_version": actor.resync_version,
            "engine_epoch": actor.engine_epoch,
            "full_book": True,
            "sequence_continuity": True,
        })
        current = self.hub.snapshot([actor.key])
        previous = current[0] if current else None
        event_time_ms = snapshot.event_time_ms
        received_at_ms = snapshot.received_at_ms
        if previous is not None:
            # Stale/status records use a synthetic process-local timestamp and
            # can therefore be newer than the exchange timestamp of the first
            # recovered delta. Keep the hub envelope monotonic while retaining
            # the untouched exchange timestamps inside the snapshot payload.
            event_time_ms = max(
                event_time_ms,
                previous.event.event_time_ms + 1,
            )
            received_at_ms = max(
                received_at_ms,
                previous.event.received_at_ms + 1,
            )
        record = self.hub.publish(MarketStateEvent(
            key=actor.key,
            event_time_ms=event_time_ms,
            received_at_ms=received_at_ms,
            source=snapshot.source,
            data=payload,
            sequence=snapshot.last_update_id,
        ))
        if record is None:
            self._metrics["hub_publish_rejected"] += 1
            self._request_resync(
                actor,
                "hub_state_regression",
                generation=actor.generation,
            )
            return
        actor.state = "live"
        actor.stale_reason = ""
        actor.rate_limit_retry_at_ms = None
        actor.rate_limit_bucket = None
        actor.rate_limit_reason = None
        actor.last_live_at_ms = snapshot.received_at_ms
        actor.last_update_id = snapshot.last_update_id
        actor.backoff_seconds = self._initial_resync_backoff_seconds
        self._metrics["live_snapshots_published"] += 1
        if completed_resync:
            self._metrics["resyncs_succeeded"] += 1

    async def _sync_failed(self, actor: _FullBookActor, reason: str) -> None:
        self._metrics["resyncs_failed"] += 1
        self._request_resync(actor, reason, generation=actor.generation)
        delay = actor.backoff_seconds
        if delay > 0:
            try:
                await asyncio.wait_for(actor.stop_event.wait(), timeout=delay)
            except TimeoutError:
                pass
        actor.backoff_seconds = min(
            self._max_resync_backoff_seconds,
            max(
                self._initial_resync_backoff_seconds,
                actor.backoff_seconds * 2,
            ),
        )

    async def _next_delta(
        self,
        actor: _FullBookActor,
        *,
        version: int | None = None,
        deadline: float | None = None,
    ) -> _DeltaEnvelope | None:
        expected_version = actor.resync_version if version is None else version
        while not actor.stop_event.is_set():
            if actor.resync_requested or actor.resync_version != expected_version:
                return None
            try:
                envelope = actor.queue.get_nowait()
            except asyncio.QueueEmpty:
                timeout = None
                if deadline is not None:
                    timeout = deadline - asyncio.get_running_loop().time()
                    if timeout <= 0:
                        return None
                await self._wait_for_actor_wake(actor, timeout=timeout)
                continue
            if (
                envelope.generation != actor.generation
                or envelope.resync_version != expected_version
            ):
                self._metrics["deltas_old_epoch_discarded"] += 1
                continue
            return envelope
        return None

    async def _wait_for_actor_wake(
        self,
        actor: _FullBookActor,
        *,
        timeout: float | None = None,
    ) -> bool:
        actor.wake.clear()
        if (
            actor.stop_event.is_set()
            or actor.resync_requested
            or not actor.queue.empty()
        ):
            return True
        try:
            if timeout is None:
                await actor.wake.wait()
            else:
                await asyncio.wait_for(actor.wake.wait(), timeout=timeout)
        except TimeoutError:
            return False
        return True

    def _discard_other_versions(self, actor: _FullBookActor, version: int) -> None:
        retained: list[_DeltaEnvelope] = []
        while True:
            try:
                envelope = actor.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if (
                envelope.generation == actor.generation
                and envelope.resync_version == version
            ):
                retained.append(envelope)
            else:
                self._metrics["deltas_old_epoch_discarded"] += 1
        for envelope in retained:
            actor.queue.put_nowait(envelope)

    def _bootstrap_invalidated(self, actor: _FullBookActor, version: int) -> bool:
        return (
            actor.stop_event.is_set()
            or self._physical.get(actor.key) is not actor
            or actor.resync_requested
            or actor.resync_version != version
        )

    def _snapshot_event(
        self,
        actor: _FullBookActor,
        events: list[MarketEvent],
    ) -> MarketEvent:
        if not isinstance(events, list) or len(events) != 1:
            raise ValueError("full order-book REST snapshot must contain exactly one event")
        event = events[0]
        if not self._event_matches(actor, event, kind="snapshot"):
            raise ValueError("full order-book REST snapshot identity or kind mismatch")
        return event

    def _event_matches(
        self,
        actor: _FullBookActor,
        event: MarketEvent,
        *,
        kind: str,
    ) -> bool:
        if not isinstance(event, MarketEvent):
            return False
        if event.event_type is not StreamType.FULL_DEPTH:
            return False
        try:
            event_identity = (
                event.exchange.strip().lower(),
                event.market_type.strip().lower(),
                event.symbol.strip().upper(),
            )
        except AttributeError:
            return False
        if event_identity != actor.identity[:3]:
            return False
        data = event.data
        if not isinstance(data, dict) or data.get("kind") != kind:
            return False
        try:
            if int(data["update_interval_ms"]) != actor.identity[3]:
                return False
        except (KeyError, TypeError, ValueError):
            return False
        snapshot_limit = data.get("snapshot_limit")
        if kind == "snapshot":
            try:
                return int(snapshot_limit) == self._snapshot_limit
            except (TypeError, ValueError):
                return False
        if snapshot_limit is not None:
            return False
        return True

    async def _quiesce_actor(self, actor: _FullBookActor, *, reason: str) -> None:
        if actor.accepting:
            actor.accepting = False
            self._publish_stale(actor, reason)
        actor.stop_event.set()
        actor.wake.set()
        task = actor.actor_task
        if task is not None and not task.done():
            task.cancel()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def _retire_actor(
        self,
        key: MarketStreamKey,
        actor: _FullBookActor,
    ) -> None:
        await self._quiesce_actor(actor, reason="retired")
        if self._physical.get(key) is actor:
            self._physical.pop(key, None)
            self.engine.deactivate_stream(actor.identity)

    async def _stop_physical(
        self,
        key: MarketStreamKey,
        actor: _FullBookActor,
    ) -> bool:
        self._metrics["physical_stops_attempted"] += 1
        stop_task = actor.stop_task
        if stop_task is not None and stop_task.done():
            if self._reconcile_completed_stop_locked(key, actor):
                return True
            stop_task = None
        if stop_task is None:
            if actor.handle is None:
                return True
            stop_task = asyncio.create_task(
                actor.handle.stop(),
                name=(
                    f"full-book-stop-{key.exchange}-{key.market_type}-{key.symbol}"
                ),
            )
            actor.stop_task = stop_task
        actor.stop_state = "stopping"
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
            stop_task.cancel()
            self._arm_late_stop_reconciliation(key, actor, stop_task)
            self._record_stop_failure(key, "stop timeout")
            return False
        except asyncio.CancelledError:
            stop_task.cancel()
            self._arm_late_stop_reconciliation(key, actor, stop_task)
            raise
        except Exception as exc:
            actor.stop_task = None
            actor.stop_state = "stop_failed"
            self._metrics["physical_stop_failures"] += 1
            self._record_stop_failure(key, str(exc))
            return False
        actor.stop_task = None
        actor.stop_state = "stopped"
        self._metrics["physical_stops_succeeded"] += 1
        return True

    def _reconcile_completed_stop_locked(
        self,
        key: MarketStreamKey,
        actor: _FullBookActor,
    ) -> bool:
        stop_task = actor.stop_task
        if stop_task is None or not stop_task.done():
            return False
        actor.reconcile_stop_on_completion = False
        if stop_task.cancelled():
            actor.stop_task = None
            actor.stop_state = "stop_cancelled"
            return False
        try:
            result = stop_task.result()
        except (asyncio.CancelledError, Exception) as exc:
            actor.stop_task = None
            actor.stop_state = "stop_failed"
            self._metrics["physical_stop_failures"] += 1
            self._record_stop_failure(key, f"late stop failure: {exc}")
            return False
        if result is False:
            actor.stop_task = None
            actor.stop_state = "stop_failed"
            self._metrics["physical_stop_failures"] += 1
            self._record_stop_failure(key, "late stop returned false")
            return False
        actor.stop_task = None
        actor.stop_state = "stopped"
        if self._physical.get(key) is actor:
            self._physical.pop(key, None)
            self.engine.deactivate_stream(actor.identity)
        self._metrics["physical_stops_late_succeeded"] += 1
        return True

    def _arm_late_stop_reconciliation(
        self,
        key: MarketStreamKey,
        actor: _FullBookActor,
        stop_task: asyncio.Task[Any],
    ) -> None:
        if actor.reconcile_stop_on_completion:
            return
        actor.reconcile_stop_on_completion = True
        stop_task.add_done_callback(
            lambda completed: self._schedule_stop_reconciliation(
                key,
                actor,
                completed,
            ),
        )

    def _schedule_stop_reconciliation(
        self,
        key: MarketStreamKey,
        actor: _FullBookActor,
        stop_task: asyncio.Task[Any],
    ) -> None:
        finalizer = asyncio.create_task(
            self._reconcile_late_stop(key, actor, stop_task),
            name=f"full-book-stop-finalize-{key.exchange}-{key.symbol}",
        )
        self._pending_stop_finalizers.add(finalizer)
        finalizer.add_done_callback(self._pending_stop_finalizers.discard)
        finalizer.add_done_callback(self._consume_task_exception)

    async def _reconcile_late_stop(
        self,
        key: MarketStreamKey,
        actor: _FullBookActor,
        stop_task: asyncio.Task[Any],
    ) -> None:
        async with self._lifecycle_lock:
            if actor.stop_task is not stop_task:
                self._consume_task_exception(stop_task)
                return
            self._reconcile_completed_stop_locked(key, actor)

    def _discard_snapshot_task(self, task: asyncio.Task[Any]) -> None:
        if task in self._discarded_snapshot_tasks:
            return
        self._discarded_snapshot_tasks.add(task)
        self._metrics["snapshot_results_discarded"] += 1
        task.cancel()

    def _drain_actor_queue(self, actor: _FullBookActor) -> None:
        while True:
            try:
                actor.queue.get_nowait()
            except asyncio.QueueEmpty:
                return

    def _is_current_live_record(
        self,
        key: MarketStreamKey,
        record: HubRecord,
    ) -> bool:
        actor = self._physical.get(key)
        return bool(
            actor is not None
            and actor.state == "live"
            and record.event.data.get("live")
            and record.event.data.get("generation") == actor.generation
            and record.event.data.get("resync_version") == actor.resync_version
        )

    def _record_stop_failure(self, key: MarketStreamKey, detail: str) -> None:
        self._metrics["last_physical_stop_error"] = f"{key.topic}: {detail}"
        logger.warning("Full order-book physical stop failed for %s: %s", key, detail)

    @staticmethod
    def _consume_task_exception(task: asyncio.Task[Any]) -> None:
        if task.cancelled():
            return
        try:
            task.exception()
        except (asyncio.CancelledError, Exception):
            return

    def _validate_key(self, key: MarketStreamKey) -> MarketStreamKey:
        if not isinstance(key, MarketStreamKey):
            raise TypeError("full order-book key must be a MarketStreamKey")
        if key.channel is not MarketChannel.FULL_DEPTH:
            raise ValueError("full order-book service only accepts full_depth keys")
        params = dict(key.params)
        if frozenset(params) != _REQUIRED_PARAMS:
            raise ValueError(
                "full order-book key requires exactly mode, snapshot_limit, "
                "and update_interval_ms params",
            )
        if params["mode"] != "full":
            raise ValueError("full order-book mode must be canonical 'full'")
        snapshot_limit = _canonical_positive_int(
            params["snapshot_limit"],
            "snapshot_limit",
        )
        if snapshot_limit != self._snapshot_limit:
            raise ValueError(f"snapshot_limit must be {self._snapshot_limit}")
        update_interval_ms = _canonical_positive_int(
            params["update_interval_ms"],
            "update_interval_ms",
        )
        if key.exchange == "binance":
            allowed_intervals = _BINANCE_UPDATE_INTERVALS_MS.get(key.market_type)
            if allowed_intervals is None:
                raise ValueError(
                    "Binance Full Order Book requires market_type to be "
                    "'spot' or 'futures'",
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
            raise RuntimeError("full order-book service is closed")

    def _ensure_readable(self) -> None:
        if self._closing or self._closed:
            raise RuntimeError("full order-book service is closed")


def _engine_identity(key: MarketStreamKey) -> FullOrderBookIdentity:
    params = dict(key.params)
    return (
        key.exchange,
        key.market_type,
        key.symbol,
        int(params["update_interval_ms"]),
    )


def _descriptor(key: MarketStreamKey) -> StreamDescriptor:
    params = dict(key.params)
    return StreamDescriptor(
        symbol=key.symbol,
        stream_type=StreamType.FULL_DEPTH,
        update_interval_ms=int(params["update_interval_ms"]),
        exchange=key.exchange,
        market_type=key.market_type,
    )


def _consumer_id(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("consumer_id cannot be blank")
    return value.strip()


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"{label} must be a positive integer")
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"{label} must be a positive integer") from exc
    if parsed <= 0 or str(parsed) != str(value).strip():
        raise ValueError(f"{label} must be a canonical positive integer")
    return parsed


def _canonical_positive_int(value: str, label: str) -> int:
    parsed = _positive_int(value, label)
    if str(parsed) != value:
        raise ValueError(f"{label} must be a canonical positive integer")
    return parsed


def _positive_float(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"{label} must be positive")
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"{label} must be positive") from exc
    if not 0 < parsed < float("inf"):
        raise ValueError(f"{label} must be finite and positive")
    return parsed


def _non_negative_float(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"{label} must be non-negative")
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"{label} must be non-negative") from exc
    if not 0 <= parsed < float("inf"):
        raise ValueError(f"{label} must be finite and non-negative")
    return parsed


__all__ = ["FullOrderBookAttachment", "FullOrderBookService"]
