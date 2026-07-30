"""
L2: Session Layer — WebSocket session lifecycle management.

Responsibilities:
  * Maintain a single WS connection for a stream (via StreamDescriptor)
  * Auto-reconnect with exponential backoff on disconnect
  * Heartbeat / staleness detection (no msg for N seconds → reconnect)
  * Track consecutive failures; when threshold exceeded → report UNHEALTHY
  * Forward raw JSON messages upward as ``RawMessage``

This layer does NOT decide whether to switch to HTTP — that's L3's job.
It simply reports its health status and keeps trying to reconnect.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Callable, Awaitable

from websockets.asyncio.client import ClientConnection
from websockets.exceptions import ConnectionClosed

from app.exchanges.ws_protocol import WsConnectionContext

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import StreamDescriptor, SessionHealth, DataSource, FeedMode, RawMessage
from .session_types import HealthCallback
from .transport import TransportLayer, TransportError

logger = logging.getLogger("ingestion.L2_Session")

class SessionLayer:
    """Manages a single WS session with reconnect and health tracking."""

    def __init__(
        self,
        config: IngestionConfig,
        transport: TransportLayer,
        descriptor: StreamDescriptor,
    ) -> None:
        self._cfg = config
        self._transport = transport
        self._descriptor = descriptor

        self._metrics = LayerMetrics("L2_Session")
        self._health = SessionHealth.DISCONNECTED
        self._conn: ClientConnection | None = None
        self._ws_context: WsConnectionContext | None = None

        # Reconnect state
        self._consecutive_failures = 0
        self._current_delay = self._cfg.ws_reconnect_delay_initial

        # Staleness detection
        self._last_msg_time: float = 0.0

        # Tasks
        self._read_task: asyncio.Task | None = None
        self._stale_task: asyncio.Task | None = None
        self._running = False

        # Callbacks
        self._on_message: Callable[[RawMessage], Awaitable[None]] | None = None
        self._on_health_change: HealthCallback | None = None

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    @property
    def health(self) -> SessionHealth:
        return self._health

    @property
    def feed_mode(self) -> FeedMode:
        return FeedMode.WEBSOCKET

    @property
    def manages_recovery_while_http(self) -> bool:
        return False

    @property
    def http_fallback_health_states(self) -> frozenset[SessionHealth]:
        return frozenset({SessionHealth.UNHEALTHY})

    @property
    def consecutive_failures(self) -> int:
        return self._consecutive_failures

    def snapshot(self) -> dict:
        return {
            "layer": "L2_Session",
            "stream_key": self._descriptor.key,
            "health": self._health.value,
            "consecutive_failures": self._consecutive_failures,
            "last_msg_time": self._last_msg_time,
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Register callbacks ───────────────────────────

    def on_message(self, callback: Callable[[RawMessage], Awaitable[None]]) -> None:
        """Register callback for each incoming WS message (called by L3/L4)."""
        self._on_message = callback

    def on_health_change(self, callback: HealthCallback) -> None:
        """Register callback for health status changes (called by L3)."""
        self._on_health_change = callback

    # ── Public: Lifecycle ────────────────────────────────────

    async def start(self) -> None:
        """Start the session — connect and begin reading."""
        if self._running:
            return
        self._running = True
        self._read_task = asyncio.create_task(
            self._run_loop(),
            name=f"session_{self._descriptor.key}",
        )
        logger.info("Session started: %s", self._descriptor.key)

    async def stop(self) -> None:
        """Gracefully stop the session."""
        self._running = False
        current = asyncio.current_task()
        if self._stale_task and not self._stale_task.done():
            self._stale_task.cancel()
        if self._read_task and not self._read_task.done():
            if current is self._read_task:
                await self._close_conn()
                await self._set_health(SessionHealth.DISCONNECTED, "stopped")
                logger.info("Session stopped: %s", self._descriptor.key)
                return
            self._read_task.cancel()
            try:
                await self._read_task
            except asyncio.CancelledError:
                pass
        await self._close_conn()
        await self._set_health(SessionHealth.DISCONNECTED, "stopped")
        logger.info("Session stopped: %s", self._descriptor.key)

    # ── Internal: Main loop ──────────────────────────────────

    async def _run_loop(self) -> None:
        """Core loop: connect → read messages → on disconnect, reconnect."""
        while self._running:
            try:
                await self._connect()
                if self._conn is None:
                    # Connection failed — wait before retry
                    await self._backoff_wait()
                    continue

                # Reset failure count on successful connect
                self._consecutive_failures = 0
                self._current_delay = self._cfg.ws_reconnect_delay_initial
                await self._set_health(SessionHealth.CONNECTED, "connected")
                self._metrics.inc("sessions_established")

                # Start staleness monitor
                self._last_msg_time = time.monotonic()
                self._stale_task = asyncio.create_task(self._stale_monitor())

                # Read loop
                await self._read_messages()

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Unexpected error in session loop: %s", exc, exc_info=True)
                self._metrics.inc("unexpected_errors")

            finally:
                # Clean up after disconnect
                if self._stale_task and not self._stale_task.done():
                    self._stale_task.cancel()
                    try:
                        await self._stale_task
                    except asyncio.CancelledError:
                        pass
                await self._close_conn()

            if not self._running:
                break

            # Count failure and decide health
            self._consecutive_failures += 1
            self._metrics.inc("reconnect_attempts")
            self._metrics.set("consecutive_failures", self._consecutive_failures)
            logger.info(
                "Session disconnected (%s), failure #%d",
                self._descriptor.key, self._consecutive_failures,
            )

            if self._consecutive_failures >= self._cfg.ws_consecutive_failure_threshold:
                await self._set_health(
                    SessionHealth.UNHEALTHY,
                    f"exceeded threshold ({self._consecutive_failures} consecutive failures)",
                )
            else:
                await self._set_health(SessionHealth.RECONNECTING, "reconnecting")

            await self._backoff_wait()

    # ── Internal: Connect ────────────────────────────────────

    async def _connect(self) -> None:
        await self._set_health(SessionHealth.CONNECTING, "connecting")
        try:
            self._ws_context = await self._transport.ws_connect(self._descriptor)
            await self._transport.ws_subscribe(self._ws_context)
            self._conn = self._ws_context.connection
        except TransportError as exc:
            logger.warning(
                "All WS endpoints failed for %s: %s",
                self._descriptor.key, exc,
            )
            self._ws_context = None
            self._conn = None

    # ── Internal: Read messages ──────────────────────────────

    async def _read_messages(self) -> None:
        """Read from WS until disconnected or stopped."""
        assert self._conn is not None
        try:
            if self._ws_context is not None and self._ws_context.prefetched_payloads:
                prefetched = list(self._ws_context.prefetched_payloads)
                self._ws_context.prefetched_payloads.clear()
                for payload in prefetched:
                    await self._handle_payload(payload)

            async for raw_msg in self._conn:
                if not self._running:
                    break
                await self._handle_payload(raw_msg)

        except ConnectionClosed as exc:
            self._metrics.inc("ws_disconnects")
            self._metrics.mark("last_disconnect_at")
            logger.info(
                "WS closed (%s): code=%s reason=%s",
                self._descriptor.key, exc.code, exc.reason,
            )

    # ── Internal: Staleness monitor ──────────────────────────

    async def _stale_monitor(self) -> None:
        """Periodically check if the connection has gone stale."""
        try:
            while self._running and self._conn is not None:
                await asyncio.sleep(self._cfg.ws_stale_timeout / 2)
                elapsed = time.monotonic() - self._last_msg_time
                if elapsed >= self._cfg.ws_stale_timeout:
                    logger.warning(
                        "WS stale (%s): no message for %.1fs, forcing reconnect",
                        self._descriptor.key, elapsed,
                    )
                    self._metrics.inc("stale_disconnects")
                    await self._close_conn()
                    break
        except asyncio.CancelledError:
            pass

    # ── Internal: Connection cleanup ─────────────────────────

    async def _close_conn(self) -> None:
        if self._conn is not None:
            try:
                if self._ws_context is not None:
                    await self._transport.ws_unsubscribe(self._ws_context)
                # Timeout prevents hanging on WS close handshake during
                # shutdown — the server may not respond to close frames
                # promptly, and this runs in a finally block where even
                # task cancellation cannot interrupt it.
                await asyncio.wait_for(self._conn.close(), timeout=2)
            except (asyncio.TimeoutError, Exception):
                pass
            self._conn = None
            self._ws_context = None

    async def _handle_payload(self, raw_msg) -> None:
        self._last_msg_time = time.monotonic()
        self._metrics.inc("messages_received")
        self._metrics.mark("last_message_at")

        try:
            data = json.loads(raw_msg) if isinstance(raw_msg, (str, bytes)) else raw_msg
        except (json.JSONDecodeError, TypeError):
            self._metrics.inc("messages_malformed")
            logger.warning("Malformed WS message: %s", str(raw_msg)[:200])
            return

        msg = RawMessage(
            payload=data,
            source=DataSource.WEBSOCKET,
            stream_type=self._descriptor.stream_type,
            received_at_ms=int(time.time() * 1000),
            endpoint=self._ws_context.endpoint if self._ws_context else self._transport.current_ws_base,
        )

        if self._on_message:
            try:
                await self._on_message(msg)
            except Exception as exc:
                logger.error("on_message callback error: %s", exc, exc_info=True)
                self._metrics.inc("callback_errors")

    # ── Internal: Backoff ────────────────────────────────────

    async def _backoff_wait(self) -> None:
        delay = min(self._current_delay, self._cfg.ws_reconnect_delay_max)
        logger.debug("Backoff: waiting %.1fs before reconnect", delay)
        self._metrics.set("backoff_delay", delay)
        await asyncio.sleep(delay)
        # Exponential backoff: double delay each time, capped at max
        self._current_delay = min(self._current_delay * 2, self._cfg.ws_reconnect_delay_max)

    # ── Internal: Health transition ──────────────────────────

    async def _set_health(self, new_health: SessionHealth, reason: str) -> None:
        if new_health == self._health:
            return
        old = self._health
        self._health = new_health
        self._metrics.set("health", new_health.value)
        self._metrics.mark("health_changed_at")
        logger.info("Session health: %s → %s (%s)", old.value, new_health.value, reason)
        if self._on_health_change:
            try:
                await self._on_health_change(new_health, reason)
            except Exception as exc:
                logger.error("Health-change callback raised: %s", exc, exc_info=exc)
