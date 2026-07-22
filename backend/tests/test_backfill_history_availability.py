from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

from app.data_engine.data_manager.backfill_coordinator import (
    BackfillCoordinator,
    RepairRequest,
)
from app.data_engine.history import (
    AlwaysOpenCalendar,
    BoundaryReason,
    BoundaryState,
    CalendarRegistry,
    HistoryAvailability,
    HistoryAvailabilityService,
    HistoryBoundaryRepository,
    HistorySeriesKey,
    SessionCalendar,
    TimeBound,
)
from app.data_engine.storage.gap_ledger import GapLedger
from app.exchanges import (
    HistoryAvailabilityPolicy,
    HistoryEmptyPageSemantics,
)


async def _ignore(*args, **kwargs) -> None:
    return None


def _request(
    start_ms: int,
    end_ms: int,
    *,
    request_id: str,
    reason: str = "visible_load_more",
) -> RepairRequest:
    return RepairRequest(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=start_ms,
        end_ms=end_ms,
        exchange="binance",
        market_type="spot",
        reason=reason,
        request_id=request_id,
    )


def _report(
    *,
    source_complete: bool = False,
    retryable: bool = False,
    exhausted_before_ms: int | None = None,
):
    return SimpleNamespace(
        status="completed",
        errors=[],
        reconcile_result=SimpleNamespace(
            bars_written=0,
            custom_bars_written=0,
        ),
        fetch_results=[SimpleNamespace(
            source_complete=source_complete,
            retryable=retryable,
            exhausted_before_ms=exhausted_before_ms,
        )],
    )


class _Storage:
    def __init__(
        self,
        *,
        earliest_ms: int | None = None,
        rows: list[dict] | None = None,
    ) -> None:
        self.earliest_ms = earliest_ms
        self.rows = list(rows or [])

    def get_bounds(self, *args, **kwargs) -> dict:
        return {
            "earliest_open_time": self.earliest_ms,
            "latest_open_time": self.earliest_ms,
            "total_count": int(self.earliest_ms is not None),
        }

    def query_bars(self, **kwargs) -> list[dict]:
        start_ms = int(kwargs["start_ms"])
        end_ms = int(kwargs["end_ms"])
        return [
            row
            for row in self.rows
            if start_ms <= int(row["open_time"]) <= end_ms
        ]


class _Engine:
    def __init__(self, report) -> None:
        self.report = report
        self.calls: list[dict] = []

    async def run(self, **kwargs):
        self.calls.append(kwargs)
        return self.report


def _context(
    *,
    availability: HistoryAvailability,
    calendar,
    semantics: HistoryEmptyPageSemantics,
):
    policy = HistoryAvailabilityPolicy(
        empty_page_semantics=semantics,
        calendar_id=calendar.calendar_id,
    )
    return SimpleNamespace(
        availability=availability,
        calendar=calendar,
        policy=policy,
        empty_page_semantics=semantics,
    )


def test_coordinator_clamps_request_before_engine_execution() -> None:
    async def _run() -> None:
        calendar = AlwaysOpenCalendar()
        service = HistoryAvailabilityService()
        context = _context(
            availability=HistoryAvailability(
                upstream_start=TimeBound(60_000, BoundaryReason.UPSTREAM_START),
                calendar_id=calendar.calendar_id,
            ),
            calendar=calendar,
            semantics=HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY,
        )
        engine = _Engine(_report())
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            history_service=service,
            history_policy_resolver=lambda request: context,
        )

        await coordinator.request_and_wait(_request(0, 120_000, request_id="clamp"))

        assert len(engine.calls) == 3
        assert {
            (call["range_start_ms"], call["range_end_ms"])
            for call in engine.calls
        } == {(60_000, 120_000)}

    asyncio.run(_run())


def test_coordinator_does_not_request_a_closed_session() -> None:
    async def _run() -> None:
        calendar = SessionCalendar(
            calendar_id="test.weekday",
            timezone_name="UTC",
            weekly_sessions={0: [("09:00", "10:00")]},
        )
        calendars = CalendarRegistry()
        calendars.register(calendar.calendar_id, calendar)
        service = HistoryAvailabilityService(calendars=calendars)
        context = _context(
            availability=HistoryAvailability(calendar_id=calendar.calendar_id),
            calendar=calendar,
            semantics=HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY,
        )
        engine = _Engine(_report())
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            engine=engine,
            loop=asyncio.get_running_loop(),
            history_service=service,
            history_policy_resolver=lambda request: context,
        )
        sunday_ms = int(
            datetime(2026, 7, 19, 9, tzinfo=timezone.utc).timestamp() * 1000
        )

        outcome = await coordinator.request_and_wait(
            _request(sunday_ms, sunday_ms, request_id="closed")
        )

        assert engine.calls == []
        assert outcome.terminal_reason == BoundaryReason.MARKET_CLOSED.value
        assert outcome.retryable is False
        assert outcome.verified_contiguous is True

    asyncio.run(_run())


