"""
Event Bus — topic-based pub/sub for Data Manager events.

The event bus sits at the center of the Data Manager, connecting
producers (ingestion → bar_aggregator, backfill, cache) to consumers
(WebSocket hub, indicator engine, strategy engine, logging, etc.).

Features:
  * **Topic routing** — events are keyed by ``SeriesKey`` (symbol@interval).
    Subscribers can listen to a specific topic or to all topics (wildcard).
  * **Callback delivery** — registered async callbacks are fired sequentially.
  * **Async-iterator delivery** — ``subscribe_iter()`` returns an
    ``AsyncIterator[DataEvent]`` backed by a bounded queue.
  * **Type filtering** — subscribers can filter by ``DataEventType``.
  * **Middleware** — pluggable pre-emit hooks for metrics, logging, etc.

Design constraints:
  * The bus is **in-process only** — no network transport.
  * Callbacks should be fast and non-blocking; heavy work should be
    offloaded to tasks or queues.
  * Queue-based subscribers that fall behind will have events dropped
    (bounded queue with backpressure).

Usage::

    bus = DataEventBus(config)

    # Callback style
    handle = bus.subscribe(
        key=SeriesKey("BTCUSDT", "1m"),
        event_types={DataEventType.BAR_CLOSED},
        callback=my_handler,
    )
    bus.unsubscribe(handle)

    # Async iterator style
    async for event in bus.subscribe_iter(
        key=SeriesKey("BTCUSDT", "1m"),
    ):
        process(event)

    # Wildcard — all events
    handle = bus.subscribe(callback=my_global_handler)

    # Emit an event
    await bus.emit(event)
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, AsyncIterator, Callable, Awaitable

from .config import EventBusConfig
from .models import (
    DataEvent,
    DataEventType,
    EventCallback,
    SeriesKey,
    SubscriptionHandle,
)

logger = logging.getLogger("data_manager.event_bus")

# Type for middleware hooks
MiddlewareHook = Callable[[DataEvent], Awaitable[DataEvent | None]]


class DataEventBus:
    """In-process, topic-based event bus for Data Manager events.

    Central nervous system of the Data Manager — all bar lifecycle
    events, stream events, and system events flow through here.

    Thread-safety: the bus is designed to be used from a single asyncio
    event loop.  ``emit()`` is async and should be awaited.
    """

    def __init__(self, config: EventBusConfig | None = None) -> None:
        self._cfg = config or EventBusConfig()

        # Callback subscriptions: handle.id → SubscriptionHandle
        self._subscriptions: dict[str, SubscriptionHandle] = {}

        # Queue-based subscriptions: handle.id → (queue, handle)
        self._queue_subs: dict[str, tuple[asyncio.Queue[DataEvent | None], SubscriptionHandle]] = {}

        # Middleware chain (pre-emit hooks)
        self._middleware: list[MiddlewareHook] = []

        # Metrics
        self._events_emitted = 0
        self._events_dropped = 0
        self._callback_errors = 0

    # ── Public: Subscription (callback) ──────────────────────

    def subscribe(
        self,
        callback: EventCallback,
        key: SeriesKey | None = None,
        event_types: set[DataEventType] | None = None,
    ) -> SubscriptionHandle:
        """Register a callback to receive events.

        Args:
            callback:    Async function called for each matching event.
            key:         Filter to this (symbol, interval).  None = all.
            event_types: Filter to these event types.  None = all types.

        Returns:
            A ``SubscriptionHandle`` — pass to ``unsubscribe()`` to stop.

        Example::

            async def on_bar_closed(event: DataEvent):
                print(f"Bar closed: {event.bar}")

            handle = bus.subscribe(
                callback=on_bar_closed,
                key=SeriesKey("BTCUSDT", "1m"),
                event_types={DataEventType.BAR_CLOSED},
            )
        """
        handle = SubscriptionHandle(
            key=key,
            event_types=event_types,
            callback=callback,
        )
        self._subscriptions[handle.id] = handle
        logger.debug(
            "Subscription added: id=%s key=%s types=%s",
            handle.id, key, event_types,
        )
        return handle

    def unsubscribe(self, handle: SubscriptionHandle) -> None:
        """Remove a callback subscription."""
        removed = self._subscriptions.pop(handle.id, None)
        if removed:
            logger.debug("Subscription removed: id=%s", handle.id)

        # Also check queue subscriptions
        entry = self._queue_subs.pop(handle.id, None)
        if entry:
            queue, _ = entry
            try:
                queue.put_nowait(None)  # sentinel to unblock iterator
            except asyncio.QueueFull:
                pass
            logger.debug("Queue subscription removed: id=%s", handle.id)

    # ── Public: Subscription (async iterator) ────────────────

    async def subscribe_iter(
        self,
        key: SeriesKey | None = None,
        event_types: set[DataEventType] | None = None,
    ) -> AsyncIterator[DataEvent]:
        """Subscribe as an async iterator.

        Yields ``DataEvent`` objects matching the optional filters.
        Break out of the loop to unsubscribe.

        Usage::

            async for event in bus.subscribe_iter(
                key=SeriesKey("BTCUSDT", "1m"),
                event_types={DataEventType.BAR_CLOSED, DataEventType.BAR_UPDATED},
            ):
                push_to_websocket(event)
        """
        queue: asyncio.Queue[DataEvent | None] = asyncio.Queue(
            maxsize=self._cfg.subscriber_queue_size,
        )
        handle = SubscriptionHandle(
            key=key,
            event_types=event_types,
        )
        self._queue_subs[handle.id] = (queue, handle)
        logger.debug(
            "Iterator subscription added: id=%s key=%s", handle.id, key,
        )

        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        finally:
            self._queue_subs.pop(handle.id, None)
            logger.debug(
                "Iterator subscription removed: id=%s", handle.id,
            )

    # ── Public: Emit ─────────────────────────────────────────

    async def emit(self, event: DataEvent) -> None:
        """Emit an event to all matching subscribers.

        The event flows through the middleware chain first.  If any
        middleware returns ``None``, the event is suppressed.

        Then it is delivered to:
          1. Callback subscribers (sequentially)
          2. Queue subscribers (non-blocking put)
        """
        # Apply config-level filters
        if not self._should_emit(event):
            return

        # Middleware chain
        processed: DataEvent | None = event
        for mw in self._middleware:
            try:
                processed = await mw(processed)
            except Exception as exc:
                logger.error("Middleware error: %s", exc, exc_info=True)
                processed = event  # fall through on error
            if processed is None:
                return  # middleware suppressed the event

        event = processed
        self._events_emitted += 1

        # Callback subscribers
        for handle in list(self._subscriptions.values()):
            if not handle.matches(event):
                continue
            if handle.callback is None:
                continue
            try:
                await handle.callback(event)
            except Exception as exc:
                self._callback_errors += 1
                logger.error(
                    "Event callback error (sub=%s): %s",
                    handle.id, exc, exc_info=True,
                )

        # Queue subscribers
        for sub_id, (queue, handle) in list(self._queue_subs.items()):
            if not handle.matches(event):
                continue
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                self._events_dropped += 1
                logger.warning(
                    "Queue subscriber %s full, dropping event", sub_id,
                )

    async def emit_many(self, events: list[DataEvent]) -> None:
        """Emit multiple events in sequence."""
        for event in events:
            await self.emit(event)

    # ── Public: Middleware ────────────────────────────────────

    def add_middleware(self, hook: MiddlewareHook) -> None:
        """Register a pre-emit middleware hook.

        Middleware runs **before** subscribers receive the event.
        The hook receives a ``DataEvent`` and must return either:
          * The same or modified ``DataEvent`` — continue delivery
          * ``None`` — suppress the event entirely

        Use cases:
          * Logging / metrics
          * Event transformation
          * Rate limiting
          * Access control

        Example::

            async def log_middleware(event: DataEvent) -> DataEvent:
                logger.info("Event: %s %s", event.event_type, event.key)
                return event

            bus.add_middleware(log_middleware)
        """
        self._middleware.append(hook)

    def remove_middleware(self, hook: MiddlewareHook) -> None:
        """Remove a previously registered middleware hook."""
        self._middleware = [m for m in self._middleware if m is not hook]

    # ── Public: Close ────────────────────────────────────────

    async def close(self) -> None:
        """Send sentinel to all queue subscribers and clear everything."""
        for sub_id, (queue, _) in list(self._queue_subs.items()):
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self._queue_subs.clear()
        self._subscriptions.clear()
        logger.info("Event bus closed")

    # ── Public: Introspection ────────────────────────────────

    def get_subscriber_count(self, key: SeriesKey | None = None) -> int:
        """Count active subscribers, optionally filtered by key."""
        count = 0
        for handle in self._subscriptions.values():
            if key is None or handle.key is None or handle.key == key:
                count += 1
        for _, (_, handle) in self._queue_subs.items():
            if key is None or handle.key is None or handle.key == key:
                count += 1
        return count

    def get_all_subscribed_keys(self) -> set[SeriesKey]:
        """Return all SeriesKeys that have at least one subscriber."""
        keys: set[SeriesKey] = set()
        for handle in self._subscriptions.values():
            if handle.key is not None:
                keys.add(handle.key)
        for _, (_, handle) in self._queue_subs.items():
            if handle.key is not None:
                keys.add(handle.key)
        return keys

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        """JSON-serializable diagnostic snapshot."""
        return {
            "callback_subscriptions": len(self._subscriptions),
            "queue_subscriptions": len(self._queue_subs),
            "middleware_count": len(self._middleware),
            "events_emitted": self._events_emitted,
            "events_dropped": self._events_dropped,
            "callback_errors": self._callback_errors,
            "subscribed_keys": [
                str(k) for k in self.get_all_subscribed_keys()
            ],
        }

    # ── Internal ─────────────────────────────────────────────

    def _should_emit(self, event: DataEvent) -> bool:
        """Apply config-level event filters."""
        et = event.event_type
        if et == DataEventType.BAR_UPDATED and not self._cfg.emit_bar_updated:
            return False
        if et == DataEventType.BAR_CREATED and not self._cfg.emit_bar_created:
            return False
        return True
