from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

PROTOCOL = "strategy-provider/1"
OBSERVATION_SCHEMA = "candlescope.observation/1"
OUTPUT_SCHEMA = "candlescope.strategy-output/1"
CONTRIBUTION_KIND = "strategy-provider/1"
LIFECYCLE = (
    "describe",
    "prepare",
    "warmup",
    "step",
    "onExecutionReport",
    "snapshot",
    "restore",
    "close",
)
OUTPUT_KINDS = frozenset({"SIGNAL", "TARGET_POSITION", "ORDER_INTENT"})


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    input_modes: tuple[str, ...] = ("BAR_CLOSE",)
    output_modes: tuple[str, ...] = ("SIGNAL",)
    state_modes: tuple[str, ...] = ("SESSION_STATEFUL",)
    reproducibility: tuple[str, ...] = ("DETERMINISTIC",)
    snapshot_restore: bool = True
    signal_clock: str = "EVENT"
    required_features: tuple[str, ...] = ()
    warmup_requirement: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ObservationFrame:
    run_id: str
    sequence: int
    event_time_ms: int
    watermark_ms: int
    phase: str
    market: Mapping[str, str]
    input_hash: str
    bar: Mapping[str, Any] | None = None
    trade: Mapping[str, Any] | None = None
    book: Mapping[str, Any] | None = None
    features: Mapping[str, Any] = field(default_factory=dict)
    account_view: Mapping[str, Any] = field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": OBSERVATION_SCHEMA,
            "runId": self.run_id,
            "sequence": self.sequence,
            "eventTimeMs": self.event_time_ms,
            "watermarkMs": self.watermark_ms,
            "phase": self.phase,
            "market": dict(self.market),
            "bar": None if self.bar is None else dict(self.bar),
            "trade": None if self.trade is None else dict(self.trade),
            "book": None if self.book is None else dict(self.book),
            "features": dict(self.features),
            "accountView": dict(self.account_view),
            "inputHash": self.input_hash,
        }


@dataclass(frozen=True, slots=True)
class StrategyOutput:
    sequence: int
    kind: str
    payload: Mapping[str, Any]
    state_hash: str
    output_hash: str

    def __post_init__(self) -> None:
        if self.kind not in OUTPUT_KINDS:
            raise ValueError(f"unsupported strategy output kind {self.kind}")

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": OUTPUT_SCHEMA,
            "sequence": self.sequence,
            "kind": self.kind,
            "payload": dict(self.payload),
            "stateHash": self.state_hash,
            "outputHash": self.output_hash,
        }
