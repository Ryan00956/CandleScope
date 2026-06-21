"""Public facade for alert rule management and event emission."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.alerts.dispatcher import AlertActionDispatcher
from app.alerts.evaluator import AlertEvaluator
from app.alerts.store import AlertStore


class AlertFacade:
    """Stable entrypoint used by API routes and future backend modules."""

    def __init__(
        self,
        *,
        store: AlertStore | None = None,
        dispatcher: AlertActionDispatcher | None = None,
        evaluator: AlertEvaluator | None = None,
        store_path: Path | None = None,
    ) -> None:
        self.store = store or AlertStore(store_path)
        self.dispatcher = dispatcher or AlertActionDispatcher()
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

    def list_history(self, *, limit: int = 100, rule_id: str | None = None) -> list[dict[str, Any]]:
        return self.store.list_history(limit=limit, rule_id=rule_id)

    def evaluate(self, expression: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        return self.evaluator.evaluate_with_trace(expression, context)

    async def emit_triggered(self, event: dict[str, Any]) -> dict[str, Any]:
        """Record an alert event and pass it to registered action channels."""
        record = self.store.append_history(event)
        actions = event.get("actions")
        if not isinstance(actions, list) or not actions:
            rule = self.get_rule(record["ruleId"]) or {}
            actions = rule.get("actions") if isinstance(rule.get("actions"), list) else []
        outcomes = await self.dispatcher.dispatch(record, actions)
        return {**record, "dispatch": outcomes}
