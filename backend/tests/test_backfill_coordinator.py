from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from app.data_engine.data_manager.backfill_coordinator import (
    BackfillCoordinator,
    RepairOutcome,
    RepairRequest,
)
from app.data_engine.history.models import HistoryDisposition
from app.data_engine.storage.gap_ledger import GapLedger


@dataclass(slots=True)
class _ReconcileResult:
    bars_written: int = 0


@dataclass(slots=True)
class _RepairReport:
    status: Any
    errors: list[str] = field(default_factory=list)
    reconcile_result: _ReconcileResult | None = field(default_factory=_ReconcileResult)


class _EventBus:
    def __init__(self) -> None:
        self.events: list[Any] = []

    async def emit(self, event: Any) -> None:
        self.events.append(event)


class _DataManager:
    def __init__(self) -> None:
        self.event_bus = _EventBus()
        self.loaded: list[tuple] = []

    async def on_bars_backfilled(self, symbol, interval, bars, **kwargs):
        self.loaded.append((symbol, interval, bars, kwargs))


class _Storage:
    pass


class _Ledger:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def upsert_detected(self, request, *, status: str = "queued") -> None:
        self.events.append(("detected", {"id": request.request_id, "status": status}))

    def mark_started(self, request, *, attempt: int) -> None:
        self.events.append(("started", {"id": request.request_id, "attempt": attempt}))

    def mark_retry_wait(self, request, *, attempt: int, error: str | None, next_retry_at: int) -> None:
        self.events.append(("retry_wait", {"id": request.request_id, "attempt": attempt, "error": error}))

    def mark_verifying(self, request) -> None:
        self.events.append(("verifying", {"id": request.request_id}))

    def mark_resolved(self, request, *, status: str, missing_count: int | None = None, error: str | None = None) -> None:
        self.events.append((
            "resolved",
            {"id": request.request_id, "status": status, "missing_count": missing_count, "error": error},
        ))


async def _wait_until(predicate, *, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    assert predicate()


def _request(start_ms: int, end_ms: int, *, request_id: str | None = None) -> RepairRequest:
    kwargs = {"request_id": request_id} if request_id is not None else {}
    return RepairRequest(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=start_ms,
        end_ms=end_ms,
        exchange="binance",
        market_type="spot",
        **kwargs,
    )


def test_backfill_coordinator_merges_pending_requests_for_same_series() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []
                self.first_started = asyncio.Event()
                self.release_first = asyncio.Event()

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 1:
                    self.first_started.set()
                    await self.release_first.wait()
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        first_id = coord.request(_request(0, 100_000, request_id="current"))
        await engine.first_started.wait()

        pending_id = coord.request(_request(200_000, 300_000, request_id="pending"))
        merged_id = coord.request(_request(250_000, 500_000, request_id="merge"))

        assert first_id == "current"
        assert pending_id == "pending"
        assert merged_id == "pending"
        snapshot = coord.snapshot()
        assert snapshot["submitted"] == 3
        assert snapshot["merged"] == 1
        assert len(snapshot["pending"]) == 1

        engine.release_first.set()
        await _wait_until(lambda: len(engine.calls) == 2 and not coord.snapshot()["active"])

        assert engine.calls[0]["range_start_ms"] == 0
        assert engine.calls[0]["range_end_ms"] == 100_000
        assert engine.calls[1]["range_start_ms"] == 200_000
        assert engine.calls[1]["range_end_ms"] == 500_000
        assert engine.calls[1]["metadata"]["merged_request_ids"] == ["pending", "merge"]

    asyncio.run(_run())


def test_backfill_coordinator_waits_for_cross_thread_deduped_request() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def run(self, **kwargs):
                self.started.set()
                await self.release.wait()
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        canonical_id = coord.request(_request(0, 60_000, request_id="canonical"))
        await engine.started.wait()

        provisional_id = await asyncio.to_thread(
            coord.trigger,
            "BTCUSDT",
            "1m",
            0,
            60_000,
            "binance",
            "spot",
        )
        assert provisional_id != canonical_id

        engine.release.set()
        outcome = await asyncio.wait_for(
            coord.wait_for_request(provisional_id),
            timeout=1.0,
        )

        assert outcome is not None
        assert outcome.request.request_id == canonical_id
        assert coord.snapshot()["deduped"] == 1
        assert coord._request_id_aliases[provisional_id] == canonical_id
        assert list(coord._outcomes) == [canonical_id]
        assert await coord.wait_for_request(provisional_id) is outcome

    asyncio.run(_run())


def test_cancelling_one_deduped_waiter_does_not_cancel_shared_repair(
    tmp_path,
) -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                self.started.set()
                await self.release.wait()
                return _RepairReport(status="completed")

        class _CompleteStorage:
            def query_bars(self, **kwargs):
                return [
                    {"open_time": 0},
                    {"open_time": 60_000},
                ]

        engine = _Engine()
        dm = _DataManager()
        ledger = GapLedger(tmp_path / "klines.sqlite")
        coordinator = BackfillCoordinator(
            storage=_CompleteStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            gap_ledger=ledger,
            base_delay_seconds=0,
        )
        first_request = _request(0, 60_000, request_id="shared-first")
        second_request = _request(0, 60_000, request_id="shared-second")

        first_waiter = asyncio.create_task(
            coordinator.request_and_wait(first_request)
        )
        await engine.started.wait()
        second_waiter = asyncio.create_task(
            coordinator.request_and_wait(second_request)
        )
        await _wait_until(lambda: coordinator.snapshot()["deduped"] == 1)

        first_waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_waiter

        engine.release.set()
        outcome = await asyncio.wait_for(second_waiter, timeout=1.0)

        assert outcome.request.request_id == first_request.request_id
        assert len(engine.calls) == 1
        assert ledger.get_status(first_request)["status"] == "filled"
        snapshot = coordinator.snapshot()
        assert snapshot["active"] == []
        assert snapshot["pending"] == []
        await coordinator.shutdown()

    asyncio.run(_run())


def test_finalizing_parent_retains_series_ownership_and_dedupes_submit() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )
        finalize_started = asyncio.Event()
        release_finalize = asyncio.Event()
        original_finalize = coordinator._scheduler._finalize

        async def _blocking_finalize(request, outcome):
            finalize_started.set()
            await release_finalize.wait()
            await original_finalize(request, outcome)

        coordinator._scheduler._finalize = _blocking_finalize
        first_request = _request(0, 60_000, request_id="finalizing-first")
        second_request = _request(0, 60_000, request_id="finalizing-second")
        first_waiter = asyncio.create_task(
            coordinator.request_and_wait(first_request)
        )

        await finalize_started.wait()
        canonical_id = coordinator.request(second_request)
        assert canonical_id == first_request.request_id
        assert coordinator.snapshot()["deduped"] == 1
        assert len(engine.calls) == 1
        second_waiter = asyncio.create_task(
            coordinator.wait_for_request(second_request.request_id)
        )

        release_finalize.set()
        first_outcome, second_outcome = await asyncio.wait_for(
            asyncio.gather(first_waiter, second_waiter),
            timeout=1.0,
        )

        assert second_outcome is first_outcome
        assert len(engine.calls) == 1
        snapshot = coordinator.snapshot()
        assert snapshot["active"] == []
        assert snapshot["pending"] == []
        await coordinator.shutdown()

    asyncio.run(_run())


def test_shutdown_during_parent_finalization_completes_shared_waiter() -> None:
    async def _run() -> None:
        class _Engine:
            async def run(self, **kwargs):
                return _RepairReport(status="completed")

        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )
        finalize_started = asyncio.Event()

        async def _blocking_finalize(request, outcome):
            finalize_started.set()
            await asyncio.Event().wait()

        coordinator._scheduler._finalize = _blocking_finalize
        waiter = asyncio.create_task(
            coordinator.request_and_wait(
                _request(0, 60_000, request_id="shutdown-finalizing")
            )
        )
        await finalize_started.wait()

        await asyncio.wait_for(coordinator.shutdown(), timeout=1.0)
        outcome = await asyncio.wait_for(waiter, timeout=1.0)

        assert outcome.status == "failed"
        assert outcome.error == "cancelled"
        assert coordinator._futures == {}
        snapshot = coordinator.snapshot()
        assert snapshot["active"] == []
        assert snapshot["pending"] == []

    asyncio.run(_run())


