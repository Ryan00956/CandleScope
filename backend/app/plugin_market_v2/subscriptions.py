"""Bounded bar subscriptions with reliable final events and forming coalescing."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

from candlescope_plugin_sdk.platform_v2 import (
    MARKET_STREAM_V1,
    BarsSubscribeRequest,
    RequestContext,
)

from app.plugin_security_v2.capabilities import CapabilityLease

from .errors import market_error
from .ports import MarketDataConsumerPort, PortBarSubscription
from .projections import public_bar_rows


MarketBatchDelivery = Callable[
    [str, str, int, tuple[dict[str, Any], ...], dict[str, Any]],
    Any,
]


@dataclass(frozen=True, slots=True)
class _QueuedBar:
    event_type: str
    bar: Any
    emitted_at_ms: int


class _BarSubscription:
    def __init__(
        self,
        *,
        subscription_id: str,
        stream_id: str,
        request: BarsSubscribeRequest,
        lease: CapabilityLease,
        request_context: RequestContext,
        deliver: MarketBatchDelivery,
        on_terminal: Callable[[str, str], None],
    ) -> None:
        self.id = subscription_id
        self.stream_id = stream_id
        self.request = request
        self.lease = lease
        self.request_context = request_context
        self._deliver = deliver
        self._on_terminal = on_terminal
        self._condition = asyncio.Condition()
        self._reliable: deque[_QueuedBar] = deque()
        self._forming: _QueuedBar | None = None
        self._history: deque[dict[str, Any]] = deque(
            maxlen=min(64, request.queue_capacity)
        )
        self._sequence = 0
        self._coalesced = 0
        self._overflow_reason: str | None = None
        self._closing = False
        self._task: asyncio.Task[None] | None = None

    @property
    def current_sequence(self) -> int:
        return self._sequence

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(
                self._run(), name=f"plugin-market-bars:{self.id}"
            )

    async def enqueue(self, event: Any) -> None:
        event_type = str(getattr(getattr(event, "event_type", ""), "value", ""))
        bar = getattr(event, "bar", None)
        if (
            event_type
            not in {
                "bar.created",
                "bar.updated",
                "bar.closed",
                "bar.amended",
            }
            or bar is None
        ):
            return
        queued = _QueuedBar(
            event_type,
            bar,
            int(getattr(event, "timestamp_ms", int(time.time() * 1000))),
        )
        async with self._condition:
            if self._closing or self._overflow_reason is not None:
                return
            forming = event_type in {"bar.created", "bar.updated"} and not bool(
                getattr(bar, "is_closed", False)
            )
            if forming:
                if self._forming is not None:
                    self._coalesced += 1
                self._forming = queued
            else:
                if self._forming is not None and getattr(
                    self._forming.bar, "time", None
                ) == getattr(bar, "time", None):
                    self._forming = None
                    self._coalesced += 1
                if len(self._reliable) >= self.request.queue_capacity:
                    self._overflow_reason = "reliable-queue-overflow"
                else:
                    self._reliable.append(queued)
            self._condition.notify()

    async def _take_batch(self) -> tuple[list[_QueuedBar], int, str | None]:
        deadline = self.request.max_latency_ms / 1_000
        async with self._condition:
            if (
                not self._reliable
                and self._forming is None
                and self._overflow_reason is None
                and not self._closing
            ):
                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=deadline)
                except TimeoutError:
                    pass
            overflow = self._overflow_reason
            if overflow is not None:
                return [], self._coalesced, overflow
            batch: list[_QueuedBar] = []
            while self._reliable and len(batch) < self.request.max_batch:
                batch.append(self._reliable.popleft())
            if self._forming is not None and len(batch) < self.request.max_batch:
                batch.append(self._forming)
                self._forming = None
            coalesced = self._coalesced
            self._coalesced = 0
            return batch, coalesced, None

    def _wire(self, item: _QueuedBar) -> dict[str, Any]:
        self._sequence += 1
        row = public_bar_rows([item.bar])[0]
        return {
            "schemaVersion": MARKET_STREAM_V1,
            "subscriptionId": self.id,
            "streamId": self.stream_id,
            "generation": self.lease.generation,
            "sequence": self._sequence,
            "eventType": item.event_type,
            "context": self.request.context.to_wire(),
            "series": self.request.series.to_wire(),
            "bar": row,
            "emittedAtMs": item.emitted_at_ms,
        }

    async def _run(self) -> None:
        terminal_reason = "closed"
        try:
            while True:
                batch, coalesced, overflow = await self._take_batch()
                if overflow is not None:
                    terminal_reason = overflow
                    await self._deliver(
                        self.lease.plugin_id,
                        self.lease.entrypoint_id,
                        self.lease.generation,
                        (),
                        {
                            "schemaVersion": MARKET_STREAM_V1,
                            "subscriptionId": self.id,
                            "streamId": self.stream_id,
                            "generation": self.lease.generation,
                            "firstSequence": None,
                            "lastSequence": self._sequence,
                            "creditWindow": self.request.queue_capacity,
                            "coalesced": coalesced,
                            "resyncRequired": True,
                            "reason": overflow,
                            "requestContext": RequestContext(
                                contribution_id=self.request_context.contribution_id,
                                user_action=False,
                                generation=self.lease.generation,
                                trace_id=f"market-resync-{self.id}-{self._sequence}",
                            ).to_wire(),
                        },
                    )
                    return
                if batch:
                    events = tuple(self._wire(item) for item in batch)
                    delivery = {
                        "schemaVersion": MARKET_STREAM_V1,
                        "subscriptionId": self.id,
                        "streamId": self.stream_id,
                        "generation": self.lease.generation,
                        "firstSequence": events[0]["sequence"],
                        "lastSequence": events[-1]["sequence"],
                        "creditWindow": self.request.queue_capacity,
                        "coalesced": coalesced,
                        "resyncRequired": False,
                        "requestContext": RequestContext(
                            contribution_id=self.request_context.contribution_id,
                            user_action=False,
                            generation=self.lease.generation,
                            trace_id=(
                                f"market-batch-{self.id}-{events[-1]['sequence']}"
                            ),
                        ).to_wire(),
                    }
                    await self._deliver(
                        self.lease.plugin_id,
                        self.lease.entrypoint_id,
                        self.lease.generation,
                        events,
                        delivery,
                    )
                    self._history.extend(events)
                    continue
                async with self._condition:
                    if self._closing and not self._reliable and self._forming is None:
                        return
        except asyncio.CancelledError:
            terminal_reason = "cancelled"
            raise
        except Exception:
            terminal_reason = "delivery-failed"
        finally:
            self._on_terminal(self.id, terminal_reason)

    async def close(self) -> None:
        async with self._condition:
            self._closing = True
            self._condition.notify_all()
        task = self._task
        if task is None or task is asyncio.current_task():
            return
        try:
            await asyncio.wait_for(task, timeout=1.0)
        except TimeoutError:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def resume(self, last_sequence: int) -> dict[str, Any]:
        if last_sequence > self._sequence:
            raise market_error(
                "MARKET_STREAM_SEQUENCE_INVALID",
                "resume sequence is ahead of the Host stream",
                plugin_id=self.lease.plugin_id,
            )
        if last_sequence == self._sequence:
            return {
                "subscriptionId": self.id,
                "streamId": self.stream_id,
                "generation": self.lease.generation,
                "resumed": True,
                "resyncRequired": False,
                "fromSequence": last_sequence,
                "toSequence": self._sequence,
                "events": [],
            }
        expected = last_sequence + 1
        events = [item for item in self._history if item["sequence"] >= expected]
        contiguous = bool(events) and events[0]["sequence"] == expected
        return {
            "subscriptionId": self.id,
            "streamId": self.stream_id,
            "generation": self.lease.generation,
            "resumed": contiguous,
            "resyncRequired": not contiguous,
            "fromSequence": last_sequence,
            "toSequence": self._sequence,
            "events": events if contiguous else [],
        }

    def summary(self) -> dict[str, Any]:
        return {
            "subscriptionId": self.id,
            "streamId": self.stream_id,
            "pluginId": self.lease.plugin_id,
            "entrypointId": self.lease.entrypoint_id,
            "generation": self.lease.generation,
            "context": self.request.context.to_wire(),
            "series": self.request.series.to_wire(),
            "sequence": self._sequence,
            "reliablePending": len(self._reliable),
            "formingPending": self._forming is not None,
            "coalesced": self._coalesced,
            "resyncRequired": self._overflow_reason is not None,
        }


class BarSubscriptionManager:
    def __init__(self, *, deliver: MarketBatchDelivery) -> None:
        self._deliver = deliver
        self._port: MarketDataConsumerPort | None = None
        self._subscriptions: dict[str, _BarSubscription] = {}
        self._port_subscriptions: dict[str, PortBarSubscription] = {}
        self._lock = asyncio.Lock()
        self._terminal_tasks: set[asyncio.Task[None]] = set()
        self._cleanup_failures = 0
        self._accepting = True
        self._revoked_owners: set[tuple[str, str, str, int]] = set()

    def start(self) -> None:
        self._accepting = True

    def bind(self, port: MarketDataConsumerPort) -> None:
        if self._port is not None and self._port is not port:
            raise RuntimeError("market data port is already bound")
        self._port = port

    def _terminal(self, subscription_id: str, reason: str) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(
            self.cancel_internal(subscription_id, reason=reason),
            name=f"plugin-market-cleanup:{subscription_id}",
        )
        self._terminal_tasks.add(task)
        task.add_done_callback(self._terminal_tasks.discard)

    async def create(
        self,
        request: BarsSubscribeRequest,
        lease: CapabilityLease,
        request_context: RequestContext | None = None,
    ) -> dict[str, Any]:
        port = self._port
        if port is None:
            raise market_error(
                "MARKET_DATA_UNAVAILABLE",
                "market data is not initialized",
                plugin_id=lease.plugin_id,
            )
        maximum = lease.scope.get("maxConcurrent", 1)
        if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1:
            raise market_error(
                "MARKET_SUBSCRIPTION_SCOPE_INVALID",
                "granted maxConcurrent is invalid",
                plugin_id=lease.plugin_id,
            )
        if request_context is None:
            request_context = RequestContext(
                contribution_id=lease.contribution_ids[0],
                user_action=False,
                generation=lease.generation,
                trace_id="market-subscription",
            )
        if (
            request_context.generation != lease.generation
            or request_context.contribution_id not in lease.contribution_ids
        ):
            raise market_error(
                "MARKET_SUBSCRIPTION_CONTEXT_INVALID",
                "bar subscription request context is not bound to the capability lease",
                plugin_id=lease.plugin_id,
            )
        async with self._lock:
            owner = (
                lease.plugin_id,
                lease.entrypoint_id,
                lease.instance_id,
                lease.generation,
            )
            if not self._accepting or owner in self._revoked_owners:
                raise market_error(
                    "MARKET_SUBSCRIPTION_GENERATION_REVOKED",
                    "subscription activation is stopping or revoked",
                    plugin_id=lease.plugin_id,
                )
            active = sum(
                item.lease.plugin_id == lease.plugin_id
                and item.lease.instance_id == lease.instance_id
                and item.lease.generation == lease.generation
                for item in self._subscriptions.values()
            )
            if active >= maximum:
                raise market_error(
                    "MARKET_SUBSCRIPTION_CONCURRENCY_EXCEEDED",
                    "bar subscription concurrency quota is exhausted",
                    plugin_id=lease.plugin_id,
                    details={"maxConcurrent": maximum},
                )
            subscription_id = "msub_" + uuid.uuid4().hex
            stream_id = "mstream_" + uuid.uuid4().hex
            subscription = _BarSubscription(
                subscription_id=subscription_id,
                stream_id=stream_id,
                request=request,
                lease=lease,
                request_context=request_context,
                deliver=self._deliver,
                on_terminal=self._terminal,
            )
            self._subscriptions[subscription_id] = subscription
        consumer_id = (
            f"plugin:{lease.plugin_id}:{lease.entrypoint_id}:"
            f"{lease.instance_id}:{lease.generation}:{subscription_id}"
        )
        try:
            port_subscription = await port.subscribe_bars(
                request,
                consumer_id=consumer_id,
                callback=subscription.enqueue,
            )
        except BaseException:
            async with self._lock:
                self._subscriptions.pop(subscription_id, None)
            raise
        discard = False
        async with self._lock:
            if (
                not self._accepting
                or owner in self._revoked_owners
                or self._subscriptions.get(subscription_id) is not subscription
            ):
                self._subscriptions.pop(subscription_id, None)
                discard = True
            else:
                self._port_subscriptions[subscription_id] = port_subscription
        if discard:
            await subscription.close()
            try:
                await port.unsubscribe_bars(port_subscription)
            except Exception:
                self._cleanup_failures += 1
            raise market_error(
                "MARKET_SUBSCRIPTION_GENERATION_REVOKED",
                "subscription activation was revoked before it became active",
                plugin_id=lease.plugin_id,
            )
        subscription.start()
        return {
            "schemaVersion": MARKET_STREAM_V1,
            "subscriptionId": subscription_id,
            "streamId": stream_id,
            "generation": lease.generation,
            "sequence": 0,
            "creditWindow": request.queue_capacity,
            "delivery": "bounded-canonical-json-batch",
            "formingPolicy": "latest-only-coalesce",
            "reliableEvents": ["bar.closed", "bar.amended"],
            "resume": "retained-window-or-resync",
        }

    @staticmethod
    def _owns(subscription: _BarSubscription, lease: CapabilityLease) -> bool:
        return (
            subscription.lease.plugin_id == lease.plugin_id
            and subscription.lease.entrypoint_id == lease.entrypoint_id
            and subscription.lease.instance_id == lease.instance_id
            and subscription.lease.generation == lease.generation
        )

    async def cancel(
        self, subscription_id: str, lease: CapabilityLease
    ) -> dict[str, Any]:
        async with self._lock:
            subscription = self._subscriptions.get(subscription_id)
            if subscription is None or not self._owns(subscription, lease):
                raise market_error(
                    "MARKET_SUBSCRIPTION_NOT_FOUND",
                    "subscription is unavailable for this activation",
                    plugin_id=lease.plugin_id,
                )
        await self.cancel_internal(subscription_id, reason="plugin-cancel")
        return {"subscriptionId": subscription_id, "cancelled": True}

    async def cancel_internal(self, subscription_id: str, *, reason: str) -> None:
        async with self._lock:
            subscription = self._subscriptions.pop(subscription_id, None)
            port_subscription = self._port_subscriptions.pop(subscription_id, None)
        if subscription is None:
            return
        await subscription.close()
        port = self._port
        if port is not None and port_subscription is not None:
            try:
                await port.unsubscribe_bars(port_subscription)
            except Exception:
                self._cleanup_failures += 1

    async def resume(
        self, subscription_id: str, last_sequence: int, lease: CapabilityLease
    ) -> dict[str, Any]:
        async with self._lock:
            subscription = self._subscriptions.get(subscription_id)
            if subscription is None or not self._owns(subscription, lease):
                raise market_error(
                    "MARKET_SUBSCRIPTION_NOT_FOUND",
                    "subscription is unavailable for this activation",
                    plugin_id=lease.plugin_id,
                )
            return subscription.resume(last_sequence)

    async def cancel_leases(
        self, leases: tuple[CapabilityLease, ...], *, reason: str
    ) -> None:
        owners = {
            (item.plugin_id, item.entrypoint_id, item.instance_id, item.generation)
            for item in leases
        }
        async with self._lock:
            self._revoked_owners.update(owners)
            ids = [
                item.id
                for item in self._subscriptions.values()
                if (
                    item.lease.plugin_id,
                    item.lease.entrypoint_id,
                    item.lease.instance_id,
                    item.lease.generation,
                )
                in owners
            ]
        await asyncio.gather(
            *(self.cancel_internal(item, reason=reason) for item in ids),
            return_exceptions=True,
        )

    async def cancel_plugin(self, plugin_id: str, *, reason: str) -> None:
        async with self._lock:
            ids = [
                item.id
                for item in self._subscriptions.values()
                if item.lease.plugin_id == plugin_id
            ]
        await asyncio.gather(
            *(self.cancel_internal(item, reason=reason) for item in ids),
            return_exceptions=True,
        )

    async def stop(self) -> None:
        async with self._lock:
            self._accepting = False
            ids = list(self._subscriptions)
        await asyncio.gather(
            *(self.cancel_internal(item, reason="platform-stop") for item in ids),
            return_exceptions=True,
        )
        if self._terminal_tasks:
            await asyncio.gather(*tuple(self._terminal_tasks), return_exceptions=True)

    def snapshot(self) -> dict[str, Any]:
        return {
            "active": len(self._subscriptions),
            "cleanupFailures": self._cleanup_failures,
            "subscriptions": [
                item.summary()
                for item in sorted(
                    self._subscriptions.values(), key=lambda value: value.id
                )
            ],
        }


__all__ = ["BarSubscriptionManager", "MarketBatchDelivery"]
