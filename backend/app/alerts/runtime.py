"""Realtime alert runtime wired to DataManager events."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any

from app.alerts.facade import AlertFacade
from app.alerts.indicator_context import (
    ALERT_INDICATOR_HISTORY_LIMIT,
    compute_alert_indicator_values,
    indicator_readiness,
    merge_alert_bar_window,
)
from app.alerts.validation import referenced_alert_fields
from app.data_engine.data_manager.models import BarData, DataEvent, DataEventType, SubscriptionHandle

logger = logging.getLogger("alerts.runtime")

_INDICATOR_FIELDS = {"rsi", "macdHist", "ma20"}


@dataclass(slots=True)
class _RuleSubscription:
    rule_id: str
    target_key: tuple[str, str, str, str]
    event_types: set[DataEventType]
    consumer_id: str
    handle: SubscriptionHandle


class AlertRuntimeEngine:
    """Keep enabled alert rules subscribed to market data and emit triggers."""

    def __init__(
        self,
        *,
        facade: AlertFacade,
        data_manager: Any | None = None,
        backfill_coordinator: Any | None = None,
        reconcile_interval_seconds: float = 5.0,
        warmup_timeout_seconds: float = 3.0,
    ) -> None:
        self.facade = facade
        self.data_manager = data_manager
        self.backfill_coordinator = backfill_coordinator
        self.reconcile_interval_seconds = max(0.1, float(reconcile_interval_seconds))
        self.warmup_timeout_seconds = max(0.1, float(warmup_timeout_seconds))
        self._started = False
        self._subscriptions: dict[str, _RuleSubscription] = {}
        self._previous_values: dict[str, dict[str, Any]] = {}
        self._bar_windows: dict[str, list[BarData]] = {}
        self._rule_diagnostics: dict[str, dict[str, Any]] = {}
        self._events_evaluated = 0
        self._triggers_emitted = 0
        self._evaluation_errors = 0
        self._system_error: str | None = None
        self._rule_errors: dict[str, str] = {}
        self._reconcile_task: asyncio.Task[None] | None = None
        self._reconcile_wakeup = asyncio.Event()
        self._warmup_tasks: dict[str, asyncio.Task[None]] = {}

    async def start(self) -> None:
        """Subscribe all currently enabled rules."""
        if self._started:
            return
        self._started = True
        try:
            await self.sync_rules()
            self._reconcile_task = asyncio.create_task(
                self._reconcile_loop(),
                name="alerts-runtime-reconcile",
            )
        except Exception as exc:
            self._record_error(exc)
            raise

    async def stop(self) -> None:
        """Release all alert-owned subscriptions."""
        self._started = False
        self._reconcile_wakeup.set()
        if self._reconcile_task is not None:
            self._reconcile_task.cancel()
            try:
                await self._reconcile_task
            except asyncio.CancelledError:
                pass
            self._reconcile_task = None
        warmup_tasks = list(self._warmup_tasks.values())
        self._warmup_tasks.clear()
        for task in warmup_tasks:
            task.cancel()
        if warmup_tasks:
            await asyncio.gather(*warmup_tasks, return_exceptions=True)
        for rule_id in list(self._subscriptions):
            await self.remove_rule(rule_id)

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
            if self._deactivation_reason(rule) in {"expired", "trigger_limit"}:
                self.facade.set_enabled(rule_id, False)
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
            if self._rule_needs_warmup(rule_id, rule):
                request_ids = await self._seed_previous_values(
                    rule_id,
                    target,
                    rule=rule,
                    auto_backfill=False,
                )
                self._schedule_backfill_wait(rule_id, target, request_ids)
            return
        if existing:
            await self.remove_rule(rule_id)

        async def _on_event(event: DataEvent, *, current_rule_id: str = rule_id) -> None:
            try:
                await self.evaluate_event(current_rule_id, event)
            except Exception as exc:
                self._evaluation_errors += 1
                self._record_error(exc, rule_id=current_rule_id)

        consumer_id = f"alert:rule:{rule_id}"
        try:
            await self.data_manager.ensure_stream(
                target["symbol"],
                target["interval"],
                exchange=target["exchange"],
                market_type=target["marketType"],
                focus_scope="background",
                subscription_tier="alerts",
                consumer_id=consumer_id,
            )
            request_ids = await self._seed_previous_values(
                rule_id,
                target,
                rule=rule,
                auto_backfill=True,
            )
            handle = self.data_manager.subscribe(
                callback=_on_event,
                symbol=target["symbol"],
                interval=target["interval"],
                exchange=target["exchange"],
                market_type=target["marketType"],
                event_types=event_types,
            )
        except Exception as exc:
            self._record_error(exc, rule_id=rule_id)
            try:
                await self.data_manager.release_stream(
                    target["symbol"],
                    target["interval"],
                    exchange=target["exchange"],
                    market_type=target["marketType"],
                    focus_scope="background",
                    subscription_tier="alerts",
                    consumer_id=consumer_id,
                )
            except Exception:
                logger.debug("Failed to roll back alert stream %s", rule_id, exc_info=True)
            return
        self._subscriptions[rule_id] = _RuleSubscription(
            rule_id=rule_id,
            target_key=target_key,
            event_types=event_types,
            consumer_id=consumer_id,
            handle=handle,
        )
        self._schedule_backfill_wait(rule_id, target, request_ids)
        self._clear_rule_error(rule_id)
        logger.info("Alert rule subscribed: %s %s", rule_id, target_key)

    async def remove_rule(self, rule_id: str) -> None:
        """Unsubscribe and release one rule's stream lease."""
        sub = self._subscriptions.pop(rule_id, None)
        warmup_task = self._warmup_tasks.pop(rule_id, None)
        if warmup_task is not None and warmup_task is not asyncio.current_task():
            warmup_task.cancel()
        self._previous_values.pop(rule_id, None)
        self._bar_windows.pop(rule_id, None)
        self._rule_diagnostics.pop(rule_id, None)
        self._clear_rule_error(rule_id)
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

        self._events_evaluated += 1
        rule = self.facade.get_rule(rule_id)
        if not self._is_rule_active(rule):
            if self._deactivation_reason(rule) in {"expired", "trigger_limit"}:
                self.facade.set_enabled(rule_id, False)
            await self.remove_rule(rule_id)
            return None

        target = self._target(rule)
        window = merge_alert_bar_window(self._bar_windows.get(rule_id, []), event.bar)
        self._bar_windows[rule_id] = window
        closed_window = [
            bar for bar in window if getattr(bar, "is_closed", True)
        ]
        indicator_values = compute_alert_indicator_values(closed_window)

        if event.event_type == DataEventType.BAR_AMENDED:
            frontier = closed_window[-1] if closed_window else window[-1]
            current = {**self._bar_values(frontier), **indicator_values}
            self._previous_values[rule_id] = current
            self._update_diagnostics(
                rule_id,
                rule,
                timestamp_ms=event.timestamp_ms,
                event_type=event.event_type,
                indicator_values=indicator_values,
                history_bars=len(window),
                state="state_updated",
            )
            # Amendments repair the indicator frontier but never manufacture a
            # historical alert after the fact.
            return None

        current = {**self._bar_values(event.bar), **indicator_values}
        previous = dict(self._previous_values.get(rule_id, {}))
        if event.previous_bar is not None:
            previous.update(self._bar_values(event.previous_bar))
        self._previous_values[rule_id] = current

        readiness = indicator_readiness(indicator_values)
        self._update_diagnostics(
            rule_id,
            rule,
            timestamp_ms=event.timestamp_ms,
            event_type=event.event_type,
            indicator_values=indicator_values,
            history_bars=len(window),
        )

        if not self._required_indicators_ready(rule, readiness):
            self._rule_diagnostics[rule_id]["lastResult"] = None
            self._rule_diagnostics[rule_id]["state"] = "warming"
            return None

        if not self._can_trigger(rule, now_ms=event.timestamp_ms):
            return None

        try:
            evaluation = self.facade.evaluate(
                rule.get("expression") if isinstance(rule, dict) else {},
                {
                    "values": current,
                    "previous": previous,
                    "event": event.to_dict(),
                },
            )
        except Exception as exc:
            self._evaluation_errors += 1
            self._record_error(exc, rule_id=rule_id)
            return None
        self._clear_rule_error(rule_id)
        self._rule_diagnostics[rule_id]["lastResult"] = bool(evaluation.get("result"))
        if not evaluation.get("result"):
            return None

        emitted = await self.facade.emit_triggered({
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
                "indicatorReady": readiness,
            },
            "actions": rule.get("actions") if isinstance(rule.get("actions"), list) else [],
            "createdAt": event.timestamp_ms,
        }, enforce_limits=True)
        if emitted is not None:
            self._triggers_emitted += 1
        refreshed = self.facade.get_rule(rule_id)
        if not self._is_rule_active(refreshed):
            if self._deactivation_reason(refreshed) in {"expired", "trigger_limit"}:
                self.facade.set_enabled(rule_id, False)
            await self.remove_rule(rule_id)
        return emitted

    def snapshot(self) -> dict[str, Any]:
        last_error = self._system_error
        if last_error is None and self._rule_errors:
            last_error = next(reversed(self._rule_errors.values()))
        return {
            "started": self._started,
            "dataManager": self.data_manager is not None,
            "status": "error" if last_error else ("running" if self._started else "stopped"),
            "eventsEvaluated": self._events_evaluated,
            "triggersEmitted": self._triggers_emitted,
            "evaluationErrors": self._evaluation_errors,
            "lastError": last_error,
            "ruleDiagnostics": dict(self._rule_diagnostics),
            "rules": self._rule_states(),
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
        return AlertRuntimeEngine._deactivation_reason(rule) is None

    @staticmethod
    def _deactivation_reason(rule: dict[str, Any] | None) -> str | None:
        if not isinstance(rule, dict) or not rule.get("id"):
            return "missing"
        if not bool(rule.get("enabled", True)):
            return "disabled"
        expires_at = rule.get("expiresAt")
        if expires_at is not None and int(expires_at) <= int(time.time() * 1000):
            return "expired"
        max_triggers = rule.get("maxTriggers")
        if max_triggers is not None and int(rule.get("triggerCount") or 0) >= int(max_triggers):
            return "trigger_limit"
        return None

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
            return {DataEventType.BAR_CLOSED, DataEventType.BAR_AMENDED}
        if trigger_on == "bar_update":
            return {DataEventType.BAR_UPDATED, DataEventType.BAR_CLOSED, DataEventType.BAR_AMENDED}
        return {
            DataEventType.BAR_CREATED,
            DataEventType.BAR_UPDATED,
            DataEventType.BAR_CLOSED,
            DataEventType.BAR_AMENDED,
        }

    async def _seed_previous_values(
        self,
        rule_id: str,
        target: dict[str, str],
        *,
        rule: dict[str, Any],
        auto_backfill: bool,
    ) -> list[str]:
        query_latest = getattr(self.data_manager, "query_latest", None)
        if not callable(query_latest):
            return []
        try:
            result = query_latest(
                target["symbol"],
                target["interval"],
                limit=ALERT_INDICATOR_HISTORY_LIMIT,
                exchange=target["exchange"],
                market_type=target["marketType"],
                auto_backfill=auto_backfill,
                backfill_reason="alert_indicator_warmup" if auto_backfill else None,
                backfill_requester="alert_runtime_seed",
            )
        except TypeError:
            result = query_latest(
                target["symbol"],
                target["interval"],
                limit=ALERT_INDICATOR_HISTORY_LIMIT,
            )
        except Exception:
            logger.debug("Failed to seed previous alert values for %s", rule_id, exc_info=True)
            return []

        bars = getattr(result, "bars", None)
        if bars:
            window = [
                bar for bar in list(bars)[-ALERT_INDICATOR_HISTORY_LIMIT:]
                if getattr(bar, "is_closed", True)
            ][-ALERT_INDICATOR_HISTORY_LIMIT:]
            self._bar_windows[rule_id] = window
            indicators = compute_alert_indicator_values(window)
            if window:
                self._previous_values[rule_id] = {
                    **self._bar_values(window[-1]),
                    **indicators,
                }
        else:
            window = []
            indicators = compute_alert_indicator_values(window)
        self._update_diagnostics(
            rule_id,
            rule,
            indicator_values=indicators,
            history_bars=len(window),
            state=(
                "ready"
                if self._required_indicators_ready(rule, indicator_readiness(indicators))
                else "warming"
            ),
        )
        metadata = getattr(result, "metadata", None)
        if not isinstance(metadata, dict):
            return []
        raw_ids = metadata.get("backfill_request_ids")
        if not isinstance(raw_ids, list):
            return []
        return [str(item) for item in raw_ids if str(item).strip()]

    async def _reconcile_loop(self) -> None:
        """Retry failed subscriptions and refresh warming indicator windows."""
        while self._started:
            try:
                await asyncio.wait_for(
                    self._reconcile_wakeup.wait(),
                    timeout=self.reconcile_interval_seconds,
                )
            except TimeoutError:
                pass
            self._reconcile_wakeup.clear()
            if not self._started:
                return
            try:
                await self.sync_rules()
                self._system_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._record_error(exc)

    def _schedule_backfill_wait(
        self,
        rule_id: str,
        target: dict[str, str],
        request_ids: list[str],
    ) -> None:
        wait_for_request = getattr(self.backfill_coordinator, "wait_for_request", None)
        if not request_ids or not callable(wait_for_request):
            return

        existing = self._warmup_tasks.pop(rule_id, None)
        if existing is not None:
            existing.cancel()

        async def _wait_and_refresh() -> None:
            try:
                waits = [wait_for_request(request_id) for request_id in request_ids]
                await asyncio.wait_for(
                    asyncio.gather(*waits),
                    timeout=self.warmup_timeout_seconds,
                )
                diagnostics = self._rule_diagnostics.setdefault(rule_id, {})
                diagnostics["warmupStatus"] = "completed"
            except TimeoutError:
                diagnostics = self._rule_diagnostics.setdefault(rule_id, {})
                diagnostics["warmupStatus"] = "background_retry"
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                diagnostics = self._rule_diagnostics.setdefault(rule_id, {})
                diagnostics["warmupStatus"] = "background_retry"
                diagnostics["warmupDetail"] = f"{type(exc).__name__}: {exc}"

            try:
                if not self._started:
                    return
                sub = self._subscriptions.get(rule_id)
                if sub is None or sub.target_key != (
                    target["exchange"],
                    target["marketType"],
                    target["symbol"],
                    target["interval"],
                ):
                    return
                rule = self.facade.get_rule(rule_id)
                if self._is_rule_active(rule):
                    await self._seed_previous_values(
                        rule_id,
                        target,
                        rule=rule,
                        auto_backfill=False,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._record_error(exc, rule_id=rule_id)
            finally:
                if self._warmup_tasks.get(rule_id) is asyncio.current_task():
                    self._warmup_tasks.pop(rule_id, None)

        self._warmup_tasks[rule_id] = asyncio.create_task(
            _wait_and_refresh(),
            name=f"alert-warmup:{rule_id}",
        )

    @staticmethod
    def _required_indicator_fields(rule: dict[str, Any] | None) -> set[str]:
        expression = rule.get("expression") if isinstance(rule, dict) else None
        return referenced_alert_fields(expression) & _INDICATOR_FIELDS

    @classmethod
    def _required_indicators_ready(
        cls,
        rule: dict[str, Any] | None,
        readiness: dict[str, bool],
    ) -> bool:
        return all(readiness.get(field, False) for field in cls._required_indicator_fields(rule))

    def _rule_needs_warmup(self, rule_id: str, rule: dict[str, Any]) -> bool:
        required = self._required_indicator_fields(rule)
        if not required:
            return False
        diagnostics = self._rule_diagnostics.get(rule_id, {})
        readiness = diagnostics.get("indicatorReady")
        if not isinstance(readiness, dict):
            return True
        return not all(bool(readiness.get(field)) for field in required)

    def _update_diagnostics(
        self,
        rule_id: str,
        rule: dict[str, Any],
        *,
        indicator_values: dict[str, Any],
        history_bars: int,
        timestamp_ms: int | None = None,
        event_type: DataEventType | None = None,
        state: str | None = None,
    ) -> None:
        diagnostics = self._rule_diagnostics.setdefault(rule_id, {})
        diagnostics.update({
            "indicatorReady": indicator_readiness(indicator_values),
            "historyBars": max(0, int(history_bars)),
            "requiredFields": sorted(referenced_alert_fields(rule.get("expression"))),
        })
        if timestamp_ms is not None:
            diagnostics["lastEvaluatedAt"] = int(timestamp_ms)
        if event_type is not None:
            diagnostics["lastEventType"] = event_type.value
        if state is not None:
            diagnostics["state"] = state

    def _rule_states(self) -> list[dict[str, Any]]:
        states: list[dict[str, Any]] = []
        for rule in self.facade.list_rules():
            rule_id = str(rule.get("id") or "")
            diagnostics = self._rule_diagnostics.get(rule_id, {})
            subscribed = rule_id in self._subscriptions
            expires_at = rule.get("expiresAt")
            max_triggers = rule.get("maxTriggers")
            is_expired = expires_at is not None and int(expires_at) <= int(time.time() * 1000)
            is_exhausted = (
                max_triggers is not None
                and int(rule.get("triggerCount") or 0) >= int(max_triggers)
            )
            if is_expired:
                state = "expired"
            elif is_exhausted:
                state = "exhausted"
            elif not bool(rule.get("enabled", True)):
                state = "disabled"
            elif rule_id in self._rule_errors:
                state = "degraded"
            elif not subscribed:
                state = "recovering"
            elif self._rule_needs_warmup(rule_id, rule):
                state = "warming"
            else:
                state = "ready"
            readiness = diagnostics.get("indicatorReady")
            states.append({
                "ruleId": rule_id,
                "state": state,
                "enabled": bool(rule.get("enabled", True)),
                "subscribed": subscribed,
                "requiredFields": sorted(referenced_alert_fields(rule.get("expression"))),
                "indicatorReady": readiness if isinstance(readiness, dict) else {},
                "historyBars": max(0, int(diagnostics.get("historyBars") or 0)),
                "lastEvaluatedAt": diagnostics.get("lastEvaluatedAt"),
                "lastEventType": diagnostics.get("lastEventType"),
                "lastError": self._rule_errors.get(rule_id),
            })
        return states

    def _record_error(self, exc: Exception, *, rule_id: str | None = None) -> None:
        message = f"{type(exc).__name__}: {exc}"
        if rule_id:
            self._rule_errors[rule_id] = message
            self._rule_diagnostics[rule_id] = {
                **self._rule_diagnostics.get(rule_id, {}),
                "lastError": message,
            }
        else:
            self._system_error = message
        logger.error("Alert runtime error%s: %s", f" for {rule_id}" if rule_id else "", message)

    def _clear_rule_error(self, rule_id: str) -> None:
        self._rule_errors.pop(rule_id, None)
        diagnostics = self._rule_diagnostics.get(rule_id)
        if diagnostics is not None:
            diagnostics.pop("lastError", None)

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
