from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from app.data_engine.data_manager.models import DataEventType
from app.indicator import data_manager_bridge as bridge_module


class _IndicatorEngine:
    def __init__(self) -> None:
        self.recomputed: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def on_bar_closed(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_bar_updated(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_bars_backfilled(self, *args: Any, **kwargs: Any) -> None:
        self.recomputed.append((args, kwargs))


class _DataManager:
    def __init__(self) -> None:
        self.subscriptions: list[tuple[Any, set[DataEventType]]] = []
        self.query_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.query_failures = 0

    def subscribe(self, *, callback: Any, event_types: set[DataEventType]) -> None:
        self.subscriptions.append((callback, event_types))

    def query_latest(self, *args: Any, **kwargs: Any) -> Any:
        self.query_calls.append((args, kwargs))
        if self.query_failures > 0:
            self.query_failures -= 1
            raise RuntimeError("query failed")
        return SimpleNamespace(bars=[SimpleNamespace(time=1)])

    def backfill_callback(self) -> Any:
        for callback, event_types in self.subscriptions:
            if event_types == {DataEventType.BACKFILL_COMPLETED}:
                return callback
        raise AssertionError("backfill callback was not registered")


class _BackfillCoordinator:
    def __init__(self, *, bars_loaded: int = 4) -> None:
        self.release = asyncio.Event()
        self.bars_loaded = bars_loaded
        self.wait_calls: list[str] = []

    async def wait_for_request(self, request_id: str) -> Any:
        self.wait_calls.append(request_id)
        await self.release.wait()
        return SimpleNamespace(bars_loaded=self.bars_loaded)


def _backfill_event(request_id: str | None = "parent-1") -> Any:
    detail = {
        "bars_count": 1000,
        "request_start_ms": 0,
        "request_end_ms": 1_000,
    }
    if request_id is not None:
        detail["request_id"] = request_id
    return SimpleNamespace(
        event_type=DataEventType.BACKFILL_COMPLETED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="3m",
        ),
        detail=detail,
    )


def _amended_event() -> Any:
    return SimpleNamespace(
        event_type=DataEventType.BAR_AMENDED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="3m",
        ),
        bar=SimpleNamespace(time=300),
        detail={},
        timestamp_ms=123,
    )


async def _wait_until(predicate: Any, *, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    assert predicate()


def _install_bridge_fakes(monkeypatch: Any, engine: _IndicatorEngine) -> None:
    monkeypatch.setattr(bridge_module, "create_engine", lambda: engine)

    async def _run_storage(func: Any, *args: Any, **kwargs: Any) -> Any:
        return func(*args, **kwargs)

    monkeypatch.setattr(bridge_module, "run_storage", _run_storage)


def test_bridge_waits_for_parent_and_recomputes_once_for_chunk_events(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        coordinator = _BackfillCoordinator()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )
        callback = dm.backfill_callback()
        event = _backfill_event()

        for _ in range(4):
            await callback(event)
        await _wait_until(lambda: coordinator.wait_calls == ["parent-1"])
        assert dm.query_calls == []

        coordinator.release.set()
        await _wait_until(lambda: len(engine.recomputed) == 1)

        assert len(dm.query_calls) == 1
        args, kwargs = dm.query_calls[0]
        assert args == ("BTCUSDT", "3m")
        assert kwargs == {
            "limit": 5000,
            "exchange": "binance",
            "market_type": "spot",
            "auto_backfill": False,
        }

        # A final chunk event can arrive after the parent future settles. It is
        # still part of the same request and must not trigger a second refresh.
        await callback(event)
        await asyncio.sleep(0)
        assert len(dm.query_calls) == 1
        assert len(engine.recomputed) == 1

    asyncio.run(_run())


def test_bridge_skips_parent_with_no_loaded_bars(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        coordinator = _BackfillCoordinator(bars_loaded=0)
        coordinator.release.set()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )

        await dm.backfill_callback()(_backfill_event())
        await _wait_until(lambda: coordinator.wait_calls == ["parent-1"])
        await asyncio.sleep(0)

        assert dm.query_calls == []
        assert engine.recomputed == []

    asyncio.run(_run())


def test_bridge_falls_back_for_backfill_without_request_id(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(dm)

        await dm.backfill_callback()(_backfill_event(request_id=None))
        await _wait_until(lambda: len(engine.recomputed) == 1)

        assert len(dm.query_calls) == 1
        assert dm.query_calls[0][1]["auto_backfill"] is False

    asyncio.run(_run())


def test_bridge_clears_failed_request_so_later_event_can_retry(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        dm.query_failures = 1
        coordinator = _BackfillCoordinator()
        coordinator.release.set()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )
        callback = dm.backfill_callback()
        event = _backfill_event()

        await callback(event)
        await _wait_until(lambda: len(dm.query_calls) == 1)
        await asyncio.sleep(0)

        await callback(event)
        await _wait_until(lambda: len(engine.recomputed) == 1)

        assert len(dm.query_calls) == 2
        assert coordinator.wait_calls == ["parent-1", "parent-1"]

    asyncio.run(_run())


def test_bridge_recomputes_after_historical_bar_amendment(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(dm)
        callback = next(
            callback for callback, event_types in dm.subscriptions
            if event_types == {DataEventType.BAR_AMENDED}
        )

        await callback(_amended_event())
        await _wait_until(lambda: len(engine.recomputed) == 1)

        assert len(dm.query_calls) == 1
        assert engine.recomputed[0][1]["dirty_range"] == {"start": 300, "end": 300}

    asyncio.run(_run())
