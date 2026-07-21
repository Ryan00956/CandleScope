"""Pure replay.v2 value objects and the Phase 0 enum registry."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from types import MappingProxyType
from typing import TypeVar

from app.replay.models import (
    normalize_decimal_string,
    validate_identifier,
    validate_timestamp_ms,
)


REPLAY_V2_PROTOCOL = "replay.v2"
REPLAY_V2_SCHEMA_VERSION = "replay.contract.v2.phase0"
MAX_V2_COUNTER = (1 << 53) - 1


class _StringEnum(str, Enum):
    def __str__(self) -> str:
        return self.value


class RunState(_StringEnum):
    PAUSED = "PAUSED"
    PLAYING = "PLAYING"
    ADVANCING = "ADVANCING"
    ENDED = "ENDED"
    ERROR = "ERROR"


class TrackState(_StringEnum):
    DORMANT = "DORMANT"
    PREPARING = "PREPARING"
    READY = "READY"
    DEGRADED = "DEGRADED"
    ERROR = "ERROR"


class ReplaySource(_StringEnum):
    BAR = "BAR"
    AGG_TRADE = "AGG_TRADE"


class StartMode(_StringEnum):
    MANUAL = "MANUAL"
    RANDOM = "RANDOM"


class IntegrityMode(_StringEnum):
    CHALLENGE = "CHALLENGE"
    PRACTICE = "PRACTICE"
    SANDBOX = "SANDBOX"


class TimeDisclosurePolicy(_StringEnum):
    NONE = "NONE"
    HIDE_YEAR = "HIDE_YEAR"
    HIDE_MONTH = "HIDE_MONTH"
    HIDE_DAY = "HIDE_DAY"
    HIDE_HOUR = "HIDE_HOUR"
    HIDE_MINUTE = "HIDE_MINUTE"
    HIDE_ALL = "HIDE_ALL"


class SubscriptionTier(_StringEnum):
    NONE = "NONE"
    WARM = "WARM"
    FULL = "FULL"


class CapabilityKind(_StringEnum):
    OHLCV = "OHLCV"
    INDICATORS = "INDICATORS"
    AGG_TRADE_TAPE = "AGG_TRADE_TAPE"
    ORDER_FLOW = "ORDER_FLOW"
    OPEN_INTEREST = "OPEN_INTEREST"
    MARKET_LIQUIDATIONS = "MARKET_LIQUIDATIONS"
    MARK_PRICE = "MARK_PRICE"
    INDEX_PRICE = "INDEX_PRICE"
    BASIS = "BASIS"
    FUNDING = "FUNDING"
    ORDER_BOOK = "ORDER_BOOK"
    SIMULATED_LIQUIDATION = "SIMULATED_LIQUIDATION"


class CapabilityState(_StringEnum):
    AVAILABLE_EXACT = "AVAILABLE_EXACT"
    AVAILABLE_APPROX = "AVAILABLE_APPROX"
    UNSUPPORTED_NO_HISTORY = "UNSUPPORTED_NO_HISTORY"
    UNSUPPORTED_SOURCE_MODE = "UNSUPPORTED_SOURCE_MODE"
    LOADING = "LOADING"
    DEGRADED = "DEGRADED"


class FastForwardPlan(_StringEnum):
    CHECKPOINT_JUMP = "CHECKPOINT_JUMP"
    AGGREGATE_SCAN = "AGGREGATE_SCAN"
    FULL_EVENT_SCAN = "FULL_EVENT_SCAN"
    BLOCKED = "BLOCKED"


class BookMode(_StringEnum):
    OFF = "OFF"
    BOOK_ASSISTED_REQUIRED = "BOOK_ASSISTED_REQUIRED"


class MarginMode(_StringEnum):
    CROSS = "CROSS"
    ISOLATED = "ISOLATED"


class ExecutionModelV2(_StringEnum):
    TOUCH_OR_TAPE_V2 = "TOUCH_OR_TAPE_V2"


class ReplayV2CommandType(_StringEnum):
    ACQUIRE_CONTROLLER = "acquire_controller"
    HEARTBEAT_CONTROLLER = "heartbeat_controller"
    RELEASE_CONTROLLER = "release_controller"
    TAKEOVER_CONTROLLER = "takeover_controller"
    PLAY = "play"
    PAUSE = "pause"
    SET_SPEED = "set_speed"
    STEP_EVENT = "step_event"
    STEP_BASE = "step_base"
    STEP_DISPLAY = "step_display"
    ADVANCE_BY = "advance_by"
    ADVANCE_TO = "advance_to"
    CANCEL_ADVANCE = "cancel_advance"
    SELECT_TRACK = "select_track"
    SET_DISPLAY_INTERVAL = "set_display_interval"
    SET_CHART_TYPE = "set_chart_type"
    RECORD_VIEW_ACTION = "record_view_action"
    ADD_TRACK = "add_track"
    SET_SUBSCRIPTION_TIER = "set_subscription_tier"
    REMOVE_UNOWNED_TRACK = "remove_unowned_track"
    PLACE_ORDER = "place_order"
    CANCEL_ORDER = "cancel_order"
    CLOSE_POSITION = "close_position"
    ALLOCATE_ISOLATED_MARGIN = "allocate_isolated_margin"
    DEPOSIT = "deposit"
    WITHDRAW = "withdraw"
    CHANGE_FEE_POLICY = "change_fee_policy"
    CHANGE_LEVERAGE_CAP = "change_leverage_cap"
    CHANGE_FUNDING_POLICY = "change_funding_policy"
    REVEAL_TIME = "reveal_time"
    SAVE = "save"
    END = "end"
    FORK = "fork"
    START_REVIEW = "start_review"


class ReplayV2EventType(_StringEnum):
    RUN_SNAPSHOT = "RUN_SNAPSHOT"
    RUN_STATE_CHANGED = "RUN_STATE_CHANGED"
    TRACK_PROJECTION = "TRACK_PROJECTION"
    ACCOUNT_PROJECTION = "ACCOUNT_PROJECTION"
    AUDIT_EVENT = "AUDIT_EVENT"
    ADVANCE_PROGRESS = "ADVANCE_PROGRESS"
    RESYNC_REQUIRED = "RESYNC_REQUIRED"


_ENUM_TYPES: tuple[tuple[str, type[_StringEnum]], ...] = (
    ("run_state", RunState),
    ("track_state", TrackState),
    ("source_kind", ReplaySource),
    ("start_mode", StartMode),
    ("integrity_mode", IntegrityMode),
    ("time_disclosure_policy", TimeDisclosurePolicy),
    ("subscription_tier", SubscriptionTier),
    ("capability_kind", CapabilityKind),
    ("capability_state", CapabilityState),
    ("fast_forward_plan", FastForwardPlan),
    ("book_mode", BookMode),
    ("margin_mode", MarginMode),
    ("execution_model", ExecutionModelV2),
    ("command_type", ReplayV2CommandType),
    ("event_type", ReplayV2EventType),
)

REPLAY_V2_ENUMS: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {name: tuple(member.value for member in enum_type) for name, enum_type in _ENUM_TYPES}
)

SCHEMA_MIGRATION_CONTRACT: dict[str, object] = {
    "strategy": "ADDITIVE_ONLY",
    "legacy_protocol": "replay.v1",
    "legacy_json_rewrite": False,
    "legacy_tables": [
        "replay_session",
        "replay_dataset_ref",
        "replay_command_log",
        "replay_source_event",
        "replay_checkpoint",
        "replay_mutation_log",
        "replay_order",
        "replay_fill",
        "replay_ledger_entry",
        "replay_journal_entry",
        "replay_report",
    ],
}


_EnumT = TypeVar("_EnumT", bound=Enum)


def expect_mapping(value: object, *, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field_name} must be an object")
    if any(not isinstance(key, str) for key in value):
        raise TypeError(f"{field_name} keys must be strings")
    return value


def expect_exact_keys(payload: Mapping[str, object], expected: set[str]) -> None:
    missing = expected - set(payload)
    unknown = set(payload) - expected
    if missing:
        raise ValueError(f"missing field(s): {', '.join(sorted(missing))}")
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")


def coerce_enum(
    enum_type: type[_EnumT], value: object, *, field_name: str
) -> _EnumT:
    if isinstance(value, enum_type):
        return value
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ValueError(f"unsupported {field_name}: {value}") from exc


def validate_v2_counter(value: object, *, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    if value < 0 or value > MAX_V2_COUNTER:
        raise ValueError(f"{field_name} must be between 0 and {MAX_V2_COUNTER}")
    return value


def validate_positive_decimal(value: object, *, field_name: str) -> str:
    normalized = normalize_decimal_string(value, field_name=field_name)
    if normalized != value:
        raise ValueError(f"{field_name} must be a canonical Decimal string")
    if Decimal(normalized) <= 0:
        raise ValueError(f"{field_name} must be positive")
    return normalized


def freeze_json(value: object, *, field_name: str) -> object:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        validate_v2_counter(abs(value), field_name=field_name)
        return value
    if isinstance(value, float):
        raise TypeError(f"{field_name} cannot contain binary float values")
    if isinstance(value, Mapping):
        frozen: dict[str, object] = {}
        for key, child in value.items():
            if not isinstance(key, str):
                raise TypeError(f"{field_name} object keys must be strings")
            frozen[key] = freeze_json(child, field_name=f"{field_name}.{key}")
        return MappingProxyType(frozen)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return tuple(
            freeze_json(child, field_name=f"{field_name}[{index}]")
            for index, child in enumerate(value)
        )
    raise TypeError(f"{field_name} contains unsupported value {type(value).__name__}")


def thaw_json(value: object) -> object:
    if isinstance(value, Mapping):
        return {key: thaw_json(child) for key, child in value.items()}
    if isinstance(value, tuple):
        return [thaw_json(child) for child in value]
    return value


def normalize_capabilities(
    value: object,
) -> Mapping[CapabilityKind, CapabilityState]:
    payload = expect_mapping(value, field_name="capabilities")
    normalized: dict[CapabilityKind, CapabilityState] = {}
    for raw_kind, raw_state in payload.items():
        kind = coerce_enum(CapabilityKind, raw_kind, field_name="capability kind")
        state = coerce_enum(CapabilityState, raw_state, field_name="capability state")
        normalized[kind] = state
    return MappingProxyType(normalized)


def capabilities_to_dict(
    capabilities: Mapping[CapabilityKind, CapabilityState],
) -> dict[str, str]:
    return {kind.value: state.value for kind, state in capabilities.items()}


_DISCLOSURE_RANK = {
    policy: rank for rank, policy in enumerate(TimeDisclosurePolicy)
}


def ensure_time_disclosure_not_weakened(
    authoritative: TimeDisclosurePolicy | str,
    candidate: TimeDisclosurePolicy | str,
) -> None:
    authoritative_policy = coerce_enum(
        TimeDisclosurePolicy,
        authoritative,
        field_name="authoritative time_disclosure_policy",
    )
    candidate_policy = coerce_enum(
        TimeDisclosurePolicy,
        candidate,
        field_name="candidate time_disclosure_policy",
    )
    if _DISCLOSURE_RANK[candidate_policy] < _DISCLOSURE_RANK[authoritative_policy]:
        raise ValueError("time_disclosure_policy downgrade requires an audited reveal event")


@dataclass(frozen=True, slots=True)
class TrainingCursor:
    virtual_time_ms: int
    source_sequence: int
    revision: int

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "virtual_time_ms",
            validate_timestamp_ms(self.virtual_time_ms, field_name="cursor.virtual_time_ms"),
        )
        object.__setattr__(
            self,
            "source_sequence",
            validate_v2_counter(
                self.source_sequence, field_name="cursor.source_sequence"
            ),
        )
        object.__setattr__(
            self,
            "revision",
            validate_v2_counter(self.revision, field_name="cursor.revision"),
        )

    @classmethod
    def from_dict(cls, value: object) -> "TrainingCursor":
        payload = expect_mapping(value, field_name="cursor")
        expect_exact_keys(payload, {"virtual_time_ms", "source_sequence", "revision"})
        return cls(
            virtual_time_ms=payload["virtual_time_ms"],  # type: ignore[arg-type]
            source_sequence=payload["source_sequence"],  # type: ignore[arg-type]
            revision=payload["revision"],  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, int]:
        return {
            "virtual_time_ms": self.virtual_time_ms,
            "source_sequence": self.source_sequence,
            "revision": self.revision,
        }


@dataclass(frozen=True, slots=True)
class TrainingRunContract:
    protocol: str
    run_id: str
    state: RunState
    source_kind: ReplaySource
    start_mode: StartMode
    book_mode: BookMode
    integrity_mode: IntegrityMode
    time_disclosure_policy: TimeDisclosurePolicy
    initial_equity: str
    active_rule_revision: int
    cursor: TrainingCursor

    def __post_init__(self) -> None:
        if self.protocol != REPLAY_V2_PROTOCOL:
            raise ValueError(f"protocol must be {REPLAY_V2_PROTOCOL}")
        object.__setattr__(
            self, "run_id", validate_identifier(self.run_id, field_name="run_id")
        )
        for field_name, enum_type in (
            ("state", RunState),
            ("source_kind", ReplaySource),
            ("start_mode", StartMode),
            ("book_mode", BookMode),
            ("integrity_mode", IntegrityMode),
            ("time_disclosure_policy", TimeDisclosurePolicy),
        ):
            object.__setattr__(
                self,
                field_name,
                coerce_enum(enum_type, getattr(self, field_name), field_name=field_name),
            )
        object.__setattr__(
            self,
            "initial_equity",
            validate_positive_decimal(self.initial_equity, field_name="initial_equity"),
        )
        object.__setattr__(
            self,
            "active_rule_revision",
            validate_v2_counter(
                self.active_rule_revision, field_name="active_rule_revision"
            ),
        )
        if not isinstance(self.cursor, TrainingCursor):
            raise TypeError("cursor must be TrainingCursor")

    @classmethod
    def from_dict(cls, value: object) -> "TrainingRunContract":
        payload = expect_mapping(value, field_name="run")
        expect_exact_keys(
            payload,
            {
                "protocol",
                "run_id",
                "state",
                "source_kind",
                "start_mode",
                "book_mode",
                "integrity_mode",
                "time_disclosure_policy",
                "initial_equity",
                "active_rule_revision",
                "cursor",
            },
        )
        return cls(
            protocol=payload["protocol"],  # type: ignore[arg-type]
            run_id=payload["run_id"],  # type: ignore[arg-type]
            state=payload["state"],  # type: ignore[arg-type]
            source_kind=payload["source_kind"],  # type: ignore[arg-type]
            start_mode=payload["start_mode"],  # type: ignore[arg-type]
            book_mode=payload["book_mode"],  # type: ignore[arg-type]
            integrity_mode=payload["integrity_mode"],  # type: ignore[arg-type]
            time_disclosure_policy=payload["time_disclosure_policy"],  # type: ignore[arg-type]
            initial_equity=payload["initial_equity"],  # type: ignore[arg-type]
            active_rule_revision=payload["active_rule_revision"],  # type: ignore[arg-type]
            cursor=TrainingCursor.from_dict(payload["cursor"]),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "protocol": self.protocol,
            "run_id": self.run_id,
            "state": self.state.value,
            "source_kind": self.source_kind.value,
            "start_mode": self.start_mode.value,
            "book_mode": self.book_mode.value,
            "integrity_mode": self.integrity_mode.value,
            "time_disclosure_policy": self.time_disclosure_policy.value,
            "initial_equity": self.initial_equity,
            "active_rule_revision": self.active_rule_revision,
            "cursor": self.cursor.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class MarketTrackContract:
    run_id: str
    track_id: str
    state: TrackState
    source_kind: ReplaySource
    subscription_tier: SubscriptionTier
    cursor: TrainingCursor
    forced_full_reasons: tuple[str, ...]
    capabilities: Mapping[CapabilityKind, CapabilityState]

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "run_id", validate_identifier(self.run_id, field_name="run_id")
        )
        object.__setattr__(
            self, "track_id", validate_identifier(self.track_id, field_name="track_id")
        )
        object.__setattr__(
            self, "state", coerce_enum(TrackState, self.state, field_name="state")
        )
        object.__setattr__(
            self,
            "source_kind",
            coerce_enum(ReplaySource, self.source_kind, field_name="source_kind"),
        )
        object.__setattr__(
            self,
            "subscription_tier",
            coerce_enum(
                SubscriptionTier,
                self.subscription_tier,
                field_name="subscription_tier",
            ),
        )
        if not isinstance(self.cursor, TrainingCursor):
            raise TypeError("cursor must be TrainingCursor")
        if not isinstance(self.forced_full_reasons, tuple):
            raise TypeError("forced_full_reasons must be a tuple")
        reasons = tuple(
            validate_identifier(reason, field_name="forced_full_reasons")
            for reason in self.forced_full_reasons
        )
        if len(set(reasons)) != len(reasons):
            raise ValueError("forced_full_reasons must be unique")
        object.__setattr__(self, "forced_full_reasons", reasons)
        object.__setattr__(
            self, "capabilities", normalize_capabilities(self.capabilities)
        )

    @classmethod
    def from_dict(cls, value: object) -> "MarketTrackContract":
        payload = expect_mapping(value, field_name="track")
        expect_exact_keys(
            payload,
            {
                "run_id",
                "track_id",
                "state",
                "source_kind",
                "subscription_tier",
                "cursor",
                "forced_full_reasons",
                "capabilities",
            },
        )
        reasons = payload["forced_full_reasons"]
        if not isinstance(reasons, list):
            raise TypeError("forced_full_reasons must be an array")
        return cls(
            run_id=payload["run_id"],  # type: ignore[arg-type]
            track_id=payload["track_id"],  # type: ignore[arg-type]
            state=payload["state"],  # type: ignore[arg-type]
            source_kind=payload["source_kind"],  # type: ignore[arg-type]
            subscription_tier=payload["subscription_tier"],  # type: ignore[arg-type]
            cursor=TrainingCursor.from_dict(payload["cursor"]),
            forced_full_reasons=tuple(reasons),  # type: ignore[arg-type]
            capabilities=normalize_capabilities(payload["capabilities"]),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "run_id": self.run_id,
            "track_id": self.track_id,
            "state": self.state.value,
            "source_kind": self.source_kind.value,
            "subscription_tier": self.subscription_tier.value,
            "cursor": self.cursor.to_dict(),
            "forced_full_reasons": list(self.forced_full_reasons),
            "capabilities": capabilities_to_dict(self.capabilities),
        }


def validate_track_source(
    run: TrainingRunContract, track: MarketTrackContract
) -> None:
    if run.run_id != track.run_id:
        raise ValueError("track run_id does not match TrainingRun")
    if run.source_kind is not track.source_kind:
        raise ValueError("track source_kind must match TrainingRun source_kind")


__all__ = [
    "BookMode",
    "CapabilityKind",
    "CapabilityState",
    "ExecutionModelV2",
    "FastForwardPlan",
    "IntegrityMode",
    "MAX_V2_COUNTER",
    "MarginMode",
    "MarketTrackContract",
    "REPLAY_V2_ENUMS",
    "REPLAY_V2_PROTOCOL",
    "REPLAY_V2_SCHEMA_VERSION",
    "ReplaySource",
    "ReplayV2CommandType",
    "ReplayV2EventType",
    "RunState",
    "SCHEMA_MIGRATION_CONTRACT",
    "StartMode",
    "SubscriptionTier",
    "TimeDisclosurePolicy",
    "TrackState",
    "TrainingCursor",
    "TrainingRunContract",
    "ensure_time_disclosure_not_weakened",
    "validate_track_source",
]