def test_shutdown_during_execute_does_not_start_a_new_finalizer() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.started = asyncio.Event()

            async def run(self, **kwargs):
                self.started.set()
                await asyncio.Event().wait()

        engine = _Engine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )
        finalize_started = asyncio.Event()

        async def _blocking_finalize(request, outcome):
            finalize_started.set()
            await asyncio.Event().wait()

        coordinator._scheduler._finalize = _blocking_finalize
        waiter = asyncio.create_task(
            coordinator.request_and_wait(
                _request(0, 60_000, request_id="shutdown-executing")
            )
        )
        await engine.started.wait()

        await asyncio.wait_for(coordinator.shutdown(), timeout=1.0)
        outcome = await asyncio.wait_for(waiter, timeout=1.0)

        assert outcome.status == "failed"
        assert outcome.error == "cancelled"
        assert finalize_started.is_set() is False
        assert coordinator._futures == {}
        snapshot = coordinator.snapshot()
        assert snapshot["active"] == []
        assert snapshot["pending"] == []

    asyncio.run(_run())


def test_backfill_coordinator_waits_for_cross_thread_merged_request() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []
                self.first_started = asyncio.Event()
                self.release_first = asyncio.Event()

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 1:
                    self.first_started.set()
                    await self.release_first.wait()
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        coord.request(_request(0, 100_000, request_id="current"))
        await engine.first_started.wait()
        canonical_id = coord.request(
            _request(200_000, 300_000, request_id="pending")
        )

        provisional_id = await asyncio.to_thread(
            coord.trigger,
            "BTCUSDT",
            "1m",
            250_000,
            500_000,
            "binance",
            "spot",
        )
        assert provisional_id != canonical_id
        await _wait_until(lambda: coord.snapshot()["merged"] == 1)

        engine.release_first.set()
        outcome = await asyncio.wait_for(
            coord.wait_for_request(provisional_id),
            timeout=1.0,
        )

        assert outcome is not None
        assert outcome.request.request_id == canonical_id
        assert outcome.request.start_ms == 200_000
        assert outcome.request.end_ms == 500_000
        assert coord._request_id_aliases[provisional_id] == canonical_id
        assert provisional_id not in coord._outcomes
        assert await coord.wait_for_request(provisional_id) is outcome

    asyncio.run(_run())


def test_backfill_coordinator_bounds_aliases_without_copying_outcomes() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def run(self, **kwargs):
                self.started.set()
                await self.release.wait()
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )
        coord._max_request_id_aliases = 3

        canonical_id = coord.request(_request(0, 60_000, request_id="canonical"))
        await engine.started.wait()
        provisional_ids = []
        for _ in range(5):
            provisional_ids.append(await asyncio.to_thread(
                coord.trigger,
                "BTCUSDT",
                "1m",
                0,
                60_000,
                "binance",
                "spot",
            ))
        await _wait_until(lambda: coord.snapshot()["deduped"] == 5)

        assert len(coord._request_id_aliases) == 3
        assert provisional_ids[-1] in coord._request_id_aliases

        engine.release.set()
        outcome = await asyncio.wait_for(
            coord.wait_for_request(provisional_ids[-1]),
            timeout=1.0,
        )

        assert outcome is not None
        assert outcome.request.request_id == canonical_id
        assert list(coord._outcomes) == [canonical_id]
        assert all(request_id not in coord._outcomes for request_id in provisional_ids)

    asyncio.run(_run())


def test_backfill_coordinator_bounds_canonical_and_scheduler_outcomes() -> None:
    async def _run() -> None:
        class _Engine:
            async def run(self, **kwargs):
                return _RepairReport(status="completed")

        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )
        coord._max_retained_outcomes = 2
        coord._scheduler._max_retained_outcomes = 2

        for index in range(4):
            await coord.request_and_wait(
                _request(
                    index * 120_000,
                    index * 120_000 + 60_000,
                    request_id=f"request-{index}",
                )
            )

        assert list(coord._outcomes) == ["request-2", "request-3"]
        assert list(coord._scheduler._outcomes) == ["request-2", "request-3"]

    asyncio.run(_run())


def test_backfill_coordinator_preserves_highest_priority_when_merging_pending() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []
                self.first_started = asyncio.Event()
                self.release_first = asyncio.Event()

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 1:
                    self.first_started.set()
                    await self.release_first.wait()
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        coord.request(_request(0, 60_000, request_id="current"))
        await engine.first_started.wait()

        coord.request(RepairRequest(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=120_000,
            end_ms=180_000,
            exchange="binance",
            market_type="spot",
            reason="latest_refresh",
            priority=80,
            request_id="latest",
        ))
        coord.request(RepairRequest(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=60_000,
            end_ms=300_000,
            exchange="binance",
            market_type="spot",
            reason="initial_history",
            priority=10,
            request_id="history",
        ))

        snapshot = coord.snapshot()
        assert snapshot["pending"][0]["priority"] == 10
        assert snapshot["pending"][0]["range_start_ms"] == 60_000
        assert snapshot["pending"][0]["range_end_ms"] == 300_000

        engine.release_first.set()
        await _wait_until(lambda: len(engine.calls) == 2 and not coord.snapshot()["active"])
        assert engine.calls[1]["metadata"]["priority"] == 10
        assert engine.calls[1]["range_start_ms"] == 60_000
        assert engine.calls[1]["range_end_ms"] == 300_000

    asyncio.run(_run())


def test_backfill_scheduler_runs_different_series_concurrently() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []
                self.active = 0
                self.max_active = 0
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                self.active += 1
                self.max_active = max(self.max_active, self.active)
                if len(self.calls) == 2:
                    self.started.set()
                await self.release.wait()
                self.active -= 1
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            max_concurrency=2,
            chunk_bars=1,
        )

        btc = asyncio.create_task(coord.request_and_wait(_request(0, 60_000)))
        eth = asyncio.create_task(coord.request_and_wait(RepairRequest(
            symbol="ETHUSDT",
            interval="1m",
            start_ms=0,
            end_ms=60_000,
            exchange="binance",
            market_type="spot",
        )))

        await engine.started.wait()
        assert engine.max_active == 2
        assert {call["symbol"] for call in engine.calls[:2]} == {"BTCUSDT", "ETHUSDT"}

        engine.release.set()
        await asyncio.gather(btc, eth)

    asyncio.run(_run())


def test_backfill_scheduler_prioritizes_foreground_after_active_chunk() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []
                self.first_started = asyncio.Event()
                self.release_first = asyncio.Event()

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 1:
                    self.first_started.set()
                    await self.release_first.wait()
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            max_concurrency=1,
            chunk_bars=1,
        )

        background = asyncio.create_task(coord.request_and_wait(RepairRequest(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=0,
            end_ms=180_000,
            exchange="binance",
            market_type="spot",
            reason="background_gap_audit",
            request_id="background",
        )))
        await engine.first_started.wait()

        foreground = asyncio.create_task(coord.request_and_wait(RepairRequest(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=240_000,
            end_ms=240_000,
            exchange="binance",
            market_type="spot",
            reason="initial_history",
            request_id="foreground",
        )))

        engine.release_first.set()
        await _wait_until(lambda: len(engine.calls) >= 2)
        assert engine.calls[0]["range_start_ms"] == 0
        assert engine.calls[1]["range_start_ms"] == 240_000
        assert engine.calls[1]["metadata"]["reason"] == "initial_history"

        await asyncio.gather(background, foreground)

    asyncio.run(_run())


def test_backfill_scheduler_runs_initial_history_from_newest_chunk() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            max_concurrency=1,
            chunk_bars=1,
        )

        await coord.request_and_wait(RepairRequest(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=0,
            end_ms=180_000,
            exchange="binance",
            market_type="spot",
            reason="initial_history",
        ))

        assert [call["range_start_ms"] for call in engine.calls] == [
            180_000,
            120_000,
            60_000,
            0,
        ]

    asyncio.run(_run())


