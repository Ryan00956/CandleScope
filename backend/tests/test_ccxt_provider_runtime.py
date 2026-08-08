from __future__ import annotations

import asyncio
import time
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    FeedMode,
    SessionHealth,
    StreamDescriptor,
    StreamType,
)
from app.exchanges.ccxt_ext.hooks import build_hooked_exchange_class
from app.exchanges.ccxt_ext.models import CcxtLifecycleEvent, CcxtRawMarketEvent
from app.exchanges.ccxt_ext.profiles import BinanceUsdmCcxtProfile
from app.exchanges.ccxt_ext.runtime import CcxtRuntimePool
from app.exchanges.ccxt_ext.session import CcxtProviderSession
from app.exchanges.plugins.binance.plugin import BinancePlugin


class _FakeExchange:
    def __init__(
        self,
        raw_sink: Any,
        lifecycle_sink: Any,
        *,
        fail_load: bool = False,
    ) -> None:
        self.raw_sink = raw_sink
        self.lifecycle_sink = lifecycle_sink
        self.fail_load = fail_load
        self.markets = {
            "BTC/USDT:USDT": {
                "id": "BTCUSDT",
                "symbol": "BTC/USDT:USDT",
                "swap": True,
                "linear": True,
            }
        }
        self.load_calls = 0
        self.close_calls = 0
        self.recycle_calls = 0
        self.clean_ws_calls = 0
        self.clients: dict[str, object] = {"wss://example.test/ws": object()}
        self.watch_queue: asyncio.Queue[CcxtRawMarketEvent | BaseException] = (
            asyncio.Queue()
        )

    async def load_markets(self) -> None:
        self.load_calls += 1
        if self.fail_load:
            raise RuntimeError("temporary load-markets failure")

    async def close(self, clean_instance_data: bool = False) -> None:
        self.close_calls += 1
        if clean_instance_data:
            self.clients.clear()

    async def close_ws_clients(self) -> None:
        self.recycle_calls += 1
        self.clients.clear()

    def clean_ws_data(self) -> None:
        self.clean_ws_calls += 1


class _UpstreamExchange:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.closed = False

    def handle_message(self, client: Any, message: Any) -> str:
        del client, message
        return "projected"

    def on_connected(self, client: Any, message: Any = None) -> None:
        del client, message

    def on_error(self, client: Any, error: BaseException) -> None:
        del client, error

    def on_close(self, client: Any, error: BaseException | None) -> None:
        del client, error

    async def close(self) -> None:
        self.closed = True


class _Client:
    url = "wss://example.test/ws"


class _FakeProfile:
    exchange_id = "fake"
    market_type = "futures"

    def __init__(self, *, load_failures: int = 0) -> None:
        self.create_calls = 0
        self.close_calls = 0
        self.load_failures = load_failures
        self.exchange: _FakeExchange | None = None

    async def close(self) -> None:
        self.close_calls += 1

    def supports(self, descriptor: StreamDescriptor) -> bool:
        return descriptor.stream_type == StreamType.AGG_TRADE

    def create_exchange(
        self,
        config: IngestionConfig,
        *,
        raw_event_sink: Any,
        lifecycle_sink: Any,
    ) -> _FakeExchange:
        del config
        self.create_calls += 1
        self.exchange = _FakeExchange(
            raw_event_sink,
            lifecycle_sink,
            fail_load=self.create_calls <= self.load_failures,
        )
        return self.exchange

    def resolve_symbol(
        self,
        exchange: _FakeExchange,
        descriptor: StreamDescriptor,
    ) -> str:
        del exchange, descriptor
        return "BTC/USDT:USDT"

    async def watch(
        self,
        exchange: _FakeExchange,
        descriptor: StreamDescriptor,
        ccxt_symbol: str,
    ) -> None:
        del descriptor, ccxt_symbol
        event = await exchange.watch_queue.get()
        if isinstance(event, BaseException):
            raise event
        exchange.raw_sink(event)

    def matches(
        self,
        event: CcxtRawMarketEvent,
        descriptor: StreamDescriptor,
    ) -> bool:
        return event.channel == "aggTrade" and event.symbol == descriptor.symbol

    def runtime_key(self, config: IngestionConfig) -> tuple[str, ...]:
        del config
        return (self.exchange_id, self.market_type)


def _agg_descriptor() -> StreamDescriptor:
    return StreamDescriptor(
        "BTCUSDT",
        StreamType.AGG_TRADE,
        market_type="futures",
    )


def _agg_event(sequence: int = 10) -> CcxtRawMarketEvent:
    return CcxtRawMarketEvent(
        channel="aggTrade",
        symbol="BTCUSDT",
        payload={
            "e": "aggTrade",
            "E": 1_700_000_000_010,
            "s": "BTCUSDT",
            "a": sequence,
            "p": "64000",
            "q": "0.1",
            "f": sequence,
            "l": sequence,
            "T": 1_700_000_000_009,
            "m": False,
        },
        received_at_ms=1_700_000_000_011,
    )


