"""
L3: Feed Control Layer — ensures data keeps flowing no matter what.

Responsibilities:
  * Primary path: WS via L2 Session
  * Fallback path: HTTP polling via L1 Transport when WS is UNHEALTHY
  * Periodically probe WS while in HTTP mode; switch back when healthy
  * Forward ``RawMessage`` upstream regardless of source
  * Expose current ``FeedMode`` for observability

Decision flow:
  1. Start with WS (via L2)
  2. L2 reports UNHEALTHY → switch to HTTP polling
  3. While polling HTTP, probe WS every ``ws_probe_interval`` seconds
  4. WS probe succeeds ``ws_probe_success_threshold`` times → stop HTTP, restart WS
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable, Awaitable

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import (
    StreamDescriptor,
    StreamType,
    FeedMode,
    SessionHealth,
    DataSource,
    RawMessage,
    TransportRequest,
)
from .transport import TransportLayer, TransportError
from .session import SessionLayer

logger = logging.getLogger("ingestion.L3_FeedControl")

# Stream types that have an HTTP REST fallback
_HTTP_FALLBACK_TYPES = {
    StreamType.KLINE,
    StreamType.AGG_TRADE,
    StreamType.TRADE,
    StreamType.TICKER,
    StreamType.MINI_TICKER,
    StreamType.DEPTH,
}


class FeedControlLayer:
    """Orchestrates WS / HTTP data sources for a single stream."""

    def __init__(
        self,
        config: IngestionConfig,
        transport: TransportLayer,
        descriptor: StreamDescriptor,
    ) -> None:
        self._cfg = config
        self._transport = transport
        self._descriptor = descriptor

        self._metrics = LayerMetrics("L3_FeedControl")
        self._mode = FeedMode.IDLE

        # L2 Session (created on start)
        self._session: SessionLayer | None = None

        # HTTP poll task + WS probe task
        self._http_poll_task: asyncio.Task | None = None
        self._ws_probe_task: asyncio.Task | None = None
        self._running = False

        # WS probe state
        self._ws_probe_successes = 0

        # Upstream callback — receives RawMessage from either WS or HTTP
        self._on_data: Callable[[RawMessage], Awaitable[None]] | None = None

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    @property
    def mode(self) -> FeedMode:
        return self._mode

    @property
    def session(self) -> SessionLayer | None:
        return self._session

    @property
    def descriptor(self) -> StreamDescriptor:
        return self._descriptor

    def snapshot(self) -> dict:
        return {
            "layer": "L3_FeedControl",
            "stream_key": self._descriptor.key,
            "mode": self._mode.value,
            "ws_probe_successes": self._ws_probe_successes,
            "metrics": self._metrics.snapshot(),
            "session": self._session.snapshot() if self._session else None,
        }

    # ── Public: Register callback ────────────────────────────

    def on_data(self, callback: Callable[[RawMessage], Awaitable[None]]) -> None:
        """Register upstream data callback (consumed by L4 Normalize)."""
        self._on_data = callback

    # ── Public: Lifecycle ────────────────────────────────────

    async def start(self) -> None:
        """Start the feed — begins with WS mode."""
        if self._running:
            return
        self._running = True
        self._metrics.mark("started_at")
        await self._switch_to_ws()
        logger.info("FeedControl started: %s", self._descriptor.key)

    async def stop(self) -> None:
        """Stop everything — WS session + HTTP polling + probes."""
        self._running = False
        await self._stop_http_poll()
        await self._stop_ws_probe()
        await self._stop_session()
        self._set_mode(FeedMode.IDLE)
        self._metrics.mark("stopped_at")
        logger.info("FeedControl stopped: %s", self._descriptor.key)

    # ── Mode switching ───────────────────────────────────────

    async def _switch_to_ws(self) -> None:
        """Activate WS mode via L2 Session."""
        await self._stop_http_poll()
        await self._stop_ws_probe()

        self._session = SessionLayer(
            config=self._cfg,
            transport=self._transport,
            descriptor=self._descriptor,
        )
        # Wire callbacks
        self._session.on_message(self._handle_ws_message)
        self._session.on_health_change(self._handle_health_change)

        await self._session.start()
        self._set_mode(FeedMode.WEBSOCKET)
        self._metrics.inc("ws_activations")
        logger.info("Switched to WS mode: %s", self._descriptor.key)

    async def _switch_to_http(self, reason: str) -> None:
        """Activate HTTP polling mode.  Session keeps running (L2 will keep
        trying to reconnect), but we don't rely on it for data."""
        if self._mode == FeedMode.HTTP_POLL:
            return  # already in HTTP mode

        # Check if this stream type supports HTTP fallback
        if self._descriptor.stream_type not in _HTTP_FALLBACK_TYPES:
            logger.warning(
                "No HTTP fallback for stream type %s, staying in WS mode",
                self._descriptor.stream_type,
            )
            return

        self._set_mode(FeedMode.HTTP_POLL)
        self._metrics.inc("http_activations")
        logger.warning(
            "Switched to HTTP poll mode (%s): %s",
            self._descriptor.key, reason,
        )

        # Start HTTP polling
        self._http_poll_task = asyncio.create_task(
            self._http_poll_loop(),
            name=f"http_poll_{self._descriptor.key}",
        )

        # Start WS probing (to detect when WS recovers)
        self._ws_probe_successes = 0
        self._ws_probe_task = asyncio.create_task(
            self._ws_probe_loop(),
            name=f"ws_probe_{self._descriptor.key}",
        )

    async def _switch_back_to_ws(self) -> None:
        """WS has recovered — switch back from HTTP to WS."""
        logger.info("WS recovered, switching back: %s", self._descriptor.key)
        self._metrics.inc("ws_recoveries")
        # Stop HTTP polling & probe
        await self._stop_http_poll()
        await self._stop_ws_probe()
        # Restart session (fresh connection)
        await self._stop_session()
        await self._switch_to_ws()

    # ── L2 Health callback ───────────────────────────────────

    async def _handle_health_change(self, health: SessionHealth, reason: str) -> None:
        """Called by L2 when WS health changes."""
        self._metrics.set("ws_health", health.value)
        self._metrics.mark("ws_health_changed_at")

        if health == SessionHealth.UNHEALTHY and self._mode == FeedMode.WEBSOCKET:
            await self._switch_to_http(reason)
        elif health == SessionHealth.CONNECTED and self._mode == FeedMode.HTTP_POLL:
            # L2 managed to reconnect on its own — switch back
            await self._stop_http_poll()
            await self._stop_ws_probe()
            self._set_mode(FeedMode.WEBSOCKET)
            self._metrics.inc("ws_recoveries")
            logger.info("WS self-recovered via L2: %s", self._descriptor.key)

    # ── WS message handler ───────────────────────────────────

    async def _handle_ws_message(self, msg: RawMessage) -> None:
        """Forward WS message upstream (only when in WS mode)."""
        if self._mode != FeedMode.WEBSOCKET:
            return  # ignore WS data while in HTTP fallback
        self._metrics.inc("ws_messages_forwarded")
        if self._on_data:
            await self._on_data(msg)

    # ── HTTP polling ─────────────────────────────────────────

    async def _http_poll_loop(self) -> None:
        """Periodically fetch latest data via HTTP REST API."""
        key = self._descriptor.key
        logger.info(
            "HTTP poll loop started: %s (interval=%.1fs)",
            key, self._cfg.http_poll_interval,
        )
        try:
            while self._running and self._mode == FeedMode.HTTP_POLL:
                try:
                    req = TransportRequest(
                        descriptor=self._descriptor,
                        limit=self._http_poll_limit(),
                    )
                    messages = await self._transport.http_fetch(req)
                    self._metrics.inc("http_polls")
                    self._metrics.mark("http_last_poll_at")

                    for msg in messages:
                        self._metrics.inc("http_messages_forwarded")
                        if self._on_data:
                            await self._on_data(msg)

                except TransportError as exc:
                    self._metrics.inc("http_poll_errors")
                    logger.warning("HTTP poll failed (%s): %s", key, exc)

                await asyncio.sleep(self._cfg.http_poll_interval)

        except asyncio.CancelledError:
            pass
        logger.info("HTTP poll loop ended: %s", key)

    def _http_poll_limit(self) -> int:
        """Determine sensible poll limit based on stream type."""
        st = self._descriptor.stream_type
        if st == StreamType.KLINE:
            return 2  # current + previous (for closed bar detection)
        if st in (StreamType.AGG_TRADE, StreamType.TRADE):
            return 20  # recent trades
        if st == StreamType.DEPTH:
            return self._descriptor.depth_levels or 20
        return 1  # ticker etc.

    # ── WS probing (while in HTTP mode) ──────────────────────

    async def _ws_probe_loop(self) -> None:
        """Periodically test WS connectivity while in HTTP fallback."""
        key = self._descriptor.key
        logger.info(
            "WS probe loop started: %s (every %.0fs)",
            key, self._cfg.ws_probe_interval,
        )
        try:
            while self._running and self._mode == FeedMode.HTTP_POLL:
                await asyncio.sleep(self._cfg.ws_probe_interval)

                ok = await self._transport.ws_probe(self._descriptor)
                self._metrics.inc("ws_probes")

                if ok:
                    self._ws_probe_successes += 1
                    self._metrics.inc("ws_probe_ok")
                    logger.info(
                        "WS probe OK (%d/%d)",
                        self._ws_probe_successes, self._cfg.ws_probe_success_threshold,
                    )
                    if self._ws_probe_successes >= self._cfg.ws_probe_success_threshold:
                        await self._switch_back_to_ws()
                        break
                else:
                    self._ws_probe_successes = 0
                    self._metrics.inc("ws_probe_failed")
                    logger.debug("WS probe failed, staying in HTTP mode")

        except asyncio.CancelledError:
            pass
        logger.info("WS probe loop ended: %s", key)

    # ── Teardown helpers ─────────────────────────────────────

    async def _stop_session(self) -> None:
        if self._session:
            await self._session.stop()
            self._session = None

    async def _stop_http_poll(self) -> None:
        if self._http_poll_task and not self._http_poll_task.done():
            self._http_poll_task.cancel()
            try:
                await self._http_poll_task
            except asyncio.CancelledError:
                pass
            self._http_poll_task = None

    async def _stop_ws_probe(self) -> None:
        if self._ws_probe_task and not self._ws_probe_task.done():
            # Guard: if the current task IS the probe task, we must not
            # cancel/await ourselves — that causes RuntimeError.
            current = asyncio.current_task()
            if current is self._ws_probe_task:
                # Let the probe loop exit naturally; just clear the reference.
                self._ws_probe_task = None
                return
            self._ws_probe_task.cancel()
            try:
                await self._ws_probe_task
            except asyncio.CancelledError:
                pass
            self._ws_probe_task = None

    # ── Mode tracking ────────────────────────────────────────

    def _set_mode(self, new_mode: FeedMode) -> None:
        if new_mode == self._mode:
            return
        old = self._mode
        self._mode = new_mode
        self._metrics.set("feed_mode", new_mode.value)
        self._metrics.mark("mode_changed_at")
        logger.info(
            "Feed mode: %s → %s (%s)",
            old.value, new_mode.value, self._descriptor.key,
        )
