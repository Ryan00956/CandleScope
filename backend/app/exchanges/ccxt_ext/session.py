"""L2 session adapter for a shared CCXT Pro exchange instance."""

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

from .models import CcxtLifecycleEvent, CcxtRawMarketEvent
from .profile import CcxtExchangeProfile
from .runtime import CcxtRuntime, CcxtRuntimePool, get_shared_ccxt_runtime_pool

logger = logging.getLogger("ingestion.ccxt.session")


class CcxtRawQueueOverflow(RuntimeError):
    """Raised instead of silently dropping an intercepted exchange payload."""


class CcxtProviderSession:
    """A lightweight per-descriptor session over a pooled CCXT connection."""

    def __init__(
        self,
        *,
        config: IngestionConfig,
        descriptor: StreamDescriptor,
        profile: CcxtExchangeProfile,
        pool: CcxtRuntimePool | None = None,
    ) -> None:
        self._cfg = config
        self._descriptor = descriptor
        self._profile = profile
        self._pool = pool or get_shared_ccxt_runtime_pool()
        self._metrics = LayerMetrics("L2_CcxtProvider")
        self._health = SessionHealth.DISCONNECTED
        self._on_message: MessageCallback | None = None
        self._on_health_change: HealthCallback | None = None
        self._runtime: CcxtRuntime | None = None
        self._subscription_token: str | None = None
        self._ccxt_symbol: str | None = None
        self._result_projector: Any | None = None
        self._queue: asyncio.Queue[CcxtRawMarketEvent] = asyncio.Queue(
            maxsize=max(1, int(config.ccxt_raw_queue_size)),
        )
        self._overflowed = False
        self._running = False
        self._watch_task: asyncio.Task[None] | None = None
        self._delivery_task: asyncio.Task[None] | None = None
        self._consecutive_failures = 0
        self._last_message_time = 0.0
        self._last_lifecycle: CcxtLifecycleEvent | None = None

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
        if self._descriptor.stream_type == StreamType.FULL_DEPTH:
            return frozenset()
        return frozenset({SessionHealth.UNHEALTHY})

    def on_message(self, callback: MessageCallback) -> None:
        self._on_message = callback

    def on_health_change(self, callback: HealthCallback) -> None:
        self._on_health_change = callback

    async def start(self) -> None:
        if self._running:
            return
        if not self._profile.supports(self._descriptor):
            raise ValueError(f"CCXT profile does not support {self._descriptor.key}")
        self._running = True
        await self._set_health(SessionHealth.CONNECTING, "CCXT runtime starting")
        self._delivery_task = asyncio.create_task(
            self._delivery_loop(),
            name=f"ccxt_delivery_{self._descriptor.key}",
        )
        self._watch_task = asyncio.create_task(
            self._watch_loop(),
            name=f"ccxt_watch_{self._descriptor.key}",
        )

    async def stop(self) -> None:
        self._running = False
        current = asyncio.current_task()
        tasks = [self._watch_task, self._delivery_task]
        self._watch_task = None
        self._delivery_task = None
        for task in tasks:
            if task is not None and task is not current and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in tasks if task is not None and task is not current),
            return_exceptions=True,
        )
        await self._detach_runtime()
        await self._set_health(SessionHealth.DISCONNECTED, "stopped")

    def snapshot(self) -> dict[str, Any]:
        return {
            "layer": "L2_CcxtProvider",
            "stream_key": self._descriptor.key,
            "provider": "ccxt",
            "health": self._health.value,
            "ccxt_symbol": self._ccxt_symbol,
            "queue_size": self._queue.qsize(),
            "queue_capacity": self._queue.maxsize,
            "overflowed": self._overflowed,
            "consecutive_failures": self._consecutive_failures,
            "last_message_time": self._last_message_time,
            "last_lifecycle": (
                self._last_lifecycle.state if self._last_lifecycle else None
            ),
            "runtime": self._runtime.snapshot() if self._runtime else None,
            "metrics": self._metrics.snapshot(),
        }

    def _enqueue_raw(self, event: CcxtRawMarketEvent) -> None:
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            self._overflowed = True
            self._metrics.inc("raw_queue_overflows")

    def _observe_lifecycle(self, event: CcxtLifecycleEvent) -> None:
        self._last_lifecycle = event
        self._metrics.inc(f"lifecycle_{event.state}")

    async def _watch_loop(self) -> None:
        delay = float(self._cfg.ws_reconnect_delay_initial)
        while self._running:
            watch_generation: int | None = None
            try:
                if self._overflowed:
                    raise CcxtRawQueueOverflow(
                        f"raw queue overflow for {self._descriptor.key}"
                    )
                if self._runtime is None:
                    await self._attach_runtime()
                assert self._runtime is not None
                assert self._ccxt_symbol is not None
                watch_generation = self._runtime.websocket_generation
                result = await asyncio.wait_for(
                    self._runtime.watch(self._descriptor, self._ccxt_symbol),
                    timeout=float(self._cfg.ws_stale_timeout),
                )
                if self._result_projector is not None:
                    for event in self._result_projector.project(result):
                        self._enqueue_raw(event)
                if self._overflowed:
                    raise CcxtRawQueueOverflow(
                        f"raw queue overflow for {self._descriptor.key}"
                    )
                self._consecutive_failures = 0
                delay = float(self._cfg.ws_reconnect_delay_initial)
                await self._set_health(SessionHealth.CONNECTED, "CCXT stream active")
                self._metrics.inc("watch_updates")
            except asyncio.CancelledError as exc:
                # CCXT cancels its per-subscription Future when a websocket is
                # recycled.  That cancellation must enter the reconnect path;
                # only cancellation of this watch task itself means shutdown.
                current = asyncio.current_task()
                if not self._running or (current is not None and current.cancelling()):
                    break
                self._consecutive_failures += 1
                self._metrics.inc("watch_cancellations")
                self._metrics.inc("watch_failures")
                self._metrics.mark("last_failure_at")
                await self._set_health(
                    SessionHealth.RECONNECTING,
                    "CCXT subscription cancelled during websocket recycle",
                )
                logger.warning(
                    "CCXT stream subscription cancelled; reconnecting (%s): %s",
                    self._descriptor.key,
                    exc,
                )
                await self._rebuild_runtime_after_failure(watch_generation)
                await asyncio.sleep(min(delay, self._cfg.ws_reconnect_delay_max))
                delay = min(delay * 2, self._cfg.ws_reconnect_delay_max)
            except Exception as exc:  # noqa: BLE001 - CCXT exchange/network errors
                self._consecutive_failures += 1
                self._metrics.inc("watch_failures")
                self._metrics.mark("last_failure_at")
                health = (
                    SessionHealth.UNHEALTHY
                    if self._overflowed
                    or self._consecutive_failures
                    >= self._cfg.ws_consecutive_failure_threshold
                    else SessionHealth.RECONNECTING
                )
                await self._set_health(health, str(exc)[:256])
                logger.warning("CCXT stream failed (%s): %s", self._descriptor.key, exc)
                if self._overflowed or not self._running:
                    break
                await self._rebuild_runtime_after_failure(watch_generation)
                await asyncio.sleep(min(delay, self._cfg.ws_reconnect_delay_max))
                delay = min(delay * 2, self._cfg.ws_reconnect_delay_max)

    async def _rebuild_runtime_after_failure(
        self,
        expected_generation: int | None,
    ) -> None:
        runtime = self._runtime
        if runtime is None or expected_generation is None:
            return
        self._metrics.inc("runtime_rebuild_requests")
        try:
            rebuilt = await runtime.rebuild_if_generation(expected_generation)
        except Exception as exc:  # noqa: BLE001 - retry loop must remain supervised
            self._metrics.inc("runtime_rebuild_failures")
            logger.warning(
                "CCXT runtime rebuild failed (%s): %s",
                self._descriptor.key,
                exc,
            )
            return
        if rebuilt:
            self._metrics.inc("runtime_rebuilds")

    async def _attach_runtime(self) -> None:
        runtime = await self._pool.acquire(self._profile, self._cfg)
        try:
            ccxt_symbol = runtime.resolve_symbol(self._descriptor)
            token = runtime.subscribe(
                self._descriptor,
                self._enqueue_raw,
                self._observe_lifecycle,
            )
            projector_factory = getattr(self._profile, "make_projector", None)
            projector = (
                projector_factory(self._descriptor)
                if callable(projector_factory)
                else None
            )
        except BaseException:
            await self._pool.release(runtime)
            raise
        self._runtime = runtime
        self._ccxt_symbol = ccxt_symbol
        self._subscription_token = token
        self._result_projector = projector

    async def _detach_runtime(self) -> None:
        runtime = self._runtime
        token = self._subscription_token
        self._runtime = None
        self._subscription_token = None
        self._ccxt_symbol = None
        self._result_projector = None
        if runtime is not None and token is not None:
            runtime.unsubscribe(token)
        if runtime is not None:
            await self._pool.release(runtime)

    async def _delivery_loop(self) -> None:
        while self._running:
            try:
                event = await self._queue.get()
            except asyncio.CancelledError:
                break
            message = RawMessage(
                payload=event.payload,
                source=DataSource.WEBSOCKET,
                stream_type=self._descriptor.stream_type,
                received_at_ms=event.received_at_ms,
                endpoint="ccxt+ws://" + self._profile.exchange_id,
            )
            if self._on_message is not None:
                await self._on_message(message)
            self._last_message_time = time.monotonic()
            self._metrics.inc("events_forwarded")
            self._queue.task_done()

    async def _set_health(self, health: SessionHealth, reason: str) -> None:
        if health == self._health:
            return
        self._health = health
        self._metrics.set("health", health.value)
        self._metrics.mark("health_changed_at")
        if self._on_health_change is not None:
            await self._on_health_change(health, reason)
