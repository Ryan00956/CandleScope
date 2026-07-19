from __future__ import annotations

from app.data_engine.data_manager import cache_behavior as cache_behavior_module
from app.data_engine.data_manager.cache_behavior import (
    EVENT_RETENTION_MS,
    CacheAccessEvent,
    CacheBehaviorStore,
)
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


def test_future_event_time_is_clamped_to_server_clock(tmp_path, monkeypatch) -> None:
    server_now_ms = 1_700_000_000_000
    monkeypatch.setattr(
        cache_behavior_module.time,
        "time",
        lambda: server_now_ms / 1000,
    )
    store = CacheBehaviorStore(tmp_path / "behavior.sqlite")
    key = SeriesKey("BTCUSDT", "1m")

    store.record(CacheAccessEvent(
        key=key,
        action="chart-active",
        source="test",
        occurred_at_ms=server_now_ms,
    ))
    heat = store.record(CacheAccessEvent(
        key=key,
        action="chart-switch",
        source="test",
        occurred_at_ms=server_now_ms + EVENT_RETENTION_MS + 1,
    ))

    assert heat["access_count_7d"] == 2
    assert heat["last_seen_ms"] <= server_now_ms
    assert heat["heat_score"] >= 0
    with store._connect() as conn:
        count, latest = conn.execute(
            "SELECT COUNT(*), MAX(occurred_at_ms) FROM cache_access_events"
        ).fetchone()
    assert count == 2
    assert latest <= server_now_ms
