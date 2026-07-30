from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from app.data_engine.data_manager.models import BarData, DataEventType
from app.indicator import create_engine as build_indicator_engine
from app.indicator import data_manager_bridge as bridge_module
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.events import IndicatorEventType
from app.indicator.engine import IndicatorEngine
from app.indicator.series_revision import SeriesRevisionRegistry


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
        self.query_pending = 0

    def subscribe(self, *, callback: Any, event_types: set[DataEventType]) -> None:
        self.subscriptions.append((callback, event_types))

    def query_latest(self, *args: Any, **kwargs: Any) -> Any:
        self.query_calls.append((args, kwargs))
        if self.query_failures > 0:
            self.query_failures -= 1
            raise RuntimeError("query failed")
        if self.query_pending > 0:
            self.query_pending -= 1
            return SimpleNamespace(
                bars=[SimpleNamespace(time=1)],
                missing_ranges=[SimpleNamespace(start_ms=0, end_ms=0)],
                retryable=True,
                complete=False,
            )
        return SimpleNamespace(
            bars=[SimpleNamespace(time=1)],
            missing_ranges=[],
            retryable=False,
            complete=True,
        )

    def backfill_callback(self) -> Any:
        for callback, event_types in self.subscriptions:
            if event_types == {DataEventType.BACKFILL_COMPLETED}:
                return callback
        raise AssertionError("backfill callback was not registered")


class _BackfillCoordinator:
    def __init__(
        self,
        *,
        bars_loaded: int = 4,
        verified_contiguous: bool | None = True,
        retryable: bool = False,
    ) -> None:
        self.release = asyncio.Event()
        self.bars_loaded = bars_loaded
        self.verified_contiguous = verified_contiguous
        self.retryable = retryable
        self.wait_calls: list[str] = []

    async def wait_for_request(self, request_id: str) -> Any:
        self.wait_calls.append(request_id)
        await self.release.wait()
        return SimpleNamespace(
            bars_loaded=self.bars_loaded,
            verified_contiguous=self.verified_contiguous,
            retryable=self.retryable,
        )


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


def _derived_backfill_event() -> Any:
    event = _backfill_event("base-parent")
    event.detail["derived_repair_targets"] = [
        {
            "interval": "91m",
            "start_ms": 5_460_000,
            "end_ms": 10_920_000,
        },
        {
            "interval": "91m",
            "start_ms": 20_000_000,
            "end_ms": 21_000_000,
        },
    ]
    return event


def _amended_event(timestamp: int = 300) -> Any:
    return SimpleNamespace(
        event_type=DataEventType.BAR_AMENDED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="3m",
        ),
        bar=SimpleNamespace(time=timestamp),
        detail={},
        timestamp_ms=timestamp * 1000,
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


def _closed_bars(count: int, *, interval_s: int = 180) -> list[BarData]:
    return [
        BarData(
            time=1_700_000_000 + index * interval_s,
            open=100 + index,
            high=101 + index,
            low=99 + index,
            close=100 + index,
            volume=10 + index,
        )
        for index in range(count)
    ]


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


def test_bridge_multi_written_ranges_use_parent_dirty_range_once(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        coordinator = _BackfillCoordinator()
        correction_calls: list[dict[str, Any]] = []

        class ResultService:
            def bind_engine(self, _engine: Any) -> None:
                return None

            def note_correction(self, **kwargs: Any) -> dict[str, Any]:
                correction_calls.append(kwargs)
                return {
                    "serverEpoch": "test",
                    "correctionRevision": 1,
                    "revisionToken": "test:1",
                }

        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
            result_service=ResultService(),
        )
        callback = dm.backfill_callback()
        first_chunk = _backfill_event("multi-range-parent")
        first_chunk.detail.update({
            "earliest": 0,
            "latest": 120,
            "range_start_ms": 0,
            "range_end_ms": 120_000,
            "request_start_ms": 0,
            "request_end_ms": 600_000,
        })
        second_chunk = _backfill_event("multi-range-parent")
        second_chunk.detail.update({
            "earliest": 300,
            "latest": 600,
            "range_start_ms": 300_000,
            "range_end_ms": 600_000,
            "request_start_ms": 0,
            "request_end_ms": 600_000,
        })

        await callback(first_chunk)
        await callback(second_chunk)
        await _wait_until(
            lambda: coordinator.wait_calls == ["multi-range-parent"]
        )
        assert dm.query_calls == []
        assert correction_calls == [{
            "series_key": "binance:spot:BTCUSDT:3m",
            "start": 0,
            "end": 600,
            "event_id": "backfill:multi-range-parent:3m",
        }]

        coordinator.release.set()
        await _wait_until(lambda: len(engine.recomputed) == 1)

        assert len(dm.query_calls) == 1
        assert engine.recomputed[0][1]["dirty_range"] == {
            "start": 0,
            "end": 600,
        }
        assert engine.recomputed[0][1]["data_revision"][
            "correctionRevision"
        ] == 1

        await callback(second_chunk)
        await asyncio.sleep(0)
        assert len(correction_calls) == 1
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


