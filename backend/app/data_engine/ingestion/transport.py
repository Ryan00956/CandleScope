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

import asyncio
import json
import logging
import time
from typing import Any

import aiohttp
import websockets
from websockets.asyncio.client import ClientConnection

from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.ws_protocol import (
    WsConnectionContext,
    WsSubscriptionMode,
)

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

class TransportLayer:
    """Async HTTP + WS transport with endpoint rotation.

    Shared across all pipelines — one instance per ``MarketDataIngress``.
    """

    def __init__(self, config: IngestionConfig) -> None:
        self._cfg = config
        self._metrics = LayerMetrics("L1_Transport")
        bootstrap_default_adapters()
        self._registry = get_exchange_registry()

        # Endpoint rotation state
        self._http_idx: dict[tuple[str, str], int] = {}
        self._ws_idx: dict[tuple[str, str], int] = {}

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
            or _os.getenv("ALL_PROXY")
            or _os.getenv("all_proxy")
        )
        if env_proxy:
            return env_proxy

        # Fallback: read from Windows registry / macOS scutil / etc.
        # Note: getproxies() short-circuits when getproxies_environment()
        # returns any entry (e.g. no_proxy), skipping the registry reader.
        # Call getproxies_registry() directly on Windows to avoid this.
        import sys
        if sys.platform == "win32":
            from urllib.request import getproxies_registry
            proxies = getproxies_registry()
        else:
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
            "active_http_endpoint": self.current_http_base,
            "active_ws_endpoint": self.current_ws_base,
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
        exchange = getattr(desc, "exchange", "binance")
        market_type = getattr(desc, "market_type", "spot")
        adapter = self._registry.get(exchange)
        rest_path = adapter.get_rest_path(desc.stream_type, market_type)
        if rest_path is None:
            raise TransportError(f"No REST endpoint for stream type: {desc.stream_type}")

        params = adapter.build_http_params(req)
        http_urls = self._sanitize_http_urls(
            exchange,
            adapter.get_http_base_urls(market_type, config=self._cfg),
        )
        last_exc: Exception | None = None
        tried = 0
        total = len(http_urls)

        if total == 0:
            raise TransportError(f"No HTTP endpoints configured for exchange: {exchange}")

        while tried < total:
            base = self._current_http_base(exchange, market_type, http_urls)
            url = f"{base}{rest_path}"
            try:
                self._metrics.inc("http_requests_sent")
                self._metrics.set("http_active_endpoint", base)
                self._metrics.mark("http_last_request_at")

                proxy = self._resolve_proxy()
                async with self._http_session.get(url, params=params, proxy=proxy) as resp:  # type: ignore[union-attr]
                    if resp.status != 200:
                        body = await resp.text()
                        if resp.status == 400:
                            logger.error(
                                "HTTP 400 from %s — params=%r url=%s body=%s",
                                base, params, resp.url, body[:300],
                            )
                        raise TransportError(f"HTTP {resp.status}: {body[:200]}")
                    data = await resp.json()

                self._metrics.inc("http_requests_ok")
                self._metrics.mark("http_last_success_at")
                now_ms = int(time.time() * 1000)

                rows = adapter.extract_http_rows(data, desc.stream_type)

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
                )
                self._rotate_http(exchange, market_type, len(http_urls))
                tried += 1

        raise TransportError(
            f"All {total} HTTP endpoints failed; last error: [{type(last_exc).__name__}] {last_exc}"
        ) from last_exc

    # ── Public: WebSocket ────────────────────────────────────

    async def ws_connect(
        self,
        descriptor: StreamDescriptor,
        *,
        quiet: bool = False,
    ) -> WsConnectionContext:
        """Open a raw WebSocket connection for the given stream.

        Returns the ``websockets`` connection object.
        The caller (L2 Session) is responsible for reading messages.
        Raises ``TransportError`` if ALL endpoints fail.
        """
        exchange = getattr(descriptor, "exchange", "binance")
        market_type = getattr(descriptor, "market_type", "spot")
        adapter = self._registry.get(exchange)
        subscription = adapter.build_ws_subscription(descriptor)
        ws_urls = self._sanitize_ws_urls(
            exchange,
            adapter.get_ws_base_urls(market_type, config=self._cfg),
        )
        last_exc: Exception | None = None
        tried = 0
        total = len(ws_urls)

        if total == 0:
            raise TransportError(f"No WS endpoints configured for exchange: {exchange}")

        while tried < total:
            base = self._current_ws_base(exchange, market_type, ws_urls)
            if subscription.mode == WsSubscriptionMode.PATH:
                if not subscription.stream_name:
                    raise TransportError(f"Missing WS stream name for {descriptor.key}")
                url = f"{base}/{subscription.stream_name}"
            else:
                url = base
            try:
                self._metrics.inc("ws_connect_attempts")
                self._metrics.set("ws_active_endpoint", base)
                self._metrics.mark("ws_last_connect_at")

                connect_kwargs: dict[str, Any] = {
                    "open_timeout": self._cfg.ws_open_timeout,
                    "close_timeout": 2,
                    "ping_interval": self._cfg.ws_ping_interval,
                    "ping_timeout": self._cfg.ws_ping_timeout,
                }
                # websockets ≥15 supports proxy natively.
                # When proxy_mode == "none", pass proxy=None to
                # disable the library's automatic system-proxy detection.
                proxy = self._resolve_proxy()
                proxy_mode = getattr(self._cfg, "proxy_mode", "system")
                if proxy:
                    connect_kwargs["proxy"] = proxy
                elif proxy_mode == "none":
                    connect_kwargs["proxy"] = None
                # else: proxy_mode == "system" with no proxy detected →
                #        let websockets auto-detect (do NOT pass proxy kwarg)

                conn = await websockets.connect(url, **connect_kwargs)

                self._metrics.inc("ws_connect_ok")
                self._metrics.mark("ws_last_success_at")
                logger.info("WS connected: %s", url)
                return WsConnectionContext(
                    connection=conn,
                    endpoint=base,
                    subscription=subscription,
                )

            except Exception as exc:
                last_exc = exc
                self._metrics.inc("ws_connect_failed")
                self._metrics.mark("ws_last_error_at")
                if quiet:
                    logger.debug("WS connect failed (%s): %s", url, exc)
                else:
                    logger.warning("WS connect failed (%s): %s", url, exc)
                self._rotate_ws(exchange, market_type, len(ws_urls))
                tried += 1

        raise TransportError(f"All {total} WS endpoints failed") from last_exc

    async def ws_subscribe(
        self,
        ctx: WsConnectionContext,
        *,
        quiet: bool = False,
    ) -> None:
        """Perform post-connect subscription handshake when required."""
        spec = ctx.subscription
        if spec.mode != WsSubscriptionMode.MESSAGE or spec.subscribe_payload is None:
            return

        try:
            await ctx.connection.send(json.dumps(spec.subscribe_payload))
        except Exception as exc:
            raise TransportError(f"WS subscribe send failed: {exc}") from exc

        if not spec.requires_subscribe_ack:
            return

        while True:
            try:
                raw_msg = await asyncio.wait_for(
                    ctx.connection.recv(),
                    timeout=self._cfg.ws_open_timeout,
                )
            except Exception as exc:
                raise TransportError(f"WS subscribe ack failed: {exc}") from exc

            try:
                payload = json.loads(raw_msg) if isinstance(raw_msg, (str, bytes)) else raw_msg
            except (json.JSONDecodeError, TypeError):
                continue

            if isinstance(payload, dict):
                event = str(payload.get("event", "")).lower()
                if event == "subscribe":
                    return
                if event == "error":
                    raise TransportError(f"WS subscription rejected: {payload}")

            ctx.prefetched_payloads.append(payload)

    async def ws_unsubscribe(self, ctx: WsConnectionContext) -> None:
        """Attempt a graceful unsubscribe for message-based protocols."""
        spec = ctx.subscription
        if spec.mode != WsSubscriptionMode.MESSAGE or spec.unsubscribe_payload is None:
            return
        try:
            await ctx.connection.send(json.dumps(spec.unsubscribe_payload))
        except Exception:
            return

    def supports_ws(self, descriptor: StreamDescriptor) -> bool:
        """Return whether the current stack can stream this descriptor over WebSocket."""
        exchange = getattr(descriptor, "exchange", "binance")
        market_type = getattr(descriptor, "market_type", "spot")
        adapter = self._registry.get(exchange)
        return adapter.supports_ws_streaming(market_type)

    # ── Public: probe (used by L3 to test WS connectivity) ───

    async def ws_probe(self, descriptor: StreamDescriptor) -> bool:
        """Quick connectivity probe — open + close immediately.

        Returns True if connection succeeds, False otherwise.
        """
        try:
            ctx = await self.ws_connect(descriptor, quiet=True)
            await self.ws_subscribe(ctx, quiet=True)
            await ctx.connection.close()
            return True
        except TransportError:
            return False

    # ── Public: current endpoints ────────────────────────────

    @property
    def current_http_base(self) -> str:
        """The HTTP base URL currently in use."""
        return self._current_http_base("binance", "spot", self._registry.get("binance").get_http_base_urls("spot", config=self._cfg))

    @property
    def current_ws_base(self) -> str:
        """The WS base URL currently in use."""
        return self._current_ws_base("binance", "spot", self._registry.get("binance").get_ws_base_urls("spot", config=self._cfg))

    # ── Internal: endpoint rotation ──────────────────────────

    def _current_http_base(
        self,
        exchange: str,
        market_type: str,
        urls: list[str],
    ) -> str:
        key = (exchange, market_type)
        idx = self._http_idx.get(key, 0)
        return urls[idx % len(urls)] if urls else ""

    def _current_ws_base(
        self,
        exchange: str,
        market_type: str,
        urls: list[str],
    ) -> str:
        key = (exchange, market_type)
        idx = self._ws_idx.get(key, 0)
        return urls[idx % len(urls)] if urls else ""

    def _rotate_http(self, exchange: str, market_type: str, total: int) -> None:
        key = (exchange, market_type)
        self._http_idx[key] = (self._http_idx.get(key, 0) + 1) % max(total, 1)
        urls = self._sanitize_http_urls(
            exchange,
            self._registry.get(exchange).get_http_base_urls(market_type, config=self._cfg),
        )
        logger.debug("HTTP endpoint rotated → %s", self._current_http_base(exchange, market_type, urls))

    def _rotate_ws(self, exchange: str, market_type: str, total: int) -> None:
        key = (exchange, market_type)
        self._ws_idx[key] = (self._ws_idx.get(key, 0) + 1) % max(total, 1)
        urls = self._sanitize_ws_urls(
            exchange,
            self._registry.get(exchange).get_ws_base_urls(market_type, config=self._cfg),
        )
        logger.debug("WS endpoint rotated → %s", self._current_ws_base(exchange, market_type, urls))

    def _sanitize_http_urls(self, exchange: str, urls: list[str]) -> list[str]:
        cleaned = [u for u in urls if u]
        if exchange == "okx":
            cleaned = [u for u in cleaned if "aws.okx.com" not in u]
        return list(dict.fromkeys(cleaned))

    def _sanitize_ws_urls(self, exchange: str, urls: list[str]) -> list[str]:
        cleaned = [u for u in urls if u]
        if exchange == "okx":
            cleaned = [u for u in cleaned if "wsaws.okx.com" not in u]
        return list(dict.fromkeys(cleaned))

    # ── Internal: HTTP session ───────────────────────────────

    async def _ensure_http_session(self) -> None:
        if self._http_session is None or self._http_session.closed:
            await self.start()


# ─── Exceptions ──────────────────────────────────────────────

class TransportError(Exception):
    """Raised when all transport endpoints fail."""
