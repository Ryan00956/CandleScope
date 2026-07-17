from __future__ import annotations

import asyncio

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.factory import ExchangeIngestionFactory
from app.data_engine.ingestion.feed_control import FeedControlLayer
from app.data_engine.ingestion.models import (
    FeedMode,
    SessionHealth,
    StreamDescriptor,
    StreamType,
)


class _Transport:
    def supports_ws(self, descriptor: StreamDescriptor) -> bool:
        return True

    async def http_fetch(self, request: object) -> list[object]:
        return []

    async def ws_probe(self, descriptor: StreamDescriptor) -> bool:
        return False


class _Session:
    def __init__(self) -> None:
        self._health = SessionHealth.DISCONNECTED
        self._on_message = None
        self._on_health = None
        self.started = 0
        self.stopped = 0

    @property
    def health(self) -> SessionHealth:
        return self._health

    @property
    def manages_recovery_while_http(self) -> bool:
        return False

    @property
    def http_fallback_health_states(self) -> frozenset[SessionHealth]:
        return frozenset({SessionHealth.UNHEALTHY})

    def on_message(self, callback) -> None:
        self._on_message = callback

    def on_health_change(self, callback) -> None:
        self._on_health = callback

    async def start(self) -> None:
        self.started += 1

    async def stop(self) -> None:
        self.stopped += 1

    def snapshot(self) -> dict[str, str]:
        return {"health": self._health.value}

    async def emit(self, health: SessionHealth, reason: str) -> None:
        self._health = health
        assert self._on_health is not None
        await self._on_health(health, reason)


def test_feed_control_fans_out_break_health_without_replacing_l3_handler() -> None:
    async def _run() -> None:
        session = _Session()
        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.FULL_DEPTH,
            exchange="binance",
            market_type="futures",
            update_interval_ms=100,
        )
        feed = FeedControlLayer(
            IngestionConfig(http_poll_interval=30, ws_probe_interval=30),
            _Transport(),  # type: ignore[arg-type]
            descriptor,
            session_factory=lambda: session,
        )
        first: list[tuple[SessionHealth, str]] = []
        second: list[tuple[SessionHealth, str]] = []

        async def _first(health: SessionHealth, reason: str) -> None:
            first.append((health, reason))

        async def _second(health: SessionHealth, reason: str) -> None:
            second.append((health, reason))

        feed.on_health_change(_first)
        feed.on_health_change(_second)
        feed.on_health_change(_first)
        await feed.start()

        for health in (
            SessionHealth.RECONNECTING,
            SessionHealth.UNHEALTHY,
            SessionHealth.DISCONNECTED,
        ):
            await session.emit(health, f"test-{health.value}")

        expected = [
            (health, f"test-{health.value}")
            for health in (
                SessionHealth.RECONNECTING,
                SessionHealth.UNHEALTHY,
                SessionHealth.DISCONNECTED,
            )
        ]
        assert first == expected
        assert second == expected
        assert feed.mode is FeedMode.WEBSOCKET
        assert feed.snapshot()["health_observers"] == 2
        await feed.stop()

    asyncio.run(_run())


def test_health_observer_failure_isolated_from_other_observers_and_l3_failover() -> None:
    async def _run() -> None:
        session = _Session()
        feed = FeedControlLayer(
            IngestionConfig(http_poll_interval=30, ws_probe_interval=30),
            _Transport(),  # type: ignore[arg-type]
            StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m"),
            session_factory=lambda: session,
        )
        delivered: list[tuple[SessionHealth, str]] = []

        async def _broken(_health: SessionHealth, _reason: str) -> None:
            raise RuntimeError("observer failed")

        async def _healthy(health: SessionHealth, reason: str) -> None:
            delivered.append((health, reason))

        feed.on_health_change(_broken)
        feed.on_health_change(_healthy)
        await feed.start()
        await session.emit(SessionHealth.UNHEALTHY, "socket lost")

        assert delivered == [(SessionHealth.UNHEALTHY, "socket lost")]
        assert feed.mode is FeedMode.HTTP_POLL
        assert session.stopped == 1
        metrics = feed.metrics.snapshot()["counters"]
        assert metrics["health_observer_errors"] == 1
        assert metrics["health_observer_notifications"] == 1
        await feed.stop()

    asyncio.run(_run())


def test_factory_registers_health_on_new_and_reused_market_pipeline() -> None:
    class _Delivery:
        def __init__(self) -> None:
            self.events: list[object] = []
            self.gaps: list[object] = []

        def on_market_event(self, callback: object) -> None:
            self.events.append(callback)

        def on_gap(self, callback: object) -> None:
            self.gaps.append(callback)

    class _Pipeline:
        def __init__(self) -> None:
            self.delivery = _Delivery()
            self.health: list[object] = []

        def on_health_change(self, callback: object) -> None:
            if callback not in self.health:
                self.health.append(callback)

    class _Ingress:
        def __init__(self) -> None:
            self.pipeline: _Pipeline | None = None
            self.add_calls = 0
            self.health_received_by_add: object | None = None

        def get_pipeline(self, key: str) -> _Pipeline | None:
            return self.pipeline

        async def add_stream(
            self,
            descriptor: StreamDescriptor,
            *,
            on_health: object | None = None,
        ) -> _Pipeline:
            self.add_calls += 1
            self.health_received_by_add = on_health
            self.pipeline = _Pipeline()
            if on_health is not None:
                self.pipeline.on_health_change(on_health)
            return self.pipeline

    async def _run() -> None:
        factory = ExchangeIngestionFactory()
        ingress = _Ingress()
        factory._ingress = ingress  # type: ignore[assignment]
        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.FULL_DEPTH,
            exchange="binance",
            market_type="futures",
            update_interval_ms=100,
        )

        async def _event_one(_event: object) -> None:
            return None

        async def _event_two(_event: object) -> None:
            return None

        async def _health_one(_health: SessionHealth, _reason: str) -> None:
            return None

        async def _health_two(_health: SessionHealth, _reason: str) -> None:
            return None

        await factory.start_market(
            descriptor,
            _event_one,
            on_health=_health_one,
        )
        await factory.start_market(
            descriptor,
            _event_two,
            on_health=_health_two,
        )

        assert ingress.add_calls == 1
        assert ingress.health_received_by_add is _health_one
        assert ingress.pipeline is not None
        assert ingress.pipeline.health == [_health_one, _health_two]
        assert ingress.pipeline.delivery.events == [_event_one, _event_two]

    asyncio.run(_run())
