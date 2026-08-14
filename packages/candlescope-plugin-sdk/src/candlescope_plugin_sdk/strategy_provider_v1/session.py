from __future__ import annotations

import hashlib
import json
from typing import Any, Protocol

from .models import (
    LIFECYCLE,
    PROTOCOL,
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
)


class StrategyProviderError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


class StrategyProvider(Protocol):
    def describe(self) -> ProviderCapabilities: ...

    def prepare(self, context: dict[str, Any]) -> None: ...

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None: ...

    def step(self, frame: ObservationFrame) -> StrategyOutput | None: ...

    def on_execution_report(self, report: dict[str, Any]) -> None: ...

    def snapshot(self) -> dict[str, Any]: ...

    def restore(self, payload: dict[str, Any]) -> None: ...

    def close(self) -> str: ...


def canonical_hash(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class StrategyProviderSession:
    """Host-side session: generation, sequence echo, no future-data pull."""

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
                "signalClock": capabilities.signal_clock,
                "requiredFeatures": list(capabilities.required_features),
                "warmupRequirement": dict(capabilities.warmup_requirement),
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
        output = self.provider.warmup(frame)
        if output is not None:
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
        self._ensure_open()
        payload = self.provider.snapshot()
        return {
            "generation": self.generation,
            "lastSequence": self.last_sequence,
            "watermarkMs": self.watermark_ms,
            "provider": payload,
            "hash": canonical_hash(payload),
        }

    def restore(self, payload: dict[str, Any]) -> None:
        if int(payload.get("generation", -1)) != self.generation:
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
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "sequence must increase",
            )
        self.last_sequence = frame.sequence
        self.watermark_ms = frame.watermark_ms

    def _ensure_open(self) -> None:
        if self.closed:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "session is closed")
