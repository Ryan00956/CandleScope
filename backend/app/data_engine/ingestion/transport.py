"""
L1: Transport Layer — the lowest-level I/O layer.

Responsibilities:
  * Open / close raw WebSocket connections (returns the connection object)
  * Send HTTP GET requests to REST endpoints (returns raw JSON)
  * Rotate through multiple base URLs on failure
  * Support user-configured proxy
  * Expose metrics: requests_sent, requests_failed, active_endpoint, etc.

This layer knows NOTHING about market-data semantics — it just moves bytes.
It is **stream-type agnostic**: the caller tells it which WS stream name
to connect to and which REST endpoint + params to hit.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import aiohttp
import websockets
from websockets.asyncio.client import ClientConnection

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import (
    StreamDescriptor,
    StreamType,
    TransportRequest,
    DataSource,
    RawMessage,
)

logger = logging.getLogger("ingestion.L1_Transport")

# ─── REST endpoint mapping per StreamType ─────────────────────

_REST_PATH: dict[StreamType, str] = {
    StreamType.KLINE: "/api/v3/klines",
    StreamType.AGG_TRADE: "/api/v3/aggTrades",
    StreamType.TRADE: "/api/v3/trades",
    StreamType.TICKER: "/api/v3/ticker/24hr",
    StreamType.MINI_TICKER: "/api/v3/ticker/24hr",
    StreamType.DEPTH: "/api/v3/depth",
}


class TransportLayer:
    """Async HTTP + WS transport with endpoint rotation.

    Shared across all pipelines — one instance per ``MarketDataIngress``.
    """

    def __init__(self, config: IngestionConfig) -> None:
        self._cfg = config
        self._metrics = LayerMetrics("L1_Transport")

        # Endpoint rotation state
        self._http_idx = 0
        self._ws_idx = 0

        # Shared HTTP session (created lazily)
        self._http_session: aiohttp.ClientSession | None = None

    # ── Public: Proxy resolution ─────────────────────────────

    def _resolve_proxy(self) -> str | None:
        """Resolve the effective proxy URL based on proxy_mode.

        Returns None when no proxy should be used.

        On Windows, proxy tools like v2rayN / Clash set the system proxy
        in the registry rather than environment variables.
        ``urllib.request.getproxies()`` handles this transparently.
        """
        import os as _os

        mode = getattr(self._cfg, "proxy_mode", "system")

        if mode == "none":
            return None

        if mode == "custom":
            proxy = self._cfg.http_proxy
            return proxy if proxy else None

        # mode == "system" (default) — env vars first, then OS-level settings
        env_proxy = (
            _os.getenv("HTTPS_PROXY")
            or _os.getenv("HTTP_PROXY")
            or _os.getenv("https_proxy")
            or _os.getenv("http_proxy")
        )
        if env_proxy:
            return env_proxy

        # Fallback: read from Windows registry / macOS scutil / etc.
        from urllib.request import getproxies
        proxies = getproxies()
        os_proxy = proxies.get("https") or proxies.get("http")
        if os_proxy:
            return os_proxy

        return self._cfg.http_proxy or None

    # ── Public: Metrics ──────────────────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "layer": "L1_Transport",
            "active_http_endpoint": self._current_http_base(),
            "active_ws_endpoint": self._current_ws_base(),
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Lifecycle ────────────────────────────────────

    async def start(self) -> None:
        """Initialize shared resources (HTTP session)."""
        if self._http_session is None or self._http_session.closed:
            timeout = aiohttp.ClientTimeout(total=self._cfg.http_timeout)
            self._http_session = aiohttp.ClientSession(timeout=timeout)
            logger.info("HTTP session created (timeout=%ss)", self._cfg.http_timeout)

    async def stop(self) -> None:
        """Release shared resources."""
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
            self._http_session = None
            logger.info("HTTP session closed")

    async def restart_http_session(self) -> None:
        """Restart the HTTP session (e.g. after proxy config change)."""
        await self.stop()
        await self.start()
        proxy = self._resolve_proxy()
        logger.info("HTTP session restarted (proxy=%s)", proxy or "none")

    # ── Public: HTTP ─────────────────────────────────────────

    async def http_fetch(self, req: TransportRequest) -> list[RawMessage]:
        """Fetch data via REST API for any stream type.

        Tries each endpoint on failure.
        Returns a list of ``RawMessage`` with raw payloads.
        Raises ``TransportError`` if ALL endpoints fail.
        """
        await self._ensure_http_session()

        desc = req.descriptor
        rest_path = _REST_PATH.get(desc.stream_type)
        if rest_path is None:
            raise TransportError(f"No REST endpoint for stream type: {desc.stream_type}")

        params = self._build_http_params(req)

        last_exc: Exception | None = None
        tried = 0
        total = len(self._cfg.http_base_urls)

        while tried < total:
            base = self._current_http_base()
            url = f"{base}{rest_path}"
            try:
                self._metrics.inc("http_requests_sent")
                self._metrics.set("http_active_endpoint", base)
                self._metrics.mark("http_last_request_at")

                proxy = self._resolve_proxy()
                async with self._http_session.get(url, params=params, proxy=proxy) as resp:  # type: ignore[union-attr]
                    if resp.status != 200:
                        body = await resp.text()
                        raise TransportError(f"HTTP {resp.status}: {body[:200]}")
                    data = await resp.json()

                self._metrics.inc("http_requests_ok")
                self._metrics.mark("http_last_success_at")
                now_ms = int(time.time() * 1000)

                # Normalize response to list
                rows = data if isinstance(data, list) else [data]

                return [
                    RawMessage(
                        payload=row,
                        source=DataSource.HTTP,
                        stream_type=desc.stream_type,
                        received_at_ms=now_ms,
                        endpoint=base,
                    )
                    for row in rows
                ]

            except Exception as exc:
                last_exc = exc
                self._metrics.inc("http_requests_failed")
                self._metrics.mark("http_last_error_at")
                logger.warning(
                    "HTTP fetch failed (%s): [%s] %s",
                    base, type(exc).__name__, exc,
                    exc_info=True,
                )
                self._rotate_http()
                tried += 1

        raise TransportError(
            f"All {total} HTTP endpoints failed; last error: [{type(last_exc).__name__}] {last_exc}"
        ) from last_exc

    # ── Public: WebSocket ────────────────────────────────────

    async def ws_connect(self, descriptor: StreamDescriptor) -> ClientConnection:
        """Open a raw WebSocket connection for the given stream.

        Returns the ``websockets`` connection object.
        The caller (L2 Session) is responsible for reading messages.
        Raises ``TransportError`` if ALL endpoints fail.
        """
        stream_name = descriptor.ws_stream_name
        last_exc: Exception | None = None
        tried = 0
        total = len(self._cfg.ws_base_urls)

        while tried < total:
            base = self._current_ws_base()
            url = f"{base}/{stream_name}"
            try:
                self._metrics.inc("ws_connect_attempts")
                self._metrics.set("ws_active_endpoint", base)
                self._metrics.mark("ws_last_connect_at")

                conn = await websockets.connect(
                    url,
                    open_timeout=self._cfg.ws_open_timeout,
                    close_timeout=2,
                    ping_interval=self._cfg.ws_ping_interval,
                    ping_timeout=self._cfg.ws_ping_timeout,
                )

                self._metrics.inc("ws_connect_ok")
                self._metrics.mark("ws_last_success_at")
                logger.info("WS connected: %s", url)
                return conn

            except Exception as exc:
                last_exc = exc
                self._metrics.inc("ws_connect_failed")
                self._metrics.mark("ws_last_error_at")
                logger.warning("WS connect failed (%s): %s", url, exc)
                self._rotate_ws()
                tried += 1

        raise TransportError(f"All {total} WS endpoints failed") from last_exc

    # ── Public: probe (used by L3 to test WS connectivity) ───

    async def ws_probe(self, descriptor: StreamDescriptor) -> bool:
        """Quick connectivity probe — open + close immediately.

        Returns True if connection succeeds, False otherwise.
        """
        try:
            conn = await self.ws_connect(descriptor)
            await conn.close()
            return True
        except TransportError:
            return False

    # ── Public: current endpoints ────────────────────────────

    @property
    def current_http_base(self) -> str:
        """The HTTP base URL currently in use."""
        return self._current_http_base()

    @property
    def current_ws_base(self) -> str:
        """The WS base URL currently in use."""
        return self._current_ws_base()

    # ── Internal: build HTTP params ──────────────────────────

    @staticmethod
    def _build_http_params(req: TransportRequest) -> dict[str, Any]:
        """Build query params based on stream type."""
        desc = req.descriptor
        params: dict[str, Any] = {"symbol": desc.symbol.upper()}

        if desc.stream_type == StreamType.KLINE:
            params["interval"] = desc.interval
            params["limit"] = req.limit
            if req.start_ms is not None:
                params["startTime"] = req.start_ms
            if req.end_ms is not None:
                params["endTime"] = req.end_ms

        elif desc.stream_type in (StreamType.AGG_TRADE, StreamType.TRADE):
            params["limit"] = req.limit
            if req.start_ms is not None:
                params["startTime"] = req.start_ms
            if req.end_ms is not None:
                params["endTime"] = req.end_ms

        elif desc.stream_type in (StreamType.TICKER, StreamType.MINI_TICKER):
            # /api/v3/ticker/24hr?symbol=BTCUSDT — no extra params needed
            pass

        elif desc.stream_type == StreamType.DEPTH:
            params["limit"] = min(req.limit, 5000)

        return params

    # ── Internal: endpoint rotation ──────────────────────────

    def _current_http_base(self) -> str:
        urls = self._cfg.http_base_urls
        return urls[self._http_idx % len(urls)] if urls else ""

    def _current_ws_base(self) -> str:
        urls = self._cfg.ws_base_urls
        return urls[self._ws_idx % len(urls)] if urls else ""

    def _rotate_http(self) -> None:
        self._http_idx = (self._http_idx + 1) % max(len(self._cfg.http_base_urls), 1)
        logger.debug("HTTP endpoint rotated → %s", self._current_http_base())

    def _rotate_ws(self) -> None:
        self._ws_idx = (self._ws_idx + 1) % max(len(self._cfg.ws_base_urls), 1)
        logger.debug("WS endpoint rotated → %s", self._current_ws_base())

    # ── Internal: HTTP session ───────────────────────────────

    async def _ensure_http_session(self) -> None:
        if self._http_session is None or self._http_session.closed:
            await self.start()


# ─── Exceptions ──────────────────────────────────────────────

class TransportError(Exception):
    """Raised when all transport endpoints fail."""
