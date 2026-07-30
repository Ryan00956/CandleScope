"""Source-aware work planning for native and derived K-line intervals.

The interval resolver remains the authority for exact routing.  This module
only turns one resolved route into a bounded amount of source-history work so
HTTP, indicator, and backfill callers can share the same arithmetic.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.data_engine.interval_policy import (
    parse_interval_ms,
    parse_monthly_count,
)
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolver,
    IntervalRoute,
    IntervalRouteKind,
)


_MAX_MONTH_DAYS = 31


@dataclass(frozen=True, slots=True)
class IntervalWorkPlan:
    """A target-bar request expressed as bounded source-row work."""

    requested_target_bars: int
    effective_target_bars: int
    base_interval: str
    source_factor: int
    source_padding_bars: int
    planned_source_rows: int
    source_row_budget: int | None
    budget_limited: bool
    derived: bool

    def provider_pages(self, page_size: int) -> int:
        """Return the source REST pages needed at ``page_size`` rows/page."""
        normalized_page_size = max(1, int(page_size))
        if self.planned_source_rows <= 0:
            return 0
        return (
            self.planned_source_rows + normalized_page_size - 1
        ) // normalized_page_size

    def to_metadata(self) -> dict[str, dict[str, Any]]:
        """Return the stable metadata contract consumed by API/scheduler layers."""
        return {
            "interval_work_plan": {
                "requested_target_bars": self.requested_target_bars,
                "effective_target_bars": self.effective_target_bars,
                "base_interval": self.base_interval,
                "source_factor": self.source_factor,
                "source_padding_bars": self.source_padding_bars,
                "planned_source_rows": self.planned_source_rows,
                "source_row_budget": self.source_row_budget,
                "budget_limited": self.budget_limited,
                "derived": self.derived,
            },
        }


def _source_factor(route: IntervalRoute) -> int:
    if route.kind is IntervalRouteKind.NATIVE:
        return 1

    source_ms = parse_interval_ms(route.source_interval)
    if source_ms is None or source_ms <= 0:
        raise ValueError(
            f"invalid resolved source interval: {route.source_interval!r}",
        )

    nominal_factor = max(
        1,
        (int(route.spec.nominal_ms) + source_ms - 1) // source_ms,
    )
    month_count = parse_monthly_count(route.canonical_interval)
    if month_count is None:
        return nominal_factor
    maximum_month_ms = month_count * _MAX_MONTH_DAYS * 86_400_000
    return max(
        nominal_factor,
        (maximum_month_ms + source_ms - 1) // source_ms,
    )


def build_interval_work_plan(
    route: IntervalRoute,
    requested_target_bars: int,
    source_row_budget: int | None,
    source_padding_bars: int = 3,
) -> IntervalWorkPlan:
    """Build a fail-closed source-row plan for one resolved interval route.

    Padding is expressed in *target* buckets and applies only to derived
    routes.  It covers boundary/finality lookaround used by custom-history
    reconstruction.  A positive budget that cannot fit one padded target bar
    yields ``effective_target_bars == 0`` instead of falling back to an
    unbounded target request.
    """
    requested = max(0, int(requested_target_bars))
    derived = route.kind is IntervalRouteKind.DERIVED
    factor = _source_factor(route)
    padding = max(0, int(source_padding_bars)) if derived else 0
    budget = (
        None
        if source_row_budget is None
        else max(0, int(source_row_budget))
    )

    if budget is None:
        effective = requested
    else:
        maximum_target = max(0, budget // factor - padding)
        effective = min(requested, maximum_target)

    planned_source_rows = (
        (effective + padding) * factor
        if effective > 0
        else 0
    )
    return IntervalWorkPlan(
        requested_target_bars=requested,
        effective_target_bars=effective,
        base_interval=route.source_interval,
        source_factor=factor,
        source_padding_bars=padding,
        planned_source_rows=planned_source_rows,
        source_row_budget=budget,
        budget_limited=effective < requested,
        derived=derived,
    )


def resolve_interval_work_plan(
    resolver: IntervalResolver,
    *,
    exchange: str,
    market_type: str,
    interval: str,
    requested_target_bars: int,
    source_row_budget: int | None,
    source_padding_bars: int = 3,
    purpose: IntervalPurpose | str = IntervalPurpose.HISTORY,
) -> IntervalWorkPlan:
    """Resolve ``interval`` exactly, then build its source-aware work plan."""
    route = resolver.resolve(
        exchange=exchange,
        market_type=market_type,
        interval=interval,
        purpose=purpose,
    )
    return build_interval_work_plan(
        route,
        requested_target_bars,
        source_row_budget,
        source_padding_bars,
    )


__all__ = [
    "IntervalWorkPlan",
    "build_interval_work_plan",
    "resolve_interval_work_plan",
]
