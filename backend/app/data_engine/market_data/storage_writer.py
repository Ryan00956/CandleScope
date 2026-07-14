"""Bounded single-consumer writer for advanced market metric history."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Literal

from app.core.executors import run_storage
from app.data_engine.storage.market_metrics_repo import MarketMetricsRepository


MetricKind = Literal["funding", "open_interest"]


@dataclass(slots=True)
class _DurableWrite:
    kind: MetricKind
    rows: list[dict[str, Any]]
    acknowledgement: asyncio.Future[int]


class MarketMetricStorageWriter:
    """Batch SQLite writes without submitting one executor job per event.

    Authoritative history writes are backpressured through a bounded queue and
    acknowledged only after commit.  Realtime provisional rows are coalesced
    by natural key in bounded ordered maps; a newer observation replaces the
    pending value for the same period/bucket.
    """

    def __init__(
        self,
        repository: MarketMetricsRepository,
        *,
        flush_interval_seconds: float = 0.25,
        max_durable_batches: int = 16,
        max_pending_provisional: int = 4096,
    ) -> None:
        self.repository = repository
        self._flush_interval_seconds = max(0.01, float(flush_interval_seconds))
        self._max_pending_provisional = max(1, int(max_pending_provisional))
        self._durable: asyncio.Queue[_DurableWrite] = asyncio.Queue(
            maxsize=max(1, int(max_durable_batches)),
        )
        self._funding_pending: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
        self._oi_pending: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
        self._wake = asyncio.Event()
        self._close_signal = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._closing = False
        self._metrics = {
            "batches": 0,
            "rows_written": 0,
            "coalesced": 0,
            "provisional_evicted": 0,
            "write_failures": 0,
        }

    def start(self) -> None:
        if self._closing:
            raise RuntimeError("market metric writer is closed")
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(
            self._run(),
            name="market-metric-storage-writer",
        )

    async def write_funding(self, rows: list[dict[str, Any]]) -> int:
        return await self._write_durable("funding", rows)

    async def write_open_interest(self, rows: list[dict[str, Any]]) -> int:
        return await self._write_durable("open_interest", rows)

    def offer_funding(self, row: dict[str, Any]) -> bool:
        key = (
            row.get("exchange"),
            row.get("market_type"),
            row.get("symbol"),
            row.get("funding_time_ms"),
        )
        return self._offer(self._funding_pending, key, row)

    def offer_open_interest(self, row: dict[str, Any]) -> bool:
        key = (
            row.get("exchange"),
            row.get("market_type"),
            row.get("symbol"),
            row.get("period"),
            row.get("event_time_ms"),
        )
        return self._offer(self._oi_pending, key, row)

    async def close(self) -> None:
        if self._closing:
            if self._task is not None:
                await asyncio.shield(self._task)
            return
        self._closing = True
        self._close_signal.set()
        self._wake.set()
        if self._task is not None:
            await asyncio.shield(self._task)
        else:
            await self._flush_without_worker()

    def diagnostics(self) -> dict[str, Any]:
        return {
            "state": (
                "closed"
                if self._closing and (self._task is None or self._task.done())
                else "closing"
                if self._closing
                else "running"
                if self._task is not None and not self._task.done()
                else "idle"
            ),
            "durable_batches_pending": self._durable.qsize(),
            "provisional_pending": len(self._funding_pending) + len(self._oi_pending),
            "limits": {
                "durable_batches": self._durable.maxsize,
                "provisional_rows": self._max_pending_provisional,
            },
            **self._metrics,
        }

    async def _write_durable(
        self,
        kind: MetricKind,
        rows: list[dict[str, Any]],
    ) -> int:
        if not rows:
            return 0
        if self._closing:
            raise RuntimeError("market metric writer is closed")
        self.start()
        acknowledgement: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        acknowledgement.add_done_callback(self._consume_acknowledgement)
        await self._durable.put(
            _DurableWrite(
                kind=kind,
                rows=[dict(row) for row in rows],
                acknowledgement=acknowledgement,
            ),
        )
        self._wake.set()
        return await asyncio.shield(acknowledgement)

    @staticmethod
    def _consume_acknowledgement(acknowledgement: asyncio.Future[int]) -> None:
        if not acknowledgement.cancelled():
            acknowledgement.exception()

    def _offer(
        self,
        pending: OrderedDict[tuple[Any, ...], dict[str, Any]],
        key: tuple[Any, ...],
        row: dict[str, Any],
    ) -> bool:
        if self._closing:
            return False
        self.start()
        if key in pending:
            pending.pop(key)
            self._metrics["coalesced"] += 1
        elif self._pending_count() >= self._max_pending_provisional:
            self._evict_oldest_provisional()
        pending[key] = dict(row)
        self._wake.set()
        return True

    async def _run(self) -> None:
        while True:
            if not self._has_work():
                if self._closing:
                    return
                self._wake.clear()
                if self._has_work():
                    continue
                await self._wake.wait()

            if not self._closing:
                try:
                    await asyncio.wait_for(
                        self._close_signal.wait(),
                        timeout=self._flush_interval_seconds,
                    )
                except asyncio.TimeoutError:
                    pass

            await self._flush_once()
            if self._closing and not self._has_work():
                return

    async def _flush_once(self) -> None:
        requests: list[_DurableWrite] = []
        while True:
            try:
                requests.append(self._durable.get_nowait())
            except asyncio.QueueEmpty:
                break

        funding_pending = list(self._funding_pending.values())
        oi_pending = list(self._oi_pending.values())
        self._funding_pending.clear()
        self._oi_pending.clear()

        funding_requests = [item for item in requests if item.kind == "funding"]
        oi_requests = [item for item in requests if item.kind == "open_interest"]
        await self._flush_kind(
            "funding",
            funding_requests,
            [*funding_pending, *(row for item in funding_requests for row in item.rows)],
        )
        await self._flush_kind(
            "open_interest",
            oi_requests,
            [*oi_pending, *(row for item in oi_requests for row in item.rows)],
        )
        for _ in requests:
            self._durable.task_done()

    async def _flush_kind(
        self,
        kind: MetricKind,
        requests: list[_DurableWrite],
        rows: list[dict[str, Any]],
    ) -> None:
        if not rows:
            return
        deduplicated = self._deduplicate(kind, rows)
        method = (
            self.repository.upsert_funding
            if kind == "funding"
            else self.repository.upsert_open_interest
        )
        try:
            written = await run_storage(method, deduplicated)
        except Exception as exc:
            self._metrics["write_failures"] += 1
            for request in requests:
                if not request.acknowledgement.done():
                    request.acknowledgement.set_exception(exc)
            return

        self._metrics["batches"] += 1
        self._metrics["rows_written"] += int(written)
        for request in requests:
            if not request.acknowledgement.done():
                request.acknowledgement.set_result(len(request.rows))

    async def _flush_without_worker(self) -> None:
        if not self._has_work():
            return
        await self._flush_once()

    def _pending_count(self) -> int:
        return len(self._funding_pending) + len(self._oi_pending)

    def _has_work(self) -> bool:
        return not self._durable.empty() or self._pending_count() > 0

    def _evict_oldest_provisional(self) -> None:
        candidates = []
        if self._funding_pending:
            candidates.append(("funding", next(iter(self._funding_pending))))
        if self._oi_pending:
            candidates.append(("open_interest", next(iter(self._oi_pending))))
        if not candidates:
            return
        kind, key = candidates[0]
        if kind == "funding":
            self._funding_pending.pop(key, None)
        else:
            self._oi_pending.pop(key, None)
        self._metrics["provisional_evicted"] += 1

    @staticmethod
    def _deduplicate(
        kind: MetricKind,
        rows: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        unique: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
        for row in rows:
            if kind == "funding":
                key = (
                    row.get("exchange"),
                    row.get("market_type"),
                    row.get("symbol"),
                    row.get("funding_time_ms"),
                )
            else:
                key = (
                    row.get("exchange"),
                    row.get("market_type"),
                    row.get("symbol"),
                    row.get("period"),
                    row.get("event_time_ms"),
                )
            current = unique.get(key)
            if current is None or _row_precedes(current, row):
                unique[key] = row
        return list(unique.values())


def _row_precedes(current: dict[str, Any], candidate: dict[str, Any]) -> bool:
    current_rank = 1 if bool(current.get("is_final", True)) else 0
    candidate_rank = 1 if bool(candidate.get("is_final", True)) else 0
    if candidate_rank != current_rank:
        return candidate_rank > current_rank
    return int(candidate.get("received_at_ms", 0)) >= int(current.get("received_at_ms", 0))


__all__ = ["MarketMetricStorageWriter"]
