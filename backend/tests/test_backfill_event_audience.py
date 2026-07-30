from __future__ import annotations

import asyncio
from types import SimpleNamespace

from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.backfill_coordinator import BackfillCoordinator, RepairRequest
from app.data_engine.data_manager.models import (
    BarData,
    audience_for_backfill_reason,
)


def test_backfill_reason_audience_mapping() -> None:
    assert audience_for_backfill_reason("initial_history") == "user"
    assert audience_for_backfill_reason("visible_range_gap") == "user"
    assert audience_for_backfill_reason("tail_gap") == "user"
    assert audience_for_backfill_reason("background_gap_audit") == "internal"
    assert audience_for_backfill_reason("active_history_hydration") == "internal"
    assert audience_for_backfill_reason("related_interval_warmup") == "internal"
    assert audience_for_backfill_reason("query_gap") == "internal"
    assert audience_for_backfill_reason("visible_range_gap+query_gap") == "user"
    assert audience_for_backfill_reason("new_unclassified_reason") == "internal"


def test_data_manager_loaded_backfill_event_uses_reason_audience() -> None:
    async def run() -> None:
        dm = DataManager()
        events = []

        async def emit(event) -> None:
            events.append(event)

        dm.event_bus = SimpleNamespace(emit=emit)
        await dm.on_bars_backfilled(
            "BTCUSDT",
            "1m",
            [BarData(time=1_700_000_000, open=1, high=2, low=1, close=2, volume=10)],
            event_detail={"reason": "related_interval_warmup"},
        )

        assert len(events) == 1
        assert events[0].audience == "internal"

    asyncio.run(run())


def test_backfill_coordinator_empty_completion_event_uses_reason_audience() -> None:
    async def run() -> None:
        events = []

        async def emit_event(event) -> None:
            events.append(event)

        async def bars_backfilled(*_args, **_kwargs) -> None:
            return None

        coordinator = BackfillCoordinator(
            storage=SimpleNamespace(),
            bars_backfilled=bars_backfilled,
            emit_event=emit_event,
        )
        request = RepairRequest(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=60_000,
            end_ms=120_000,
            reason="visible_seed_gap",
        )

        await coordinator._emit_completion_if_needed(
            request,
            SimpleNamespace(status="completed"),
            bars_loaded=0,
        )

        assert len(events) == 1
        assert events[0].audience == "user"

    asyncio.run(run())
