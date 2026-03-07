"""
L6: Delivery Layer — the consumer-facing interface of the ingestion pipeline.

Responsibilities:
  * Accept ``MarketEvent`` / ``GapMarker`` from L5 Continuity
  * Wrap them in ``IngestionEvent`` envelopes
  * Distribute to multiple subscribers via:
      - Async queue (``subscribe()`` → ``AsyncIterator``)
      - Callback registration (``on_market_event()`` / ``on_gap()`` / ``on_event()``)
  * Bounded queue per subscriber to prevent backpressure from stalling the pipeline
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
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable, Awaitable, AsyncIterator

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import StreamDescriptor, MarketEvent, GapMarker, IngestionEvent

logger = logging.getLogger("ingestion.L6_Delivery")


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

        # Subscriber queues (for async-iterator consumers)
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
        """Register a callback for market events."""
        self._market_event_callbacks.append(callback)

    def on_gap(self, callback: Callable[[GapMarker], Awaitable[None]]) -> None:
        """Register a callback for gap markers."""
        self._gap_callbacks.append(callback)

    def on_event(self, callback: Callable[[IngestionEvent], Awaitable[None]]) -> None:
        """Register a callback for all events (market_event, gap, status)."""
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

    async def subscribe(self) -> AsyncIterator[IngestionEvent]:
        """Subscribe as an async iterator.  Yields ``IngestionEvent``.

        Usage::

            async for event in delivery.subscribe():
                ...

        Break out of the loop to stop.
        """
        queue: asyncio.Queue[IngestionEvent | None] = asyncio.Queue(
            maxsize=self._cfg.delivery_queue_size,
        )
        self._subscriber_queues.append(queue)
        self._metrics.inc("subscribers_total")
        self._metrics.set("active_subscribers", len(self._subscriber_queues))
        logger.debug("New subscriber (total=%d)", len(self._subscriber_queues))

        try:
            while True:
                event = await queue.get()
                if event is None:
                    # Sentinel — unsubscribe
                    break
                yield event
        finally:
            self._subscriber_queues = [q for q in self._subscriber_queues if q is not queue]
            self._metrics.set("active_subscribers", len(self._subscriber_queues))
            logger.debug("Subscriber removed (remaining=%d)", len(self._subscriber_queues))

    async def close_all_subscribers(self) -> None:
        """Send sentinel to all subscriber queues to unblock them."""
        for queue in list(self._subscriber_queues):
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self._subscriber_queues.clear()
        self._metrics.set("active_subscribers", 0)

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
