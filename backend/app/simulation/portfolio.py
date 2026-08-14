"""Single global clock for multi-market portfolios. One missing track fails all."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Iterable, Mapping

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.simulation.contract_accounting import KIND_RANK


def global_sort_key(event: MarketEvent) -> tuple[int, str, str, int, int]:
    market = event.payload
    return (
        int(event.event_time_ms),
        str(market.get("venue") or ""),
        str(market.get("symbol") or ""),
        KIND_RANK.get(event.role, 9),
        int(event.sequence),
    )


def merge_market_tracks(*tracks: Iterable[MarketEvent]) -> tuple[MarketEvent, ...]:
    merged = [event for track in tracks for event in track]
    if not merged:
        raise MarketDatasetError("no market tracks", code="DATA_QUALITY_FAILED")
    merged.sort(key=global_sort_key)
    previous = None
    for event in merged:
        if previous is not None and global_sort_key(event) <= global_sort_key(previous):
            raise MarketDatasetError("global clock is not strictly ordered", code="DATA_QUALITY_FAILED")
        previous = event
    return tuple(merged)


def assert_track_coverage(
    required: Mapping[str, tuple[int, int]],
    events: Iterable[MarketEvent],
) -> None:
    seen: dict[str, list[int]] = {symbol: [] for symbol in required}
    for event in events:
        symbol = str(event.payload.get("symbol") or "")
        if symbol in seen:
            seen[symbol].append(int(event.event_time_ms))
    for symbol, (start_ms, end_ms) in required.items():
        times = seen.get(symbol) or []
        if not times or min(times) > start_ms or max(times) < end_ms:
            raise MarketDatasetError(
                f"track {symbol} does not cover the required window",
                code="DATA_GAP_REJECTED",
            )


@dataclass(slots=True)
class PortfolioBook:
    cash: Decimal = Decimal("10000")
    positions: dict[str, Decimal] = field(default_factory=dict)

    def apply_fill(self, symbol: str, side: str, qty: Decimal, price: Decimal) -> None:
        signed = qty if side == "BUY" else -qty
        self.positions[symbol] = self.positions.get(symbol, Decimal("0")) + signed
        self.cash -= signed * price

    def snapshot(self) -> dict[str, object]:
        return {
            "cash": str(self.cash),
            "positions": {key: str(value) for key, value in sorted(self.positions.items())},
        }
