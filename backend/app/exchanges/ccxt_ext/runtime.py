"""Shared, reference-counted CCXT Pro runtimes."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor

from .models import CcxtLifecycleEvent, CcxtRawMarketEvent
from .profile import CcxtExchangeProfile

logger = logging.getLogger("ingestion.ccxt.runtime")
RawSubscriber = Callable[[CcxtRawMarketEvent], None]
LifecycleSubscriber = Callable[[CcxtLifecycleEvent], None]


class CcxtRuntime:
    """One CCXT exchange instance shared by many lightweight stream sessions."""

    def __init__(
        self,
        profile: CcxtExchangeProfile,
        config: IngestionConfig,
    ) -> None:
        self.profile = profile
        self.config = config
        self._raw_subscribers: dict[str, tuple[StreamDescriptor, RawSubscriber]] = {}
        self._lifecycle_subscribers: dict[str, LifecycleSubscriber] = {}
        self._started = False
        self._closed = False
        self._raw_events = 0
        self._lifecycle_events = 0
        self._websocket_recycles = 0
        self.exchange = profile.create_exchange(
            config,
            raw_event_sink=self._on_raw_event,
            lifecycle_sink=self._on_lifecycle_event,
        )

    async def start(self) -> None:
        if self._started:
            return
        if self._closed:
            raise RuntimeError("CCXT runtime is already closed")
        await self.exchange.load_markets()
        self._started = True

    def subscribe(
        self,
        descriptor: StreamDescriptor,
        raw_callback: RawSubscriber,
        lifecycle_callback: LifecycleSubscriber,
    ) -> str:
        if not self._started or self._closed:
            raise RuntimeError("CCXT runtime is not available")
        self._validate_unambiguous_routing(descriptor)
        token = uuid.uuid4().hex
        self._raw_subscribers[token] = (descriptor, raw_callback)
        self._lifecycle_subscribers[token] = lifecycle_callback
        return token

    def unsubscribe(self, token: str) -> None:
        self._raw_subscribers.pop(token, None)
        self._lifecycle_subscribers.pop(token, None)

    def resolve_symbol(self, descriptor: StreamDescriptor) -> str:
        return self.profile.resolve_symbol(self.exchange, descriptor)

    async def watch(self, descriptor: StreamDescriptor, symbol: str) -> Any:
        return await self.profile.watch(self.exchange, descriptor, symbol)

    async def recycle_websockets(self) -> int:
        """Close live WS clients without closing the shared REST/runtime state.

        This is used by controlled recovery drills.  Stream sessions observe
        the cancelled CCXT subscription futures and reconnect through their
        normal supervised watch loop.
        """

        if not self._started or self._closed:
            raise RuntimeError("CCXT runtime is not available")
        clients = getattr(self.exchange, "clients", None)
        closer = getattr(self.exchange, "close_ws_clients", None)
        if not isinstance(clients, dict) or not callable(closer):
            raise TypeError("CCXT exchange does not expose recyclable WS clients")
        count = len(clients)
        await closer()
        self._websocket_recycles += 1
        return count

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._raw_subscribers.clear()
        self._lifecycle_subscribers.clear()
        await self.exchange.close()

    def snapshot(self) -> dict[str, Any]:
        return {
            "exchange": self.profile.exchange_id,
            "market_type": self.profile.market_type,
            "started": self._started,
            "closed": self._closed,
            "subscribers": len(self._raw_subscribers),
            "raw_events": self._raw_events,
            "lifecycle_events": self._lifecycle_events,
            "websocket_recycles": self._websocket_recycles,
        }

    def _on_raw_event(self, event: CcxtRawMarketEvent) -> None:
        self._raw_events += 1
        for descriptor, callback in tuple(self._raw_subscribers.values()):
            if self.profile.matches(event, descriptor):
                callback(event)

    def _on_lifecycle_event(self, event: CcxtLifecycleEvent) -> None:
        self._lifecycle_events += 1
        for callback in tuple(self._lifecycle_subscribers.values()):
            callback(event)

    def _validate_unambiguous_routing(self, descriptor: StreamDescriptor) -> None:
        """Fail closed when a raw payload cannot identify its subscription.

        Binance depth messages contain symbol and sequence but not requested
        update speed.  Two speeds for the same symbol therefore cannot be
        demultiplexed safely from one shared exchange instance.
        """

        from app.data_engine.ingestion.models import StreamType

        if descriptor.stream_type != StreamType.FULL_DEPTH:
            return
        requested_rate = descriptor.update_interval_ms or 250
        for existing, _callback in self._raw_subscribers.values():
            if (
                existing.stream_type == StreamType.FULL_DEPTH
                and existing.symbol.upper() == descriptor.symbol.upper()
                and (existing.update_interval_ms or 250) != requested_rate
            ):
                raise RuntimeError(
                    "CCXT raw depth routing is ambiguous for one symbol at "
                    "multiple update speeds"
                )


@dataclass(slots=True)
class _PoolEntry:
    runtime: CcxtRuntime
    start_task: asyncio.Task[None]
    references: int = 0


class CcxtRuntimePool:
    """Process-local pool keyed by exchange, market, and connection config."""

    def __init__(self) -> None:
        self._entries: dict[tuple[str, ...], _PoolEntry] = {}
        self._lock = asyncio.Lock()

    async def acquire(
        self,
        profile: CcxtExchangeProfile,
        config: IngestionConfig,
    ) -> CcxtRuntime:
        key = profile.runtime_key(config)
        async with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                runtime = CcxtRuntime(profile, config)
                entry = _PoolEntry(
                    runtime=runtime,
                    start_task=asyncio.create_task(
                        runtime.start(),
                        name=f"ccxt_runtime_start_{profile.exchange_id}_{profile.market_type}",
                    ),
                )
                self._entries[key] = entry
            entry.references += 1
        try:
            await asyncio.shield(entry.start_task)
        except asyncio.CancelledError:
            should_close = False
            async with self._lock:
                current = self._entries.get(key)
                if current is entry:
                    entry.references -= 1
                    if entry.references <= 0:
                        self._entries.pop(key, None)
                        should_close = True
            if should_close:
                await asyncio.shield(
                    asyncio.gather(entry.start_task, return_exceptions=True)
                )
                await entry.runtime.close()
            raise
        except BaseException:
            async with self._lock:
                current = self._entries.get(key)
                if current is entry:
                    self._entries.pop(key, None)
            await entry.runtime.close()
            raise
        return entry.runtime

    async def release(self, runtime: CcxtRuntime) -> None:
        key = runtime.profile.runtime_key(runtime.config)
        should_close = False
        async with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry.runtime is not runtime:
                return
            entry.references -= 1
            if entry.references <= 0:
                self._entries.pop(key, None)
                should_close = True
        if should_close:
            await runtime.close()

    def snapshot(self) -> dict[str, Any]:
        return {
            "runtimes": {
                "|".join(key): {
                    **entry.runtime.snapshot(),
                    "references": entry.references,
                }
                for key, entry in self._entries.items()
            }
        }

    async def recycle_all_websockets(self) -> dict[str, int]:
        """Recycle every pooled runtime once and report closed client counts."""

        async with self._lock:
            entries = tuple(self._entries.items())
        results: dict[str, int] = {}
        for key, entry in entries:
            results["|".join(key)] = await entry.runtime.recycle_websockets()
        return results


_SHARED_POOL = CcxtRuntimePool()


def get_shared_ccxt_runtime_pool() -> CcxtRuntimePool:
    return _SHARED_POOL
