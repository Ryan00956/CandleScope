"""Bounded multi-instrument K-line WebSocket transport.

The endpoint is additive and default-off.  One browser connection owns many
stable logical subscription IDs while DataManager remains the only owner of
physical stream lifecycle and EventBus fan-out.
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_klines import (
    _KlineWsOutbox,
    _require_active_stream_info,
    _serialize_kline_event,
    _subscription_failure,
    should_forward_browser_event,
)
from app.api.v1.stream_utils import (
    normalize_market_type,
    send_json_with_timeout,
    send_text_with_timeout,
    validate_ws_interval,
)
from app.core import config
from app.data_engine.data_manager import StreamCapacityError
from app.data_engine.data_manager.models import DataEventType
from app.data_engine.interval_policy import parse_interval_spec
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.symbols import normalize_symbol


KLINE_BATCH_PROTOCOL = "candlescope.kline-batch/1"
_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_.:@|/-]{1,128}$")
_EVENT_TYPES = {
    DataEventType.BAR_CREATED,
    DataEventType.BAR_UPDATED,
    DataEventType.BAR_CLOSED,
    DataEventType.BAR_AMENDED,
    DataEventType.BACKFILL_COMPLETED,
}


@dataclass(frozen=True, slots=True)
class KlineBatchLimits:
    max_series_per_client: int
    max_intervals_per_series: int
    max_total_subscriptions: int
    outbox_size: int
    app_max_active_series: int

    @classmethod
    def from_config(cls) -> "KlineBatchLimits":
        return cls(
            max_series_per_client=max(
                1,
                int(config.KLINE_BATCH_MAX_SERIES_PER_CLIENT),
            ),
            max_intervals_per_series=max(
                1,
                int(config.KLINE_BATCH_MAX_INTERVALS_PER_SERIES),
            ),
            max_total_subscriptions=max(
                1,
                int(config.KLINE_BATCH_MAX_TOTAL_SUBSCRIPTIONS),
            ),
            outbox_size=max(1, int(config.KLINE_BATCH_OUTBOX_SIZE)),
            app_max_active_series=max(1, int(config.KLINE_APP_MAX_ACTIVE_SERIES)),
        )

    def to_wire(self) -> dict[str, int]:
        return {
            "maxSeriesPerClient": self.max_series_per_client,
            "maxIntervalsPerSeries": self.max_intervals_per_series,
            "maxTotalSubscriptions": self.max_total_subscriptions,
            "outboxSize": self.outbox_size,
            "appMaxActiveSeries": self.app_max_active_series,
        }


@dataclass(slots=True)
class _BatchSubscription:
    client_id: str
    exchange: str
    market_type: str
    symbol: str
    consumer_id: str
    handles: dict[str, Any] = field(default_factory=dict)

    @property
    def intervals(self) -> set[str]:
        return set(self.handles)

    @property
    def series_key(self) -> tuple[str, str, str]:
        return (self.exchange, self.market_type, self.symbol)


class KlineBatchConnectionRegistry:
    """Process-owned diagnostics registry; it never owns socket lifecycle."""

    def __init__(self) -> None:
        self._connections: dict[str, "KlineBatchConnection"] = {}
        self.opened = 0
        self.closed = 0

    def register(self, connection: "KlineBatchConnection") -> None:
        self._connections[connection.connection_id] = connection
        self.opened += 1

    def unregister(self, connection: "KlineBatchConnection") -> None:
        if self._connections.pop(connection.connection_id, None) is not None:
            self.closed += 1

    def snapshot(self, *, offset: int = 0, limit: int = 20) -> dict[str, Any]:
        safe_offset = max(0, int(offset))
        safe_limit = min(100, max(0, int(limit)))
        ordered = [
            self._connections[key]
            for key in sorted(self._connections)
        ]
        summaries = [connection.snapshot() for connection in ordered]
        return {
            "protocol": KLINE_BATCH_PROTOCOL,
            "enabled": bool(config.KLINE_BATCH_STREAM_ENABLED),
            "websocket_connections": len(summaries),
            "logical_clients": sum(item["logical_series"] for item in summaries),
            "logical_series": sum(item["logical_series"] for item in summaries),
            "logical_subscriptions": sum(
                item["logical_subscriptions"] for item in summaries
            ),
            "outbox_depth": sum(item["outbox"]["depth"] for item in summaries),
            "outbox_dropped_replaceable": sum(
                item["outbox"]["dropped_replaceable"] for item in summaries
            ),
            "outbox_authoritative_timeouts": sum(
                item["outbox"]["authoritative_timeouts"] for item in summaries
            ),
            "opened": self.opened,
            "closed": self.closed,
            "limits": KlineBatchLimits.from_config().to_wire(),
            "detail_offset": safe_offset,
            "detail_limit": safe_limit,
            "detail_total": len(summaries),
            "connections": summaries[safe_offset:safe_offset + safe_limit],
        }


def kline_batch_registry_from_state(state: Any) -> KlineBatchConnectionRegistry:
    registry = getattr(state, "kline_batch_registry", None)
    if isinstance(registry, KlineBatchConnectionRegistry):
        return registry
    registry = KlineBatchConnectionRegistry()
    setattr(state, "kline_batch_registry", registry)
    return registry


class _ItemError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class KlineBatchConnection:
    def __init__(
        self,
        websocket: WebSocket,
        dm: Any,
        *,
        limits: KlineBatchLimits,
        connection_id: str | None = None,
    ) -> None:
        self.websocket = websocket
        self.dm = dm
        self.limits = limits
        self.connection_id = connection_id or f"batch-{id(websocket)}"
        self.subscriptions: dict[str, _BatchSubscription] = {}
        self.outbox = _KlineWsOutbox(maxsize=limits.outbox_size)
        self.closed = False
        self.commands = 0
        self.item_acks = 0
        self.item_failures = 0
        self._send_lock = asyncio.Lock()

    async def run(self) -> None:
        forwarder = asyncio.create_task(
            self._forward(),
            name=f"kline-batch-forward:{self.connection_id}",
        )
        try:
            while not self.closed:
                raw = await self.websocket.receive_text()
                if raw.strip().lower() == "ping":
                    await self._safe_send_text("pong")
                    continue
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    await self._send_command_error(None, "invalid_json", "Invalid JSON")
                    continue
                await self._handle_command(message)
        except WebSocketDisconnect:
            self.closed = True
        finally:
            self.closed = True
            forwarder.cancel()
            try:
                await forwarder
            except (asyncio.CancelledError, Exception):
                pass
            await self.close()

    async def close(self) -> None:
        subscriptions = list(self.subscriptions.values())
        self.subscriptions.clear()
        for subscription in subscriptions:
            await self._release_subscription(subscription)

    async def _forward(self) -> None:
        while not self.closed:
            message = await self.outbox.get()
            if not await self._safe_send_json(message):
                return

    async def _safe_send_json(self, payload: dict[str, Any]) -> bool:
        if self.closed:
            return False
        try:
            async with self._send_lock:
                await send_json_with_timeout(self.websocket, payload)
            return True
        except Exception:
            self.closed = True
            return False

    async def _safe_send_text(self, payload: str) -> bool:
        if self.closed:
            return False
        try:
            async with self._send_lock:
                await send_text_with_timeout(self.websocket, payload)
            return True
        except Exception:
            self.closed = True
            return False

    async def _handle_command(self, message: Any) -> None:
        self.commands += 1
        if not isinstance(message, dict):
            await self._send_command_error(None, "invalid_command", "command must be an object")
            return
        action = str(message.get("action") or "").strip().lower()
        request_id = message.get("request_id")
        items = message.get("items")
        if action not in {"subscribe", "update", "unsubscribe"}:
            await self._send_command_error(
                request_id,
                "unknown_action",
                f"Unknown action: {action}",
            )
            return
        if not isinstance(items, list) or not items:
            await self._send_command_error(
                request_id,
                "items_required",
                "items must be a non-empty list",
            )
            return
        if len(items) > self.limits.max_series_per_client:
            await self._send_command_error(
                request_id,
                "command_item_limit",
                "command contains too many items",
            )
            return
        for index, raw_item in enumerate(items):
            try:
                if action == "subscribe":
                    ack = await self._subscribe(raw_item)
                elif action == "update":
                    ack = await self._update(raw_item)
                else:
                    ack = await self._unsubscribe(raw_item)
            except _ItemError as exc:
                self.item_failures += 1
                ack = self._failure_ack(
                    action,
                    raw_item,
                    code=exc.code,
                    message=str(exc),
                )
            except StreamCapacityError as exc:
                self.item_failures += 1
                ack = self._failure_ack(
                    action,
                    raw_item,
                    code="kline_app_capacity",
                    message=str(exc),
                )
            except Exception as exc:
                self.item_failures += 1
                ack = self._failure_ack(
                    action,
                    raw_item,
                    code="stream_subscription_failed",
                    message=str(exc),
                )
            ack.update({"request_id": request_id, "item_index": index})
            self.item_acks += 1
            if not await self._safe_send_json(ack):
                return

    async def _subscribe(self, raw_item: Any) -> dict[str, Any]:
        item = self._normalize_item(raw_item, require_intervals=True)
        client_id = item["client_id"]
        existing = self.subscriptions.get(client_id)
        if existing is not None and existing.series_key != item["series_key"]:
            raise _ItemError(
                "client_id_conflict",
                "clientId already owns another instrument; use update",
            )
        if existing is None and len(self.subscriptions) >= self.limits.max_series_per_client:
            raise _ItemError("series_limit", "per-client series limit reached")
        self._require_total_capacity(
            len(set(item["intervals"]) - (existing.intervals if existing else set())),
        )
        subscription = existing or self._new_subscription(item)
        failures = await self._add_intervals(subscription, item["intervals"])
        if subscription.handles:
            self.subscriptions[client_id] = subscription
        return self._success_ack("subscribe", subscription, failures=failures)

    async def _update(self, raw_item: Any) -> dict[str, Any]:
        item = self._normalize_item(raw_item, require_intervals=True)
        client_id = item["client_id"]
        current = self.subscriptions.get(client_id)
        if current is None:
            raise _ItemError("subscription_not_found", "clientId is not subscribed")
        requested = set(item["intervals"])
        if current.series_key != item["series_key"]:
            replacement = self._new_subscription(item)
            self._require_total_capacity(len(requested))
            failures = await self._add_intervals(replacement, item["intervals"])
            if not replacement.handles:
                raise _ItemError(
                    "update_failed",
                    failures[0]["message"] if failures else "replacement has no active intervals",
                )
            self.subscriptions[client_id] = replacement
            await self._release_subscription(current)
            return self._success_ack("update", replacement, failures=failures)

        additions = requested - current.intervals
        self._require_total_capacity(len(additions))
        failures = await self._add_intervals(current, sorted(additions))
        successful_requested = requested - {
            failure["interval"] for failure in failures
        }
        await self._remove_intervals(current, current.intervals - successful_requested)
        if not current.handles:
            self.subscriptions.pop(client_id, None)
        return self._success_ack("update", current, failures=failures)

    async def _unsubscribe(self, raw_item: Any) -> dict[str, Any]:
        if not isinstance(raw_item, dict):
            raise _ItemError("invalid_item", "subscription item must be an object")
        client_id = self._client_id(raw_item)
        current = self.subscriptions.get(client_id)
        if current is None:
            return {
                "type": "subscription_ack",
                "protocol": KLINE_BATCH_PROTOCOL,
                "action": "unsubscribe",
                "ok": True,
                "status": "already_absent",
                "client_id": client_id,
                "active_intervals": [],
            }
        raw_intervals = raw_item.get("intervals")
        if raw_intervals is None:
            remove = current.intervals
        else:
            remove = set(self._normalize_intervals(raw_intervals))
        await self._remove_intervals(current, remove)
        if not current.handles:
            self.subscriptions.pop(client_id, None)
        return self._success_ack("unsubscribe", current)

    def _normalize_item(
        self,
        raw_item: Any,
        *,
        require_intervals: bool,
    ) -> dict[str, Any]:
        if not isinstance(raw_item, dict):
            raise _ItemError("invalid_item", "subscription item must be an object")
        client_id = self._client_id(raw_item)
        exchange = str(raw_item.get("exchange") or "binance").strip().lower()
        bootstrap_default_adapters()
        if not get_exchange_registry().has(exchange):
            raise _ItemError("unknown_exchange", f"Unknown exchange: {exchange}")
        market_type = normalize_market_type(
            str(raw_item.get("market_type") or raw_item.get("marketType") or "spot")
        )
        raw_symbol = str(raw_item.get("symbol") or "").strip()
        if not raw_symbol or len(raw_symbol) > 64:
            raise _ItemError("invalid_symbol", "symbol must be 1..64 characters")
        symbol = normalize_symbol(raw_symbol, exchange=exchange, market_type=market_type)
        intervals = self._normalize_intervals(raw_item.get("intervals"))
        if require_intervals and not intervals:
            raise _ItemError("intervals_required", "intervals must be a non-empty list")
        return {
            "client_id": client_id,
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "intervals": intervals,
            "series_key": (exchange, market_type, symbol),
        }

    @staticmethod
    def _client_id(raw_item: dict[str, Any]) -> str:
        client_id = str(raw_item.get("clientId") or raw_item.get("client_id") or "").strip()
        if not _CLIENT_ID_RE.fullmatch(client_id):
            raise _ItemError(
                "invalid_client_id",
                "clientId must be 1..128 safe identifier characters",
            )
        return client_id

    def _normalize_intervals(self, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        if len(value) > self.limits.max_intervals_per_series:
            raise _ItemError(
                "interval_limit",
                "per-series interval limit reached",
            )
        result: list[str] = []
        for raw_interval in value:
            if not isinstance(raw_interval, str) or not validate_ws_interval(raw_interval):
                raise _ItemError("invalid_interval", f"Unsupported interval: {raw_interval}")
            spec = parse_interval_spec(raw_interval)
            canonical = spec.canonical if spec is not None else raw_interval
            if canonical not in result:
                result.append(canonical)
        return result

    def _new_subscription(self, item: dict[str, Any]) -> _BatchSubscription:
        client_id = item["client_id"]
        return _BatchSubscription(
            client_id=client_id,
            exchange=item["exchange"],
            market_type=item["market_type"],
            symbol=item["symbol"],
            consumer_id=f"ws:klines_batch:{self.connection_id}:{client_id}",
        )

    def _require_total_capacity(self, additions: int) -> None:
        projected = self.logical_subscription_count + max(0, int(additions))
        if projected > self.limits.max_total_subscriptions:
            raise _ItemError(
                "total_subscription_limit",
                "per-client total subscription limit reached",
            )

    async def _add_intervals(
        self,
        subscription: _BatchSubscription,
        intervals: list[str] | set[str],
    ) -> list[dict[str, str]]:
        failures: list[dict[str, str]] = []
        for interval in intervals:
            if interval in subscription.handles:
                continue
            try:
                info = await self.dm.ensure_stream(
                    subscription.symbol,
                    interval,
                    exchange=subscription.exchange,
                    market_type=subscription.market_type,
                    focus_scope="websocket",
                    subscription_tier="batch",
                    consumer_id=subscription.consumer_id,
                )
                _require_active_stream_info(info, interval)
                callback = self._event_callback(subscription.client_id)
                handle = self.dm.subscribe(
                    callback=callback,
                    symbol=subscription.symbol,
                    interval=interval,
                    exchange=subscription.exchange,
                    market_type=subscription.market_type,
                    event_types=_EVENT_TYPES,
                )
            except StreamCapacityError:
                raise
            except Exception as exc:
                failures.append(_subscription_failure(interval, exc))
                await self._release_stream(subscription, interval)
                continue
            subscription.handles[interval] = handle
        return failures

    def _event_callback(self, client_id: str) -> Callable[[Any], Any]:
        async def callback(event: Any) -> None:
            if self.closed or not should_forward_browser_event(event):
                return
            key = (
                client_id,
                event.key.exchange,
                event.key.market_type,
                event.key.symbol,
                event.key.interval,
            )
            if event.event_type == DataEventType.BACKFILL_COMPLETED:
                payload = {
                    "type": "backfill_completed",
                    "protocol": KLINE_BATCH_PROTOCOL,
                    "client_id": client_id,
                    "exchange": event.key.exchange,
                    "market_type": event.key.market_type,
                    "symbol": event.key.symbol,
                    "interval": event.key.interval,
                    "detail": event.detail or {},
                }
                queued = await self.outbox.put(payload, key=key, timeout=1.0)
            else:
                payload = _serialize_kline_event(event)
                payload.update({
                    "protocol": KLINE_BATCH_PROTOCOL,
                    "client_id": client_id,
                })
                queued = await self.outbox.put(
                    payload,
                    key=key,
                    replaceable=event.event_type == DataEventType.BAR_UPDATED,
                    timeout=1.0,
                )
            if not queued and event.event_type != DataEventType.BAR_UPDATED:
                self.closed = True
                try:
                    await self.websocket.close(
                        code=1013,
                        reason="authoritative K-line outbox exhausted",
                    )
                except Exception:
                    pass

        return callback

    async def _remove_intervals(
        self,
        subscription: _BatchSubscription,
        intervals: set[str],
    ) -> None:
        for interval in sorted(intervals):
            handle = subscription.handles.pop(interval, None)
            if handle is not None:
                try:
                    self.dm.unsubscribe(handle)
                except Exception:
                    pass
                await self._release_stream(subscription, interval)

    async def _release_subscription(self, subscription: _BatchSubscription) -> None:
        await self._remove_intervals(subscription, subscription.intervals)

    async def _release_stream(
        self,
        subscription: _BatchSubscription,
        interval: str,
    ) -> None:
        release = getattr(self.dm, "release_stream", None)
        if not callable(release):
            return
        try:
            await release(
                subscription.symbol,
                interval,
                exchange=subscription.exchange,
                market_type=subscription.market_type,
                focus_scope="websocket",
                subscription_tier="batch",
                consumer_id=subscription.consumer_id,
            )
        except Exception:
            pass

    def _success_ack(
        self,
        action: str,
        subscription: _BatchSubscription,
        *,
        failures: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        failed = failures or []
        return {
            "type": "subscription_ack",
            "protocol": KLINE_BATCH_PROTOCOL,
            "action": action,
            "ok": not failed,
            "status": "partial" if failed else "ok",
            "client_id": subscription.client_id,
            "exchange": subscription.exchange,
            "market_type": subscription.market_type,
            "symbol": subscription.symbol,
            "active_intervals": sorted(subscription.intervals),
            "failed": failed,
        }

    def _failure_ack(
        self,
        action: str,
        raw_item: Any,
        *,
        code: str,
        message: str,
    ) -> dict[str, Any]:
        client_id = ""
        if isinstance(raw_item, dict):
            client_id = str(
                raw_item.get("clientId") or raw_item.get("client_id") or ""
            ).strip()
        existing = self.subscriptions.get(client_id)
        return {
            "type": "subscription_ack",
            "protocol": KLINE_BATCH_PROTOCOL,
            "action": action,
            "ok": False,
            "status": "failed",
            "client_id": client_id,
            "code": code,
            "message": message,
            "active_intervals": sorted(existing.intervals) if existing else [],
        }

    async def _send_command_error(
        self,
        request_id: Any,
        code: str,
        message: str,
    ) -> None:
        await self._safe_send_json({
            "type": "error",
            "protocol": KLINE_BATCH_PROTOCOL,
            "request_id": request_id,
            "code": code,
            "message": message,
        })

    @property
    def logical_subscription_count(self) -> int:
        return sum(len(subscription.handles) for subscription in self.subscriptions.values())

    def snapshot(self) -> dict[str, Any]:
        by_series: dict[str, int] = {}
        for subscription in self.subscriptions.values():
            label = ":".join(subscription.series_key)
            by_series[label] = by_series.get(label, 0) + len(subscription.handles)
        return {
            "connection_id": self.connection_id,
            "logical_series": len(self.subscriptions),
            "logical_subscriptions": self.logical_subscription_count,
            "commands": self.commands,
            "item_acks": self.item_acks,
            "item_failures": self.item_failures,
            "closed": self.closed,
            "outbox": self.outbox.snapshot(),
            "subscriptions_by_series": dict(sorted(by_series.items())[:64]),
        }


async def stream_batch_kline(
    websocket: WebSocket,
    dm: Any,
    *,
    registry: KlineBatchConnectionRegistry,
) -> None:
    limits = KlineBatchLimits.from_config()
    connection = KlineBatchConnection(websocket, dm, limits=limits)
    registry.register(connection)
    try:
        await send_json_with_timeout(websocket, {
            "type": "connected",
            "protocol": KLINE_BATCH_PROTOCOL,
            "connection_id": connection.connection_id,
            "capabilities": limits.to_wire(),
        })
        await connection.run()
    finally:
        await connection.close()
        registry.unregister(connection)


__all__ = [
    "KLINE_BATCH_PROTOCOL",
    "KlineBatchConnection",
    "KlineBatchConnectionRegistry",
    "KlineBatchLimits",
    "kline_batch_registry_from_state",
    "stream_batch_kline",
]
