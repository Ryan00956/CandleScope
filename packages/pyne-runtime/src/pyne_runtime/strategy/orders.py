"""Strategy order lifecycle helpers."""
from __future__ import annotations

from typing import Any

from .constants import StrategyIntrabarPath, StrategyOca, StrategySameBarPriority


def _exit_trigger(
    *,
    current_position: float,
    open_price: float,
    high: float,
    low: float,
    stop: float | None,
    limit: float | None,
    tick_verify: float = 0.0,
    same_bar_fill_priority: str = StrategySameBarPriority.stop_first,
    intrabar_path: str = StrategyIntrabarPath.same_bar_priority,
) -> tuple[str, float] | None:
    if current_position > 0:
        stop_hit = stop is not None and low <= stop
        limit_hit = limit is not None and high >= limit + tick_verify
        if stop_hit and limit_hit:
            reason, price = _same_bar_trigger(
                stop=stop,
                limit=limit,
                stop_path="low",
                limit_path="high",
                same_bar_fill_priority=same_bar_fill_priority,
                intrabar_path=intrabar_path,
            )
            return reason, _exit_fill_price(
                current_position=current_position,
                reason=reason,
                trigger_price=price,
                open_price=open_price,
            )
        if stop_hit:
            return "stop", _exit_fill_price(
                current_position=current_position,
                reason="stop",
                trigger_price=float(stop),
                open_price=open_price,
            )
        if limit_hit:
            return "limit", max(float(limit), float(open_price))
        return None
    stop_hit = stop is not None and high >= stop
    limit_hit = limit is not None and low <= limit - tick_verify
    if stop_hit and limit_hit:
        reason, price = _same_bar_trigger(
            stop=stop,
            limit=limit,
            stop_path="high",
            limit_path="low",
            same_bar_fill_priority=same_bar_fill_priority,
            intrabar_path=intrabar_path,
        )
        return reason, _exit_fill_price(
            current_position=current_position,
            reason=reason,
            trigger_price=price,
            open_price=open_price,
        )
    if stop_hit:
        return "stop", _exit_fill_price(
            current_position=current_position,
            reason="stop",
            trigger_price=float(stop),
            open_price=open_price,
        )
    if limit_hit:
        return "limit", min(float(limit), float(open_price))
    return None


def _is_pending_submission(order: dict[str, Any]) -> bool:
    return order.get("_limit") is not None or order.get("_stop") is not None