def test_backfill_scheduler_wakes_after_rate_limit_without_new_submit() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )
        request = _request(0, 60_000, request_id="rate-limited")
        bucket = coord._scheduler._bucket_for(request)
        bucket.capacity = 1
        bucket.tokens = 0
        bucket.refill_per_second = 20.0

        task = asyncio.create_task(coord.request_and_wait(request))
        await asyncio.sleep(0)

        snapshot = coord.snapshot()
        assert engine.calls == []
        assert snapshot["ready_chunks"] == 1
        assert snapshot["next_drain_in_ms"] is not None
        assert snapshot["rate_limited_skips"] == 1
        scheduler_bucket = snapshot["scheduler_buckets"]["binance:spot"]
        assert scheduler_bucket["scope"] == "scheduler_dispatch"
        assert scheduler_bucket["refill_per_second"] == 20.0

        await _wait_until(lambda: len(engine.calls) == 1)
        outcome = await task

        assert outcome.status == "completed"
        assert coord.snapshot()["next_drain_in_ms"] is None

    asyncio.run(_run())


def test_backfill_coordinator_retries_failed_report_until_success() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.calls = 0

            async def run(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    return _RepairReport(status="failed", errors=["temporary"])
                return _RepairReport(status="completed")

        dm = _DataManager()
        engine = _Engine()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            max_retries=2,
            base_delay_seconds=0,
        )

        outcome = await coord.request_and_wait(_request(0, 60_000))

        assert engine.calls == 2
        assert outcome.status == "completed"
        assert outcome.attempts == 2
        assert outcome.error is None
        assert [event.event_type.value for event in dm.event_bus.events] == ["backfill.completed"]

    asyncio.run(_run())


def test_backfill_coordinator_loads_cache_from_written_ranges() -> None:
    async def _run() -> None:
        class _ReconcileResult:
            bars_written = 1
            written_ranges = [{
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "start_ms": 60_000,
                "end_ms": 60_000,
                "bars_written": 1,
            }]

        class _Report:
            status = "completed"
            errors: list[str] = []
            reconcile_result = _ReconcileResult()

        class _Engine:
            async def run(self, **kwargs):
                return _Report()

        class _Storage:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            def query_bars(self, **kwargs):
                self.calls.append(kwargs)
                if kwargs["start_ms"] == 0:
                    return [
                        {
                            "open_time": open_time,
                            "open": 1,
                            "high": 2,
                            "low": 1,
                            "close": 2,
                            "volume": 3,
                        }
                        for open_time in (0, 60_000, 120_000, 180_000)
                    ]
                return [{
                    "open_time": kwargs["start_ms"],
                    "open": 1,
                    "high": 2,
                    "low": 1,
                    "close": 2,
                    "volume": 3,
                }]

        storage = _Storage()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        request = _request(0, 180_000)
        request.metadata["derived_repair_targets"] = [{
            "interval": "45m",
            "start_ms": 0,
            "end_ms": 0,
        }]
        outcome = await coord.request_and_wait(request)

        assert outcome.bars_loaded == 1
        assert outcome.verified_contiguous is True
        assert storage.calls == [
            {
                "symbol": "BTCUSDT",
                "interval": "1m",
                "start_ms": 0,
                "end_ms": 180_000,
                "order": "ASC",
                "exchange": "binance",
                "market_type": "spot",
            },
        ]
        assert dm.loaded[0][3]["event_detail"]["status"] == "completed"
        assert dm.loaded[0][3]["event_detail"]["range_start_ms"] == 60_000
        assert dm.loaded[0][3]["event_detail"]["verified_contiguous"] is True
        assert dm.loaded[0][3]["event_detail"]["derived_repair_targets"] == [{
            "interval": "45m",
            "start_ms": 0,
            "end_ms": 0,
        }]

    asyncio.run(_run())


def test_backfill_coordinator_updates_gap_ledger_lifecycle() -> None:
    async def _run() -> None:
        class _Report:
            status = "completed"
            errors: list[str] = []
            reconcile_result = _ReconcileResult(bars_written=0)

        class _Engine:
            async def run(self, **kwargs):
                return _Report()

        ledger = _Ledger()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            gap_ledger=ledger,
        )

        outcome = await coord.request_and_wait(_request(0, 60_000, request_id="gap"))

        assert outcome.status == "completed"
        assert [name for name, _ in ledger.events] == [
            "detected",
            "started",
            "verifying",
            "resolved",
        ]
        # Without an exact storage verifier, an empty-looking provider result
        # is not authoritative enough to persist as source_empty.
        assert ledger.events[-1][1]["status"] == "partial"

    asyncio.run(_run())


def test_repair_request_merge_metadata_and_reason_remain_bounded() -> None:
    merged = _request(0, 60_000, request_id="root")
    for index in range(100):
        other = _request(
            index * 60_000,
            (index + 2) * 60_000,
            request_id=f"child-{index}",
        )
        other.reason = f"reason_{index}"
        merged = merged.merged_with(other)

    assert len(merged.metadata["merged_request_ids"]) <= 32
    assert len(merged.reason.split("+")) <= 8


def test_repair_request_merge_stably_dedupes_derived_targets() -> None:
    first = _request(0, 60_000, request_id="first")
    first.metadata["derived_repair_targets"] = [{
        "interval": "45m",
        "start_ms": 0,
        "end_ms": 0,
    }]
    second = _request(30_000, 120_000, request_id="second")
    second.metadata["derived_repair_targets"] = [
        {"interval": "45m", "start_ms": 0, "end_ms": 0},
        {"interval": "90m", "start_ms": 0, "end_ms": 0},
    ]

    merged = first.merged_with(second)

    assert merged.metadata["derived_repair_targets"] == [
        {"interval": "45m", "start_ms": 0, "end_ms": 0},
        {"interval": "90m", "start_ms": 0, "end_ms": 0},
    ]


def test_active_deduped_repair_merges_derived_targets_into_completion() -> None:
    async def _run() -> None:
        class _Written:
            bars_written = 1
            written_ranges = [{
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "interval": "15m",
                "start_ms": 900_000,
                "end_ms": 900_000,
                "bars_written": 1,
            }]

        class _Report:
            status = "completed"
            errors: list[str] = []
            reconcile_result = _Written()

        class _Engine:
            def __init__(self) -> None:
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def run(self, **kwargs):
                self.started.set()
                await self.release.wait()
                return _Report()

        class _CompleteStorage:
            def query_bars(self, **kwargs):
                return [{
                    "open_time": 900_000,
                    "open": 1,
                    "high": 2,
                    "low": 1,
                    "close": 2,
                    "volume": 1,
                }]

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_CompleteStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )
        first = RepairRequest(
            symbol="BTCUSDT",
            interval="15m",
            start_ms=900_000,
            end_ms=900_000,
            request_id="base-active",
            metadata={"derived_repair_targets": [{
                "interval": "45m",
                "start_ms": 0,
                "end_ms": 0,
            }]},
        )
        second = RepairRequest(
            symbol="BTCUSDT",
            interval="15m",
            start_ms=900_000,
            end_ms=900_000,
            request_id="base-deduped",
            metadata={"derived_repair_targets": [{
                "interval": "90m",
                "start_ms": 0,
                "end_ms": 0,
            }]},
        )

        canonical = coord.request(first)
        await engine.started.wait()
        assert coord.request(second) == canonical
        engine.release.set()
        outcome = await coord.wait_for_request(canonical)

        assert outcome is not None
        assert coord.snapshot()["deduped"] == 1
        assert dm.loaded[0][3]["event_detail"]["derived_repair_targets"] == [
            {"interval": "45m", "start_ms": 0, "end_ms": 0},
            {"interval": "90m", "start_ms": 0, "end_ms": 0},
        ]

    asyncio.run(_run())


def test_chunked_gap_ledger_only_resolves_after_parent_aggregate(tmp_path) -> None:
    async def _run() -> None:
        class _ChunkStorage:
            def query_bars(self, **kwargs):
                return [{"open_time": kwargs["start_ms"]}]

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []
                self.second_started = asyncio.Event()
                self.release_second = asyncio.Event()

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 2:
                    self.second_started.set()
                    await self.release_second.wait()
                return _RepairReport(status="completed")

        parent = _request(0, 60_000, request_id="chunked-parent")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        engine = _Engine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_ChunkStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            gap_ledger=ledger,
            chunk_bars=1,
        )

        outcome_task = asyncio.create_task(coordinator.request_and_wait(parent))
        await asyncio.wait_for(engine.second_started.wait(), timeout=1)

        middle = ledger.get_status(parent)
        assert middle is not None
        assert middle["status"] in {"repairing", "verifying"}
        assert middle["resolved_at"] is None
        assert ledger.get_status(_request(0, 0, request_id="child")) is None

        engine.release_second.set()
        outcome = await asyncio.wait_for(outcome_task, timeout=1)
        assert outcome.verified_contiguous is True
        final = ledger.get_status(parent)
        assert final is not None
        assert final["status"] == "filled"
        assert final["missing_count"] == 0

    asyncio.run(_run())


