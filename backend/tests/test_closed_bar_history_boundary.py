from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.gap_detector import GapDetector
from app.data_engine.data_manager.backfill_coordinator import (
    BackfillCoordinator,
    RepairRequest,
)
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.history import (
    BoundaryReason,
    HistoryAvailability,
    HistoryDisposition,
    HistoryRequest,
    HistoryRequestPlanner,
    HistorySeriesKey,
    TimeRange,
)
from app.data_engine.interval_policy import last_closed_bar_open_ms


def _ms(value: str) -> int:
    return int(
        datetime.fromisoformat(value)
        .replace(tzinfo=timezone.utc)
        .timestamp()
        * 1000
    )


def _history_request(start_ms: int, end_ms: int, interval: str = "1h") -> HistoryRequest:
    return HistoryRequest(
        HistorySeriesKey("binance", "futures", "BTCUSDT", "kline", interval),
        interval,
        start_ms,
        end_ms,
    )


class _EmptyStorage:
    async def get_earliest_time(self, *args, **kwargs):
        return None

    async def get_latest_time(self, *args, **kwargs):
        return None

    async def get_existing_open_times(self, *args, **kwargs):
        return set()

    def query_bars(self, **kwargs):
        return []


class _Engine:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def run(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            status="completed",
            errors=[],
            fetch_results=[],
            reconcile_result=SimpleNamespace(
                bars_written=0,
                custom_bars_written=0,
                written_ranges=[],
            ),
        )


async def _ignore(*args, **kwargs) -> None:
    return None


def test_last_closed_bar_open_handles_fixed_and_calendar_month_intervals() -> None:
    now_ms = _ms("2026-07-15T08:58:00")
    assert last_closed_bar_open_ms(now_ms, "1h") == _ms("2026-07-15T07:00:00")
    assert last_closed_bar_open_ms(_ms("2026-07-15T09:00:00"), "1h") == _ms(
        "2026-07-15T08:00:00"
    )

    assert last_closed_bar_open_ms(_ms("2024-02-15T12:00:00"), "1M") == _ms(
        "2024-01-01T00:00:00"
    )
    assert last_closed_bar_open_ms(_ms("2024-03-15T12:00:00"), "2M") == _ms(
        "2024-01-01T00:00:00"
    )


def test_history_planner_excludes_forming_kline_tail_without_terminal_exhaustion() -> None:
    previous_open = _ms("2026-07-15T07:00:00")
    forming_open = _ms("2026-07-15T08:00:00")
    now_ms = _ms("2026-07-15T08:58:00")
    planner = HistoryRequestPlanner()

    partial = planner.plan(
        _history_request(previous_open, forming_open),
        HistoryAvailability(calendar_id="crypto.24x7.utc"),
        now_ms=now_ms,
    )
    assert partial.fetch_ranges == (TimeRange(previous_open, previous_open),)
    assert partial.exclusions[-1].reason is BoundaryReason.FORMING_BAR
    assert partial.exclusions[-1].disposition is HistoryDisposition.NOT_EXPECTED
    assert partial.terminal is False

    forming_only = planner.plan(
        _history_request(forming_open, forming_open),
        HistoryAvailability(calendar_id="crypto.24x7.utc"),
        now_ms=now_ms,
    )
    assert forming_only.disposition is HistoryDisposition.NOT_EXPECTED
    assert forming_only.fetch_ranges == ()
    assert forming_only.terminal is False


def test_gap_detector_never_reports_the_target_intervals_forming_bucket(monkeypatch) -> None:
    previous_open = _ms("2026-07-15T07:00:00")
    forming_open = _ms("2026-07-15T08:00:00")
    now_ms = _ms("2026-07-15T08:58:00")
    monkeypatch.setattr(
        "app.data_engine.backfill.gap_detector.time.time",
        lambda: now_ms / 1000,
    )

    async def _run() -> None:
        detector = GapDetector(
            BackfillConfig(gap_tolerance_bars=0),
            _EmptyStorage(),
        )
        gaps = await detector.detect(
            "BTCUSDT",
            intervals=["1h"],
            range_start_ms=previous_open,
            range_end_ms=forming_open,
            exchange="binance",
            market_type="futures",
        )
        assert [(gap.start_ms, gap.end_ms, gap.missing_bars) for gap in gaps] == [
            (previous_open, previous_open, 1)
        ]

        assert await detector.detect(
            "BTCUSDT",
            intervals=["1h"],
            range_start_ms=forming_open,
            range_end_ms=forming_open,
            exchange="binance",
            market_type="futures",
        ) == []

    asyncio.run(_run())


def test_query_engine_skips_a_forming_only_backfill_without_history_resolver(
    monkeypatch,
) -> None:
    forming_open = _ms("2026-07-15T08:00:00")
    now_ms = _ms("2026-07-15T08:58:00")
    monkeypatch.setattr(
        "app.data_engine.data_manager.query.time.time",
        lambda: now_ms / 1000,
    )
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=_EmptyStorage(),  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query(
        "BTCUSDT",
        "1h",
        start_ms=forming_open,
        end_ms=forming_open,
        exchange="binance",
        market_type="futures",
    )

    assert triggered == []
    assert result.backfill_triggered is False
    assert result.missing_ranges == []


def test_coordinator_clamps_or_completes_forming_requests_without_history_service(
    monkeypatch,
) -> None:
    previous_open = _ms("2026-07-15T07:00:00")
    forming_open = _ms("2026-07-15T08:00:00")
    now_ms = _ms("2026-07-15T08:58:00")
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: now_ms / 1000,
    )

    async def _run() -> None:
        engine = _Engine()
        coordinator = BackfillCoordinator(
            storage=_EmptyStorage(),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            engine=engine,
            loop=asyncio.get_running_loop(),
        )

        forming = await coordinator.request_and_wait(RepairRequest(
            symbol="BTCUSDT",
            interval="1h",
            start_ms=forming_open,
            end_ms=forming_open,
            exchange="binance",
            market_type="futures",
            request_id="forming-only",
        ))
        assert engine.calls == []
        assert forming.terminal_reason == BoundaryReason.FORMING_BAR.value
        assert forming.retryable is False

        await coordinator.request_and_wait(RepairRequest(
            symbol="BTCUSDT",
            interval="1h",
            start_ms=previous_open,
            end_ms=forming_open,
            exchange="binance",
            market_type="futures",
            request_id="closed-plus-forming",
        ))
        assert len(engine.calls) == 1
        assert engine.calls[0]["range_start_ms"] == previous_open
        assert engine.calls[0]["range_end_ms"] == previous_open

    asyncio.run(_run())
