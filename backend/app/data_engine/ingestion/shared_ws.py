from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

from app.exchanges import bootstrap_default_adapters, get_exchange_registry

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import DataSource, RawMessage, SessionHealth, StreamDescriptor, StreamType
from .session_types import HealthCallback, MessageCallback, SessionLike
from .transport import TransportError, TransportLayer

logger = logging.getLogger("ingestion.shared_ws")

SharedDataCallback = Callable[[RawMessage], Awaitable[None]]
SharedHealthCallback = Callable[[SessionHealth, str], Awaitable[None]]


@dataclass(slots=True)
class _Subscriber:
    token: int
    descriptor: StreamDescriptor
    on_data: SharedDataCallback
    on_health: SharedHealthCallback


class SharedWsSubscriptionHandle:
    __slots__ = ("_hub", "_token", "_closed")

    def __init__(self, hub: "SharedMultiplexHub", token: int) -> None:
        self._hub = hub
        self._token = token
        self._closed = False

    async def unsubscribe(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._hub.unsubscribe(self._token)


class SharedWsSessionAdapter:
    """SessionLike adapter for a shared upstream WS hub."""

    def __init__(
        self,
        hub: "SharedMultiplexHub",
        descriptor: StreamDescriptor,
    ) -> None:
        self._hub = hub
        self._descriptor = descriptor
        self._metrics = LayerMetrics("L2_SharedSession")
        self._handle: SharedWsSubscriptionHandle | None = None
        self._health = hub.health
        self._last_msg_time = 0.0
        self._on_message: MessageCallback | None = None
        self._on_health_change: HealthCallback | None = None

    @property
    def health(self) -> SessionHealth:
        return self._health

    @property
    def manages_recovery_while_http(self) -> bool:
        return True

    @property
    def http_fallback_health_states(self) -> frozenset[SessionHealth]:
        return frozenset({
            SessionHealth.RECONNECTING,
            SessionHealth.UNHEALTHY,
            SessionHealth.DISCONNECTED,
        })

    def on_message(self, callback: MessageCallback) -> None:
        self._on_message = callback

    def on_health_change(self, callback: HealthCallback) -> None:
        self._on_health_change = callback

    async def start(self) -> None:
        if self._handle is not None:
            return
        self._handle = await self._hub.subscribe(
            self._descriptor,
            self._handle_data,
            self._handle_health,
        )
        self._metrics.mark("started_at")

    async def stop(self) -> None:
        if self._handle is not None:
            await self._handle.unsubscribe()
            self._handle = None
        self._metrics.mark("stopped_at")

    def snapshot(self) -> dict:
        return {
            "layer": "L2_SharedSession",
            "stream_key": self._descriptor.key,
            "health": self._health.value,
            "consecutive_failures": self._hub.consecutive_failures,
            "last_msg_time": self._last_msg_time,
            "metrics": self._metrics.snapshot(),
        }

    async def _handle_data(self, msg: RawMessage) -> None:
        self._last_msg_time = time.monotonic()
        self._metrics.inc("messages_received")
        self._metrics.mark("last_message_at")
        if self._on_message:
            await self._on_message(msg)

    async def _handle_health(self, health: SessionHealth, reason: str) -> None:
        self._health = health
        self._metrics.set("health", health.value)
        self._metrics.mark("health_changed_at")
        if self._on_health_change:
            await self._on_health_change(health, reason)


class SharedMultiplexHub:
    """One upstream WS connection shared by many stream subscribers."""

    def __init__(
        self,
        config: IngestionConfig,
        transport: TransportLayer,
        exchange: str,
        market_type: str,
        symbol: str,
    ) -> None:
        self._cfg = config
        self._transport = transport
        self._exchange = exchange
        self._market_type = market_type
        self._symbol = symbol.upper()

        bootstrap_default_adapters()
        self._plugin = get_exchange_registry().get_plugin(exchange)
        self._protocol = self._plugin.protocol()

        self._subscribers: dict[int, _Subscriber] = {}
        self._next_token = 1
        self._runner_task: asyncio.Task | None = None
        self._subscription_changed = asyncio.Event()
        self._conn = None
        self._ctx = None
        self._health = SessionHealth.DISCONNECTED
        self._current_delay = self._cfg.ws_reconnect_delay_initial
        self._consecutive_failures = 0

    @property
    def health(self) -> SessionHealth:
        return self._health

    @property
    def consecutive_failures(self) -> int:
        return self._consecutive_failures

    async def subscribe(
        self,
        descriptor: StreamDescriptor,
        on_data: SharedDataCallback,
        on_health: SharedHealthCallback,
    ) -> SharedWsSubscriptionHandle:
        token = self._next_token
        self._next_token += 1
        self._subscribers[token] = _Subscriber(
            token=token,
            descriptor=descriptor,
            on_data=on_data,
            on_health=on_health,
        )
        await self._notify_health_single(on_health, self._health, "subscribed")
        self._subscription_changed.set()
        self._ensure_runner()
        return SharedWsSubscriptionHandle(self, token)

    async def unsubscribe(self, token: int) -> None:
        removed = self._subscribers.pop(token, None)
        if removed is None:
            return
        self._subscription_changed.set()
        if not self._subscribers:
            await self._close_connection()
            if self._runner_task and not self._runner_task.done():
                self._runner_task.cancel()
                try:
                    await self._runner_task
                except asyncio.CancelledError:
                    pass
            self._runner_task = None
            await self._set_health(SessionHealth.DISCONNECTED, "no subscribers")

    def _ensure_runner(self) -> None:
        if self._runner_task is None or self._runner_task.done():
            self._runner_task = asyncio.create_task(
                self._run_loop(),
                name=f"{self._exchange}_shared_ws_{self._market_type}_{self._symbol}",
            )

    async def _run_loop(self) -> None:
        while self._subscribers:
            await self._wait_for_subscription_stabilize()
            if not self._subscribers:
                break

            descriptors = self._unique_descriptors()
            representative = descriptors[0]

            try:
                state = (
                    SessionHealth.RECONNECTING
                    if self._consecutive_failures > 0
                    else SessionHealth.CONNECTING
                )
                await self._set_health(state, "connecting")
                self._ctx = await self._transport.ws_connect(representative)
                self._conn = self._ctx.connection
                await self._send_combined_subscribe(descriptors)
                self._consecutive_failures = 0
                self._current_delay = self._cfg.ws_reconnect_delay_initial
                await self._set_health(SessionHealth.CONNECTED, "connected")
                await self._read_loop()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._consecutive_failures += 1
                state = (
                    SessionHealth.UNHEALTHY
                    if self._consecutive_failures >= self._cfg.ws_consecutive_failure_threshold
                    else SessionHealth.RECONNECTING
                )
                await self._set_health(state, str(exc))
                await self._close_connection()
                if not self._subscribers:
                    break
                delay = min(self._current_delay, self._cfg.ws_reconnect_delay_max)
                await asyncio.sleep(delay)
                self._current_delay = min(
                    self._current_delay * 2,
                    self._cfg.ws_reconnect_delay_max,
                )
            finally:
                await self._close_connection()

        await self._set_health(SessionHealth.DISCONNECTED, "stopped")

    async def _wait_for_subscription_stabilize(self) -> None:
        while True:
            self._subscription_changed.clear()
            await asyncio.sleep(0.2)
            if not self._subscription_changed.is_set():
                return

    def _unique_descriptors(self) -> list[StreamDescriptor]:
        by_key: dict[str, StreamDescriptor] = {}
        for sub in self._subscribers.values():
            by_key[sub.descriptor.key] = sub.descriptor
        return sorted(by_key.values(), key=lambda d: d.interval or "")

    async def _send_combined_subscribe(self, descriptors: list[StreamDescriptor]) -> None:
        if self._conn is None:
            raise TransportError("shared WS connection not ready")
        payload = self._protocol.build_combined_subscribe(descriptors)
        if not payload:
            raise TransportError(f"no {self._exchange} subscription payload available")
        await self._conn.send(json.dumps(payload))

    async def _read_loop(self) -> None:
        assert self._conn is not None
        while self._subscribers:
            if self._subscription_changed.is_set():
                return
            try:
                raw = await asyncio.wait_for(
                    self._conn.recv(),
                    timeout=self._cfg.ws_stale_timeout,
                )
            except asyncio.TimeoutError as exc:
                raise TransportError("shared WS stale") from exc

            payload = self._decode_payload(raw)
            if payload is None:
                continue

            if isinstance(payload, dict):
                event = str(payload.get("event", "")).lower()
                if event == "subscribe":
                    continue
                if event == "error":
                    raise TransportError(f"{self._exchange} WS subscription rejected: {payload}")

            await self._dispatch_payload(payload)

    def _decode_payload(self, raw) -> dict | list | None:
        try:
            return json.loads(raw) if isinstance(raw, (str, bytes)) else raw
        except (json.JSONDecodeError, TypeError):
            return None

    async def _dispatch_payload(self, payload: dict | list) -> None:
        if not isinstance(payload, dict):
            return

        now_ms = int(time.time() * 1000)
        matching = [
            sub for sub in self._subscribers.values()
            if self._protocol.payload_matches_descriptor(payload, sub.descriptor)
        ]
        for sub in matching:
            msg = RawMessage(
                payload=payload,
                source=DataSource.WEBSOCKET,
                stream_type=sub.descriptor.stream_type,
                received_at_ms=now_ms,
                endpoint=self._ctx.endpoint if self._ctx else "",
            )
            try:
                await sub.on_data(msg)
            except Exception as exc:
                logger.error("Shared WS callback error: %s", exc, exc_info=True)

    async def _set_health(self, new_health: SessionHealth, reason: str) -> None:
        if new_health == self._health:
            return
        self._health = new_health
        for sub in list(self._subscribers.values()):
            await self._notify_health_single(sub.on_health, new_health, reason)

    async def _notify_health_single(
        self,
        callback: SharedHealthCallback,
        health: SessionHealth,
        reason: str,
    ) -> None:
        try:
            await callback(health, reason)
        except Exception as exc:
            logger.error("Shared WS health callback error: %s", exc, exc_info=True)

    async def _close_connection(self) -> None:
        if self._conn is not None:
            try:
                await asyncio.wait_for(self._conn.close(), timeout=2)
            except Exception:
                pass
        self._conn = None
        self._ctx = None


class SharedWsHubRegistry:
    def __init__(self, config: IngestionConfig, transport: TransportLayer) -> None:
        self._cfg = config
        self._transport = transport
        self._hubs: dict[tuple[str, str, str], SharedMultiplexHub] = {}

    def get_hub(self, descriptor: StreamDescriptor) -> SharedMultiplexHub | None:
        bootstrap_default_adapters()
        plugin = get_exchange_registry().get_plugin(descriptor.exchange)
        if (
            plugin.capabilities().ws_connection_model != "shared_multiplex"
            or descriptor.stream_type != StreamType.KLINE
        ):
            return None
        key = (descriptor.exchange, descriptor.market_type, descriptor.symbol.upper())
        hub = self._hubs.get(key)
        if hub is None:
            hub = SharedMultiplexHub(
                config=self._cfg,
                transport=self._transport,
                exchange=descriptor.exchange,
                market_type=descriptor.market_type,
                symbol=descriptor.symbol,
            )
            self._hubs[key] = hub
        return hub

    def create_session(self, descriptor: StreamDescriptor) -> SessionLike | None:
        hub = self.get_hub(descriptor)
        if hub is None:
            return None
        return SharedWsSessionAdapter(hub, descriptor)


# Backward-compatible alias for tests and older imports.
OkxSharedKlineHub = SharedMultiplexHub