def _strategy_lifecycle_events(orders: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for order in sorted(
        orders,
        key=lambda item: (
            item.get("_submit_time", item.get("time", 0)),
            item.get("_seq", 0),
        ),
    ):
        event = _strategy_lifecycle_event(order)
        if event is not None:
            events.append(event)
    return events


def _strategy_lifecycle_event(order: dict[str, Any]) -> dict[str, Any] | None:
    order_type = str(order.get("type") or "")
    active = bool(order.get("_active", True))
    canceled = bool(order.get("_canceled"))
    rejected = bool(order.get("_rejected_reason"))
    pending_submission = order_type in {"entry", "order"} and _is_pending_submission(order)

    if not active and not canceled and not rejected and not pending_submission:
        return None

    status = _strategy_lifecycle_status(
        order_type=order_type,
        active=active,
        canceled=canceled,
        rejected=rejected,
        pending_submission=pending_submission,
    )
    phase = _strategy_lifecycle_phase(
        order_type=order_type,
        status=status,
        pending_submission=pending_submission,
    )
    event: dict[str, Any] = {
        "id": order.get("id"),
        "type": order_type,
        "status": status,
        "phase": phase,
        "submitted_time": order.get("_submit_time", order.get("time")),
        "filled_time": order.get("time") if status == "filled" else None,
        "canceled_time": order.get("_canceled_time")
        if status == "canceled" and pending_submission
        else order.get("time")
        if status == "canceled"
        else None,
        "rejected_time": order.get("_rejected_time") if status == "rejected" else None,
        "side": order.get("side"),
        "qty": order.get("qty"),
        "price": order.get("price"),
        "position_after": order.get("position_after"),
    }
    optional_fields = (
        "from_entry",
        "reason",
        "comment",
        "canceled",
        "commission",
        "oca_name",
        "oca_type",
    )
    for key in optional_fields:
        if key in order:
            event[key] = order[key]
    for internal_key, public_key in (("_limit", "limit"), ("_stop", "stop")):
        if order.get(internal_key) is not None:
            event[public_key] = order.get(internal_key)
    if order.get("_requested_fill_qty") is not None:
        event["requested_qty"] = round(float(order.get("_requested_fill_qty", 0.0)), 8)
    if order.get("_filled_qty") is not None:
        event["filled_qty"] = round(float(order.get("_filled_qty", 0.0)), 8)
    if order.get("_target_qty") is not None:
        event["target_qty"] = round(float(order.get("_target_qty", 0.0)), 8)
    if order.get("_qty_percent") is not None:
        event["qty_percent"] = round(float(order.get("_qty_percent", 0.0)), 8)
    if order.get("_transaction_qty") is not None:
        event["transaction_qty"] = round(float(order.get("_transaction_qty", 0.0)), 8)
    if order.get("_canceled_by"):
        event["canceled_by"] = order.get("_canceled_by")
    if order.get("_rejected_reason"):
        event["rejected_reason"] = order.get("_rejected_reason")
    return event


def _strategy_lifecycle_status(
    *,
    order_type: str,
    active: bool,
    canceled: bool,
    rejected: bool,
    pending_submission: bool,
) -> str:
    if canceled or order_type in {"cancel", "cancel_all"} and active:
        return "canceled"
    if rejected:
        return "rejected"
    if active:
        return "filled"
    if pending_submission:
        return "pending"
    return "submitted"


def _strategy_lifecycle_phase(
    *,
    order_type: str,
    status: str,
    pending_submission: bool,
) -> str:
    if order_type in {"cancel", "cancel_all"}:
        return "cancel"
    if status == "canceled" and pending_submission:
        return "pending_canceled"
    if status == "rejected":
        return "pending_rejected" if pending_submission else "rejected"
    if status == "pending":
        return "pending"
    if pending_submission:
        return "pending_fill"
    if order_type == "exit":
        return "exit_fill"
    if order_type == "close":
        return "close_fill"
    if order_type == "close_all":
        return "close_all_fill"
    if order_type in {"entry", "order"}:
        return "market_fill"
    return order_type or status


def _reject_order(order: dict[str, Any], *, timestamp: int, reason: str) -> None:
    if order.get("type") in {"entry", "order"}:
        order.setdefault(
            "_requested_fill_qty",
            float(order.get("_original_qty", order.get("qty", 0.0))),
        )
        order.setdefault("_filled_qty", 0.0)
    order["_rejected_reason"] = reason
    order["_rejected_time"] = timestamp


def _pending_trigger(
    *,
    side: str,
    open_price: float,
    high: float,
    low: float,
    limit: float | None,
    stop: float | None,
    tick_verify: float = 0.0,
    same_bar_fill_priority: str = StrategySameBarPriority.stop_first,
    intrabar_path: str = StrategyIntrabarPath.same_bar_priority,
) -> tuple[str, float] | None:
    if side == "long":
        stop_hit = stop is not None and high >= stop
        limit_hit = limit is not None and low <= limit - tick_verify
        if stop_hit and limit_hit:
            reason, price = _same_bar_trigger(
                stop=stop,
                limit=limit,
                stop_path="high",
                limit_path="low",
                same_bar_fill_priority=same_bar_fill_priority,
                intrabar_path=intrabar_path,
            )
            return reason, _pending_fill_price(
                side=side,
                reason=reason,
                trigger_price=price,
                open_price=open_price,
            )
        if stop_hit:
            return "stop", _pending_fill_price(
                side=side,
                reason="stop",
                trigger_price=float(stop),
                open_price=open_price,
            )
        if limit_hit:
            return "limit", _pending_fill_price(
                side=side,
                reason="limit",
                trigger_price=float(limit),
                open_price=open_price,
            )
        return None
    stop_hit = stop is not None and low <= stop
    limit_hit = limit is not None and high >= limit + tick_verify
    if stop_hit and limit_hit:
        reason, price = _same_bar_trigger(
            stop=stop,
            limit=limit,
            stop_path="low",
            limit_path="high",
            same_bar_fill_priority=same_bar_fill_priority,
            intrabar_path=intrabar_path,
        )
        return reason, _pending_fill_price(
            side=side,
            reason=reason,
            trigger_price=price,
            open_price=open_price,
        )
    if stop_hit:
        return "stop", _pending_fill_price(
            side=side,
            reason="stop",
            trigger_price=float(stop),
            open_price=open_price,
        )
    if limit_hit:
        return "limit", _pending_fill_price(
            side=side,
            reason="limit",
            trigger_price=float(limit),
            open_price=open_price,
        )
    return None


def _pending_fill_price(
    *,
    side: str,
    reason: str,
    trigger_price: float,
    open_price: float,
) -> float:
    trigger = float(trigger_price)
    opened = float(open_price)
    if side == "long":
        return max(trigger, opened) if reason == "stop" else min(trigger, opened)
    return min(trigger, opened) if reason == "stop" else max(trigger, opened)


def _exit_fill_price(
    *,
    current_position: float,
    reason: str,
    trigger_price: float,
    open_price: float,
) -> float:
    trigger = float(trigger_price)
    opened = float(open_price)
    if current_position > 0:
        return min(trigger, opened) if reason == "stop" else max(trigger, opened)
    return max(trigger, opened) if reason == "stop" else min(trigger, opened)


def _same_bar_trigger(
    *,
    stop: float | None,
    limit: float | None,
    stop_path: str,
    limit_path: str,
    same_bar_fill_priority: str,
    intrabar_path: str,
) -> tuple[str, float]:
    if intrabar_path == StrategyIntrabarPath.open_high_low_close:
        if stop_path == "high" and limit_path == "low":
            return "stop", float(stop)
        if limit_path == "high" and stop_path == "low":
            return "limit", float(limit)
    if intrabar_path == StrategyIntrabarPath.open_low_high_close:
        if stop_path == "low" and limit_path == "high":
            return "stop", float(stop)
        if limit_path == "low" and stop_path == "high":
            return "limit", float(limit)
    if same_bar_fill_priority == StrategySameBarPriority.limit_first:
        return "limit", float(limit)
    return "stop", float(stop)


def _normalize_same_bar_fill_priority(value: str) -> str:
    normalized = str(value or "").strip().lower()
    aliases = {
        "stop": StrategySameBarPriority.stop_first,
        "stop_first": StrategySameBarPriority.stop_first,
        "stop-first": StrategySameBarPriority.stop_first,
        "limit": StrategySameBarPriority.limit_first,
        "limit_first": StrategySameBarPriority.limit_first,
        "limit-first": StrategySameBarPriority.limit_first,
    }
    if normalized in aliases:
        return aliases[normalized]
    raise ValueError(
        "same_bar_fill_priority must be strategy.same_bar.stop_first or "
        "strategy.same_bar.limit_first"
    )


def _normalize_intrabar_path(value: str) -> str:
    normalized = str(value or "").strip().lower()
    aliases = {
        "same_bar_priority": StrategyIntrabarPath.same_bar_priority,
        "same-bar-priority": StrategyIntrabarPath.same_bar_priority,
        "priority": StrategyIntrabarPath.same_bar_priority,
        "open_high_low_close": StrategyIntrabarPath.open_high_low_close,
        "ohlc": StrategyIntrabarPath.open_high_low_close,
        "high_low": StrategyIntrabarPath.open_high_low_close,
        "open-high-low-close": StrategyIntrabarPath.open_high_low_close,
        "open_low_high_close": StrategyIntrabarPath.open_low_high_close,
        "open-low-high-close": StrategyIntrabarPath.open_low_high_close,
        "olhc": StrategyIntrabarPath.open_low_high_close,
        "low_high": StrategyIntrabarPath.open_low_high_close,
    }
    if normalized in aliases:
        return aliases[normalized]
    raise ValueError(
        "intrabar_path must be strategy.intrabar.same_bar_priority, "
        "strategy.intrabar.open_high_low_close, or "
        "strategy.intrabar.open_low_high_close"
    )


def _normalize_oca_type(value: str | None) -> str:
    if value is None:
        return StrategyOca.none
    normalized = str(value or "").lower()
    if normalized in {"cancel", "strategy.oca.cancel"}:
        return StrategyOca.cancel
    if normalized in {"reduce", "strategy.oca.reduce"}:
        return StrategyOca.reduce
    if normalized in {"none", "", "strategy.oca.none"}:
        return StrategyOca.none
    raise ValueError("oca_type must be strategy.oca.none, strategy.oca.cancel, or strategy.oca.reduce")


def _apply_oca_after_fill(
    filled_order: dict[str, Any],
    pending_orders: list[dict[str, Any]],
) -> None:
    oca_type = filled_order.get("_oca_type")
    oca_name = str(filled_order.get("_oca_name") or "")
    if not oca_name or oca_type == StrategyOca.none:
        return
    filled_qty = abs(float(filled_order.get("qty", 0.0)))
    for order in pending_orders:
        if order is filled_order:
            continue
        if order.get("_oca_name") != oca_name or order.get("_oca_type") != oca_type:
            continue
        if oca_type == StrategyOca.cancel:
            order["_canceled"] = True
            order["_canceled_time"] = filled_order.get("time")
            order["_canceled_by"] = filled_order.get("id")
        elif oca_type == StrategyOca.reduce:
            remaining = max(float(order.get("qty", 0.0)) - filled_qty, 0.0)
            order["qty"] = remaining
            if remaining <= 0:
                order["_canceled"] = True
                order["_canceled_time"] = filled_order.get("time")
                order["_canceled_by"] = filled_order.get("id")
