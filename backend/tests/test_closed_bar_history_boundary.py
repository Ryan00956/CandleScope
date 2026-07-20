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
from app.data_engine.storage.gap_ledger import GapLedger
from app.data_engine.history import (
    BoundaryReason,
    HistoryAvailability,
    HistoryDisposition,
    HistoryRequest,
    HistoryRequestPlanner,
    HistorySeriesKey,
    TimeRange,
)
from app.data_engine.interval_policy import (
    aggregate_kline_rows,
    last_closed_bar_open_ms,
)


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


def test_history_planner_keeps_a_just_closed_full_day_wall_clock_edge() -> None:
    daily_open = _ms("2026-07-15T00:00:00")
    daily_close = _ms("2026-07-15T23:59:59.999")
    planner = HistoryRequestPlanner()

    plan = planner.plan(
        _history_request(daily_open, daily_close, interval="1d"),
        HistoryAvailability(calendar_id="crypto.24x7.utc"),
        now_ms=_ms("2026-07-16T00:01:00"),
    )

    assert plan.disposition is HistoryDisposition.FETCH
    assert plan.fetch_ranges == (TimeRange(daily_open, daily_open),)
    assert plan.exclusions == ()


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


def test_query_engine_detects_an_exactly_one_bar_closed_daily_tail(monkeypatch) -> None:
    day_14 = _ms("2026-07-14T00:00:00")
    day_15 = _ms("2026-07-15T00:00:00")
    now_ms = _ms("2026-07-16T08:00:00")
    monkeypatch.setattr(
        "app.data_engine.data_manager.query.time.time",
        lambda: now_ms / 1000,
    )

    class _Storage:
        def query_bars(self, **kwargs):
            rows = [{
                "open_time": day_14,
                "close_time": day_15 - 1,
                "open": 1,
                "high": 2,
                "low": 1,
                "close": 2,
                "volume": 10,
                "source": "backfill",
            }]
            start_ms = kwargs.get("start_ms")
            end_ms = kwargs.get("end_ms")
            rows = [
                row for row in rows
                if (start_ms is None or row["open_time"] >= start_ms)
                and (end_ms is None or row["open_time"] <= end_ms)
            ]
            return list(reversed(rows)) if kwargs.get("order") == "DESC" else rows

    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=_Storage(),  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query(
        "BTCUSDT",
        "1d",
        start_ms=day_14,
        end_ms=day_15,
        limit=2,
        exchange="binance",
        market_type="futures",
    )

    assert [(item.start_ms, item.end_ms, item.reason) for item in result.missing_ranges] == [
        (day_15, day_15, "query_tail_gap"),
    ]
    assert triggered == [
        ("BTCUSDT", "1d", day_15, day_15, "binance", "futures"),
    ]
    assert result.has_tail_gap is True


def test_query_engine_does_not_treat_a_forming_daily_bucket_as_a_tail_gap(
    monkeypatch,
) -> None:
    closed_day = _ms("2026-07-15T00:00:00")
    forming_day = _ms("2026-07-16T00:00:00")
    now_ms = _ms("2026-07-16T08:00:00")
    monkeypatch.setattr(
        "app.data_engine.data_manager.query.time.time",
        lambda: now_ms / 1000,
    )

    class _Storage:
        def query_bars(self, **kwargs):
            return [{
                "open_time": closed_day,
                "close_time": forming_day - 1,
                "open": 1,
                "high": 2,
                "low": 1,
                "close": 2,
                "volume": 10,
                "source": "backfill",
            }]

    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=_Storage(),  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query(
        "BTCUSDT",
        "1d",
        start_ms=closed_day,
        end_ms=forming_day,
        limit=2,
        exchange="binance",
        market_type="futures",
    )

    assert result.missing_ranges == []
    assert result.backfill_triggered is False
    assert triggered == []


def test_component_aggregation_requires_a_complete_closed_daily_bucket() -> None:
    day_open = _ms("2026-07-15T00:00:00")
    minute_ms = 60_000
    rows = [{
        "open_time": day_open + index * minute_ms,
        "close_time": day_open + (index + 1) * minute_ms - 1,
        "open": 100 + index,
        "high": 101 + index,
        "low": 99 + index,
        "close": 100.5 + index,
        "volume": 1,
    } for index in range(24 * 60)]
    now_ms = _ms("2026-07-16T00:01:00")

    rebuilt = aggregate_kline_rows(
        rows,
        target_interval="1d",
        source_interval="1m",
        now_ms=now_ms,
    )
    assert len(rebuilt) == 1
    assert rebuilt[0]["open_time"] == day_open
    assert rebuilt[0]["close_time"] == _ms("2026-07-15T23:59:59.999")
    assert rebuilt[0]["volume"] == 1440
    assert rebuilt[0]["is_closed"] is True

    # This helper is only suitable for explicitly-derived/custom series.  A
    # standard exchange-native 1d repair remains authoritative REST work, but
    # if it is ever used for derivation it must reject even one missing minute.
    assert aggregate_kline_rows(
        rows[:177] + rows[178:],
        target_interval="1d",
        source_interval="1m",
        now_ms=now_ms,
    ) == []


