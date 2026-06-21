"""JSON-backed storage for alert rules and trigger history."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from app.alerts.models import VALID_ACTION_TYPES, VALID_TRIGGER_ON
from app.core.config import DATA_DIR


class AlertStore:
    """Small local-first alert store with atomic writes."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (DATA_DIR / "alerts.json")
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
                "maxTriggers": self._optional_int(self._pick(item, existing, "maxTriggers", 1)),
                "tags": self._normalize_tags(self._pick(item, existing, "tags", [])),
                "triggerCount": int(existing.get("triggerCount") or item.get("triggerCount") or 0),
                "lastTriggeredAt": existing.get("lastTriggeredAt") or item.get("lastTriggeredAt"),
                "createdAt": int(existing.get("createdAt") or item.get("createdAt") or now),
                "updatedAt": now,
            }

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
            rule["enabled"] = bool(enabled)
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

    def list_history(self, *, limit: int = 100, rule_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            items = self._load()["history"]
            if rule_id:
                items = [item for item in items if item.get("ruleId") == rule_id]
            return sorted(items, key=lambda item: item.get("createdAt", 0), reverse=True)[:limit]

    def append_history(self, event: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            now = int(time.time() * 1000)
            event_id = str(event.get("id") or "").strip() or self._new_event_id()
            record = {
                "id": event_id,
                "ruleId": str(event.get("ruleId") or "").strip(),
                "eventType": event.get("eventType") or "alert.triggered",
                "target": event.get("target") if isinstance(event.get("target"), dict) else {},
                "message": event.get("message") or "",
                "values": event.get("values") if isinstance(event.get("values"), dict) else {},
                "actions": event.get("actions") if isinstance(event.get("actions"), list) else [],
                "createdAt": int(event.get("createdAt") or now),
                "acknowledgedAt": event.get("acknowledgedAt"),
            }
            if not record["ruleId"]:
                raise ValueError("Alert history ruleId is required")

            data["history"].append(record)
            rule = data["rules"].get(record["ruleId"])
            if rule is not None:
                rule["triggerCount"] = int(rule.get("triggerCount") or 0) + 1
                rule["lastTriggeredAt"] = record["createdAt"]
                rule["updatedAt"] = now
            self._save(data)
            return record

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"schemaVersion": 1, "rules": {}, "history": []}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
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
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_path, self.path)

    @staticmethod
    def _pick(item: dict[str, Any], existing: dict[str, Any], key: str, default: Any) -> Any:
        if key in item and item[key] is not None:
            return item[key]
        if key in existing:
            return existing[key]
        return default

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

    @staticmethod
    def _validate_rule(item: dict[str, Any]) -> None:
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
        for action in item.get("actions") or []:
            if action.get("type") not in VALID_ACTION_TYPES:
                raise ValueError(f"Unsupported alert action type: {action.get('type')}")

    @staticmethod
    def _new_rule_id() -> str:
        return f"alert-{uuid.uuid4().hex[:12]}"

    @staticmethod
    def _new_event_id() -> str:
        return f"alert-event-{uuid.uuid4().hex[:12]}"
