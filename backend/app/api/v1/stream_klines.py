"""K-line WebSocket handlers backed by DataManager events."""
from __future__ import annotations

import asyncio
import json
from collections import deque
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_utils import (
    send_json_with_timeout,
    send_text_with_timeout,
    validate_ws_interval,
)
from app.data_engine.data_manager.models import DataEventType, StreamStatus
from app.data_engine.interval_policy import parse_interval_spec
from app.data_engine.interval_resolution import IntervalResolutionError


@dataclass(slots=True)
class _LatestKlineMessage:
    key: tuple[str, ...]
    message: dict[str, Any]
    authoritative_after: dict[str, Any] | None = None


class _KlineWsOutbox:
    """Bounded WS outbox with one replaceable forming update per series."""

    def __init__(self, maxsize: int = 1000) -> None:
        self._queue: asyncio.Queue[_LatestKlineMessage | dict[str, Any]] = (
            asyncio.Queue(maxsize=max(1, int(maxsize)))
        )
        self._latest: dict[tuple[str, ...], _LatestKlineMessage] = {}
        self._front: deque[dict[str, Any]] = deque()
        self._attached_authoritative = 0
        self.enqueued = 0
        self.replaced = 0
        self.authoritative_supersedes = 0
        self.dropped_replaceable = 0
        self.authoritative_timeouts = 0
        self.max_depth = 0

    async def put(
        self,
        message: dict[str, Any],
        *,
        key: tuple[str, ...] | None = None,
        replaceable: bool = False,
        timeout: float = 1.0,
    ) -> bool:
        if replaceable and key is not None:
            pending = self._latest.get(key)
            if pending is not None:
                pending.message = message
                self.replaced += 1
                return True
            pending = _LatestKlineMessage(key=key, message=message)
            try:
                self._queue.put_nowait(pending)
            except asyncio.QueueFull:
                self.dropped_replaceable += 1
                return False
            self._latest[key] = pending
            self.enqueued += 1
            self.max_depth = max(self.max_depth, self._queue.qsize())
            return True

        pending = self._latest.get(key) if key is not None else None
        if pending is not None and key is not None:
            # Preserve the existing forming -> final ordering while letting
            # the authoritative event share its own forming message's physical
            # queue slot.  This prevents a full queue from dropping the final
            # solely because that same key's replaceable update occupies it.
            pending.authoritative_after = message
            self._attached_authoritative += 1
            if self._latest.get(key) is pending:
                self._latest.pop(key, None)
            self.authoritative_supersedes += 1
            self.max_depth = max(self.max_depth, self._logical_depth())
            return True
        try:
            await asyncio.wait_for(self._queue.put(message), timeout=timeout)
            # Keep the old forming slot indexed until the final/correction is
            # actually queued.  A timeout must not allow duplicate forming
            # slots to accumulate behind an unindexed pending item.
            if key is not None and self._latest.get(key) is pending:
                self._latest.pop(key, None)
            self.enqueued += 1
            self.max_depth = max(self.max_depth, self._queue.qsize())
            return True
        except asyncio.TimeoutError:
            self.authoritative_timeouts += 1
            return False

    async def get(self) -> dict[str, Any]:
        if self._front:
            return self._front.popleft()
        item = await self._queue.get()
        if isinstance(item, _LatestKlineMessage):
            if self._latest.get(item.key) is item:
                self._latest.pop(item.key, None)
            if item.authoritative_after is not None:
                self._attached_authoritative = max(
                    0,
                    self._attached_authoritative - 1,
                )
                self._front.append(item.authoritative_after)
            return item.message
        return item

    def _logical_depth(self) -> int:
        return (
            self._queue.qsize()
            + len(self._front)
            + self._attached_authoritative
        )

    def snapshot(self) -> dict[str, int]:
        return {
            "depth": self._logical_depth(),
            "physical_depth": self._queue.qsize(),
            "maxsize": self._queue.maxsize,
            "forming_slots": len(self._latest),
            "enqueued": self.enqueued,
            "replaced": self.replaced,
            "authoritative_supersedes": self.authoritative_supersedes,
            "dropped_replaceable": self.dropped_replaceable,
            "authoritative_timeouts": self.authoritative_timeouts,
            "max_depth": self.max_depth,
        }


