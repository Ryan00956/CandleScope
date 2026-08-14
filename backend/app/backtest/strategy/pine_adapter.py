"""Versioned Pine strategy subset. Does not claim TradingView equivalence."""

from __future__ import annotations

import re
from typing import Any, Mapping

from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
    canonical_hash,
)

MATRIX_VERSION = "pine.strategy.backtest.v1"
PINE_EXAMPLE_MARKER = "candlescope.pine-strategy-example:long_flat"
UNSUPPORTED = (
    "strategy.order",
    "strategy.exit",
    "strategy.risk",
    "calc_on_every_tick",
    "request.security",
    "request.seed",
    "strategy.short",
)
PINE_LONG_FLAT_SOURCE = """// candlescope.pine-strategy-example:long_flat
//@version=5
strategy("Long Flat", overlay=true, pyramiding=0)
if close >= 100
    strategy.entry("L", strategy.long)
if close < 100
    strategy.close("L")
"""


def analyze_pine_strategy(source: str) -> list[str]:
    lowered = source.lower()
    rejected = [token for token in UNSUPPORTED if token in lowered]
    if re.search(r"pyramiding\s*=\s*(?!0\b)", lowered):
        rejected.append("pyramiding>0")
    if "strategy(" in lowered and "strategy.entry" not in lowered and "strategy.close" not in lowered:
        rejected.append("strategy-without-entry-or-close")
    return rejected


class PineStrategyProvider:
    def __init__(self) -> None:
        self._source = ""
        self._seen: list[int] = []

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("SIGNAL", "TARGET_POSITION"),
            reproducibility=("DETERMINISTIC",),
        )

    def prepare(self, context: Mapping[str, Any]) -> None:
        source = str(context.get("source") or "")
        rejected = analyze_pine_strategy(source)
        if rejected:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION",
                "unsupported Pine strategy semantics: " + ", ".join(rejected),
            )
        if PINE_EXAMPLE_MARKER not in source and "strategy.entry" not in source:
            raise StrategyProviderError(
                "FIDELITY_UNSUPPORTED",
                "source is outside pine.strategy.backtest.v1",
            )
        self._source = source
        self._seen = []

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._seen.append(frame.sequence)
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        self._seen.append(frame.sequence)
        close = float((frame.bar or {}).get("close") or 0)
        exposure = "1" if close >= 100 else "0"
        payload = {
            "targetExposure": exposure,
            "reasonCode": "pine_long_flat",
            "matrixVersion": MATRIX_VERSION,
        }
        return StrategyOutput(
            sequence=frame.sequence,
            kind="TARGET_POSITION",
            payload=payload,
            state_hash=canonical_hash(self._seen),
            output_hash=canonical_hash(payload),
        )

    def on_execution_report(self, report: Mapping[str, Any]) -> None:
        if "accepted" not in report:
            raise StrategyProviderError("PROVIDER_PROTOCOL_VIOLATION", "report missing accepted")

    def snapshot(self) -> dict[str, Any]:
        return {"source": self._source, "seen": list(self._seen)}

    def restore(self, payload: Mapping[str, Any]) -> None:
        self.prepare({"source": payload["source"]})
        self._seen = list(payload.get("seen") or [])

    def close(self) -> str:
        return canonical_hash(self._seen)

    def identity(self) -> dict[str, Any]:
        return {
            "matrixVersion": MATRIX_VERSION,
            "tradingViewEquivalent": False,
        }
