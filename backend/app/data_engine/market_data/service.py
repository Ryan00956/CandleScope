"""Independent lifecycle and projection service for advanced market data."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

from app.core.executors import run_storage
from app.data_engine.ingestion.models import (
    MarketEvent,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.interval_policy import parse_interval_ms
from app.data_engine.storage.market_metrics_repo import MarketMetricsRepository
from app.exchanges import (
    bootstrap_default_adapters,
    get_exchange_registry,
    get_shared_rate_limit_manager,
)

from .events import HubRecord, MarketStateEvent
from .hub import MarketEventHub, MarketHubSubscription
from .models import MarketChannel, MarketStreamKey
from .storage_writer import MarketMetricStorageWriter


logger = logging.getLogger("data_engine.market_data")

_SUMMARY_CHANNELS = frozenset({
    MarketChannel.MARK_PRICE,
    MarketChannel.INDEX_PRICE,
    MarketChannel.FUNDING_RATE,
    MarketChannel.BASIS,
})
_P1_CHANNELS = _SUMMARY_CHANNELS | {MarketChannel.OPEN_INTEREST}
_HISTORY_STREAM_TYPES = {
    MarketChannel.FUNDING_RATE: StreamType.FUNDING_RATE,
    MarketChannel.OPEN_INTEREST: StreamType.OPEN_INTEREST,
    MarketChannel.LIQUIDATION: StreamType.LIQUIDATION,
}
_DEFAULT_OPEN_INTEREST_STORAGE_PERIOD = "5m"
_DEFAULT_OPEN_INTEREST_STORAGE_BUCKET_MS = 5 * 60 * 1000


@dataclass(slots=True)
class _LogicalLease:
    consumers: set[str] = field(default_factory=set)


@dataclass(slots=True)
class _PhysicalEntry:
    descriptor: StreamDescriptor
    logical_keys: set[MarketStreamKey] = field(default_factory=set)
    handle: Any = None
    stop_task: asyncio.Task | None = None
    stop_error: str | None = None
    stop_attempts: int = 0
    retry_stop_at: float = 0.0


@dataclass(frozen=True, slots=True)
class MarketHistoryPage:
    events: list[MarketStateEvent]
    fallback: bool = False


class MarketDataService:
    """Own logical leases, physical feeds, REST reads, and the typed hub."""

    def __init__(
        self,
        ingestion_factory: Any,
        *,
        hub: MarketEventHub | None = None,
        open_interest_poll_seconds: float = 5.0,
        max_open_interest_streams: int = 64,
        max_summary_streams: int = 512,
        metrics_repository: MarketMetricsRepository | None = None,
        metrics_writer: MarketMetricStorageWriter | None = None,
    ) -> None:
        self._factory = ingestion_factory
        self.hub = hub or MarketEventHub()
        self._open_interest_poll_seconds = max(1.0, float(open_interest_poll_seconds))
        self._max_open_interest_streams = max(1, int(max_open_interest_streams))
        self._max_summary_streams = max(1, int(max_summary_streams))
        self._logical_leases: dict[MarketStreamKey, _LogicalLease] = {}
        self._physical_entries: dict[tuple[str, str, str, str], _PhysicalEntry] = {}
        self._lock = asyncio.Lock()
        self._snapshot_lock = asyncio.Lock()
        self._snapshot_tasks: dict[tuple[str, str, str, str], asyncio.Task] = {}
        self._rate_limits = get_shared_rate_limit_manager()
        self._metrics_repository = metrics_repository
        self._metrics_writer = metrics_writer
        self._metrics = {"snapshot_fetch_errors": 0, "physical_stop_errors": 0}
        self._closed = False

    async def ensure_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
        """Acquire one idempotent consumer lease; start the first physical feed."""

        consumer = self._consumer_id(consumer_id)
        self._validate_key(key, history=False)
        physical_id = self._physical_id(key)

        while True:
            wait_for_stop: asyncio.Task | None = None
            async with self._lock:
                if self._closed:
                    raise RuntimeError("market data service is closed")
                entry = self._physical_entries.get(physical_id)
                if entry is not None and entry.stop_task is not None:
                    wait_for_stop = entry.stop_task
                elif entry is not None and entry.stop_error is not None:
                    delay = max(0.0, entry.retry_stop_at - time.monotonic())
                    wait_for_stop = self._schedule_physical_stop(
                        physical_id,
                        entry,
                        delay=delay,
                    )
                else:
                    lease = self._logical_leases.get(key)
                    if lease is not None and consumer in lease.consumers:
                        return False

                    created_physical = entry is None
                    if entry is None:
                        wait_for_stop = self._physical_capacity_waiter(key)
                        if wait_for_stop is None:
                            entry = _PhysicalEntry(
                                descriptor=self._physical_descriptor(key),
                            )
                            self._physical_entries[physical_id] = entry

                    if wait_for_stop is None:
                        lease = self._logical_leases.setdefault(key, _LogicalLease())
                        lease.consumers.add(consumer)
                        entry.logical_keys.add(key)

                        if created_physical:
                            try:
                                async def _on_event(event: MarketEvent) -> None:
                                    await self._on_ingestion_event(physical_id, event)

                                entry.handle = await self._factory.start_market(
                                    entry.descriptor,
                                    _on_event,
                                )
                            except BaseException:
                                entry.logical_keys.discard(key)
                                self._physical_entries.pop(physical_id, None)
                                lease.consumers.discard(consumer)
                                if not lease.consumers:
                                    self._logical_leases.pop(key, None)
                                raise
                        return True

            if wait_for_stop is not None:
                await asyncio.shield(wait_for_stop)

    async def ensure_streams(
        self,
        keys: Iterable[MarketStreamKey],
        *,
        consumer_id: str,
    ) -> list[MarketStreamKey]:
        acquired: list[MarketStreamKey] = []
        try:
            for key in keys:
                if await self.ensure_stream(key, consumer_id=consumer_id):
                    acquired.append(key)
            return acquired
        except BaseException:
            for key in reversed(acquired):
                try:
                    await self.release_stream(key, consumer_id=consumer_id)
                except BaseException:
                    logger.exception("Failed to roll back market stream %s", key)
            raise

    async def release_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
        """Release one lease and stop the physical feed after its last dependent."""

        consumer = self._consumer_id(consumer_id)
        physical_id = self._physical_id(key)
        stop_task: asyncio.Task | None = None
        async with self._lock:
            lease = self._logical_leases.get(key)
            if lease is None or consumer not in lease.consumers:
                return False
            lease.consumers.remove(consumer)
            if lease.consumers:
                return True

            self._logical_leases.pop(key, None)
            entry = self._physical_entries.get(physical_id)
            if entry is None:
                return True
            entry.logical_keys.discard(key)
            if entry.logical_keys:
                return True

            if entry.stop_task is None:
                self._schedule_physical_stop(physical_id, entry)
            stop_task = entry.stop_task

        if stop_task is not None:
            await asyncio.shield(stop_task)
        return True

    async def snapshot(
        self,
        keys: Iterable[MarketStreamKey],
        *,
        refresh_missing: bool = True,
    ) -> list[HubRecord]:
        self._ensure_open()
        requested = list(dict.fromkeys(keys))
        for key in requested:
            self._validate_key(key, history=False)

        now_ms = int(time.time() * 1000)
        existing = {
            record.event.key
            for record in self.hub.snapshot(requested)
            if self._is_fresh(record, now_ms=now_ms)
        }
        missing = [key for key in requested if key not in existing]
        if refresh_missing and missing:
            await self.refresh_snapshot(missing)
        now_ms = int(time.time() * 1000)
        by_key = {
            record.event.key: record
            for record in self.hub.snapshot(requested)
            if self._is_fresh(record, now_ms=now_ms)
        }
        return [by_key[key] for key in requested if key in by_key]

    async def refresh_snapshot(
        self,
        keys: Iterable[MarketStreamKey],
    ) -> list[HubRecord]:
        self._ensure_open()
        requested = list(dict.fromkeys(keys))
        grouped: dict[tuple[str, str, str, str], list[MarketStreamKey]] = {}
        for key in requested:
            self._validate_key(key, history=False)
            grouped.setdefault(self._physical_id(key), []).append(key)

        pages = await asyncio.gather(
            *(self._refresh_group(physical_id, group) for physical_id, group in grouped.items()),
            return_exceptions=True,
        )
        records: list[HubRecord] = []
        for page in pages:
            if isinstance(page, BaseException):
                self._metrics["snapshot_fetch_errors"] += 1
                logger.warning("Advanced market snapshot group failed: %s", page)
                continue
            records.extend(self.hub.seed(page))
        return records

    async def history(
        self,
        key: MarketStreamKey,
        *,
        period: str | None = None,
        limit: int = 500,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> list[MarketStateEvent]:
        page = await self.history_page(
            key,
            period=period,
            limit=limit,
            start_ms=start_ms,
            end_ms=end_ms,
        )
        return page.events

    async def history_page(
        self,
        key: MarketStreamKey,
        *,
        period: str | None = None,
        limit: int = 500,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> MarketHistoryPage:
        """Refresh one Funding/OI history page and serve it from SQLite.

        Without an injected repository this preserves the original upstream-
        only behavior for tests and alternate embeddings.  With storage
        enabled, an upstream failure falls back to an already persisted page.
        """

        self._ensure_open()
        self._validate_key(key, history=True)
        if start_ms is not None and end_ms is not None and start_ms > end_ms:
            raise ValueError("start_ms must be less than or equal to end_ms")
        stream_type = _HISTORY_STREAM_TYPES.get(key.channel)
        if stream_type is None:
            raise ValueError(f"history is not supported for channel {key.channel.value!r}")
        if key.channel == MarketChannel.OPEN_INTEREST and not period:
            raise ValueError("open-interest history requires period")

        descriptor = StreamDescriptor(
            symbol=key.symbol,
            stream_type=stream_type,
            interval=period,
            exchange=key.exchange,
            market_type=key.market_type,
        )
        event_key = (
            MarketStreamKey.build(
                key.exchange,
                key.market_type,
                key.symbol,
                key.channel,
                params={"period": period},
            )
            if period is not None
            else key
        )
        if self._metrics_repository is None:
            raw_events = await self._fetch_market(
                descriptor,
                limit=limit,
                start_ms=start_ms,
                end_ms=end_ms,
                history=True,
            )
            return MarketHistoryPage(events=[
                projected
                for event in raw_events
                if (projected := self._project(event, event_key)) is not None
            ])

        local_events = await self._read_persisted_history(
            event_key,
            period=period,
            limit=limit,
            start_ms=start_ms,
            end_ms=end_ms,
        )
        try:
            raw_events = await self._fetch_market(
                descriptor,
                limit=limit,
                start_ms=start_ms,
                end_ms=end_ms,
                history=True,
            )
        except ValueError:
            raise
        except Exception:
            if not local_events:
                raise
            logger.warning(
                "Advanced market history refresh failed; serving persisted %s page",
                event_key.topic,
                exc_info=True,
            )
            return MarketHistoryPage(events=local_events, fallback=True)

        projected_events = [
            projected
            for event in raw_events
            if (projected := self._project(event, event_key)) is not None
        ]
        await self._persist_final_history(projected_events, period=period)
        return MarketHistoryPage(
            events=await self._read_persisted_history(
                event_key,
                period=period,
                limit=limit,
                start_ms=start_ms,
                end_ms=end_ms,
            ),
        )

    async def _read_persisted_history(
        self,
        key: MarketStreamKey,
        *,
        period: str | None,
        limit: int,
        start_ms: int | None,
        end_ms: int | None,
    ) -> list[MarketStateEvent]:
        repository = self._metrics_repository
        if repository is None:
            return []
        common = {
            "exchange": key.exchange,
            "market_type": key.market_type,
            "symbol": key.symbol,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "limit": limit,
        }
        if key.channel == MarketChannel.FUNDING_RATE:
            rows = await run_storage(
                repository.query_funding,
                oldest_first=True,
                **common,
            )
            events: list[MarketStateEvent] = []
            for row in rows:
                is_final = bool(row["is_final"])
                data: dict[str, Any] = {
                    "funding_rate": row["funding_rate"],
                    "funding_time_ms": row["funding_time_ms"],
                    "is_final": is_final,
                    "sample_kind": "settlement" if is_final else "preview",
                }
                events.append(
                    MarketStateEvent(
                        key=key,
                        event_time_ms=row["funding_time_ms"],
                        received_at_ms=row["received_at_ms"],
                        source=row["source"],
                        data=data,
                        sequence=row["funding_time_ms"],
                    ),
                )
            return events

        if key.channel == MarketChannel.OPEN_INTEREST:
            if not period:
                raise ValueError("open-interest history requires period")
            rows = await run_storage(
                repository.query_open_interest,
                period=period,
                **common,
            )
            events = []
            for row in rows:
                is_final = bool(row["is_final"])
                data = {
                    "open_interest": row["open_interest"],
                    "is_final": is_final,
                    "sample_kind": "final" if is_final else "provisional",
                }
                if row.get("open_interest_value") is not None:
                    data["open_interest_value"] = row["open_interest_value"]
                events.append(
                    MarketStateEvent(
                        key=key,
                        event_time_ms=row["event_time_ms"],
                        received_at_ms=row["received_at_ms"],
                        source=row["source"],
                        data=data,
                        sequence=row["event_time_ms"],
                    ),
                )
            return events
        return []

    async def _persist_final_history(
        self,
        events: list[MarketStateEvent],
        *,
        period: str | None,
    ) -> None:
        repository = self._metrics_repository
        if repository is None or not events:
            return
        channel = events[0].key.channel
        if channel == MarketChannel.FUNDING_RATE:
            rows = [self._funding_storage_row(event, is_final=True) for event in events]
            if self._metrics_writer is not None:
                await self._metrics_writer.write_funding(rows)
            else:
                await run_storage(repository.upsert_funding, rows)
            return
        if channel == MarketChannel.OPEN_INTEREST:
            if not period:
                raise ValueError("open-interest history requires period")
            rows = [
                self._open_interest_storage_row(
                    event,
                    period=period,
                    is_final=True,
                )
                for event in events
            ]
            if self._metrics_writer is not None:
                await self._metrics_writer.write_open_interest(rows)
            else:
                await run_storage(repository.upsert_open_interest, rows)

    def subscribe(
        self,
        keys: Iterable[MarketStreamKey],
        *,
        max_pending: int = 64,
        replay: bool = True,
    ) -> MarketHubSubscription:
        self._ensure_open()
        return self.hub.subscribe(keys, max_pending=max_pending, replay=replay)

    async def shutdown(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            self._logical_leases.clear()
            stop_tasks: list[asyncio.Task] = []
            for physical_id, entry in self._physical_entries.items():
                entry.logical_keys.clear()
                if entry.stop_task is None:
                    entry.stop_error = None
                    self._schedule_physical_stop(physical_id, entry)
                stop_tasks.append(entry.stop_task)

        async with self._snapshot_lock:
            snapshot_tasks = list(self._snapshot_tasks.values())
            self._snapshot_tasks.clear()
        for task in snapshot_tasks:
            if not task.done():
                task.cancel()
        if snapshot_tasks:
            await asyncio.gather(*snapshot_tasks, return_exceptions=True)

        if stop_tasks:
            await asyncio.gather(
                *(asyncio.shield(task) for task in stop_tasks),
                return_exceptions=True,
            )
        async with self._lock:
            self._physical_entries.clear()
        if self._metrics_writer is not None:
            await self._metrics_writer.close()
        await self.hub.close()

    def diagnostics(self) -> dict[str, Any]:
        return {
            "closed": self._closed,
            "logical_streams": len(self._logical_leases),
            "logical_consumers": sum(
                len(lease.consumers) for lease in self._logical_leases.values()
            ),
            "physical_streams": len(self._physical_entries),
            "limits": {
                "summary_streams": self._max_summary_streams,
                "open_interest_streams": self._max_open_interest_streams,
            },
            "physical": [
                {
                    "descriptor": entry.descriptor.key,
                    "logical_streams": len(entry.logical_keys),
                    "state": (
                        "stop_failed"
                        if entry.stop_error is not None
                        else "stopping"
                        if entry.stop_task is not None
                        else "running"
                    ),
                    "stop_error": entry.stop_error,
                }
                for entry in self._physical_entries.values()
            ],
            "hub": self.hub.diagnostics(),
            "storage": {
                "enabled": self._metrics_repository is not None,
                "writer": (
                    self._metrics_writer.diagnostics()
                    if self._metrics_writer is not None
                    else None
                ),
            },
            "rate_limits": self._rate_limits.snapshot(),
            **self._metrics,
        }

    async def _refresh_group(
        self,
        physical_id: tuple[str, str, str, str],
        group: list[MarketStreamKey],
    ) -> list[MarketStateEvent]:
        async with self._snapshot_lock:
            self._ensure_open()
            task = self._snapshot_tasks.get(physical_id)
            if task is None:
                task = asyncio.create_task(
                    self._fetch_snapshot_source(group[0]),
                    name=f"market-snapshot-{group[0].symbol}",
                )
                self._snapshot_tasks[physical_id] = task
                task.add_done_callback(
                    lambda completed, key=physical_id: self._discard_snapshot_task(
                        key,
                        completed,
                    ),
                )
        raw_events = await asyncio.shield(task)
        projected: list[MarketStateEvent] = []
        for raw_event in raw_events:
            for key in group:
                event = self._project(raw_event, key)
                if event is not None:
                    projected.append(event)
        return projected

    def _discard_snapshot_task(
        self,
        physical_id: tuple[str, str, str, str],
        task: asyncio.Task,
    ) -> None:
        if not task.cancelled():
            task.exception()
        if self._snapshot_tasks.get(physical_id) is task:
            self._snapshot_tasks.pop(physical_id, None)

    async def _fetch_snapshot_source(self, key: MarketStreamKey) -> list[MarketEvent]:
        return await self._fetch_market(self._physical_descriptor(key), limit=1)

    async def _fetch_market(
        self,
        descriptor: StreamDescriptor,
        *,
        limit: int,
        start_ms: int | None = None,
        end_ms: int | None = None,
        history: bool = False,
    ) -> list[MarketEvent]:
        self._ensure_open()
        plugin = get_exchange_registry().get_plugin(descriptor.exchange)
        request = TransportRequest(
            descriptor=descriptor,
            limit=limit,
            start_ms=start_ms,
            end_ms=end_ms,
            history=history,
        )
        spec = plugin.protocol().rest_request(
            request,
            config=getattr(self._factory, "config", None),
        )
        if spec is None:
            raise ValueError(f"No REST endpoint for {descriptor.key}")
        return await self._factory.fetch_market(
            descriptor,
            limit=limit,
            start_ms=start_ms,
            end_ms=end_ms,
            history=history,
        )

    def _schedule_physical_stop(
        self,
        physical_id: tuple[str, str, str, str],
        entry: _PhysicalEntry,
        *,
        delay: float = 0.0,
    ) -> asyncio.Task:
        entry.stop_error = None
        task = asyncio.create_task(
            self._stop_physical_after_delay(physical_id, entry, delay),
            name=f"market-stop-{entry.descriptor.key}",
        )
        entry.stop_task = task
        task.add_done_callback(self._consume_background_task_result)
        return task

    async def _stop_physical_after_delay(
        self,
        physical_id: tuple[str, str, str, str],
        entry: _PhysicalEntry,
        delay: float,
    ) -> None:
        if delay > 0:
            await asyncio.sleep(delay)
        await self._stop_physical(physical_id, entry)

    @staticmethod
    def _consume_background_task_result(task: asyncio.Task) -> None:
        if not task.cancelled():
            task.exception()

    async def _stop_physical(
        self,
        physical_id: tuple[str, str, str, str],
        entry: _PhysicalEntry,
    ) -> None:
        error: BaseException | None = None
        try:
            if entry.handle is not None:
                stopped = await entry.handle.stop()
                if stopped is False:
                    raise RuntimeError("ingestion handle reported stop failure")
        except BaseException as exc:
            error = exc

        async with self._lock:
            current = self._physical_entries.get(physical_id)
            if current is entry:
                entry.stop_task = None
                if error is None:
                    self._physical_entries.pop(physical_id, None)
                else:
                    self._metrics["physical_stop_errors"] += 1
                    entry.stop_attempts += 1
                    entry.retry_stop_at = time.monotonic() + min(
                        5.0,
                        0.25 * (2 ** (entry.stop_attempts - 1)),
                    )
                    entry.stop_error = f"{type(error).__name__}: {error}"
                    if not self._closed:
                        self._schedule_physical_stop(
                            physical_id,
                            entry,
                            delay=max(0.0, entry.retry_stop_at - time.monotonic()),
                        )

        if error is not None:
            raise error

    async def _on_ingestion_event(
        self,
        physical_id: tuple[str, str, str, str],
        event: MarketEvent,
    ) -> None:
        # No await is needed to take this event-loop-local snapshot.  Keeping
        # callbacks lock-free also lets a handle stop while a final event is in
        # flight without deadlocking the lifecycle lock.
        entry = self._physical_entries.get(physical_id)
        keys = tuple(entry.logical_keys) if entry is not None else ()
        for key in keys:
            projected = self._project(event, key)
            if projected is not None:
                self.hub.publish(projected)
        self._offer_realtime_provisional(event, keys)

    def _offer_realtime_provisional(
        self,
        event: MarketEvent,
        keys: tuple[MarketStreamKey, ...],
    ) -> None:
        writer = self._metrics_writer
        if writer is None:
            return

        funding_key = next(
            (key for key in keys if key.channel == MarketChannel.FUNDING_RATE),
            None,
        )
        if funding_key is not None and "next_funding_time_ms" in event.data:
            projected = self._project(event, funding_key)
            if projected is not None:
                writer.offer_funding(
                    self._funding_storage_row(projected, is_final=False),
                )

        open_interest_key = next(
            (key for key in keys if key.channel == MarketChannel.OPEN_INTEREST),
            None,
        )
        if open_interest_key is not None:
            projected = self._project(event, open_interest_key)
            if projected is not None:
                bucket_time_ms = (
                    projected.event_time_ms // _DEFAULT_OPEN_INTEREST_STORAGE_BUCKET_MS
                ) * _DEFAULT_OPEN_INTEREST_STORAGE_BUCKET_MS
                writer.offer_open_interest(
                    self._open_interest_storage_row(
                        projected,
                        period=_DEFAULT_OPEN_INTEREST_STORAGE_PERIOD,
                        is_final=False,
                        event_time_ms=bucket_time_ms,
                    ),
                )

    @staticmethod
    def _funding_storage_row(
        event: MarketStateEvent,
        *,
        is_final: bool,
    ) -> dict[str, Any]:
        time_field = "funding_time_ms" if is_final else "next_funding_time_ms"
        funding_time_ms = event.data.get(time_field)
        if funding_time_ms is None:
            funding_time_ms = event.event_time_ms
        row: dict[str, Any] = {
            "exchange": event.key.exchange,
            "market_type": event.key.market_type,
            "symbol": event.key.symbol,
            "funding_time_ms": int(funding_time_ms),
            "funding_rate": event.data["funding_rate"],
            "is_final": is_final,
            "source": event.source.value,
            "received_at_ms": event.received_at_ms,
        }
        return row

    @staticmethod
    def _open_interest_storage_row(
        event: MarketStateEvent,
        *,
        period: str,
        is_final: bool,
        event_time_ms: int | None = None,
    ) -> dict[str, Any]:
        resolved_event_time_ms = (
            event.event_time_ms if event_time_ms is None else event_time_ms
        )
        period_ms = parse_interval_ms(period)
        if period_ms is not None and period_ms > 0:
            resolved_event_time_ms = (
                resolved_event_time_ms // period_ms
            ) * period_ms
        row: dict[str, Any] = {
            "exchange": event.key.exchange,
            "market_type": event.key.market_type,
            "symbol": event.key.symbol,
            "period": period,
            "event_time_ms": resolved_event_time_ms,
            "open_interest": event.data["open_interest"],
            "is_final": is_final,
            "source": event.source.value,
            "received_at_ms": event.received_at_ms,
        }
        if event.data.get("open_interest_value") is not None:
            row["open_interest_value"] = event.data["open_interest_value"]
        return row

    @staticmethod
    def _project(event: MarketEvent, key: MarketStreamKey) -> MarketStateEvent | None:
        data = event.data
        projected: dict[str, Any]
        if key.channel == MarketChannel.MARK_PRICE:
            if "mark_price" not in data:
                return None
            projected = {"mark_price": data["mark_price"]}
            if "estimated_settle_price" in data:
                projected["estimated_settle_price"] = data["estimated_settle_price"]
        elif key.channel == MarketChannel.INDEX_PRICE:
            if "index_price" not in data:
                return None
            projected = {"index_price": data["index_price"]}
        elif key.channel == MarketChannel.FUNDING_RATE:
            if "funding_rate" not in data:
                return None
            projected = {"funding_rate": data["funding_rate"]}
            for name in ("next_funding_time_ms", "funding_time_ms", "mark_price"):
                if name in data:
                    projected[name] = data[name]
        elif key.channel == MarketChannel.OPEN_INTEREST:
            if "open_interest" not in data:
                return None
            projected = {"open_interest": data["open_interest"]}
            if "open_interest_value" in data:
                projected["open_interest_value"] = data["open_interest_value"]
        elif key.channel == MarketChannel.BASIS:
            if "mark_price" not in data or "index_price" not in data:
                return None
            mark_price = float(data["mark_price"])
            index_price = float(data["index_price"])
            if index_price == 0:
                return None
            basis = mark_price - index_price
            basis_rate = basis / index_price
            projected = {
                "mark_price": mark_price,
                "index_price": index_price,
                "basis": basis,
                "basis_rate": basis_rate,
                "basis_bps": basis_rate * 10_000,
            }
        else:
            return None

        return MarketStateEvent(
            key=key,
            event_time_ms=event.event_time_ms,
            received_at_ms=event.received_at_ms,
            source=event.source,
            data=projected,
            sequence=event.sequence,
        )

    def _physical_descriptor(self, key: MarketStreamKey) -> StreamDescriptor:
        if key.channel in _SUMMARY_CHANNELS:
            return StreamDescriptor(
                symbol=key.symbol,
                stream_type=StreamType.MARK_PRICE,
                exchange=key.exchange,
                market_type=key.market_type,
            )
        return StreamDescriptor(
            symbol=key.symbol,
            stream_type=StreamType.OPEN_INTEREST,
            exchange=key.exchange,
            market_type=key.market_type,
            poll_interval_seconds=self._open_interest_poll_seconds,
        )

    @staticmethod
    def _physical_id(key: MarketStreamKey) -> tuple[str, str, str, str]:
        source = "derivatives_summary" if key.channel in _SUMMARY_CHANNELS else "open_interest"
        return key.exchange, key.market_type, key.symbol, source

    def _physical_capacity_waiter(
        self,
        key: MarketStreamKey,
    ) -> asyncio.Task | None:
        source = "derivatives_summary" if key.channel in _SUMMARY_CHANNELS else "open_interest"
        active = [
            (physical_id, entry)
            for physical_id, entry in self._physical_entries.items()
            if physical_id[3] == source
        ]
        limit = (
            self._max_summary_streams
            if source == "derivatives_summary"
            else self._max_open_interest_streams
        )
        if len(active) < limit:
            return None
        for physical_id, entry in active:
            if entry.logical_keys:
                continue
            if entry.stop_task is not None:
                return entry.stop_task
            return self._schedule_physical_stop(
                physical_id,
                entry,
                delay=max(0.0, entry.retry_stop_at - time.monotonic()),
            )
        raise RuntimeError(f"{source} physical stream limit reached ({limit})")

    @staticmethod
    def _is_fresh(record: HubRecord, *, now_ms: int) -> bool:
        max_age_ms = (
            15_000
            if record.event.key.channel == MarketChannel.OPEN_INTEREST
            else 10_000
        )
        return now_ms - record.event.received_at_ms <= max_age_ms

    @staticmethod
    def _consumer_id(value: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("market stream consumer_id cannot be blank")
        return value.strip()

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("market data service is closed")

    @staticmethod
    def _validate_key(key: MarketStreamKey, *, history: bool) -> None:
        if key.params:
            raise ValueError("P1 realtime market streams do not accept params")
        if len(key.symbol) > 64:
            raise ValueError("market stream symbol is too long")
        if key.channel not in _P1_CHANNELS:
            raise ValueError(f"unsupported P1 market channel: {key.channel.value}")
        bootstrap_default_adapters()
        try:
            capabilities = get_exchange_registry().get_plugin(key.exchange).capabilities()
        except KeyError as exc:
            raise ValueError(str(exc)) from exc

        if key.channel == MarketChannel.BASIS:
            supported = all(
                capabilities.supports_channel(channel, key.market_type, history=history)
                for channel in (MarketChannel.MARK_PRICE, MarketChannel.INDEX_PRICE)
            )
        else:
            supported = capabilities.supports_channel(
                key.channel,
                key.market_type,
                history=history,
            )
        if not supported:
            mode = "history" if history else "realtime"
            raise ValueError(
                f"{key.exchange}:{key.market_type}:{key.channel.value} does not support {mode}",
            )