def test_binance_ccxt_provider_is_default_off_and_narrowly_scoped() -> None:
    plugin = BinancePlugin()
    descriptor = _agg_descriptor()

    assert plugin.supports_provider_stream(descriptor) is True
    assert plugin.create_stream_session(IngestionConfig(), descriptor) is None

    enabled = IngestionConfig(ccxt_stream_enabled=True)
    session = plugin.create_stream_session(enabled, descriptor)
    assert isinstance(session, CcxtProviderSession)
    assert session.feed_mode == FeedMode.PLUGIN_STREAM
    assert session.http_fallback_health_states == frozenset({SessionHealth.UNHEALTHY})

    spot = StreamDescriptor("BTCUSDT", StreamType.AGG_TRADE)
    assert plugin.supports_provider_stream(spot) is False


def test_generic_hook_captures_decoded_envelope_before_projection() -> None:
    raw = []
    lifecycle = []
    hooked_class = build_hooked_exchange_class(
        _UpstreamExchange,
        exchange_id="okx",
        market_type="swap",
        supported_ccxt_version="test-only",
    )
    exchange = hooked_class(
        {"newUpdates": True},
        raw_event_sink=raw.append,
        lifecycle_sink=lifecycle.append,
        enforce_version=False,
    )
    payload = {
        "arg": {"channel": "books", "instId": "BTC-USDT-SWAP"},
        "data": [{"seqId": "123", "bids": [], "asks": []}],
    }

    assert exchange.handle_message(_Client(), payload) == "projected"
    exchange.on_connected(_Client())
    exchange.on_close(_Client(), RuntimeError("network"))

    assert raw[0].payload == payload
    assert raw[0].channel == "books"
    assert raw[0].symbol == "BTC-USDT-SWAP"
    assert raw[0].exchange == "okx"
    assert raw[0].market_type == "swap"
    assert [event.state for event in lifecycle] == ["connected", "disconnected"]


def test_binance_profile_routes_only_exact_raw_channel_and_symbol() -> None:
    profile = BinanceUsdmCcxtProfile()
    descriptor = _agg_descriptor()

    assert profile.matches(_agg_event(), descriptor) is True
    wrong_channel = _agg_event()
    wrong_channel = CcxtRawMarketEvent(
        channel="depth",
        symbol=wrong_channel.symbol,
        payload=wrong_channel.payload,
        received_at_ms=wrong_channel.received_at_ms,
    )
    assert profile.matches(wrong_channel, descriptor) is False
    wrong_symbol = _agg_event()
    wrong_symbol = CcxtRawMarketEvent(
        channel=wrong_symbol.channel,
        symbol="ETHUSDT",
        payload=wrong_symbol.payload,
        received_at_ms=wrong_symbol.received_at_ms,
    )
    assert profile.matches(wrong_symbol, descriptor) is False

    kline_descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.KLINE,
        interval="1m",
        market_type="futures",
    )
    wrong_interval = CcxtRawMarketEvent(
        channel="kline",
        symbol="BTCUSDT",
        payload={"e": "kline", "s": "BTCUSDT", "k": {"i": "5m"}},
        received_at_ms=1,
    )
    assert profile.matches(wrong_interval, kline_descriptor) is False


def test_runtime_rejects_ambiguous_depth_update_speeds() -> None:
    async def run() -> None:
        pool = CcxtRuntimePool()
        profile = _FakeProfile()
        runtime = await pool.acquire(profile, IngestionConfig())
        first = StreamDescriptor(
            "BTCUSDT",
            StreamType.FULL_DEPTH,
            market_type="futures",
            update_interval_ms=100,
        )
        second = StreamDescriptor(
            "BTCUSDT",
            StreamType.FULL_DEPTH,
            market_type="futures",
            update_interval_ms=250,
        )
        runtime.subscribe(first, lambda _event: None, lambda _event: None)

        try:
            runtime.subscribe(second, lambda _event: None, lambda _event: None)
        except RuntimeError as exc:
            assert "ambiguous" in str(exc)
        else:
            raise AssertionError("ambiguous raw depth routing was accepted")
        await pool.release(runtime)

    asyncio.run(run())


def test_runtime_pool_shares_one_exchange_and_closes_at_last_release() -> None:
    async def run() -> None:
        pool = CcxtRuntimePool()
        profile = _FakeProfile()
        config = IngestionConfig()

        first, second = await asyncio.gather(
            pool.acquire(profile, config),
            pool.acquire(profile, config),
        )

        assert first is second
        assert profile.create_calls == 1
        assert profile.exchange is not None
        assert profile.exchange.load_calls == 1
        assert pool.snapshot()["runtimes"]["fake|futures"]["references"] == 2

        await pool.release(first)
        assert profile.exchange.close_calls == 0
        assert profile.close_calls == 0
        await pool.release(second)
        assert profile.exchange.close_calls == 1
        assert profile.close_calls == 1
        assert pool.snapshot() == {"runtimes": {}}

    asyncio.run(run())


