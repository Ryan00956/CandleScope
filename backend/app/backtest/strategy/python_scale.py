"""Official Python BAR scale. A raised env cap is not product evidence."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

DEFAULT_BAR_CAPACITY = 200_000
OFFICIAL_BAR_CAPACITY = 1_000_000
AGG_TRADE_PRODUCT_CAPACITY = 2_000_000
SCALE_FLAG = "BACKTEST_PYTHON_SCALE_V1_ENABLED"
# Flipped only after a committed 1,000,000 BAR Python Host reference run.
EVIDENCED_MILLION_BAR = True


def official_bar_capacity() -> int:
    return OFFICIAL_BAR_CAPACITY if EVIDENCED_MILLION_BAR else DEFAULT_BAR_CAPACITY


def million_bar_is_product_ready() -> bool:
    return EVIDENCED_MILLION_BAR


def scale_v1_enabled(environment: Mapping[str, str] | None = None) -> bool:
    source = environment
    if source is None:
        import os

        source = os.environ
    return str(source.get(SCALE_FLAG, "0")).strip() == "1"


def bar_row_hard_ceiling(environment: Mapping[str, str] | None = None) -> int:
    if scale_v1_enabled(environment):
        return OFFICIAL_BAR_CAPACITY
    return DEFAULT_BAR_CAPACITY


def iter_reference_bars(
    count: int,
    *,
    start_ms: int = 1_700_000_000_000,
    interval_ms: int = 60_000,
) -> Iterator[Any]:
    from app.market_dataset.snapshot import MarketEvent

    if count < 1:
        return
    for index in range(1, count + 1):
        close = str(10_000 + index // 1_000)
        open_ms = start_ms + (index - 1) * interval_ms
        close_ms = open_ms + interval_ms
        yield MarketEvent(
            sequence=index,
            event_time_ms=close_ms,
            role="BARS",
            payload={
                "open_time_ms": open_ms,
                "close_time_ms": close_ms,
                "open": close,
                "high": close,
                "low": close,
                "close": close,
                "volume": "1",
                "time": close_ms // 1000,
            },
        )
