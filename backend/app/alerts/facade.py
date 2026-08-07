"""Public facade for alert rule management and event emission."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.alerts.dispatcher import AlertActionDispatcher
from app.alerts.evaluator import AlertEvaluator
from app.alerts.notifications import AlertNotificationBroker, BrowserOwnedAlertChannel
from app.alerts.store import AlertStore
from app.alerts.validation import validate_alert_expression


class AlertFacade:
    """Stable entrypoint shared by API routes and the realtime runtime."""

    def __init__(
        self,
        *,
        store: AlertStore | None = None,
        dispatcher: AlertActionDispatcher | None = None,
        evaluator: AlertEvaluator | None = None,
        notification_broker: AlertNotificationBroker | None = None,
        store_path: Path | None = None,
    ) -> None:
        self.store = store or AlertStore(store_path)
        self.notification_broker = notification_broker or AlertNotificationBroker()
        self.dispatcher = dispatcher or AlertActionDispatcher()
        if dispatcher is None:
            for action_type in ("in_app", "browser", "sound"):
                self.dispatcher.register(
                    BrowserOwnedAlertChannel(action_type, self.notification_broker)
                )
        self.evaluator = evaluator or AlertEvaluator()

    def list_rules(self) -> list[dict[str, Any]]:
        return self.store.list_rules()

    def get_rule(self, rule_id: str) -> dict[str, Any] | None:
        return self.store.get_rule(rule_id)

    def save_rule(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.store.upsert_rule(payload)

    def set_enabled(self, rule_id: str, enabled: bool) -> dict[str, Any] | None:
        return self.store.set_enabled(rule_id, enabled)

    def delete_rule(self, rule_id: str) -> bool:
        return self.store.delete_rule(rule_id)

    def list_history(
        self,
        *,
        limit: int = 100,
        rule_id: str | None = None,
        since_ms: int | None = None,
        acknowledged: bool | None = None,
    ) -> list[dict[str, Any]]:
        return self.store.list_history(
            limit=limit,
            rule_id=rule_id,
            since_ms=since_ms,
            acknowledged=acknowledged,
        )

    def acknowledge_history(self, event_id: str, acknowledged: bool) -> dict[str, Any] | None:
        return self.store.acknowledge_history(event_id, acknowledged)

    def record_dispatch_receipt(
        self,
        event_id: str,
        dispatch_id: str,
        *,
        status: str,
        detail: str = "",
    ) -> dict[str, Any] | None:
        return self.store.update_dispatch_receipt(
            event_id,
            dispatch_id,
            status=status,
            detail=detail,
        )

    def evaluate(self, expression: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        validate_alert_expression(expression)
        return self.evaluator.evaluate_with_trace(expression, context)

    async def emit_triggered(
        self,
        event: dict[str, Any],
        *,
        enforce_limits: bool = True,
    ) -> dict[str, Any] | None:
        """Record an alert event and pass it to registered action channels."""
        record = (
            self.store.append_history_if_eligible(event)
            if enforce_limits
            else self.store.append_history(event)
        )
        if record is None:
            return None
        actions = event.get("actions")
        if not isinstance(actions, list) or not actions:
            rule = self.get_rule(record["ruleId"]) or {}
            actions = rule.get("actions") if isinstance(rule.get("actions"), list) else []
        outcomes = await self.dispatcher.dispatch(record, actions)
        updated = self.store.update_history_dispatch(record["id"], outcomes)
        return updated or {**record, "dispatch": outcomes}

    def status(self) -> dict[str, Any]:
        return {
            "registeredChannels": self.dispatcher.registered_types,
            "notificationBroker": self.notification_broker.snapshot(),
        }
