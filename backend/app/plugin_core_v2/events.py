"""Non-blocking delivery of versioned public app events to plugin sidecars."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .contracts import CoreContribution, validate_public_event
from .errors import core_error


EventDelivery = Callable[
    [CoreContribution, tuple[dict[str, Any], ...], dict[str, Any]], Awaitable[None]
]


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class _Subscription:
    contribution: CoreContribution
    callback: EventDelivery
    queue: asyncio.Queue[dict[str, Any]]
    task: asyncio.Task[None] | None = None
    delivered_batches: int = 0
    delivered_events: int = 0
    dropped_total: int = 0
    dropped_pending: int = 0
    failures: int = 0
    last_error: str | None = None
    batch_sequence: int = 0
    stopping: bool = False


class PublicEventHub:
    """One bounded queue per static subscriber; publish never awaits a plugin."""

    def __init__(self) -> None:
        self._subscriptions: dict[str, _Subscription] = {}
        self._event_sequence = 0

    def register(self, contribution: CoreContribution, callback: EventDelivery) -> None:
        if contribution.kind != "event-subscriber/1":
            raise ValueError("only event subscriber contributions can be registered")
        if contribution.full_id in self._subscriptions:
            raise core_error(
                "PLUGIN_EVENT_SUBSCRIPTION_CONFLICT",
                "event subscription is already registered",
                plugin_id=contribution.plugin_id,
            )
        config = contribution.configuration
        subscription = _Subscription(
            contribution,
            callback,
            asyncio.Queue(maxsize=config["queueCapacity"]),
        )
        subscription.task = asyncio.create_task(
            self._run_subscription(subscription),
            name=f"plugin-event:{contribution.full_id}",
        )
        self._subscriptions[contribution.full_id] = subscription

    def publish(self, event_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        normalized = validate_public_event(event_id, payload)
        self._event_sequence += 1
        event = {
            "id": event_id,
            "sequence": self._event_sequence,
            "publishedAt": _utc_now(),
            "payload": normalized,
        }
        matched = 0
        dropped = 0
        for subscription in tuple(self._subscriptions.values()):
            if event_id not in subscription.contribution.configuration["events"]:
                continue
            matched += 1
            if subscription.queue.full():
                try:
                    subscription.queue.get_nowait()
                    subscription.queue.task_done()
                except asyncio.QueueEmpty:
                    pass
                subscription.dropped_total += 1
                subscription.dropped_pending += 1
                dropped += 1
            subscription.queue.put_nowait(dict(event))
        return {
            "eventId": event_id,
            "sequence": self._event_sequence,
            "matchedSubscriptions": matched,
            "dropped": dropped,
        }

    async def _run_subscription(self, subscription: _Subscription) -> None:
        config = subscription.contribution.configuration
        max_batch = config["maxBatch"]
        latency = config["maxLatencyMs"] / 1000.0
        try:
            while not subscription.stopping:
                first = await subscription.queue.get()
                batch = [first]
                deadline = asyncio.get_running_loop().time() + latency
                while len(batch) < max_batch:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        break
                    try:
                        batch.append(
                            await asyncio.wait_for(
                                subscription.queue.get(), timeout=remaining
                            )
                        )
                    except TimeoutError:
                        break
                subscription.batch_sequence += 1
                delivery = {
                    "schemaVersion": 1,
                    "subscriptionId": subscription.contribution.full_id,
                    "batchSequence": subscription.batch_sequence,
                    "firstEventSequence": batch[0]["sequence"],
                    "lastEventSequence": batch[-1]["sequence"],
                    "droppedBeforeBatch": subscription.dropped_pending,
                    "semantics": "bounded-at-most-once",
                }
                subscription.dropped_pending = 0
                try:
                    await subscription.callback(
                        subscription.contribution, tuple(batch), delivery
                    )
                    subscription.delivered_batches += 1
                    subscription.delivered_events += len(batch)
                    subscription.failures = 0
                    subscription.last_error = None
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    subscription.failures += 1
                    subscription.last_error = type(exc).__name__
                    await asyncio.sleep(
                        min(30.0, 0.25 * (2 ** min(subscription.failures, 7)))
                    )
                finally:
                    for _ in batch:
                        subscription.queue.task_done()
        except asyncio.CancelledError:
            raise

    async def unregister_plugin(self, plugin_id: str) -> int:
        selected = [
            key
            for key, subscription in self._subscriptions.items()
            if subscription.contribution.plugin_id == plugin_id
        ]
        await self._unregister(selected)
        return len(selected)

    async def stop(self) -> None:
        await self._unregister(list(self._subscriptions))

    async def _unregister(self, keys: list[str]) -> None:
        tasks: list[asyncio.Task[None]] = []
        for key in keys:
            subscription = self._subscriptions.pop(key, None)
            if subscription is None:
                continue
            subscription.stopping = True
            if subscription.task is not None:
                subscription.task.cancel()
                tasks.append(subscription.task)
            while not subscription.queue.empty():
                try:
                    subscription.queue.get_nowait()
                    subscription.queue.task_done()
                except asyncio.QueueEmpty:
                    break
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def snapshot(self) -> dict[str, Any]:
        return {
            "eventSequence": self._event_sequence,
            "subscriptions": [
                {
                    "id": item.contribution.full_id,
                    "pluginId": item.contribution.plugin_id,
                    "events": list(item.contribution.configuration["events"]),
                    "queued": item.queue.qsize(),
                    "capacity": item.queue.maxsize,
                    "deliveredBatches": item.delivered_batches,
                    "deliveredEvents": item.delivered_events,
                    "dropped": item.dropped_total,
                    "failures": item.failures,
                    "lastError": item.last_error,
                }
                for item in sorted(
                    self._subscriptions.values(),
                    key=lambda value: value.contribution.full_id,
                )
            ],
        }
