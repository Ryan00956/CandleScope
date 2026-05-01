"""Stream planning rules for DataManager.ensure_stream."""
from __future__ import annotations

from dataclasses import dataclass

from app.data_engine.interval_policy import is_standard_interval, parse_interval_ms

from .models import SeriesKey


@dataclass(frozen=True, slots=True)
class StreamEnsurePlan:
    """Concrete work needed to ensure one requested stream."""

    requested: SeriesKey
    aggregation_targets: tuple[SeriesKey, ...]
    prerequisite_streams: tuple[SeriesKey, ...] = ()


class StreamEnsurePlanner:
    """Decide aggregation targets and required ingestion streams."""

    def __init__(self, base_interval: str = "1m") -> None:
        self._base_interval = base_interval

    def plan(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> StreamEnsurePlan:
        requested = SeriesKey(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        targets = [requested]
        prerequisites: list[SeriesKey] = []
        base = SeriesKey(
            symbol,
            self._base_interval,
            exchange=exchange,
            market_type=market_type,
        )

        if not is_standard_interval(interval):
            targets.append(base)
        elif self._needs_okx_base_stream(requested):
            targets.append(base)
            prerequisites.append(base)

        return StreamEnsurePlan(
            requested=requested,
            aggregation_targets=tuple(dict.fromkeys(targets)),
            prerequisite_streams=tuple(dict.fromkeys(prerequisites)),
        )

    def _needs_okx_base_stream(self, requested: SeriesKey) -> bool:
        if requested.exchange != "okx":
            return False
        if requested.interval == self._base_interval:
            return False
        if not is_standard_interval(requested.interval):
            return False
        requested_ms = parse_interval_ms(requested.interval) or 0
        base_ms = parse_interval_ms(self._base_interval) or 0
        return requested_ms > base_ms
