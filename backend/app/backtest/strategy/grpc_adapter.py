"""Restricted gRPC/remote adapter. Disabled unless the external-provider flag is on."""

from __future__ import annotations

import time
from typing import Any, Callable, Mapping

from app.backtest.strategy.artifacts import ModelArtifact
from app.backtest.strategy.external import evidence_record
from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
)


class GrpcStrategyProvider:
    def __init__(
        self,
        artifact: ModelArtifact,
        *,
        enabled: bool,
        transport: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        timeout_s: float = 0.05,
    ) -> None:
        self._artifact = artifact
        self._enabled = enabled
        self._transport = transport
        self._timeout_s = timeout_s
        self.captured: list[dict[str, Any]] = []
        self.evidence: dict[str, Any] = {}

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            output_modes=("SIGNAL",),
            reproducibility=("RECORDED_OUTPUT_ONLY",),
        )

    def prepare(self, context: Mapping[str, Any]) -> None:
        if not self._enabled:
            raise StrategyProviderError("FLAG_DISABLED", "BACKTEST_EXTERNAL_PROVIDER_ENABLED is 0")
        if self._artifact.format != "REMOTE_DESCRIPTOR":
            raise StrategyProviderError("FIDELITY_UNSUPPORTED", "artifact is not REMOTE_DESCRIPTOR")
        if not self._artifact.allow_network:
            raise StrategyProviderError("PROVIDER_UNAUTHORIZED_WRITE", "remote adapter defaults to no network")
        host = str(context.get("host") or "")
        if host not in self._artifact.allowed_hosts:
            raise StrategyProviderError("PROVIDER_UNAUTHORIZED_WRITE", f"host {host!r} is not granted")
        self.evidence = evidence_record(self._artifact, host=host)

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        if self._transport is None:
            raise StrategyProviderError("PROVIDER_TIMEOUT", "no remote transport configured")
        started = time.monotonic()
        response = self._transport({"sequence": frame.sequence, "features": dict(frame.features)})
        elapsed = time.monotonic() - started
        if elapsed > self._timeout_s:
            raise StrategyProviderError("PROVIDER_TIMEOUT", "remote model exceeded timeout")
        self.captured.append(dict(response))
        return None

    def on_execution_report(self, report: Mapping[str, Any]) -> None:
        return None

    def snapshot(self) -> dict[str, Any]:
        return {"captured": list(self.captured)}

    def restore(self, payload: Mapping[str, Any]) -> None:
        self.captured = list(payload.get("captured") or [])

    def close(self) -> str:
        return str(len(self.captured))
