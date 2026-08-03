"""Pure replay.v2 value objects and the Phase 0 enum registry."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from types import MappingProxyType
from typing import TypeVar

from app.data_engine.interval_policy import parse_interval_ms
from app.replay.models import (
    normalize_decimal_string,
    validate_identifier,
    validate_timestamp_ms,
)


REPLAY_V2_PROTOCOL = "replay.v2"
REPLAY_V2_SCHEMA_VERSION = "replay.contract.v2.phase0"
REPLAY_LAUNCH_CONTEXT_SCHEMA_VERSION = "replay.launch-context.v1"
REPLAY_WATCHLIST_SNAPSHOT_SCHEMA_VERSION = "replay.watchlist-snapshot.v1"
REPLAY_ACCOUNT_HISTORY_REF_SCHEMA_VERSION = "replay.account-history-ref.v1"
MAX_REPLAY_WATCHLIST_GROUPS = 32
MAX_REPLAY_WATCHLIST_ITEMS = 100
MAX_V2_COUNTER = (1 << 53) - 1
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_MARKET_IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


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


class VisibleHistoryMode(_StringEnum):
    DURATION = "DURATION"
    ALL_AVAILABLE = "ALL_AVAILABLE"


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
    HISTORICAL_MARK_INDEX = "HISTORICAL_MARK_INDEX"
    HISTORICAL_INSTRUMENT_RULE = "HISTORICAL_INSTRUMENT_RULE"


class CapabilityState(_StringEnum):
    AVAILABLE_EXACT = "AVAILABLE_EXACT"
    AVAILABLE_APPROX = "AVAILABLE_APPROX"
    AVAILABLE_EXACT_INPUTS_MODELLED_ACCOUNT = (
        "AVAILABLE_EXACT_INPUTS_MODELLED_ACCOUNT"
    )
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


class FundingMode(_StringEnum):
    OFF = "OFF"
    HISTORICAL_EXACT = "HISTORICAL_EXACT"
    SANDBOX_FIXED = "SANDBOX_FIXED"


class AccountDataMode(_StringEnum):
    APPROX_PROXY = "APPROX_PROXY"
    HISTORICAL_EXACT = "HISTORICAL_EXACT"


class ExecutionModelV2(_StringEnum):
    TOUCH_OR_TAPE_V2 = "TOUCH_OR_TAPE_V2"


class AdvanceBasis(_StringEnum):
    DISPLAY_BAR = "DISPLAY_BAR"
    BASE_BAR = "BASE_BAR"
    SOURCE_EVENT = "SOURCE_EVENT"
    VIRTUAL_TIME = "VIRTUAL_TIME"


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
    ADVANCE = "advance"
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


POLICY_MUTATION_VALUES: tuple[str, ...] = (
    ReplayV2CommandType.DEPOSIT.value,
    ReplayV2CommandType.WITHDRAW.value,
    ReplayV2CommandType.CHANGE_FEE_POLICY.value,
    ReplayV2CommandType.CHANGE_LEVERAGE_CAP.value,
    ReplayV2CommandType.CHANGE_FUNDING_POLICY.value,
    ReplayV2CommandType.REVEAL_TIME.value,
)


_ENUM_TYPES: tuple[tuple[str, type[_StringEnum]], ...] = (
    ("run_state", RunState),
    ("track_state", TrackState),
    ("source_kind", ReplaySource),
    ("start_mode", StartMode),
    ("visible_history_mode", VisibleHistoryMode),
    ("integrity_mode", IntegrityMode),
    ("time_disclosure_policy", TimeDisclosurePolicy),
    ("subscription_tier", SubscriptionTier),
    ("capability_kind", CapabilityKind),
    ("capability_state", CapabilityState),
    ("fast_forward_plan", FastForwardPlan),
    ("book_mode", BookMode),
    ("margin_mode", MarginMode),
    ("funding_mode", FundingMode),
    ("account_data_mode", AccountDataMode),
    ("execution_model", ExecutionModelV2),
    ("advance_basis", AdvanceBasis),
    ("command_type", ReplayV2CommandType),
    ("event_type", ReplayV2EventType),
)

REPLAY_V2_ENUMS: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {name: tuple(member.value for member in enum_type) for name, enum_type in _ENUM_TYPES}
)

ADAPTER_STORAGE_CONTRACT: dict[str, object] = {
    "ownership": "V2_INTERNAL_ADAPTER",
    "adapter_protocol": "replay.v1",
    "public_legacy_import": False,
    "adapter_tables": [
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


def validate_non_negative_decimal(value: object, *, field_name: str) -> str:
    normalized = normalize_decimal_string(value, field_name=field_name)
    if normalized != value:
        raise ValueError(f"{field_name} must be a canonical Decimal string")
    if Decimal(normalized) < 0:
        raise ValueError(f"{field_name} cannot be negative")
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
class ViewerState:
    """Mutable semantic view state kept outside the replay domain hash."""

    run_id: str
    selected_track_id: str
    display_interval: str
    chart_type: str
    visible_range: Mapping[str, object] | None
    pane_layout: Mapping[str, object]
    rail_layout: Mapping[str, object]
    semantic_view_revision: int

    def __post_init__(self) -> None:
        for field_name in (
            "run_id",
            "selected_track_id",
            "display_interval",
            "chart_type",
        ):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )
        if self.visible_range is not None:
            visible = expect_mapping(self.visible_range, field_name="visible_range")
            object.__setattr__(
                self,
                "visible_range",
                freeze_json(visible, field_name="visible_range"),
            )
        for field_name in ("pane_layout", "rail_layout"):
            layout = expect_mapping(getattr(self, field_name), field_name=field_name)
            object.__setattr__(
                self,
                field_name,
                freeze_json(layout, field_name=field_name),
            )
        object.__setattr__(
            self,
            "semantic_view_revision",
            validate_v2_counter(
                self.semantic_view_revision,
                field_name="semantic_view_revision",
            ),
        )

    @classmethod
    def from_dict(cls, value: object) -> "ViewerState":
        payload = expect_mapping(value, field_name="viewer_state")
        expect_exact_keys(
            payload,
            {
                "run_id",
                "selected_track_id",
                "display_interval",
                "chart_type",
                "visible_range",
                "pane_layout",
                "rail_layout",
                "semantic_view_revision",
            },
        )
        return cls(
            run_id=payload["run_id"],  # type: ignore[arg-type]
            selected_track_id=payload["selected_track_id"],  # type: ignore[arg-type]
            display_interval=payload["display_interval"],  # type: ignore[arg-type]
            chart_type=payload["chart_type"],  # type: ignore[arg-type]
            visible_range=(
                None
                if payload["visible_range"] is None
                else expect_mapping(payload["visible_range"], field_name="visible_range")
            ),
            pane_layout=expect_mapping(payload["pane_layout"], field_name="pane_layout"),
            rail_layout=expect_mapping(payload["rail_layout"], field_name="rail_layout"),
            semantic_view_revision=payload["semantic_view_revision"],  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "run_id": self.run_id,
            "selected_track_id": self.selected_track_id,
            "display_interval": self.display_interval,
            "chart_type": self.chart_type,
            "visible_range": thaw_json(self.visible_range),
            "pane_layout": thaw_json(self.pane_layout),
            "rail_layout": thaw_json(self.rail_layout),
            "semantic_view_revision": self.semantic_view_revision,
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


def _display_string(
    value: object,
    *,
    field_name: str,
    max_length: int,
) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > max_length
        or any(ord(char) < 32 or ord(char) == 127 for char in normalized)
    ):
        raise ValueError(
            f"{field_name} must contain 1-{max_length} display-safe characters"
        )
    return normalized


def _market_identity_string(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if not _MARKET_IDENTITY.fullmatch(value):
        raise ValueError(
            f"{field_name} must contain 1-128 market identity characters"
        )
    return value


@dataclass(frozen=True, slots=True)
class ReplayLaunchWatchlistItem:
    exchange: str
    market_type: str
    symbol: str

    def __post_init__(self) -> None:
        for field_name in ("exchange", "market_type", "symbol"):
            object.__setattr__(
                self,
                field_name,
                _market_identity_string(
                    getattr(self, field_name),
                    field_name=field_name,
                ),
            )

    @classmethod
    def from_dict(cls, value: object) -> "ReplayLaunchWatchlistItem":
        payload = expect_mapping(value, field_name="launch watchlist item")
        expect_exact_keys(payload, {"exchange", "market_type", "symbol"})
        return cls(
            exchange=payload["exchange"],  # type: ignore[arg-type]
            market_type=payload["market_type"],  # type: ignore[arg-type]
            symbol=payload["symbol"],  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, str]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
        }


@dataclass(frozen=True, slots=True)
class ReplayLaunchWatchlistGroup:
    id: str
    name: str
    color: str
    items: tuple[ReplayLaunchWatchlistItem, ...]

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "id",
            validate_identifier(self.id, field_name="watchlist group id"),
        )
        object.__setattr__(
            self,
            "name",
            _display_string(
                self.name,
                field_name="watchlist group name",
                max_length=80,
            ),
        )
        object.__setattr__(
            self,
            "color",
            _display_string(
                self.color,
                field_name="watchlist group color",
                max_length=32,
            ),
        )
        if not isinstance(self.items, (tuple, list)):
            raise TypeError("watchlist group items must be an array")
        normalized = tuple(self.items)
        if any(not isinstance(item, ReplayLaunchWatchlistItem) for item in normalized):
            raise TypeError("watchlist group items must be launch watchlist items")
        identities = tuple(
            (item.exchange, item.market_type, item.symbol) for item in normalized
        )
        if len(set(identities)) != len(identities):
            raise ValueError("watchlist group items must be unique")
        object.__setattr__(self, "items", normalized)

    @classmethod
    def from_dict(cls, value: object) -> "ReplayLaunchWatchlistGroup":
        payload = expect_mapping(value, field_name="launch watchlist group")
        expect_exact_keys(payload, {"id", "name", "color", "items"})
        raw_items = payload["items"]
        if not isinstance(raw_items, Sequence) or isinstance(
            raw_items, (str, bytes, bytearray)
        ):
            raise TypeError("watchlist group items must be an array")
        return cls(
            id=payload["id"],  # type: ignore[arg-type]
            name=payload["name"],  # type: ignore[arg-type]
            color=payload["color"],  # type: ignore[arg-type]
            items=tuple(ReplayLaunchWatchlistItem.from_dict(item) for item in raw_items),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "items": [item.to_dict() for item in self.items],
        }


@dataclass(frozen=True, slots=True)
class ReplayWatchlistSnapshot:
    schema_version: str
    groups: tuple[ReplayLaunchWatchlistGroup, ...]

    def __post_init__(self) -> None:
        if self.schema_version != REPLAY_WATCHLIST_SNAPSHOT_SCHEMA_VERSION:
            raise ValueError(
                "watchlist snapshot schema_version must be "
                f"{REPLAY_WATCHLIST_SNAPSHOT_SCHEMA_VERSION}"
            )
        if not isinstance(self.groups, (tuple, list)):
            raise TypeError("watchlist snapshot groups must be an array")
        normalized = tuple(self.groups)
        if any(not isinstance(group, ReplayLaunchWatchlistGroup) for group in normalized):
            raise TypeError("watchlist snapshot groups must be launch watchlist groups")
        if len(normalized) > MAX_REPLAY_WATCHLIST_GROUPS:
            raise ValueError(
                f"watchlist snapshot cannot exceed {MAX_REPLAY_WATCHLIST_GROUPS} groups"
            )
        if sum(len(group.items) for group in normalized) > MAX_REPLAY_WATCHLIST_ITEMS:
            raise ValueError(
                f"watchlist snapshot cannot exceed {MAX_REPLAY_WATCHLIST_ITEMS} items"
            )
        group_ids = tuple(group.id for group in normalized)
        if len(set(group_ids)) != len(group_ids):
            raise ValueError("watchlist snapshot group ids must be unique")
        object.__setattr__(self, "groups", normalized)

    @classmethod
    def from_dict(cls, value: object) -> "ReplayWatchlistSnapshot":
        payload = expect_mapping(value, field_name="watchlist snapshot")
        expect_exact_keys(payload, {"schema_version", "groups"})
        raw_groups = payload["groups"]
        if not isinstance(raw_groups, Sequence) or isinstance(
            raw_groups, (str, bytes, bytearray)
        ):
            raise TypeError("watchlist snapshot groups must be an array")
        return cls(
            schema_version=payload["schema_version"],  # type: ignore[arg-type]
            groups=tuple(ReplayLaunchWatchlistGroup.from_dict(group) for group in raw_groups),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "groups": [group.to_dict() for group in self.groups],
        }


@dataclass(frozen=True, slots=True)
class ReplayLaunchContext:
    schema_version: str
    source: str
    exchange: str
    market_type: str
    symbol: str
    display_interval: str
    watchlist_snapshot: ReplayWatchlistSnapshot

    def __post_init__(self) -> None:
        if self.schema_version != REPLAY_LAUNCH_CONTEXT_SCHEMA_VERSION:
            raise ValueError(
                "launch context schema_version must be "
                f"{REPLAY_LAUNCH_CONTEXT_SCHEMA_VERSION}"
            )
        if self.source not in {"LIVE_PAGE", "DIRECT_HUB"}:
            raise ValueError("launch context source is unsupported")
        for field_name in ("exchange", "market_type", "symbol"):
            object.__setattr__(
                self,
                field_name,
                _market_identity_string(
                    getattr(self, field_name),
                    field_name=field_name,
                ),
            )
        object.__setattr__(
            self,
            "display_interval",
            validate_identifier(
                self.display_interval,
                field_name="display_interval",
            ),
        )
        if not isinstance(self.watchlist_snapshot, ReplayWatchlistSnapshot):
            raise TypeError("watchlist_snapshot must be a ReplayWatchlistSnapshot")

    @classmethod
    def from_dict(cls, value: object) -> "ReplayLaunchContext":
        payload = expect_mapping(value, field_name="replay launch context")
        expect_exact_keys(
            payload,
            {
                "schema_version",
                "source",
                "exchange",
                "market_type",
                "symbol",
                "display_interval",
                "watchlist_snapshot",
            },
        )
        return cls(
            schema_version=payload["schema_version"],  # type: ignore[arg-type]
            source=payload["source"],  # type: ignore[arg-type]
            exchange=payload["exchange"],  # type: ignore[arg-type]
            market_type=payload["market_type"],  # type: ignore[arg-type]
            symbol=payload["symbol"],  # type: ignore[arg-type]
            display_interval=payload["display_interval"],  # type: ignore[arg-type]
            watchlist_snapshot=ReplayWatchlistSnapshot.from_dict(
                payload["watchlist_snapshot"]
            ),
        )

    @classmethod
    def direct_hub(
        cls,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        display_interval: str,
    ) -> "ReplayLaunchContext":
        return cls(
            schema_version=REPLAY_LAUNCH_CONTEXT_SCHEMA_VERSION,
            source="DIRECT_HUB",
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            display_interval=display_interval,
            watchlist_snapshot=ReplayWatchlistSnapshot(
                schema_version=REPLAY_WATCHLIST_SNAPSHOT_SCHEMA_VERSION,
                groups=(),
            ),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "source": self.source,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "display_interval": self.display_interval,
            "watchlist_snapshot": self.watchlist_snapshot.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class VisibleHistoryLookback:
    mode: VisibleHistoryMode
    duration_ms: int | None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "mode",
            coerce_enum(
                VisibleHistoryMode,
                self.mode,
                field_name="visible_history_lookback.mode",
            ),
        )
        if self.mode is VisibleHistoryMode.ALL_AVAILABLE:
            if self.duration_ms is not None:
                raise ValueError(
                    "ALL_AVAILABLE visible history cannot include duration_ms"
                )
            return
        if self.duration_ms is None:
            raise ValueError("DURATION visible history requires duration_ms")
        duration_ms = validate_v2_counter(
            self.duration_ms,
            field_name="visible_history_lookback.duration_ms",
        )
        if duration_ms < 1:
            raise ValueError("visible history duration_ms must be positive")
        object.__setattr__(self, "duration_ms", duration_ms)

    @classmethod
    def from_dict(cls, value: object) -> "VisibleHistoryLookback":
        payload = expect_mapping(value, field_name="visible_history_lookback")
        expect_exact_keys(payload, {"mode", "duration_ms"})
        return cls(
            mode=payload["mode"],  # type: ignore[arg-type]
            duration_ms=payload["duration_ms"],  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "mode": self.mode.value,
            "duration_ms": self.duration_ms,
        }


@dataclass(frozen=True, slots=True)
class AccountHistoryRef:
    schema_version: str
    archive_id: str
    dataset_epoch: str
    checksum_sha256: str

    def __post_init__(self) -> None:
        if self.schema_version != REPLAY_ACCOUNT_HISTORY_REF_SCHEMA_VERSION:
            raise ValueError(
                "account history ref schema_version is unsupported"
            )
        object.__setattr__(
            self,
            "archive_id",
            validate_identifier(self.archive_id, field_name="account_history_ref.archive_id"),
        )
        for field_name in ("dataset_epoch", "checksum_sha256"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or _DIGEST.fullmatch(value) is None:
                raise ValueError(
                    f"account_history_ref.{field_name} must be a sha256 digest"
                )

    @classmethod
    def from_dict(cls, value: object) -> "AccountHistoryRef":
        payload = expect_mapping(value, field_name="account_history_ref")
        expect_exact_keys(
            payload,
            {
                "schema_version",
                "archive_id",
                "dataset_epoch",
                "checksum_sha256",
            },
        )
        return cls(**payload)  # type: ignore[arg-type]

    def to_dict(self) -> dict[str, str]:
        return {
            "schema_version": self.schema_version,
            "archive_id": self.archive_id,
            "dataset_epoch": self.dataset_epoch,
            "checksum_sha256": self.checksum_sha256,
        }


@dataclass(frozen=True, slots=True)
class TrainingRunCreateRequest:
    """Replay training create contract mapped to one replay.v1 adapter session."""

    protocol: str
    catalog_epoch: str
    name: str | None
    source_kind: ReplaySource
    start_mode: StartMode
    exchange: str
    market_type: str
    symbol: str
    settlement_asset: str
    base_interval: str
    display_interval: str
    requested_start_ms: int | None
    warmup_bars: int
    forward_cache_ms: int
    random_seed: int | None
    initial_equity: str
    max_leverage: str
    maker_fee_bps: str
    taker_fee_bps: str
    market_slippage_bps: str
    integrity_mode: IntegrityMode
    time_disclosure_policy: TimeDisclosurePolicy
    book_mode: BookMode
    margin_mode: MarginMode
    funding_mode: FundingMode
    allow_rule_changes: bool
    account_data_mode: AccountDataMode = AccountDataMode.APPROX_PROXY
    account_history_ref: "AccountHistoryRef | None" = None
    fixed_funding_rate: str | None = None
    funding_interval_ms: int | None = None
    allowed_mutations: tuple[str, ...] = ()
    launch_context: ReplayLaunchContext | None = None
    visible_history_lookback: "VisibleHistoryLookback | None" = None

    def __post_init__(self) -> None:
        if self.protocol != REPLAY_V2_PROTOCOL:
            raise ValueError(f"protocol must be {REPLAY_V2_PROTOCOL}")
        if not isinstance(self.catalog_epoch, str) or not _DIGEST.fullmatch(
            self.catalog_epoch
        ):
            raise ValueError("catalog_epoch must be a sha256 digest")
        if self.name is not None:
            if not isinstance(self.name, str):
                raise TypeError("name must be a string or null")
            name = self.name.strip()
            if not name or len(name) > 80 or any(ord(char) < 32 for char in name):
                raise ValueError("name must contain 1-80 display-safe characters")
            object.__setattr__(self, "name", name)
        for field_name, enum_type in (
            ("source_kind", ReplaySource),
            ("start_mode", StartMode),
            ("integrity_mode", IntegrityMode),
            ("time_disclosure_policy", TimeDisclosurePolicy),
            ("book_mode", BookMode),
            ("margin_mode", MarginMode),
            ("funding_mode", FundingMode),
            ("account_data_mode", AccountDataMode),
        ):
            object.__setattr__(
                self,
                field_name,
                coerce_enum(enum_type, getattr(self, field_name), field_name=field_name),
            )
        for field_name in ("exchange", "market_type", "symbol"):
            object.__setattr__(
                self,
                field_name,
                _market_identity_string(
                    getattr(self, field_name),
                    field_name=field_name,
                ),
            )
        for field_name in ("settlement_asset", "base_interval", "display_interval"):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )
        if self.requested_start_ms is not None:
            object.__setattr__(
                self,
                "requested_start_ms",
                validate_timestamp_ms(
                    self.requested_start_ms,
                    field_name="requested_start_ms",
                ),
            )
        if self.start_mode is StartMode.MANUAL and self.requested_start_ms is None:
            raise ValueError("MANUAL start requires requested_start_ms")
        if self.start_mode is StartMode.RANDOM and self.requested_start_ms is not None:
            raise ValueError("RANDOM start cannot include requested_start_ms")
        warmup = validate_v2_counter(self.warmup_bars, field_name="warmup_bars")
        forward_cache = validate_v2_counter(
            self.forward_cache_ms, field_name="forward_cache_ms"
        )
        random_seed = (
            None
            if self.random_seed is None
            else validate_v2_counter(self.random_seed, field_name="random_seed")
        )
        if warmup < 1:
            raise ValueError("warmup_bars must be positive")
        if forward_cache < 1:
            raise ValueError("forward_cache_ms must be positive")
        object.__setattr__(self, "warmup_bars", warmup)
        object.__setattr__(self, "forward_cache_ms", forward_cache)
        object.__setattr__(self, "random_seed", random_seed)
        visible_history = self.visible_history_lookback
        if visible_history is None:
            interval_ms = parse_interval_ms(self.base_interval)
            if interval_ms is None:
                raise ValueError("base_interval must be a fixed replay interval")
            visible_history = VisibleHistoryLookback(
                mode=VisibleHistoryMode.DURATION,
                duration_ms=warmup * interval_ms,
            )
        elif not isinstance(visible_history, VisibleHistoryLookback):
            raise TypeError(
                "visible_history_lookback must be a VisibleHistoryLookback"
            )
        object.__setattr__(self, "visible_history_lookback", visible_history)
        for field_name in ("initial_equity", "max_leverage"):
            object.__setattr__(
                self,
                field_name,
                validate_positive_decimal(
                    getattr(self, field_name), field_name=field_name
                ),
            )
        for field_name in (
            "maker_fee_bps",
            "taker_fee_bps",
            "market_slippage_bps",
        ):
            object.__setattr__(
                self,
                field_name,
                validate_non_negative_decimal(
                    getattr(self, field_name), field_name=field_name
                ),
            )
        raw_allowed = self.allowed_mutations
        if not isinstance(raw_allowed, (tuple, list)) or any(
            not isinstance(value, str) for value in raw_allowed
        ):
            raise TypeError("allowed_mutations must be an array of strings")
        allowed = tuple(raw_allowed)
        if len(set(allowed)) != len(allowed):
            raise ValueError("allowed_mutations must be unique")
        unsupported = set(allowed) - set(POLICY_MUTATION_VALUES)
        if unsupported:
            raise ValueError(
                f"unsupported allowed mutation(s): {', '.join(sorted(unsupported))}"
            )
        if self.integrity_mode is IntegrityMode.CHALLENGE:
            if allowed or self.allow_rule_changes:
                raise ValueError("CHALLENGE integrity mode locks all policy mutations")
        elif self.integrity_mode is IntegrityMode.PRACTICE:
            if self.allow_rule_changes is not bool(allowed):
                raise ValueError(
                    "PRACTICE allow_rule_changes must match allowed_mutations"
                )
        else:
            allowed = POLICY_MUTATION_VALUES
            object.__setattr__(self, "allow_rule_changes", True)
        object.__setattr__(self, "allowed_mutations", allowed)
        if self.funding_mode is FundingMode.SANDBOX_FIXED:
            if self.integrity_mode is not IntegrityMode.SANDBOX:
                raise ValueError("SANDBOX_FIXED funding requires SANDBOX integrity mode")
            if self.fixed_funding_rate is None or self.funding_interval_ms is None:
                raise ValueError(
                    "SANDBOX_FIXED funding requires rate and interval"
                )
            object.__setattr__(
                self,
                "fixed_funding_rate",
                normalize_decimal_string(
                    self.fixed_funding_rate,
                    field_name="fixed_funding_rate",
                ),
            )
            interval = validate_v2_counter(
                self.funding_interval_ms,
                field_name="funding_interval_ms",
            )
            if interval < 60_000 or interval > 30 * 86_400_000:
                raise ValueError("funding_interval_ms is outside supported bounds")
            object.__setattr__(self, "funding_interval_ms", interval)
        elif self.fixed_funding_rate is not None or self.funding_interval_ms is not None:
            raise ValueError(
                "fixed funding fields are available only for SANDBOX_FIXED"
            )
        if self.account_history_ref is not None and not isinstance(
            self.account_history_ref,
            AccountHistoryRef,
        ):
            raise TypeError("account_history_ref must be an AccountHistoryRef or null")
        if self.account_data_mode is AccountDataMode.APPROX_PROXY:
            if self.account_history_ref is not None:
                raise ValueError(
                    "APPROX_PROXY account data cannot carry an exact history ref"
                )
        elif self.funding_mode is FundingMode.SANDBOX_FIXED:
            raise ValueError(
                "HISTORICAL_EXACT account data cannot use synthetic Sandbox funding"
            )
        if self.launch_context is not None:
            if not isinstance(self.launch_context, ReplayLaunchContext):
                raise TypeError("launch_context must be a ReplayLaunchContext or null")
            if (
                self.launch_context.exchange != self.exchange
                or self.launch_context.market_type != self.market_type
                or self.launch_context.symbol != self.symbol
                or self.launch_context.display_interval != self.display_interval
            ):
                raise ValueError(
                    "launch_context primary identity must match the training request"
                )

    @classmethod
    def from_dict(cls, value: object) -> "TrainingRunCreateRequest":
        payload = expect_mapping(value, field_name="training run create")
        required = {
            "protocol",
            "catalog_epoch",
            "name",
            "source_kind",
            "start_mode",
            "exchange",
            "market_type",
            "symbol",
            "settlement_asset",
            "base_interval",
            "display_interval",
            "requested_start_ms",
            "forward_cache_ms",
            "initial_equity",
            "max_leverage",
            "maker_fee_bps",
            "taker_fee_bps",
            "market_slippage_bps",
            "integrity_mode",
            "time_disclosure_policy",
            "book_mode",
            "margin_mode",
            "funding_mode",
            "allow_rule_changes",
        }
        warmup_fields = {
            field_name
            for field_name in ("warmup_bars", "indicator_warmup_bars")
            if field_name in payload and payload[field_name] is not None
        }
        if len(warmup_fields) != 1:
            raise ValueError(
                "exactly one of warmup_bars or indicator_warmup_bars is required"
            )
        missing = required - set(payload)
        unknown = set(payload) - required - {
            "warmup_bars",
            "indicator_warmup_bars",
            "visible_history_lookback",
            "random_seed",
            "allowed_mutations",
            "fixed_funding_rate",
            "funding_interval_ms",
            "account_data_mode",
            "account_history_ref",
            "launch_context",
        }
        if missing:
            raise ValueError(f"missing field(s): {', '.join(sorted(missing))}")
        if unknown:
            raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
        normalized = dict(payload)
        normalized["warmup_bars"] = normalized.pop(
            next(iter(warmup_fields))
        )
        normalized.pop("indicator_warmup_bars", None)
        raw_visible_history = normalized.get("visible_history_lookback")
        normalized["visible_history_lookback"] = (
            None
            if raw_visible_history is None
            else VisibleHistoryLookback.from_dict(raw_visible_history)
        )
        normalized.setdefault("random_seed", None)
        raw_allowed = normalized.get("allowed_mutations", ())
        if not isinstance(raw_allowed, (list, tuple)):
            raise TypeError("allowed_mutations must be an array")
        normalized["allowed_mutations"] = tuple(raw_allowed)
        raw_launch_context = normalized.get("launch_context")
        normalized["launch_context"] = (
            None
            if raw_launch_context is None
            else ReplayLaunchContext.from_dict(raw_launch_context)
        )
        normalized.setdefault("account_data_mode", AccountDataMode.APPROX_PROXY.value)
        raw_account_history_ref = normalized.get("account_history_ref")
        normalized["account_history_ref"] = (
            None
            if raw_account_history_ref is None
            else AccountHistoryRef.from_dict(raw_account_history_ref)
        )
        return cls(**normalized)  # type: ignore[arg-type]

    def resolved_launch_context(self) -> ReplayLaunchContext:
        return self.launch_context or ReplayLaunchContext.direct_hub(
            exchange=self.exchange,
            market_type=self.market_type,
            symbol=self.symbol,
            display_interval=self.display_interval,
        )

    @property
    def indicator_warmup_bars(self) -> int:
        """Canonical Phase 14 name for the legacy internal warmup field."""

        return self.warmup_bars

    def to_dict(self, *, redact_hidden_start: bool = False) -> dict[str, object]:
        hidden = self.time_disclosure_policy is not TimeDisclosurePolicy.NONE
        return {
            "protocol": self.protocol,
            "catalog_epoch": self.catalog_epoch,
            "name": self.name,
            "source_kind": self.source_kind.value,
            "start_mode": self.start_mode.value,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "settlement_asset": self.settlement_asset,
            "base_interval": self.base_interval,
            "display_interval": self.display_interval,
            "requested_start_ms": (
                None if redact_hidden_start and hidden else self.requested_start_ms
            ),
            "indicator_warmup_bars": self.warmup_bars,
            "visible_history_lookback": self.visible_history_lookback.to_dict(),
            "forward_cache_ms": self.forward_cache_ms,
            "random_seed": (
                None if redact_hidden_start and hidden else self.random_seed
            ),
            "initial_equity": self.initial_equity,
            "max_leverage": self.max_leverage,
            "maker_fee_bps": self.maker_fee_bps,
            "taker_fee_bps": self.taker_fee_bps,
            "market_slippage_bps": self.market_slippage_bps,
            "integrity_mode": self.integrity_mode.value,
            "time_disclosure_policy": self.time_disclosure_policy.value,
            "book_mode": self.book_mode.value,
            "margin_mode": self.margin_mode.value,
            "funding_mode": self.funding_mode.value,
            "account_data_mode": self.account_data_mode.value,
            "account_history_ref": (
                None
                if self.account_history_ref is None
                else self.account_history_ref.to_dict()
            ),
            "fixed_funding_rate": self.fixed_funding_rate,
            "funding_interval_ms": self.funding_interval_ms,
            "allow_rule_changes": self.allow_rule_changes,
            "allowed_mutations": list(self.allowed_mutations),
        }


__all__ = [
    "AccountDataMode",
    "AccountHistoryRef",
    "AdvanceBasis",
    "BookMode",
    "CapabilityKind",
    "CapabilityState",
    "ExecutionModelV2",
    "FastForwardPlan",
    "FundingMode",
    "IntegrityMode",
    "MAX_V2_COUNTER",
    "MarginMode",
    "MarketTrackContract",
    "REPLAY_V2_ENUMS",
    "REPLAY_V2_PROTOCOL",
    "REPLAY_V2_SCHEMA_VERSION",
    "REPLAY_LAUNCH_CONTEXT_SCHEMA_VERSION",
    "REPLAY_ACCOUNT_HISTORY_REF_SCHEMA_VERSION",
    "REPLAY_WATCHLIST_SNAPSHOT_SCHEMA_VERSION",
    "ReplayLaunchContext",
    "ReplayLaunchWatchlistGroup",
    "ReplayLaunchWatchlistItem",
    "ReplayWatchlistSnapshot",
    "ReplaySource",
    "ReplayV2CommandType",
    "ReplayV2EventType",
    "RunState",
    "POLICY_MUTATION_VALUES",
    "ADAPTER_STORAGE_CONTRACT",
    "StartMode",
    "SubscriptionTier",
    "TimeDisclosurePolicy",
    "TrackState",
    "TrainingCursor",
    "TrainingRunCreateRequest",
    "TrainingRunContract",
    "VisibleHistoryLookback",
    "VisibleHistoryMode",
    "ViewerState",
    "ensure_time_disclosure_not_weakened",
    "validate_track_source",
]
