from __future__ import annotations

import time
from typing import Any

from .protocol import (
    ObservationFrame,
    StrategyProviderError,
    StrategyProviderSession,
    canonical_hash,
)


class StrategyHostAdapter:
    """Maps a backtest run to a strategy-provider session. No kernel fills."""

    def __init__(
        self,
        session: StrategyProviderSession,
        *,
        step_timeout_s: float = 2.0,
    ) -> None:
        self.session = session
        self.step_timeout_s = step_timeout_s

    def start(self, input_plan: dict[str, Any]) -> dict[str, Any]:
        described = self.session.describe()
        self.session.prepare(
            {"runId": self.session.run_id, "inputPlan": input_plan, **input_plan}
        )
        return described

    def observe(
        self,
        *,
        sequence: int,
        event_time_ms: int,
        watermark_ms: int,
        phase: str,
        market: dict[str, str],
        bar: dict[str, Any] | None,
        features: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if event_time_ms > watermark_ms:
            raise StrategyProviderError("LOOKAHEAD_VIOLATION", "host refused future bar")
        frame = ObservationFrame(
            run_id=self.session.run_id,
            sequence=sequence,
            event_time_ms=event_time_ms,
            watermark_ms=watermark_ms,
            phase=phase,
            market=market,
            input_hash=canonical_hash(
                {"sequence": sequence, "watermark": watermark_ms, "bar": bar, "features": features}
            ),
            bar=bar,
            features=features or {},
        )
        started = time.monotonic()
        if phase == "WARMUP":
            self.session.warmup(frame)
            output = None
        else:
            output = self.session.step(frame)
        if time.monotonic() - started > self.step_timeout_s:
            raise StrategyProviderError("PROVIDER_TIMEOUT", "provider step exceeded budget")
        return None if output is None else output.to_wire()

    def reject_host_write(self, attempt: str) -> None:
        raise StrategyProviderError(
            "PROVIDER_UNAUTHORIZED_WRITE",
            f"provider cannot write {attempt}",
        )