def test_bridge_seals_parent_when_no_subscriber_is_active(
    monkeypatch: Any,
) -> None:
    async def _run() -> None:
        bars = [
            BarData(
                time=300 + index * 180,
                open=100 + index,
                high=101 + index,
                low=99 + index,
                close=100 + index,
                volume=10,
            )
            for index in range(20)
        ]
        engine = bridge_module.create_engine()

        class HistoryDataManager(_DataManager):
            def query_latest(self, *args: Any, **kwargs: Any) -> Any:
                self.query_calls.append((args, kwargs))
                return SimpleNamespace(
                    bars=bars,
                    missing_ranges=[],
                    retryable=False,
                    complete=True,
                )

        dm = HistoryDataManager()
        coordinator = _BackfillCoordinator()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )
        event = _backfill_event("late-subscriber-parent")
        event.detail.update({
            "request_start_ms": bars[0].time * 1000,
            "request_end_ms": bars[-1].time * 1000,
        })

        await dm.backfill_callback()(event)
        await asyncio.sleep(0)
        assert coordinator.wait_calls == []
        assert dm.query_calls == []

        key, initial = engine.subscribe(
            symbol="BTCUSDT",
            interval="3m",
            market_type="spot",
            indicator_name="MA",
            params={"period": 5},
            bars=bars,
            exchange="binance",
        )
        assert initial is not None
        coordinator.release.set()
        await dm.backfill_callback()(event)
        await asyncio.sleep(0)

        # The same parent completion stays sealed after a subscriber appears;
        # otherwise every written range can retrigger an obsolete snapshot.
        assert coordinator.wait_calls == []
        assert dm.query_calls == []
        result = engine.get_result(key)
        assert result is not None
        assert len(result.outputs["ma"].data) == 20

    asyncio.run(_run())


def test_bridge_out_of_span_notification_skips_recompute_and_deduplicates(
    monkeypatch: Any,
) -> None:
    async def _run() -> None:
        bars = [
            BarData(
                time=10_000 + index * 180,
                open=100 + index,
                high=101 + index,
                low=99 + index,
                close=100 + index,
                volume=10,
            )
            for index in range(20)
        ]
        engine = bridge_module.create_engine()
        engine.subscribe(
            symbol="BTCUSDT",
            interval="3m",
            market_type="spot",
            indicator_name="MA",
            params={"period": 5},
            bars=bars,
            exchange="binance",
        )
        recomputed_events: list[Any] = []
        engine.add_listener(
            lambda event: recomputed_events.append(event)
            if event.event_type == IndicatorEventType.INDICATOR_RECOMPUTED
            else None
        )
        dm = _DataManager()
        coordinator = _BackfillCoordinator()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )
        event = _backfill_event("left-only-parent")
        event.detail.update({
            "request_start_ms": 1_000,
            "request_end_ms": 2_000,
        })

        await dm.backfill_callback()(event)
        await _wait_until(lambda: len(recomputed_events) == 1)

        assert coordinator.wait_calls == []
        assert dm.query_calls == []
        assert recomputed_events[0].full_result is None
        assert recomputed_events[0].detail["dirtyRange"] == {
            "start": 1,
            "end": 2,
        }

        # Later range events from the same parent-series completion must not
        # repeat either the invalidation or a storage refresh.
        await dm.backfill_callback()(event)
        await asyncio.sleep(0)
        assert coordinator.wait_calls == []
        assert dm.query_calls == []
        assert len(recomputed_events) == 1

    asyncio.run(_run())


