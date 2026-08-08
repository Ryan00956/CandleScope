"""Pure replay domain value objects and strict wire-value validation."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import Enum
from types import MappingProxyType
from typing import TypeVar

from .constants import (
    REPLAY_PROTOCOL,
    CommandType,
    ExecutionModel,
    QualityMode,
    ReplayEventType,
    SlippageKind,
    SourceKind,
    StartPolicy,
)
from .internal_commands import InternalCommandType


MAX_TIMESTAMP_MS = 253_402_300_799_999
MAX_COUNTER = (1 << 63) - 1
MAX_RANDOM_SEED = (1 << 64) - 1

_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_DECIMAL_PATTERN = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")
_SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_EnumT = TypeVar("_EnumT", bound=Enum)


def validate_identifier(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if not _IDENTIFIER_PATTERN.fullmatch(value):
        raise ValueError(
            f"{field_name} must be 1-128 safe identifier characters"
        )
    return value


def validate_counter(value: object, *, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    if value < 0 or value > MAX_COUNTER:
        raise ValueError(f"{field_name} must be between 0 and {MAX_COUNTER}")
    return value


def validate_timestamp_ms(value: object, *, field_name: str) -> int:
    timestamp = validate_counter(value, field_name=field_name)
    if timestamp > MAX_TIMESTAMP_MS:
        raise ValueError(
            f"{field_name} must be between 0 and {MAX_TIMESTAMP_MS}"
        )
    return timestamp


def normalize_decimal_string(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a Decimal string")
    if not _DECIMAL_PATTERN.fullmatch(value):
        raise ValueError(f"{field_name} must be a finite plain Decimal string")
    try:
        decimal_value = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"{field_name} must be a valid Decimal string") from exc
    if not decimal_value.is_finite():
        raise ValueError(f"{field_name} must be finite")
    if decimal_value == 0:
        return "0"
    normalized = format(decimal_value, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    if normalized.startswith("."):
        normalized = f"0{normalized}"
    if normalized.startswith("-."):
        normalized = f"-0{normalized[1:]}"
    return normalized


def _validate_decimal_bound(
    value: object,
    *,
    field_name: str,
    positive: bool = False,
) -> str:
    normalized = normalize_decimal_string(value, field_name=field_name)
    decimal_value = Decimal(normalized)
    if positive and decimal_value <= 0:
        raise ValueError(f"{field_name} must be positive")
    if not positive and decimal_value < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return normalized


def _coerce_enum(enum_type: type[_EnumT], value: object, *, field_name: str) -> _EnumT:
    if isinstance(value, enum_type):
        return value
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ValueError(f"unsupported {field_name}: {value}") from exc


def _expect_exact_keys(payload: Mapping[str, object], expected: set[str]) -> None:
    missing = expected - set(payload)
    unknown = set(payload) - expected
    if missing:
        raise ValueError(f"missing field(s): {', '.join(sorted(missing))}")
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")


def _freeze_json(value: object, *, field_name: str) -> object:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        raise TypeError(f"{field_name} cannot contain binary float values")
    if isinstance(value, Mapping):
        frozen: dict[str, object] = {}
        for key, child in value.items():
            if not isinstance(key, str):
                raise TypeError(f"{field_name} object keys must be strings")
            frozen[key] = _freeze_json(child, field_name=f"{field_name}.{key}")
        return MappingProxyType(frozen)
    if isinstance(value, (list, tuple)):
        return tuple(
            _freeze_json(child, field_name=f"{field_name}[{index}]")
            for index, child in enumerate(value)
        )
    raise TypeError(f"{field_name} contains unsupported value {type(value).__name__}")


def _thaw_json(value: object) -> object:
    if isinstance(value, Mapping):
        return {key: _thaw_json(child) for key, child in value.items()}
    if isinstance(value, tuple):
        return [_thaw_json(child) for child in value]
    return value


@dataclass(frozen=True, slots=True)
class FeeModel:
    maker_bps: str
    taker_bps: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "maker_bps",
            _validate_decimal_bound(self.maker_bps, field_name="fee_model.maker_bps"),
        )
        object.__setattr__(
            self,
            "taker_bps",
            _validate_decimal_bound(self.taker_bps, field_name="fee_model.taker_bps"),
        )

    @classmethod
    def from_dict(cls, payload: object) -> "FeeModel":
        if not isinstance(payload, Mapping):
            raise TypeError("fee_model must be an object")
        _expect_exact_keys(payload, {"maker_bps", "taker_bps"})
        return cls(
            maker_bps=payload["maker_bps"],  # type: ignore[arg-type]
            taker_bps=payload["taker_bps"],  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, str]:
        return {"maker_bps": self.maker_bps, "taker_bps": self.taker_bps}


@dataclass(frozen=True, slots=True)
class SlippageModel:
    kind: SlippageKind
    market_bps: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "kind",
            _coerce_enum(SlippageKind, self.kind, field_name="slippage_model.kind"),
        )
        object.__setattr__(
            self,
            "market_bps",
            _validate_decimal_bound(
                self.market_bps,
                field_name="slippage_model.market_bps",
            ),
        )

    @classmethod
    def from_dict(cls, payload: object) -> "SlippageModel":
        if not isinstance(payload, Mapping):
            raise TypeError("slippage_model must be an object")
        _expect_exact_keys(payload, {"kind", "market_bps"})
        return cls(
            kind=payload["kind"],  # type: ignore[arg-type]
            market_bps=payload["market_bps"],  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind.value, "market_bps": self.market_bps}


@dataclass(frozen=True, slots=True)
class ReplaySessionConfig:
    protocol: str
    source_kind: SourceKind
    exchange: str
    market_type: str
    symbol: str
    base_interval: str
    display_interval: str
    start_policy: StartPolicy
    requested_start_ms: int | None
    warmup_bars: int
    horizon_ms: int
    random_seed: int
    quality_mode: QualityMode
    blind_mode: bool
    initial_equity: str
    quote_asset: str
    execution_model: ExecutionModel
    fee_model: FeeModel
    slippage_model: SlippageModel
    max_leverage: str
    pause_on_controller_loss: bool
    position_mode: str = field(
        default="ONE_WAY",
        metadata={"canonical_omit_value": "ONE_WAY"},
    )

    def __post_init__(self) -> None:
        if self.protocol != REPLAY_PROTOCOL:
            raise ValueError(f"protocol must be {REPLAY_PROTOCOL}")
        object.__setattr__(
            self,
            "source_kind",
            _coerce_enum(SourceKind, self.source_kind, field_name="source_kind"),
        )
        object.__setattr__(
            self,
            "quality_mode",
            _coerce_enum(QualityMode, self.quality_mode, field_name="quality_mode"),
        )
        object.__setattr__(
            self,
            "execution_model",
            _coerce_enum(
                ExecutionModel,
                self.execution_model,
                field_name="execution_model",
            ),
        )
        object.__setattr__(
            self,
            "start_policy",
            _coerce_enum(StartPolicy, self.start_policy, field_name="start_policy"),
        )
        for field_name in (
            "exchange",
            "market_type",
            "symbol",
            "base_interval",
            "display_interval",
            "quote_asset",
        ):
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
        warmup_bars = validate_counter(self.warmup_bars, field_name="warmup_bars")
        horizon_ms = validate_counter(self.horizon_ms, field_name="horizon_ms")
        if isinstance(self.random_seed, bool) or not isinstance(self.random_seed, int):
            raise TypeError("random_seed must be an integer")
        random_seed = self.random_seed
        if random_seed < 0:
            raise ValueError("random_seed cannot be negative")
        if horizon_ms == 0:
            raise ValueError("horizon_ms must be positive")
        if random_seed > MAX_RANDOM_SEED:
            raise ValueError(f"random_seed must not exceed {MAX_RANDOM_SEED}")
        object.__setattr__(self, "warmup_bars", warmup_bars)
        object.__setattr__(self, "horizon_ms", horizon_ms)
        object.__setattr__(self, "random_seed", random_seed)
        if not isinstance(self.blind_mode, bool):
            raise TypeError("blind_mode must be a boolean")
        if not isinstance(self.pause_on_controller_loss, bool):
            raise TypeError("pause_on_controller_loss must be a boolean")
        if self.position_mode not in {"ONE_WAY", "HEDGE"}:
            raise ValueError("position_mode must be ONE_WAY or HEDGE")
        object.__setattr__(
            self,
            "initial_equity",
            _validate_decimal_bound(
                self.initial_equity,
                field_name="initial_equity",
                positive=True,
            ),
        )
        object.__setattr__(
            self,
            "max_leverage",
            _validate_decimal_bound(
                self.max_leverage,
                field_name="max_leverage",
                positive=True,
            ),
        )
        if not isinstance(self.fee_model, FeeModel):
            raise TypeError("fee_model must be FeeModel")
        if not isinstance(self.slippage_model, SlippageModel):
            raise TypeError("slippage_model must be SlippageModel")

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplaySessionConfig":
        data = dict(payload)
        position_mode = data.pop("position_mode", "ONE_WAY")
        expected = {
            "protocol",
            "source_kind",
            "exchange",
            "market_type",
            "symbol",
            "base_interval",
            "display_interval",
            "start_policy",
            "requested_start_ms",
            "warmup_bars",
            "horizon_ms",
            "random_seed",
            "quality_mode",
            "blind_mode",
            "initial_equity",
            "quote_asset",
            "execution_model",
            "fee_model",
            "slippage_model",
            "max_leverage",
            "pause_on_controller_loss",
        }
        _expect_exact_keys(data, expected)
        return cls(
            protocol=data["protocol"],  # type: ignore[arg-type]
            source_kind=data["source_kind"],  # type: ignore[arg-type]
            exchange=data["exchange"],  # type: ignore[arg-type]
            market_type=data["market_type"],  # type: ignore[arg-type]
            symbol=data["symbol"],  # type: ignore[arg-type]
            base_interval=data["base_interval"],  # type: ignore[arg-type]
            display_interval=data["display_interval"],  # type: ignore[arg-type]
            start_policy=data["start_policy"],  # type: ignore[arg-type]
            requested_start_ms=data["requested_start_ms"],  # type: ignore[arg-type]
            warmup_bars=data["warmup_bars"],  # type: ignore[arg-type]
            horizon_ms=data["horizon_ms"],  # type: ignore[arg-type]
            random_seed=data["random_seed"],  # type: ignore[arg-type]
            quality_mode=data["quality_mode"],  # type: ignore[arg-type]
            blind_mode=data["blind_mode"],  # type: ignore[arg-type]
            initial_equity=data["initial_equity"],  # type: ignore[arg-type]
            quote_asset=data["quote_asset"],  # type: ignore[arg-type]
            execution_model=data["execution_model"],  # type: ignore[arg-type]
            fee_model=FeeModel.from_dict(data["fee_model"]),
            slippage_model=SlippageModel.from_dict(data["slippage_model"]),
            max_leverage=data["max_leverage"],  # type: ignore[arg-type]
            pause_on_controller_loss=data["pause_on_controller_loss"],  # type: ignore[arg-type]
            position_mode=position_mode,  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "protocol": self.protocol,
            "source_kind": self.source_kind.value,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "base_interval": self.base_interval,
            "display_interval": self.display_interval,
            "start_policy": self.start_policy.value,
            "requested_start_ms": self.requested_start_ms,
            "warmup_bars": self.warmup_bars,
            "horizon_ms": self.horizon_ms,
            "random_seed": self.random_seed,
            "quality_mode": self.quality_mode.value,
            "blind_mode": self.blind_mode,
            "initial_equity": self.initial_equity,
            "quote_asset": self.quote_asset,
            "execution_model": self.execution_model.value,
            "fee_model": self.fee_model.to_dict(),
            "slippage_model": self.slippage_model.to_dict(),
            "max_leverage": self.max_leverage,
            "pause_on_controller_loss": self.pause_on_controller_loss,
        }
        if self.position_mode == "HEDGE":
            payload["position_mode"] = self.position_mode
        return payload


@dataclass(frozen=True, slots=True)
class ReplayCursor:
    virtual_time_ms: int
    source_sequence: int
    last_base_bar_open_ms: int | None = None
    last_trade_time_ms: int | None = None
    last_agg_trade_id: int | None = None
    at_end: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "virtual_time_ms",
            validate_timestamp_ms(self.virtual_time_ms, field_name="virtual_time_ms"),
        )
        object.__setattr__(
            self,
            "source_sequence",
            validate_counter(self.source_sequence, field_name="source_sequence"),
        )
        if self.last_base_bar_open_ms is not None:
            object.__setattr__(
                self,
                "last_base_bar_open_ms",
                validate_timestamp_ms(
                    self.last_base_bar_open_ms,
                    field_name="last_base_bar_open_ms",
                ),
            )
        if (self.last_trade_time_ms is None) != (self.last_agg_trade_id is None):
            raise ValueError(
                "last_trade_time_ms and last_agg_trade_id must be present together"
            )
        if self.last_trade_time_ms is not None:
            object.__setattr__(
                self,
                "last_trade_time_ms",
                validate_timestamp_ms(
                    self.last_trade_time_ms,
                    field_name="last_trade_time_ms",
                ),
            )
            object.__setattr__(
                self,
                "last_agg_trade_id",
                validate_counter(
                    self.last_agg_trade_id,
                    field_name="last_agg_trade_id",
                ),
            )
        if not isinstance(self.at_end, bool):
            raise TypeError("at_end must be a boolean")


@dataclass(frozen=True, slots=True)
class ReplayCommand:
    protocol: str
    command_id: str
    client_instance_id: str
    expected_revision: int
    type: CommandType | InternalCommandType
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.protocol != REPLAY_PROTOCOL:
            raise ValueError(f"protocol must be {REPLAY_PROTOCOL}")
        object.__setattr__(
            self,
            "command_id",
            validate_identifier(self.command_id, field_name="command_id"),
        )
        object.__setattr__(
            self,
            "client_instance_id",
            validate_identifier(
                self.client_instance_id,
                field_name="client_instance_id",
            ),
        )
        object.__setattr__(
            self,
            "expected_revision",
            validate_counter(
                self.expected_revision,
                field_name="expected_revision",
            ),
        )
        command_type = self.type
        if not isinstance(command_type, InternalCommandType):
            command_type = _coerce_enum(
                CommandType,
                command_type,
                field_name="command type",
            )
        object.__setattr__(self, "type", command_type)
        if not isinstance(self.payload, Mapping):
            raise TypeError("payload must be an object")
        object.__setattr__(
            self,
            "payload",
            _freeze_json(self.payload, field_name="payload"),
        )

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayCommand":
        _expect_exact_keys(
            payload,
            {
                "protocol",
                "command_id",
                "client_instance_id",
                "expected_revision",
                "type",
                "payload",
            },
        )
        command_type = payload["type"]
        if isinstance(command_type, InternalCommandType):
            raise ValueError("internal command type is not part of replay.v1")
        return cls(
            protocol=payload["protocol"],  # type: ignore[arg-type]
            command_id=payload["command_id"],  # type: ignore[arg-type]
            client_instance_id=payload["client_instance_id"],  # type: ignore[arg-type]
            expected_revision=payload["expected_revision"],  # type: ignore[arg-type]
            type=command_type,  # type: ignore[arg-type]
            payload=payload["payload"],  # type: ignore[arg-type]
        )

    @classmethod
    def from_persisted_dict(cls, payload: Mapping[str, object]) -> "ReplayCommand":
        """Restore a trusted command tail, including training-only commands."""

        command_type = payload.get("type")
        try:
            internal_type = InternalCommandType(command_type)
        except (TypeError, ValueError):
            return cls.from_dict(payload)
        trusted_payload = dict(payload)
        trusted_payload["type"] = internal_type
        _expect_exact_keys(
            trusted_payload,
            {
                "protocol",
                "command_id",
                "client_instance_id",
                "expected_revision",
                "type",
                "payload",
            },
        )
        return cls(
            protocol=trusted_payload["protocol"],  # type: ignore[arg-type]
            command_id=trusted_payload["command_id"],  # type: ignore[arg-type]
            client_instance_id=trusted_payload["client_instance_id"],  # type: ignore[arg-type]
            expected_revision=trusted_payload["expected_revision"],  # type: ignore[arg-type]
            type=internal_type,
            payload=trusted_payload["payload"],  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "protocol": self.protocol,
            "command_id": self.command_id,
            "client_instance_id": self.client_instance_id,
            "expected_revision": self.expected_revision,
            "type": self.type.value,
            "payload": _thaw_json(self.payload),
        }


@dataclass(frozen=True, slots=True)
class ReplayEvent:
    type: ReplayEventType
    protocol: str
    session_id: str
    sequence: int
    revision: int
    virtual_time_ms: int
    state_hash: str
    data_epoch: str
    data: Mapping[str, object]

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "type",
            _coerce_enum(ReplayEventType, self.type, field_name="event type"),
        )
        if self.protocol != REPLAY_PROTOCOL:
            raise ValueError(f"protocol must be {REPLAY_PROTOCOL}")
        object.__setattr__(
            self,
            "session_id",
            validate_identifier(self.session_id, field_name="session_id"),
        )
        object.__setattr__(
            self,
            "sequence",
            validate_counter(self.sequence, field_name="sequence"),
        )
        object.__setattr__(
            self,
            "revision",
            validate_counter(self.revision, field_name="revision"),
        )
        object.__setattr__(
            self,
            "virtual_time_ms",
            validate_timestamp_ms(self.virtual_time_ms, field_name="virtual_time_ms"),
        )
        for field_name in ("state_hash", "data_epoch"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not _SHA256_PATTERN.fullmatch(value):
                raise ValueError(f"{field_name} must be sha256:<64 lowercase hex>")
        if not isinstance(self.data, Mapping):
            raise TypeError("data must be an object")
        object.__setattr__(self, "data", _freeze_json(self.data, field_name="data"))

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayEvent":
        _expect_exact_keys(
            payload,
            {
                "type",
                "protocol",
                "session_id",
                "sequence",
                "revision",
                "virtual_time_ms",
                "state_hash",
                "data_epoch",
                "data",
            },
        )
        return cls(
            type=payload["type"],  # type: ignore[arg-type]
            protocol=payload["protocol"],  # type: ignore[arg-type]
            session_id=payload["session_id"],  # type: ignore[arg-type]
            sequence=payload["sequence"],  # type: ignore[arg-type]
            revision=payload["revision"],  # type: ignore[arg-type]
            virtual_time_ms=payload["virtual_time_ms"],  # type: ignore[arg-type]
            state_hash=payload["state_hash"],  # type: ignore[arg-type]
            data_epoch=payload["data_epoch"],  # type: ignore[arg-type]
            data=payload["data"],  # type: ignore[arg-type]
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "type": self.type.value,
            "protocol": self.protocol,
            "session_id": self.session_id,
            "sequence": self.sequence,
            "revision": self.revision,
            "virtual_time_ms": self.virtual_time_ms,
            "state_hash": self.state_hash,
            "data_epoch": self.data_epoch,
            "data": _thaw_json(self.data),
        }