def test_chunked_parent_is_not_filled_when_any_chunk_verification_is_unknown(
    tmp_path,
) -> None:
    async def _run() -> None:
        class _PartlyVerifiableStorage:
            def query_bars(self, **kwargs):
                if kwargs["start_ms"] == 0:
                    return [{"open_time": 0}]
                raise RuntimeError("verification unavailable")

        class _Engine:
            async def run(self, **kwargs):
                return _RepairReport(status="completed")

        parent = _request(0, 60_000, request_id="unknown-chunk-parent")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_PartlyVerifiableStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            gap_ledger=ledger,
            chunk_bars=1,
        )

        outcome = await coordinator.request_and_wait(parent)

        assert outcome.verified_contiguous is None
        assert ledger.get_status(parent)["status"] == "partial"
        assert ledger.get_status(parent)["resolved_at"] is None

    asyncio.run(_run())


def test_partial_early_terminal_parent_is_inactive_until_long_retry(tmp_path) -> None:
    async def _run() -> None:
        request = _request(0, 180_000, request_id="early-terminal-parent")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )
        outcome = RepairOutcome(
            request=request,
            status="completed",
            attempts=1,
            bars_loaded=10,
            verified_contiguous=None,
            remaining_missing_bars=2,
            terminal_reason="provider_exhausted",
            retryable=False,
        )

        await coordinator._ledger_finalize_parent(request, outcome)

        status = ledger.get_status(request)
        assert status is not None
        assert status["status"] == "unavailable"
        assert status["last_error"] == "provider_exhausted"
        assert status["next_retry_at"] is not None
        assert ledger.list_reconcilable(
            due_before_ms=status["next_retry_at"] - 1,
            stale_before_ms=status["next_retry_at"],
        ) == []

    asyncio.run(_run())


def test_stale_queued_ledger_row_closes_only_after_exact_storage_verification(tmp_path) -> None:
    async def _run() -> None:
        class _ContiguousStorage:
            def scan_gaps(self, **kwargs):
                return {
                    "gap_count": 0,
                    "scanned_bars": 2,
                    "truncated": False,
                }

        request = _request(0, 60_000, request_id="stale-contiguous")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_ContiguousStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )

        report = await coordinator.reconcile_gap_ledger(stale_after_ms=0)

        assert report.scanned == 1
        assert report.resolved == 1
        assert report.requeued == 0
        assert ledger.get_status(request)["status"] == "filled"

    asyncio.run(_run())


def test_stale_queued_ledger_row_requeues_only_after_storage_confirms_gap(tmp_path) -> None:
    async def _run() -> None:
        class _GappedStorage:
            def scan_gaps(self, **kwargs):
                return {
                    "gap_count": 1,
                    "scanned_bars": 1,
                    "truncated": False,
                    "gaps": [{"start_ms": 60_000, "end_ms": 60_000}],
                }

            def query_bars(self, **kwargs):
                return []

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        request = _request(0, 60_000, request_id="stale-gapped")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        storage = _GappedStorage()
        engine = _Engine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        report = await coordinator.reconcile_gap_ledger(stale_after_ms=0)

        assert report.scanned == 1
        assert report.resolved == 0
        assert report.requeued == 1
        await _wait_until(lambda: len(engine.calls) == 1)
        await _wait_until(
            lambda: ledger.get_status(request)["status"] == "source_empty"
        )
        assert engine.calls[0]["metadata"]["origin"] == "stale_ledger_recovery"

    asyncio.run(_run())


def test_stale_ledger_exact_verification_pages_beyond_scan_limit(tmp_path) -> None:
    async def _run() -> None:
        class _PagedStorage:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            def scan_gaps(self, **kwargs):
                self.calls.append(dict(kwargs))
                if len(self.calls) == 1:
                    return {
                        "gap_count": 0,
                        "scanned_bars": 2,
                        "truncated": True,
                        "resume_from_ms": 60_000,
                    }
                return {
                    "gap_count": 0,
                    "scanned_bars": 2,
                    "truncated": False,
                }

            def verify_contiguous_range(self, **kwargs):
                return {"verified_contiguous": True}

        request = _request(0, 180_000, request_id="paged-stale")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        storage = _PagedStorage()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )

        report = await coordinator.reconcile_gap_ledger(
            stale_after_ms=0,
            scan_limit=2,
        )

        assert report.scanned == 2
        assert report.resolved == 1
        assert storage.calls[0]["start_ms"] == 0
        assert storage.calls[1]["start_ms"] == 120_000
        assert ledger.get_status(request)["status"] == "filled"

    asyncio.run(_run())


def test_monthly_ledger_reconciliation_resumes_across_three_bounded_passes(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator."
        "_LEDGER_RECONCILE_MAX_PAGES_PER_RANGE",
        1,
    )
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator."
        "_LEDGER_RECONCILE_MAX_TOTAL_PAGES",
        1,
    )

    async def _run() -> None:
        january = int(
            datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
        )
        february = int(
            datetime(2024, 2, 1, tzinfo=timezone.utc).timestamp() * 1000
        )
        march = int(
            datetime(2024, 3, 1, tzinfo=timezone.utc).timestamp() * 1000
        )

        class _MonthlyPagedStorage:
            def __init__(self) -> None:
                self.starts: list[int] = []

            def scan_gaps(self, **kwargs):
                start_ms = int(kwargs["start_ms"])
                self.starts.append(start_ms)
                if start_ms < march:
                    return {
                        "gap_count": 0,
                        "scanned_bars": 1,
                        "truncated": True,
                        # A one-row page resumes at the same row.  The
                        # coordinator must advance with calendar bucket math,
                        # not a fixed 30-day millisecond approximation.
                        "resume_from_ms": start_ms,
                    }
                return {
                    "gap_count": 0,
                    "scanned_bars": 1,
                    "truncated": False,
                }

            def verify_contiguous_range(self, **kwargs):
                return {"verified_contiguous": True}

        request = RepairRequest(
            symbol="BTCUSDT",
            interval="1M",
            start_ms=january,
            end_ms=march,
            exchange="binance",
            market_type="spot",
            request_id="monthly-paged-stale",
        )
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        storage = _MonthlyPagedStorage()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )

        first = await coordinator.reconcile_gap_ledger(
            stale_after_ms=0,
            scan_limit=1,
        )
        checkpoint = json.loads(
            ledger.get_status(request)["metadata_json"]
        )["reconciliation_checkpoint"]

        assert first.scanned == 1
        assert first.skipped == 1
        assert checkpoint["cursor_ms"] == february
        assert checkpoint["scanned_bars"] == 1
        assert storage.starts == [january]

        # Make the leased row due without disturbing its persisted cursor.
        ledger.mark_reconciled_checked(request, next_retry_at=0)
        second = await coordinator.reconcile_gap_ledger(
            stale_after_ms=0,
            scan_limit=1,
        )

        second_checkpoint = json.loads(
            ledger.get_status(request)["metadata_json"]
        )["reconciliation_checkpoint"]
        assert second.scanned == 1
        assert second.skipped == 1
        assert second.resolved == 0
        assert second_checkpoint["cursor_ms"] == march
        assert second_checkpoint["scanned_bars"] == 2

        ledger.mark_reconciled_checked(request, next_retry_at=0)
        third = await coordinator.reconcile_gap_ledger(
            stale_after_ms=0,
            scan_limit=1,
        )

        assert third.scanned == 1
        assert third.resolved == 1
        assert storage.starts == [january, february, march]
        assert ledger.get_status(request)["status"] == "filled"
        assert "reconciliation_checkpoint" not in json.loads(
            ledger.get_status(request)["metadata_json"]
        )

    asyncio.run(_run())


