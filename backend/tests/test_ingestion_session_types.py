from __future__ import annotations

import asyncio

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.feed_control import FeedControlLayer
from app.data_engine.ingestion import MarketDataIngress
from app.data_engine.ingestion.models import (
    DataSource,
    FeedMode,
    RawMessage,
    SessionHealth,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.ingestion.session import SessionLayer
from app.data_engine.ingestion.shared_ws import SharedWsHubRegistry, SharedWsSessionAdapter
from app.data_engine.ingestion.transport import TransportLayer


class _FakeTransport:
    def __init__(self) -> None:
        self.ws_probes = 0

    def supports_ws(self, descriptor: StreamDescriptor) -> bool:
        return True

    async def http_fetch(self, req):
        return []

    async def ws_probe(self, descriptor: StreamDescriptor) -> bool:
        self.ws_probes += 1
        return True


class _FakeSession:
    def __init__(
        self,
        *,
        manages_recovery: bool = False,
        fallback_states: frozenset[SessionHealth] | None = None,
    ) -> None:
        self._health = SessionHealth.DISCONNECTED
        self._manages_recovery = manages_recovery
        self._fallback_states = fallback_states or frozenset({SessionHealth.UNHEALTHY})
        self.started = 0
        self.stopped = 0
        self._on_message = None
        self._on_health_change = None

    @property
    def health(self) -> SessionHealth:
        return self._health

    @property
    def manages_recovery_while_http(self) -> bool:
        return self._manages_recovery

    @property
    def http_fallback_health_states(self) -> frozenset[SessionHealth]:
        return self._fallback_states

    def on_message(self, callback) -> None:
        self._on_message = callback

    def on_health_change(self, callback) -> None:
        self._on_health_change = callback

    async def start(self) -> None:
        self.started += 1

    async def stop(self) -> None:
        self.stopped += 1

    def snapshot(self) -> dict:
        return {"health": self._health.value}

    async def emit_health(self, health: SessionHealth, reason: str = "test") -> None:
        self._health = health
        if self._on_health_change is not None:
            await self._on_health_change(health, reason)


def test_direct_session_unhealthy_switches_to_http_and_stops_session() -> None:
    async def _run() -> None:
        descriptor = StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
        session = _FakeSession()
        feed = FeedControlLayer(
            IngestionConfig(http_poll_interval=30, ws_probe_interval=30),
            _FakeTransport(),  # type: ignore[arg-type]
            descriptor,
            session_factory=lambda: session,
        )

        await feed.start()
        assert feed.mode == FeedMode.WEBSOCKET
        assert session.started == 1

        await session.emit_health(SessionHealth.UNHEALTHY)
        assert feed.mode == FeedMode.HTTP_POLL
        assert session.stopped == 1
        assert feed.session is None

        await feed.stop()

    asyncio.run(_run())


def test_shared_session_reconnecting_uses_http_without_stopping_session() -> None:
    async def _run() -> None:
        descriptor = StreamDescriptor(
            "BTC-USDT",
            StreamType.KLINE,
            interval="1m",
            exchange="okx",
        )
        session = _FakeSession(
            manages_recovery=True,
            fallback_states=frozenset({
                SessionHealth.RECONNECTING,
                SessionHealth.UNHEALTHY,
                SessionHealth.DISCONNECTED,
            }),
        )
        transport = _FakeTransport()
        feed = FeedControlLayer(
            IngestionConfig(http_poll_interval=30, ws_probe_interval=30),
            transport,  # type: ignore[arg-type]
            descriptor,
            session_factory=lambda: session,
        )

        await feed.start()
        await session.emit_health(SessionHealth.RECONNECTING)
        assert feed.mode == FeedMode.HTTP_POLL
        assert session.stopped == 0
        assert feed.session is session
        assert transport.ws_probes == 0

        await session.emit_health(SessionHealth.CONNECTED)
        assert feed.mode == FeedMode.WEBSOCKET
        assert session.stopped == 0

        await feed.stop()
        assert session.stopped == 1

    asyncio.run(_run())


def test_shared_ws_session_adapter_matches_session_contract() -> None:
    class _Handle:
        def __init__(self) -> None:
            self.unsubscribed = False

        async def unsubscribe(self) -> None:
            self.unsubscribed = True

    class _Hub:
        health = SessionHealth.DISCONNECTED
        consecutive_failures = 2

        def __init__(self) -> None:
            self.handle = _Handle()
            self.on_data = None
            self.on_health = None

        async def subscribe(self, descriptor, on_data, on_health):
            self.on_data = on_data
            self.on_health = on_health
            await on_health(SessionHealth.CONNECTED, "ready")
            return self.handle

    async def _run() -> None:
        descriptor = StreamDescriptor(
            "BTC-USDT",
            StreamType.KLINE,
            interval="1m",
            exchange="okx",
        )
        hub = _Hub()
        adapter = SharedWsSessionAdapter(hub, descriptor)  # type: ignore[arg-type]
        health_events: list[tuple[SessionHealth, str]] = []
        messages: list[RawMessage] = []

        async def _on_health(health: SessionHealth, reason: str) -> None:
            health_events.append((health, reason))

        async def _on_message(msg: RawMessage) -> None:
            messages.append(msg)

        adapter.on_health_change(_on_health)
        adapter.on_message(_on_message)

        await adapter.start()
        assert health_events == [(SessionHealth.CONNECTED, "ready")]
        assert adapter.health == SessionHealth.CONNECTED
        assert adapter.manages_recovery_while_http is True
        assert SessionHealth.RECONNECTING in adapter.http_fallback_health_states

        msg = RawMessage(
            payload={"arg": {"channel": "candle1m", "instId": "BTC-USDT"}},
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.KLINE,
            received_at_ms=1,
        )
        assert hub.on_data is not None
        await hub.on_data(msg)
        assert messages == [msg]

        snapshot = adapter.snapshot()
        assert snapshot["layer"] == "L2_SharedSession"
        assert snapshot["stream_key"] == "okx:BTC-USDT@kline_1m"
        assert snapshot["health"] == "connected"
        assert snapshot["consecutive_failures"] == 2

        await adapter.stop()
        assert hub.handle.unsubscribed is True

    asyncio.run(_run())


def test_shared_ws_hub_registry_uses_exchange_capabilities() -> None:
    registry = SharedWsHubRegistry(IngestionConfig(), TransportLayer(IngestionConfig()))

    okx_kline = StreamDescriptor(
        "BTC-USDT",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
    )
    okx_ticker = StreamDescriptor(
        "BTC-USDT",
        StreamType.TICKER,
        exchange="okx",
    )
    binance_kline = StreamDescriptor(
        "BTCUSDT",
        StreamType.KLINE,
        interval="1m",
        exchange="binance",
    )

    assert registry.get_hub(okx_kline) is not None
    assert registry.get_hub(okx_ticker) is None
    assert registry.get_hub(binance_kline) is None


def test_market_data_ingress_session_factory_follows_exchange_capabilities() -> None:
    ingress = MarketDataIngress(IngestionConfig())

    binance_kline = StreamDescriptor(
        "BTCUSDT",
        StreamType.KLINE,
        interval="1m",
        exchange="binance",
    )
    okx_kline = StreamDescriptor(
        "BTC-USDT",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
    )

    binance_factory = ingress._create_session_factory(binance_kline)
    okx_factory = ingress._create_session_factory(okx_kline)

    assert binance_factory is not None
    assert okx_factory is not None
    assert isinstance(binance_factory(), SessionLayer)
    assert isinstance(okx_factory(), SharedWsSessionAdapter)
