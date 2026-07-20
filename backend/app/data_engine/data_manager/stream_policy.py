"""Stream planning rules for DataManager.ensure_stream."""
from __future__ import annotations

from dataclasses import dataclass

from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.data_engine.interval_policy import parse_interval_spec
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolver,
    IntervalRouteKind,
)

from .models import SeriesKey


@dataclass(frozen=True, slots=True)
class StreamEnsurePlan:
    """Concrete work needed to ensure one requested stream."""

    requested: SeriesKey
    aggregation_targets: tuple[SeriesKey, ...]
    prerequisite_streams: tuple[SeriesKey, ...] = ()


class StreamEnsurePlanner:
    """Decide aggregation targets and required ingestion streams."""

    def __init__(
        self,
        base_interval: str = "1m",
        interval_resolver: IntervalResolver | None = None,
    ) -> None:
        self._base_interval = base_interval
        self._interval_resolver = interval_resolver or IntervalResolver()

    def plan(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> StreamEnsurePlan:
        route = self._interval_resolver.resolve(
            exchange=exchange,
            market_type=market_type,
            interval=interval,
            purpose=IntervalPurpose.REALTIME,
        )
        requested = SeriesKey(
            symbol,
            route.canonical_interval,
            exchange=route.exchange,
            market_type=route.market_type,
        )
        targets = [requested]
        prerequisites: list[SeriesKey] = []

        if route.kind is IntervalRouteKind.DERIVED:
            base_spec = parse_interval_spec(route.base_interval or "")
            if base_spec is None:  # guarded by resolver
                raise ValueError(f"invalid resolved realtime base: {route.base_interval!r}")
            base = SeriesKey(
                symbol,
                base_spec.canonical,
                exchange=route.exchange,
                market_type=route.market_type,
            )
            targets.append(base)
            prerequisites.append(base)
        elif self._needs_policy_base_stream(requested):
            policy = self._realtime_policy(requested.exchange)
            base_spec = parse_interval_spec(policy.base_interval)
            base = SeriesKey(
                symbol,
                base_spec.canonical if base_spec is not None else policy.base_interval,
                exchange=route.exchange,
                market_type=route.market_type,
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
