from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from app.data_engine.data_manager.backfill_coordinator import (
    BackfillCoordinator,
    RepairRequest,
)


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


class _Storage:
    pass


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
        coord = BackfillCoordinator(
            data_manager=_DataManager(),
            storage=_Storage(),
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
            data_manager=dm,
            storage=_Storage(),
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
                return [{
                    "open_time": kwargs["start_ms"],
                    "open": 1,
                    "high": 2,
                    "low": 1,
                    "close": 2,
                    "volume": 3,
                }]

        class _DataManager:
            def __init__(self) -> None:
                self.event_bus = _EventBus()
                self.loaded: list[tuple] = []

            async def on_bars_backfilled(self, symbol, interval, bars, **kwargs):
                self.loaded.append((symbol, interval, bars, kwargs))

        storage = _Storage()
        dm = _DataManager()
        coord = BackfillCoordinator(
            data_manager=dm,
            storage=storage,
            engine=_Engine(),
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        outcome = await coord.request_and_wait(_request(0, 180_000))

        assert outcome.bars_loaded == 1
        assert storage.calls == [{
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 60_000,
            "order": "ASC",
            "exchange": "binance",
            "market_type": "spot",
        }]
        assert dm.loaded[0][3]["event_detail"]["status"] == "completed"
        assert dm.loaded[0][3]["event_detail"]["range_start_ms"] == 60_000

    asyncio.run(_run())


def test_backfill_coordinator_maps_partial_report_to_completed_event() -> None:
    async def _run() -> None:
        class _Engine:
            async def run(self, **kwargs):
                return _RepairReport(status="partial")

        dm = _DataManager()
        coord = BackfillCoordinator(
            data_manager=dm,
            storage=_Storage(),
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
            data_manager=dm,
            storage=_Storage(),
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
        coord = BackfillCoordinator(
            data_manager=_DataManager(),
            storage=_Storage(),
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
