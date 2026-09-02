from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode, urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection, connect

from app.data_engine.ingestion.config import IngestionConfig

from .adapter import twelve_data_api_key


logger = logging.getLogger("ingestion.twelvedata.runtime")
wire_logger = logging.getLogger("ingestion.twelvedata.websocket")
# The provider requires apikey in the WebSocket URI.  Prevent verbose
# websockets handshake logging from serialising that URI into application logs.
wire_logger.setLevel(logging.INFO)


@dataclass(frozen=True, slots=True)
class TwelveDataWsEvent:
    payload: dict[str, Any]
    received_at_ms: int
    generation: int


@dataclass(frozen=True, slots=True)
class TwelveDataLifecycleEvent:
    state: str
    reason: str
    generation: int
    consecutive_failures: int = 0


RawCallback = Callable[[TwelveDataWsEvent], None]
LifecycleCallback = Callable[[TwelveDataLifecycleEvent], None]


def provider_ws_symbol(symbol: str, market_type: str) -> str:
    value = str(symbol or "").strip().upper()
    if str(market_type or "").strip().lower() in {"stock", "etf"}:
        return value.split(":", 1)[0]
    return value


def _safe_error(exc: BaseException, api_key: str) -> str:
    value = str(exc).replace(api_key, "***")
    value = re.sub(r"(?i)(apikey=)[^&\s]+", r"\1***", value)
    return f"{type(exc).__name__}: {value}"[:256]


def _runtime_key(config: IngestionConfig) -> tuple[str, ...]:
    secret_id = hashlib.sha256(twelve_data_api_key(config).encode("utf-8")).hexdigest()[:16]
    return (
        "twelvedata",
        str(config.twelve_data_ws_base_url).strip(),
        secret_id,
        str(config.proxy_mode),
        str(config.http_proxy or ""),
    )


def _symbol_limit(config: IngestionConfig) -> int:
    # This adapter intentionally describes the Basic/free entitlement.  A
    # larger paid-plan runtime should be a separately declared capability.
    return min(8, max(1, int(config.twelve_data_ws_max_symbols)))


