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
from dataclasses import replace
from typing import Callable, Awaitable, Any

from app.data_engine.market_data.kline_metrics import declared_enhanced_fields
from app.data_engine.series_identity import identity_from_metadata
from app.exchanges import (
    HistoricalRequest,
    RateLimitDeferred,
    RateLimitPolicy,
    RateLimitRule,
    bootstrap_default_adapters,
    get_shared_rate_limit_manager,
    get_shared_rate_limit_semaphore,
    get_exchange_registry,
)
from app.exchanges.rate_limits import RateLimitReservation
from app.data_engine.interval_policy import parse_interval_ms, parse_interval_spec

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
from .source_router import ArchiveRoutePlan, HistoricalSourceRouter

logger = logging.getLogger("backfill.Fetcher")

# Type aliases
ProgressCallback = Callable[
    [BackfillTask, int, int], Awaitable[None]
]  # task, fetched, total
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
        *,
        source_router: HistoricalSourceRouter | None = None,
    ) -> None:
        self._cfg = config
        self._transport = transport
        self._ingestion_cfg = ingestion_config or IngestionConfig()
        self._metrics = LayerMetrics("HistoricalFetcher")
        self._last_history_diagnostics: dict[str, Any] = {}

        # Concurrency control
        self._semaphore = asyncio.Semaphore(self._global_fetch_concurrency())
        self._rate_limit_manager = get_shared_rate_limit_manager()
        self._source_router = source_router
        if (
            self._source_router is None
            and self._cfg.history_archive_enabled
            and isinstance(transport, TransportLayer)
        ):
            proxy_resolver = getattr(transport, "_resolve_proxy", None)
            self._source_router = HistoricalSourceRouter(
                config,
                proxy_resolver=proxy_resolver if callable(proxy_resolver) else None,
            )

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
            "global_concurrency": self._global_fetch_concurrency(),
            "binance_spot_concurrency": getattr(
                self._cfg,
                "fetch_binance_spot_concurrency",
                None,
            ),
            "binance_futures_concurrency": self._cfg.fetch_binance_futures_concurrency,
            "okx_concurrency": self._cfg.fetch_okx_concurrency,
            "batch_size": self._cfg.fetch_batch_size,
            "rate_limit_delay": self._cfg.fetch_rate_limit_delay,
            "binance_futures_rate_limit_delay": self._cfg.fetch_binance_futures_rate_limit_delay,
            "okx_rate_limit_delay": self._cfg.fetch_okx_rate_limit_delay,
            "exchange_rate_limits": self._rate_limit_manager.snapshot(),
            "history_archive": (
                self._source_router.snapshot()
                if self._source_router is not None
                else {
                    "enabled": False,
                    "reason": "transport_not_archive_capable",
                }
            ),
            "last_history_request": dict(self._last_history_diagnostics),
            "metrics": self._metrics.snapshot(),
        }

    async def probe_history_archives(self) -> dict[str, Any]:
        if self._source_router is None:
            return {"enabled": False, "reason": "archive_router_unavailable"}
        return await self._source_router.probe_enabled_capabilities()

    def acknowledge_archive_imports(
        self,
        fetch_results: list[FetchResult],
    ) -> None:
        """Confirm archive receipts only after reconciliation succeeds."""
        if self._source_router is None:
            return
        object_keys: set[str] = set()
        for result in fetch_results:
            raw = result.metadata.get("archive_objects")
            if not isinstance(raw, list):
                continue
            for receipt in raw:
                if not isinstance(receipt, dict):
                    continue
                object_key = str(receipt.get("object_key") or "").strip()
                if object_key:
                    object_keys.add(object_key)
        if object_keys:
            self._source_router.acknowledge_imports(object_keys)

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

        fetch_started = time.monotonic()
        self._metrics.inc("fetch_runs")
        self._metrics.mark("last_fetch_at")
        logger.info("Historical fetch started: %d tasks", len(tasks))

        route_plan = (
            await self._source_router.prepare(tasks)
            if self._source_router is not None
            else ArchiveRoutePlan({}, {}, {})
        )

        # REST requests keep the existing bounded semaphore. Archive downloads
        # use their own two-wide semaphore and are already running here, so
        # partial/current REST tails can progress in parallel.
        coros = [self._fetch_task(task, route_plan) for task in tasks]
        raw_results = await asyncio.gather(*coros, return_exceptions=True)

        deferred = [
            result for result in raw_results if isinstance(result, RateLimitDeferred)
        ]
        if deferred:
            # One scheduler chunk may contain several physical gap tasks.  A
            # parent retry must wait for the latest shared-bucket deadline so
            # it does not immediately re-enter and churn the queue again.
            raise max(
                deferred,
                key=lambda exc: int(exc.retry_at_ms or 0),
            )

        # Handle any unexpected exceptions returned by gather
        results: list[FetchResult] = []
        for i, r in enumerate(raw_results):
            if isinstance(r, BaseException):
                self._metrics.inc("fetch_errors")
                logger.error(
                    "Task %s raised unexpected exception: %s",
                    tasks[i].task_key,
                    r,
                    exc_info=r,
                )
                results.append(
                    FetchResult(
                        task=tasks[i],
                        status=BackfillStatus.FAILED,
                        errors=[str(r)],
                    )
                )
            else:
                results.append(r)

        total_bars = sum(r.bars_count for r in results)
        failed = sum(1 for r in results if r.status == BackfillStatus.FAILED)

        self._metrics.inc("total_bars_fetched", total_bars)
        self._metrics.set("last_fetch_total_bars", total_bars)
        logger.info(
            "Historical fetch completed: %d tasks, %d bars, %d failed",
            len(tasks),
            total_bars,
            failed,
        )
        if self._source_router is not None:
            # Cold parent archives are intentionally launched only after the
            # foreground REST pass has completed.  The task is not awaited:
            # later scheduler chunks join the same singleflight objects.
            self._source_router.start_deferred_prefetch(route_plan)
        fetch_elapsed_ms = int((time.monotonic() - fetch_started) * 1_000)
        self._metrics.inc("fetch_elapsed_ms_total", fetch_elapsed_ms)
        self._metrics.set("last_fetch_elapsed_ms", fetch_elapsed_ms)
        return list(results)

    # ── Internal: Single task execution ──────────────────────

    async def _fetch_task(
        self,
        task: BackfillTask,
        route_plan: ArchiveRoutePlan,
    ) -> FetchResult:
        """Fetch one task from archive-covered slices plus REST residuals."""
        refs = route_plan.refs_for(task)
        if refs:
            return await self._fetch_routed_task(task, refs, route_plan)
        return await self._fetch_rest_task(task)

    async def _fetch_rest_task(self, task: BackfillTask) -> FetchResult:
        """Fetch all REST pages for a single task."""
        async with self._semaphore:
            return await self._fetch_rest_task_inner(task)

    async def _fetch_rest_task_inner(self, task: BackfillTask) -> FetchResult:
        """Inner fetch logic with pagination and retry."""
        start_time = time.monotonic()
        all_bars: list[FetchedBar] = []
        errors: list[str] = []
        pages_fetched = 0
        source_complete = False
        empty_reason: str | None = None

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

        # Pagination is exchange-owned because cursor semantics vary by API.
        pagination_policy = self._pagination_policy(task)
        current_request = pagination_policy.first_request(
            task,
            batch_size=self._cfg.fetch_batch_size,
            now_ms=now_ms,
        )
        batch_size = self._cfg.fetch_batch_size
        max_retries = self._cfg.fetch_max_retries
        max_total = self._cfg.fetch_max_total_bars

        while current_request is not None:
            # Safety: cap total bars
            if len(all_bars) >= max_total:
                logger.warning(
                    "Task %s hit max total bars (%d), stopping",
                    task.task_key,
                    max_total,
                )
                break

            req = current_request

            # Fetch with retry
            page_bars: list[FetchedBar] = []
            retry_count = 0
            success = False
            max_attempts = max_retries + 1

            while retry_count < max_attempts:
                try:
                    # Check without consuming before the endpoint gate. The
                    # consuming admission happens after the gate so a request
                    # queued behind an in-flight 418 cannot slip through with
                    # a stale reservation.
                    await self._rate_limit_admission(task, req)
                    exchange_semaphore = self._get_exchange_semaphore(task, req)
                    async with exchange_semaphore:
                        quota_reservation: RateLimitReservation | None = None
                        if self._custom_rate_limiter is None:
                            quota_reservation = await self._rate_limit(task, req)
                        req.quota_acquired = True
                        req.defer_on_rate_limit = True
                        req.quota_semaphore_held = True
                        req.quota_reservation = quota_reservation
                        try:
                            raw_messages = await self._transport.http_fetch(req)
                        except asyncio.CancelledError:
                            if (
                                quota_reservation is not None
                                and not quota_reservation.settled
                            ):
                                quota_reservation.record_response(
                                    response_unknown=True,
                                )
                            raise
                        except TransportError as exc:
                            if (
                                quota_reservation is not None
                                and not quota_reservation.settled
                            ):
                                quota_reservation.record_response(
                                    status_code=exc.status_code,
                                    headers=exc.headers,
                                    body_code=exc.body_code,
                                    retry_after=exc.retry_after,
                                    fallback_cooldown_seconds=(
                                        quota_reservation.rule.cooldown_seconds
                                    ),
                                )
                                exc.rate_limit_recorded = True
                            await self._record_rate_limit_cooldown(task, exc, req)
                            if self._is_rate_limited(exc):
                                raise await self._rate_limit_deferred(
                                    task,
                                    req,
                                    reservation=quota_reservation,
                                ) from exc
                            raise
                        except Exception:
                            if (
                                quota_reservation is not None
                                and not quota_reservation.settled
                            ):
                                quota_reservation.record_response(
                                    response_unknown=True,
                                )
                            raise
                        finally:
                            if req.quota_reservation is quota_reservation:
                                req.quota_reservation = None
                        if (
                            quota_reservation is not None
                            and not quota_reservation.settled
                        ):
                            if raw_messages:
                                message = raw_messages[0]
                                quota_reservation.record_response(
                                    status_code=getattr(message, "http_status", None),
                                    headers=getattr(message, "http_headers", None),
                                    body_code=getattr(message, "http_body_code", None),
                                )
                            else:
                                quota_reservation.record_response(status_code=200)
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

                except RateLimitDeferred:
                    raise

                except TransportError as exc:
                    retry_count += 1
                    error_msg = f"Page fetch error (attempt {retry_count}/{max_attempts}): {exc}"
                    logger.warning(error_msg)
                    if retry_count >= max_attempts:
                        errors.append(error_msg)
                        await self._fire_error(task, error_msg)

                except Exception as exc:
                    error_msg = f"Unexpected fetch error: {exc}"
                    errors.append(error_msg)
                    logger.error(error_msg, exc_info=True)
                    await self._fire_error(task, error_msg)
                    break

            if not success:
                break

            pages_fetched += 1

            if not page_bars and not raw_messages:
                # Preserve a successful empty-page signal separately from
                # failures.  The coordinator combines this with calendar,
                # pagination and local-bound evidence before learning a
                # durable history boundary.
                source_complete = True
                empty_reason = "source_empty"
                break  # No more data available
            if not page_bars:
                # A non-empty payload that normalizes to no closed bars may be
                # a forming candle, schema drift, or parse failure.  It is not
                # evidence that the provider's history is exhausted.
                errors.append("History page contained no usable closed bars")
                empty_reason = "unusable_page"
                break

            all_bars.extend(page_bars)
            await self._fire_progress(task, len(all_bars), estimated_total)

            current_request = pagination_policy.next_request(
                task,
                req,
                page_bars,
                batch_size=batch_size,
            )

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
            source_complete=source_complete and not errors,
            exhausted_before_ms=(
                min((bar.open_time for bar in all_bars), default=None)
                if source_complete and not errors
                else None
            ),
            empty_reason=empty_reason if source_complete and not errors else None,
            retryable=bool(errors),
            metadata={
                "history_sources": sorted(
                    {bar.source for bar in all_bars} or {"backfill"}
                ),
                "history_lane": task.metadata.get("history_lane", "rest"),
                "rest_pages": pages_fetched,
            },
        )
        self._last_history_diagnostics = {
            "selected_sources": result.metadata["history_sources"],
            "archive_object_count": 0,
            "archive_cache_hits": 0,
            "archive_download_bytes": 0,
            "archive_download_elapsed_ms": 0,
            "archive_verify_elapsed_ms": 0,
            "archive_parse_elapsed_ms": 0,
            "rest_pages": pages_fetched,
            "rest_tail_ranges": 1,
            "rest_fallback_ranges": 0,
        }

        logger.info(
            "Task %s: %d bars in %dms (%d pages, status=%s)",
            task.task_key,
            len(all_bars),
            elapsed,
            pages_fetched,
            status.value,
        )
        return result

    async def _fetch_routed_task(
        self,
        task: BackfillTask,
        refs,
        route_plan: ArchiveRoutePlan,
    ) -> FetchResult:
        started = time.monotonic()
        interval_spec = parse_interval_spec(task.interval)
        if interval_spec is None:
            return await self._fetch_rest_task(task)

        coverage_refs = [
            ref
            for ref in refs
            if _ranges_intersect(
                task.start_ms,
                task.end_ms,
                ref.start_ms,
                ref.end_ms,
            )
        ]
        archive_ranges = [
            (max(task.start_ms, ref.start_ms), min(task.end_ms, ref.end_ms))
            for ref in coverage_refs
        ]
        uncovered = _subtract_ranges(
            task.start_ms,
            task.end_ms,
            archive_ranges,
            interval_spec,
        )
        rest_tail_tasks = [
            asyncio.create_task(
                self._fetch_rest_task(
                    _slice_task(task, start_ms, end_ms, lane="rest_tail")
                )
            )
            for start_ms, end_ms in uncovered
        ]

        archive_values = await asyncio.gather(
            *(route_plan.future_for(ref) for ref in refs),
            return_exceptions=True,
        )
        archive_bars: list[FetchedBar] = []
        archive_receipts: list[dict[str, Any]] = []
        archive_errors: list[str] = []
        fallback_ranges: list[tuple[int, int]] = []
        sources: set[str] = set()

        for ref, value in zip(refs, archive_values):
            covers_task = _ranges_intersect(
                task.start_ms,
                task.end_ms,
                ref.start_ms,
                ref.end_ms,
            )
            if not covers_task:
                if isinstance(value, BaseException):
                    archive_errors.append(f"{ref.object_key}: {value}")
                    self._metrics.inc("archive_prefill_errors")
                    continue
                if route_plan.owns_object(task, ref):
                    archive_bars.extend(value.bars)
                    archive_receipts.append(value.receipt())
                sources.update(bar.source for bar in value.bars)
                continue
            intersection = (
                max(task.start_ms, ref.start_ms),
                min(task.end_ms, ref.end_ms),
            )
            if isinstance(value, BaseException):
                archive_errors.append(f"{ref.object_key}: {value}")
                fallback_ranges.append(intersection)
                self._metrics.inc("archive_rest_fallbacks")
                logger.warning(
                    "rest_fallback object=%s task=%s error=%s",
                    ref.object_key,
                    task.task_key,
                    value,
                )
                continue
            selected = [
                bar
                for bar in value.bars
                if intersection[0] <= bar.open_time <= intersection[1]
            ]
            owns_object = route_plan.owns_object(task, ref)
            if owns_object:
                # Import the complete closed archive object once.  The object
                # was selected from the scheduler's parent range, so these
                # extra rows are bounded, intentional historical prefill.
                archive_bars.extend(value.bars)
                archive_receipts.append(value.receipt())
            sources.update(bar.source for bar in selected)
            missing = _missing_ranges(
                intersection[0],
                intersection[1],
                {bar.open_time for bar in selected},
                interval_spec,
            )
            if missing:
                fallback_ranges.extend(missing)
                self._metrics.inc("archive_hole_rest_fallbacks", len(missing))

        fallback_ranges = _merge_ranges(fallback_ranges, interval_spec)
        fallback_tasks = [
            asyncio.create_task(
                self._fetch_rest_task(
                    _slice_task(task, start_ms, end_ms, lane="rest_fallback")
                )
            )
            for start_ms, end_ms in fallback_ranges
        ]
        rest_results = await asyncio.gather(
            *rest_tail_tasks,
            *fallback_tasks,
            return_exceptions=True,
        )

        deferred = [
            value for value in rest_results if isinstance(value, RateLimitDeferred)
        ]
        if deferred:
            # Archive routing is an implementation detail of the same
            # scheduler chunk. Never downgrade quota control flow to a
            # partial FetchResult merely because archive rows were available.
            raise max(
                deferred,
                key=lambda exc: int(exc.retry_at_ms or 0),
            )

        errors: list[str] = []
        pages_fetched = 0
        rest_bars: list[FetchedBar] = []
        retryable = False
        rest_fetch_results: list[FetchResult] = []
        for value in rest_results:
            if isinstance(value, BaseException):
                errors.append(str(value))
                retryable = True
                continue
            rest_fetch_results.append(value)
            pages_fetched += value.pages_fetched
            rest_bars.extend(value.bars)
            if value.status in {BackfillStatus.FAILED, BackfillStatus.PARTIAL}:
                errors.extend(value.errors)
                retryable = retryable or value.retryable
            sources.update(bar.source for bar in value.bars)

        # REST is allowed to amend an archive row at equal authority, so add it
        # last when an overlap is produced by a defensive fallback.
        by_open_time = {bar.open_time: bar for bar in archive_bars}
        for bar in rest_bars:
            by_open_time[bar.open_time] = bar
        bars = sorted(by_open_time.values(), key=lambda item: item.open_time)
        if errors and not bars:
            status = BackfillStatus.FAILED
        elif errors:
            status = BackfillStatus.PARTIAL
        else:
            status = BackfillStatus.COMPLETED

        elapsed_ms = self._elapsed_ms(started)
        await self._fire_progress(task, len(bars), max(1, task.estimated_bars))
        owned_archive_values = [
            value
            for ref, value in zip(refs, archive_values)
            if route_plan.owns_object(task, ref)
            and not isinstance(value, BaseException)
        ]
        metadata = {
            "history_sources": sorted(sources),
            "archive_objects": archive_receipts,
            "archive_errors": archive_errors,
            "archive_object_count": len(owned_archive_values),
            "archive_coverage_object_count": len(coverage_refs),
            "archive_cache_hits": sum(
                1 for value in owned_archive_values if value.cache_hit
            ),
            "archive_download_bytes": sum(
                value.size_bytes
                for value in owned_archive_values
                if not value.cache_hit
            ),
            "archive_download_elapsed_ms": sum(
                value.download_elapsed_ms for value in owned_archive_values
            ),
            "archive_verify_elapsed_ms": sum(
                value.verify_elapsed_ms for value in owned_archive_values
            ),
            "archive_parse_elapsed_ms": sum(
                value.parse_elapsed_ms for value in owned_archive_values
            ),
            "archive_import_rows": len(archive_bars),
            "rest_tail_ranges": len(uncovered),
            "rest_fallback_ranges": len(fallback_ranges),
            "rest_pages": pages_fetched,
        }
        self._metrics.inc("archive_objects_selected", len(owned_archive_values))
        self._metrics.inc("archive_cache_hits", metadata["archive_cache_hits"])
        self._metrics.inc(
            "archive_download_bytes",
            metadata["archive_download_bytes"],
        )
        self._metrics.inc("rest_tail_ranges", len(uncovered))
        self._metrics.inc("rest_fallback_ranges", len(fallback_ranges))
        self._metrics.set("last_history_sources", sorted(sources))
        self._metrics.set("last_archive_object_count", len(owned_archive_values))
        self._metrics.set(
            "last_archive_download_elapsed_ms",
            metadata["archive_download_elapsed_ms"],
        )
        self._metrics.set(
            "last_archive_parse_elapsed_ms",
            metadata["archive_parse_elapsed_ms"],
        )
        self._metrics.set(
            "last_archive_verify_elapsed_ms",
            metadata["archive_verify_elapsed_ms"],
        )
        self._last_history_diagnostics = {
            "selected_sources": metadata["history_sources"],
            "archive_object_count": metadata["archive_object_count"],
            "archive_coverage_object_count": metadata["archive_coverage_object_count"],
            "archive_cache_hits": metadata["archive_cache_hits"],
            "archive_download_bytes": metadata["archive_download_bytes"],
            "archive_download_elapsed_ms": metadata["archive_download_elapsed_ms"],
            "archive_verify_elapsed_ms": metadata["archive_verify_elapsed_ms"],
            "archive_parse_elapsed_ms": metadata["archive_parse_elapsed_ms"],
            "archive_import_rows": metadata["archive_import_rows"],
            "rest_pages": metadata["rest_pages"],
            "rest_tail_ranges": metadata["rest_tail_ranges"],
            "rest_fallback_ranges": metadata["rest_fallback_ranges"],
        }
        logger.info(
            "Task %s: %d bars in %dms archive_objects=%d rest_pages=%d status=%s",
            task.task_key,
            len(bars),
            elapsed_ms,
            len(refs),
            pages_fetched,
            status.value,
        )
        rest_requested_ranges = uncovered + fallback_ranges
        rest_covers_task = (
            bool(rest_requested_ranges)
            and not _subtract_ranges(
                task.start_ms,
                task.end_ms,
                rest_requested_ranges,
                interval_spec,
            )
            and len(rest_fetch_results) == len(rest_results)
        )
        source_complete = bool(
            rest_covers_task
            and any(value.source_complete for value in rest_fetch_results)
        )
        exhausted_values = [
            value.exhausted_before_ms
            for value in rest_fetch_results
            if value.source_complete and value.exhausted_before_ms is not None
        ]
        return FetchResult(
            task=task,
            bars=bars,
            status=status,
            elapsed_ms=elapsed_ms,
            pages_fetched=pages_fetched,
            errors=errors,
            # Archive absence/404 is never boundary evidence. Only when REST
            # physically covered the complete routed task may its empty-page
            # evidence be propagated to the coordinator.
            source_complete=source_complete,
            exhausted_before_ms=(min(exhausted_values) if exhausted_values else None),
            empty_reason="source_empty" if source_complete else None,
            retryable=retryable,
            metadata=metadata,
        )

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
            enhanced_fields = declared_enhanced_fields(
                task.exchange,
                task.market_type,
                data,
            )
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
                enhanced_fields=enhanced_fields,
                series_identity=identity_from_metadata(
                    task.exchange,
                    task.metadata,
                ),
            )
        except (KeyError, ValueError, TypeError) as exc:
            logger.warning("Failed to convert event to bar: %s", exc)
            return None

    # ── Internal: Rate limiting ──────────────────────────────

    async def _rate_limit(
        self,
        task: BackfillTask | None = None,
        request: TransportRequest | None = None,
        penalty_seconds: float = 0.0,
    ) -> RateLimitReservation | None:
        """Apply rate limiting between requests."""
        if self._custom_rate_limiter is not None:
            await self._custom_rate_limiter()
            if penalty_seconds > 0:
                await asyncio.sleep(penalty_seconds)
            return None

        if task is None:
            base_delay = self._cfg.fetch_rate_limit_delay
            if base_delay > 0 or penalty_seconds > 0:
                await asyncio.sleep(base_delay + penalty_seconds)
            return None

        historical_request = self._historical_request(task, request)
        rule = self._rate_limit_rule(task, historical_request)
        if penalty_seconds > 0:
            self._rate_limit_manager.record_cooldown(rule, penalty_seconds)
        await self._rate_limit_manager.acquire_nowait(rule, historical_request)
        return RateLimitReservation(
            manager=self._rate_limit_manager,
            rule=rule,
            request=historical_request,
        )

    async def _rate_limit_admission(
        self,
        task: BackfillTask,
        request: TransportRequest | None = None,
    ) -> None:
        """Preflight quota without reserving tokens or holding concurrency."""

        if self._custom_rate_limiter is not None:
            await self._custom_rate_limiter()
            return
        historical_request = self._historical_request(task, request)
        rule = self._rate_limit_rule(task, historical_request)
        admission = await self._rate_limit_manager.inspect(rule, historical_request)
        if not admission.allowed:
            raise RateLimitDeferred(admission)

    def _get_exchange_semaphore(
        self,
        task: BackfillTask,
        request: TransportRequest | None = None,
    ) -> asyncio.Semaphore:
        historical_request = self._historical_request(task, request)
        rule = self._rate_limit_rule(task, historical_request)
        limit = rule.max_concurrency or self._rate_limit_policy(task).concurrency_for(
            task.market_type
        )
        return get_shared_rate_limit_semaphore(rule, fallback=max(1, int(limit)))

    def _global_fetch_concurrency(self) -> int:
        configured = getattr(self._cfg, "fetch_global_concurrency", None)
        if configured is None:
            configured = self._cfg.fetch_concurrency
        return max(1, int(configured))

    def _base_delay_for_task(self, task: BackfillTask) -> float:
        return self._rate_limit_policy(task).delay_for(task.market_type)

    def _retry_backoff_seconds(
        self,
        task: BackfillTask,
        exc: TransportError,
        request: TransportRequest | None = None,
    ) -> float:
        if self._is_rate_limited(exc):
            retry_after = getattr(exc, "retry_after", None) or 0.0
            historical_request = self._historical_request(task, request)
            rule = self._rate_limit_rule(task, historical_request)
            return max(
                rule.cooldown_seconds,
                self._base_delay_for_task(task),
                retry_after,
            )
        return 0.0

    def _rate_limit_policy(self, task: BackfillTask):
        bootstrap_default_adapters()
        try:
            plugin = get_exchange_registry().get_plugin(task.exchange)
        except KeyError:
            return RateLimitPolicy(
                default_concurrency=self._cfg.fetch_concurrency,
                default_delay_seconds=self._cfg.fetch_rate_limit_delay,
                default_retry_429_backoff_seconds=self._cfg.fetch_429_backoff_seconds,
            )
        return plugin.rate_limit_policy(self._cfg)

    def _pagination_policy(self, task: BackfillTask):
        bootstrap_default_adapters()
        try:
            plugin = get_exchange_registry().get_plugin(task.exchange)
        except KeyError:
            from app.exchanges.pagination import ReverseTimePaginationPolicy

            return ReverseTimePaginationPolicy()
        return plugin.pagination_policy(self._cfg)

    def _historical_request(
        self,
        task: BackfillTask,
        request: TransportRequest | None = None,
    ) -> HistoricalRequest:
        endpoint = self._endpoint_for_task(task, request)
        return HistoricalRequest(
            exchange=str(task.exchange or "binance").strip().lower(),
            market_type=str(task.market_type or "spot").strip().lower(),
            endpoint=endpoint,
            symbol=str(task.symbol),
            interval=str(task.interval) if task.interval is not None else None,
            start_ms=request.start_ms if request is not None else task.start_ms,
            end_ms=request.end_ms if request is not None else task.end_ms,
            limit=request.limit if request is not None else self._cfg.fetch_batch_size,
        )

    def _endpoint_for_task(
        self,
        task: BackfillTask,
        request: TransportRequest | None = None,
    ) -> str:
        bootstrap_default_adapters()
        try:
            plugin = get_exchange_registry().get_plugin(task.exchange)
            protocol = plugin.protocol()
            descriptor = (
                request.descriptor
                if request is not None
                else StreamDescriptor(
                    symbol=task.symbol,
                    stream_type=StreamType.KLINE,
                    interval=task.interval,
                    exchange=task.exchange,
                    market_type=task.market_type,
                )
            )
            endpoint = None
            provider_endpoint = getattr(
                plugin,
                "provider_rate_limit_endpoint",
                None,
            )
            if callable(provider_endpoint):
                endpoint = provider_endpoint(
                    request
                    or TransportRequest(
                        descriptor=descriptor,
                        limit=self._cfg.fetch_batch_size,
                    )
                )
            if not endpoint:
                endpoint = protocol.rest_path(
                    descriptor.stream_type,
                    descriptor.market_type,
                )
        except Exception:
            endpoint = None
        return endpoint or "kline"

    def _rate_limit_rule(
        self,
        task: BackfillTask,
        request: HistoricalRequest,
    ) -> RateLimitRule:
        return self._rate_limit_policy(task).rule_for(request)

    async def _record_rate_limit_cooldown(
        self,
        task: BackfillTask,
        exc: TransportError,
        request: TransportRequest | None = None,
    ) -> None:
        if bool(getattr(exc, "rate_limit_recorded", False)):
            return
        backoff_seconds = self._retry_backoff_seconds(task, exc, request)
        if backoff_seconds <= 0:
            return

        historical_request = self._historical_request(task, request)
        rule = self._rate_limit_rule(task, historical_request)
        extended = self._rate_limit_manager.record_response(
            rule,
            status_code=getattr(exc, "status_code", None),
            headers=getattr(exc, "headers", None),
            body_code=getattr(exc, "body_code", None),
            retry_after=getattr(exc, "retry_after", None),
            fallback_cooldown_seconds=backoff_seconds,
        )
        if extended:
            logger.warning(
                "Rate-limit cooldown active for %s backfill requests: %.1fs",
                rule.bucket_key,
                backoff_seconds,
            )

    async def _rate_limit_deferred(
        self,
        task: BackfillTask,
        request: TransportRequest | None = None,
        *,
        reservation: RateLimitReservation | None = None,
    ) -> RateLimitDeferred:
        if reservation is not None:
            return await reservation.manager.deferred_error(
                reservation.rule,
                reservation.request,
            )
        historical_request = self._historical_request(task, request)
        rule = self._rate_limit_rule(task, historical_request)
        return await self._rate_limit_manager.deferred_error(
            rule,
            historical_request,
        )

    def _record_rate_limit_response(
        self,
        task: BackfillTask,
        request: TransportRequest,
        message,
    ) -> None:
        historical_request = self._historical_request(task, request)
        rule = self._rate_limit_rule(task, historical_request)
        self._rate_limit_manager.record_response(
            rule,
            status_code=getattr(message, "http_status", None),
            headers=getattr(message, "http_headers", None),
            body_code=getattr(message, "http_body_code", None),
        )

    @staticmethod
    def _is_rate_limited(exc: TransportError) -> bool:
        return (
            getattr(exc, "status_code", None) in {418, 429}
            or getattr(exc, "body_code", None) in {"-1003", "50011"}
            or "HTTP 418" in str(exc)
            or "HTTP 429" in str(exc)
        )

    # ── Internal: Callbacks ──────────────────────────────────

    async def _fire_progress(
        self,
        task: BackfillTask,
        fetched: int,
        total: int,
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


def _slice_task(
    task: BackfillTask,
    start_ms: int,
    end_ms: int,
    *,
    lane: str,
) -> BackfillTask:
    spec = parse_interval_spec(task.interval)
    estimated = 0
    if spec is not None and start_ms <= end_ms:
        cursor = spec.floor_ms(start_ms)
        if cursor < start_ms:
            cursor = spec.next_ms(cursor)
        while cursor <= end_ms:
            estimated += 1
            cursor = spec.next_ms(cursor)
    return replace(
        task,
        start_ms=int(start_ms),
        end_ms=int(end_ms),
        estimated_bars=estimated,
        metadata={**task.metadata, "history_lane": lane},
    )


def _subtract_ranges(
    start_ms: int,
    end_ms: int,
    covered_ranges: list[tuple[int, int]],
    spec,
) -> list[tuple[int, int]]:
    if start_ms > end_ms:
        return []
    normalized = _merge_ranges(covered_ranges, spec)
    cursor = spec.floor_ms(start_ms)
    if cursor < start_ms:
        cursor = spec.next_ms(cursor)
    missing: list[tuple[int, int]] = []
    run_start: int | None = None
    previous: int | None = None
    while cursor <= end_ms:
        covered = any(left <= cursor <= right for left, right in normalized)
        if not covered:
            if run_start is None:
                run_start = cursor
            previous = cursor
        elif run_start is not None and previous is not None:
            missing.append((run_start, previous))
            run_start = None
            previous = None
        cursor = spec.next_ms(cursor)
    if run_start is not None and previous is not None:
        missing.append((run_start, previous))
    return missing


def _missing_ranges(
    start_ms: int,
    end_ms: int,
    available_open_times: set[int],
    spec,
) -> list[tuple[int, int]]:
    cursor = spec.floor_ms(start_ms)
    if cursor < start_ms:
        cursor = spec.next_ms(cursor)
    missing: list[tuple[int, int]] = []
    run_start: int | None = None
    previous: int | None = None
    while cursor <= end_ms:
        if cursor not in available_open_times:
            if run_start is None:
                run_start = cursor
            previous = cursor
        elif run_start is not None and previous is not None:
            missing.append((run_start, previous))
            run_start = None
            previous = None
        cursor = spec.next_ms(cursor)
    if run_start is not None and previous is not None:
        missing.append((run_start, previous))
    return missing


def _merge_ranges(ranges: list[tuple[int, int]], spec) -> list[tuple[int, int]]:
    ordered = sorted(
        ((int(start), int(end)) for start, end in ranges if start <= end),
        key=lambda item: (item[0], item[1]),
    )
    if not ordered:
        return []
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        previous_start, previous_end = merged[-1]
        if start <= spec.next_ms(previous_end):
            merged[-1] = (previous_start, max(previous_end, end))
        else:
            merged.append((start, end))
    return merged


def _ranges_intersect(
    left_start: int,
    left_end: int,
    right_start: int,
    right_end: int,
) -> bool:
    return left_start <= right_end and right_start <= left_end
