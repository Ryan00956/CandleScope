"""Bridge DataManager events into the IndicatorEngine."""
from __future__ import annotations

import logging
from typing import Any

from app.data_engine.data_manager.models import DataEventType
from app.indicator import create_engine

logger = logging.getLogger("candlescope.indicator.bridge")


def bridge_indicator_engine(data_manager: Any) -> Any:
    """Create an IndicatorEngine and subscribe it to DataManager events."""
    indicator_engine = create_engine()

    async def _on_bar_event(event: Any) -> None:
        bar = event.bar
        if bar is None:
            return
        symbol = event.key.symbol
        interval = event.key.interval
        market_type = event.key.market_type

        if event.event_type == DataEventType.BAR_CLOSED:
            indicator_engine.on_bar_closed(symbol, interval, bar, market_type=market_type)
        elif event.event_type == DataEventType.BAR_UPDATED:
            indicator_engine.on_bar_updated(symbol, interval, bar, market_type=market_type)

    async def _on_backfill(event: Any) -> None:
        symbol = event.key.symbol
        interval = event.key.interval
        market_type = event.key.market_type
        try:
            result = data_manager.query_latest(
                symbol,
                interval,
                limit=5000,
                market_type=market_type,
            )
            if result.bars:
                indicator_engine.on_bars_backfilled(
                    symbol,
                    interval,
                    result.bars,
                    market_type=market_type,
                )
        except Exception as exc:
            logger.warning("Indicator recompute after backfill failed: %s", exc)

    data_manager.subscribe(
        callback=_on_bar_event,
        event_types={DataEventType.BAR_CLOSED, DataEventType.BAR_UPDATED},
    )
    data_manager.subscribe(
        callback=_on_backfill,
        event_types={DataEventType.BACKFILL_COMPLETED},
    )

    return indicator_engine


__all__ = ["bridge_indicator_engine"]