def test_zero_bar_completion_does_not_advance_indicator_revision(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        coordinator = _BackfillCoordinator(bars_loaded=0)
        coordinator.release.set()
        correction_calls: list[dict[str, Any]] = []

        class ResultService:
            def bind_engine(self, _engine: Any) -> None:
                return None

            def note_correction(self, **kwargs: Any) -> dict[str, Any]:
                correction_calls.append(kwargs)
                return {"revisionToken": "unexpected"}

        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
            result_service=ResultService(),
        )
        event = _backfill_event("empty-parent")
        event.detail["bars_count"] = 0

        await dm.backfill_callback()(event)
        await asyncio.sleep(0)

        assert correction_calls == []
        assert coordinator.wait_calls == []
        assert dm.query_calls == []
        assert engine.recomputed == []

    asyncio.run(_run())


def test_backfill_correction_event_id_deduplicates_across_consumers() -> None:
    event = _backfill_event("shared-parent")
    dirty_range = {"start": 0, "end": 1}
    event_id = bridge_module.indicator_correction_event_id(
        event,
        interval="3m",
        dirty_range=dirty_range,
    )
    registry = SeriesRevisionRegistry(server_epoch="test")

    first = registry.record_correction(
        "BTCUSDT",
        "3m",
        dirty_range["start"],
        dirty_range["end"],
        event_id=event_id,
    )
    second = registry.record_correction(
        "BTCUSDT",
        "3m",
        dirty_range["start"],
        dirty_range["end"],
        event_id=event_id,
    )

    assert event_id == "backfill:shared-parent:3m"
    assert first["correctionRevision"] == 1
    assert second["correctionRevision"] == 1


def test_correction_event_id_fallback_is_scoped_by_exchange_and_market() -> None:
    events = []
    for exchange, market_type in (
        ("binance", "spot"),
        ("binance", "futures"),
        ("okx", "spot"),
    ):
        event = _backfill_event(request_id=None)
        event.key = SimpleNamespace(
            exchange=exchange,
            market_type=market_type,
            symbol="BTCUSDT",
            interval="3m",
        )
        event.timestamp_ms = 123_456
        events.append(event)

    event_ids = {
        bridge_module.indicator_correction_event_id(
            event,
            interval="3m",
            dirty_range={"start": 0, "end": 1},
        )
        for event in events
    }

    assert len(event_ids) == 3
    assert (
        "backfill.completed:binance:spot:BTCUSDT:3m:0:1:123456"
        in event_ids
    )


def test_bridge_does_not_complete_partial_backfill_refresh(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        coordinator = _BackfillCoordinator(
            bars_loaded=4,
            verified_contiguous=False,
            retryable=True,
        )
        coordinator.release.set()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )
        callback = dm.backfill_callback()
        event = _backfill_event("partial-parent")

        await callback(event)
        await _wait_until(lambda: coordinator.wait_calls == ["partial-parent"])
        await asyncio.sleep(0)
        await callback(event)
        await _wait_until(lambda: coordinator.wait_calls == [
            "partial-parent",
            "partial-parent",
        ])

        assert dm.query_calls == []
        assert engine.recomputed == []

    asyncio.run(_run())


def test_bridge_retries_when_target_query_is_still_pending(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        dm.query_pending = 1
        coordinator = _BackfillCoordinator()
        coordinator.release.set()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )
        callback = dm.backfill_callback()
        event = _backfill_event("pending-query-parent")

        await callback(event)
        await _wait_until(lambda: len(dm.query_calls) == 1)
        await asyncio.sleep(0)
        assert engine.recomputed == []

        await callback(event)
        await _wait_until(lambda: len(engine.recomputed) == 1)

        assert len(dm.query_calls) == 2
        assert coordinator.wait_calls == [
            "pending-query-parent",
            "pending-query-parent",
        ]

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


def test_bridge_skips_storage_when_series_has_no_active_builtin(
    monkeypatch: Any,
) -> None:
    async def _run() -> None:
        engine = bridge_module.create_engine()
        dm = _DataManager()
        bars = [
            BarData(
                time=300 + index * 180,
                open=100 + index,
                high=101 + index,
                low=99 + index,
                close=100 + index,
                volume=10,
            )
            for index in range(20)
        ]
        key, _result = engine.subscribe(
            symbol="BTCUSDT",
            interval="3m",
            market_type="spot",
            indicator_name="MA",
            params={"period": 5},
            bars=bars,
            exchange="binance",
        )
        engine.unsubscribe(key)
        assert engine.list_instances() == [key]

        coordinator = _BackfillCoordinator()
        coordinator.release.set()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )

        event = _backfill_event("idle-series-parent")
        event.detail.update({
            "request_start_ms": bars[0].time * 1000,
            "request_end_ms": bars[-1].time * 1000,
        })
        await dm.backfill_callback()(event)
        await asyncio.sleep(0)

        assert coordinator.wait_calls == []
        assert dm.query_calls == []
        assert engine.list_instances() == []

        await dm.backfill_callback()(event)
        await asyncio.sleep(0)
        assert coordinator.wait_calls == []
        assert dm.query_calls == []

    asyncio.run(_run())


