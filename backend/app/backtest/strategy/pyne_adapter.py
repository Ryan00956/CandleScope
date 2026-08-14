"""Host planner that turns Pyne strategy output into kernel order intents."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.backtest.strategy.protocol import StrategyOutput
from app.market_dataset.snapshot import MarketEvent


class PyneHostPlanner:
    """Maps TARGET_POSITION / SIGNAL to Host order intents. Provider never fills."""

    def __init__(self) -> None:
        self.position = Decimal("0")

    def plan(self, output: StrategyOutput | dict[str, Any] | None) -> list[dict[str, str]]:
        if output is None:
            return []
        payload = output.payload if isinstance(output, StrategyOutput) else output.get("payload") or {}
        kind = output.kind if isinstance(output, StrategyOutput) else str(output.get("kind") or "")
        target = self.position
        if kind == "TARGET_POSITION":
            target = Decimal(str(payload.get("targetExposure") or "0"))
        elif kind == "SIGNAL":
            direction = str(payload.get("direction") or "FLAT").upper()
            target = Decimal("1") if direction == "LONG" else Decimal("0")
        else:
            return []
        delta = target - self.position
        if delta == 0:
            return []
        intent = {
            "side": "BUY" if delta > 0 else "SELL",
            "type": "MARKET",
            "qty": str(abs(delta)),
        }
        self.position = target
        return [intent]


def events_to_visible_bars(events: tuple[MarketEvent, ...]) -> tuple[MarketEvent, ...]:
    return events