def test_checkpointed_reconciliation_restarts_if_scanned_prefix_changes(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator."
        "_LEDGER_RECONCILE_MAX_PAGES_PER_RANGE",
        1,
    )
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator."
        "_LEDGER_RECONCILE_MAX_TOTAL_PAGES",
        1,
    )

    async def _run() -> None:
        class _MutablePagedStorage:
            def __init__(self) -> None:
                self.starts: list[int] = []
                self.live_count = 5

            def scan_gaps(self, **kwargs):
                start_ms = int(kwargs["start_ms"])
                self.starts.append(start_ms)
                if start_ms < 120_000:
                    return {
                        "gap_count": 0,
                        "scanned_bars": 2,
                        "truncated": True,
                        "resume_from_ms": start_ms + 60_000,
                    }
                return {
                    "gap_count": 0,
                    "scanned_bars": 3,
                    "truncated": False,
                }

            def verify_contiguous_range(self, **kwargs):
                return {"verified_contiguous": self.live_count == 5}

        request = _request(0, 240_000, request_id="mutated-paged-stale")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        storage = _MutablePagedStorage()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )

        first = await coordinator.reconcile_gap_ledger(
            stale_after_ms=0,
            scan_limit=2,
        )
        assert first.skipped == 1
        assert storage.starts == [0]

        # A GC/delete operation punches the already-scanned prefix before the
        # continuation runs.  The clean suffix must not make the parent filled.
        storage.live_count = 4
        ledger.mark_reconciled_checked(request, next_retry_at=0)
        second = await coordinator.reconcile_gap_ledger(
            stale_after_ms=0,
            scan_limit=2,
        )

        assert second.resolved == 0
        assert second.skipped == 1
        assert ledger.get_status(request)["status"] == "queued"
        assert "reconciliation_checkpoint" not in json.loads(
            ledger.get_status(request)["metadata_json"]
        )

        # Once due again, the invalidated proof restarts at the original head.
        ledger.mark_reconciled_checked(request, next_retry_at=0)
        await coordinator.reconcile_gap_ledger(
            stale_after_ms=0,
            scan_limit=2,
        )
        assert storage.starts == [0, 120_000, 0]

    asyncio.run(_run())


@pytest.mark.parametrize(
    "terminal_status",
    ["failed", "unavailable", "not_expected"],
)
def test_due_inactive_ledger_outcome_requeues_when_closed_storage_still_has_gap(
    tmp_path,
    terminal_status,
) -> None:
    async def _run() -> None:
        class _GappedStorage:
            def scan_gaps(self, **kwargs):
                return {
                    "gap_count": 1,
                    "scanned_bars": 1,
                    "truncated": False,
                    "gaps": [{"start_ms": 60_000, "end_ms": 60_000}],
                }

            def query_bars(self, **kwargs):
                return []

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        request = _request(
            0,
            60_000,
            request_id=f"due-{terminal_status}",
        )
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        if terminal_status == "failed":
            ledger.mark_resolved(request, status="failed", error="failed")
            ledger.mark_reconciled_checked(request, next_retry_at=0)
        else:
            ledger.mark_deferred(
                request,
                status=terminal_status,
                reason=terminal_status,
                next_retry_at=0,
            )
        engine = _Engine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_GappedStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        report = await coordinator.reconcile_gap_ledger(stale_after_ms=0)

        assert report.scanned == 1
        assert report.requeued == 1
        await _wait_until(
            lambda: len(engine.calls) == 1
            and not coordinator.snapshot()["active"]
        )
        assert engine.calls[0]["metadata"]["origin"] == "stale_ledger_recovery"
        assert engine.calls[0]["metadata"]["ledger_recovery_count"] == 1

    asyncio.run(_run())


def test_forming_not_expected_ledger_row_is_not_requeued(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: 120.0,
    )

    async def _run() -> None:
        class _StorageWithSpy:
            def __init__(self) -> None:
                self.scan_calls = 0

            def scan_gaps(self, **kwargs):
                self.scan_calls += 1
                return {"gap_count": 1, "scanned_bars": 0, "truncated": False}

        request = _request(120_000, 120_000, request_id="forming-not-expected")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        ledger.mark_deferred(
            request,
            status="not_expected",
            reason="forming_bar",
            next_retry_at=0,
        )
        storage = _StorageWithSpy()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )

        report = await coordinator.reconcile_gap_ledger(stale_after_ms=0)

        assert report.requeued == 0
        assert report.skipped == 1
        assert storage.scan_calls == 0
        assert ledger.get_status(request)["status"] == "not_expected"

    asyncio.run(_run())


def test_due_source_empty_gap_stays_cold_instead_of_requeueing(tmp_path) -> None:
    async def _run() -> None:
        class _GappedStorage:
            def scan_gaps(self, **kwargs):
                return {
                    "gap_count": 1,
                    "scanned_bars": 1,
                    "truncated": False,
                    "gaps": [{"start_ms": 60_000, "end_ms": 60_000}],
                }

        request = _request(0, 60_000, request_id="cold-source-empty")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        ledger.mark_resolved(request, status="source_empty")
        ledger.mark_reconciled_checked(request, next_retry_at=0)
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_GappedStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )

        report = await coordinator.reconcile_gap_ledger(stale_after_ms=0)
        status = ledger.get_status(request)

        assert report.requeued == 0
        assert report.skipped == 1
        assert status["status"] == "source_empty"
        assert status["next_retry_at"] is not None

    asyncio.run(_run())


def test_source_empty_parent_suppresses_repeated_exact_and_child_requests_until_due(
    tmp_path,
) -> None:
    async def _run() -> None:
        class _EmptyStorage:
            def query_bars(self, **kwargs):
                return []

        class _EmptyEngine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        parent = _request(0, 180_000, request_id="empty-parent")
        child = _request(60_000, 60_000, request_id="empty-child-repeat")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        engine = _EmptyEngine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_EmptyStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        await coordinator.request_and_wait(parent)
        parent_status = ledger.get_status(parent)
        assert parent_status["status"] == "source_empty"
        assert parent_status["next_retry_at"] is not None
        assert len(engine.calls) == 1

        suppressed = await coordinator.request_and_wait(child)
        assert suppressed.status == "suppressed"
        assert suppressed.suppressed is True
        assert suppressed.ledger_status == "source_empty"
        assert suppressed.retryable is False
        assert suppressed.retry_at_ms == parent_status["next_retry_at"]
        assert suppressed.suppression["start_ms"] == parent.start_ms
        assert suppressed.suppression["end_ms"] == parent.end_ms
        assert len(engine.calls) == 1
        assert ledger.get_status(parent)["status"] == "source_empty"
        assert ledger.get_status(child) is None

        ledger.mark_reconciled_checked(parent, next_retry_at=0)
        await coordinator.refresh_suppressions()
        due_child = _request(60_000, 60_000, request_id="empty-child-due")
        await coordinator.request_and_wait(due_child)
        assert len(engine.calls) == 2

    asyncio.run(_run())


def test_failed_ledger_recovery_failure_moves_deadline_and_does_not_hot_loop(
    tmp_path,
) -> None:
    async def _run() -> None:
        class _GappedStorage:
            def __init__(self) -> None:
                self.scan_calls = 0

            def scan_gaps(self, **kwargs):
                self.scan_calls += 1
                return {
                    "gap_count": 1,
                    "scanned_bars": 1,
                    "truncated": False,
                    "gaps": [{"start_ms": 60_000, "end_ms": 60_000}],
                }

        class _FailingEngine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="failed", errors=["still failed"])

        request = _request(0, 60_000, request_id="backed-off-failure")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        ledger.mark_resolved(request, status="failed", error="failed")
        ledger.mark_reconciled_checked(request, next_retry_at=0)
        storage = _GappedStorage()
        engine = _FailingEngine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
            max_retries=1,
            base_delay_seconds=0,
        )

        first = await coordinator.reconcile_gap_ledger(stale_after_ms=0)
        assert first.requeued == 1
        await _wait_until(
            lambda: len(engine.calls) == 1
            and ledger.get_status(request)["status"] == "failed"
        )
        failed = ledger.get_status(request)
        assert failed["status"] == "failed"
        assert failed["next_retry_at"] > (
            int(time.time() * 1000) + 25 * 60 * 1_000
        )
        assert engine.calls[0]["metadata"]["ledger_recovery_count"] == 1

        second = await coordinator.reconcile_gap_ledger(stale_after_ms=0)
        assert second.scanned == 0
        assert second.requeued == 0
        assert storage.scan_calls == 1
        assert len(engine.calls) == 1

    asyncio.run(_run())