def test_runtime_pool_bounds_okx_kline_descriptors_per_shard(monkeypatch) -> None:
    async def run() -> None:
        from app.core import config as app_config

        monkeypatch.setattr(app_config, "KLINE_UPSTREAM_MAX_DESCRIPTORS_PER_SHARD", 2)
        pool = CcxtRuntimePool()
        profile = _FakeProfile()
        profile.exchange_id = "okx"
        profile.market_type = "spot"
        config = IngestionConfig()

        def descriptor(symbol: str) -> StreamDescriptor:
            return StreamDescriptor(
                symbol,
                StreamType.KLINE,
                interval="1m",
                exchange="okx",
                market_type="spot",
            )

        btc = descriptor("BTC-USDT")
        eth = descriptor("ETH-USDT")
        sol = descriptor("SOL-USDT")
        first = await pool.acquire(profile, config, btc)
        same_shard = await pool.acquire(profile, config, eth)
        second = await pool.acquire(profile, config, sol)

        assert first is same_shard
        assert second is not first
        snapshot = pool.snapshot()["runtimes"]
        assert sorted(value["descriptor_count"] for value in snapshot.values()) == [1, 2]
        assert sorted(value["shard_index"] for value in snapshot.values()) == [0, 1]

        await pool.release(first, btc)
        await pool.release(same_shard, eth)
        await pool.release(second, sol)
        assert pool.snapshot() == {"runtimes": {}}

    asyncio.run(run())


def test_runtime_pool_rebuilds_ccxt_caches_when_recycling_websockets() -> None:
    async def run() -> None:
        pool = CcxtRuntimePool()
        profile = _FakeProfile()
        runtime = await pool.acquire(profile, IngestionConfig())
        assert profile.exchange is not None

        recycled = await pool.recycle_all_websockets()

        assert recycled == {"fake|futures": 1}
        assert profile.exchange.recycle_calls == 1
        assert profile.exchange.clean_ws_calls == 1
        assert profile.exchange.close_calls == 0
        assert profile.exchange.load_calls == 1
        assert runtime.snapshot()["websocket_recycles"] == 1
        assert runtime.snapshot()["websocket_generation"] == 1
        assert profile.close_calls == 1
        await pool.release(runtime)
        assert profile.exchange.close_calls == 1
        assert profile.close_calls == 2

    asyncio.run(run())


def test_provider_session_forwards_raw_payload_without_ccxt_projection() -> None:
    async def run() -> None:
        pool = CcxtRuntimePool()
        profile = _FakeProfile()
        session = CcxtProviderSession(
            config=IngestionConfig(
                ccxt_stream_enabled=True,
                ws_stale_timeout=1.0,
            ),
            descriptor=_agg_descriptor(),
            profile=profile,
            pool=pool,
        )
        messages = []
        health = []

        async def on_message(message: Any) -> None:
            messages.append(message)

        async def on_health(state: SessionHealth, reason: str) -> None:
            health.append((state, reason))

        session.on_message(on_message)
        session.on_health_change(on_health)
        await session.start()
        await _wait_until(lambda: profile.exchange is not None)
        assert profile.exchange is not None
        await profile.exchange.watch_queue.put(_agg_event(123))

        deadline = time.monotonic() + 1.0
        while not messages and time.monotonic() < deadline:
            await asyncio.sleep(0.01)

        assert messages[0].payload["a"] == 123
        assert messages[0].payload["f"] == 123
        assert messages[0].source == DataSource.WEBSOCKET
        assert messages[0].endpoint == "ccxt+ws://fake"
        assert any(state == SessionHealth.CONNECTED for state, _ in health)

        await session.stop()
        assert session.health == SessionHealth.DISCONNECTED
        assert profile.exchange.close_calls == 1

    asyncio.run(run())


