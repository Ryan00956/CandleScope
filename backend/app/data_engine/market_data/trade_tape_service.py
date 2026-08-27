"""Shared lifecycle and append fanout for observational CCXT trades."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.data_engine.ingestion.models import MarketEvent, StreamDescriptor, StreamType
from app.exchanges.products import observational_trade_delivery_mode

from .append_hub import AppendBatchHub, AppendBatchSubscription
from .models import MarketChannel, MarketStreamKey
from .trade_tape import ObservedTrade, StreamIdentity, TradeTapeEngine


logger = logging.getLogger("data_engine.market_data.trade_tape")


class _IngestionFactory(Protocol):
    async def start_market(
        self,
        descriptor: StreamDescriptor,
        callback: Any,
        *,
        on_gap: Any | None = None,
    ) -> Any: ...


@dataclass(frozen=True, slots=True)
class TradeTapeAttachment:
    subscription: AppendBatchSubscription[ObservedTrade]
    recent: dict[StreamIdentity, tuple[ObservedTrade, ...]]


@dataclass(slots=True)
class _PhysicalLease:
    handle: Any
    consumers: set[str] = field(default_factory=set)


class TradeTapeService:
    """Own non-repairable raw trade feeds without weakening TradeFlow."""

    def __init__(
        self,
        ingestion_factory: _IngestionFactory,
        *,
        engine: TradeTapeEngine | None = None,
        hub: AppendBatchHub[ObservedTrade] | None = None,
        flush_interval_seconds: float = 0.05,
        max_streams: int = 64,
        max_attach_recent: int = 2_000,
        physical_stop_timeout_seconds: float = 3.0,
    ) -> None:
        self._factory = ingestion_factory
        self.engine = engine or TradeTapeEngine(max_streams=max_streams)
        self.hub = hub or AppendBatchHub[ObservedTrade]()
        self._flush_interval_seconds = max(0.01, float(flush_interval_seconds))
        self._max_streams = max(1, min(int(max_streams), self.engine.max_streams))
        self._max_attach_recent = max(1, int(max_attach_recent))
        self._physical_stop_timeout_seconds = max(
            0.01,
            min(float(physical_stop_timeout_seconds), 30.0),
        )
        self._physical: dict[StreamIdentity, _PhysicalLease] = {}
        self._lock = asyncio.Lock()
        self._flush_task: asyncio.Task[None] | None = None
        self._closed = False
        self._metrics = {
            "events_received": 0,
            "events_invalid": 0,
            "events_duplicate": 0,
            "hub_append_rejected": 0,
            "physical_stop_failures": 0,
        }

    async def ensure_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
        identity = self._validate_key(key)
        consumer = _consumer_id(consumer_id)
        async with self._lock:
            self._ensure_open()
            existing = self._physical.get(identity)
            if existing is not None:
                if consumer in existing.consumers:
                    return False
                existing.consumers.add(consumer)
                return True
            if len(self._physical) >= self._max_streams:
                raise RuntimeError(f"trade-tape stream limit reached ({self._max_streams})")
            if not self.engine.activate_stream(identity):
                raise RuntimeError("trade-tape engine identity is already active")
            reservation = _PhysicalLease(handle=None)
            self._physical[identity] = reservation
            self._start_flusher()

        async def _on_event(event: MarketEvent) -> None:
            if identity not in self._physical:
                return
            self._metrics["events_received"] += 1
            try:
                record = self.engine.ingest(event)
            except (TypeError, ValueError):
                self._metrics["events_invalid"] += 1
                logger.debug("Rejected invalid observational trade", exc_info=True)
                return
            if record is None:
                self._metrics["events_duplicate"] += 1
                return
            if not self.hub.append(record):
                self._metrics["hub_append_rejected"] += 1

        try:
            handle = await self._factory.start_market(_descriptor(identity), _on_event)
        except BaseException:
            async with self._lock:
                if self._physical.get(identity) is reservation:
                    self._physical.pop(identity, None)
                    self.engine.deactivate_stream(identity)
            raise

        close_after_start = False
        async with self._lock:
            if self._closed or self._physical.get(identity) is not reservation:
                close_after_start = True
            else:
                reservation.handle = handle
                reservation.consumers.add(consumer)
        if close_after_start:
            await handle.stop()
            raise RuntimeError("trade-tape service closed while stream was starting")
        return True

    async def release_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
        identity = _normalize_key(key)
        consumer = _consumer_id(consumer_id)
        async with self._lock:
            entry = self._physical.get(identity)
            if entry is None or consumer not in entry.consumers:
                return False
            if len(entry.consumers) > 1:
                entry.consumers.remove(consumer)
                return True
            entry.consumers.remove(consumer)
        try:
            if entry.handle is not None:
                stopped = await asyncio.wait_for(
                    entry.handle.stop(),
                    timeout=self._physical_stop_timeout_seconds,
                )
                if stopped is False:
                    raise RuntimeError("ingestion handle reported stop failure")
        except BaseException:
            self._metrics["physical_stop_failures"] += 1
            async with self._lock:
                entry.consumers.add(consumer)
            raise
        async with self._lock:
            if self._physical.get(identity) is entry:
                self._physical.pop(identity, None)
                self.engine.deactivate_stream(identity)
        return True

    def recent(self, key: MarketStreamKey, *, limit: int = 500) -> list[ObservedTrade]:
        self._ensure_open()
        identity = self._validate_key(key)
        bounded = max(0, min(int(limit), self._max_attach_recent))
        return list(self.engine.raw_tail(identity, bounded))

    def attach(
        self,
        keys: MarketStreamKey | Iterable[MarketStreamKey],
        *,
        recent_limit: int = 500,
        max_pending_records: int | None = None,
    ) -> TradeTapeAttachment:
        self._ensure_open()
        requested = [keys] if isinstance(keys, MarketStreamKey) else list(keys)
        identities = tuple(dict.fromkeys(self._validate_key(key) for key in requested))
        if not identities:
            raise ValueError("trade-tape attachment requires at least one identity")
        bounded = max(0, min(int(recent_limit), self._max_attach_recent))
        identity_set = frozenset(identities)
        self.hub.flush_all()
        subscription = self.hub.subscribe(
            max_pending_records=max_pending_records,
            predicate=lambda record: record.stream_identity in identity_set,
        )
        recent = {
            identity: self.engine.raw_tail(identity, bounded) if bounded else ()
            for identity in identities
        }
        return TradeTapeAttachment(subscription=subscription, recent=recent)

    def diagnostics(self) -> dict[str, Any]:
        return {
            "state": "closed" if self._closed else "running" if self._physical else "idle",
            "delivery": "append_observational",
            "sequence_continuity": False,
            "history": False,
            "physical_streams": len(self._physical),
            "logical_leases": sum(len(item.consumers) for item in self._physical.values()),
            "engine": self.engine.diagnostics(),
            "hub": self.hub.diagnostics(),
            **self._metrics,
        }

    async def shutdown(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            entries = tuple(self._physical.items())
            self._physical.clear()
        for identity, entry in entries:
            try:
                if entry.handle is not None:
                    await asyncio.wait_for(
                        entry.handle.stop(),
                        timeout=self._physical_stop_timeout_seconds,
                    )
            except BaseException:
                self._metrics["physical_stop_failures"] += 1
            self.engine.deactivate_stream(identity)
        if self._flush_task is not None:
            self._flush_task.cancel()
            await asyncio.gather(self._flush_task, return_exceptions=True)
        self.hub.flush_all()
        await self.hub.close(flush=False)

    def _start_flusher(self) -> None:
        if self._flush_task is None:
            self._flush_task = asyncio.create_task(
                self._flush_loop(),
                name="trade-tape-flush",
            )

    async def _flush_loop(self) -> None:
        while not self._closed:
            await asyncio.sleep(self._flush_interval_seconds)
            self.hub.flush_all()

    @staticmethod
    def _validate_key(key: MarketStreamKey) -> StreamIdentity:
        from app.exchanges import bootstrap_default_adapters, get_exchange_registry

        identity = _normalize_key(key)
        bootstrap_default_adapters()
        try:
            capabilities = get_exchange_registry().get_plugin(identity[0]).capabilities()
        except KeyError as exc:
            raise ValueError(str(exc)) from exc
        if observational_trade_delivery_mode(capabilities, identity[1]) is None:
            raise ValueError(
                f"{identity[0]}:{identity[1]}:trade does not support the "
                "observational tape product",
            )
        return identity

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("trade-tape service is closed")


def _normalize_key(key: MarketStreamKey) -> StreamIdentity:
    if not isinstance(key, MarketStreamKey):
        raise TypeError("trade-tape key must be a MarketStreamKey")
    if key.channel is not MarketChannel.TRADE or key.params:
        raise ValueError("trade-tape service only accepts parameterless trade keys")
    return key.exchange, key.market_type, key.symbol


def _descriptor(identity: StreamIdentity) -> StreamDescriptor:
    from app.exchanges import bootstrap_default_adapters, get_exchange_registry

    bootstrap_default_adapters()
    try:
        capabilities = get_exchange_registry().get_plugin(identity[0]).capabilities()
    except KeyError:
        # Unit-test/embedded factories may inject a validated synthetic
        # identity. Production identities are rejected earlier by
        # ``_validate_key``.
        capabilities = None
    capability = (
        capabilities.channel_capability(MarketChannel.TRADE, identity[1])
        if capabilities is not None
        else None
    )
    declared = tuple(
        int(value)
        for value in getattr(capability, "update_intervals_ms", ())
        if isinstance(value, int) and not isinstance(value, bool) and value > 0
    )
    rate_limit_ms = getattr(capabilities, "limits", {}).get("ccxt.rate_limit_ms", 0)
    poll_interval_ms = max(
        1000,
        min(declared) if declared else 0,
        rate_limit_ms if isinstance(rate_limit_ms, int) else 0,
    )
    return StreamDescriptor(
        symbol=identity[2],
        stream_type=StreamType.TRADE,
        exchange=identity[0],
        market_type=identity[1],
        poll_interval_seconds=poll_interval_ms / 1000.0,
    )


def _consumer_id(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("trade-tape consumer_id cannot be blank")
    return value.strip()


__all__ = ["TradeTapeAttachment", "TradeTapeService"]