def test_bridge_preserves_active_89m_ma500_computed_span(
    monkeypatch: Any,
) -> None:
    async def _run() -> None:
        step_seconds = 89 * 60
        bars = [
            BarData(
                time=1_700_000_000 + index * step_seconds,
                open=100 + index,
                high=101 + index,
                low=99 + index,
                close=100 + index,
                volume=10 + index,
            )
            for index in range(2_000)
        ]
        engine = bridge_module.create_engine()
        key, initial = engine.subscribe(
            symbol="BTCUSDT",
            interval="89m",
            market_type="spot",
            indicator_name="MA",
            params={"period": 500},
            bars=bars,
            exchange="binance",
        )
        assert initial is not None
        assert initial.outputs["ma"].data[-1].value is not None

        class HistoryDataManager(_DataManager):
            def query_latest(self, *args: Any, **kwargs: Any) -> Any:
                self.query_calls.append((args, kwargs))
                return SimpleNamespace(
                    bars=bars,
                    missing_ranges=[],
                    retryable=False,
                    complete=True,
                )

        dm = HistoryDataManager()
        coordinator = _BackfillCoordinator()
        coordinator.release.set()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )
        event = _backfill_event("ma500-parent")
        event.key = SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="89m",
        )
        event.detail.update({
            "request_start_ms": bars[500].time * 1000,
            "request_end_ms": bars[600].time * 1000,
        })

        await dm.backfill_callback()(event)
        await _wait_until(lambda: len(dm.query_calls) == 1)
        await _wait_until(
            lambda: engine.get_result(key) is not initial
        )

        assert dm.query_calls[0][0] == ("BTCUSDT", "89m")
        assert dm.query_calls[0][1]["limit"] == 2_001
        refreshed = engine.get_result(key)
        assert refreshed is not None
        assert len(refreshed.outputs["ma"].data) == 2_000
        assert refreshed.outputs["ma"].data[-1].value is not None

    asyncio.run(_run())


def test_bridge_recomputes_each_derived_repair_target(monkeypatch: Any) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        coordinator = _BackfillCoordinator()
        coordinator.release.set()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )

        await dm.backfill_callback()(_derived_backfill_event())
        await _wait_until(lambda: len(engine.recomputed) == 2)

        assert {args[1] for args, _kwargs in engine.recomputed} == {"3m", "91m"}
        assert {args[1] for args, _kwargs in dm.query_calls} == {"3m", "91m"}
        query_limits = {
            args[1]: kwargs["limit"] for args, kwargs in dm.query_calls
        }
        assert query_limits == {"3m": 5000, "91m": 51}
        by_interval = {
            args[1]: kwargs for args, kwargs in engine.recomputed
        }
        assert by_interval["91m"]["dirty_range"] == {
            "start": 5_460,
            "end": 21_000,
        }
        assert coordinator.wait_calls == ["base-parent", "base-parent"]

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


def test_bridge_flushes_amendments_arriving_during_active_refresh(
    monkeypatch: Any,
) -> None:
    async def _run() -> None:
        engine = _IndicatorEngine()
        dm = _DataManager()
        query_started = asyncio.Event()
        release_query = asyncio.Event()
        correction_calls: list[dict[str, Any]] = []

        class ResultService:
            def bind_engine(self, _engine: Any) -> None:
                return None

            def note_correction(self, **kwargs: Any) -> dict[str, Any]:
                correction_calls.append(kwargs)
                revision = len(correction_calls)
                return {
                    "serverEpoch": "test",
                    "correctionRevision": revision,
                    "revisionToken": f"test:{revision}",
                }

        _install_bridge_fakes(monkeypatch, engine)

        async def blocking_run_storage(
            func: Any,
            *args: Any,
            **kwargs: Any,
        ) -> Any:
            query_started.set()
            await release_query.wait()
            return func(*args, **kwargs)

        monkeypatch.setattr(
            bridge_module,
            "run_storage",
            blocking_run_storage,
        )
        bridge_module.bridge_indicator_engine(
            dm,
            result_service=ResultService(),
        )
        callback = next(
            callback for callback, event_types in dm.subscriptions
            if event_types == {DataEventType.BAR_AMENDED}
        )

        await callback(_amended_event(300))
        await asyncio.wait_for(query_started.wait(), timeout=1)
        await callback(_amended_event(600))
        await callback(_amended_event(900))

        assert len(correction_calls) == 3
        assert dm.query_calls == []

        release_query.set()
        await _wait_until(lambda: len(engine.recomputed) == 2)

        assert len(dm.query_calls) == 2
        assert [
            kwargs["dirty_range"] for _args, kwargs in engine.recomputed
        ] == [
            {"start": 300, "end": 300},
            {"start": 600, "end": 900},
        ]
        assert engine.recomputed[-1][1]["data_revision"][
            "correctionRevision"
        ] == 3

    asyncio.run(_run())


