"""K-line WebSocket handlers backed by DataManager events."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_utils import (
    send_json_with_timeout,
    send_text_with_timeout,
    validate_ws_interval,
)
from app.data_engine.data_manager.models import DataEventType
from app.data_engine.interval_policy import parse_interval_spec


@dataclass(slots=True)
class _LatestKlineMessage:
    key: tuple[str, str, str, str]
    message: dict[str, Any]


class _KlineWsOutbox:
    """Bounded WS outbox with one replaceable forming update per series."""

    def __init__(self, maxsize: int = 1000) -> None:
        self._queue: asyncio.Queue[_LatestKlineMessage | dict[str, Any]] = (
            asyncio.Queue(maxsize=max(1, int(maxsize)))
        )
        self._latest: dict[tuple[str, str, str, str], _LatestKlineMessage] = {}

    async def put(
        self,
        message: dict[str, Any],
        *,
        key: tuple[str, str, str, str] | None = None,
        replaceable: bool = False,
        timeout: float = 1.0,
    ) -> bool:
        if replaceable and key is not None:
            pending = self._latest.get(key)
            if pending is not None:
                pending.message = message
                return True
            pending = _LatestKlineMessage(key=key, message=message)
            try:
                self._queue.put_nowait(pending)
            except asyncio.QueueFull:
                return False
            self._latest[key] = pending
            return True

        pending = self._latest.get(key) if key is not None else None
        try:
            await asyncio.wait_for(self._queue.put(message), timeout=timeout)
            # Keep the old forming slot indexed until the final/correction is
            # actually queued.  A timeout must not allow duplicate forming
            # slots to accumulate behind an unindexed pending item.
            if key is not None and self._latest.get(key) is pending:
                self._latest.pop(key, None)
            return True
        except asyncio.TimeoutError:
            return False

    async def get(self) -> dict[str, Any]:
        item = await self._queue.get()
        if isinstance(item, _LatestKlineMessage):
            if self._latest.get(item.key) is item:
                self._latest.pop(item.key, None)
            return item.message
        return item


def should_forward_browser_event(event) -> bool:
    """Return whether a DataManager event should be sent to browser K-line clients."""
    if event.event_type != DataEventType.BACKFILL_COMPLETED:
        return True
    return getattr(event, "audience", "user") != "internal"


async def stream_single_kline(
    websocket: WebSocket,
    dm,
    symbol: str,
    interval: str,
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Stream bars for a single interval using DataManager's EventBus."""
    spec = parse_interval_spec(interval)
    if spec is not None:
        interval = spec.canonical
    consumer_id = f"ws:klines:{exchange}:{market_type}:{symbol}:{interval}:{id(websocket)}"
    try:
        await dm.ensure_stream(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            focus_scope="websocket",
            consumer_id=consumer_id,
        )

        await send_json_with_timeout(websocket, {
            "type": "subscribed",
            "exchange": exchange,
            "symbol": symbol,
            "interval": interval,
            "market_type": market_type,
        })

        client_task = asyncio.create_task(
            read_client_messages(websocket),
            name="ws_client_reader",
        )
        stream_task = asyncio.create_task(
            forward_events_to_ws(
                websocket,
                dm,
                symbol,
                [interval],
                exchange=exchange,
                market_type=market_type,
            ),
            name="ws_event_forwarder",
        )

        _done, pending = await asyncio.wait(
            {client_task, stream_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in pending:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        release_stream = getattr(dm, "release_stream", None)
        if callable(release_stream):
            try:
                await release_stream(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    focus_scope="websocket",
                    consumer_id=consumer_id,
                )
            except Exception:
                pass


async def stream_multi_kline(
    websocket: WebSocket,
    dm,
    symbol: str,
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Multi-interval stream using DataManager's EventBus."""
    active_intervals: set[str] = set()
    event_queue = _KlineWsOutbox(maxsize=1000)
    subscriptions = {}
    ws_closed = False
    consumer_id = f"ws:klines_multi:{exchange}:{market_type}:{symbol}:{id(websocket)}"

    async def safe_send_json(data: dict) -> bool:
        nonlocal ws_closed
        if ws_closed:
            return False
        try:
            await send_json_with_timeout(websocket, data)
            return True
        except (RuntimeError, Exception):
            ws_closed = True
            return False

    async def safe_send_text(data: str) -> bool:
        nonlocal ws_closed
        if ws_closed:
            return False
        try:
            await send_text_with_timeout(websocket, data)
            return True
        except (RuntimeError, Exception):
            ws_closed = True
            return False

    async def event_callback(event):
        if ws_closed:
            return
        if not should_forward_browser_event(event):
            return
        event_key = (
            event.key.exchange,
            event.key.market_type,
            event.key.symbol,
            event.key.interval,
        )
        try:
            if event.event_type == DataEventType.BACKFILL_COMPLETED:
                await event_queue.put(
                    {
                        "type": "backfill_completed",
                        "exchange": event.key.exchange,
                        "symbol": event.key.symbol,
                        "interval": event.key.interval,
                        "market_type": event.key.market_type,
                        "detail": event.detail or {},
                    },
                    key=event_key,
                    timeout=1.0,
                )
                return

            bar_dict = {
                "type": "kline",
                "exchange": event.key.exchange,
                "symbol": event.key.symbol,
                "interval": event.key.interval,
                "market_type": event.key.market_type,
                "data": event.bar.to_kline_dict() if event.bar else {},
            }
            bar_dict["data"]["is_closed"] = event.event_type in {
                DataEventType.BAR_CLOSED,
                DataEventType.BAR_AMENDED,
            }
            await event_queue.put(
                bar_dict,
                key=event_key,
                replaceable=event.event_type == DataEventType.BAR_UPDATED,
                timeout=1.0,
            )
        except (asyncio.TimeoutError, Exception):
            pass

    try:
        async def forwarder() -> None:
            nonlocal ws_closed
            while not ws_closed:
                msg = await event_queue.get()
                if not await safe_send_json(msg):
                    return

        forwarder_task = asyncio.create_task(forwarder(), name="ws_forwarder")

        try:
            while not ws_closed:
                raw = await websocket.receive_text()
                stripped = raw.strip().lower()

                if stripped == "ping":
                    if not await safe_send_text("pong"):
                        break
                    continue

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    if not await safe_send_json({"type": "error", "detail": "Invalid JSON"}):
                        break
                    continue

                action = msg.get("action", "").lower()
                intervals = msg.get("intervals", [])

                if not isinstance(intervals, list) or not intervals:
                    if not await safe_send_json({
                        "type": "error",
                        "detail": "intervals must be a non-empty list",
                    }):
                        break
                    continue

                valid: list[str] = []
                seen_intervals: set[str] = set()
                for raw_interval in intervals:
                    if not validate_ws_interval(raw_interval):
                        continue
                    spec = parse_interval_spec(raw_interval)
                    canonical = spec.canonical if spec is not None else raw_interval
                    if canonical not in seen_intervals:
                        seen_intervals.add(canonical)
                        valid.append(canonical)
                invalid = [i for i in intervals if not validate_ws_interval(i)]

                if invalid:
                    await safe_send_json({
                        "type": "warning",
                        "detail": f"Skipped invalid intervals: {invalid}",
                    })

                if not valid:
                    if not await safe_send_json({
                        "type": "error",
                        "detail": "No valid intervals provided",
                    }):
                        break
                    continue

                if action == "subscribe":
                    subscribed_now: list[str] = []
                    failed: list[dict[str, str]] = []
                    for iv in valid:
                        if iv in active_intervals:
                            subscribed_now.append(iv)
                            continue
                        if iv not in active_intervals:
                            try:
                                await dm.ensure_stream(
                                    symbol,
                                    iv,
                                    exchange=exchange,
                                    market_type=market_type,
                                    focus_scope="websocket",
                                    consumer_id=consumer_id,
                                )
                                handle = dm.subscribe(
                                    callback=event_callback,
                                    symbol=symbol,
                                    interval=iv,
                                    exchange=exchange,
                                    market_type=market_type,
                                    event_types={
                                        DataEventType.BAR_CREATED,
                                        DataEventType.BAR_UPDATED,
                                        DataEventType.BAR_CLOSED,
                                        DataEventType.BAR_AMENDED,
                                        DataEventType.BACKFILL_COMPLETED,
                                    },
                                )
                            except Exception as exc:
                                failed.append({"interval": iv, "error": str(exc)})
                                release_stream = getattr(dm, "release_stream", None)
                                if callable(release_stream):
                                    try:
                                        await release_stream(
                                            symbol,
                                            iv,
                                            exchange=exchange,
                                            market_type=market_type,
                                            focus_scope="websocket",
                                            consumer_id=consumer_id,
                                        )
                                    except Exception:
                                        pass
                                continue
                            subscriptions[iv] = handle
                            active_intervals.add(iv)
                            subscribed_now.append(iv)

                    if failed:
                        await safe_send_json({
                            "type": "warning",
                            "detail": "Some intervals could not be subscribed",
                            "failed": failed,
                        })

                    await safe_send_json({
                        "type": "subscribed",
                        "exchange": exchange,
                        "symbol": symbol,
                        "intervals": subscribed_now,
                        "market_type": market_type,
                    })

                elif action == "unsubscribe":
                    for iv in valid:
                        was_active = iv in active_intervals
                        active_intervals.discard(iv)
                        handle = subscriptions.pop(iv, None)
                        if handle is not None:
                            try:
                                dm.unsubscribe(handle)
                            except Exception:
                                pass
                        if was_active:
                            release_stream = getattr(dm, "release_stream", None)
                            if callable(release_stream):
                                try:
                                    await release_stream(
                                        symbol,
                                        iv,
                                        exchange=exchange,
                                        market_type=market_type,
                                        focus_scope="websocket",
                                        consumer_id=consumer_id,
                                    )
                                except Exception:
                                    pass
                    await safe_send_json({
                        "type": "unsubscribed",
                        "exchange": exchange,
                        "symbol": symbol,
                        "intervals": valid,
                        "market_type": market_type,
                    })

                else:
                    await safe_send_json({
                        "type": "error",
                        "detail": f"Unknown action: {action}",
                    })

        except WebSocketDisconnect:
            ws_closed = True

        forwarder_task.cancel()
        try:
            await forwarder_task
        except (asyncio.CancelledError, Exception):
            pass

    finally:
        ws_closed = True
        release_stream = getattr(dm, "release_stream", None)
        intervals_to_release = list(active_intervals)
        for handle in list(subscriptions.values()):
            try:
                dm.unsubscribe(handle)
            except Exception:
                pass
        if callable(release_stream):
            for iv in intervals_to_release:
                try:
                    await release_stream(
                        symbol,
                        iv,
                        exchange=exchange,
                        market_type=market_type,
                        focus_scope="websocket",
                        consumer_id=consumer_id,
                    )
                except Exception:
                    pass
        active_intervals.clear()
        subscriptions.clear()


async def forward_events_to_ws(
    websocket: WebSocket,
    dm,
    symbol: str,
    intervals: list[str],
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Forward DataManager K-line events to a WebSocket client."""
    for interval in intervals:
        async for event in dm.subscribe_iter(
            symbol=symbol,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
            event_types={
                DataEventType.BAR_CREATED,
                DataEventType.BAR_UPDATED,
                DataEventType.BAR_CLOSED,
                DataEventType.BAR_AMENDED,
                DataEventType.BACKFILL_COMPLETED,
            },
        ):
            if event.event_type == DataEventType.BACKFILL_COMPLETED:
                if not should_forward_browser_event(event):
                    continue
                try:
                    await send_json_with_timeout(websocket, {
                        "type": "backfill_completed",
                        "exchange": event.key.exchange,
                        "symbol": event.key.symbol,
                        "interval": event.key.interval,
                        "market_type": event.key.market_type,
                        "detail": event.detail or {},
                    })
                except Exception:
                    return
                continue
            bar_dict = {
                "type": "kline",
                "exchange": event.key.exchange,
                "symbol": event.key.symbol,
                "interval": event.key.interval,
                "market_type": event.key.market_type,
                "data": event.bar.to_kline_dict() if event.bar else {},
            }
            bar_dict["data"]["is_closed"] = event.event_type in {
                DataEventType.BAR_CLOSED,
                DataEventType.BAR_AMENDED,
            }

            try:
                await send_json_with_timeout(websocket, bar_dict)
            except Exception:
                return


async def read_client_messages(websocket: WebSocket) -> None:
    """Read and handle client messages for simple K-line streams."""
    try:
        while True:
            message = await websocket.receive_text()
            if message.lower().strip() == "ping":
                await send_text_with_timeout(websocket, "pong")
    except WebSocketDisconnect:
        pass
