"""Inline live-gap repair between continuity and delivery.

The layer is intentionally enabled only for the opt-in CCXT transport.  It
uses CandleScope's existing REST transport, quota manager, raw normalizer, and
strict sequence checks; CCXT never decides whether a repair is complete.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any

from app.data_engine.interval_policy import parse_interval_ms

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import (
    DataSource,
    GapMarker,
    MarketEvent,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from .normalize import NormalizeLayer
from .transport import TransportLayer

logger = logging.getLogger("ingestion.L5_Recovery")
_SUPPORTED_STREAMS = frozenset({StreamType.KLINE, StreamType.AGG_TRADE})


class GapRecoveryError(RuntimeError):
    """A requested gap could not be proven complete and contiguous."""


class RecoveryLayer:
    """Keep a gap fail-closed through bounded authoritative REST retries."""

    def __init__(
        self,
        config: IngestionConfig,
        transport: TransportLayer,
        descriptor: StreamDescriptor,
    ) -> None:
        self._cfg = config
        self._transport = transport
        self._descriptor = descriptor
        self._normalizer = NormalizeLayer(config, descriptor)
        self._enabled = self._is_enabled()
        self._metrics = LayerMetrics("L5_Recovery")
        self._on_event: Callable[[MarketEvent], Awaitable[None]] | None = None
        self._on_gap: Callable[[GapMarker], Awaitable[None]] | None = None
        self._state_lock = asyncio.Lock()
        self._emit_lock = asyncio.Lock()
        self._active_gap: GapMarker | None = None
        self._target_end: int | None = None
        self._expected_missing = 0
        self._buffer: list[MarketEvent] = []
        self._task: asyncio.Task[None] | None = None
        self._repaired_keys: OrderedDict[int | str, bool] = OrderedDict()
        self._last_emitted_key: int | None = None
        self._state = "healthy" if self._enabled else "disabled"
        self._pending_since_ms: int | None = None
        self._next_retry_at_ms: int | None = None
        self._attempt = 0
        self._last_repair_attempts = 0
        self._last_error = ""
        self._terminal_failures = 0
        self._metrics.set("state", self._state)

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    @property
    def enabled(self) -> bool:
        return self._enabled

    def on_event(self, callback: Callable[[MarketEvent], Awaitable[None]]) -> None:
        self._on_event = callback

    def on_gap(self, callback: Callable[[GapMarker], Awaitable[None]]) -> None:
        self._on_gap = callback

    async def ingest_event(self, event: MarketEvent) -> None:
        dedup_key = event.dedup_key
        if dedup_key is not None and dedup_key in self._repaired_keys:
            self._metrics.inc("repaired_events_deduplicated")
            return
        overflowed = False
        overflow_task: asyncio.Task[None] | None = None
        async with self._state_lock:
            if self._active_gap is not None:
                self._buffer.append(event)
                self._metrics.inc("events_buffered")
                maximum = max(1, int(self._cfg.ccxt_recovery_buffer_max_events))
                if len(self._buffer) <= maximum:
                    return
                self._metrics.inc("buffer_overflows")
                overflowed = True
                overflow_task = self._task
        if overflowed:
            await self._abandon_repair(
                "recovery live-event buffer exceeded "
                f"{self._cfg.ccxt_recovery_buffer_max_events} events",
                task=overflow_task,
            )
            return
        await self._emit_event(event)

    async def ingest_gap(self, gap: GapMarker) -> None:
        if not self._enabled or not self._repairable(gap):
            self._metrics.inc("gaps_passthrough")
            await self._emit_gap(gap)
            return

        async with self._state_lock:
            if self._active_gap is not None:
                self._target_end = max(int(self._target_end or 0), int(gap.gap_end))
                self._expected_missing += int(gap.expected_count)
                self._metrics.inc("gaps_coalesced")
                return
            self._active_gap = gap
            self._target_end = int(gap.gap_end)
            self._expected_missing = int(gap.expected_count)
            self._buffer = []
            self._pending_since_ms = int(time.time() * 1000)
            self._next_retry_at_ms = None
            self._attempt = 0
            self._last_error = ""
            self._set_state_locked(
                "failed" if self._terminal_failures else "recovering"
            )
            self._metrics.inc("repairs_started")
            self._metrics.mark("last_repair_started_at")
            self._task = asyncio.create_task(
                self._run_repair(),
                name=f"gap_repair_{self._descriptor.key}",
            )

    async def wait_idle(self) -> None:
        """Wait for the current bounded repair, primarily for shutdown/tests."""

        task = self._task
        if task is not None:
            await asyncio.shield(task)

    async def stop(self) -> None:
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._finish_repair(
            [],
            success=False,
            reason="stream stopped before pending gap recovery completed",
            target_end=None,
        )

    def snapshot(self) -> dict[str, Any]:
        return {
            "layer": "L5_Recovery",
            "stream_key": self._descriptor.key,
            "enabled": self._enabled,
            "state": self._state,
            "repairing": self._active_gap is not None,
            "target_end": self._target_end,
            "expected_missing": self._expected_missing,
            "pending_since_ms": self._pending_since_ms,
            "next_retry_at_ms": self._next_retry_at_ms,
            "repair_attempt": self._attempt,
            "last_repair_attempts": self._last_repair_attempts,
            "last_error": self._last_error,
            "terminal_failures": self._terminal_failures,
            "buffered_events": len(self._buffer),
            "buffer_capacity": max(
                1,
                int(self._cfg.ccxt_recovery_buffer_max_events),
            ),
            "retry": {
                "attempt_timeout_seconds": max(
                    0.1,
                    float(self._cfg.ccxt_recovery_timeout_seconds),
                ),
                "initial_seconds": max(
                    0.0,
                    float(self._cfg.ccxt_recovery_retry_initial_seconds),
                ),
                "max_seconds": max(
                    0.0,
                    float(self._cfg.ccxt_recovery_retry_max_seconds),
                ),
                "deadline_seconds": max(
                    0.0,
                    float(self._cfg.ccxt_recovery_retry_deadline_seconds),
                ),
            },
            "repaired_dedup_cache_size": len(self._repaired_keys),
            "last_emitted_key": self._last_emitted_key,
            "metrics": self._metrics.snapshot(),
        }

    async def _run_repair(self) -> None:
        loop = asyncio.get_running_loop()
        started = loop.time()
        deadline = max(
            0.0,
            float(self._cfg.ccxt_recovery_retry_deadline_seconds),
        )
        delay = max(
            0.0,
            float(self._cfg.ccxt_recovery_retry_initial_seconds),
        )
        maximum_delay = max(
            0.1,
            delay,
            float(self._cfg.ccxt_recovery_retry_max_seconds),
        )
        timeout = max(0.1, float(self._cfg.ccxt_recovery_timeout_seconds))

        while True:
            async with self._state_lock:
                gap = self._active_gap
                target_end = self._target_end
                if gap is None or target_end is None:
                    return
                self._attempt += 1
                self._next_retry_at_ms = None
                self._metrics.inc("repair_attempts")
                self._metrics.mark("last_repair_attempt_at")
            try:
                async with asyncio.timeout(timeout):
                    recovered = await self._fetch_range(
                        int(gap.gap_start),
                        int(target_end),
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - every failed repair is retryable
                reason = f"{type(exc).__name__}: {exc}"[:256]
                logger.warning(
                    "Gap repair attempt %s failed (%s): %s",
                    self._attempt,
                    self._descriptor.key,
                    exc,
                )
                async with self._state_lock:
                    if self._active_gap is None:
                        return
                    self._last_error = reason
                    self._metrics.inc("repair_attempts_failed")
                    self._metrics.set("last_failure", reason)
                    self._metrics.mark("last_repair_attempt_failed_at")
                remaining = deadline - (loop.time() - started)
                if deadline <= 0 or remaining <= 0:
                    self._metrics.inc("retry_deadlines_exhausted")
                    await self._finish_repair(
                        [],
                        success=False,
                        reason=reason,
                        target_end=None,
                    )
                    return
                sleep_for = min(delay, remaining)
                async with self._state_lock:
                    self._next_retry_at_ms = int(
                        time.time() * 1000 + sleep_for * 1000
                    )
                    self._metrics.inc("retries_scheduled")
                await asyncio.sleep(sleep_for)
                delay = min(maximum_delay, max(delay * 2, 0.1))
                continue

            finished = await self._finish_repair(
                recovered,
                success=True,
                reason="",
                target_end=target_end,
            )
            if finished:
                return
            self._metrics.inc("repair_targets_extended")

    async def _finish_repair(
        self,
        recovered: list[MarketEvent],
        *,
        success: bool,
        reason: str,
        target_end: int | None,
    ) -> bool:
        async with self._emit_lock:
            async with self._state_lock:
                gap = self._active_gap
                current_target_end = self._target_end
                expected_missing = self._expected_missing
                if gap is None or current_target_end is None:
                    return True
                if (
                    success
                    and target_end is not None
                    and target_end != current_target_end
                ):
                    return False
                if success:
                    self._last_error = ""
                else:
                    self._last_error = reason[:256]
                buffered = self._take_buffered_locked(success=success)

            if success:
                buffered_keys = {
                    event.continuity_key
                    for event in buffered
                    if event.continuity_key is not None
                }
                recovered = [
                    event
                    for event in recovered
                    if event.continuity_key not in buffered_keys
                ]
                recovered_ids = {id(event) for event in recovered}
                merged = [*recovered, *buffered]
                merged.sort(key=self._event_sort_key)
                for event in merged:
                    if id(event) in recovered_ids:
                        self._remember_repaired(event)
                    await self._emit_event_unlocked(event)
                filled = replace(
                    gap,
                    gap_end=current_target_end,
                    expected_count=len(recovered),
                    filled=True,
                )
                await self._emit_gap(filled)
                self._metrics.inc("repairs_succeeded")
                self._metrics.inc("events_recovered", len(recovered))
                self._metrics.mark("last_repair_succeeded_at")
            else:
                failed = replace(
                    gap,
                    gap_end=current_target_end,
                    expected_count=expected_missing,
                    filled=False,
                )
                await self._emit_gap(failed)
                for event in sorted(buffered, key=self._event_sort_key):
                    await self._emit_event_unlocked(event)
                self._metrics.inc("repairs_failed")
                self._metrics.set("last_failure", reason[:256])
                self._metrics.mark("last_repair_failed_at")
            return True

    async def _abandon_repair(
        self,
        reason: str,
        *,
        task: asyncio.Task[None] | None,
    ) -> None:
        current = asyncio.current_task()
        if task is not None and task is not current and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._finish_repair(
            [],
            success=False,
            reason=reason,
            target_end=None,
        )

    def _take_buffered_locked(self, *, success: bool) -> list[MarketEvent]:
        buffered = self._buffer
        self._buffer = []
        self._last_repair_attempts = self._attempt
        self._active_gap = None
        self._target_end = None
        self._expected_missing = 0
        self._pending_since_ms = None
        self._next_retry_at_ms = None
        self._attempt = 0
        self._task = None
        if not success:
            self._terminal_failures += 1
            self._set_state_locked("failed")
        elif self._terminal_failures:
            self._set_state_locked("failed")
        else:
            self._set_state_locked("healthy")
        return buffered

    def _set_state_locked(self, state: str) -> None:
        self._state = state
        self._metrics.set("state", state)

    async def _fetch_range(self, gap_start: int, gap_end: int) -> list[MarketEvent]:
        if self._descriptor.stream_type == StreamType.AGG_TRADE:
            return await self._fetch_aggregate_trades(gap_start + 1, gap_end - 1)
        if self._descriptor.stream_type == StreamType.KLINE:
            interval_ms = parse_interval_ms(self._descriptor.interval or "")
            if interval_ms is None or interval_ms <= 0:
                raise GapRecoveryError(
                    f"inline recovery requires a fixed-width interval: "
                    f"{self._descriptor.interval}"
                )
            return await self._fetch_klines(
                gap_start + interval_ms,
                gap_end - interval_ms,
                interval_ms,
            )
        raise GapRecoveryError("stream is not repairable")

    async def _fetch_aggregate_trades(
        self,
        first_id: int,
        last_id: int,
    ) -> list[MarketEvent]:
        if first_id > last_id:
            return []
        expected_count = last_id - first_id + 1
        self._guard_repair_size(expected_count)
        events: list[MarketEvent] = []
        cursor = first_id
        while cursor <= last_id:
            rows = await self._fetch_page(
                TransportRequest(
                    descriptor=self._descriptor,
                    limit=min(1000, last_id - cursor + 1),
                    from_id=cursor,
                    history=True,
                )
            )
            page = self._normalize_rows(rows, lower=cursor, upper=last_id)
            self._validate_page(page, cursor, step=1)
            events.extend(page)
            cursor = int(page[-1].continuity_key or -1) + 1
        self._validate_complete(events, first_id, last_id, step=1)
        return events

    async def _fetch_klines(
        self,
        first_open_ms: int,
        last_open_ms: int,
        interval_ms: int,
    ) -> list[MarketEvent]:
        if first_open_ms > last_open_ms:
            return []
        expected_count = ((last_open_ms - first_open_ms) // interval_ms) + 1
        self._guard_repair_size(expected_count)
        events: list[MarketEvent] = []
        cursor = first_open_ms
        while cursor <= last_open_ms:
            page_limit = min(
                1000,
                ((last_open_ms - cursor) // interval_ms) + 1,
            )
            rows = await self._fetch_page(
                TransportRequest(
                    descriptor=self._descriptor,
                    limit=page_limit,
                    start_ms=cursor,
                    end_ms=last_open_ms,
                    history=True,
                )
            )
            page = self._normalize_rows(rows, lower=cursor, upper=last_open_ms)
            self._validate_page(page, cursor, step=interval_ms)
            events.extend(page)
            cursor = int(page[-1].continuity_key or -1) + interval_ms
        self._validate_complete(
            events,
            first_open_ms,
            last_open_ms,
            step=interval_ms,
        )
        return events

    async def _fetch_page(self, request: TransportRequest) -> list[Any]:
        self._metrics.inc("rest_pages_requested")
        return await self._transport.http_fetch(request)

    def _normalize_rows(
        self,
        rows: list[Any],
        *,
        lower: int,
        upper: int,
    ) -> list[MarketEvent]:
        events: list[MarketEvent] = []
        for row in rows:
            normalized = self._normalizer.parse_raw(
                replace(row, source=DataSource.HTTP_BACKFILL)
            )
            if normalized is None or normalized.continuity_key is None:
                continue
            if lower <= normalized.continuity_key <= upper:
                events.append(normalized)
        events.sort(key=self._event_sort_key)
        return events

    @staticmethod
    def _validate_page(
        events: list[MarketEvent],
        expected_first: int,
        *,
        step: int,
    ) -> None:
        if not events:
            raise GapRecoveryError("REST repair returned an empty page")
        expected = expected_first
        for event in events:
            if event.continuity_key != expected:
                raise GapRecoveryError(
                    f"REST repair is not contiguous: expected {expected}, "
                    f"got {event.continuity_key}"
                )
            expected += step

    @staticmethod
    def _validate_complete(
        events: list[MarketEvent],
        first: int,
        last: int,
        *,
        step: int,
    ) -> None:
        expected_count = ((last - first) // step) + 1
        if (
            len(events) != expected_count
            or events[0].continuity_key != first
            or events[-1].continuity_key != last
        ):
            raise GapRecoveryError(
                f"REST repair incomplete: expected {expected_count}, got {len(events)}"
            )

    def _guard_repair_size(self, expected_count: int) -> None:
        maximum = max(1, int(self._cfg.ccxt_recovery_max_events))
        if expected_count > maximum:
            raise GapRecoveryError(
                f"gap has {expected_count} events, limit is {maximum}"
            )

    def _repairable(self, gap: GapMarker) -> bool:
        return (
            gap.stream_type == self._descriptor.stream_type
            and gap.expected_count > 0
            and gap.expected_count <= max(1, int(self._cfg.ccxt_recovery_max_events))
        )

    def _is_enabled(self) -> bool:
        return (
            bool(self._cfg.ccxt_stream_enabled)
            and self._descriptor.exchange.strip().lower() == "binance"
            and self._descriptor.market_type.strip().lower() == "futures"
            and self._descriptor.stream_type in _SUPPORTED_STREAMS
        )

    async def _emit_event(self, event: MarketEvent) -> None:
        async with self._emit_lock:
            await self._emit_event_unlocked(event)

    async def _emit_event_unlocked(self, event: MarketEvent) -> None:
        if self._enabled and self._drop_replayed_ordered_event(event):
            return
        self._metrics.inc("events_emitted")
        if self._on_event is not None:
            await self._on_event(event)

    def _drop_replayed_ordered_event(self, event: MarketEvent) -> bool:
        """Keep the CCXT lane monotonic across reconnect replay windows.

        CCXT/Binance can deliver an older raw-message tail after a websocket
        reconnect.  Continuity observes the regression, but its intentionally
        small LRU cannot suppress a replay larger than that cache.  Recovery is
        the final ordered boundary before delivery, so retain a high-water mark
        here instead of allowing a stale replay to escape downstream.

        Live K-lines may legitimately revise the current open time, while
        trades have immutable sequence IDs.  Therefore equal K-line keys pass;
        equal aggregate-trade keys are duplicates and are dropped.
        """

        key = event.continuity_key
        if key is None:
            return False
        key = int(key)
        previous = self._last_emitted_key
        if previous is not None:
            if key < previous:
                self._metrics.inc("events_out_of_order_dropped")
                self._metrics.mark("last_out_of_order_drop_at")
                return True
            if key == previous and event.event_type in {
                StreamType.AGG_TRADE,
                StreamType.TRADE,
            }:
                self._metrics.inc("events_duplicate_dropped")
                self._metrics.mark("last_duplicate_drop_at")
                return True
        if previous is None or key > previous:
            self._last_emitted_key = key
        return False

    async def _emit_gap(self, gap: GapMarker) -> None:
        self._metrics.inc("gaps_emitted")
        if self._on_gap is not None:
            await self._on_gap(gap)

    def _remember_repaired(self, event: MarketEvent) -> None:
        key = event.dedup_key
        if key is None:
            return
        self._repaired_keys[key] = True
        while len(self._repaired_keys) > self._cfg.continuity_buffer_size:
            self._repaired_keys.popitem(last=False)

    @staticmethod
    def _event_sort_key(event: MarketEvent) -> int:
        return int(event.continuity_key or -1)