def test_unknown_history_deferral_without_retry_hint_gets_default_lease(
    tmp_path,
) -> None:
    async def _run() -> None:
        request = _request(0, 60_000, request_id="unknown-history")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )
        plan = SimpleNamespace(
            disposition=HistoryDisposition.UNKNOWN,
            unknown=True,
            retry_at_ms=None,
        )

        coordinator._ledger_mark_history_deferred(request, plan)
        await _wait_until(lambda: (
            (ledger.get_status(request) or {}).get("status") == "unavailable"
        ))
        status = ledger.get_status(request)

        assert status["status"] == "unavailable"
        assert status["next_retry_at"] is not None
        assert ledger.list_reconcilable(
            due_before_ms=status["next_retry_at"] - 1,
        ) == []

    asyncio.run(_run())


def test_truncated_stale_ledger_scan_is_deferred_and_does_not_starve(tmp_path) -> None:
    async def _run() -> None:
        class _UnpageableStorage:
            def scan_gaps(self, **kwargs):
                return {
                    "gap_count": 0,
                    "scanned_bars": 2,
                    "truncated": True,
                    "resume_from_ms": None,
                }

        request = _request(0, 180_000, request_id="unpageable-stale")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(request)
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_UnpageableStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )

        first = await coordinator.reconcile_gap_ledger(stale_after_ms=0)
        second = await coordinator.reconcile_gap_ledger(stale_after_ms=0)

        assert first.scanned == 1
        assert first.skipped == 1
        assert ledger.get_status(request)["next_retry_at"] is not None
        assert second.scanned == 0

    asyncio.run(_run())


def test_gap_ledger_lifecycle_never_runs_sqlite_callbacks_on_event_loop() -> None:
    async def _run() -> None:
        loop_thread = threading.get_ident()
        callback_threads: list[int] = []

        class _ThreadLedger(_Ledger):
            def _mark_thread(self) -> None:
                callback_threads.append(threading.get_ident())

            def upsert_detected(self, request, *, status="queued") -> None:
                self._mark_thread()
                super().upsert_detected(request, status=status)

            def mark_started(self, request, *, attempt) -> None:
                self._mark_thread()
                super().mark_started(request, attempt=attempt)

            def mark_verifying(self, request) -> None:
                self._mark_thread()
                super().mark_verifying(request)

            def mark_resolved(self, request, **kwargs) -> None:
                self._mark_thread()
                super().mark_resolved(request, **kwargs)

        class _Engine:
            async def run(self, **kwargs):
                return _RepairReport(status="completed")

        ledger = _ThreadLedger()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
            gap_ledger=ledger,
        )

        await coordinator.request_and_wait(_request(0, 60_000, request_id="threaded-ledger"))

        assert callback_threads
        assert all(thread_id != loop_thread for thread_id in callback_threads)

    asyncio.run(_run())


def test_completed_outcome_retains_summary_without_fetched_bars() -> None:
    async def _run() -> None:
        class _Engine:
            async def run(self, **kwargs):
                return SimpleNamespace(
                    status="completed",
                    errors=[],
                    elapsed_ms=12,
                    written_ranges=[],
                    fetch_results=[SimpleNamespace(bars=[object() for _ in range(10_000)])],
                    reconcile_result=SimpleNamespace(
                        bars_received=10_000,
                        bars_written=0,
                        bars_skipped=10_000,
                        bars_deduplicated=10_000,
                        custom_bars_generated=0,
                        custom_bars_written=0,
                        bars_cached=0,
                        write_errors=0,
                        failed_batches=[],
                        written_ranges=[],
                        elapsed_ms=8,
                    ),
                )

        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )
        request = _request(0, 60_000, request_id="compact-outcome")

        outcome = await coordinator.request_and_wait(request)

        assert outcome.report.fetch_result_count == 1
        assert outcome.report.fetched_bar_count == 10_000
        assert outcome.report.reconcile_result.bars_received == 10_000
        assert not hasattr(outcome.report, "fetch_results")
        assert coordinator._outcomes[request.request_id].report is outcome.report
        assert coordinator._scheduler._outcomes[request.request_id].report is outcome.report

    asyncio.run(_run())


def test_backfill_coordinator_audits_storage_gaps_and_queues_repairs() -> None:
    async def _run() -> None:
        class _AuditStorage:
            def __init__(self) -> None:
                self.scan_calls: list[dict] = []

            def get_bounds(self, *args, **kwargs):
                return {"earliest_open_time": 0, "latest_open_time": 0}

            def scan_gaps(self, **kwargs):
                self.scan_calls.append(kwargs)
                if "end_ms" in kwargs:
                    return {"gaps": [], "truncated": False}
                return {
                    "gaps": [{
                        "start_ms": 120_000,
                        "end_ms": 120_000,
                        "reason": "interior_gap",
                    }]
                }

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        storage = _AuditStorage()
        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        report = await coord.audit_storage_gaps(
            [("binance", "spot", "BTCUSDT")],
            ("1m",),
            repair=True,
        )

        assert report.scanned == 2
        assert report.queued == 1
        await _wait_until(lambda: len(engine.calls) == 1)
        assert len(storage.scan_calls) == 2
        tail_call = dict(storage.scan_calls[0])
        tail_end_ms = tail_call.pop("end_ms")
        assert tail_end_ms % 60_000 == 0
        assert tail_call["start_ms"] <= tail_end_ms
        assert tail_call["limit"] == 1_000
        scan_call = dict(storage.scan_calls[1])
        assert scan_call == {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
            "limit": 50_000,
        }
        assert engine.calls[0]["range_start_ms"] == 120_000
        assert engine.calls[0]["range_end_ms"] == 120_000
        assert engine.calls[0]["metadata"]["origin"] == "background_gap_audit"
        assert engine.calls[0]["metadata"]["gap_type"] == "interior_gap"

    asyncio.run(_run())


def test_backfill_coordinator_audits_exact_okx_series() -> None:
    async def _run() -> None:
        class _AuditStorage:
            def __init__(self) -> None:
                self.scan_calls: list[dict] = []

            def scan_gaps(self, **kwargs):
                self.scan_calls.append(kwargs)
                return {
                    "gaps": [{
                        "start_ms": 60_000,
                        "end_ms": 60_000,
                        "reason": "interior_gap",
                    }]
                }

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        storage = _AuditStorage()
        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        report = await coord.audit_storage_series([
            ("okx", "spot", "BTC-USDT", "1m"),
            ("okx", "spot", "BTC-USDT", "1m"),
        ])

        assert report.scanned == 1
        assert report.queued == 1
        await _wait_until(lambda: len(engine.calls) == 1)
        assert len(storage.scan_calls) == 1
        scan_call = dict(storage.scan_calls[0])
        assert scan_call == {
            "symbol": "BTC-USDT",
            "interval": "1m",
            "exchange": "okx",
            "market_type": "spot",
            "limit": 50_000,
        }
        assert engine.calls[0]["symbol"] == "BTC-USDT"
        assert engine.calls[0]["exchange"] == "okx"
        assert engine.calls[0]["market_type"] == "spot"

    asyncio.run(_run())


def test_gap_audit_budget_cursor_stays_on_first_unprocessed_gap() -> None:
    async def _run() -> None:
        class _AuditStorage:
            def __init__(self) -> None:
                self.scan_calls: list[dict] = []

            def scan_gaps(self, **kwargs):
                self.scan_calls.append(dict(kwargs))
                starts = [60_000, 120_000, 180_000]
                if kwargs.get("start_ms") is not None:
                    starts = [value for value in starts if value >= kwargs["start_ms"]]
                return {
                    "gaps": [
                        {
                            "start_ms": value,
                            "end_ms": value,
                            "reason": "interior_gap",
                        }
                        for value in starts
                    ],
                    "truncated": len(self.scan_calls) == 1,
                    "resume_from_ms": 999_000 if len(self.scan_calls) == 1 else None,
                }

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        series = [("binance", "spot", "BTCUSDT", "1m")]
        storage = _AuditStorage()
        engine = _Engine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        first = await coordinator.audit_storage_series(
            series,
            max_gaps=1,
        )
        assert first.queued == 1
        assert coordinator._gap_audit_cursors[series[0]] == 120_000
        await _wait_until(lambda: len(engine.calls) >= 1)

        second = await coordinator.audit_storage_series(
            series,
            max_gaps=1,
        )
        assert second.queued == 1
        assert storage.scan_calls[1]["start_ms"] == 120_000
        assert coordinator._gap_audit_cursors[series[0]] == 180_000
        await _wait_until(lambda: len(engine.calls) >= 2)

    asyncio.run(_run())


