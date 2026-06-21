"""Realtime alert runtime wired to DataManager events."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

from app.alerts.facade import AlertFacade
from app.data_engine.data_manager.models import BarData, DataEvent, DataEventType, SubscriptionHandle

logger = logging.getLogger("alerts.runtime")


@dataclass(slots=True)
class _RuleSubscription:
    rule_id: str
    target_key: tuple[str, str, str, str]
    event_types: set[DataEventType]
    consumer_id: str
    handle: SubscriptionHandle


class AlertRuntimeEngine:
    """Keep enabled alert rules subscribed to market data and emit triggers."""

    def __init__(self, *, facade: AlertFacade, data_manager: Any | None = None) -> None:
        self.facade = facade
        self.data_manager = data_manager
        self._started = False
        self._subscriptions: dict[str, _RuleSubscription] = {}
        self._previous_values: dict[str, dict[str, Any]] = {}

    async def start(self) -> None:
        """Subscribe all currently enabled rules."""
        if self._started:
            return
        self._started = True
        await self.sync_rules()

    async def stop(self) -> None:
        """Release all alert-owned subscriptions."""
        for rule_id in list(self._subscriptions):
            await self.remove_rule(rule_id)
        self._started = False

    async def sync_rules(self) -> None:
        """Reconcile runtime subscriptions with persisted rules."""
        if self.data_manager is None:
            return
        rules = self.facade.list_rules()
        seen = {str(rule.get("id")) for rule in rules if rule.get("id")}
        for rule in rules:
            await self.sync_rule(rule)
        for stale_rule_id in list(self._subscriptions):
            if stale_rule_id not in seen:
                await self.remove_rule(stale_rule_id)

    async def sync_rule(self, rule: dict[str, Any] | None) -> None:
        """Start, update, or stop one rule subscription."""
        if not self._started or self.data_manager is None or not isinstance(rule, dict):
            return

        rule_id = str(rule.get("id") or "").strip()
        if not rule_id:
            return
        if not self._is_rule_active(rule):
            await self.remove_rule(rule_id)
            return

        target = self._target(rule)
        if not target["symbol"] or not target["interval"]:
            await self.remove_rule(rule_id)
            return

        target_key = (target["exchange"], target["marketType"], target["symbol"], target["interval"])
        existing = self._subscriptions.get(rule_id)
        event_types = self._event_types_for_rule(rule)
        if existing and existing.target_key == target_key and existing.event_types == event_types:
            return
        if existing:
            await self.remove_rule(rule_id)

        await self._seed_previous_values(rule_id, target)

        async def _on_event(event: DataEvent, *, current_rule_id: str = rule_id) -> None:
            await self.evaluate_event(current_rule_id, event)

        handle = self.data_manager.subscribe(
            callback=_on_event,
            symbol=target["symbol"],
            interval=target["interval"],
            exchange=target["exchange"],
            market_type=target["marketType"],
            event_types=event_types,
        )
        consumer_id = f"alert:rule:{rule_id}"
        await self.data_manager.ensure_stream(
            target["symbol"],
            target["interval"],
            exchange=target["exchange"],
            market_type=target["marketType"],
            focus_scope="background",
            subscription_tier="alerts",
            consumer_id=consumer_id,
        )
        self._subscriptions[rule_id] = _RuleSubscription(
            rule_id=rule_id,
            target_key=target_key,
            event_types=event_types,
            consumer_id=consumer_id,
            handle=handle,
        )
        logger.info("Alert rule subscribed: %s %s", rule_id, target_key)

    async def remove_rule(self, rule_id: str) -> None:
        """Unsubscribe and release one rule's stream lease."""
        sub = self._subscriptions.pop(rule_id, None)
        self._previous_values.pop(rule_id, None)
        if sub is None or self.data_manager is None:
            return

        try:
            self.data_manager.unsubscribe(sub.handle)
        except Exception:
            logger.exception("Failed to unsubscribe alert rule %s", rule_id)

        exchange, market_type, symbol, interval = sub.target_key
        try:
            await self.data_manager.release_stream(
                symbol,
                interval,
                exchange=exchange,
                market_type=market_type,
                focus_scope="background",
                subscription_tier="alerts",
                consumer_id=sub.consumer_id,
            )
        except Exception:
            logger.exception("Failed to release alert stream for rule %s", rule_id)

    async def evaluate_event(self, rule_id: str, event: DataEvent) -> dict[str, Any] | None:
        """Evaluate one DataEvent for a rule and emit history when matched."""
        if event.bar is None:
            return None

        rule = self.facade.get_rule(rule_id)
        if not self._is_rule_active(rule):
            await self.remove_rule(rule_id)
            return None

        target = self._target(rule)
        current = self._bar_values(event.bar)
        previous = (
            self._bar_values(event.previous_bar)
            if event.previous_bar is not None
            else self._previous_values.get(rule_id, {})
        )
        self._previous_values[rule_id] = current

        if not self._can_trigger(rule, now_ms=event.timestamp_ms):
            return None

        evaluation = self.facade.evaluate(
            rule.get("expression") if isinstance(rule, dict) else {},
            {
                "values": current,
                "previous": previous,
                "event": event.to_dict(),
            },
        )
        if not evaluation.get("result"):
            return None

        return await self.facade.emit_triggered({
            "ruleId": rule_id,
            "eventType": "alert.triggered",
            "target": target,
            "message": self._render_message(rule, current, evaluation),
            "values": {
                **current,
                "eventType": event.event_type.value,
                "timestampMs": event.timestamp_ms,
                "previous": previous,
                "trace": evaluation.get("trace"),
            },
            "actions": rule.get("actions") if isinstance(rule.get("actions"), list) else [],
            "createdAt": event.timestamp_ms,
        })

    def snapshot(self) -> dict[str, Any]:
        return {
            "started": self._started,
            "dataManager": self.data_manager is not None,
            "subscriptions": [
                {
                    "ruleId": item.rule_id,
                    "target": {
                        "exchange": item.target_key[0],
                        "marketType": item.target_key[1],
                        "symbol": item.target_key[2],
                        "interval": item.target_key[3],
                    },
                }
                for item in self._subscriptions.values()
            ],
        }

    @staticmethod
    def _target(rule: dict[str, Any] | None) -> dict[str, str]:
        raw = rule.get("target") if isinstance(rule, dict) and isinstance(rule.get("target"), dict) else {}
        return {
            "exchange": str(raw.get("exchange") or "binance").strip().lower() or "binance",
            "marketType": str(raw.get("marketType") or raw.get("market_type") or "spot").strip().lower() or "spot",
            "symbol": str(raw.get("symbol") or "").strip().upper(),
            "interval": str(raw.get("interval") or "1m").strip() or "1m",
        }

    @staticmethod
    def _is_rule_active(rule: dict[str, Any] | None) -> bool:
        if not isinstance(rule, dict) or not rule.get("id"):
            return False
        if not bool(rule.get("enabled", True)):
            return False
        expires_at = rule.get("expiresAt")
        if expires_at is not None and int(expires_at) <= int(time.time() * 1000):
            return False
        return True

    @staticmethod
    def _can_trigger(rule: dict[str, Any], *, now_ms: int) -> bool:
        max_triggers = rule.get("maxTriggers")
        if max_triggers is not None and int(rule.get("triggerCount") or 0) >= int(max_triggers):
            return False

        last_triggered_at = rule.get("lastTriggeredAt")
        cooldown_ms = max(0, int(rule.get("cooldownMs") or 0))
        if last_triggered_at is not None and cooldown_ms > 0:
            return now_ms - int(last_triggered_at) >= cooldown_ms
        return True

    @staticmethod
    def _event_types_for_rule(rule: dict[str, Any]) -> set[DataEventType]:
        trigger_on = str(rule.get("triggerOn") or "bar_close")
        if trigger_on == "bar_close":
            return {DataEventType.BAR_CLOSED}
        if trigger_on == "bar_update":
            return {DataEventType.BAR_UPDATED, DataEventType.BAR_CLOSED, DataEventType.BAR_AMENDED}
        return {
            DataEventType.BAR_CREATED,
            DataEventType.BAR_UPDATED,
            DataEventType.BAR_CLOSED,
            DataEventType.BAR_AMENDED,
        }

    async def _seed_previous_values(self, rule_id: str, target: dict[str, str]) -> None:
        query_latest = getattr(self.data_manager, "query_latest", None)
        if not callable(query_latest):
            return
        try:
            result = query_latest(
                target["symbol"],
                target["interval"],
                limit=1,
                exchange=target["exchange"],
                market_type=target["marketType"],
                auto_backfill=False,
                backfill_reason=None,
                backfill_requester="alert_runtime_seed",
            )
        except TypeError:
            result = query_latest(target["symbol"], target["interval"], limit=1)
        except Exception:
            logger.debug("Failed to seed previous alert values for %s", rule_id, exc_info=True)
            return

        bars = getattr(result, "bars", None)
        if bars:
            self._previous_values[rule_id] = self._bar_values(bars[-1])

    @staticmethod
    def _bar_values(bar: BarData | Any) -> dict[str, Any]:
        if hasattr(bar, "to_dict"):
            values = bar.to_dict()
        elif isinstance(bar, dict):
            values = dict(bar)
        else:
            values = {
                "time": getattr(bar, "time", None),
                "open": getattr(bar, "open", None),
                "high": getattr(bar, "high", None),
                "low": getattr(bar, "low", None),
                "close": getattr(bar, "close", None),
                "volume": getattr(bar, "volume", None),
            }
        values["last"] = values.get("close")
        return values

    @staticmethod
    def _render_message(rule: dict[str, Any], values: dict[str, Any], evaluation: dict[str, Any]) -> str:
        target = AlertRuntimeEngine._target(rule)
        template = ""
        for action in rule.get("actions") or []:
            config = action.get("config") if isinstance(action, dict) else {}
            if isinstance(config, dict) and config.get("template"):
                template = str(config.get("template") or "")
                break

        condition = ""
        trace = evaluation.get("trace")
        if isinstance(trace, dict):
            condition = str(trace.get("summary") or "")

        replacements = {
            "symbol": target["symbol"],
            "interval": target["interval"],
            "condition": condition,
            "value": values.get("close"),
            "close": values.get("close"),
            "open": values.get("open"),
            "high": values.get("high"),
            "low": values.get("low"),
            "volume": values.get("volume"),
        }
        if template:
            message = template
            for key, value in replacements.items():
                message = message.replace(f"{{{{{key}}}}}", "" if value is None else str(value))
            return message

        return f"{rule.get('name') or 'Alert'} matched on {target['symbol']} {target['interval']}"
