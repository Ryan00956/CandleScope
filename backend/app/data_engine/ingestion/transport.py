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

from app.exchanges import (
    HistoricalRequest,
    RateLimitAdmission,
    RateLimitDeferred,
    bootstrap_default_adapters,
    get_exchange_registry,
    get_shared_rate_limit_manager,
    get_shared_rate_limit_semaphore,
)
from app.exchanges.ws_protocol import (
    WsConnectionContext,
    WsSubscriptionMode,
)
from app.data_engine.market_data import TransportMode, market_channel_for_stream_type

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

_NON_RETRYABLE_HTTP_BODY_CODES = frozenset({"-1130"})


class TransportLayer:
    """Async HTTP + WS transport with endpoint rotation.

    Shared across all pipelines — one instance per ``MarketDataIngress``.
    """

    def __init__(self, config: IngestionConfig) -> None:
        self._cfg = config
        self._metrics = LayerMetrics("L1_Transport")
        bootstrap_default_adapters()
        self._registry = get_exchange_registry()
        self._rate_limits = get_shared_rate_limit_manager()

        # Endpoint rotation state
        self._http_idx: dict[tuple[str, str], int] = {}
        self._ws_idx: dict[tuple[str, str], int] = {}
        self._last_http_base: str = ""
        self._last_ws_base: str = ""

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
    def config(self) -> IngestionConfig:
        return self._cfg

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "layer": "L1_Transport",
            "active_http_endpoint": self.current_http_base,
            "active_ws_endpoint": self.current_ws_base,
            "active_http_endpoints": {
                f"{exchange}:{market_type}": self._current_http_base(exchange, market_type, urls)
                for (exchange, market_type), urls in self._diagnostic_http_url_map().items()
            },
            "active_ws_endpoints": {
                f"{exchange}:{market_type}": self._current_ws_base(exchange, market_type, urls)
                for (exchange, market_type), urls in self._diagnostic_ws_url_map().items()
            },
            "metrics": self._metrics.snapshot(),
            "exchange_rate_limits": self._rate_limits.snapshot(),
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
        quota_acquired = bool(req.quota_acquired)
        quota_semaphore_held = bool(req.quota_semaphore_held)
        req.quota_acquired = False
        req.quota_semaphore_held = False

        plugin = self._registry.get_plugin(exchange)
        protocol = plugin.protocol()
        spec = protocol.rest_request(req, config=self._cfg)
        if spec is None:
            raise TransportError(f"No REST endpoint for stream type: {desc.stream_type}")

        params = spec.params
        quota_request = HistoricalRequest(
            exchange=exchange,
            market_type=market_type,
            endpoint=spec.path,
            symbol=desc.symbol,
            interval=desc.interval,
            start_ms=req.start_ms,
            end_ms=req.end_ms,
            limit=req.limit,
            params=dict(params),
        )
        quota_policy = plugin.rate_limit_policy(self._cfg)
        quota_rule = quota_policy.rule_for(quota_request)
        quota_semaphore = get_shared_rate_limit_semaphore(
            quota_rule,
            fallback=quota_policy.concurrency_for(market_type),
        )
        http_urls = spec.base_urls
        last_exc: Exception | None = None
        tried = 0
        total = len(http_urls)

        if total == 0:
            raise TransportError(f"No HTTP endpoints configured for exchange: {exchange}")

        while tried < total:
            base = self._current_http_base(exchange, market_type, http_urls)
            url = f"{base}{spec.path}"
            acquired_here = False
            response_headers_accounted = False
            response_completed = False
            try:
                needs_quota = not (quota_acquired and tried == 0)
                if needs_quota:
                    # Wait/return before taking the scarce endpoint gate, but
                    # do not consume yet. A queued request must re-check after
                    # the gate because another in-flight request may have
                    # opened a shared 418 circuit in the meantime.
                    await self._wait_for_http_admission(
                        quota_rule,
                        quota_request,
                        defer=req.defer_on_rate_limit,
                    )
                if not quota_semaphore_held:
                    await quota_semaphore.acquire()
                    acquired_here = True
                if needs_quota:
                    try:
                        await self._rate_limits.acquire_nowait(
                            quota_rule,
                            quota_request,
                        )
                    except RateLimitDeferred:
                        if req.defer_on_rate_limit:
                            raise
                        # The circuit/budget changed while waiting for the
                        # semaphore. Release it and repeat the non-consuming
                        # wait; never sleep while monopolizing the gate.
                        if acquired_here:
                            quota_semaphore.release()
                            acquired_here = False
                        continue

                self._metrics.inc("http_requests_sent")
                self._metrics.set("http_active_endpoint", base)
                self._metrics.mark("http_last_request_at")

                proxy = self._resolve_proxy()
                async with self._http_session.get(url, params=params, proxy=proxy) as resp:  # type: ignore[union-attr]
                    headers = {str(k): str(v) for k, v in resp.headers.items()}
                    if resp.status != 200:
                        body = ""
                        body_error: Exception | None = None
                        try:
                            body = await resp.text()
                        except Exception as exc:
                            # Status and headers are already authoritative.  In
                            # particular, a reset while reading a 418/429 body
                            # must not erase Retry-After or turn one exchange
                            # warning into failover traffic against every host.
                            body_error = exc
                        if resp.status == 400 and body_error is None:
                            logger.error(
                                "HTTP 400 from %s — params=%r url=%s body=%s",
                                base, params, resp.url, body[:300],
                            )
                        raise TransportError(
                            (
                                f"HTTP {resp.status}: {body[:200]}"
                                if body_error is None
                                else (
                                    f"HTTP {resp.status}: response body unavailable: "
                                    f"{body_error}"
                                )
                            ),
                            status_code=resp.status,
                            retry_after=_parse_retry_after(resp.headers.get("Retry-After")),
                            headers=headers,
                            body_code=_extract_body_code(body),
                        )
                    # Exchange quota headers are authoritative as soon as the
                    # response head arrives.  Account them before consuming or
                    # decoding the body so a truncated/malformed HTTP 200 does
                    # not erase used-weight and invite an oversized failover.
                    self._rate_limits.record_response(
                        quota_rule,
                        status_code=resp.status,
                        headers=headers,
                        response_complete=False,
                    )
                    response_headers_accounted = True
                    data = await resp.json()
                    body_code = _extract_body_code(data)
                    self._rate_limits.record_response(
                        quota_rule,
                        status_code=resp.status,
                        headers=headers,
                        body_code=body_code,
                        retry_after=_parse_retry_after(resp.headers.get("Retry-After")),
                        fallback_cooldown_seconds=quota_rule.cooldown_seconds,
                    )
                    response_completed = True
                    if body_code not in (None, "0"):
                        raise TransportError(
                            f"Exchange error {body_code}: {str(data)[:200]}",
                            status_code=resp.status,
                            retry_after=_parse_retry_after(resp.headers.get("Retry-After")),
                            headers=headers,
                            body_code=body_code,
                        )

                self._metrics.inc("http_requests_ok")
                self._metrics.mark("http_last_success_at")
                self._last_http_base = base
                now_ms = int(time.time() * 1000)

                rows = protocol.extract_http_rows(data, desc)

                return [
                    RawMessage(
                        payload=row,
                        source=DataSource.HTTP,
                        stream_type=desc.stream_type,
                        received_at_ms=now_ms,
                        endpoint=base,
                        http_status=200,
                        http_headers=headers,
                        http_body_code=body_code,
                        request_limit=req.limit,
                    )
                    for row in rows
                ]

            except RateLimitDeferred:
                # No physical request was made.  Preserve the typed scheduler
                # control signal and never rotate endpoints for shared budget.
                raise
            except Exception as exc:
                last_exc = exc
                # A successful response head may already have accounted the
                # physical request before JSON/body parsing failed. Preserve
                # that status/used-weight, but complete any strict probe as an
                # unknown result so its next admission ramps safely from zero.
                if response_headers_accounted and not response_completed:
                    self._rate_limits.record_response(
                        quota_rule,
                        response_unknown=True,
                    )
                elif not response_completed:
                    self._rate_limits.record_response(
                        quota_rule,
                        status_code=getattr(exc, "status_code", None),
                        headers=getattr(exc, "headers", None),
                        body_code=getattr(exc, "body_code", None),
                        retry_after=getattr(exc, "retry_after", None),
                        fallback_cooldown_seconds=quota_rule.cooldown_seconds,
                    )
                self._metrics.inc("http_requests_failed")
                self._metrics.mark("http_last_error_at")
                if isinstance(exc, TransportError):
                    exc.rate_limit_recorded = True
                if _is_rate_limit_http_error(exc):
                    # Alternate Binance/OKX hostnames share the same IP quota;
                    # failover would multiply the warning into a temporary ban.
                    if req.defer_on_rate_limit:
                        raise await self._rate_limits.deferred_error(
                            quota_rule,
                            quota_request,
                        ) from exc
                    raise
                if _is_non_retryable_http_error(exc):
                    raise
                logger.warning(
                    "HTTP fetch failed (%s): [%s] %s",
                    base, type(exc).__name__, exc,
                )
                self._rotate_http(exchange, market_type, len(http_urls))
                tried += 1
            finally:
                if acquired_here:
                    quota_semaphore.release()

        if isinstance(last_exc, TransportError):
            wrapped = TransportError(
                f"All {total} HTTP endpoints failed; last error: "
                f"[{type(last_exc).__name__}] {last_exc}",
                status_code=last_exc.status_code,
                retry_after=last_exc.retry_after,
                headers=last_exc.headers,
                body_code=last_exc.body_code,
            )
            wrapped.rate_limit_recorded = last_exc.rate_limit_recorded
            raise wrapped from last_exc
        raise TransportError(
            f"All {total} HTTP endpoints failed; last error: [{type(last_exc).__name__}] {last_exc}"
        ) from last_exc

    async def http_admission(self, req: TransportRequest) -> RateLimitAdmission:
        """Inspect REST quota for ``req`` without consuming it or doing I/O."""

        desc = req.descriptor
        exchange = getattr(desc, "exchange", "binance")
        market_type = getattr(desc, "market_type", "spot")
        plugin = self._registry.get_plugin(exchange)
        protocol = plugin.protocol()
        spec = protocol.rest_request(req, config=self._cfg)
        if spec is None:
            raise TransportError(f"No REST endpoint for stream type: {desc.stream_type}")
        quota_request = HistoricalRequest(
            exchange=exchange,
            market_type=market_type,
            endpoint=spec.path,
            symbol=desc.symbol,
            interval=desc.interval,
            start_ms=req.start_ms,
            end_ms=req.end_ms,
            limit=req.limit,
            params=dict(spec.params),
        )
        quota_rule = plugin.rate_limit_policy(self._cfg).rule_for(quota_request)
        return await self._rate_limits.inspect(quota_rule, quota_request)

    async def _wait_for_http_admission(
        self,
        rule: Any,
        request: HistoricalRequest,
        *,
        defer: bool,
    ) -> RateLimitAdmission:
        """Wait outside the endpoint gate, or return typed scheduler control."""

        while True:
            admission = await self._rate_limits.inspect(rule, request)
            if admission.allowed:
                return admission
            if defer:
                raise RateLimitDeferred(admission)
            await asyncio.sleep(max(0.001, admission.retry_after_seconds))

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
        protocol = self._registry.get_plugin(exchange).protocol()
        spec = protocol.ws_connection(descriptor, config=self._cfg)
        subscription = spec.subscription
        ws_urls = spec.base_urls
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
                self._last_ws_base = base
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
        plugin = self._registry.get_plugin(exchange)
        protocol_support = getattr(plugin.protocol(), "supports_ws", None)
        if callable(protocol_support) and not protocol_support(descriptor):
            return False

        capabilities = plugin.capabilities()
        channel = market_channel_for_stream_type(descriptor.stream_type)
        if channel is not None and getattr(capabilities, "capability_schema_version", 1) >= 2:
            capability = capabilities.channel_capability(channel, market_type)
            if capability is not None:
                return capability.supports_transport(TransportMode.WEBSOCKET)
        return capabilities.ws_connection_model != "polling_only"

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
        """Most recent HTTP base URL used by this transport."""
        if self._last_http_base:
            return self._last_http_base
        url_map = self._diagnostic_http_url_map()
        for (exchange, market_type), urls in url_map.items():
            if urls:
                return self._current_http_base(exchange, market_type, urls)
        return ""

    @property
    def current_ws_base(self) -> str:
        """Most recent WS base URL used by this transport."""
        if self._last_ws_base:
            return self._last_ws_base
        url_map = self._diagnostic_ws_url_map()
        for (exchange, market_type), urls in url_map.items():
            if urls:
                return self._current_ws_base(exchange, market_type, urls)
        return ""

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
        protocol = self._registry.get_plugin(exchange).protocol()
        urls = protocol.rest_base_urls(market_type, config=self._cfg)
        logger.debug("HTTP endpoint rotated → %s", self._current_http_base(exchange, market_type, urls))

    def _rotate_ws(self, exchange: str, market_type: str, total: int) -> None:
        key = (exchange, market_type)
        self._ws_idx[key] = (self._ws_idx.get(key, 0) + 1) % max(total, 1)
        protocol = self._registry.get_plugin(exchange).protocol()
        descriptor = StreamDescriptor(
            "",
            StreamType.KLINE,
            interval="1m",
            exchange=exchange,
            market_type=market_type,
        )
        urls = protocol.ws_base_urls(descriptor, config=self._cfg)
        logger.debug("WS endpoint rotated → %s", self._current_ws_base(exchange, market_type, urls))

    def _diagnostic_http_url_map(self) -> dict[tuple[str, str], list[str]]:
        result: dict[tuple[str, str], list[str]] = {}
        for plugin in self._registry.list_plugins():
            protocol = plugin.protocol()
            for market in plugin.capabilities().markets:
                result[(plugin.id, market.market_type)] = protocol.rest_base_urls(
                    market.market_type,
                    config=self._cfg,
                )
        return result

    def _diagnostic_ws_url_map(self) -> dict[tuple[str, str], list[str]]:
        result: dict[tuple[str, str], list[str]] = {}
        for plugin in self._registry.list_plugins():
            protocol = plugin.protocol()
            for market in plugin.capabilities().markets:
                descriptor = StreamDescriptor(
                    "",
                    StreamType.KLINE,
                    interval="1m",
                    exchange=plugin.id,
                    market_type=market.market_type,
                )
                result[(plugin.id, market.market_type)] = protocol.ws_base_urls(
                    descriptor,
                    config=self._cfg,
                )
        return result

    def _get_ws_base_urls_for_descriptor(
        self,
        adapter: Any,
        descriptor: StreamDescriptor,
        market_type: str,
    ) -> list[str]:
        get_descriptor_ws_urls = getattr(adapter, "get_ws_base_urls_for_descriptor", None)
        if callable(get_descriptor_ws_urls):
            urls = list(
                get_descriptor_ws_urls(
                    descriptor,
                    market_type=market_type,
                    config=self._cfg,
                ) or []
            )
            if urls:
                return urls

        if descriptor.stream_type in (StreamType.TICKER, StreamType.MINI_TICKER):
            get_ticker_ws_urls = getattr(adapter, "get_ticker_ws_urls", None)
            if callable(get_ticker_ws_urls):
                urls = list(get_ticker_ws_urls(market_type) or [])
                if urls:
                    return urls
        return list(adapter.get_ws_base_urls(market_type, config=self._cfg))

    # ── Internal: HTTP session ───────────────────────────────

    async def _ensure_http_session(self) -> None:
        if self._http_session is None or self._http_session.closed:
            await self.start()


# ─── Exceptions ──────────────────────────────────────────────

class TransportError(Exception):
    """Raised when all transport endpoints fail."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retry_after: float | None = None,
        headers: dict[str, str] | None = None,
        body_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after
        self.headers = headers or {}
        self.body_code = body_code
        self.rate_limit_recorded = False


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _extract_body_code(body: object) -> str | None:
    if isinstance(body, dict):
        raw = body.get("code")
        return str(raw) if raw is not None else None
    if not isinstance(body, str):
        return None
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    raw = payload.get("code")
    return str(raw) if raw is not None else None


def _is_non_retryable_http_error(exc: Exception) -> bool:
    return (
        isinstance(exc, TransportError)
        and exc.status_code == 400
        and exc.body_code in _NON_RETRYABLE_HTTP_BODY_CODES
    )


def _is_rate_limit_http_error(exc: Exception) -> bool:
    if not isinstance(exc, TransportError):
        return False
    return (
        exc.status_code in {418, 429}
        or exc.body_code in {"-1003", "50011"}
        or "HTTP 418" in str(exc)
        or "HTTP 429" in str(exc)
    )