def test_cold_empty_builtin_seed_rebuilds_full_requested_window_once(
    monkeypatch: Any,
) -> None:
    async def _run() -> None:
        bars = _closed_bars(2_000)
        engine = build_indicator_engine()
        ema_key, ema_initial = engine.subscribe(
            symbol="BTCUSDT",
            interval="3m",
            market_type="spot",
            indicator_name="EMA",
            params={"period": 20, "source": "close"},
            bars=[],
            exchange="binance",
            desired_seed_bars=2_000,
        )
        macd_key, macd_initial = engine.subscribe(
            symbol="BTCUSDT",
            interval="3m",
            market_type="spot",
            indicator_name="MACD",
            params={"fast": 12, "slow": 26, "signal": 9, "source": "close"},
            bars=[],
            exchange="binance",
            desired_seed_bars=2_000,
        )
        assert ema_initial is None
        assert macd_initial is None

        class HistoryDataManager(_DataManager):
            def query_latest(self, *args: Any, **kwargs: Any) -> Any:
                self.query_calls.append((args, kwargs))
                return SimpleNamespace(
                    bars=bars,
                    missing_ranges=[],
                    retryable=False,
                    complete=True,
                )

        dm = HistoryDataManager()
        coordinator = _BackfillCoordinator()
        coordinator.release.set()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(
            dm,
            backfill_coordinator=coordinator,
        )

        await dm.backfill_callback()(_backfill_event("cold-empty-seed"))
        await _wait_until(lambda: len(dm.query_calls) == 1)

        assert len(dm.query_calls) == 1
        assert dm.query_calls[0][1]["limit"] == 2_001
        fresh = build_indicator_engine()
        expected_ema = fresh.compute(
            "BTCUSDT", "3m", "spot", "EMA",
            {"period": 20, "source": "close"}, bars,
        )
        expected_macd = fresh.compute(
            "BTCUSDT", "3m", "spot", "MACD",
            {"fast": 12, "slow": 26, "signal": 9, "source": "close"}, bars,
        )
        actual_ema = engine.get_result(ema_key)
        actual_macd = engine.get_result(macd_key)
        assert actual_ema is not None and expected_ema is not None
        assert actual_macd is not None and expected_macd is not None
        assert actual_ema.outputs["ema"].data == expected_ema.outputs["ema"].data
        for name in expected_macd.outputs:
            assert actual_macd.outputs[name].data == expected_macd.outputs[name].data

    asyncio.run(_run())


def test_base_amendment_routes_to_active_nonresident_89m_without_metadata(
    monkeypatch: Any,
) -> None:
    async def _run() -> None:
        bars = _closed_bars(40, interval_s=89 * 60)
        engine = build_indicator_engine()
        key, initial = engine.subscribe(
            symbol="BTCUSDT",
            interval="89m",
            market_type="spot",
            indicator_name="MA",
            params={"period": 5},
            bars=bars,
            exchange="binance",
        )
        assert initial is not None

        class HistoryDataManager(_DataManager):
            def query_latest(self, *args: Any, **kwargs: Any) -> Any:
                self.query_calls.append((args, kwargs))
                return SimpleNamespace(
                    bars=bars,
                    missing_ranges=[],
                    retryable=False,
                    complete=True,
                )

        dm = HistoryDataManager()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(dm)
        amendment = SimpleNamespace(
            event_type=DataEventType.BAR_AMENDED,
            key=SimpleNamespace(
                exchange="binance",
                market_type="spot",
                symbol="BTCUSDT",
                interval="1m",
            ),
            bar=BarData(
                time=bars[-1].time,
                open=1,
                high=2,
                low=0,
                close=1,
                volume=1,
            ),
            detail={},
            timestamp_ms=bars[-1].time * 1000,
        )
        callback = next(
            callback for callback, event_types in dm.subscriptions
            if event_types == {DataEventType.BAR_AMENDED}
        )
        await callback(amendment)
        await _wait_until(lambda: len(dm.query_calls) == 1)

        assert dm.query_calls[0][0] == ("BTCUSDT", "89m")
        assert dm.query_calls[0][1]["limit"] == 54
        assert engine.get_result(key) is not None

    asyncio.run(_run())