class TwelveDataRuntime:
    """One pooled Twelve Data socket shared by up to the configured symbols."""

    def __init__(self, config: IngestionConfig) -> None:
        self._cfg = config
        self._api_key = twelve_data_api_key(config)
        self._subscriptions: dict[
            str,
            tuple[str, RawCallback, LifecycleCallback],
        ] = {}
        self._symbol_references: dict[str, int] = {}
        self._lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        self._connection: ClientConnection | None = None
        self._run_task: asyncio.Task[None] | None = None
        self._running = False
        self._generation = 0
        self._consecutive_failures = 0
        self._messages = 0
        self._price_events = 0
        self._malformed_messages = 0
        self._heartbeats_sent = 0
        self._heartbeat_failures = 0
        self._reconnects = 0
        self._last_message_time = 0.0
        self._last_price_time = 0.0
        self._max_receive_gap_ms = 0

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._run_task = asyncio.create_task(
            self._run(),
            name="twelvedata_ws_runtime",
        )

    async def close(self) -> None:
        self._running = False
        task = self._run_task
        self._run_task = None
        if task is not None and not task.done():
            task.cancel()
        await self._close_connection()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        async with self._lock:
            self._subscriptions.clear()
            self._symbol_references.clear()

    async def subscribe(
        self,
        *,
        symbol: str,
        market_type: str,
        raw_callback: RawCallback,
        lifecycle_callback: LifecycleCallback,
    ) -> str:
        provider_symbol = provider_ws_symbol(symbol, market_type)
        if not provider_symbol:
            raise ValueError("Twelve Data WebSocket symbol must be non-empty")
        token = uuid.uuid4().hex
        should_send = False
        async with self._lock:
            current = self._symbol_references.get(provider_symbol, 0)
            if current == 0:
                limit = _symbol_limit(self._cfg)
                if len(self._symbol_references) >= limit:
                    raise RuntimeError(
                        f"Twelve Data WebSocket symbol limit reached ({limit})"
                    )
                should_send = self._connection is not None
            self._subscriptions[token] = (
                provider_symbol,
                raw_callback,
                lifecycle_callback,
            )
            self._symbol_references[provider_symbol] = current + 1
        if should_send:
            try:
                await self._send_symbols("subscribe", (provider_symbol,))
            except BaseException:
                # Do not retain a logical subscriber when its physical
                # subscribe frame could not be sent.  The caller has not yet
                # received the token, so only the runtime can roll it back.
                await self.unsubscribe(token)
                raise
            lifecycle_callback(TwelveDataLifecycleEvent(
                state="connected",
                reason="Twelve Data subscription active",
                generation=self._generation,
                consecutive_failures=self._consecutive_failures,
            ))
        return token

    async def unsubscribe(self, token: str) -> None:
        provider_symbol: str | None = None
        should_send = False
        async with self._lock:
            subscription = self._subscriptions.pop(token, None)
            if subscription is None:
                return
            provider_symbol = subscription[0]
            remaining = self._symbol_references.get(provider_symbol, 0) - 1
            if remaining <= 0:
                self._symbol_references.pop(provider_symbol, None)
                should_send = self._connection is not None
            else:
                self._symbol_references[provider_symbol] = remaining
        if should_send and provider_symbol is not None:
            try:
                await self._send_symbols("unsubscribe", (provider_symbol,))
            except Exception:
                # The desired set is already updated. Reconnect will subscribe
                # only the remaining symbols even if graceful unsubscribe fails.
                pass

    def snapshot(self) -> dict[str, Any]:
        return {
            "provider": "twelvedata",
            "running": self._running,
            "connected": self._connection is not None,
            "physical_websockets": 1 if self._connection is not None else 0,
            "logical_subscribers": len(self._subscriptions),
            "subscribed_symbols": len(self._symbol_references),
            "max_symbols": _symbol_limit(self._cfg),
            "generation": self._generation,
            "consecutive_failures": self._consecutive_failures,
            "messages": self._messages,
            "price_events": self._price_events,
            "malformed_messages": self._malformed_messages,
            "heartbeats_sent": self._heartbeats_sent,
            "heartbeat_failures": self._heartbeat_failures,
            "reconnects": self._reconnects,
            "last_message_time": self._last_message_time,
            "max_receive_gap_ms": self._max_receive_gap_ms,
        }

    async def _run(self) -> None:
        delay = max(0.1, float(self._cfg.ws_reconnect_delay_initial))
        while self._running:
            state = "connecting" if self._generation == 0 else "reconnecting"
            self._notify_lifecycle(state, "Twelve Data WebSocket opening")
            try:
                uri = self._connection_uri()
                connection = await connect(
                    uri,
                    open_timeout=float(self._cfg.ws_open_timeout),
                    close_timeout=2,
                    ping_interval=float(self._cfg.ws_ping_interval),
                    ping_timeout=float(self._cfg.ws_ping_timeout),
                    proxy=self._proxy_setting(),
                    max_queue=64,
                    logger=wire_logger,
                )
                self._connection = connection
                self._generation += 1
                self._consecutive_failures = 0
                delay = max(0.1, float(self._cfg.ws_reconnect_delay_initial))
                symbols = tuple(sorted(self._symbol_references))
                if symbols:
                    await self._send_symbols("subscribe", symbols)
                self._notify_lifecycle("connected", "Twelve Data WebSocket connected")
                await self._read_loop(connection)
                if self._running:
                    raise RuntimeError("Twelve Data WebSocket ended unexpectedly")
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._consecutive_failures += 1
                self._reconnects += 1
                threshold = max(1, int(self._cfg.ws_consecutive_failure_threshold))
                health = (
                    "unhealthy"
                    if self._consecutive_failures >= threshold
                    else "reconnecting"
                )
                reason = _safe_error(exc, self._api_key)
                self._notify_lifecycle(health, reason)
                logger.warning("Twelve Data WebSocket reconnecting: %s", reason)
            finally:
                await self._close_connection()
            if self._running:
                await asyncio.sleep(min(delay, float(self._cfg.ws_reconnect_delay_max)))
                delay = min(delay * 2, float(self._cfg.ws_reconnect_delay_max))
        self._notify_lifecycle("disconnected", "Twelve Data WebSocket stopped")

    async def _read_loop(self, connection: ClientConnection) -> None:
        heartbeat = asyncio.create_task(
            self._heartbeat_loop(connection),
            name=f"twelvedata_heartbeat_{self._generation}",
        )
        try:
            while self._running and self._connection is connection:
                raw = await asyncio.wait_for(
                    connection.recv(),
                    timeout=float(self._cfg.ws_stale_timeout),
                )
                self._messages += 1
                self._last_message_time = time.monotonic()
                try:
                    payload = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
                except (json.JSONDecodeError, TypeError):
                    self._malformed_messages += 1
                    continue
                if not isinstance(payload, dict):
                    self._malformed_messages += 1
                    continue
                event = str(payload.get("event") or "").strip().lower()
                if event == "price":
                    self._dispatch_price(payload)
                elif event == "subscribe-status":
                    self._handle_subscribe_status(payload)
        finally:
            if not heartbeat.done():
                heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)

    async def _heartbeat_loop(self, connection: ClientConnection) -> None:
        interval = max(
            1.0,
            float(self._cfg.twelve_data_ws_heartbeat_interval),
        )
        while self._running and self._connection is connection:
            await asyncio.sleep(interval)
            if not self._running or self._connection is not connection:
                return
            try:
                await self._send_control({"action": "heartbeat"})
                self._heartbeats_sent += 1
            except asyncio.CancelledError:
                raise
            except Exception:
                self._heartbeat_failures += 1
                # Break recv() so the owning connection loop can reconnect.
                try:
                    await connection.close()
                finally:
                    return

    def _dispatch_price(self, payload: dict[str, Any]) -> None:
        provider_symbol = str(payload.get("symbol") or "").strip().upper()
        if not provider_symbol:
            self._malformed_messages += 1
            return
        now = time.monotonic()
        if self._last_price_time > 0:
            gap_ms = int((now - self._last_price_time) * 1000)
            self._max_receive_gap_ms = max(self._max_receive_gap_ms, gap_ms)
        self._last_price_time = now
        self._price_events += 1
        event = TwelveDataWsEvent(
            payload={
                **payload,
                "_twelve_data_ws_generation": self._generation,
            },
            received_at_ms=int(time.time() * 1000),
            generation=self._generation,
        )
        for expected_symbol, callback, _ in tuple(self._subscriptions.values()):
            if expected_symbol == provider_symbol:
                callback(event)

    def _handle_subscribe_status(self, payload: dict[str, Any]) -> None:
        status = str(payload.get("status") or "").strip().lower()
        rejected = payload.get("fails") or payload.get("failed") or ()
        rejected_symbols = {
            str(item.get("symbol") or "").strip().upper()
            for item in rejected
            if isinstance(item, dict)
        } if isinstance(rejected, list) else set()
        if status in {"ok", "success"} and not rejected_symbols:
            return
        reason = str(
            payload.get("message")
            or payload.get("status")
            or "subscription rejected"
        )
        event = TwelveDataLifecycleEvent(
            state="unhealthy",
            reason=reason[:256],
            generation=self._generation,
            consecutive_failures=max(1, self._consecutive_failures),
        )
        for symbol, _, callback in tuple(self._subscriptions.values()):
            if not rejected_symbols or symbol in rejected_symbols:
                callback(event)

    def _notify_lifecycle(self, state: str, reason: str) -> None:
        event = TwelveDataLifecycleEvent(
            state=state,
            reason=reason[:256],
            generation=self._generation,
            consecutive_failures=self._consecutive_failures,
        )
        for _, _, callback in tuple(self._subscriptions.values()):
            callback(event)

    async def _send_symbols(self, action: str, symbols: tuple[str, ...]) -> None:
        if not symbols:
            return
        await self._send_control({
            "action": action,
            "params": {"symbols": ",".join(symbols)},
        })

    async def _send_control(self, payload: dict[str, Any]) -> None:
        connection = self._connection
        if connection is None:
            return
        async with self._send_lock:
            await connection.send(json.dumps(payload, separators=(",", ":")))

    async def _close_connection(self) -> None:
        connection = self._connection
        self._connection = None
        if connection is None:
            return
        try:
            await asyncio.wait_for(connection.close(), timeout=2)
        except Exception:
            pass

    def _connection_uri(self) -> str:
        base = str(self._cfg.twelve_data_ws_base_url or "").strip()
        parsed = urlsplit(base)
        if parsed.scheme != "wss" or not parsed.netloc:
            raise ValueError("Twelve Data WebSocket base URL must be a wss URL")
        if parsed.query or parsed.fragment:
            raise ValueError("Twelve Data WebSocket base URL must not contain query or fragment")
        clean = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        return f"{clean}?{urlencode({'apikey': self._api_key})}"

    def _proxy_setting(self) -> str | bool | None:
        mode = str(self._cfg.proxy_mode or "system").strip().lower()
        if mode == "none":
            return None
        if mode == "custom":
            return self._cfg.http_proxy or None
        return True


