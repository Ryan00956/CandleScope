from __future__ import annotations

import time

import pytest

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType
from app.data_engine.ingestion.shared_ws import SharedMultiplexHub, SharedWsHubRegistry
from app.data_engine.ingestion.transport import TransportError, TransportLayer
from app.exchanges.ccxt_ext.session import CcxtProviderSession
from app.exchanges.plugins.okx.protocol import OkxExchangeProtocol


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


async def test_okx_kline_descriptors_defer_to_ccxt_provider_pool() -> None:
    ingestion = IngestionConfig()
    transport = TransportLayer(ingestion)
    registry = SharedWsHubRegistry(
        ingestion,
        transport,
        max_descriptors_per_shard=2,
    )
    btc = _okx("BTC-USDT")
    eth = _okx("ETH-USDT")
    sol = _okx("SOL-USDT")

    assert [registry.get_hub(item) for item in (btc, eth, sol)] == [None, None, None]
    sessions = [transport.create_provider_session(item) for item in (btc, eth, sol)]
    assert all(isinstance(session, CcxtProviderSession) for session in sessions)
    assert registry.snapshot()["hub_count"] == 0


async def test_hub_itself_fails_closed_if_assignment_races_past_shard_cap() -> None:
    ingestion = IngestionConfig()
    hub = SharedMultiplexHub(
        config=ingestion,
        transport=TransportLayer(ingestion),
        exchange="okx",
        market_type="spot",
        symbol="KLINES",
        protocol=OkxExchangeProtocol(),
        max_descriptors=1,
    )
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

    assert registry.get_hub(_okx("BTC-USDT")) is None
    assert registry.get_hub(_okx("ETH-USDT")) is None
    assert registry.get_hub(_okx("SOL-USDT")) is None
    assert registry.snapshot()["descriptor_count"] == 0


async def test_okx_hub_enforces_official_control_and_payload_budgets() -> None:
    class _Connection:
        async def send(self, _payload: str) -> None:
            return None

    ingestion = IngestionConfig()
    hub = SharedMultiplexHub(
        config=ingestion,
        transport=TransportLayer(ingestion),
        exchange="okx",
        market_type="spot",
        symbol="KLINES",
        protocol=OkxExchangeProtocol(),
    )
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
