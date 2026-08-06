from __future__ import annotations

import pytest

from app.api.v1.stream_klines import _KlineWsOutbox
from app.data_engine.data_manager import DataManager, DataManagerConfig, StreamCapacityError
from app.data_engine.data_manager.models import SeriesKey
from app.indicator import IndicatorCapacityError, IndicatorEngine


pytestmark = pytest.mark.anyio


async def test_stream_leases_are_idempotent_and_reject_only_new_unique_series() -> None:
    config = DataManagerConfig()
    config.coordinator.max_active_series = 2
    manager = DataManager(config)
    first = SeriesKey("BTCUSDT", "1m")
    second = SeriesKey("ETHUSDT", "1m")
    third = SeriesKey("SOLUSDT", "1m")

    manager._register_stream_leases((first,), consumer_id="window:a:cell:1")
    manager._register_stream_leases((first,), consumer_id="window:a:cell:1")
    manager._register_stream_leases((first,), consumer_id="window:b:cell:1")
    manager._register_stream_leases((second,), consumer_id="window:a:cell:2")

    with pytest.raises(StreamCapacityError) as error:
        manager._register_stream_leases((third,), consumer_id="window:a:cell:3")

    assert error.value.active == 2
    assert manager.stream_lease_snapshot(limit=1) == {
        "series_count": 2,
        "consumer_claims": 3,
        "unique_consumers": 3,
        "max_active_series": 2,
        "detail_offset": 0,
        "detail_limit": 1,
        "detail_total": 2,
        "series": [{"key": str(first), "consumer_count": 2}],
    }

    manager._release_stream_leases((first,), consumer_id="window:a:cell:1")
    assert first in manager._stream_leases
    manager._release_stream_leases((first,), consumer_id="window:b:cell:1")
    assert first not in manager._stream_leases
    manager._register_stream_leases((third,), consumer_id="window:a:cell:3")
    assert manager.stream_lease_snapshot()["series_count"] == 2


async def test_authoritative_outbox_message_supersedes_its_forming_slot() -> None:
    outbox = _KlineWsOutbox(maxsize=1)
    key = ("cell-1", "binance", "spot", "BTCUSDT", "1m")

    assert await outbox.put({"state": "forming-1"}, key=key, replaceable=True)
    assert await outbox.put({"state": "forming-2"}, key=key, replaceable=True)
    assert await outbox.put({"state": "final"}, key=key, timeout=0.01)

    assert await outbox.get() == {"state": "forming-2"}
    assert await outbox.get() == {"state": "final"}
    assert outbox.snapshot()["authoritative_supersedes"] == 1
    assert outbox.snapshot()["authoritative_timeouts"] == 0


async def test_batch_outbox_keeps_same_series_isolated_by_logical_client() -> None:
    outbox = _KlineWsOutbox(maxsize=2)
    common = ("binance", "spot", "BTCUSDT", "1m")

    assert await outbox.put(
        {"client_id": "cell-1"},
        key=("cell-1", *common),
        replaceable=True,
    )
    assert await outbox.put(
        {"client_id": "cell-2"},
        key=("cell-2", *common),
        replaceable=True,
    )

    assert {"cell-1", "cell-2"} == {
        (await outbox.get())["client_id"],
        (await outbox.get())["client_id"],
    }


async def test_indicator_capacity_evicts_idle_then_preserves_active_targets() -> None:
    engine = IndicatorEngine(
        warm_ttl_seconds=300,
        warm_max_instances=2,
        max_active_targets=2,
    )

    first, _ = engine.subscribe("BTCUSDT", "1m", "spot", "MA", {"period": 3})
    engine.unsubscribe(first)
    second, _ = engine.subscribe("ETHUSDT", "1m", "spot", "MA", {"period": 3})
    third, _ = engine.subscribe("SOLUSDT", "1m", "spot", "MA", {"period": 3})

    assert first not in engine.list_instances()
    assert {second, third}.issubset(set(engine.list_instances()))
    with pytest.raises(IndicatorCapacityError):
        engine.subscribe("XRPUSDT", "1m", "spot", "MA", {"period": 3})

    # Existing active targets remain reusable at the boundary.
    replay, _ = engine.subscribe("ETHUSDT", "1m", "spot", "MA", {"period": 3})
    assert replay == second
    assert engine.snapshot()["max_active_targets"] == 2