@dataclass(slots=True)
class _PoolEntry:
    runtime: TwelveDataRuntime
    references: int = 0


class TwelveDataRuntimePool:
    def __init__(self) -> None:
        self._entries: dict[tuple[str, ...], _PoolEntry] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, config: IngestionConfig) -> TwelveDataRuntime:
        key = _runtime_key(config)
        async with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                entry = _PoolEntry(TwelveDataRuntime(config))
                self._entries[key] = entry
            entry.references += 1
            runtime = entry.runtime
        await runtime.start()
        return runtime

    async def release(self, runtime: TwelveDataRuntime) -> None:
        close_runtime = False
        async with self._lock:
            for key, entry in tuple(self._entries.items()):
                if entry.runtime is not runtime:
                    continue
                entry.references -= 1
                if entry.references <= 0:
                    self._entries.pop(key, None)
                    close_runtime = True
                break
        if close_runtime:
            await runtime.close()

    async def close_all(self) -> None:
        async with self._lock:
            runtimes = [entry.runtime for entry in self._entries.values()]
            self._entries.clear()
        await asyncio.gather(*(runtime.close() for runtime in runtimes))

    def snapshot(self) -> dict[str, Any]:
        return {
            "runtime_count": len(self._entries),
            "runtimes": {
                f"runtime-{index}": entry.runtime.snapshot()
                for index, entry in enumerate(self._entries.values(), start=1)
            },
        }


_SHARED_POOL = TwelveDataRuntimePool()


def get_shared_twelve_data_runtime_pool() -> TwelveDataRuntimePool:
    return _SHARED_POOL


__all__ = [
    "TwelveDataLifecycleEvent",
    "TwelveDataRuntime",
    "TwelveDataRuntimePool",
    "TwelveDataWsEvent",
    "get_shared_twelve_data_runtime_pool",
    "provider_ws_symbol",
]