def test_backfill_coordinator_resumes_at_first_gap_left_by_quota() -> None:
    async def _run() -> None:
        class _PagedAuditStorage:
            def __init__(self) -> None:
                self.scan_calls: list[dict] = []

            def scan_gaps(self, **kwargs):
                self.scan_calls.append(kwargs)
                if kwargs.get("start_ms") == 180_000:
                    return {
                        "gaps": [{
                            "start_ms": 180_000,
                            "end_ms": 180_000,
                            "reason": "interior_gap",
                        }],
                        "truncated": False,
                        "resume_from_ms": None,
                    }
                return {
                    "gaps": [
                        {
                            "start_ms": 60_000,
                            "end_ms": 60_000,
                            "reason": "interior_gap",
                        },
                        {
                            "start_ms": 180_000,
                            "end_ms": 180_000,
                            "reason": "interior_gap",
                        },
                    ],
                    "truncated": True,
                    "resume_from_ms": 240_000,
                }

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        storage = _PagedAuditStorage()
        engine = _Engine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        first = await coordinator.audit_storage_series([
            ("binance", "spot", "BTCUSDT", "1m"),
        ], max_gaps=1)
        second = await coordinator.audit_storage_series([
            ("binance", "spot", "BTCUSDT", "1m"),
        ], max_gaps=1)

        assert first.queued == 1
        assert second.queued == 1
        await _wait_until(lambda: len(engine.calls) == 2)
        assert [call.get("start_ms") for call in storage.scan_calls] == [
            None,
            180_000,
        ]
        assert [call["range_start_ms"] for call in engine.calls] == [
            60_000,
            180_000,
        ]

    asyncio.run(_run())


@pytest.mark.parametrize("existing_status", ["queued", "failed", "retry_wait"])
def test_gap_audit_skips_fresh_or_backed_off_gap_and_reaches_new_work(
    tmp_path,
    existing_status,
) -> None:
    async def _run() -> None:
        class _TwoGapStorage:
            def scan_gaps(self, **kwargs):
                return {
                    "gaps": [
                        {
                            "start_ms": 60_000,
                            "end_ms": 60_000,
                            "reason": "interior_gap",
                        },
                        {
                            "start_ms": 120_000,
                            "end_ms": 120_000,
                            "reason": "interior_gap",
                        },
                    ],
                    "truncated": False,
                }

        existing = _request(60_000, 60_000, request_id="existing-audit-gap")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(existing)
        if existing_status == "failed":
            ledger.mark_resolved(existing, status="failed", error="failed")
        elif existing_status == "retry_wait":
            ledger.mark_retry_wait(
                existing,
                attempt=1,
                error="retry",
                next_retry_at=9_999_999_999_999,
            )
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_TwoGapStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )
        submitted: list[RepairRequest] = []
        coordinator.request = lambda request: (
            submitted.append(request) or request.request_id
        )

        report = await coordinator.audit_storage_series(
            [("binance", "spot", "BTCUSDT", "1m")],
            max_gaps=1,
        )

        assert report.queued == 1
        assert [request.start_ms for request in submitted] == [120_000]

    asyncio.run(_run())


def test_narrow_audit_gap_respects_covering_parent_failure_deadline(tmp_path) -> None:
    async def _run() -> None:
        parent = _request(0, 180_000, request_id="wide-failed-parent")
        child = _request(60_000, 60_000, request_id="narrow-audit-child")
        ledger = GapLedger(tmp_path / "klines.sqlite")
        ledger.upsert_detected(parent)
        ledger.mark_resolved(parent, status="failed", error="failed")
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            gap_ledger=ledger,
            loop=asyncio.get_running_loop(),
        )

        assert await coordinator._should_skip_audited_gap(child) is True

        ledger.mark_reconciled_checked(parent, next_retry_at=0)
        assert await coordinator._should_skip_audited_gap(child) is False

    asyncio.run(_run())


def test_gap_audit_scheduler_dedupe_does_not_consume_queue_budget() -> None:
    async def _run() -> None:
        class _TwoGapStorage:
            def scan_gaps(self, **kwargs):
                return {
                    "gaps": [
                        {
                            "start_ms": 60_000,
                            "end_ms": 60_000,
                            "reason": "interior_gap",
                        },
                        {
                            "start_ms": 120_000,
                            "end_ms": 120_000,
                            "reason": "interior_gap",
                        },
                    ],
                    "truncated": False,
                }

        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=_TwoGapStorage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            loop=asyncio.get_running_loop(),
        )
        submitted: list[int] = []

        def _submit(request: RepairRequest) -> str:
            submitted.append(request.start_ms)
            if request.start_ms == 60_000:
                return "existing-parent"
            return request.request_id

        coordinator.request = _submit

        report = await coordinator.audit_storage_series(
            [("binance", "spot", "BTCUSDT", "1m")],
            max_gaps=1,
        )

        assert report.queued == 1
        assert submitted == [60_000, 120_000]

    asyncio.run(_run())


def test_gap_audit_only_extends_explicit_live_series_to_closed_tail() -> None:
    async def _run() -> None:
        class _AuditStorage:
            def __init__(self) -> None:
                self.scan_calls: list[dict] = []

            def scan_gaps(self, **kwargs):
                self.scan_calls.append(dict(kwargs))
                if "end_ms" in kwargs:
                    return {
                        "gaps": [{
                            "start_ms": kwargs["start_ms"] + 60_000,
                            "end_ms": kwargs["start_ms"] + 60_000,
                            "reason": "tail_gap",
                        }],
                        "truncated": False,
                    }
                return {"gaps": [], "truncated": False}

            def get_bounds(self, symbol, interval, **kwargs):
                assert symbol == "BTCUSDT"
                return {"earliest_open_time": 0, "latest_open_time": 60_000}

        live = ("binance", "futures", "BTCUSDT", "1m")
        inactive = ("okx", "spot", "OLD-USDT", "1m")
        storage = _AuditStorage()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            loop=asyncio.get_running_loop(),
        )

        report = await coordinator.audit_storage_series(
            [inactive, live],
            repair=False,
            tail_series=[live],
        )

        assert report.scanned == 3
        inactive_calls = [
            call for call in storage.scan_calls if call["symbol"] == "OLD-USDT"
        ]
        live_calls = [
            call for call in storage.scan_calls if call["symbol"] == "BTCUSDT"
        ]
        assert len(inactive_calls) == 1
        assert "end_ms" not in inactive_calls[0]
        assert len(live_calls) == 2
        assert "end_ms" in live_calls[0]
        assert live_calls[0]["start_ms"] <= live_calls[0]["end_ms"]
        assert live_calls[0]["limit"] == 1_000
        assert "end_ms" not in live_calls[1]

    asyncio.run(_run())


def test_live_tail_lane_runs_before_truncated_interior_cursor_page() -> None:
    async def _run() -> None:
        class _LargeStorage:
            def __init__(self) -> None:
                self.scan_calls: list[dict] = []

            def get_bounds(self, *args, **kwargs):
                return {
                    "earliest_open_time": 0,
                    "latest_open_time": 9_000_000,
                }

            def scan_gaps(self, **kwargs):
                self.scan_calls.append(dict(kwargs))
                if "end_ms" in kwargs:
                    return {
                        "gaps": [{
                            "start_ms": 9_060_000,
                            "end_ms": 9_060_000,
                            "reason": "tail_gap",
                        }],
                        "truncated": False,
                    }
                return {
                    "gaps": [],
                    "truncated": True,
                    "resume_from_ms": 3_000_000,
                }

        series = ("binance", "spot", "BTCUSDT", "1m")
        storage = _LargeStorage()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            loop=asyncio.get_running_loop(),
        )

        report = await coordinator.audit_storage_series(
            [series],
            repair=False,
            tail_series=[series],
        )

        assert report.scanned == 2
        assert report.repaired == 1
        assert "end_ms" in storage.scan_calls[0]
        assert storage.scan_calls[0]["start_ms"] <= storage.scan_calls[0]["end_ms"]
        assert storage.scan_calls[0]["limit"] == 1_000
        assert "end_ms" not in storage.scan_calls[1]
        assert coordinator._gap_audit_cursors[series] == 3_060_000

    asyncio.run(_run())


