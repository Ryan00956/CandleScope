"""Strict replay command payloads and bounded idempotency history."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from types import MappingProxyType
from typing import Mapping

from .canonical import canonical_sha256
from .clock import validate_speed
from .constants import CommandType, SessionState
from .errors import ReplayDomainError, ReplayErrorCode
from .internal_commands import InternalCommandType
from .models import (
    ReplayCommand,
    ReplayCursor,
    normalize_decimal_string,
    validate_counter,
    validate_timestamp_ms,
)


MAX_STEP_COUNT = 100_000
MAX_ADVANCE_MS = 30 * 86_400_000
MAX_JOURNAL_NOTE_CHARS = 4_000
MAX_POLICY_REASON_CHARS = 500
MAX_TRADE_PLAN_REASON_CHARS = 500


_TRADE_PLAN_FIELDS = {
    "schema_version",
    "track_id",
    "client_order_id",
    "side",
    "order_type",
    "sizing_mode",
    "risk_amount",
    "risk_percent",
    "account_equity",
    "entry_price",
    "invalidation_price",
    "target_price",
    "risk_per_unit",
    "reward_risk_ratio",
    "quantity",
    "reason",
}


def _exact_keys(payload: Mapping[str, object], expected: set[str]) -> None:
    actual = set(payload)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        detail = []
        if missing:
            detail.append(f"missing {', '.join(missing)}")
        if unknown:
            detail.append(f"unknown {', '.join(unknown)}")
        raise ReplayDomainError(
            ReplayErrorCode.INVALID_STATE_TRANSITION,
            f"invalid command payload: {'; '.join(detail)}",
        )


def _positive_bounded_int(
    value: object,
    *,
    field_name: str,
    upper_bound: int,
) -> int:
    try:
        normalized = validate_counter(value, field_name=field_name)
    except (TypeError, ValueError) as exc:
        raise ReplayDomainError(
            ReplayErrorCode.INVALID_STATE_TRANSITION,
            f"{field_name} must be a positive integer",
        ) from exc
    if normalized < 1 or normalized > upper_bound:
        raise ReplayDomainError(
            ReplayErrorCode.INVALID_STATE_TRANSITION,
            f"{field_name} must be between 1 and {upper_bound}",
        )
    return normalized


def _optional_order_leverage(payload: Mapping[str, object]) -> str | None:
    leverage = payload.get("leverage")
    if leverage is None:
        return None
    try:
        normalized = normalize_decimal_string(leverage, field_name="leverage")
    except (TypeError, ValueError) as exc:
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            "leverage must be a finite Decimal string",
        ) from exc
    if Decimal(normalized) < 1:
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            "leverage must be at least 1",
        )
    return normalized


def _parse_trade_plan(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            "trade_plan must be an object",
        )
    _exact_keys(value, _TRADE_PLAN_FIELDS)
    if value["schema_version"] != "replay.trade-plan.snapshot.v1":
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            "trade_plan schema is unsupported",
        )
    for field_name in ("track_id", "client_order_id"):
        field_value = value[field_name]
        if (
            not isinstance(field_value, str)
            or not field_value
            or len(field_value) > 128
        ):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                f"trade_plan {field_name} is invalid",
            )
    if value["side"] not in {"BUY", "SELL"}:
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            "trade_plan side is invalid",
        )
    if value["order_type"] not in {"MARKET", "LIMIT"}:
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            "trade_plan order_type is invalid",
        )
    sizing_mode = value["sizing_mode"]
    if sizing_mode not in {"RISK_AMOUNT", "ACCOUNT_RISK_PERCENT"}:
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            "trade_plan sizing_mode is invalid",
        )
    for field_name in (
        "risk_amount",
        "account_equity",
        "entry_price",
        "invalidation_price",
        "target_price",
        "risk_per_unit",
        "reward_risk_ratio",
        "quantity",
    ):
        field_value = value[field_name]
        if not isinstance(field_value, str):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                f"trade_plan {field_name} must be a Decimal string",
            )
        try:
            number = Decimal(field_value)
        except InvalidOperation as exc:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                f"trade_plan {field_name} is invalid",
            ) from exc
        if not number.is_finite() or number <= 0 or format(number, "f") != field_value:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                f"trade_plan {field_name} must be a positive canonical Decimal string",
            )
    risk_percent = value["risk_percent"]
    if sizing_mode == "RISK_AMOUNT":
        if risk_percent is not None:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "fixed-risk trade_plan must not contain risk_percent",
            )
    else:
        if not isinstance(risk_percent, str):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "percentage-risk trade_plan requires risk_percent",
            )
        try:
            percent = Decimal(risk_percent)
        except InvalidOperation as exc:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "trade_plan risk_percent is invalid",
            ) from exc
        if (
            not percent.is_finite()
            or percent <= 0
            or percent > 100
            or format(percent, "f") != risk_percent
        ):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "trade_plan risk_percent must be a canonical value in (0, 100]",
            )
    reason = value["reason"]
    if not isinstance(reason, str):
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            "trade_plan reason must be a string",
        )
    normalized_reason = reason.strip()
    if not normalized_reason or len(normalized_reason) > MAX_TRADE_PLAN_REASON_CHARS:
        raise ReplayDomainError(
            ReplayErrorCode.ORDER_REJECTED,
            f"trade_plan reason must contain 1-{MAX_TRADE_PLAN_REASON_CHARS} characters",
        )
    return {**dict(value), "reason": normalized_reason}


@dataclass(frozen=True, slots=True)
class ParsedCommand:
    type: CommandType | InternalCommandType
    values: Mapping[str, object]

    def __post_init__(self) -> None:
        object.__setattr__(self, "values", MappingProxyType(dict(self.values)))


def parse_command(command: ReplayCommand) -> ParsedCommand:
    if not isinstance(command, ReplayCommand):
        raise TypeError("command must be ReplayCommand")
    payload = command.payload
    command_type = command.type
    if command_type is CommandType.ACQUIRE_CONTROLLER:
        if not payload:
            return ParsedCommand(command_type, {"takeover": False})
        _exact_keys(payload, {"takeover"})
        takeover = payload["takeover"]
        if not isinstance(takeover, bool):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "takeover must be a boolean",
            )
        return ParsedCommand(command_type, {"takeover": takeover})
    if command_type in {
        CommandType.RELEASE_CONTROLLER,
        CommandType.PLAY,
        CommandType.PAUSE,
    }:
        _exact_keys(payload, set())
        return ParsedCommand(command_type, {})
    if command_type is CommandType.SET_SPEED:
        _exact_keys(payload, {"speed"})
        try:
            speed = validate_speed(payload["speed"])
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                str(exc),
            ) from exc
        return ParsedCommand(command_type, {"speed": speed})
    if command_type is CommandType.STEP:
        _exact_keys(payload, {"count"})
        return ParsedCommand(
            command_type,
            {
                "count": _positive_bounded_int(
                    payload["count"],
                    field_name="count",
                    upper_bound=MAX_STEP_COUNT,
                )
            },
        )
    if command_type is CommandType.ADVANCE_BY:
        _exact_keys(payload, {"ms"})
        return ParsedCommand(
            command_type,
            {
                "ms": _positive_bounded_int(
                    payload["ms"],
                    field_name="ms",
                    upper_bound=MAX_ADVANCE_MS,
                )
            },
        )
    if command_type is CommandType.SEEK_TO:
        _exact_keys(payload, {"virtual_time_ms"})
        try:
            target = validate_timestamp_ms(
                payload["virtual_time_ms"],
                field_name="virtual_time_ms",
            )
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "virtual_time_ms is invalid",
            ) from exc
        return ParsedCommand(command_type, {"virtual_time_ms": target})
    if command_type is CommandType.PLACE_ORDER:
        fields = (
            "client_order_id",
            "side",
            "order_type",
            "quantity",
            "reduce_only",
            "limit_price",
            "stop_price",
        )
        expected = set(fields)
        optional = set(payload) & {"trade_plan", "leverage", "position_side"}
        _exact_keys(payload, expected | optional)
        trade_plan = (
            _parse_trade_plan(payload["trade_plan"])
            if "trade_plan" in payload
            else None
        )
        leverage = _optional_order_leverage(payload)
        position_side = payload.get("position_side")
        if position_side is not None and position_side not in {"LONG", "SHORT"}:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "position_side must be LONG, SHORT, or null",
            )
        for field_name in ("client_order_id", "side", "order_type", "quantity"):
            if not isinstance(payload[field_name], str):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    f"{field_name} must be a string",
                )
        if not isinstance(payload["reduce_only"], bool):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "reduce_only must be a boolean",
            )
        for field_name in ("limit_price", "stop_price"):
            if payload[field_name] is not None and not isinstance(
                payload[field_name], str
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    f"{field_name} must be a Decimal string or null",
                )
        return ParsedCommand(
            command_type,
            {
                **{field_name: payload[field_name] for field_name in fields},
                **({} if trade_plan is None else {"trade_plan": trade_plan}),
                **({} if leverage is None else {"leverage": leverage}),
                **({} if position_side is None else {"position_side": position_side}),
            },
        )
    if command_type is CommandType.REPLACE_ORDER:
        fields = (
            "order_id",
            "client_order_id",
            "quantity",
            "limit_price",
            "stop_price",
        )
        _exact_keys(payload, set(fields))
        for field_name in ("order_id", "client_order_id", "quantity"):
            if not isinstance(payload[field_name], str):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    f"{field_name} must be a string",
                )
        for field_name in ("limit_price", "stop_price"):
            if payload[field_name] is not None and not isinstance(
                payload[field_name], str
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    f"{field_name} must be a Decimal string or null",
                )
        return ParsedCommand(
            command_type,
            {field_name: payload[field_name] for field_name in fields},
        )
    if command_type is CommandType.CANCEL_ORDER:
        _exact_keys(payload, {"order_id"})
        if not isinstance(payload["order_id"], str):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "order_id must be a string",
            )
        return ParsedCommand(command_type, {"order_id": payload["order_id"]})
    if command_type is CommandType.CANCEL_ORDERS:
        _exact_keys(payload, {"scope", "order_ids"})
        scope = payload["scope"]
        order_ids = payload["order_ids"]
        if scope not in {"ORDER_IDS", "SELECTED_TRACK"}:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "cancel_orders scope must be ORDER_IDS or SELECTED_TRACK",
            )
        if not isinstance(order_ids, (list, tuple)) or any(
            not isinstance(order_id, str) for order_id in order_ids
        ):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "cancel_orders order_ids must be an array of strings",
            )
        if len(order_ids) != len(set(order_ids)):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "cancel_orders order_ids must be unique",
            )
        if scope == "ORDER_IDS" and not 1 <= len(order_ids) <= 64:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "ORDER_IDS requires between 1 and 64 order_ids",
            )
        if scope == "SELECTED_TRACK" and order_ids:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "SELECTED_TRACK requires an empty order_ids array",
            )
        return ParsedCommand(
            command_type,
            {"scope": scope, "order_ids": tuple(order_ids)},
        )
    if command_type is CommandType.CLOSE_POSITION:
        if not payload:
            return ParsedCommand(command_type, {"quantity": None})
        required = {"quantity"}
        optional = set(payload) & {"position_side"}
        _exact_keys(payload, required | optional)
        if payload["quantity"] is not None and not isinstance(payload["quantity"], str):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "quantity must be a Decimal string or null",
            )
        position_side = payload.get("position_side")
        if position_side is not None and position_side not in {"LONG", "SHORT"}:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "position_side must be LONG, SHORT, or null",
            )
        return ParsedCommand(
            command_type,
            {
                "quantity": payload["quantity"],
                **({} if position_side is None else {"position_side": position_side}),
            },
        )
    if command_type is CommandType.EXECUTE_POSITION_INTENT:
        expected = {"intent", "side", "quantity"}
        optional = set(payload) & {"leverage", "position_side"}
        _exact_keys(payload, expected | optional)
        intent = payload["intent"]
        if intent not in {"OPEN", "CLOSE", "REVERSE"}:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "position intent must be OPEN, CLOSE, or REVERSE",
            )
        side = payload["side"]
        quantity = payload["quantity"]
        leverage = _optional_order_leverage(payload)
        position_side = payload.get("position_side")
        if position_side is not None and position_side not in {"LONG", "SHORT"}:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "position_side must be LONG, SHORT, or null",
            )
        if side is not None and not isinstance(side, str):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "position intent side must be a string or null",
            )
        if quantity is not None and not isinstance(quantity, str):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "position intent quantity must be a Decimal string or null",
            )
        return ParsedCommand(
            command_type,
            {
                "intent": intent,
                "side": side,
                "quantity": quantity,
                **({} if leverage is None else {"leverage": leverage}),
                **({} if position_side is None else {"position_side": position_side}),
            },
        )
    if command_type is CommandType.SET_POSITION_PROTECTION:
        expected = {"quantity", "stop_loss_price", "take_profit_price"}
        optional = set(payload) & {"position_side"}
        _exact_keys(payload, expected | optional)
        for field_name in (
            "quantity",
            "stop_loss_price",
            "take_profit_price",
        ):
            if payload[field_name] is not None and not isinstance(
                payload[field_name], str
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    f"{field_name} must be a Decimal string or null",
                )
        if payload.get("position_side") is not None and payload["position_side"] not in {
            "LONG",
            "SHORT",
        }:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "position_side must be LONG, SHORT, or null",
            )
        return ParsedCommand(
            command_type,
            {
                "quantity": payload["quantity"],
                "stop_loss_price": payload["stop_loss_price"],
                "take_profit_price": payload["take_profit_price"],
                **(
                    {}
                    if payload.get("position_side") is None
                    else {"position_side": payload["position_side"]}
                ),
            },
        )
    if command_type is CommandType.SET_POSITION_LEVERAGE:
        _exact_keys(payload, {"position_side", "leverage"})
        if payload["position_side"] not in {"LONG", "SHORT"}:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "position_side must be LONG or SHORT",
            )
        leverage = _optional_order_leverage(payload)
        if leverage is None:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "leverage is required",
            )
        return ParsedCommand(
            command_type,
            {
                "position_side": payload["position_side"],
                "leverage": leverage,
            },
        )
    if command_type is CommandType.ADD_JOURNAL_NOTE:
        _exact_keys(payload, {"text"})
        text = payload["text"]
        if not isinstance(text, str):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "journal text must be a string",
            )
        normalized = text.strip()
        if not normalized or len(normalized) > MAX_JOURNAL_NOTE_CHARS:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                f"journal text must contain 1-{MAX_JOURNAL_NOTE_CHARS} characters",
            )
        return ParsedCommand(command_type, {"text": normalized})
    if command_type is CommandType.REVEAL_HISTORY:
        _exact_keys(payload, set())
        return ParsedCommand(command_type, {})
    if command_type is InternalCommandType.REVEAL_HISTORY_AUTHORIZED:
        if not payload:
            return ParsedCommand(command_type, {"reason": "user reveal"})
        _exact_keys(payload, {"reason"})
        reason = payload["reason"]
        if not isinstance(reason, str):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "reveal reason must be a string",
            )
        normalized_reason = reason.strip()
        if not normalized_reason or len(normalized_reason) > MAX_POLICY_REASON_CHARS:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                f"reveal reason must contain 1-{MAX_POLICY_REASON_CHARS} characters",
            )
        return ParsedCommand(command_type, {"reason": normalized_reason})
    if command_type is InternalCommandType.ADJUST_CAPITAL:
        _exact_keys(payload, {"kind", "amount", "reason"})
        kind = payload["kind"]
        amount = payload["amount"]
        reason = payload["reason"]
        if kind not in {"deposit", "withdraw"}:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "capital adjustment kind is unsupported",
            )
        if not isinstance(amount, str):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "capital adjustment amount must be a Decimal string",
            )
        try:
            number = Decimal(amount)
        except InvalidOperation as exc:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "capital adjustment amount is invalid",
            ) from exc
        if not number.is_finite() or number <= 0 or format(number, "f") != amount:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "capital adjustment amount must be a positive canonical Decimal string",
            )
        if not isinstance(reason, str):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "capital adjustment reason must be a string",
            )
        normalized_reason = reason.strip()
        if not normalized_reason or len(normalized_reason) > MAX_POLICY_REASON_CHARS:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                f"capital adjustment reason must contain 1-{MAX_POLICY_REASON_CHARS} characters",
            )
        return ParsedCommand(
            command_type,
            {"kind": kind, "amount": amount, "reason": normalized_reason},
        )
    if command_type is InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT:
        _exact_keys(payload, {"count", "tail_events"})
        count = _positive_bounded_int(
            payload["count"],
            field_name="count",
            upper_bound=MAX_STEP_COUNT,
        )
        tail_events = payload["tail_events"]
        if (
            isinstance(tail_events, bool)
            or not isinstance(tail_events, int)
            or tail_events < 0
            or tail_events > count
        ):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "tail_events must be between 0 and count",
            )
        return ParsedCommand(
            command_type,
            {"count": count, "tail_events": tail_events},
        )
    if command_type is InternalCommandType.FAST_FORWARD_FINAL_STATE:
        _exact_keys(
            payload,
            {
                "target_virtual_time_ms",
                "max_events",
                "require_empty_account",
                "snapshot_only",
            },
        )
        try:
            target_virtual_time_ms = validate_timestamp_ms(
                payload["target_virtual_time_ms"],
                field_name="target_virtual_time_ms",
            )
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "target_virtual_time_ms must be a non-negative integer",
            ) from exc
        max_events = _positive_bounded_int(
            payload["max_events"],
            field_name="max_events",
            upper_bound=MAX_STEP_COUNT,
        )
        require_empty_account = payload["require_empty_account"]
        if not isinstance(require_empty_account, bool):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "require_empty_account must be a boolean",
            )
        snapshot_only = payload["snapshot_only"]
        if not isinstance(snapshot_only, bool):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "snapshot_only must be a boolean",
            )
        return ParsedCommand(
            command_type,
            {
                "target_virtual_time_ms": target_virtual_time_ms,
                "max_events": max_events,
                "require_empty_account": require_empty_account,
                "snapshot_only": snapshot_only,
            },
        )
    if command_type is CommandType.END_SESSION:
        if not payload:
            return ParsedCommand(
                command_type,
                {
                    "open_order_disposition": "expire",
                    "position_disposition": "keep",
                },
            )
        _exact_keys(
            payload,
            {"open_order_disposition", "position_disposition"},
        )
        open_disposition = payload["open_order_disposition"]
        position_disposition = payload["position_disposition"]
        if open_disposition not in {"expire", "cancel", "preserve"}:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "open_order_disposition is unsupported",
            )
        if position_disposition not in {"keep", "mark_close"}:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "position_disposition is unsupported",
            )
        return ParsedCommand(
            command_type,
            {
                "open_order_disposition": open_disposition,
                "position_disposition": position_disposition,
            },
        )
    raise ReplayDomainError(
        ReplayErrorCode.INVALID_STATE_TRANSITION,
        f"command {command_type.value} is not available in replay actor phase",
    )


@dataclass(frozen=True, slots=True)
class CommandResult:
    command_id: str
    revision: int
    sequence: int
    state: SessionState
    state_hash: str
    cursor: ReplayCursor
    data: Mapping[str, object]

    def __post_init__(self) -> None:
        state = (
            self.state
            if isinstance(self.state, SessionState)
            else SessionState(self.state)
        )
        object.__setattr__(self, "state", state)
        object.__setattr__(self, "data", MappingProxyType(dict(self.data)))


@dataclass(frozen=True, slots=True)
class _StoredFailure:
    code: ReplayErrorCode
    message: str
    details: Mapping[str, object]

    @classmethod
    def from_error(cls, error: ReplayDomainError) -> "_StoredFailure":
        return cls(error.code, error.message, MappingProxyType(dict(error.details)))

    def raise_error(self) -> None:
        raise ReplayDomainError(self.code, self.message, details=self.details)


@dataclass(frozen=True, slots=True)
class _HistoryRecord:
    fingerprint: str
    result: CommandResult | None
    failure: _StoredFailure | None


class CommandHistory:
    """Bounded fail-closed command ID history; entries are never evicted."""

    def __init__(self, *, max_records: int) -> None:
        if (
            isinstance(max_records, bool)
            or not isinstance(max_records, int)
            or max_records < 1
        ):
            raise ValueError("max_records must be a positive integer")
        self._max_records = max_records
        self._records: dict[str, _HistoryRecord] = {}
        self._replays = 0
        self._reuse_conflicts = 0
        self._capacity_rejections = 0

    def replay(self, command: ReplayCommand) -> CommandResult | None:
        fingerprint = canonical_sha256(command.to_dict())
        record = self._records.get(command.command_id)
        if record is None:
            return None
        if record.fingerprint != fingerprint:
            self._reuse_conflicts += 1
            raise ReplayDomainError(
                ReplayErrorCode.COMMAND_ID_REUSED,
                "command_id was reused with a different canonical command",
                details={"command_id": command.command_id},
            )
        self._replays += 1
        if record.failure is not None:
            record.failure.raise_error()
        assert record.result is not None
        return record.result

    def ensure_capacity(self) -> None:
        """Reject a new command before it can mutate actor-owned state."""
        if len(self._records) >= self._max_records:
            self._capacity_rejections += 1
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "command idempotency history capacity exceeded",
                details={"max_records": self._max_records},
            )

    def record_success(self, command: ReplayCommand, result: CommandResult) -> None:
        self._record(command, result=result, failure=None)

    def record_failure(self, command: ReplayCommand, error: ReplayDomainError) -> None:
        self._record(
            command,
            result=None,
            failure=_StoredFailure.from_error(error),
        )

    def diagnostics(self) -> dict[str, int]:
        return {
            "records": len(self._records),
            "max_records": self._max_records,
            "replays": self._replays,
            "reuse_conflicts": self._reuse_conflicts,
            "capacity_rejections": self._capacity_rejections,
        }

    def _record(
        self,
        command: ReplayCommand,
        *,
        result: CommandResult | None,
        failure: _StoredFailure | None,
    ) -> None:
        if command.command_id in self._records:
            raise RuntimeError("command history record already exists")
        self.ensure_capacity()
        self._records[command.command_id] = _HistoryRecord(
            fingerprint=canonical_sha256(command.to_dict()),
            result=result,
            failure=failure,
        )
