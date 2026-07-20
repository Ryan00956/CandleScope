from __future__ import annotations

from app.data_engine.data_manager.cache import BarCache, BarSeries
from app.data_engine.data_manager.config import CacheConfig, DataManagerConfig
from app.data_engine.data_manager.gc import plan_memory_gc
from app.data_engine.data_manager.manager import DataManager
from app.data_engine.data_manager.models import BarData, SeriesKey


def _bar(time_s: int, close: float = 1) -> BarData:
    return BarData(
        time=time_s,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=1,
    )


def _bars(start: int, stop: int) -> list[BarData]:
    return [_bar(time_s) for time_s in range(start, stop)]


def test_history_capacity_is_clamped_and_demotes_oldest_reservation() -> None:
    cache = BarCache(CacheConfig(
        max_bars_per_series=3,
        max_series=10,
        history_max_bars_per_series=8,
        history_max_series=2,
    ))
    first = SeriesKey("BTCUSDT", "1m")
    second = SeriesKey("ETHUSDT", "1m")
    third = SeriesKey("SOLUSDT", "1m")

    reservation = cache.reserve_history_capacity(first, 100)
    assert reservation.capacity_bars == 8
    assert reservation.capped is True
    cache.bulk_load(first, _bars(0, 9))

    demotion_evictions: list[tuple[SeriesKey, list[BarData]]] = []
    cache.on_eviction(
        lambda key, bars: demotion_evictions.append((key, list(bars)))
    )
    cache.reserve_history_capacity(second, 7)
    cache.bulk_load(second, _bars(0, 7))
    # Even a small follow-up request is reuse and refreshes reservation LRU.
    assert cache.reserve_history_capacity(first, 1).capacity_bars == 8
    cache.reserve_history_capacity(third, 6)

    snapshot = cache.snapshot()
    assert snapshot["max_total_bars"] == 40
    assert snapshot["history"]["reservation_count"] == 2
    assert snapshot["history"]["reservation_demotions"] == 1
    assert list(snapshot["history"]["reservations"]) == [str(first), str(third)]
    assert snapshot["series"][str(second)]["max_bars"] == 3
    assert cache.series_count(second) == 3
    assert [bar.time for bar in cache.get_latest(second, 10)] == [4, 5, 6]
    assert [(key, [bar.time for bar in bars]) for key, bars in demotion_evictions] == [
        (second, [0, 1, 2, 3]),
    ]


def test_history_invalidation_drops_rows_but_keeps_bounded_capacity() -> None:
    cache = BarCache(CacheConfig(
        max_bars_per_series=3,
        history_max_bars_per_series=12,
        history_max_series=1,
    ))
    key = SeriesKey("BTCUSDT", "1m")
    cache.reserve_history_capacity(key, 12)
    cache.bulk_load(key, _bars(0, 12))

    correction = _bar(5, close=99)
    cache.bulk_load(key, [correction])
    assert cache.get_bar_at(key, 5) == correction

    cache.invalidate(key)
    invalidated = cache.snapshot()
    assert str(key) not in invalidated["series"]
    assert invalidated["history"]["reservations"] == {str(key): 12}

    cache.bulk_load(key, _bars(0, 12))
    reloaded = cache.snapshot()
    assert reloaded["series"][str(key)]["max_bars"] == 12
    assert cache.series_count(key) == 12

    assert cache.remove_series(key) == 12
    assert cache.snapshot()["history"]["reservation_count"] == 0


def test_disjoint_bulk_load_paths_keep_order_updates_and_capacity() -> None:
    series = BarSeries(max_bars=6)
    assert series.bulk_load(_bars(3, 6)) == []
    assert series.bulk_load(_bars(0, 3)) == []
    evicted = series.bulk_load(_bars(6, 9))

    assert [bar.time for bar in evicted] == [0, 1, 2]
    assert [bar.time for bar in series.get_latest(10)] == [3, 4, 5, 6, 7, 8]

    replacement = _bar(5, close=55)
    assert series.bulk_load([replacement]) == []
    assert series.get_bar_at(5) == replacement


def test_memory_gc_uses_expanded_history_budget_without_false_pressure() -> None:
    manager = DataManager(DataManagerConfig(cache=CacheConfig(
        max_bars_per_series=3,
        max_series=2,
        history_max_bars_per_series=8,
        history_max_series=1,
    )))
    history_key = SeriesKey("BTCUSDT", "1m")
    normal_key = SeriesKey("ETHUSDT", "1m")
    manager.cache.reserve_history_capacity(history_key, 8)
    manager.cache.bulk_load(history_key, _bars(0, 8))
    manager.cache.bulk_load(normal_key, _bars(0, 3))

    plan = plan_memory_gc(manager, {"cold_idle_seconds": 3_600})

    assert plan["pressure"]["total_bars"] == 11
    assert plan["pressure"]["max_total_bars"] == 11
    assert plan["pressure"]["over_total_bars"] == 0
