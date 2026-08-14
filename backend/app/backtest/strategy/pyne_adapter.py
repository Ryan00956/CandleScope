"""Host planner that turns Pyne strategy output into kernel order intents."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Mapping

from app.backtest.strategy.protocol import StrategyOutput, StrategyProviderError
from app.backtest.strategy.host_policy import (
    HOST_POLICY_REVISION,
    ConfiguredSizingPolicy,
    HostPolicyConfig,
    HostRiskPolicy,
    PlanningContext,
)
from app.market_dataset.snapshot import MarketEvent


class HostPlan(list[dict[str, Any]]):
    """List-compatible order plan with a policy-independent provider decision."""

    def __init__(
        self,
        values: list[dict[str, Any]],
        *,
        decision: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(values)
        self.decision = None if decision is None else dict(decision)


class PyneHostPlanner:
    """Maps TARGET_POSITION / SIGNAL to Host order intents. Provider never fills."""

    def __init__(
        self,
        config: Mapping[str, Any] | None = None,
        *,
        execution_reporter: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.position = Decimal("0")
        self.config = HostPolicyConfig.from_mapping(config or {})
        self.sizing = (
            None if self.config is None else ConfiguredSizingPolicy(self.config)
        )
        self.risk = None if self.config is None else HostRiskPolicy(self.config)
        self.execution_reporter = execution_reporter
        self.rejections: list[dict[str, Any]] = []

    def plan(
        self,
        output: StrategyOutput | dict[str, Any] | None,
        *,
        current_position: Decimal | str | None = None,
        context: PlanningContext | None = None,
    ) -> list[dict[str, Any]]:
        if self.config is None:
            return self._legacy_plan(output, current_position=current_position)
        if context is None:
            raise ValueError("versioned Host policy requires PlanningContext")
        assert self.risk is not None and self.sizing is not None
        self.risk.observe(context)
        if output is None:
            return HostPlan([])
        payload = (
            output.payload
            if isinstance(output, StrategyOutput)
            else output.get("payload") or {}
        )
        kind = (
            output.kind
            if isinstance(output, StrategyOutput)
            else str(output.get("kind") or "")
        )
        decision = (
            output.to_wire() if isinstance(output, StrategyOutput) else dict(output)
        )
        raw_intents: list[dict[str, Any]]
        if kind == "TARGET_POSITION":
            try:
                target = Decimal(str(payload.get("targetExposure") or "0"))
            except (InvalidOperation, TypeError, ValueError):
                return self._rejected_plan(
                    decision,
                    context,
                    "ORDER_REJECTED_RULES",
                    "TARGET_POSITION_INVALID",
                    output=payload,
                )
            raw_intents = self._target_intents(target, context)
        elif kind == "SIGNAL":
            direction = str(payload.get("direction") or "FLAT").upper()
            try:
                target = self.sizing.target_quantity(
                    direction=direction, context=context
                )
            except StrategyProviderError as exc:
                reason_code = (
                    str(exc).split(":", 1)[-1].strip() if str(exc) else "SIZING_FAILED"
                )
                return self._rejected_plan(
                    decision,
                    context,
                    "ORDER_REJECTED_RISK",
                    reason_code,
                    output=payload,
                )
            if direction != "FLAT" and target == 0:
                return self._rejected_plan(
                    decision,
                    context,
                    "ORDER_REJECTED_RULES",
                    "SIZING_BELOW_QUANTITY_STEP",
                    output=payload,
                )
            raw_intents = self._target_intents(target, context)
        elif kind == "ORDER_INTENT":
            raw_intents = payload.get("intents")
            values = raw_intents if isinstance(raw_intents, list) else [payload]
            raw_intents = [
                dict(value) for value in values if isinstance(value, Mapping)
            ]
        else:
            return HostPlan([], decision=decision)
        return self._validate_intents(raw_intents, decision=decision, context=context)

    def _legacy_plan(
        self,
        output: StrategyOutput | dict[str, Any] | None,
        *,
        current_position: Decimal | str | None,
    ) -> list[dict[str, Any]]:
        if output is None:
            return []
        payload = (
            output.payload
            if isinstance(output, StrategyOutput)
            else output.get("payload") or {}
        )
        kind = (
            output.kind
            if isinstance(output, StrategyOutput)
            else str(output.get("kind") or "")
        )
        authoritative = (
            self.position
            if current_position is None
            else Decimal(str(current_position))
        )
        target = authoritative
        if kind == "TARGET_POSITION":
            target = Decimal(str(payload.get("targetExposure") or "0"))
        elif kind == "SIGNAL":
            direction = str(payload.get("direction") or "FLAT").upper()
            target = (
                Decimal("1")
                if direction == "LONG"
                else (Decimal("-1") if direction == "SHORT" else Decimal("0"))
            )
        elif kind == "ORDER_INTENT":
            raw_intents = payload.get("intents")
            values = raw_intents if isinstance(raw_intents, list) else [payload]
            return [dict(value) for value in values if isinstance(value, dict)]
        else:
            return []
        delta = target - authoritative
        if delta == 0:
            return []
        intent = {
            "side": "BUY" if delta > 0 else "SELL",
            "type": "MARKET",
            "qty": str(abs(delta)),
        }
        # Direct adapter users retain the original stateful convenience. The
        # runtime always supplies Host account state so rejected or cancelled
        # intents cannot corrupt future target-position deltas.
        if current_position is None:
            self.position = target
        return [intent]

    def _target_intents(
        self, target: Decimal, context: PlanningContext
    ) -> list[dict[str, Any]]:
        delta = target - context.projected_position
        if delta == 0:
            return []
        reducing_same_side = (
            context.actual_position != 0
            and target * context.actual_position >= 0
            and abs(target) < abs(context.actual_position)
        )
        return [
            {
                "side": "BUY" if delta > 0 else "SELL",
                "type": "MARKET",
                "qty": str(abs(delta)),
                "reduce_only": reducing_same_side,
            }
        ]

    def _validate_intents(
        self,
        intents: list[dict[str, Any]],
        *,
        decision: Mapping[str, Any],
        context: PlanningContext,
    ) -> HostPlan:
        accepted: list[dict[str, Any]] = []
        projected = context.projected_position
        active_count = context.active_order_count
        for raw in intents:
            intent = dict(raw)
            try:
                qty = Decimal(str(intent.get("qty")))
            except (InvalidOperation, TypeError, ValueError):
                self._reject(
                    context,
                    "ORDER_REJECTED_RULES",
                    "INVALID_QTY",
                    intent=intent,
                )
                continue
            side = str(intent.get("side") or "").upper()
            if side not in {"BUY", "SELL"} or not qty.is_finite() or qty <= 0:
                self._reject(
                    context,
                    "ORDER_REJECTED_RULES",
                    "INVALID_ORDER_INTENT",
                    intent=intent,
                )
                continue
            if context.quantity_step is not None and qty % context.quantity_step != 0:
                self._reject(
                    context,
                    "ORDER_REJECTED_RULES",
                    "QTY_STEP_MISMATCH",
                    intent=intent,
                )
                continue
            signed = qty if side == "BUY" else -qty
            reduce_only = bool(intent.get("reduce_only") or False)
            reducible = (
                max(projected, Decimal("0"))
                if side == "SELL"
                else max(-projected, Decimal("0"))
            )
            if reduce_only and (reducible <= 0 or qty > reducible):
                self._reject(
                    context,
                    "ORDER_REJECTED_RISK",
                    "RISK_REDUCE_ONLY_CROSSES_ZERO",
                    intent=intent,
                )
                continue
            projected_after = projected + signed
            opening_quantity = (
                Decimal("0") if reduce_only else max(Decimal("0"), qty - reducible)
            )
            notional = qty * context.reference_price * context.contract_multiplier
            if (
                not reduce_only
                and context.min_notional is not None
                and notional < context.min_notional
            ):
                self._reject(
                    context,
                    "ORDER_REJECTED_RULES",
                    "MIN_NOTIONAL",
                    intent=intent,
                )
                continue
            order_type = str(intent.get("type") or "MARKET").upper()
            intent["side"] = side
            intent["type"] = order_type
            intent["qty"] = str(qty)
            intent["reduce_only"] = reduce_only
            intent["estimated_fee_bps"] = str(
                context.maker_fee_bps
                if order_type in {"LIMIT", "STOP_LIMIT"}
                else context.taker_fee_bps
            )
            assert self.risk is not None
            adjusted = replace(context, active_order_count=active_count)
            risk_reason = self.risk.validate(
                intent,
                context=adjusted,
                projected_after=projected_after,
                opening_quantity=opening_quantity,
            )
            intent.pop("estimated_fee_bps", None)
            if risk_reason is not None:
                self._reject(
                    context,
                    "ORDER_REJECTED_RISK",
                    risk_reason,
                    intent=intent,
                )
                continue
            accepted.append(intent)
            projected = projected_after
            active_count += 1
        return HostPlan(accepted, decision=decision)

    def _rejected_plan(
        self,
        decision: Mapping[str, Any],
        context: PlanningContext,
        reason: str,
        reason_code: str,
        *,
        output: Mapping[str, Any],
    ) -> HostPlan:
        self._reject(context, reason, reason_code, output=output)
        return HostPlan([], decision=decision)

    def _reject(
        self,
        context: PlanningContext,
        reason: str,
        reason_code: str,
        *,
        intent: Mapping[str, Any] | None = None,
        output: Mapping[str, Any] | None = None,
    ) -> None:
        rejection = {
            "accepted": False,
            "reason": reason,
            "reason_code": reason_code,
            "sequence": context.sequence,
            "event_time_ms": context.event_time_ms,
            "policy_revision": HOST_POLICY_REVISION,
            "sizing_policy": self.config.sizing_policy if self.config else None,
            "risk_policy": None if self.risk is None else self.risk.revision,
            "rule_revision": context.rule_revision,
            "input_snapshot": {
                "actual_position": str(context.actual_position),
                "projected_position": str(context.projected_position),
                "reference_price": str(context.reference_price),
                "equity": str(context.equity),
                "cumulative_fees": str(context.cumulative_fees),
                "active_order_count": context.active_order_count,
            },
            **({"intent": dict(intent)} if intent is not None else {}),
            **({"output": dict(output)} if output is not None else {}),
        }
        self.rejections.append(rejection)
        if reason == "ORDER_REJECTED_RISK" and self.risk is not None:
            self.risk.record_stop(reason_code)
        if self.execution_reporter is not None:
            self.execution_reporter(rejection)

    def snapshot(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"position": str(self.position)}
        if self.config is not None and self.risk is not None:
            payload.update(
                {
                    "policy_revision": HOST_POLICY_REVISION,
                    "sizing_policy": self.config.sizing_policy,
                    "risk": self.risk.snapshot(),
                    "rejections": list(self.rejections),
                }
            )
        return payload

    def restore(self, payload: dict[str, Any]) -> None:
        self.position = Decimal(str(payload.get("position") or "0"))
        if self.config is None:
            return
        if (
            payload.get("policy_revision") != HOST_POLICY_REVISION
            or payload.get("sizing_policy") != self.config.sizing_policy
            or self.risk is None
        ):
            raise ValueError("Host policy checkpoint identity changed")
        self.risk.restore(payload.get("risk") or {})
        self.rejections = [dict(item) for item in payload.get("rejections") or []]

    def report(self) -> dict[str, Any]:
        if self.config is None or self.risk is None:
            return {}
        return self.risk.report()


def events_to_visible_bars(events: tuple[MarketEvent, ...]) -> tuple[MarketEvent, ...]:
    return events