def test_authoritative_empty_range_confirms_after_repeated_attempt_evidence(
    tmp_path,
) -> None:
    async def _run() -> None:
        calendar = AlwaysOpenCalendar()
        repository = HistoryBoundaryRepository(tmp_path / "history.sqlite3")
        service = HistoryAvailabilityService(boundaries=repository)
        context = _context(
            availability=HistoryAvailability(
                calendar_id=calendar.calendar_id,
                revision="cap-v1",
            ),
            calendar=calendar,
            semantics=HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY,
        )
        engine = _Engine(_report(source_complete=True))
        coordinator = BackfillCoordinator(
            storage=_Storage(earliest_ms=120_000),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            history_service=service,
            history_policy_resolver=lambda request: context,
        )

        first = await coordinator.request_and_wait(
            _request(0, 60_000, request_id="evidence-1")
        )
        confirmed = service.get_boundary(
            HistorySeriesKey("binance", "spot", "BTCUSDT", "kline", "1m"),
            "left",
            include_stale=True,
        )
        second = await coordinator.request_and_wait(
            _request(0, 60_000, request_id="evidence-2")
        )
        third = await coordinator.request_and_wait(
            _request(0, 60_000, request_id="already-exhausted")
        )

        assert first.terminal_reason == "provider_exhausted"
        assert confirmed is not None
        assert confirmed.bound.state is BoundaryState.CONFIRMED
        assert confirmed.bound.value_ms == 120_000
        assert second.terminal_reason == BoundaryReason.SOURCE_EXHAUSTED.value
        assert third.terminal_reason == BoundaryReason.SOURCE_EXHAUSTED.value
        assert len(engine.calls) == 2

    asyncio.run(_run())


def test_terminal_empty_semantics_confirms_on_first_evidence(tmp_path) -> None:
    async def _run() -> None:
        calendar = AlwaysOpenCalendar()
        service = HistoryAvailabilityService(
            boundaries=HistoryBoundaryRepository(tmp_path / "history.sqlite3")
        )
        context = _context(
            availability=HistoryAvailability(
                calendar_id=calendar.calendar_id,
                revision="terminal-v1",
            ),
            calendar=calendar,
            semantics=HistoryEmptyPageSemantics.TERMINAL_EXHAUSTION,
        )
        ledger = GapLedger(tmp_path / "gaps.sqlite3")
        engine = _Engine(_report(source_complete=True))
        coordinator = BackfillCoordinator(
            storage=_Storage(earliest_ms=120_000),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            engine=engine,
            loop=asyncio.get_running_loop(),
            gap_ledger=ledger,
            history_service=service,
            history_policy_resolver=lambda request: context,
        )

        request = _request(0, 60_000, request_id="terminal")
        outcome = await coordinator.request_and_wait(request)
        boundary = service.get_boundary(
            HistorySeriesKey("binance", "spot", "BTCUSDT", "kline", "1m"),
            "left",
            include_stale=True,
        )

        assert outcome.terminal_reason == "provider_exhausted"
        assert outcome.verified_contiguous is False
        assert outcome.retryable is False
        assert len(engine.calls) == 1
        assert ledger.get_status(request)["status"] == "source_empty"
        assert ledger.get_status(request)["next_retry_at"] is not None
        assert boundary is not None
        assert boundary.bound.state is BoundaryState.CONFIRMED

    asyncio.run(_run())


def test_retryable_empty_result_never_persists_a_boundary(tmp_path) -> None:
    async def _run() -> None:
        calendar = AlwaysOpenCalendar()
        service = HistoryAvailabilityService(
            boundaries=HistoryBoundaryRepository(tmp_path / "history.sqlite3")
        )
        context = _context(
            availability=HistoryAvailability(calendar_id=calendar.calendar_id),
            calendar=calendar,
            semantics=HistoryEmptyPageSemantics.TERMINAL_EXHAUSTION,
        )
        coordinator = BackfillCoordinator(
            storage=_Storage(earliest_ms=120_000),
            bars_backfilled=_ignore,
            emit_event=_ignore,
            engine=_Engine(_report(source_complete=True, retryable=True)),
            loop=asyncio.get_running_loop(),
            history_service=service,
            history_policy_resolver=lambda request: context,
        )

        outcome = await coordinator.request_and_wait(
            _request(0, 60_000, request_id="retryable")
        )

        assert outcome.retryable is True
        assert outcome.terminal_reason is None
        assert service.get_boundary(
            HistorySeriesKey("binance", "spot", "BTCUSDT", "kline", "1m"),
            "left",
            include_stale=True,
        ) is None

    asyncio.run(_run())


def test_range_verification_ignores_expected_session_closures() -> None:
    async def _run() -> None:
        monday_ms = int(
            datetime(2026, 7, 20, 9, tzinfo=timezone.utc).timestamp() * 1000
        )
        tuesday_ms = int(
            datetime(2026, 7, 21, 9, tzinfo=timezone.utc).timestamp() * 1000
        )
        calendar = SessionCalendar(
            calendar_id="test.two-days",
            timezone_name="UTC",
            weekly_sessions={
                0: [("09:00", "10:00")],
                1: [("09:00", "10:00")],
            },
        )
        context = _context(
            availability=HistoryAvailability(calendar_id=calendar.calendar_id),
            calendar=calendar,
            semantics=HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY,
        )
        coordinator = BackfillCoordinator(
            storage=_Storage(rows=[
                {"open_time": monday_ms},
                {"open_time": tuesday_ms},
            ]),
            bars_backfilled=_ignore,
            emit_event=_ignore,
        )
        request = RepairRequest(
            symbol="BTCUSDT",
            interval="1h",
            start_ms=monday_ms,
            end_ms=tuesday_ms,
            request_id="verify-sessions",
        )

        verification = await coordinator._verify_request_range(
            request,
            context=context,
        )

        assert verification == {
            "verified_contiguous": True,
            "remaining_missing_bars": 0,
            "expected_bars": 2,
            "actual_bars": 2,
        }

    asyncio.run(_run())
