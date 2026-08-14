from __future__ import annotations

import time
from typing import Any

from .models import ObservationFrame, ProviderCapabilities, StrategyOutput
from .session import StrategyProviderError, canonical_hash


class DeterministicFakeProvider:
    """Deterministic SIGNAL provider used by protocol conformance tests."""

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
        state_hash = canonical_hash(self._seen)
        return StrategyOutput(
            sequence=frame.sequence,
            kind="SIGNAL",
            payload=payload,
            state_hash=state_hash,
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
