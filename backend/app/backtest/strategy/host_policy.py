"""Versioned Host sizing and risk policies for backtest strategy outputs."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from typing import Any, Mapping, Protocol

from app.backtest.strategy.protocol import StrategyProviderError

HOST_POLICY_REVISION = "HOST_SIZING_RISK_V1"
SIZING_POLICIES = frozenset(
    {
        "FIXED_QTY_V1",
        "FIXED_NOTIONAL_V1",
        "EQUITY_PERCENT_V1",
        "RISK_PER_STOP_V1",
    }
)
RISK_POLICY_REVISION = "HOST_RISK_LIMITS_V1"


@dataclass(frozen=True, slots=True)
class PlanningContext:
    sequence: int
    event_time_ms: int
    actual_position: Decimal
    projected_position: Decimal
    reference_price: Decimal
    equity: Decimal
    initial_balance: Decimal
    cumulative_fees: Decimal
    leverage: Decimal
    active_order_count: int
    quantity_step: Decimal | None = None
    min_notional: Decimal | None = None
    contract_multiplier: Decimal = Decimal("1")
    rule_revision: str = "LEGACY_CONFIG"
    taker_fee_bps: Decimal = Decimal("0")
    maker_fee_bps: Decimal = Decimal("0")


@dataclass(frozen=True, slots=True)
class HostPolicyConfig:
    sizing_policy: str
    fixed_qty: Decimal | None
    fixed_notional: Decimal | None
    equity_percent: Decimal | None
    risk_per_stop_percent: Decimal | None
    stop_distance: Decimal | None
    max_abs_position_qty: Decimal | None
    max_notional: Decimal | None
    max_leverage: Decimal | None
    max_order_risk: Decimal | None
    max_active_orders: int | None
    max_cumulative_fees: Decimal | None
    max_drawdown_percent: Decimal | None
    daily_loss_limit: Decimal | None
    cooldown_events: int

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> HostPolicyConfig | None:
        policy = str(value.get("sizing_policy") or "").strip()
        if not policy:
            return None
        if policy not in SIZING_POLICIES:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "unknown Host sizing policy"
            )
        config = cls(
            sizing_policy=policy,
            fixed_qty=_optional_decimal(value, "fixed_qty"),
            fixed_notional=_optional_decimal(value, "fixed_notional"),
            equity_percent=_optional_decimal(value, "equity_percent"),
            risk_per_stop_percent=_optional_decimal(value, "risk_per_stop_percent"),
            stop_distance=_optional_decimal(value, "stop_distance"),
            max_abs_position_qty=_optional_decimal(value, "max_abs_position_qty"),
            max_notional=_optional_decimal(value, "max_notional"),
            max_leverage=_optional_decimal(value, "max_leverage"),
            max_order_risk=_optional_decimal(value, "max_order_risk"),
            max_active_orders=_optional_int(value, "max_active_orders"),
            max_cumulative_fees=_optional_decimal(value, "max_cumulative_fees"),
            max_drawdown_percent=_optional_decimal(value, "max_drawdown_percent"),
            daily_loss_limit=_optional_decimal(value, "daily_loss_limit"),
            cooldown_events=int(value.get("cooldown_events") or 0),
        )
        config.validate()
        return config

    def validate(self) -> None:
        required = {
            "FIXED_QTY_V1": self.fixed_qty,
            "FIXED_NOTIONAL_V1": self.fixed_notional,
            "EQUITY_PERCENT_V1": self.equity_percent,
            "RISK_PER_STOP_V1": self.risk_per_stop_percent,
        }[self.sizing_policy]
        if required is None or required <= 0:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                f"{self.sizing_policy} requires a positive sizing value",
            )
        if self.equity_percent is not None and self.equity_percent > 100:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "equity_percent must be in (0, 100]"
            )
        if self.risk_per_stop_percent is not None and self.risk_per_stop_percent > 100:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "risk_per_stop_percent must be in (0, 100]",
            )
        for name in (
            "fixed_qty",
            "fixed_notional",
            "stop_distance",
            "max_abs_position_qty",
            "max_notional",
            "max_leverage",
            "max_order_risk",
            "max_cumulative_fees",
            "max_drawdown_percent",
            "daily_loss_limit",
        ):
            item = getattr(self, name)
            if item is not None and (not item.is_finite() or item <= 0):
                raise StrategyProviderError(
                    "PROVIDER_PROTOCOL_VIOLATION", f"{name} must be positive"
                )
        if self.max_drawdown_percent is not None and self.max_drawdown_percent > 100:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "max_drawdown_percent must be in (0, 100]",
            )
        if self.max_active_orders is not None and self.max_active_orders < 1:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "max_active_orders must be positive"
            )
        if self.cooldown_events < 0:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "cooldown_events must not be negative"
            )

    def identity(self) -> dict[str, Any]:
        return {
            "host_policy_revision": HOST_POLICY_REVISION,
            "sizing_policy": self.sizing_policy,
            "risk_policy": RISK_POLICY_REVISION,
            "fixed_qty": _text(self.fixed_qty),
            "fixed_notional": _text(self.fixed_notional),
            "equity_percent": _text(self.equity_percent),
            "risk_per_stop_percent": _text(self.risk_per_stop_percent),
            "stop_distance": _text(self.stop_distance),
            "max_abs_position_qty": _text(self.max_abs_position_qty),
            "max_notional": _text(self.max_notional),
            "max_leverage": _text(self.max_leverage),
            "max_order_risk": _text(self.max_order_risk),
            "max_active_orders": self.max_active_orders,
            "max_cumulative_fees": _text(self.max_cumulative_fees),
            "max_drawdown_percent": _text(self.max_drawdown_percent),
            "daily_loss_limit": _text(self.daily_loss_limit),
            "cooldown_events": self.cooldown_events,
        }


class SizingPolicy(Protocol):
    revision: str

    def target_quantity(
        self, *, direction: str, context: PlanningContext
    ) -> Decimal: ...


class RiskPolicy(Protocol):
    revision: str

    def validate(
        self,
        intent: Mapping[str, Any],
        *,
        context: PlanningContext,
        projected_after: Decimal,
        opening_quantity: Decimal,
    ) -> str | None: ...


class ConfiguredSizingPolicy:
    def __init__(self, config: HostPolicyConfig) -> None:
        self.config = config
        self.revision = config.sizing_policy

    def target_quantity(self, *, direction: str, context: PlanningContext) -> Decimal:
        sign = Decimal("1") if direction == "LONG" else Decimal("-1")
        if direction == "FLAT":
            return Decimal("0")
        if direction not in {"LONG", "SHORT"}:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "SIGNAL direction is invalid"
            )
        if self.revision == "FIXED_QTY_V1":
            raw = self.config.fixed_qty
        elif self.revision == "FIXED_NOTIONAL_V1":
            raw = self.config.fixed_notional / (
                context.reference_price * context.contract_multiplier
            )
        elif self.revision == "EQUITY_PERCENT_V1":
            raw = (
                context.equity
                * self.config.equity_percent
                / Decimal("100")
                / (context.reference_price * context.contract_multiplier)
            )
        else:
            if self.config.stop_distance is None:
                raise StrategyProviderError(
                    "ORDER_REJECTED_RISK", "RISK_STOP_DISTANCE_REQUIRED"
                )
            raw = (
                context.equity
                * self.config.risk_per_stop_percent
                / Decimal("100")
                / (self.config.stop_distance * context.contract_multiplier)
            )
        assert raw is not None
        return sign * _floor_step(raw, context.quantity_step)


class HostRiskPolicy:
    revision = RISK_POLICY_REVISION

    def __init__(self, config: HostPolicyConfig) -> None:
        self.config = config
        self.peak_equity: Decimal | None = None
        self.daily_epoch: int | None = None
        self.daily_start_equity: Decimal | None = None
        self.cooldown_until_sequence = 0
        self.max_actual_abs_position = Decimal("0")
        self.max_actual_notional = Decimal("0")
        self.stop_reasons: dict[str, int] = {}

    def observe(self, context: PlanningContext) -> None:
        self.peak_equity = (
            context.equity
            if self.peak_equity is None
            else max(self.peak_equity, context.equity)
        )
        day = context.event_time_ms // 86_400_000
        if day != self.daily_epoch:
            self.daily_epoch = day
            self.daily_start_equity = context.equity
        actual_notional = (
            abs(context.actual_position)
            * context.reference_price
            * context.contract_multiplier
        )
        self.max_actual_abs_position = max(
            self.max_actual_abs_position, abs(context.actual_position)
        )
        self.max_actual_notional = max(self.max_actual_notional, actual_notional)

    def validate(
        self,
        intent: Mapping[str, Any],
        *,
        context: PlanningContext,
        projected_after: Decimal,
        opening_quantity: Decimal,
    ) -> str | None:
        self.observe(context)
        reduce_only = bool(intent.get("reduce_only") or False)
        if reduce_only:
            return None
        reason: str | None = None
        projected_notional = (
            abs(projected_after) * context.reference_price * context.contract_multiplier
        )
        opening_notional = (
            opening_quantity * context.reference_price * context.contract_multiplier
        )
        estimated_fee = (
            opening_notional
            * Decimal(str(intent.get("estimated_fee_bps") or "0"))
            / Decimal("10000")
        )
        if (
            self.config.max_abs_position_qty is not None
            and abs(projected_after) > self.config.max_abs_position_qty
        ):
            reason = "RISK_MAX_POSITION_QTY"
        elif (
            self.config.max_notional is not None
            and projected_notional > self.config.max_notional
        ):
            reason = "RISK_MAX_NOTIONAL"
        elif self.config.max_leverage is not None and (
            context.leverage > self.config.max_leverage
            or (
                context.equity > 0
                and projected_notional / context.equity > self.config.max_leverage
            )
        ):
            reason = "RISK_MAX_LEVERAGE"
        elif (
            self.config.max_order_risk is not None
            and self._order_risk(opening_quantity, context) > self.config.max_order_risk
        ):
            reason = "RISK_MAX_ORDER_RISK"
        elif (
            self.config.max_active_orders is not None
            and context.active_order_count >= self.config.max_active_orders
        ):
            reason = "RISK_MAX_ACTIVE_ORDERS"
        elif (
            self.config.max_cumulative_fees is not None
            and context.cumulative_fees + estimated_fee
            > self.config.max_cumulative_fees
        ):
            reason = "RISK_MAX_CUMULATIVE_FEES"
        elif self._drawdown_percent(context) >= (
            self.config.max_drawdown_percent or Decimal("Infinity")
        ):
            reason = "RISK_MAX_DRAWDOWN"
        elif context.sequence <= self.cooldown_until_sequence:
            reason = "RISK_COOLDOWN"
        elif self._daily_loss(context) >= (
            self.config.daily_loss_limit or Decimal("Infinity")
        ):
            self.cooldown_until_sequence = max(
                self.cooldown_until_sequence,
                context.sequence + self.config.cooldown_events,
            )
            reason = "RISK_DAILY_LOSS"
        return reason

    def snapshot(self) -> dict[str, Any]:
        return {
            "revision": self.revision,
            "peak_equity": _text(self.peak_equity),
            "daily_epoch": self.daily_epoch,
            "daily_start_equity": _text(self.daily_start_equity),
            "cooldown_until_sequence": self.cooldown_until_sequence,
            "max_actual_abs_position": str(self.max_actual_abs_position),
            "max_actual_notional": str(self.max_actual_notional),
            "stop_reasons": dict(sorted(self.stop_reasons.items())),
        }

    def restore(self, value: Mapping[str, Any]) -> None:
        if str(value.get("revision") or "") != self.revision:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "risk checkpoint revision changed"
            )
        self.peak_equity = _decimal_or_none(value.get("peak_equity"))
        self.daily_epoch = (
            None if value.get("daily_epoch") is None else int(value["daily_epoch"])
        )
        self.daily_start_equity = _decimal_or_none(value.get("daily_start_equity"))
        self.cooldown_until_sequence = int(value.get("cooldown_until_sequence") or 0)
        self.max_actual_abs_position = Decimal(
            str(value.get("max_actual_abs_position") or "0")
        )
        self.max_actual_notional = Decimal(str(value.get("max_actual_notional") or "0"))
        self.stop_reasons = {
            str(key): int(count)
            for key, count in dict(value.get("stop_reasons") or {}).items()
        }

    def report(self) -> dict[str, Any]:
        return {
            "policy_revision": HOST_POLICY_REVISION,
            "sizing_policy": self.config.sizing_policy,
            "risk_policy": self.revision,
            "max_actual_abs_position": str(self.max_actual_abs_position),
            "max_actual_notional": str(self.max_actual_notional),
            "peak_equity": _text(self.peak_equity),
            "stop_reasons": dict(sorted(self.stop_reasons.items())),
            "cooldown_until_sequence": self.cooldown_until_sequence,
        }

    def record_stop(self, reason: str) -> None:
        self.stop_reasons[reason] = self.stop_reasons.get(reason, 0) + 1

    def _order_risk(
        self, opening_quantity: Decimal, context: PlanningContext
    ) -> Decimal:
        if self.config.stop_distance is not None:
            return (
                opening_quantity
                * self.config.stop_distance
                * context.contract_multiplier
            )
        return (
            opening_quantity
            * context.reference_price
            * context.contract_multiplier
            / context.leverage
        )

    def _drawdown_percent(self, context: PlanningContext) -> Decimal:
        if self.peak_equity is None or self.peak_equity <= 0:
            return Decimal("0")
        return max(
            Decimal("0"),
            (self.peak_equity - context.equity) / self.peak_equity * Decimal("100"),
        )

    def _daily_loss(self, context: PlanningContext) -> Decimal:
        if self.daily_start_equity is None:
            return Decimal("0")
        return max(Decimal("0"), self.daily_start_equity - context.equity)


def _floor_step(value: Decimal, step: Decimal | None) -> Decimal:
    magnitude = abs(value)
    if step is not None:
        magnitude = (magnitude / step).to_integral_value(rounding=ROUND_DOWN) * step
    return magnitude.copy_sign(value)


def _optional_decimal(value: Mapping[str, Any], name: str) -> Decimal | None:
    raw = value.get(name)
    if raw is None or str(raw).strip() == "":
        return None
    try:
        parsed = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise StrategyProviderError(
            "PROVIDER_PROTOCOL_VIOLATION", f"{name} must be Decimal"
        ) from exc
    return parsed


def _optional_int(value: Mapping[str, Any], name: str) -> int | None:
    raw = value.get(name)
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise StrategyProviderError(
            "PROVIDER_PROTOCOL_VIOLATION", f"{name} must be integer"
        ) from exc


def _decimal_or_none(value: object) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _text(value: Decimal | None) -> str | None:
    return None if value is None else str(value)