def _subscription_failure(interval: str, exc: Exception) -> dict[str, str]:
    """Return the stable, client-facing shape for one rejected interval."""
    if isinstance(exc, IntervalResolutionError):
        detail = exc.to_dict()
        return {
            "interval": detail.get("interval") or interval,
            "code": detail["code"],
            "message": detail["message"],
        }
    return {
        "interval": interval,
        "code": "stream_subscription_failed",
        "message": str(exc),
    }


def _require_active_stream_info(info: Any, interval: str) -> None:
    """Reject explicit non-active coordinator results from facade/test doubles."""
    status = getattr(info, "status", None)
    if status is None:
        # Compatibility with legacy facades that return None after a
        # successful ensure.  DataManager itself always returns StreamInfo.
        return
    status_value = status.value if isinstance(status, StreamStatus) else str(status)
    if status_value == StreamStatus.ACTIVE.value:
        return
    error = getattr(info, "error", None)
    detail = f"stream {interval} is {status_value}"
    if error:
        detail = f"{detail}: {error}"
    raise RuntimeError(detail)


def _with_request_id(payload: dict[str, Any], message: dict[str, Any]) -> dict[str, Any]:
    """Echo an optional request identifier without changing legacy messages."""
    if "request_id" in message:
        payload["request_id"] = message.get("request_id")
    return payload


def should_forward_browser_event(event) -> bool:
    """Return whether a DataManager event should be sent to browser K-line clients."""
    if event.event_type != DataEventType.BACKFILL_COMPLETED:
        return True
    return getattr(event, "audience", "user") != "internal"


def _serialize_kline_event(event) -> dict[str, Any]:
    """Serialize a bar event without erasing its lifecycle semantics.

    ``is_closed`` alone cannot distinguish an ordinary close from a historical
    correction.  Keeping the event type in the envelope lets browser caches
    apply ``bar.amended`` to an interior timestamp while older clients can
    continue to rely on the existing payload shape.
    """
    data = event.bar.to_kline_dict() if event.bar else {}
    data["is_closed"] = event.event_type in {
        DataEventType.BAR_CLOSED,
        DataEventType.BAR_AMENDED,
    }
    return {
        "type": "kline",
        "event_type": event.event_type.value,
        "exchange": event.key.exchange,
        "symbol": event.key.symbol,
        "interval": event.key.interval,
        "market_type": event.key.market_type,
        "data": data,
    }


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
        try:
            info = await dm.ensure_stream(
                symbol,
                interval,
                exchange=exchange,
                market_type=market_type,
                focus_scope="websocket",
                consumer_id=consumer_id,
            )
            _require_active_stream_info(info, interval)
        except Exception as exc:
            failure = _subscription_failure(interval, exc)
            await send_json_with_timeout(websocket, {
                "type": "error",
                "detail": "Stream could not be subscribed",
                "failed": [failure],
            })
            return

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

            bar_dict = _serialize_kline_event(event)
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
                                info = await dm.ensure_stream(
                                    symbol,
                                    iv,
                                    exchange=exchange,
                                    market_type=market_type,
                                    focus_scope="websocket",
                                    consumer_id=consumer_id,
                                )
                                _require_active_stream_info(info, iv)
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
                                failed.append(_subscription_failure(iv, exc))
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
                            "failed": [
                                {
                                    "interval": failure["interval"],
                                    "error": failure["message"],
                                }
                                for failure in failed
                            ],
                        })

                    await safe_send_json(_with_request_id({
                        "type": "subscribed",
                        "exchange": exchange,
                        "symbol": symbol,
                        "intervals": subscribed_now,
                        "requested_intervals": valid,
                        "failed": failed,
                        "active_intervals": sorted(active_intervals),
                        "market_type": market_type,
                    }, msg))

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
                    await safe_send_json(_with_request_id({
                        "type": "unsubscribed",
                        "exchange": exchange,
                        "symbol": symbol,
                        "intervals": valid,
                        "active_intervals": sorted(active_intervals),
                        "market_type": market_type,
                    }, msg))

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
            bar_dict = _serialize_kline_event(event)

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
