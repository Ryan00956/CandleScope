"""
Historical Fetcher — retrieves missing data from the exchange REST API.

Responsibilities:
  * Execute ``BackfillTask`` objects from the Planner
  * Reuse ingestion's ``TransportLayer`` (L1) for HTTP requests
  * Reuse ingestion's ``NormalizeLayer`` (L4) for response parsing
  * Paginate automatically (1000 bars per page)
  * Concurrency control via asyncio.Semaphore
  * Rate limiting between requests
  * Retry on transient failures
  * Convert ``MarketEvent`` → ``FetchedBar``
  * Report progress via callbacks

Extension points:
  * ``on_fetch_progress(callback)``  — per-page progress
  * ``on_fetch_error(callback)``     — per-error callback
  * ``set_rate_limiter(fn)``         — custom rate-limit logic
  * ``set_transport(transport)``     — swap transport at runtime

Usage::

    fetcher = HistoricalFetcher(config, transport)
    results = await fetcher.fetch(plan.tasks)
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Callable, Awaitable

from app.data_engine.interval_policy import parse_interval_ms

from ..ingestion.config import IngestionConfig
from ..ingestion.metrics import LayerMetrics
from ..ingestion.models import (
    StreamDescriptor,
    StreamType,
    TransportRequest,
    MarketEvent,
    DataSource,
)
from ..ingestion.transport import TransportLayer, TransportError
from ..ingestion.normalize import NormalizeLayer
from .config import BackfillConfig
from .models import (
    BackfillTask,
    BackfillStatus,
    FetchedBar,
    FetchResult,
)

logger = logging.getLogger("backfill.Fetcher")

# Type aliases
ProgressCallback = Callable[[BackfillTask, int, int], Awaitable[None]]  # task, fetched, total
ErrorCallback = Callable[[BackfillTask, str], Awaitable[None]]  # task, error_msg
RateLimiter = Callable[[], Awaitable[None]]  # async sleep / token-bucket


class HistoricalFetcher:
    """Fetches historical bar data from the exchange REST API.

    Reuses the ingestion ``TransportLayer`` for HTTP I/O and
    ``NormalizeLayer`` for parsing raw responses into ``MarketEvent``.
    """

    def __init__(
        self,
        config: BackfillConfig,
        transport: TransportLayer,
        ingestion_config: IngestionConfig | None = None,
    ) -> None:
        self._cfg = config
        self._transport = transport
        self._ingestion_cfg = ingestion_config or IngestionConfig()
        self._metrics = LayerMetrics("HistoricalFetcher")

        # Concurrency control
        self._semaphore = asyncio.Semaphore(self._cfg.fetch_concurrency)
        self._exchange_semaphores: dict[tuple[str, str], asyncio.Semaphore] = {}
        self._exchange_rate_locks: dict[tuple[str, str], asyncio.Lock] = defaultdict(asyncio.Lock)
        self._exchange_next_request_at: dict[tuple[str, str], float] = {}

        # Extension points
        self._progress_callbacks: list[ProgressCallback] = []
        self._error_callbacks: list[ErrorCallback] = []
        self._custom_rate_limiter: RateLimiter | None = None

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "component": "HistoricalFetcher",
            "concurrency": self._cfg.fetch_concurrency,
            "okx_concurrency": self._cfg.fetch_okx_concurrency,
            "batch_size": self._cfg.fetch_batch_size,
            "rate_limit_delay": self._cfg.fetch_rate_limit_delay,
            "okx_rate_limit_delay": self._cfg.fetch_okx_rate_limit_delay,
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Extension points ─────────────────────────────

    def on_fetch_progress(self, callback: ProgressCallback) -> None:
        """Register a progress callback, invoked after each successful page.

        Args:
            callback: ``async (task, bars_fetched_so_far, estimated_total) → None``
        """
        self._progress_callbacks.append(callback)

    def remove_progress_callback(self, callback: ProgressCallback) -> None:
        self._progress_callbacks = [
            cb for cb in self._progress_callbacks if cb is not callback
        ]

    def on_fetch_error(self, callback: ErrorCallback) -> None:
        """Register an error callback, invoked on each fetch failure.

        Args:
            callback: ``async (task, error_message) → None``
        """
        self._error_callbacks.append(callback)

    def remove_error_callback(self, callback: ErrorCallback) -> None:
        self._error_callbacks = [
            cb for cb in self._error_callbacks if cb is not callback
        ]

    def set_rate_limiter(self, limiter: RateLimiter) -> None:
        """Override the default rate limiter.

        The limiter is an async callable that should ``await`` for the
        appropriate delay before the next request is allowed.

        Example — token bucket::

            async def my_limiter():
                await token_bucket.acquire()
            fetcher.set_rate_limiter(my_limiter)
        """
        self._custom_rate_limiter = limiter

    def set_transport(self, transport: TransportLayer) -> None:
        """Swap the transport layer at runtime (e.g. for testing)."""
        self._transport = transport

    # ── Public: Fetch ────────────────────────────────────────

    async def fetch(self, tasks: list[BackfillTask]) -> list[FetchResult]:
        """Execute all fetch tasks, respecting concurrency limits.

        Args:
            tasks: Ordered list of ``BackfillTask`` from the Planner.

        Returns:
            A list of ``FetchResult``, one per task, in the same order.
        """
        if not tasks:
            return []

        self._metrics.inc("fetch_runs")
        self._metrics.mark("last_fetch_at")
        logger.info("Historical fetch started: %d tasks", len(tasks))

        # Execute tasks with bounded concurrency
        coros = [self._fetch_task(task) for task in tasks]
        raw_results = await asyncio.gather(*coros, return_exceptions=True)

        # Handle any unexpected exceptions returned by gather
        results: list[FetchResult] = []
        for i, r in enumerate(raw_results):
            if isinstance(r, BaseException):
                self._metrics.inc("fetch_errors")
                logger.error(
                    "Task %s raised unexpected exception: %s",
                    tasks[i].task_key, r, exc_info=r,
                )
                results.append(FetchResult(
                    task=tasks[i],
                    status=BackfillStatus.FAILED,
                    errors=[str(r)],
                ))
            else:
                results.append(r)

        total_bars = sum(r.bars_count for r in results)
        failed = sum(1 for r in results if r.status == BackfillStatus.FAILED)

        self._metrics.inc("total_bars_fetched", total_bars)
        self._metrics.set("last_fetch_total_bars", total_bars)
        logger.info(
            "Historical fetch completed: %d tasks, %d bars, %d failed",
            len(tasks), total_bars, failed,
        )
        return list(results)

    # ── Internal: Single task execution ──────────────────────

    async def _fetch_task(self, task: BackfillTask) -> FetchResult:
        """Fetch all pages for a single task."""
        async with self._semaphore:
            return await self._fetch_task_inner(task)

    async def _fetch_task_inner(self, task: BackfillTask) -> FetchResult:
        """Inner fetch logic with pagination and retry."""
        start_time = time.monotonic()
        all_bars: list[FetchedBar] = []
        errors: list[str] = []
        pages_fetched = 0

        interval_ms = parse_interval_ms(task.interval)
        if interval_ms is None:
            msg = f"Cannot parse interval '{task.interval}'"
            logger.error(msg)
            return FetchResult(
                task=task,
                status=BackfillStatus.FAILED,
                errors=[msg],
                elapsed_ms=self._elapsed_ms(start_time),
            )

        # Build a StreamDescriptor for this task
        descriptor = StreamDescriptor(
            symbol=task.symbol,
            stream_type=StreamType.KLINE,
            interval=task.interval,
            exchange=task.exchange,
            market_type=task.market_type,
        )

        # Create a normalizer for parsing raw REST responses
        normalizer = NormalizeLayer(self._ingestion_cfg, descriptor)

        # Estimate total bars for progress reporting
        now_ms = int(time.time() * 1000)
        total_span_ms = (task.end_ms or now_ms) - (task.start_ms or 0)
        estimated_total = max(1, total_span_ms // interval_ms) if interval_ms > 0 else 0

        # Pagination: walk backward from end_ms
        cursor_end_ms = task.end_ms or now_ms
        batch_size = self._cfg.fetch_batch_size
        max_retries = self._cfg.fetch_max_retries
        max_total = self._cfg.fetch_max_total_bars

        while True:
            # Safety: cap total bars
            if len(all_bars) >= max_total:
                logger.warning(
                    "Task %s hit max total bars (%d), stopping",
                    task.task_key, max_total,
                )
                break

            req = TransportRequest(
                descriptor=descriptor,
                limit=batch_size,
                start_ms=int(task.start_ms) if task.start_ms is not None else None,
                end_ms=int(cursor_end_ms),
            )

            # Fetch with retry
            page_bars: list[FetchedBar] = []
            retry_count = 0
            success = False
            max_attempts = max_retries + 1

            while retry_count < max_attempts:
                try:
                    exchange_semaphore = self._get_exchange_semaphore(task)
                    async with exchange_semaphore:
                        await self._rate_limit(task)
                        raw_messages = await self._transport.http_fetch(req)
                    self._metrics.inc("http_pages_fetched")

                    for msg in raw_messages:
                        msg.source = DataSource.HTTP_BACKFILL
                        event = normalizer.parse_raw(msg)
                        if event is None:
                            continue
                        bar = self._event_to_bar(event, task)
                        if bar is not None:
                            page_bars.append(bar)

                    success = True
                    break

                except TransportError as exc:
                    retry_count += 1
                    error_msg = (
                        f"Page fetch error (attempt {retry_count}/{max_attempts}): {exc}"
                    )
                    logger.warning(error_msg)
                    if retry_count >= max_attempts:
                        errors.append(error_msg)
                        await self._fire_error(task, error_msg)
                    else:
                        await self._rate_limit(
                            task,
                            penalty_seconds=self._retry_backoff_seconds(task, exc),
                        )

                except Exception as exc:
                    error_msg = f"Unexpected fetch error: {exc}"
                    errors.append(error_msg)
                    logger.error(error_msg, exc_info=True)
                    await self._fire_error(task, error_msg)
                    break

            if not success:
                break

            pages_fetched += 1

            if not page_bars:
                break  # No more data available

            all_bars.extend(page_bars)
            await self._fire_progress(task, len(all_bars), estimated_total)

            # Advance cursor: move to before the oldest bar in this page
            oldest_bar_time = min(b.open_time for b in page_bars)
            if oldest_bar_time >= cursor_end_ms:
                logger.warning(
                    "Task %s pagination stalled: oldest=%d cursor_end=%d; stopping",
                    task.task_key,
                    oldest_bar_time,
                    cursor_end_ms,
                )
                break
            if task.start_ms is not None and oldest_bar_time <= task.start_ms:
                break  # Covered entire requested range

            cursor_end_ms = oldest_bar_time - 1

        # Deduplicate by open_time and sort ascending
        seen: set[int] = set()
        unique_bars: list[FetchedBar] = []
        for bar in sorted(all_bars, key=lambda b: b.open_time):
            if bar.open_time not in seen:
                seen.add(bar.open_time)
                unique_bars.append(bar)
        all_bars = unique_bars

        # Filter to task range
        if task.start_ms is not None:
            all_bars = [b for b in all_bars if b.open_time >= task.start_ms]
        if task.end_ms is not None:
            all_bars = [b for b in all_bars if b.open_time <= task.end_ms]

        # Determine status
        elapsed = self._elapsed_ms(start_time)
        if errors and not all_bars:
            status = BackfillStatus.FAILED
        elif errors:
            status = BackfillStatus.PARTIAL
        else:
            status = BackfillStatus.COMPLETED

        result = FetchResult(
            task=task,
            bars=all_bars,
            status=status,
            elapsed_ms=elapsed,
            pages_fetched=pages_fetched,
            errors=errors,
        )

        logger.info(
            "Task %s: %d bars in %dms (%d pages, status=%s)",
            task.task_key, len(all_bars), elapsed, pages_fetched, status.value,
        )
        return result

    # ── Internal: MarketEvent → FetchedBar ───────────────────

    @staticmethod
    def _event_to_bar(event: MarketEvent, task: BackfillTask) -> FetchedBar | None:
        """Convert a MarketEvent (kline) to a FetchedBar."""
        if event.event_type != StreamType.KLINE:
            return None

        data = event.data
        # Skip unclosed bars
        if not data.get("is_closed", True):
            return None

        try:
            return FetchedBar(
                symbol=task.symbol,
                interval=task.interval,
                open_time=int(data["open_time"]),
                close_time=int(data["close_time"]),
                open=float(data["open"]),
                high=float(data["high"]),
                low=float(data["low"]),
                close=float(data["close"]),
                volume=float(data["volume"]),
                exchange=task.exchange,
                market_type=task.market_type,
                quote_volume=float(data.get("quote_volume", 0)),
                trades=int(data.get("trades", 0)),
                taker_buy_base=float(data.get("taker_buy_base", 0)),
                taker_buy_quote=float(data.get("taker_buy_quote", 0)),
                source="backfill",
            )
        except (KeyError, ValueError, TypeError) as exc:
            logger.warning("Failed to convert event to bar: %s", exc)
            return None

    # ── Internal: Rate limiting ──────────────────────────────

    async def _rate_limit(
        self,
        task: BackfillTask | None = None,
        penalty_seconds: float = 0.0,
    ) -> None:
        """Apply rate limiting between requests."""
        if self._custom_rate_limiter is not None:
            await self._custom_rate_limiter()
            if penalty_seconds > 0:
                await asyncio.sleep(penalty_seconds)
            return

        if task is None:
            base_delay = self._cfg.fetch_rate_limit_delay
            if base_delay > 0 or penalty_seconds > 0:
                await asyncio.sleep(base_delay + penalty_seconds)
            return

        key = self._exchange_key(task)
        lock = self._exchange_rate_locks[key]
        base_delay = self._base_delay_for_task(task)

        async with lock:
            now = time.monotonic()
            next_allowed_at = self._exchange_next_request_at.get(key, now)
            wait_seconds = max(0.0, next_allowed_at - now)
            if wait_seconds > 0:
                await asyncio.sleep(wait_seconds)
            if penalty_seconds > 0:
                await asyncio.sleep(penalty_seconds)
            self._exchange_next_request_at[key] = time.monotonic() + base_delay

    def _get_exchange_semaphore(self, task: BackfillTask) -> asyncio.Semaphore:
        key = self._exchange_key(task)
        sem = self._exchange_semaphores.get(key)
        if sem is not None:
            return sem
        limit = self._cfg.fetch_okx_concurrency if key[0] == "okx" else self._cfg.fetch_concurrency
        sem = asyncio.Semaphore(max(1, int(limit)))
        self._exchange_semaphores[key] = sem
        return sem

    @staticmethod
    def _exchange_key(task: BackfillTask) -> tuple[str, str]:
        return (
            str(task.exchange or "binance").strip().lower(),
            str(task.market_type or "spot").strip().lower(),
        )

    def _base_delay_for_task(self, task: BackfillTask) -> float:
        if self._exchange_key(task)[0] == "okx":
            return max(0.0, self._cfg.fetch_okx_rate_limit_delay)
        return max(0.0, self._cfg.fetch_rate_limit_delay)

    def _retry_backoff_seconds(self, task: BackfillTask, exc: TransportError) -> float:
        message = str(exc)
        if "HTTP 429" in message:
            if self._exchange_key(task)[0] == "okx":
                return max(self._cfg.fetch_429_backoff_seconds, self._cfg.fetch_okx_rate_limit_delay)
            return max(self._cfg.fetch_429_backoff_seconds, self._cfg.fetch_rate_limit_delay)
        return 0.0

    # ── Internal: Callbacks ──────────────────────────────────

    async def _fire_progress(
        self, task: BackfillTask, fetched: int, total: int,
    ) -> None:
        for cb in self._progress_callbacks:
            try:
                await cb(task, fetched, total)
            except Exception as exc:
                self._metrics.inc("callback_errors")
                logger.error("Progress callback error: %s", exc, exc_info=True)

    async def _fire_error(self, task: BackfillTask, error: str) -> None:
        for cb in self._error_callbacks:
            try:
                await cb(task, error)
            except Exception as exc:
                self._metrics.inc("callback_errors")
                logger.error("Error callback error: %s", exc, exc_info=True)

    # ── Internal: Helpers ────────────────────────────────────

    @staticmethod
    def _elapsed_ms(start: float) -> int:
        return int((time.monotonic() - start) * 1000)
