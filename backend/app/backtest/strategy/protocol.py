"""Host copy of strategy-provider/1. SDK package is the author-facing twin."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

PROTOCOL = "strategy-provider/1"
OBSERVATION_SCHEMA = "candlescope.observation/1"
OUTPUT_SCHEMA = "candlescope.strategy-output/1"
CONTRIBUTION_KIND = "strategy-provider/1"
OUTPUT_KINDS = frozenset({"SIGNAL", "TARGET_POSITION", "ORDER_INTENT"})
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


class StrategyProviderError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def canonical_hash(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    input_modes: tuple[str, ...] = ("BAR_CLOSE",)
    output_modes: tuple[str, ...] = ("SIGNAL",)
    state_modes: tuple[str, ...] = ("SESSION_STATEFUL",)
    reproducibility: tuple[str, ...] = ("DETERMINISTIC",)
    snapshot_restore: bool = True


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


class StrategyProvider(Protocol):
    def describe(self) -> ProviderCapabilities: ...
    def prepare(self, context: dict[str, Any]) -> None: ...
    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None: ...
    def step(self, frame: ObservationFrame) -> StrategyOutput | None: ...
    def on_execution_report(self, report: dict[str, Any]) -> None: ...
    def snapshot(self) -> dict[str, Any]: ...
    def restore(self, payload: dict[str, Any]) -> None: ...
    def close(self) -> str: ...


class StrategyProviderSession:
    def __init__(self, provider: StrategyProvider, *, run_id: str) -> None:
        self.provider = provider
        self.run_id = run_id
        self.generation = 1
        self.last_sequence = 0
        self.prepared = False
        self.closed = False
        self.watermark_ms = 0

    def describe(self) -> dict[str, Any]:
        capabilities = self.provider.describe()
        return {
            "protocol": PROTOCOL,
            "lifecycle": list(LIFECYCLE),
            "capabilities": {
                "inputModes": list(capabilities.input_modes),
                "outputModes": list(capabilities.output_modes),
                "stateModes": list(capabilities.state_modes),
                "reproducibility": list(capabilities.reproducibility),
                "snapshotRestore": capabilities.snapshot_restore,
            },
        }

    def prepare(self, context: dict[str, Any]) -> None:
        self._ensure_open()
        if "inputPlan" not in context:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "inputPlan required")
        self.provider.prepare(context)
        self.prepared = True

    def warmup(self, frame: ObservationFrame) -> None:
        self._accept_frame(frame)
        if self.provider.warmup(frame) is not None:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "warmup must not emit a tradable output",
            )

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._accept_frame(frame)
        output = self.provider.step(frame)
        if output is None:
            return None
        if output.sequence != frame.sequence:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "output sequence must echo the observation",
            )
        return output

    def on_execution_report(self, report: dict[str, Any]) -> None:
        self._ensure_open()
        if int(report.get("generation", self.generation)) != self.generation:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "stale generation discarded",
            )
        self.provider.on_execution_report(report)

    def snapshot(self) -> dict[str, Any]:
        payload = self.provider.snapshot()
        return {
            "generation": self.generation,
            "lastSequence": self.last_sequence,
            "watermarkMs": self.watermark_ms,
            "provider": payload,
            "hash": canonical_hash(payload),
        }

    def restore(self, payload: dict[str, Any]) -> None:
        self.generation = int(payload["generation"])
        self.last_sequence = int(payload["lastSequence"])
        self.watermark_ms = int(payload["watermarkMs"])
        self.provider.restore(dict(payload["provider"]))
        self.prepared = True
        self.closed = False

    def close(self) -> str:
        digest = self.provider.close()
        self.closed = True
        return digest

    def _accept_frame(self, frame: ObservationFrame) -> None:
        self._ensure_open()
        if not self.prepared:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "prepare first")
        if frame.run_id != self.run_id:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "runId mismatch")
        if frame.watermark_ms < self.watermark_ms:
            raise StrategyProviderError("LOOKAHEAD_VIOLATION", "watermark moved backwards")
        if frame.event_time_ms > frame.watermark_ms:
            raise StrategyProviderError("LOOKAHEAD_VIOLATION", "event after watermark")
        if frame.sequence <= self.last_sequence:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "sequence must increase")
        self.last_sequence = frame.sequence
        self.watermark_ms = frame.watermark_ms

    def _ensure_open(self) -> None:
        if self.closed:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "session is closed")


class DeterministicFakeProvider:
    def __init__(self) -> None:
        self._seen: list[int] = []
        self._prepared: dict[str, Any] = {}

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities()

    def prepare(self, context: dict[str, Any]) -> None:
        self._prepared = dict(context)
        self._seen = []

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._seen.append(frame.sequence)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._seen.append(frame.sequence)
        close = "0"
        if frame.bar is not None:
            close = str(frame.bar.get("close") or "0")
        payload = {"direction": "LONG" if close >= "100" else "FLAT", "close": close}
        return StrategyOutput(
            sequence=frame.sequence,
            kind="SIGNAL",
            payload=payload,
            state_hash=canonical_hash(self._seen),
            output_hash=canonical_hash({"sequence": frame.sequence, "payload": payload}),
        )

    def on_execution_report(self, report: dict[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "report missing accepted")

    def snapshot(self) -> dict[str, Any]:
        return {"seen": list(self._seen), "prepared": dict(self._prepared)}

    def restore(self, payload: dict[str, Any]) -> None:
        self._seen = list(payload["seen"])
        self._prepared = dict(payload["prepared"])

    def close(self) -> str:
        return canonical_hash(self._seen)


class CrashProvider(DeterministicFakeProvider):
    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        raise StrategyProviderError("PROVIDER_CRASH_UNRECOVERABLE", "forced crash")


class TimeoutProvider(DeterministicFakeProvider):
    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        time.sleep(0.05)
        raise StrategyProviderError("PROVIDER_TIMEOUT", "forced timeout")
