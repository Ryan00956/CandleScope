from __future__ import annotations

from app.data_engine.data_manager.cache_behavior import CacheAccessEvent, CacheBehaviorStore
from app.data_engine.data_manager.models import SeriesKey


def test_snapshot_removes_heat_after_event_retention_window(tmp_path) -> None:
    store = CacheBehaviorStore(tmp_path / "behavior.sqlite")
    key = SeriesKey("BTCUSDT", "1m")
    store.record(CacheAccessEvent(
        key=key,
        action="chart-active",
        source="test",
        occurred_at_ms=1_000,
    ))

    assert store.snapshot()["series"] == []


def test_snapshot_recomputes_heat_for_current_events(tmp_path) -> None:
    store = CacheBehaviorStore(tmp_path / "behavior.sqlite")
    key = SeriesKey("ETHUSDT", "1m")
    store.record(CacheAccessEvent(key=key, action="chart-active", source="test"))

    first = store.snapshot()["series"][0]
    assert first["key"] == str(key)
    assert first["heat_score"] > 0
