"""JSON-backed storage for alert rules and trigger history."""
from __future__ import annotations

import json
import math
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from app.alerts.models import DELIVERABLE_ACTION_TYPES, VALID_ACTION_TYPES, VALID_TRIGGER_ON
from app.alerts.validation import normalize_after_trigger, validate_alert_expression
from app.alerts.webhook import WebhookSettings, validate_webhook_action_config
from app.core.config import DATA_DIR


def _finite_values(value: Any) -> Any:
    """Represent unavailable numeric observations consistently in JSON and delivery."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _finite_values(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite_values(item) for item in value]
    return value


class AlertStore:
    """Small local-first alert store with atomic writes."""

    _LIFECYCLE_FIELDS = (
        "target",
        "triggerOn",
        "expression",
        "cooldownMs",
        "expiresAt",
        "maxTriggers",
        "afterTrigger",
    )

    def __init__(
        self,
        path: Path | None = None,
        *,
        webhook_settings: WebhookSettings | None = None,
    ) -> None:
        self.path = path or (DATA_DIR / "alerts.json")
        self.webhook_settings = webhook_settings or WebhookSettings()
        self.deliverable_action_types = set(DELIVERABLE_ACTION_TYPES)
        if self.webhook_settings.ready:
            self.deliverable_action_types.add("webhook")
        self._lock = threading.RLock()

    def list_rules(self) -> list[dict[str, Any]]:
        with self._lock:
            return sorted(
                self._load()["rules"].values(),
                key=lambda item: item.get("updatedAt", 0),
                reverse=True,
            )

    def get_rule(self, rule_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._load()["rules"].get(rule_id)

    def upsert_rule(self, item: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            rules = data["rules"]
            now = int(time.time() * 1000)
            rule_id = str(item.get("id") or "").strip() or self._new_rule_id()
            existing = rules.get(rule_id, {})

            after_trigger = normalize_after_trigger(
                self._pick(item, existing, "afterTrigger", "auto_disable")
            )
            max_triggers = self._optional_int(
                self._pick(item, existing, "maxTriggers", 1)
            )
            if after_trigger == "keep":
                max_triggers = None
            elif after_trigger == "pause":
                max_triggers = 1

            record = {
                "schemaVersion": int(self._pick(item, existing, "schemaVersion", 1)),
                "id": rule_id,
                "name": str(self._pick(item, existing, "name", "Untitled Alert")).strip(),
                "description": self._pick(item, existing, "description", ""),
                "enabled": bool(self._pick(item, existing, "enabled", True)),
                "target": self._normalize_target(self._pick(item, existing, "target", {})),
                "triggerOn": self._pick(item, existing, "triggerOn", "bar_close"),
                "expression": self._pick(item, existing, "expression", {}),
                "actions": self._normalize_actions(self._pick(item, existing, "actions", [])),
                "cooldownMs": max(0, int(self._pick(item, existing, "cooldownMs", 30_000) or 0)),
                "expiresAt": self._optional_int(self._pick(item, existing, "expiresAt", None)),
                "maxTriggers": max_triggers,
                "afterTrigger": after_trigger,
                "tags": self._normalize_tags(self._pick(item, existing, "tags", [])),
                "triggerCount": int(
                    existing.get("triggerCount", item.get("triggerCount", 0)) or 0
                ),
                "lastTriggeredAt": existing.get("lastTriggeredAt", item.get("lastTriggeredAt")),
                "createdAt": int(existing.get("createdAt") or item.get("createdAt") or now),
                "updatedAt": now,
            }

            if existing and (
                (record["enabled"] and not bool(existing.get("enabled", True)))
                or self._lifecycle_changed(existing, record)
            ):
                # Enabling a paused/one-shot rule and materially editing a rule
                # both arm a new lifecycle.  Keeping the old count would make
                # the apparently enabled rule permanently ineligible.
                record["triggerCount"] = 0
                record["lastTriggeredAt"] = None

            self._validate_rule(record)
            rules[rule_id] = record
            self._save(data)
            return record

    def set_enabled(self, rule_id: str, enabled: bool) -> dict[str, Any] | None:
        with self._lock:
            data = self._load()
            rule = data["rules"].get(rule_id)
            if rule is None:
                return None
            was_enabled = bool(rule.get("enabled", True))
            rule["enabled"] = bool(enabled)
            if enabled and not was_enabled:
                rule["triggerCount"] = 0
                rule["lastTriggeredAt"] = None
            rule["updatedAt"] = int(time.time() * 1000)
            self._save(data)
            return rule

    def delete_rule(self, rule_id: str) -> bool:
        with self._lock:
            data = self._load()
            if rule_id not in data["rules"]:
                return False
            del data["rules"][rule_id]
            self._save(data)
            return True

    def list_history(
        self,
        *,
        limit: int = 100,
        rule_id: str | None = None,
        since_ms: int | None = None,
        acknowledged: bool | None = None,
    ) -> list[dict[str, Any]]:
        with self._lock:
            items = self._load()["history"]
            if rule_id:
                items = [item for item in items if item.get("ruleId") == rule_id]
            if since_ms is not None:
                items = [item for item in items if int(item.get("createdAt") or 0) >= since_ms]
            if acknowledged is not None:
                items = [
                    item
                    for item in items
                    if (item.get("acknowledgedAt") is not None) is acknowledged
                ]
            return sorted(items, key=lambda item: item.get("createdAt", 0), reverse=True)[:limit]

    def append_history(self, event: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            now = int(time.time() * 1000)
            record = self._history_record(event, now=now)

            data["history"].append(record)
            rule = data["rules"].get(record["ruleId"])
            if rule is not None:
                rule["triggerCount"] = int(rule.get("triggerCount") or 0) + 1
                rule["lastTriggeredAt"] = record["createdAt"]
                rule["updatedAt"] = now
            self._save(data)
            return record

    def append_history_if_eligible(self, event: dict[str, Any]) -> dict[str, Any] | None:
        """Atomically enforce rule state, expiry, count, and cooldown."""
        with self._lock:
            data = self._load()
            rule_id = str(event.get("ruleId") or "").strip()
            rule = data["rules"].get(rule_id)
            if not isinstance(rule, dict) or not bool(rule.get("enabled", True)):
                return None

            now = int(time.time() * 1000)
            created_at = int(event.get("createdAt") or now)
            expires_at = rule.get("expiresAt")
            if expires_at is not None and int(expires_at) <= now:
                rule["enabled"] = False
                rule["updatedAt"] = now
                self._save(data)
                return None

            max_triggers = rule.get("maxTriggers")
            trigger_count = int(rule.get("triggerCount") or 0)
            if max_triggers is not None and trigger_count >= int(max_triggers):
                if rule.get("afterTrigger", "auto_disable") == "auto_disable":
                    rule["enabled"] = False
                    rule["updatedAt"] = now
                    self._save(data)
                return None

            last_triggered_at = rule.get("lastTriggeredAt")
            cooldown_ms = max(0, int(rule.get("cooldownMs") or 0))
            if (
                last_triggered_at is not None
                and cooldown_ms > 0
                and created_at - int(last_triggered_at) < cooldown_ms
            ):
                return None

            record = self._history_record(event, now=now)
            data["history"].append(record)
            trigger_count += 1
            rule["triggerCount"] = trigger_count
            rule["lastTriggeredAt"] = record["createdAt"]
            rule["updatedAt"] = now
            if rule.get("afterTrigger", "auto_disable") == "pause" or (
                rule.get("afterTrigger", "auto_disable") == "auto_disable"
                and max_triggers is not None
                and trigger_count >= int(max_triggers)
            ):
                rule["enabled"] = False
            self._save(data)
            return record

    def update_history_dispatch(
        self,
        event_id: str,
        outcomes: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        with self._lock:
            data = self._load()
            for item in data["history"]:
                if item.get("id") == event_id:
                    item["dispatch"] = outcomes
                    self._save(data)
                    return item
            return None

    def update_dispatch_receipt(
        self,
        event_id: str,
        dispatch_id: str,
        *,
        status: str,
        detail: str = "",
    ) -> dict[str, Any] | None:
        with self._lock:
            data = self._load()
            for item in data["history"]:
                if item.get("id") != event_id:
                    continue
                outcomes = item.get("dispatch") if isinstance(item.get("dispatch"), list) else []
                for outcome in outcomes:
                    if isinstance(outcome, dict) and outcome.get("dispatchId") == dispatch_id:
                        outcome["status"] = str(status or "unknown")
                        outcome["detail"] = str(detail or "")
                        outcome["receiptAt"] = int(time.time() * 1000)
                        self._save(data)
                        return item
                return None
            return None

    def acknowledge_history(self, event_id: str, acknowledged: bool) -> dict[str, Any] | None:
        with self._lock:
            data = self._load()
            for item in data["history"]:
                if item.get("id") == event_id:
                    item["acknowledgedAt"] = int(time.time() * 1000) if acknowledged else None
                    self._save(data)
                    return item
            return None

    @classmethod
    def _history_record(cls, event: dict[str, Any], *, now: int) -> dict[str, Any]:
        event_id = str(event.get("id") or "").strip() or cls._new_event_id()
        record = {
            "id": event_id,
            "ruleId": str(event.get("ruleId") or "").strip(),
            "eventType": event.get("eventType") or "alert.triggered",
            "target": (
                event.get("target") if isinstance(event.get("target"), dict) else {}
            ),
            "message": event.get("message") or "",
            "values": (
                _finite_values(event.get("values"))
                if isinstance(event.get("values"), dict)
                else {}
            ),
            "actions": (
                event.get("actions") if isinstance(event.get("actions"), list) else []
            ),
            "createdAt": int(event.get("createdAt") or now),
            "acknowledgedAt": event.get("acknowledgedAt"),
            "dispatch": (
                event.get("dispatch") if isinstance(event.get("dispatch"), list) else []
            ),
        }
        if not record["ruleId"]:
            raise ValueError("Alert history ruleId is required")
        return record

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"schemaVersion": 1, "rules": {}, "history": []}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f, parse_constant=lambda _: None)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Alert store is corrupt: {self.path}") from exc

        if not isinstance(raw, dict):
            raise ValueError(f"Alert store has invalid format: {self.path}")

        rules_raw = raw.get("rules", {})
        if isinstance(rules_raw, list):
            rules = {
                str(item["id"]): item
                for item in rules_raw
                if isinstance(item, dict) and item.get("id")
            }
        elif isinstance(rules_raw, dict):
            rules = {
                str(key): item
                for key, item in rules_raw.items()
                if isinstance(item, dict)
            }
        else:
            raise ValueError(f"Alert store rules have invalid format: {self.path}")

        history = raw.get("history", [])
        if not isinstance(history, list):
            raise ValueError(f"Alert store history has invalid format: {self.path}")

        return {"schemaVersion": int(raw.get("schemaVersion") or 1), "rules": rules, "history": history}

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": 1,
            "rules": sorted(data["rules"].values(), key=lambda item: item.get("updatedAt", 0), reverse=True),
            "history": sorted(data["history"], key=lambda item: item.get("createdAt", 0), reverse=True)[:5000],
        }
        serialized = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(serialized)
            f.write("\n")
        os.replace(tmp_path, self.path)

    @staticmethod
    def _pick(item: dict[str, Any], existing: dict[str, Any], key: str, default: Any) -> Any:
        if key in item and item[key] is not None:
            return item[key]
        if key in existing:
            return existing[key]
        return default

    @classmethod
    def _lifecycle_changed(
        cls,
        existing: dict[str, Any],
        record: dict[str, Any],
    ) -> bool:
        return any(existing.get(field) != record.get(field) for field in cls._LIFECYCLE_FIELDS)

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        if value is None or value == "":
            return None
        return int(value)

    @staticmethod
    def _normalize_target(value: Any) -> dict[str, str]:
        target = value if isinstance(value, dict) else {}
        market_type = target.get("marketType", target.get("market_type", "spot"))
        return {
            "exchange": str(target.get("exchange") or "binance").strip().lower() or "binance",
            "marketType": str(market_type or "spot").strip().lower() or "spot",
            "symbol": str(target.get("symbol") or "").strip().upper(),
            "interval": str(target.get("interval") or "1m").strip() or "1m",
        }

    @staticmethod
    def _normalize_actions(value: Any) -> list[dict[str, Any]]:
        raw_actions = value if isinstance(value, list) else []
        actions: list[dict[str, Any]] = []
        for item in raw_actions:
            if not isinstance(item, dict):
                continue
            action_type = str(item.get("type") or "in_app").strip()
            actions.append({
                "type": action_type,
                "enabled": bool(item.get("enabled", True)),
                "config": item.get("config") if isinstance(item.get("config"), dict) else {},
            })
        return actions or [{"type": "in_app", "enabled": True, "config": {}}]

    @staticmethod
    def _normalize_tags(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(item).strip() for item in value if str(item).strip()]

    def _validate_rule(self, item: dict[str, Any]) -> None:
        if not item.get("id"):
            raise ValueError("Alert rule id is required")
        if not item.get("name"):
            raise ValueError("Alert rule name is required")
        if item.get("triggerOn") not in VALID_TRIGGER_ON:
            raise ValueError(f"Alert triggerOn must be one of: {', '.join(sorted(VALID_TRIGGER_ON))}")
        target = item.get("target") if isinstance(item.get("target"), dict) else {}
        if not target.get("symbol"):
            raise ValueError("Alert target symbol is required")
        if not isinstance(item.get("expression"), dict) or not item["expression"]:
            raise ValueError("Alert expression must be a non-empty object")
        validate_alert_expression(item["expression"])
        normalize_after_trigger(item.get("afterTrigger"))
        max_triggers = item.get("maxTriggers")
        if max_triggers is not None and int(max_triggers) <= 0:
            raise ValueError("Alert maxTriggers must be positive or null")
        for action in item.get("actions") or []:
            if action.get("type") not in VALID_ACTION_TYPES:
                raise ValueError(f"Unsupported alert action type: {action.get('type')}")
            if action.get("enabled", True) and action.get("type") not in self.deliverable_action_types:
                raise ValueError(f"Alert action channel is not available: {action.get('type')}")
            if action.get("enabled", True) and action.get("type") == "webhook":
                config = action.get("config") if isinstance(action.get("config"), dict) else {}
                validate_webhook_action_config(config, self.webhook_settings)

    @staticmethod
    def _new_rule_id() -> str:
        return f"alert-{uuid.uuid4().hex[:12]}"

    @staticmethod
    def _new_event_id() -> str:
        return f"alert-event-{uuid.uuid4().hex[:12]}"
