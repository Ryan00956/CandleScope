"""Stream planning rules for DataManager.ensure_stream."""
from __future__ import annotations

from dataclasses import dataclass

from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.data_engine.interval_policy import is_standard_interval

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

        if not is_standard_interval(interval):
            base = SeriesKey(
                symbol,
                self._base_interval,
                exchange=exchange,
                market_type=market_type,
            )
            targets.append(base)
        elif self._needs_policy_base_stream(requested):
            policy = self._realtime_policy(requested.exchange)
            base = SeriesKey(
                symbol,
                policy.base_interval,
                exchange=exchange,
                market_type=market_type,
            )
            targets.append(base)
            prerequisites.append(base)

        return StreamEnsurePlan(
            requested=requested,
            aggregation_targets=tuple(dict.fromkeys(targets)),
            prerequisite_streams=tuple(dict.fromkeys(prerequisites)),
        )

    def _needs_policy_base_stream(self, requested: SeriesKey) -> bool:
        return self._realtime_policy(requested.exchange).needs_base_stream(requested.interval)

    @staticmethod
    def _realtime_policy(exchange: str):
        bootstrap_default_adapters()
        return get_exchange_registry().get_plugin(exchange).realtime_policy()