def test_legacy_source_empty_for_a_forming_daily_bar_is_reaudited_when_closed(
    tmp_path,
    monkeypatch,
) -> None:
    daily_open = _ms("2026-07-15T00:00:00")
    daily_close = _ms("2026-07-15T23:59:59.999")
    recorded_while_forming_ms = _ms("2026-07-15T08:00:00")
    now_after_close_ms = _ms("2026-07-16T00:01:00")
    request = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=daily_open,
        # Older rows may use a full-day wall-clock right edge instead of the
        # canonical open time.  It still represents exactly the 7/15 candle.
        end_ms=daily_close,
        exchange="binance",
        market_type="futures",
        request_id="legacy-forming-source-empty",
    )
    monkeypatch.setattr(
        "app.data_engine.storage.gap_ledger._now_ms",
        lambda: recorded_while_forming_ms,
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    ledger.upsert_detected(request)
    ledger.mark_resolved(request, status="source_empty")
    status = ledger.get_status(request)
    assert status is not None
    assert status["next_retry_at"] > now_after_close_ms

    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: now_after_close_ms / 1000,
    )
    coordinator = BackfillCoordinator(
        storage=_EmptyStorage(),
        bars_backfilled=_ignore,
        emit_event=_ignore,
        gap_ledger=ledger,
    )

    # The cooldown still has almost eight hours left, but its source-empty
    # observation included the then-forming target bar, so it must not suppress
    # this first closed-bar audit.
    assert asyncio.run(coordinator._should_skip_audited_gap(request)) is False


def test_source_empty_cache_reopens_after_close_and_fails_closed_while_uncertain(
    tmp_path,
    monkeypatch,
) -> None:
    daily_open = _ms("2026-07-15T00:00:00")
    daily_close = _ms("2026-07-15T23:59:59.999")
    recorded_while_forming_ms = _ms("2026-07-15T08:00:00")
    still_forming_ms = _ms("2026-07-15T12:00:00")
    now_after_close_ms = _ms("2026-07-16T00:01:00")
    request = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=daily_open,
        end_ms=daily_close,
        exchange="binance",
        market_type="futures",
        request_id="cached-forming-source-empty",
    )
    monkeypatch.setattr(
        "app.data_engine.storage.gap_ledger._now_ms",
        lambda: recorded_while_forming_ms,
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    ledger.upsert_detected(request)
    ledger.mark_resolved(request, status="source_empty")

    async def _run() -> None:
        coordinator = BackfillCoordinator(
            storage=_EmptyStorage(),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            gap_ledger=ledger,
        )

        monkeypatch.setattr(
            "app.data_engine.data_manager.backfill_coordinator.time.time",
            lambda: still_forming_ms / 1000,
        )
        assert await coordinator.refresh_suppressions() == 1
        forming_suppression = coordinator.get_repair_suppression(
            "BTCUSDT",
            "1d",
            daily_open,
            daily_close,
            "binance",
            "futures",
        )
        assert forming_suppression is not None
        assert forming_suppression["ledger_status"] == "source_empty"

        monkeypatch.setattr(
            "app.data_engine.data_manager.backfill_coordinator.time.time",
            lambda: now_after_close_ms / 1000,
        )
        assert await coordinator.refresh_suppressions() == 1
        assert coordinator.get_repair_suppression(
            "BTCUSDT",
            "1d",
            daily_open,
            daily_close,
            "binance",
            "futures",
        ) is None

        unknown_calendar = BackfillCoordinator(
            storage=_EmptyStorage(),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            gap_ledger=ledger,
            history_policy_resolver=lambda _request: HistoryAvailability(
                calendar_id="missing.session.calendar"
            ),
        )
        assert await unknown_calendar.refresh_suppressions() == 1
        unknown_suppression = unknown_calendar.get_repair_suppression(
            "BTCUSDT",
            "1d",
            daily_open,
            daily_close,
            "binance",
            "futures",
        )
        assert unknown_suppression is not None
        assert unknown_suppression["ledger_status"] == "source_empty"

        await coordinator.shutdown()
        await unknown_calendar.shutdown()

    asyncio.run(_run())


def test_ledger_storage_reconciliation_closes_a_legacy_full_day_row(tmp_path, monkeypatch) -> None:
    daily_open = _ms("2026-07-15T00:00:00")
    daily_close = _ms("2026-07-15T23:59:59.999")
    now_after_close_ms = _ms("2026-07-16T00:01:00")
    legacy = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=daily_open,
        end_ms=daily_close,
        exchange="binance",
        market_type="futures",
        request_id="legacy-full-day-source-empty",
    )
    verified_range = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=daily_open,
        end_ms=daily_open,
        exchange="binance",
        market_type="futures",
        request_id="known-authoritative-daily-range",
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    ledger.upsert_detected(legacy)
    ledger.mark_resolved(legacy, status="source_empty")

    class _ContiguousStorage(_EmptyStorage):
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def scan_gaps(self, **kwargs):
            self.calls.append(kwargs)
            return {
                "gap_count": 0,
                "scanned_bars": 1,
                "truncated": False,
            }

    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: now_after_close_ms / 1000,
    )

    async def _run() -> None:
        storage = _ContiguousStorage()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=_ignore,
            emit_event=_ignore,
            gap_ledger=ledger,
        )
        # A caller that has just imported authoritative history can supply its
        # exact range.  The coordinator still scans storage before it closes
        # any overlapping inactive ledger row.
        report = await coordinator.reconcile_gap_ledger(ranges=[verified_range])

        assert report.scanned == 1
        assert report.resolved == 1
        assert report.skipped == 0
        assert storage.calls == [{
            "symbol": "BTCUSDT",
            "interval": "1d",
            "start_ms": daily_open,
            "end_ms": daily_open,
            "exchange": "binance",
            "market_type": "futures",
            "limit": 50_000,
        }]
        assert ledger.get_status(legacy)["status"] == "filled"

    asyncio.run(_run())


