from __future__ import annotations

import time

import pytest

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType
from app.data_engine.ingestion.shared_ws import SharedWsHubRegistry
from app.data_engine.ingestion.transport import TransportError, TransportLayer


pytestmark = pytest.mark.anyio


def _okx(symbol: str, interval: str = "1m") -> StreamDescriptor:
    return StreamDescriptor(
        symbol=symbol,
        stream_type=StreamType.KLINE,
        interval=interval,
        exchange="okx",
        market_type="spot",
    )


async def _noop(*_args) -> None:
    return None


async def test_okx_kline_descriptors_share_bounded_cross_symbol_shards() -> None:
    ingestion = IngestionConfig()
    registry = SharedWsHubRegistry(
        ingestion,
        TransportLayer(ingestion),
        max_descriptors_per_shard=2,
    )
    btc = _okx("BTC-USDT")
    eth = _okx("ETH-USDT")
    sol = _okx("SOL-USDT")

    first = registry.get_hub(btc)
    assert first is not None
    first._ensure_runner = lambda: None
    await first.subscribe(btc, _noop, _noop)

    second_for_same_shard = registry.get_hub(eth)
    assert second_for_same_shard is first
    await first.subscribe(eth, _noop, _noop)

    second = registry.get_hub(sol)
    assert second is not None and second is not first
    second._ensure_runner = lambda: None
    await second.subscribe(sol, _noop, _noop)

    snapshot = registry.snapshot()
    assert snapshot["hub_count"] == 2
    assert snapshot["descriptor_count"] == 3
    assert snapshot["max_descriptors_per_shard"] == 2
    assert [hub["shard_index"] for hub in snapshot["hubs"]] == [0, 1]
    assert all(hub["scope"] == "KLINES" for hub in snapshot["hubs"])

    # A failure/reconnect streak is local to one physical shard.
    first._consecutive_failures = 3
    assert first.snapshot()["consecutive_failures"] == 3
    assert second.snapshot()["consecutive_failures"] == 0


async def test_hub_itself_fails_closed_if_assignment_races_past_shard_cap() -> None:
    ingestion = IngestionConfig()
    registry = SharedWsHubRegistry(
        ingestion,
        TransportLayer(ingestion),
        max_descriptors_per_shard=1,
    )
    hub = registry.get_hub(_okx("BTC-USDT"))
    assert hub is not None
    hub._ensure_runner = lambda: None
    await hub.subscribe(_okx("BTC-USDT"), _noop, _noop)

    with pytest.raises(TransportError, match="shard capacity"):
        await hub.subscribe(_okx("ETH-USDT"), _noop, _noop)


async def test_registry_reserves_slots_before_concurrent_sessions_subscribe() -> None:
    ingestion = IngestionConfig()
    registry = SharedWsHubRegistry(
        ingestion,
        TransportLayer(ingestion),
        max_descriptors_per_shard=2,
    )

    first = registry.get_hub(_okx("BTC-USDT"))
    second = registry.get_hub(_okx("ETH-USDT"))
    overflow = registry.get_hub(_okx("SOL-USDT"))

    assert first is second
    assert overflow is not None and overflow is not first
    snapshot = registry.snapshot()
    assert snapshot["descriptor_count"] == 3
    assert [hub["reserved_descriptor_count"] for hub in snapshot["hubs"]] == [2, 1]


async def test_okx_hub_enforces_official_control_and_payload_budgets() -> None:
    class _Connection:
        async def send(self, _payload: str) -> None:
            return None

    ingestion = IngestionConfig()
    registry = SharedWsHubRegistry(ingestion, TransportLayer(ingestion))
    hub = registry.get_hub(_okx("BTC-USDT"))
    assert hub is not None
    hub._conn = _Connection()

    hub._control_messages.extend([time.monotonic()] * 480)
    with pytest.raises(TransportError, match="480/hour"):
        await hub._send_control_payload({"op": "subscribe", "args": []})

    hub._control_messages.clear()
    with pytest.raises(TransportError, match="64 KiB"):
        await hub._send_control_payload({"op": "subscribe", "padding": "x" * 70_000})


async def test_binance_kline_transport_remains_path_per_stream() -> None:
    ingestion = IngestionConfig()
    registry = SharedWsHubRegistry(ingestion, TransportLayer(ingestion))
    descriptor = StreamDescriptor(
        symbol="BTCUSDT",
        stream_type=StreamType.KLINE,
        interval="1m",
        exchange="binance",
        market_type="spot",
    )

    assert registry.get_hub(descriptor) is None
