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

    def plan(
        self,
        output: StrategyOutput | dict[str, Any] | None,
        *,
        current_position: Decimal | str | None = None,
    ) -> list[dict[str, Any]]:
        if output is None:
            return []
        payload = output.payload if isinstance(output, StrategyOutput) else output.get("payload") or {}
        kind = output.kind if isinstance(output, StrategyOutput) else str(output.get("kind") or "")
        authoritative = (
            self.position
            if current_position is None
            else Decimal(str(current_position))
        )
        target = authoritative
        if kind == "TARGET_POSITION":
            target = Decimal(str(payload.get("targetExposure") or "0"))
        elif kind == "SIGNAL":
            direction = str(payload.get("direction") or "FLAT").upper()
            target = (
                Decimal("1")
                if direction == "LONG"
                else Decimal("-1") if direction == "SHORT" else Decimal("0")
            )
        elif kind == "ORDER_INTENT":
            raw_intents = payload.get("intents")
            values = raw_intents if isinstance(raw_intents, list) else [payload]
            return [dict(value) for value in values if isinstance(value, dict)]
        else:
            return []
        delta = target - authoritative
        if delta == 0:
            return []
        intent = {
            "side": "BUY" if delta > 0 else "SELL",
            "type": "MARKET",
            "qty": str(abs(delta)),
        }
        # Direct adapter users retain the original stateful convenience. The
        # runtime always supplies Host account state so rejected or cancelled
        # intents cannot corrupt future target-position deltas.
        if current_position is None:
            self.position = target
        return [intent]

    def snapshot(self) -> dict[str, str]:
        return {"position": str(self.position)}

    def restore(self, payload: dict[str, Any]) -> None:
        self.position = Decimal(str(payload.get("position") or "0"))


def events_to_visible_bars(events: tuple[MarketEvent, ...]) -> tuple[MarketEvent, ...]:
    return events