def test_monthly_audit_cursor_advances_by_calendar_bucket_and_finds_march_gap() -> None:
    async def _run() -> None:
        january = int(
            datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
        )
        february = int(
            datetime(2024, 2, 1, tzinfo=timezone.utc).timestamp() * 1000
        )
        march = int(
            datetime(2024, 3, 1, tzinfo=timezone.utc).timestamp() * 1000
        )

        class _MonthlyStorage:
            def __init__(self) -> None:
                self.starts: list[int | None] = []

            def scan_gaps(self, **kwargs):
                start_ms = kwargs.get("start_ms")
                self.starts.append(start_ms)
                if start_ms is None:
                    return {
                        "gaps": [],
                        "truncated": True,
                        "resume_from_ms": january,
                    }
                if start_ms == february:
                    return {
                        "gaps": [],
                        "truncated": True,
                        "resume_from_ms": february,
                    }
                assert start_ms == march
                return {
                    "gaps": [{
                        "start_ms": march,
                        "end_ms": march,
                        "reason": "head_gap",
                    }],
                    "truncated": False,
                }

        series = ("binance", "spot", "BTCUSDT", "1M")
        storage = _MonthlyStorage()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            loop=asyncio.get_running_loop(),
        )

        first = await coordinator.audit_storage_series(
            [series],
            scan_limit=1,
            repair=False,
        )
        assert first.repaired == 0
        assert coordinator._gap_audit_cursors[series] == february

        second = await coordinator.audit_storage_series(
            [series],
            scan_limit=1,
            repair=False,
        )
        assert second.repaired == 0
        assert coordinator._gap_audit_cursors[series] == march

        third = await coordinator.audit_storage_series(
            [series],
            scan_limit=1,
            repair=False,
        )
        assert third.repaired == 1
        assert series not in coordinator._gap_audit_cursors
        assert storage.starts == [None, february, march]

    asyncio.run(_run())


def test_live_tail_lane_immediately_finds_recent_gap_before_latest_bar(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: 720.0,
    )

    async def _run() -> None:
        class _RecoveredTailStorage:
            def __init__(self) -> None:
                self.scan_calls: list[dict] = []

            def get_bounds(self, *args, **kwargs):
                # The 10m candle exists again, but the preceding 9m candle is
                # missing.  Starting at latest=10m would never see that hole.
                return {
                    "earliest_open_time": 0,
                    "latest_open_time": 600_000,
                }

            def scan_gaps(self, **kwargs):
                self.scan_calls.append(dict(kwargs))
                if "end_ms" in kwargs:
                    assert kwargs["start_ms"] <= 540_000 <= kwargs["end_ms"]
                    return {
                        "gaps": [{
                            "start_ms": 540_000,
                            "end_ms": 540_000,
                            "reason": "interior_gap",
                        }],
                        "truncated": False,
                    }
                raise AssertionError("tail budget should queue before interior scan")

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                return _RepairReport(status="completed")

        series = ("binance", "spot", "BTCUSDT", "1m")
        storage = _RecoveredTailStorage()
        engine = _Engine()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        report = await coordinator.audit_storage_series(
            [series],
            max_gaps=1,
            tail_series=[series],
        )

        assert report.queued == 1
        assert len(storage.scan_calls) == 1
        assert storage.scan_calls[0]["start_ms"] == 0
        assert storage.scan_calls[0]["end_ms"] == 660_000
        await _wait_until(lambda: len(engine.calls) == 1)
        assert engine.calls[0]["range_start_ms"] == 540_000
        assert engine.calls[0]["range_end_ms"] == 540_000
        assert engine.calls[0]["metadata"]["audit_lane"] == "tail"

    asyncio.run(_run())


def test_live_tail_lane_resumes_first_unprocessed_gap_without_touching_interior_cursor(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.backfill_coordinator.time.time",
        lambda: 720.0,
    )

    async def _run() -> None:
        class _ManyTailGapsStorage:
            def __init__(self) -> None:
                self.tail_starts: list[int] = []

            def get_bounds(self, *args, **kwargs):
                return {
                    "earliest_open_time": 0,
                    "latest_open_time": 600_000,
                }

            def scan_gaps(self, **kwargs):
                if "end_ms" not in kwargs:
                    raise AssertionError(
                        "tail budget should be exhausted before interior scan"
                    )
                start_ms = int(kwargs["start_ms"])
                self.tail_starts.append(start_ms)
                return {
                    "gaps": [
                        {
                            "start_ms": gap_start,
                            "end_ms": gap_start,
                            "reason": "tail_gap",
                        }
                        for gap_start in (300_000, 360_000, 420_000)
                        if gap_start >= start_ms
                    ],
                    "truncated": False,
                }

        series = ("binance", "spot", "BTCUSDT", "1m")
        storage = _ManyTailGapsStorage()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            loop=asyncio.get_running_loop(),
        )
        submitted: list[RepairRequest] = []
        coordinator.request = lambda request: (
            submitted.append(request) or request.request_id
        )

        first = await coordinator.audit_storage_series(
            [series],
            max_gaps=1,
            tail_series=[series],
        )
        assert first.queued == 1
        assert coordinator._gap_audit_tail_cursors[series] == 360_000
        assert series not in coordinator._gap_audit_cursors

        second = await coordinator.audit_storage_series(
            [series],
            max_gaps=1,
            tail_series=[series],
        )
        assert second.queued == 1
        assert coordinator._gap_audit_tail_cursors[series] == 420_000
        assert series not in coordinator._gap_audit_cursors

        third = await coordinator.audit_storage_series(
            [series],
            max_gaps=1,
            tail_series=[series],
        )
        assert third.queued == 1
        assert series not in coordinator._gap_audit_tail_cursors
        assert series not in coordinator._gap_audit_cursors
        assert storage.tail_starts == [0, 360_000, 420_000]
        assert [request.start_ms for request in submitted] == [
            300_000,
            360_000,
            420_000,
        ]

    asyncio.run(_run())


def test_live_tail_lane_with_no_stored_bar_falls_back_to_interior_only() -> None:
    async def _run() -> None:
        class _EmptySeriesStorage:
            def __init__(self) -> None:
                self.scan_calls: list[dict] = []

            def get_bounds(self, *args, **kwargs):
                return {"latest_open_time": None, "total_count": 0}

            def scan_gaps(self, **kwargs):
                self.scan_calls.append(dict(kwargs))
                return {"gaps": [], "truncated": False}

        series = ("binance", "spot", "NEWUSDT", "1m")
        storage = _EmptySeriesStorage()
        dm = _DataManager()
        coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            loop=asyncio.get_running_loop(),
        )

        report = await coordinator.audit_storage_series(
            [series],
            repair=False,
            tail_series=[series],
        )

        assert report.scanned == 1
        assert storage.scan_calls == [{
            "symbol": "NEWUSDT",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
            "limit": 50_000,
        }]

    asyncio.run(_run())


def test_backfill_coordinator_maps_partial_report_to_completed_event() -> None:
    async def _run() -> None:
        class _Engine:
            async def run(self, **kwargs):
                return _RepairReport(status="partial")

        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        outcome = await coord.request_and_wait(_request(0, 60_000))

        assert outcome.status == "partial"
        assert [event.event_type.value for event in dm.event_bus.events] == [
            "backfill.completed"
        ]
        assert dm.event_bus.events[0].detail["status"] == "partial"

    asyncio.run(_run())


def test_backfill_coordinator_maps_failed_report_to_failed_event() -> None:
    async def _run() -> None:
        class _Engine:
            async def run(self, **kwargs):
                return _RepairReport(status="failed", errors=["no data"])

        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            max_retries=1,
            base_delay_seconds=0,
        )

        outcome = await coord.request_and_wait(_request(0, 60_000))

        assert outcome.status == "failed"
        assert [event.event_type.value for event in dm.event_bus.events] == [
            "backfill.failed"
        ]
        assert dm.event_bus.events[0].detail["errors"] == ["no data"]

    asyncio.run(_run())


def test_backfill_coordinator_shutdown_cancels_active_request() -> None:
    async def _run() -> None:
        class _Engine:
            def __init__(self) -> None:
                self.started = asyncio.Event()

            async def run(self, **kwargs):
                self.started.set()
                await asyncio.Event().wait()

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        task = asyncio.create_task(coord.request_and_wait(_request(0, 60_000)))
        await engine.started.wait()

        await coord.shutdown()
        outcome = await task

        assert outcome.status == "failed"
        assert outcome.error == "cancelled"
        assert coord.snapshot()["active"] == []

    asyncio.run(_run())
