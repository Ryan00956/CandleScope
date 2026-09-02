from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.metrics import LayerMetrics
from app.data_engine.ingestion.models import (
    DataSource,
    FeedMode,
    RawMessage,
    SessionHealth,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.ingestion.session_types import HealthCallback, MessageCallback
from app.exchanges.rate_limits import RateLimitDeferred

from .runtime import (
    TwelveDataLifecycleEvent,
    TwelveDataRuntime,
    TwelveDataRuntimePool,
    TwelveDataWsEvent,
    get_shared_twelve_data_runtime_pool,
)
from .snapshot import fetch_twelve_data_quote


logger = logging.getLogger("ingestion.twelvedata.session")


class TwelveDataProviderSession:
    """Logical ticker session over the single pooled Twelve Data socket."""

    def __init__(
        self,
        *,
        config: IngestionConfig,
        descriptor: StreamDescriptor,
        pool: TwelveDataRuntimePool | None = None,
    ) -> None:
        self._cfg = config
        self._descriptor = descriptor
        self._pool = pool or get_shared_twelve_data_runtime_pool()
        self._runtime: TwelveDataRuntime | None = None
        self._token: str | None = None
        self._health = SessionHealth.DISCONNECTED
        self._metrics = LayerMetrics("L2_TwelveDataProvider")
        self._on_message: MessageCallback | None = None
        self._on_health_change: HealthCallback | None = None
        self._queue: asyncio.Queue[RawMessage] = asyncio.Queue(
            maxsize=max(1, int(config.twelve_data_ws_queue_size)),
        )
        self._running = False
        self._overflowed = False
        self._delivery_task: asyncio.Task[None] | None = None
        self._snapshot_tasks: dict[int, asyncio.Task[None]] = {}
        self._lifecycle_tasks: set[asyncio.Task[None]] = set()
        self._last_snapshot_generation = 0
        self._last_message_time = 0.0

    @property
    def health(self) -> SessionHealth:
        return self._health

    @property
    def feed_mode(self) -> FeedMode:
        return FeedMode.PLUGIN_STREAM

    @property
    def manages_recovery_while_http(self) -> bool:
        return True

    @property
    def http_fallback_health_states(self) -> frozenset[SessionHealth]:
        return frozenset({SessionHealth.UNHEALTHY})

    def on_message(self, callback: MessageCallback) -> None:
        self._on_message = callback

    def on_health_change(self, callback: HealthCallback) -> None:
        self._on_health_change = callback

    async def start(self) -> None:
        if self._running:
            return
        if self._descriptor.stream_type != StreamType.TICKER:
            raise ValueError("Twelve Data provider stream supports ticker only")
        self._running = True
        await self._set_health(SessionHealth.CONNECTING, "Twelve Data runtime starting")
        self._delivery_task = asyncio.create_task(
            self._delivery_loop(),
            name=f"twelvedata_delivery_{self._descriptor.key}",
        )
        try:
            runtime = await self._pool.acquire(self._cfg)
            # Store the acquired runtime before subscribing so a failed
            # subscribe can still release the pool reference in stop().
            self._runtime = runtime
            token = await runtime.subscribe(
                symbol=self._descriptor.symbol,
                market_type=self._descriptor.market_type,
                raw_callback=self._observe_raw,
                lifecycle_callback=self._observe_lifecycle,
            )
        except BaseException:
            await self.stop()
            raise
        self._token = token

    async def stop(self) -> None:
        self._running = False
        for task in tuple(self._snapshot_tasks.values()):
            if not task.done():
                task.cancel()
        for task in tuple(self._lifecycle_tasks):
            if not task.done():
                task.cancel()
        delivery = self._delivery_task
        self._delivery_task = None
        if delivery is not None and not delivery.done():
            delivery.cancel()
        runtime = self._runtime
        token = self._token
        self._runtime = None
        self._token = None
        if runtime is not None and token is not None:
            await runtime.unsubscribe(token)
        if runtime is not None:
            await self._pool.release(runtime)
        tasks = [
            *self._snapshot_tasks.values(),
            *self._lifecycle_tasks,
            *([delivery] if delivery is not None else []),
        ]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._snapshot_tasks.clear()
        self._lifecycle_tasks.clear()
        await self._set_health(SessionHealth.DISCONNECTED, "stopped")

    def snapshot(self) -> dict[str, Any]:
        return {
            "layer": "L2_TwelveDataProvider",
            "stream_key": self._descriptor.key,
            "provider": "twelvedata",
            "health": self._health.value,
            "queue_size": self._queue.qsize(),
            "queue_capacity": self._queue.maxsize,
            "overflowed": self._overflowed,
            "last_message_time": self._last_message_time,
            "last_snapshot_generation": self._last_snapshot_generation,
            "runtime": self._runtime.snapshot() if self._runtime else None,
            "metrics": self._metrics.snapshot(),
        }

    def _observe_raw(self, event: TwelveDataWsEvent) -> None:
        message = RawMessage(
            payload=event.payload,
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.TICKER,
            received_at_ms=event.received_at_ms,
            endpoint="twelvedata+ws://quotes/price",
        )
        self._enqueue(message)

    def _observe_lifecycle(self, event: TwelveDataLifecycleEvent) -> None:
        if not self._running:
            return
        task = asyncio.create_task(
            self._apply_lifecycle(event),
            name=f"twelvedata_health_{self._descriptor.key}",
        )
        self._lifecycle_tasks.add(task)
        task.add_done_callback(self._lifecycle_tasks.discard)

    async def _apply_lifecycle(self, event: TwelveDataLifecycleEvent) -> None:
        health = {
            "connecting": SessionHealth.CONNECTING,
            "connected": SessionHealth.CONNECTED,
            "reconnecting": SessionHealth.RECONNECTING,
            "unhealthy": SessionHealth.UNHEALTHY,
            "disconnected": SessionHealth.DISCONNECTED,
        }.get(event.state, SessionHealth.RECONNECTING)
        await self._set_health(health, event.reason)
        if (
            event.state == "connected"
            and event.generation > self._last_snapshot_generation
            and event.generation not in self._snapshot_tasks
        ):
            self._last_snapshot_generation = event.generation
            task = asyncio.create_task(
                self._refresh_quote_snapshot(event.generation),
                name=f"twelvedata_quote_{self._descriptor.key}_{event.generation}",
            )
            self._snapshot_tasks[event.generation] = task
            task.add_done_callback(
                lambda _done, generation=event.generation: self._snapshot_tasks.pop(
                    generation,
                    None,
                )
            )

    async def _refresh_quote_snapshot(self, generation: int) -> None:
        while self._running and generation == self._last_snapshot_generation:
            try:
                payload = await fetch_twelve_data_quote(
                    self._cfg,
                    symbol=self._descriptor.symbol,
                    market_type=self._descriptor.market_type,
                )
                break
            except asyncio.CancelledError:
                raise
            except RateLimitDeferred as exc:
                # Eight logical trial subscriptions may reconnect together,
                # while REST shares the Basic API-credit bucket.  Preserve
                # every generation snapshot by pacing it instead of dropping
                # all but the first cold-start request.
                self._metrics.inc("quote_snapshot_deferrals")
                await asyncio.sleep(
                    min(60.0, max(0.05, float(exc.retry_after_seconds)))
                )
            except Exception as exc:
                self._metrics.inc("quote_snapshot_failures")
                logger.warning(
                    "Twelve Data quote snapshot failed (%s, generation=%d): %s",
                    self._descriptor.key,
                    generation,
                    str(exc)[:256],
                )
                return
        else:
            return
        self._metrics.inc("quote_snapshots")
        self._enqueue(RawMessage(
            payload={
                **payload,
                "_twelve_data_snapshot_generation": generation,
            },
            source=DataSource.HTTP,
            stream_type=StreamType.TICKER,
            received_at_ms=int(time.time() * 1000),
            endpoint="twelvedata+https://quote",
        ))

    def _enqueue(self, message: RawMessage) -> None:
        if not self._running:
            return
        try:
            self._queue.put_nowait(message)
        except asyncio.QueueFull:
            self._overflowed = True
            self._metrics.inc("raw_queue_overflows")
            self._observe_lifecycle(TwelveDataLifecycleEvent(
                state="unhealthy",
                reason="Twelve Data raw queue overflow",
                generation=self._last_snapshot_generation,
                consecutive_failures=1,
            ))

    async def _delivery_loop(self) -> None:
        while self._running:
            try:
                message = await self._queue.get()
            except asyncio.CancelledError:
                break
            try:
                if self._on_message is not None:
                    await self._on_message(message)
                self._last_message_time = time.monotonic()
                self._metrics.inc("events_forwarded")
            finally:
                self._queue.task_done()

    async def _set_health(self, health: SessionHealth, reason: str) -> None:
        if health == self._health:
            return
        self._health = health
        self._metrics.set("health", health.value)
        self._metrics.mark("health_changed_at")
        if self._on_health_change is not None:
            await self._on_health_change(health, reason[:256])


__all__ = ["TwelveDataProviderSession"]
