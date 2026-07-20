from __future__ import annotations

import asyncio
import json
import threading
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.data_engine.data_manager.backfill_coordinator import (
    BackfillCoordinator,
    RepairRequest,
)
from app.data_engine.history import HistoryAvailability, SessionCalendar
from app.data_engine.storage.gap_ledger import GapLedger


def _utc_ms(value: str) -> int:
    return int(
        datetime.fromisoformat(value)
        .replace(tzinfo=timezone.utc)
        .timestamp()
        * 1000
    )


_SESSION_START_MS = _utc_ms("2026-07-13T09:30:00")
_SESSION_LAST_OPEN_MS = _utc_ms("2026-07-13T15:30:00")
_NOW_AFTER_SESSION_MS = _utc_ms("2026-07-13T17:00:00")


async def _ignore(*args, **kwargs) -> None:
    return None


def _session_calendar() -> SessionCalendar:
    return SessionCalendar(
        calendar_id="test.reconciliation.0930.utc",
        timezone_name="UTC",
        weekly_sessions={
            weekday: (("09:30", "16:30"),)
            for weekday in range(7)
        },
    )


def _request(*, request_id: str, metadata: dict | None = None) -> RepairRequest:
    return RepairRequest(
        symbol="TEST",
        interval="1h",
        start_ms=_SESSION_START_MS,
        end_ms=_SESSION_LAST_OPEN_MS,
        exchange="test",
        market_type="spot",
        reason="query_gap",
        metadata=dict(metadata or {}),
        request_id=request_id,
    )


def _coordinator(
    *,
    storage,
    ledger: GapLedger,
    calendar: SessionCalendar,
) -> BackfillCoordinator:
    context = SimpleNamespace(
        availability=HistoryAvailability(calendar_id=calendar.calendar_id),
        calendar=calendar,
    )
    return BackfillCoordinator(
        storage=storage,
        bars_backfilled=_ignore,
        emit_event=_ignore,
        gap_ledger=ledger,
        history_policy_resolver=lambda _request: context,
    )


def _seed_due_source_empty(ledger: GapLedger, request: RepairRequest) -> None:
    ledger.upsert_detected(request)
    ledger.mark_resolved(request, status="source_empty")
    ledger.mark_reconciled_checked(request, next_retry_at=0)


def test_restart_reconciliation_scans_session_tail_and_keeps_missing_tail_open(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: _NOW_AFTER_SESSION_MS / 1000,
    )

    class _MissingTailStorage:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def scan_gaps(self, **kwargs) -> dict:
            self.calls.append(dict(kwargs))
            if int(kwargs["end_ms"]) < _SESSION_LAST_OPEN_MS:
                return {
                    "gap_count": 0,
                    "scanned_bars": 6,
                    "truncated": False,
                }
            return {
                "gap_count": 1,
                "scanned_bars": 6,
                "truncated": False,
                "gaps": [{
                    "start_ms": _SESSION_LAST_OPEN_MS,
                    "end_ms": _SESSION_LAST_OPEN_MS,
                }],
            }

    async def _run() -> None:
        request = _request(request_id="missing-session-tail")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        _seed_due_source_empty(ledger, request)
        storage = _MissingTailStorage()
        coordinator = _coordinator(
            storage=storage,
            ledger=ledger,
            calendar=_session_calendar(),
        )

        report = await coordinator.reconcile_gap_ledger(stale_after_ms=0)

        assert report.resolved == 0
        assert report.skipped == 1
        assert len(storage.calls) == 1
        assert storage.calls[0]["start_ms"] == _SESSION_START_MS
        assert storage.calls[0]["end_ms"] == _SESSION_LAST_OPEN_MS
        assert ledger.get_status(request)["status"] == "source_empty"
        await coordinator.shutdown()

    asyncio.run(_run())


def test_restart_reconciliation_can_fill_complete_session_range(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: _NOW_AFTER_SESSION_MS / 1000,
    )

    class _CompleteStorage:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def scan_gaps(self, **kwargs) -> dict:
            self.calls.append(dict(kwargs))
            return {
                "gap_count": 0,
                "scanned_bars": 7,
                "truncated": False,
            }

    async def _run() -> None:
        request = _request(request_id="complete-session-range")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        _seed_due_source_empty(ledger, request)
        storage = _CompleteStorage()
        coordinator = _coordinator(
            storage=storage,
            ledger=ledger,
            calendar=_session_calendar(),
        )

        report = await coordinator.reconcile_gap_ledger(stale_after_ms=0)

        assert report.resolved == 1
        assert report.skipped == 0
        assert len(storage.calls) == 1
        assert storage.calls[0]["start_ms"] == _SESSION_START_MS
        assert storage.calls[0]["end_ms"] == _SESSION_LAST_OPEN_MS
        assert ledger.get_status(request)["status"] == "filled"
        await coordinator.shutdown()

    asyncio.run(_run())


@pytest.mark.parametrize("scan_outcome", ["contiguous", "gapped"])
def test_stale_scan_cas_cannot_overwrite_fresh_natural_key_upsert(
    tmp_path,
    monkeypatch,
    scan_outcome: str,
) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: _NOW_AFTER_SESSION_MS / 1000,
    )

    class _BlockingStorage:
        def __init__(self) -> None:
            self.started = threading.Event()
            self.release = threading.Event()

        def scan_gaps(self, **kwargs) -> dict:
            self.started.set()
            if not self.release.wait(timeout=5):
                raise TimeoutError("test did not release the blocked ledger scan")
            if scan_outcome == "contiguous":
                return {
                    "gap_count": 0,
                    "scanned_bars": 7,
                    "truncated": False,
                }
            return {
                "gap_count": 1,
                "scanned_bars": 6,
                "truncated": False,
                "gaps": [{
                    "start_ms": _SESSION_LAST_OPEN_MS,
                    "end_ms": _SESSION_LAST_OPEN_MS,
                }],
            }

    async def _run() -> None:
        old_request = _request(
            request_id=f"old-{scan_outcome}",
            metadata={"generation": "old"},
        )
        fresh_request = _request(
            request_id=f"fresh-{scan_outcome}",
            metadata={"generation": "fresh"},
        )
        ledger = GapLedger(tmp_path / "klines.sqlite")
        _seed_due_source_empty(ledger, old_request)
        storage = _BlockingStorage()
        coordinator = _coordinator(
            storage=storage,
            ledger=ledger,
            calendar=_session_calendar(),
        )

        task = asyncio.create_task(
            coordinator.reconcile_gap_ledger(stale_after_ms=0)
        )
        started = await asyncio.wait_for(
            asyncio.to_thread(storage.started.wait, 2),
            timeout=3,
        )
        if not started:
            storage.release.set()
            await asyncio.wait_for(task, timeout=3)
        assert started

        try:
            await asyncio.to_thread(
                ledger.upsert_detected,
                fresh_request,
                status="queued",
            )
        finally:
            storage.release.set()

        report = await asyncio.wait_for(task, timeout=5)
        fresh = ledger.get_status(fresh_request)

        assert report.resolved == 0
        assert fresh is not None
        assert fresh["status"] == "queued"
        assert fresh["last_checked_at"] is None
        assert fresh["next_retry_at"] is None
        assert fresh["last_error"] is None
        assert json.loads(fresh["metadata_json"])["generation"] == "fresh"
        await coordinator.shutdown()

    asyncio.run(_run())
