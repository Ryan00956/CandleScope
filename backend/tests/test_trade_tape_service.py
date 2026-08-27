from __future__ import annotations

import asyncio

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.trade_tape import TradeTapeEngine
from app.data_engine.market_data.trade_tape_service import TradeTapeService


class _Handle:
    def __init__(self) -> None:
        self.stops = 0

    async def stop(self) -> bool:
        self.stops += 1
        return True


class _Factory:
    def __init__(self) -> None:
        self.callback = None
        self.handle = _Handle()

    async def start_market(self, descriptor, callback, *, on_gap=None):
        assert descriptor.stream_type is StreamType.TRADE
        assert on_gap is None
        self.callback = callback
        return self.handle


def _key() -> MarketStreamKey:
    return MarketStreamKey.build(
        "sample",
        "spot",
        "BTC/USDT",
        MarketChannel.TRADE,
    )


def _event(trade_id: str, *, side: str = "buy") -> MarketEvent:
    return MarketEvent(
        event_type=StreamType.TRADE,
        symbol="BTC/USDT",
        exchange="sample",
        market_type="spot",
        event_time_ms=1_700_000_000_000,
        received_at_ms=1_700_000_000_010,
        source=DataSource.PLUGIN,
        data={
            "trade_id": trade_id,
            "exchange_trade_id": trade_id,
            "price": 60_000.0,
            "quantity": 0.1,
            "trade_time_ms": 1_700_000_000_000,
            "side": side,
            "is_buyer_maker": side == "sell",
        },
    )


def test_trade_tape_engine_deduplicates_without_claiming_exchange_continuity() -> None:
    engine = TradeTapeEngine(raw_ring_size=4, max_streams=1)
    identity = ("sample", "spot", "BTC/USDT")
    assert engine.activate_stream(identity) is True

    first = engine.ingest(_event("opaque-a"))
    duplicate = engine.ingest(_event("opaque-a"))
    second = engine.ingest(_event("opaque-z", side="sell"))

    assert first is not None and first.observation_sequence == 0
    assert duplicate is None
    assert second is not None and second.observation_sequence == 1
    assert second.to_dict()["continuity_mode"] == "observational"
    assert second.to_dict()["is_buyer_maker"] is True
    assert engine.diagnostics()["continuity"] is False


@pytest.mark.anyio
async def test_trade_tape_service_keeps_atomic_recent_to_live_handoff(monkeypatch) -> None:
    factory = _Factory()
    service = TradeTapeService(
        factory,
        engine=TradeTapeEngine(raw_ring_size=8, max_streams=2),
        flush_interval_seconds=1,
        max_streams=2,
    )
    monkeypatch.setattr(
        TradeTapeService,
        "_validate_key",
        staticmethod(lambda key: (key.exchange, key.market_type, key.symbol)),
    )
    key = _key()

    assert await service.ensure_stream(key, consumer_id="browser") is True
    assert factory.callback is not None
    await factory.callback(_event("one"))
    attachment = service.attach(key, recent_limit=10, max_pending_records=8)
    assert [item.trade_id for item in attachment.recent[("sample", "spot", "BTC/USDT")]] == [
        "one",
    ]

    await factory.callback(_event("two", side="sell"))
    service.hub.flush_all()
    batch = await asyncio.wait_for(attachment.subscription.receive(), timeout=1)
    assert batch is not None
    assert [item.trade_id for item in batch.records] == ["two"]
    assert batch.continuity is True

    await attachment.subscription.close()
    assert await service.release_stream(key, consumer_id="browser") is True
    assert factory.handle.stops == 1
    await service.shutdown()
