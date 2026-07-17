"""Bounded writer for one-minute liquidation rollups."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from .liquidation_store import LiquidationRollupStore


@dataclass(slots=True)
class _DurableWrite:
    rows: list[dict[str, Any]]
    acknowledgement: asyncio.Future[int]


class LiquidationRollupWriter:
    """Batch durable rollups and coalesce hot provisional observations.

    Final rows use the acknowledged ``write`` path.  The non-blocking ``offer``
    path only accepts provisional rows and is bounded by distinct natural keys,
    including liquidation position side.  Evictions and exhausted retries stay
    visible through diagnostics.
    """

    def __init__(
        self,
        store: LiquidationRollupStore,
        *,
        flush_interval_seconds: float = 0.1,
        max_durable_batches: int = 16,
        max_pending_provisional: int = 4096,
        max_write_attempts: int = 3,
        retry_base_seconds: float = 0.05,
        retry_max_seconds: float = 1.0,
    ) -> None:
        self.store = store
        self._flush_interval_seconds = max(0.01, float(flush_interval_seconds))
        self._max_pending_provisional = max(1, int(max_pending_provisional))
        self._max_write_attempts = max(1, min(int(max_write_attempts), 10))
        self._retry_base_seconds = max(0.0, float(retry_base_seconds))
        self._retry_max_seconds = max(
            self._retry_base_seconds,
            float(retry_max_seconds),
        )
        self._durable: asyncio.Queue[_DurableWrite] = asyncio.Queue(
            maxsize=max(1, int(max_durable_batches))
        )
        self._enqueue_lock = asyncio.Lock()
        self._provisional: OrderedDict[
            tuple[Any, ...], dict[str, Any]
        ] = OrderedDict()
        self._wake = asyncio.Event()
        self._durable_wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._closing = False
        self._metrics = {
            "batches_written": 0,
            "rows_written": 0,
            "coalesced": 0,
            "provisional_evicted": 0,
            "provisional_lost_on_failure": 0,
            "offer_rejected_final": 0,
            "write_failures": 0,
            "retry_attempts": 0,
            "failed_batches": 0,
            "failed_rows": 0,
            "last_error": None,
        }
        self._durability_failed = False

    def start(self) -> None:
        if self._closing:
            raise RuntimeError("liquidation rollup writer is closed")
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(
            self._run(),
            name="liquidation-rollup-writer",
        )

    async def write(self, rows: Iterable[dict[str, Any]]) -> int:
        acknowledgement = await self.enqueue(rows)
        if acknowledgement is None:
            return 0
        return await asyncio.shield(acknowledgement)

    async def enqueue(
        self,
        rows: Iterable[dict[str, Any]],
    ) -> asyncio.Future[int] | None:
        """Losslessly enqueue final rows without waiting for storage I/O."""

        copied = [dict(row) for row in rows]
        if not copied:
            return None
        async with self._enqueue_lock:
            if self._closing:
                raise RuntimeError("liquidation rollup writer is closed")
            self.start()
            acknowledgement = asyncio.get_running_loop().create_future()
            acknowledgement.add_done_callback(self._consume_acknowledgement)
            await self._durable.put(
                _DurableWrite(rows=copied, acknowledgement=acknowledgement)
            )
            self._durable_wake.set()
            self._wake.set()
        return acknowledgement

    def offer(self, row: dict[str, Any]) -> bool:
        """Queue one provisional row without blocking the event loop."""

        if self._closing:
            return False
        if bool(row.get("is_final", False)):
            self._metrics["offer_rejected_final"] += 1
            return False
        self.start()
        key = _natural_key(row)
        candidate = dict(row)
        current = self._provisional.get(key)
        if current is not None:
            self._metrics["coalesced"] += 1
            if not _candidate_precedes(current, candidate):
                return True
            self._provisional.pop(key)
        elif len(self._provisional) >= self._max_pending_provisional:
            self._provisional.popitem(last=False)
            self._metrics["provisional_evicted"] += 1
        self._provisional[key] = candidate
        self._wake.set()
        return True

    async def close(self) -> None:
        """Drain durable/provisional work and stop the writer task."""

        async with self._enqueue_lock:
            if not self._closing:
                self._closing = True
                self._durable_wake.set()
                self._wake.set()
            task = self._task
        if task is not None:
            await asyncio.shield(task)
        elif self._has_work():
            await self._flush_once()

    def diagnostics(self) -> dict[str, Any]:
        if self._durability_failed:
            state = "failed"
        elif self._closing and (self._task is None or self._task.done()):
            state = "closed"
        elif self._closing:
            state = "closing"
        elif self._task is not None and not self._task.done():
            state = "running"
        else:
            state = "idle"
        return {
            "state": state,
            "durable_batches_pending": self._durable.qsize(),
            "provisional_pending": len(self._provisional),
            "limits": {
                "durable_batches": self._durable.maxsize,
                "provisional_rows": self._max_pending_provisional,
                "write_attempts": self._max_write_attempts,
                "retry_base_seconds": self._retry_base_seconds,
                "retry_max_seconds": self._retry_max_seconds,
            },
            "degraded": self._durability_failed,
            **self._metrics,
        }

    async def _run(self) -> None:
        while True:
            if not self._has_work():
                if self._closing:
                    return
                self._wake.clear()
                if self._has_work():
                    continue
                await self._wake.wait()

            if not self._closing and self._durable.empty():
                self._durable_wake.clear()
                if not self._durable.empty():
                    continue
                try:
                    await asyncio.wait_for(
                        self._durable_wake.wait(),
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

        provisional = list(self._provisional.values())
        self._provisional.clear()
        rows = [*provisional, *(row for item in requests for row in item.rows)]
        if rows:
            deduplicated = _deduplicate(rows)
            error: Exception | None = None
            written = 0
            for attempt in range(1, self._max_write_attempts + 1):
                try:
                    written = await self.store.upsert_rollups(deduplicated)
                except Exception as exc:
                    error = exc
                    self._metrics["write_failures"] += 1
                    if attempt >= self._max_write_attempts:
                        break
                    self._metrics["retry_attempts"] += 1
                    delay = min(
                        self._retry_base_seconds * (2 ** (attempt - 1)),
                        self._retry_max_seconds,
                    )
                    if delay:
                        await asyncio.sleep(delay)
                else:
                    error = None
                    break
            if error is not None:
                self._durability_failed = True
                self._metrics["provisional_lost_on_failure"] += len(provisional)
                self._metrics["failed_batches"] += len(requests)
                self._metrics["failed_rows"] += len(deduplicated)
                self._metrics["last_error"] = str(error)[:500]
                for request in requests:
                    if not request.acknowledgement.done():
                        request.acknowledgement.set_exception(error)
            else:
                self._metrics["batches_written"] += 1
                self._metrics["rows_written"] += int(written)
                for request in requests:
                    if not request.acknowledgement.done():
                        request.acknowledgement.set_result(len(request.rows))
        for _ in requests:
            self._durable.task_done()

    def _has_work(self) -> bool:
        return not self._durable.empty() or bool(self._provisional)

    @staticmethod
    def _consume_acknowledgement(acknowledgement: asyncio.Future[int]) -> None:
        if not acknowledgement.cancelled():
            acknowledgement.exception()


def _natural_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        _normalized_text(row.get("exchange"), lower=True),
        _normalized_text(row.get("market_type"), lower=True),
        _normalized_text(row.get("symbol"), lower=False),
        row.get("bucket_open_ms", row.get("bucket_start_ms")),
        _normalized_text(row.get("position_side"), lower=True),
    )


def _normalized_text(value: Any, *, lower: bool) -> Any:
    if not isinstance(value, str):
        return value
    normalized = value.strip()
    return normalized.lower() if lower else normalized.upper()


def _candidate_precedes(
    current: dict[str, Any],
    candidate: dict[str, Any],
) -> bool:
    current_received_at = int(
        current.get("received_at_ms", current.get("updated_at_ms", 0))
    )
    candidate_received_at = int(
        candidate.get("received_at_ms", candidate.get("updated_at_ms", 0))
    )
    if candidate_received_at != current_received_at:
        return candidate_received_at > current_received_at
    current_revision = int(current.get("revision", 0))
    candidate_revision = int(candidate.get("revision", 0))
    return candidate_revision >= current_revision


def _deduplicate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
    for row in rows:
        key = _natural_key(row)
        current = unique.get(key)
        if current is None:
            unique[key] = row
            continue
        current_final = bool(current.get("is_final", False))
        candidate_final = bool(row.get("is_final", False))
        if current_final and not candidate_final:
            continue
        if candidate_final and not current_final:
            unique[key] = row
            continue
        if _candidate_precedes(current, row):
            unique[key] = row
    return list(unique.values())


__all__ = ["LiquidationRollupWriter"]