def test_provider_session_reports_unhealthy_then_recovers_after_watch_failures() -> (
    None
):
    async def run() -> None:
        pool = CcxtRuntimePool()
        profile = _FakeProfile()
        session = CcxtProviderSession(
            config=IngestionConfig(
                ccxt_stream_enabled=True,
                ws_consecutive_failure_threshold=2,
                ws_reconnect_delay_initial=0.001,
                ws_reconnect_delay_max=0.001,
                ws_stale_timeout=1.0,
            ),
            descriptor=_agg_descriptor(),
            profile=profile,
            pool=pool,
        )
        health: list[SessionHealth] = []

        async def on_health(state: SessionHealth, reason: str) -> None:
            del reason
            health.append(state)

        async def on_message(message: Any) -> None:
            del message

        session.on_health_change(on_health)
        session.on_message(on_message)
        await session.start()
        await _wait_until(lambda: profile.exchange is not None)
        assert profile.exchange is not None
        await profile.exchange.watch_queue.put(RuntimeError("disconnect-1"))
        await profile.exchange.watch_queue.put(RuntimeError("disconnect-2"))
        await profile.exchange.watch_queue.put(_agg_event(100))

        deadline = time.monotonic() + 1.0
        while SessionHealth.CONNECTED not in health and time.monotonic() < deadline:
            await asyncio.sleep(0.01)

        assert SessionHealth.RECONNECTING in health
        assert SessionHealth.UNHEALTHY in health
        assert health[-1] == SessionHealth.CONNECTED
        assert session.snapshot()["consecutive_failures"] == 0
        await session.stop()

    asyncio.run(run())


def test_provider_session_reconnects_when_ccxt_subscription_future_is_cancelled() -> (
    None
):
    async def run() -> None:
        pool = CcxtRuntimePool()
        profile = _FakeProfile()
        session = CcxtProviderSession(
            config=IngestionConfig(
                ccxt_stream_enabled=True,
                ws_reconnect_delay_initial=0.001,
                ws_reconnect_delay_max=0.001,
                ws_stale_timeout=1.0,
            ),
            descriptor=_agg_descriptor(),
            profile=profile,
            pool=pool,
        )
        health: list[SessionHealth] = []
        messages = []

        async def on_health(state: SessionHealth, reason: str) -> None:
            del reason
            health.append(state)

        async def on_message(message: Any) -> None:
            messages.append(message)

        session.on_health_change(on_health)
        session.on_message(on_message)
        await session.start()
        await _wait_until(lambda: profile.exchange is not None)
        assert profile.exchange is not None
        await profile.exchange.watch_queue.put(asyncio.CancelledError())
        await profile.exchange.watch_queue.put(_agg_event(300))
        await _wait_until(lambda: bool(messages))

        assert SessionHealth.RECONNECTING in health
        assert health[-1] == SessionHealth.CONNECTED
        assert session.snapshot()["metrics"]["counters"]["watch_cancellations"] == 1
        assert session.snapshot()["metrics"]["counters"]["runtime_rebuilds"] == 1
        await session.stop()

    asyncio.run(run())


def test_provider_session_recovers_from_runtime_startup_failure() -> None:
    async def run() -> None:
        profile = _FakeProfile(load_failures=1)
        session = CcxtProviderSession(
            config=IngestionConfig(
                ccxt_stream_enabled=True,
                ws_consecutive_failure_threshold=1,
                ws_reconnect_delay_initial=0.001,
                ws_reconnect_delay_max=0.001,
                ws_stale_timeout=1.0,
            ),
            descriptor=_agg_descriptor(),
            profile=profile,
            pool=CcxtRuntimePool(),
        )
        health: list[SessionHealth] = []

        async def on_health(state: SessionHealth, reason: str) -> None:
            del reason
            health.append(state)

        async def on_message(message: Any) -> None:
            del message

        session.on_health_change(on_health)
        session.on_message(on_message)
        await session.start()
        await _wait_until(lambda: profile.create_calls >= 2)
        assert profile.exchange is not None
        await profile.exchange.watch_queue.put(_agg_event(200))
        await _wait_until(lambda: SessionHealth.CONNECTED in health)

        assert SessionHealth.UNHEALTHY in health
        assert health[-1] == SessionHealth.CONNECTED
        assert profile.create_calls == 2
        await session.stop()

    asyncio.run(run())


def test_raw_queue_overflow_is_observable_and_never_silent() -> None:
    session = CcxtProviderSession(
        config=IngestionConfig(ccxt_raw_queue_size=1),
        descriptor=_agg_descriptor(),
        profile=_FakeProfile(),
        pool=CcxtRuntimePool(),
    )

    session._enqueue_raw(_agg_event(1))
    session._enqueue_raw(_agg_event(2))

    snapshot = session.snapshot()
    assert snapshot["overflowed"] is True
    assert snapshot["metrics"]["counters"]["raw_queue_overflows"] == 1


def test_lifecycle_observation_does_not_claim_stream_health() -> None:
    session = CcxtProviderSession(
        config=IngestionConfig(),
        descriptor=_agg_descriptor(),
        profile=_FakeProfile(),
        pool=CcxtRuntimePool(),
    )
    session._observe_lifecycle(
        CcxtLifecycleEvent(
            state="disconnected",
            url="wss://example.test/ws",
            observed_at_ms=1,
            error="network",
        )
    )

    assert session.health == SessionHealth.DISCONNECTED
    assert session.snapshot()["last_lifecycle"] == "disconnected"


async def _wait_until(predicate: Any, timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    assert predicate()
