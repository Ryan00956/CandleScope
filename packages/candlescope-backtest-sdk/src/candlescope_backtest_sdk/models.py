"""Author-facing Observation, Context, outputs, and execution report."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .contract import (
    CONTEXT_SCHEMA,
    EXECUTION_REPORT_SCHEMA,
    OBSERVATION_SCHEMA,
    ORDER_SIDES,
    ORDER_TYPES,
    OUTPUT_SCHEMA,
    SIGNAL_DIRECTIONS,
    TIME_IN_FORCE,
)
from .errors import PythonStrategyContractError
from .json_codec import canonical_sha256, dumps_canonical


def _require_mapping(value: Mapping[str, Any], allowed: frozenset[str], label: str) -> dict[str, Any]:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise PythonStrategyContractError(
            "UNKNOWN_FIELD",
            f"{label} has unknown fields: {', '.join(unknown)}",
        )
    return dict(value)


def _decimal_string(value: Any, label: str) -> str:
    text = str(value).strip()
    if not text or text.lower() in {"nan", "inf", "+inf", "-inf", "infinity", "-infinity"}:
        raise PythonStrategyContractError(
            "NON_FINITE_NUMBER",
            f"{label} must be a finite decimal string",
        )
    try:
        from decimal import Decimal

        parsed = Decimal(text)
    except Exception as exc:
        raise PythonStrategyContractError(
            "INVALID_DECIMAL",
            f"{label} must be a finite decimal string",
        ) from exc
    if not parsed.is_finite():
        raise PythonStrategyContractError(
            "NON_FINITE_NUMBER",
            f"{label} must be a finite decimal string",
        )
    return format(parsed, "f")


@dataclass(frozen=True, slots=True)
class Bar:
    open_time_ms: int
    close_time_ms: int
    open: str
    high: str
    low: str
    close: str
    volume: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "openTimeMs": self.open_time_ms,
            "closeTimeMs": self.close_time_ms,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> "Bar":
        payload = _require_mapping(
            value,
            frozenset(
                {
                    "openTimeMs",
                    "closeTimeMs",
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                }
            ),
            "bar",
        )
        return cls(
            open_time_ms=int(payload["openTimeMs"]),
            close_time_ms=int(payload["closeTimeMs"]),
            open=_decimal_string(payload["open"], "bar.open"),
            high=_decimal_string(payload["high"], "bar.high"),
            low=_decimal_string(payload["low"], "bar.low"),
            close=_decimal_string(payload["close"], "bar.close"),
            volume=_decimal_string(payload["volume"], "bar.volume"),
        )


@dataclass(frozen=True, slots=True)
class Observation:
    run_id: str
    revision_id: str
    generation: int
    sequence: int
    event_time_ms: int
    watermark_ms: int
    phase: str
    market: Mapping[str, str]
    bar: Bar
    features: Mapping[str, str] = field(default_factory=dict)
    account_view: Mapping[str, str] = field(default_factory=dict)
    input_hash: str = ""

    def to_wire(self) -> dict[str, Any]:
        wire = {
            "schemaVersion": OBSERVATION_SCHEMA,
            "runId": self.run_id,
            "revisionId": self.revision_id,
            "generation": self.generation,
            "sequence": self.sequence,
            "eventTimeMs": self.event_time_ms,
            "watermarkMs": self.watermark_ms,
            "phase": self.phase,
            "market": dict(self.market),
            "bar": self.bar.to_wire(),
            "features": dict(self.features),
            "accountView": dict(self.account_view),
            "inputHash": self.input_hash,
        }
        if not self.input_hash:
            wire["inputHash"] = canonical_sha256(
                {key: value for key, value in wire.items() if key != "inputHash"}
            )
        return wire

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> "Observation":
        payload = _require_mapping(
            value,
            frozenset(
                {
                    "schemaVersion",
                    "runId",
                    "revisionId",
                    "generation",
                    "sequence",
                    "eventTimeMs",
                    "watermarkMs",
                    "phase",
                    "market",
                    "bar",
                    "features",
                    "accountView",
                    "inputHash",
                }
            ),
            "observation",
        )
        if payload.get("schemaVersion") != OBSERVATION_SCHEMA:
            raise PythonStrategyContractError(
                "SCHEMA_UNKNOWN_FIELD",
                "observation schemaVersion must be candlescope.python-strategy-observation/1",
            )
        bar = payload.get("bar")
        if not isinstance(bar, Mapping):
            raise PythonStrategyContractError("INVALID_BAR", "observation.bar is required")
        return cls(
            run_id=str(payload["runId"]),
            revision_id=str(payload["revisionId"]),
            generation=int(payload["generation"]),
            sequence=int(payload["sequence"]),
            event_time_ms=int(payload["eventTimeMs"]),
            watermark_ms=int(payload["watermarkMs"]),
            phase=str(payload["phase"]),
            market=dict(payload.get("market") or {}),
            bar=Bar.from_wire(bar),
            features=dict(payload.get("features") or {}),
            account_view=dict(payload.get("accountView") or {}),
            input_hash=str(payload.get("inputHash") or ""),
        )


@dataclass(frozen=True, slots=True)
class StrategyContext:
    run_id: str
    revision_id: str
    parameters: Mapping[str, Any]
    seed: str | None = None
    reproducibility: str = "DETERMINISTIC_CPU_LOCKED"

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": CONTEXT_SCHEMA,
            "runId": self.run_id,
            "revisionId": self.revision_id,
            "parameters": dict(self.parameters),
            "seed": self.seed,
            "reproducibility": self.reproducibility,
        }


@dataclass(frozen=True, slots=True)
class Signal:
    direction: str
    score: str = "0"
    confidence: str = "0"
    horizon: str = "1"

    def __post_init__(self) -> None:
        if self.direction not in SIGNAL_DIRECTIONS:
            raise PythonStrategyContractError(
                "INVALID_SIGNAL_DIRECTION",
                "SIGNAL direction must be LONG, SHORT, or FLAT",
            )
        object.__setattr__(self, "score", _decimal_string(self.score, "score"))
        object.__setattr__(self, "confidence", _decimal_string(self.confidence, "confidence"))
        object.__setattr__(self, "horizon", _decimal_string(self.horizon, "horizon"))

    def to_payload(self) -> dict[str, Any]:
        return {
            "direction": self.direction,
            "score": self.score,
            "confidence": self.confidence,
            "horizon": self.horizon,
        }


@dataclass(frozen=True, slots=True)
class TargetPosition:
    quantity: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "quantity", _decimal_string(self.quantity, "quantity"))

    def to_payload(self) -> dict[str, Any]:
        return {"quantity": self.quantity}


@dataclass(frozen=True, slots=True)
class OrderIntent:
    side: str
    type: str
    quantity: str
    limit_price: str | None = None
    stop_price: str | None = None
    tif: str = "GTC"
    client_tag: str = ""

    def __post_init__(self) -> None:
        if self.side not in ORDER_SIDES:
            raise PythonStrategyContractError("INVALID_ORDER_SIDE", "side must be BUY or SELL")
        if self.type not in ORDER_TYPES:
            raise PythonStrategyContractError(
                "INVALID_ORDER_TYPE",
                "type must be MARKET, LIMIT, STOP, or STOP_LIMIT",
            )
        if self.tif not in TIME_IN_FORCE:
            raise PythonStrategyContractError("INVALID_TIF", "tif must be GTC, IOC, or FOK")
        object.__setattr__(self, "quantity", _decimal_string(self.quantity, "quantity"))
        if self.limit_price is not None:
            object.__setattr__(
                self, "limit_price", _decimal_string(self.limit_price, "limit_price")
            )
        if self.stop_price is not None:
            object.__setattr__(
                self, "stop_price", _decimal_string(self.stop_price, "stop_price")
            )

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "side": self.side,
            "type": self.type,
            "quantity": self.quantity,
            "tif": self.tif,
        }
        if self.limit_price is not None:
            payload["limitPrice"] = self.limit_price
        if self.stop_price is not None:
            payload["stopPrice"] = self.stop_price
        if self.client_tag:
            payload["clientTag"] = self.client_tag
        return payload


AuthorOutput = Signal | TargetPosition | OrderIntent


def output_kind(value: AuthorOutput) -> str:
    if isinstance(value, Signal):
        return "SIGNAL"
    if isinstance(value, TargetPosition):
        return "TARGET_POSITION"
    if isinstance(value, OrderIntent):
        return "ORDER_INTENT"
    raise PythonStrategyContractError("INVALID_OUTPUT", "unsupported strategy output")


def encode_output(sequence: int, value: AuthorOutput) -> dict[str, Any]:
    kind = output_kind(value)
    payload = value.to_payload()
    wire = {
        "schemaVersion": OUTPUT_SCHEMA,
        "sequence": sequence,
        "kind": kind,
        "payload": payload,
    }
    wire["outputHash"] = canonical_sha256(wire)
    return wire


@dataclass(frozen=True, slots=True)
class ExecutionReport:
    sequence: int
    accepted: bool
    reason_code: str = ""
    fill_qty: str = "0"
    fill_price: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": EXECUTION_REPORT_SCHEMA,
            "sequence": self.sequence,
            "accepted": self.accepted,
            "reasonCode": self.reason_code,
            "fillQty": _decimal_string(self.fill_qty, "fillQty"),
            "fillPrice": None
            if self.fill_price is None
            else _decimal_string(self.fill_price, "fillPrice"),
        }


def encode_snapshot(payload: Mapping[str, Any]) -> dict[str, Any]:
    try:
        dumps_canonical(dict(payload))
    except PythonStrategyContractError:
        raise
    except TypeError as exc:
        raise PythonStrategyContractError(
            "SNAPSHOT_NOT_JSON",
            "snapshot() must return JSON-encodable values",
        ) from exc
    encoded = dict(payload)
    return {"payload": encoded, "hash": canonical_sha256(encoded)}
