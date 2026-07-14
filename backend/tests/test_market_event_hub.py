from __future__ import annotations

import asyncio
from functools import wraps

from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.events import MarketStateEvent
from app.data_engine.market_data.hub import MarketEventHub
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


def _async_test(function):
    @wraps(function)
    def _wrapped():
        return asyncio.run(function())

    return _wrapped


def _key(symbol: str = "BTCUSDT", channel: MarketChannel = MarketChannel.MARK_PRICE):
    return MarketStreamKey.build("binance", "futures", symbol, channel)


def _event(
    key: MarketStreamKey,
    value: float,
    *,
    event_time_ms: int,
    received_at_ms: int | None = None,
) -> MarketStateEvent:
    return MarketStateEvent(
        key=key,
        event_time_ms=event_time_ms,
        received_at_ms=received_at_ms or event_time_ms + 1,
        source=DataSource.WEBSOCKET,
        data={"value": value},
    )


@_async_test
async def test_market_hub_replays_and_coalesces_latest_state_per_key() -> None:
    hub = MarketEventHub(max_states=8, default_max_pending=4)
    key = _key()
    first = hub.publish(_event(key, 1, event_time_ms=100))
    assert first is not None and first.revision == 1

    subscription = hub.subscribe([key], replay=True)
    replay = await subscription.receive()
    assert replay is not None and replay.event.data["value"] == 1

    hub.publish(_event(key, 2, event_time_ms=200))
    hub.publish(_event(key, 3, event_time_ms=300))
    assert subscription.pending_count == 1
    latest = await subscription.receive()
    assert latest is not None
    assert latest.revision == 3
    assert latest.event.data["value"] == 3
    assert hub.diagnostics()["subscriber_coalesced"] == 1

    await subscription.close()


@_async_test
async def test_market_hub_rejects_regression_and_protects_active_state_at_capacity() -> None:
    hub = MarketEventHub(max_states=1)
    key = _key()
    assert hub.publish(_event(key, 2, event_time_ms=200)) is not None
    assert hub.publish(_event(key, 1, event_time_ms=100)) is None
    subscription = hub.subscribe([key], replay=False)
    assert hub.publish(_event(_key("ETHUSDT"), 3, event_time_ms=300)) is None

    snapshot = hub.snapshot([key])
    assert len(snapshot) == 1
    assert snapshot[0].event.data["value"] == 2
    diagnostics = hub.diagnostics()
    assert diagnostics["stale_rejected"] == 1
    assert diagnostics["capacity_rejected"] == 1
    await subscription.close()


def test_market_hub_evicts_oldest_inactive_state_at_capacity() -> None:
    hub = MarketEventHub(max_states=1)
    old_key = _key()
    new_key = _key("ETHUSDT")
    assert hub.publish(_event(old_key, 1, event_time_ms=100)) is not None

    replacement = hub.publish(_event(new_key, 2, event_time_ms=200))

    assert replacement is not None
    assert hub.snapshot([old_key]) == []
    assert hub.snapshot([new_key]) == [replacement]
    assert hub.diagnostics()["capacity_evicted"] == 1


@_async_test
async def test_market_hub_pending_buffer_is_bounded_and_close_unblocks() -> None:
    hub = MarketEventHub(max_states=8)
    first_key = _key("BTCUSDT")
    second_key = _key("ETHUSDT")
    subscription = hub.subscribe([first_key, second_key], max_pending=1, replay=False)

    hub.publish(_event(first_key, 1, event_time_ms=100))
    hub.publish(_event(second_key, 2, event_time_ms=200))
    assert subscription.pending_count == 1
    record = await subscription.receive()
    assert record is not None and record.event.key == second_key
    assert hub.diagnostics()["subscriber_dropped"] == 1

    waiting = asyncio.create_task(subscription.receive())
    await asyncio.sleep(0)
    await subscription.close()
    assert await waiting is None
    assert hub.diagnostics()["active_subscribers"] == 0
