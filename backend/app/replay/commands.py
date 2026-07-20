"""Strict replay command payloads and bounded idempotency history."""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

from .canonical import canonical_sha256
from .clock import validate_speed
from .constants import CommandType, SessionState
from .errors import ReplayDomainError, ReplayErrorCode
from .models import ReplayCommand, ReplayCursor, validate_counter, validate_timestamp_ms


MAX_STEP_COUNT = 100_000
MAX_ADVANCE_MS = 30 * 86_400_000
MAX_JOURNAL_NOTE_CHARS = 4_000


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


@dataclass(frozen=True, slots=True)
class ParsedCommand:
    type: CommandType
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
        _exact_keys(payload, set(fields))
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
    if command_type is CommandType.CLOSE_POSITION:
        if not payload:
            return ParsedCommand(command_type, {"quantity": None})
        _exact_keys(payload, {"quantity"})
        if payload["quantity"] is not None and not isinstance(payload["quantity"], str):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "quantity must be a Decimal string or null",
            )
        return ParsedCommand(command_type, {"quantity": payload["quantity"]})
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