def test_ledger_storage_reconciliation_never_closes_a_forming_range(tmp_path, monkeypatch) -> None:
    forming_open = _ms("2026-07-16T00:00:00")
    now_ms = _ms("2026-07-16T08:00:00")
    forming = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=forming_open,
        end_ms=forming_open,
        exchange="binance",
        market_type="futures",
        request_id="forming-ledger-row",
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    ledger.upsert_detected(forming)
    ledger.mark_deferred(forming, status="not_expected", reason="forming_bar")

    class _Storage(_EmptyStorage):
        def scan_gaps(self, **kwargs):
            raise AssertionError("forming ledger range must not be scanned or closed")

    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: now_ms / 1000,
    )

    async def _run() -> None:
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            gap_ledger=ledger,
        )
        report = await coordinator.reconcile_gap_ledger()
        assert report.scanned == 0
        assert report.resolved == 0
        assert report.skipped == 1
        assert ledger.get_status(forming)["status"] == "not_expected"

    asyncio.run(_run())


def test_gap_audit_automatically_reconciles_contiguous_legacy_ledger_rows(
    tmp_path,
    monkeypatch,
) -> None:
    daily_open = _ms("2026-07-15T00:00:00")
    daily_close = _ms("2026-07-15T23:59:59.999")
    now_after_close_ms = _ms("2026-07-16T00:01:00")
    legacy = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=daily_open,
        end_ms=daily_close,
        exchange="binance",
        market_type="futures",
        request_id="gap-audit-legacy-row",
    )
    monkeypatch.setattr(
        "app.data_engine.storage.gap_ledger._now_ms",
        lambda: now_after_close_ms - 2 * 86_400_000,
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    ledger.upsert_detected(legacy)
    ledger.mark_resolved(legacy, status="source_empty")

    class _ContiguousStorage(_EmptyStorage):
        def scan_gaps(self, **kwargs):
            return {
                "gap_count": 0,
                "scanned_bars": 1,
                "truncated": False,
            }

    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: now_after_close_ms / 1000,
    )

    async def _run() -> None:
        coordinator = BackfillCoordinator(
            storage=_ContiguousStorage(),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            gap_ledger=ledger,
        )
        report = await coordinator.audit_storage_series(
            [("binance", "futures", "BTCUSDT", "1d")],
            repair=False,
        )
        assert report.scanned == 1
        assert report.ledger_scanned == 1
        assert report.ledger_resolved == 1
        assert ledger.get_status(legacy)["status"] == "filled"

    asyncio.run(_run())
