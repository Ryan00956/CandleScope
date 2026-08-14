from __future__ import annotations

import queue
import threading
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
        trade: dict[str, Any] | None = None,
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
                {
                    "sequence": sequence,
                    "watermark": watermark_ms,
                    "bar": bar,
                    "trade": trade,
                    "features": features,
                }
            ),
            bar=bar,
            trade=trade,
            features=features or {},
        )
        completed: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

        def invoke() -> None:
            try:
                if phase == "WARMUP":
                    self.session.warmup(frame)
                    completed.put((True, None))
                else:
                    completed.put((True, self.session.step(frame)))
            except BaseException as exc:
                completed.put((False, exc))

        thread = threading.Thread(
            target=invoke,
            name=f"strategy-step-{self.session.run_id}-{sequence}",
            daemon=True,
        )
        thread.start()
        try:
            ok, value = completed.get(timeout=self.step_timeout_s)
        except queue.Empty:
            raise StrategyProviderError("PROVIDER_TIMEOUT", "provider step exceeded budget")
        if not ok:
            raise value
        output = value
        return None if output is None else output.to_wire()

    def reject_host_write(self, attempt: str) -> None:
        raise StrategyProviderError(
            "PROVIDER_UNAUTHORIZED_WRITE",
            f"provider cannot write {attempt}",
        )