def test_forming_tail_cannot_advance_committed_indicator_frontier() -> None:
    bars = _closed_bars(20)
    engine = build_indicator_engine()
    key, initial = engine.subscribe(
        symbol="BTCUSDT",
        interval="3m",
        market_type="spot",
        indicator_name="MA",
        params={"period": 5},
        bars=bars,
        exchange="binance",
    )
    assert initial is not None
    forming_time = bars[-1].time + 180
    forming = BarData(
        time=forming_time,
        open=200,
        high=210,
        low=190,
        close=201,
        volume=5,
        is_closed=False,
    )
    engine.on_bars_backfilled(
        "BTCUSDT",
        "3m",
        bars + [forming],
        market_type="spot",
        exchange="binance",
    )
    after_correction = engine.get_result(key)
    assert after_correction is not None
    assert len(after_correction.outputs["ma"].data) == 20

    closed = BarData(
        time=forming_time,
        open=200,
        high=212,
        low=189,
        close=209,
        volume=9,
        is_closed=True,
    )
    engine.on_bar_closed(
        "BTCUSDT",
        "3m",
        closed,
        market_type="spot",
        exchange="binance",
    )
    final = engine.get_result(key)
    assert final is not None
    assert len(final.outputs["ma"].data) == 21
    assert final.outputs["ma"].data[-1].timestamp == forming_time


def test_base_amendment_invalidates_warm_engine_and_resident_89m_cache(
    monkeypatch: Any,
) -> None:
    async def _run() -> None:
        bars = _closed_bars(30, interval_s=89 * 60)
        engine = IndicatorEngine(
            warm_ttl_seconds=60,
            warm_max_instances=8,
        )
        key, result = engine.subscribe(
            symbol="BTCUSDT",
            interval="89m",
            market_type="spot",
            indicator_name="MA",
            params={"period": 5},
            bars=bars,
            exchange="binance",
        )
        assert result is not None
        engine.unsubscribe(key)
        assert engine.resident_series_intervals("BTCUSDT") == ("89m",)

        service = IndicatorRangeResultService(
            ttl_seconds=60,
            max_entries=8,
        )
        meta = {
            "kind": "builtin",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "89m",
            "name": "MA",
            "params": {"period": 5},
            "indicatorId": key.uid,
        }
        assert service.put_payload(
            meta,
            {"type": "indicator.snapshot", "lines": []},
            start=bars[0].time,
            end=bars[-1].time,
        )
        assert service.lookup_snapshot(
            meta,
            bars[0].time,
            bars[-1].time,
        ) is not None
        revision_before = service.data_revision_for_meta(meta)[
            "correctionRevision"
        ]

        dm = _DataManager()
        _install_bridge_fakes(monkeypatch, engine)
        bridge_module.bridge_indicator_engine(dm, result_service=service)
        callback = next(
            callback for callback, event_types in dm.subscriptions
            if event_types == {DataEventType.BAR_AMENDED}
        )
        event = SimpleNamespace(
            event_type=DataEventType.BAR_AMENDED,
            key=SimpleNamespace(
                exchange="binance",
                market_type="spot",
                symbol="BTCUSDT",
                interval="1m",
            ),
            bar=BarData(
                time=bars[-1].time,
                open=1,
                high=2,
                low=0,
                close=1,
                volume=1,
            ),
            detail={},
            timestamp_ms=bars[-1].time * 1000,
        )
        await callback(event)
        await asyncio.sleep(0)

        assert dm.query_calls == []
        assert engine.resident_series_intervals("BTCUSDT") == ()
        assert service.data_revision_for_meta(meta)["correctionRevision"] == (
            revision_before + 1
        )
        assert service.lookup_snapshot(
            meta,
            bars[0].time,
            bars[-1].time,
        ) is None

    asyncio.run(_run())
