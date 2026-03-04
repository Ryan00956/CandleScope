from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

import websockets
from fastapi import WebSocket

from app.core.config import BINANCE_WS_URL, BINANCE_WS_URLS
from app.data_engine.storage import upsert_klines


@dataclass
class StreamSubscription:
    symbol: str
    interval: str
    clients: set[WebSocket] = field(default_factory=set)
    task: asyncio.Task | None = None
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)


class KlineStreamHub:
    def __init__(self) -> None:
        self._subscriptions: dict[tuple[str, str], StreamSubscription] = {}
        self._lock = asyncio.Lock()
        self._last_working_ws_base: str | None = None

    @staticmethod
    def _key(symbol: str, interval: str) -> tuple[str, str]:
        return symbol.upper().strip(), interval.strip()

    @staticmethod
    def _stream_name(symbol: str, interval: str) -> str:
        stream_name = f"{symbol.lower()}@kline_{interval}"
        return stream_name

    @staticmethod
    def _compose_stream_url(base_url: str, stream_name: str) -> str:
        base = base_url.rstrip("/")
        return f"{base}/{stream_name}"

    def _candidate_ws_bases(self) -> list[str]:
        bases: list[str] = []
        if self._last_working_ws_base:
            bases.append(self._last_working_ws_base)
        if BINANCE_WS_URL and BINANCE_WS_URL not in bases:
            bases.append(BINANCE_WS_URL)
        for item in BINANCE_WS_URLS:
            if item and item not in bases:
                bases.append(item)
        return bases

    async def subscribe(self, websocket: WebSocket, symbol: str, interval: str) -> None:
        key = self._key(symbol, interval)
        async with self._lock:
            subscription = self._subscriptions.get(key)
            if subscription is None:
                subscription = StreamSubscription(symbol=key[0], interval=key[1])
                self._subscriptions[key] = subscription

            subscription.clients.add(websocket)
            if subscription.task is None or subscription.task.done():
                subscription.stop_event = asyncio.Event()
                subscription.task = asyncio.create_task(self._run_stream(key))

    async def unsubscribe(self, websocket: WebSocket, symbol: str, interval: str) -> None:
        await self._remove_client_from_key(websocket, self._key(symbol, interval))

    async def remove_websocket(self, websocket: WebSocket) -> None:
        async with self._lock:
            keys = [key for key, sub in self._subscriptions.items() if websocket in sub.clients]

        for key in keys:
            await self._remove_client_from_key(websocket, key)

    async def _remove_client_from_key(self, websocket: WebSocket, key: tuple[str, str]) -> None:
        async with self._lock:
            subscription = self._subscriptions.get(key)
            if subscription is None:
                return

            subscription.clients.discard(websocket)
            if not subscription.clients:
                subscription.stop_event.set()
                if subscription.task and subscription.task.done():
                    self._subscriptions.pop(key, None)

    async def _run_stream(self, key: tuple[str, str]) -> None:
        reconnect_delay = 2
        while True:
            async with self._lock:
                subscription = self._subscriptions.get(key)
                if subscription is None or subscription.stop_event.is_set():
                    self._subscriptions.pop(key, None)
                    return

                symbol = subscription.symbol
                interval = subscription.interval
                stop_event = subscription.stop_event

            stream_name = self._stream_name(symbol, interval)
            try:
                await self._broadcast(
                    key,
                    {
                        "type": "stream_status",
                        "status": "connecting",
                        "symbol": symbol,
                        "interval": interval,
                    },
                )

                connected = False
                last_error: Exception | None = None
                for ws_base in self._candidate_ws_bases():
                    try:
                        url = self._compose_stream_url(ws_base, stream_name)
                        async with websockets.connect(
                            url,
                            open_timeout=8,
                            ping_interval=20,
                            ping_timeout=20,
                        ) as upstream:
                            self._last_working_ws_base = ws_base
                            connected = True

                            await self._broadcast(
                                key,
                                {
                                    "type": "stream_status",
                                    "status": "live",
                                    "symbol": symbol,
                                    "interval": interval,
                                },
                            )
                            async for message in upstream:
                                if stop_event.is_set():
                                    break

                                payload = self._normalize_kline_message(
                                    message,
                                    symbol=symbol,
                                    interval=interval,
                                )
                                if payload is None:
                                    continue

                                if payload["data"]["is_closed"]:
                                    self._persist_closed_kline(symbol, interval, payload["data"])

                                await self._broadcast(key, payload)
                            break
                    except Exception as endpoint_exc:  # noqa: BLE001
                        last_error = endpoint_exc
                        continue

                if not connected:
                    raise RuntimeError(f"all ws endpoints failed: {last_error}")

            except asyncio.CancelledError:
                return
            except Exception as exc:  # noqa: BLE001
                await self._broadcast(
                    key,
                    {
                        "type": "stream_status",
                        "status": "reconnecting",
                        "symbol": symbol,
                        "interval": interval,
                        "detail": str(exc),
                    },
                )

            if stop_event.is_set():
                async with self._lock:
                    self._subscriptions.pop(key, None)
                return

            await asyncio.sleep(reconnect_delay)

    @staticmethod
    def _normalize_kline_message(message: str, symbol: str, interval: str) -> dict | None:
        try:
            raw = json.loads(message)
        except json.JSONDecodeError:
            return None

        payload = raw.get("data", raw)
        kline = payload.get("k")
        if not kline:
            return None

        return {
            "type": "kline",
            "symbol": symbol,
            "interval": interval,
            "data": {
                "time": int(kline["t"]) // 1000,
                "open_time": int(kline["t"]),
                "close_time": int(kline["T"]),
                "open": float(kline["o"]),
                "high": float(kline["h"]),
                "low": float(kline["l"]),
                "close": float(kline["c"]),
                "volume": float(kline["v"]),
                "quote_volume": float(kline["q"]),
                "trades": int(kline["n"]),
                "taker_buy_base": float(kline["V"]),
                "taker_buy_quote": float(kline["Q"]),
                "is_closed": bool(kline["x"]),
            },
        }

    @staticmethod
    def _persist_closed_kline(symbol: str, interval: str, kline: dict) -> None:
        row = {
            "open_time": kline["open_time"],
            "close_time": kline["close_time"],
            "open": kline["open"],
            "high": kline["high"],
            "low": kline["low"],
            "close": kline["close"],
            "volume": kline["volume"],
            "quote_volume": kline["quote_volume"],
            "trades": kline["trades"],
            "taker_buy_base": kline["taker_buy_base"],
            "taker_buy_quote": kline["taker_buy_quote"],
        }
        upsert_klines(symbol=symbol, interval=interval, rows=[row], source="binance_ws")

    async def _broadcast(self, key: tuple[str, str], message: dict) -> None:
        async with self._lock:
            subscription = self._subscriptions.get(key)
            if subscription is None:
                return
            clients = list(subscription.clients)

        dead_clients: list[WebSocket] = []
        for client in clients:
            try:
                await client.send_json(message)
            except Exception:  # noqa: BLE001
                dead_clients.append(client)

        if dead_clients:
            for dead in dead_clients:
                await self._remove_client_from_key(dead, key)


kline_stream_hub = KlineStreamHub()
