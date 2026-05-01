"""
L6: Delivery Layer — the consumer-facing interface of the ingestion pipeline.

Responsibilities:
  * Accept ``MarketEvent`` / ``GapMarker`` from L5 Continuity
  * Wrap them in ``IngestionEvent`` envelopes
  * Distribute to multiple subscribers via:
      - Ordered callback registration for the core path
      - Bounded async queues for non-core consumers
  * Bounded queue per subscriber to prevent slow consumers from stalling the pipeline
  * Emit status events (feed-mode changes, etc.)

This layer outputs a **stable event stream** similar to a WebSocket feed.
Downstream consumers (kline aggregator, storage, UI, etc.) subscribe here.

Usage::

    delivery = DeliveryLayer(config, descriptor)

    # Callback style
    delivery.on_market_event(my_handler)
    delivery.on_gap(my_gap_handler)

    # Or async-iterator style
    async for event in delivery.subscribe():
        if event.event_type == "market_event":
            process(event.market_event)

Ordered callbacks are awaited and can backpressure the ingestion path. Queue
subscribers are non-blocking; when a queue is full, the new event is dropped
for that subscriber.
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator, Awaitable, Callable

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import StreamDescriptor, MarketEvent, GapMarker, IngestionEvent

logger = logging.getLogger("ingestion.L6_Delivery")


class DeliveryQueueSubscriber:
    """Bounded queue subscriber for non-core consumers."""

    def __init__(
        self,
        layer: "DeliveryLayer",
        queue: asyncio.Queue[IngestionEvent | None],
    ) -> None:
        self._layer = layer
        self._queue = queue
        self._closed = False

    @property
    def queue_size(self) -> int:
        return self._queue.qsize()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._layer._remove_queue(self._queue)
        self._layer._send_sentinel(self._queue)

    def __aiter__(self) -> AsyncIterator[IngestionEvent]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[IngestionEvent]:
        try:
            while True:
                event = await self._queue.get()
                if event is None:
                    break
                yield event
        finally:
            await self.close()


class DeliveryLayer:
    """Fan-out delivery to multiple consumers."""

    def __init__(self, config: IngestionConfig, descriptor: StreamDescriptor) -> None:
        self._cfg = config
        self._descriptor = descriptor
        self._metrics = LayerMetrics("L6_Delivery")

        # Callback registrations
        self._market_event_callbacks: list[Callable[[MarketEvent], Awaitable[None]]] = []
        self._gap_callbacks: list[Callable[[GapMarker], Awaitable[None]]] = []
        self._event_callbacks: list[Callable[[IngestionEvent], Awaitable[None]]] = []

        # Subscriber queues for non-core async consumers. These are bounded and
        # never block the ordered callback path.
        self._subscriber_queues: list[asyncio.Queue[IngestionEvent | None]] = []

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "layer": "L6_Delivery",
            "stream_key": self._descriptor.key,
            "market_event_callbacks": len(self._market_event_callbacks),
            "gap_callbacks": len(self._gap_callbacks),
            "event_callbacks": len(self._event_callbacks),
            "active_subscribers": len(self._subscriber_queues),
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Callback registration ────────────────────────

    def on_market_event(self, callback: Callable[[MarketEvent], Awaitable[None]]) -> None:
        """Register an ordered callback for market events.

        Ordered callbacks are part of the core ingestion path and are awaited
        before non-core queue subscribers receive the event.
        """
        self._market_event_callbacks.append(callback)

    def on_gap(self, callback: Callable[[GapMarker], Awaitable[None]]) -> None:
        """Register an ordered callback for gap markers."""
        self._gap_callbacks.append(callback)

    def on_event(self, callback: Callable[[IngestionEvent], Awaitable[None]]) -> None:
        """Register an ordered callback for all events."""
        self._event_callbacks.append(callback)

    def remove_market_event_callback(self, callback: Callable) -> None:
        self._market_event_callbacks = [
            cb for cb in self._market_event_callbacks if cb is not callback
        ]

    def remove_gap_callback(self, callback: Callable) -> None:
        self._gap_callbacks = [cb for cb in self._gap_callbacks if cb is not callback]

    def remove_event_callback(self, callback: Callable) -> None:
        self._event_callbacks = [cb for cb in self._event_callbacks if cb is not callback]

    # ── Public: Async-iterator subscription ──────────────────

    def create_queue_subscriber(
        self,
        maxsize: int | None = None,
    ) -> DeliveryQueueSubscriber:
        """Create a bounded queue subscriber for non-core consumers."""
        queue: asyncio.Queue[IngestionEvent | None] = asyncio.Queue(
            maxsize=maxsize if maxsize is not None else self._cfg.delivery_queue_size,
        )
        self._subscriber_queues.append(queue)
        self._metrics.inc("subscribers_total")
        self._metrics.set("active_subscribers", len(self._subscriber_queues))
        logger.debug("New subscriber (total=%d)", len(self._subscriber_queues))
        return DeliveryQueueSubscriber(self, queue)

    async def subscribe(self) -> AsyncIterator[IngestionEvent]:
        """Subscribe as an async iterator.  Yields ``IngestionEvent``.

        Usage::

            async for event in delivery.subscribe():
                ...

        Break out of the loop to stop.
        """
        subscriber = self.create_queue_subscriber()
        async for event in subscriber:
            yield event

    async def close_all_subscribers(self) -> None:
        """Send sentinel to all subscriber queues to unblock them."""
        for queue in list(self._subscriber_queues):
            self._remove_queue(queue)
            self._send_sentinel(queue)

    # ── Public: Ingest (called by L5) ────────────────────────

    async def deliver_event(self, market_event: MarketEvent) -> None:
        """Accept a MarketEvent from L5 and distribute to all consumers."""
        self._metrics.inc("events_delivered")
        self._metrics.mark("last_event_at")

        event = IngestionEvent(event_type="market_event", market_event=market_event)

        # Callbacks
        await self._fire_market_event_callbacks(market_event)
        await self._fire_event_callbacks(event)

        # Queues
        self._enqueue(event)

    async def deliver_gap(self, gap: GapMarker) -> None:
        """Accept a gap marker from L5 and distribute to all consumers."""
        self._metrics.inc("gaps_delivered")
        self._metrics.mark("last_gap_at")

        event = IngestionEvent(event_type="gap", gap=gap)

        # Callbacks
        await self._fire_gap_callbacks(gap)
        await self._fire_event_callbacks(event)

        # Queues
        self._enqueue(event)

    async def deliver_status(self, status: dict) -> None:
        """Emit a status event (e.g. feed-mode change) to all consumers."""
        self._metrics.inc("status_delivered")

        event = IngestionEvent(event_type="status", status=status)
        await self._fire_event_callbacks(event)
        self._enqueue(event)

    # ── Internal: Callback dispatch ──────────────────────────

    async def _fire_market_event_callbacks(self, market_event: MarketEvent) -> None:
        for cb in self._market_event_callbacks:
            try:
                await cb(market_event)
            except Exception as exc:
                self._metrics.inc("callback_errors")
                logger.error("MarketEvent callback error: %s", exc, exc_info=True)

    async def _fire_gap_callbacks(self, gap: GapMarker) -> None:
        for cb in self._gap_callbacks:
            try:
                await cb(gap)
            except Exception as exc:
                self._metrics.inc("callback_errors")
                logger.error("Gap callback error: %s", exc, exc_info=True)

    async def _fire_event_callbacks(self, event: IngestionEvent) -> None:
        for cb in self._event_callbacks:
            try:
                await cb(event)
            except Exception as exc:
                self._metrics.inc("callback_errors")
                logger.error("Event callback error: %s", exc, exc_info=True)

    # ── Internal: Queue dispatch ─────────────────────────────

    def _enqueue(self, event: IngestionEvent) -> None:
        """Push event to all subscriber queues (non-blocking)."""
        for queue in list(self._subscriber_queues):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                self._metrics.inc("queue_drops")
                logger.warning(
                    "Subscriber queue full (size=%d), dropping event",
                    queue.maxsize,
                )

    def _remove_queue(self, queue: asyncio.Queue[IngestionEvent | None]) -> None:
        self._subscriber_queues = [q for q in self._subscriber_queues if q is not queue]
        self._metrics.set("active_subscribers", len(self._subscriber_queues))
        logger.debug("Subscriber removed (remaining=%d)", len(self._subscriber_queues))

    def _send_sentinel(self, queue: asyncio.Queue[IngestionEvent | None]) -> None:
        try:
            queue.put_nowait(None)
            return
        except asyncio.QueueFull:
            self._metrics.inc("queue_close_drops")

        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass

        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            logger.warning("Subscriber queue still full while closing")
