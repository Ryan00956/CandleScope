"""Bridge DataManager events into the IndicatorEngine."""
from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from typing import Any

from app.core.executors import run_storage
from app.data_engine.data_manager.models import DataEventType
from app.indicator import create_engine

logger = logging.getLogger("candlescope.indicator.bridge")

_COMPLETED_BACKFILL_REQUEST_LIMIT = 512


def bridge_indicator_engine(
    data_manager: Any,
    *,
    backfill_coordinator: Any | None = None,
    result_service: Any | None = None,
) -> Any:
    """Create an IndicatorEngine and subscribe it to DataManager events."""
    indicator_engine = create_engine()
    if result_service is not None:
        result_service.bind_engine(indicator_engine)
    pending_backfills: dict[str, asyncio.Task[None]] = {}
    completed_backfills: OrderedDict[str, None] = OrderedDict()

    def _remember_completed(request_id: str) -> None:
        completed_backfills.pop(request_id, None)
        completed_backfills[request_id] = None
        while len(completed_backfills) > _COMPLETED_BACKFILL_REQUEST_LIMIT:
            completed_backfills.popitem(last=False)

    async def _on_bar_event(event: Any) -> None:
        bar = event.bar
        if bar is None:
            return
        symbol = event.key.symbol
        interval = event.key.interval
        market_type = event.key.market_type
        exchange = event.key.exchange

        if event.event_type == DataEventType.BAR_CLOSED:
            if result_service is not None:
                result_service.note_closed(
                    series_key=(
                        f"{exchange}:{market_type}:{symbol}:{interval}"
                    ),
                    closed_through=int(bar.time),
                )
            indicator_engine.on_bar_closed(symbol, interval, bar, market_type=market_type, exchange=exchange)
        elif event.event_type == DataEventType.BAR_UPDATED:
            indicator_engine.on_bar_updated(symbol, interval, bar, market_type=market_type, exchange=exchange)

    async def _recompute_after_backfill(
        event: Any,
        request_id: str | None,
        data_revision: dict[str, Any] | None,
    ) -> bool:
        symbol = event.key.symbol
        interval = event.key.interval
        market_type = event.key.market_type
        exchange = event.key.exchange
        dirty_range = _dirty_range_from_event(event)
        try:
            if backfill_coordinator is not None and request_id:
                outcome = await backfill_coordinator.wait_for_request(request_id)
                if outcome is None:
                    return False
                if int(getattr(outcome, "bars_loaded", 0) or 0) <= 0:
                    return True

            result = await run_storage(
                data_manager.query_latest,
                symbol,
                interval,
                limit=5000,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=False,
            )
            if result.bars:
                indicator_engine.on_bars_backfilled(
                    symbol,
                    interval,
                    result.bars,
                    market_type=market_type,
                    exchange=exchange,
                    dirty_range=dirty_range,
                    data_revision=data_revision,
                )
            return True
        except Exception as exc:
            logger.warning("Indicator recompute after backfill failed: %s", exc)
            return False

    async def _run_backfill_refresh(
        task_key: str,
        event: Any,
        request_id: str | None,
        data_revision: dict[str, Any] | None,
    ) -> None:
        completed = False
        try:
            completed = await _recompute_after_backfill(event, request_id, data_revision)
        finally:
            if completed and request_id:
                _remember_completed(request_id)
            pending_backfills.pop(task_key, None)

    async def _on_backfill(event: Any) -> None:
        detail = event.detail if isinstance(event.detail, dict) else {}
        raw_request_id = detail.get("request_id")
        request_id = str(raw_request_id).strip() if raw_request_id else None
        if request_id and request_id in completed_backfills:
            return

        dirty_range = _dirty_range_from_event(event)
        data_revision = None
        if result_service is not None:
            data_revision = result_service.note_correction(
                series_key=(
                    f"{event.key.exchange}:{event.key.market_type}:"
                    f"{event.key.symbol}:{event.key.interval}"
                ),
                start=dirty_range["start"],
                end=dirty_range["end"],
                event_id=(
                    f"backfill:{request_id}"
                    if request_id
                    else f"{event.event_type.value}:{event.key.symbol}:"
                    f"{event.key.interval}:{dirty_range['start']}:"
                    f"{dirty_range['end']}:{getattr(event, 'timestamp_ms', 0)}"
                ),
            )

        series_key = (
            f"{event.key.exchange}:{event.key.market_type}:"
            f"{event.key.symbol}:{event.key.interval}"
        )
        task_key = f"request:{request_id}" if request_id else f"series:{series_key}"
        existing = pending_backfills.get(task_key)
        if existing is not None and not existing.done():
            return

        pending_backfills[task_key] = asyncio.create_task(
            _run_backfill_refresh(task_key, event, request_id, data_revision),
            name=f"indicator-backfill-refresh:{task_key}",
        )

    data_manager.subscribe(
        callback=_on_bar_event,
        event_types={DataEventType.BAR_CLOSED, DataEventType.BAR_UPDATED},
    )
    data_manager.subscribe(
        callback=_on_backfill,
        event_types={DataEventType.BACKFILL_COMPLETED},
    )
    data_manager.subscribe(
        callback=_on_backfill,
        event_types={DataEventType.BAR_AMENDED},
    )

    return indicator_engine


def _dirty_range_from_event(event: Any) -> dict[str, int]:
    """Return the actual amended/backfilled range in unix seconds."""
    if event.event_type == DataEventType.BAR_AMENDED and event.bar is not None:
        bar_time = int(event.bar.time)
        return {"start": bar_time, "end": bar_time}
    detail = event.detail if isinstance(event.detail, dict) else {}
    start = detail.get("earliest")
    end = detail.get("latest")
    if start is None:
        start_ms = detail.get("request_start_ms") or detail.get("range_start_ms")
        start = int(start_ms) // 1000 if start_ms is not None else 0
    if end is None:
        end_ms = detail.get("request_end_ms") or detail.get("range_end_ms")
        end = int(end_ms) // 1000 if end_ms is not None else start
    start_s = int(start or 0)
    return {"start": start_s, "end": max(start_s, int(end or start_s))}


__all__ = ["bridge_indicator_engine"]
