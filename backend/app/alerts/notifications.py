"""Bounded in-process delivery bridge for browser-owned alert actions."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class AlertNotificationSubscription:
    id: str
    queue: asyncio.Queue[dict[str, Any]]


class AlertNotificationBroker:
    """Fan triggered client actions out to active SSE consumers."""

    def __init__(self, *, queue_size: int = 64) -> None:
        if queue_size <= 0:
            raise ValueError("alert notification queue_size must be positive")
        self.queue_size = queue_size
        self._subscribers: dict[str, asyncio.Queue[dict[str, Any]]] = {}
        self._published = 0
        self._dropped = 0

    def subscribe(self) -> AlertNotificationSubscription:
        subscription_id = f"alert-client-{uuid.uuid4().hex[:12]}"
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self.queue_size)
        self._subscribers[subscription_id] = queue
        return AlertNotificationSubscription(subscription_id, queue)

    def unsubscribe(self, subscription: AlertNotificationSubscription) -> None:
        self._subscribers.pop(subscription.id, None)

    def publish(self, payload: dict[str, Any]) -> int:
        delivered = 0
        for queue in list(self._subscribers.values()):
            if queue.full():
                try:
                    queue.get_nowait()
                    self._dropped += 1
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(dict(payload))
                delivered += 1
            except asyncio.QueueFull:
                self._dropped += 1
        self._published += 1
        return delivered

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def snapshot(self) -> dict[str, Any]:
        return {
            "subscribers": len(self._subscribers),
            "queueSize": self.queue_size,
            "published": self._published,
            "dropped": self._dropped,
        }


class BrowserOwnedAlertChannel:
    """Publish actions that must execute in a connected browser window."""

    def __init__(self, action_type: str, broker: AlertNotificationBroker) -> None:
        self.action_type = action_type
        self.broker = broker

    async def dispatch(self, event: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        dispatch_id = f"dispatch-{uuid.uuid4().hex[:16]}"
        payload = {
            "schemaVersion": 1,
            "dispatchId": dispatch_id,
            "eventId": str(event.get("id") or ""),
            "ruleId": str(event.get("ruleId") or ""),
            "action": {
                "type": self.action_type,
                "config": action.get("config") if isinstance(action.get("config"), dict) else {},
            },
            "message": str(event.get("message") or ""),
            "target": event.get("target") if isinstance(event.get("target"), dict) else {},
            "values": event.get("values") if isinstance(event.get("values"), dict) else {},
            "createdAt": int(event.get("createdAt") or time.time() * 1000),
        }
        subscriber_count = self.broker.subscriber_count
        if subscriber_count == 0:
            return {
                "type": self.action_type,
                "status": "unavailable",
                "reason": "no_active_clients",
                "dispatchId": dispatch_id,
                "subscriberCount": 0,
            }
        # Defer publication until AlertFacade has persisted this dispatchId.
        # A client can otherwise race its delivery receipt against history.
        asyncio.get_running_loop().call_soon(self.broker.publish, payload)
        return {
            "type": self.action_type,
            "status": "published",
            "dispatchId": dispatch_id,
            "subscriberCount": subscriber_count,
        }
