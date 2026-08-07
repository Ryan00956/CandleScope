"""Alert action dispatching boundary."""
from __future__ import annotations

import logging
from typing import Any, Protocol

logger = logging.getLogger("candlescope.alerts.dispatcher")


class AlertActionChannel(Protocol):
    action_type: str

    async def dispatch(self, event: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        ...


class AlertActionDispatcher:
    """Route triggered alert events to optional delivery adapters."""

    def __init__(self) -> None:
        self._channels: dict[str, AlertActionChannel] = {}

    def register(self, channel: AlertActionChannel) -> None:
        self._channels[channel.action_type] = channel

    @property
    def registered_types(self) -> list[str]:
        return sorted(self._channels)

    async def dispatch(self, event: dict[str, Any], actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        outcomes: list[dict[str, Any]] = []
        for action in actions:
            if not action.get("enabled", True):
                outcomes.append({"type": action.get("type"), "status": "skipped", "reason": "disabled"})
                continue

            action_type = str(action.get("type") or "")
            channel = self._channels.get(action_type)
            if channel is None:
                outcomes.append({"type": action_type, "status": "unsupported", "reason": "channel_not_registered"})
                continue

            try:
                result = await channel.dispatch(event, action)
            except Exception as exc:
                logger.exception("Alert action failed: type=%s event=%s", action_type, event.get("id"))
                result = {"type": action_type, "status": "error", "error": str(exc)}
            outcomes.append(result)
        return outcomes
