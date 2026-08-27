"""Shared closed-bar materializer for derived manual-history targets.

This is a thin adapter over ``interval_policy.aggregate_kline_rows`` so the
manual-history runner and the existing reconciler stay on one aggregation
contract.  Incomplete source buckets never emit a target bar.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from app.data_engine.interval_policy import aggregate_kline_rows


def materialize_closed_target_bars(
    component_rows: Sequence[Mapping[str, Any]],
    *,
    target_interval: str,
    source_interval: str,
    now_ms: int,
) -> list[dict[str, Any]]:
    """Rebuild closed target candles from complete stored source components."""

    return aggregate_kline_rows(
        component_rows,
        target_interval=target_interval,
        source_interval=source_interval,
        now_ms=now_ms,
    )
