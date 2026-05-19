"""
Gap Detector — identifies missing data ranges by comparing live state with storage.

Responsibilities:
  * Accept a backfill command specifying symbol, intervals, and time range
  * Optionally subscribe to ingestion L6 Delivery to learn the "live edge"
  * Query the ``StorageBackend`` for each interval's earliest / latest data
  * Detect three kinds of gaps:
      - **Tail gap**: DB is behind the live edge
      - **Head gap**: DB starts later than the requested range
      - **Interior holes**: missing bars inside the stored range
  * Emit ``GapInfo`` objects for downstream planning

Extension points:
  * ``set_reference_time_provider(fn)``  — override how "now" is determined
  * ``set_gap_filter(fn)``              — custom filter to ignore certain gaps
  * ``on_gap_detected(callback)``       — per-gap callback

Usage::

    detector = GapDetector(config, storage)
    # Optionally attach live reference from ingestion
    detector.set_reference_time_provider(my_live_time_fn)

    gaps = await detector.detect(
        symbol="BTCUSDT",
        intervals=["1m", "5m", "1h"],
        range_start_ms=...,
        range_end_ms=...,
    )
"""
from __future__ import annotations

import logging
import time
from typing import Callable, Awaitable, Any

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    next_month_bucket,
    parse_interval_ms,
    parse_monthly_count,
)

from ..ingestion.metrics import LayerMetrics
from .config import BackfillConfig
from .models import (
    GapInfo,
    GapType,
    StorageBackend,
)

logger = logging.getLogger("backfill.GapDetector")


def _is_monthly(interval: str) -> bool:
    """Return True if interval uses calendar-month units (e.g. '1M')."""
    return is_monthly_interval(interval)


def _next_month_open_ms(ts_ms: int, months: int = 1) -> int:
    """Compute the open_time of the next monthly candle after *ts_ms*."""
    return next_month_bucket(ts_ms // 1000, months) * 1000


def _first_expected_open_ms(start_ms: int, interval: str, interval_ms: int) -> int:
    bucket = compute_bucket_start_ms(start_ms, interval_ms, interval=interval)
    if bucket < start_ms:
        bucket = compute_bucket_end_ms(bucket, interval_ms, interval=interval)
    return bucket


def _last_expected_open_ms(end_ms: int, interval: str, interval_ms: int) -> int:
    return compute_bucket_start_ms(end_ms, interval_ms, interval=interval)


def _next_expected_open_ms(open_ms: int, interval: str, interval_ms: int) -> int:
    return compute_bucket_end_ms(open_ms, interval_ms, interval=interval)


def _previous_expected_open_ms(open_ms: int, interval: str, interval_ms: int) -> int:
    return compute_bucket_start_ms(open_ms - 1, interval_ms, interval=interval)


def _count_expected_opens(
    start_ms: int,
    end_ms: int,
    interval: str,
    interval_ms: int,
) -> int:
    if start_ms > end_ms:
        return 0
    if _is_monthly(interval):
        month_count = parse_monthly_count(interval) or 1
        count = 0
        current = start_ms
        while current <= end_ms:
            count += 1
            current = _next_month_open_ms(current, month_count)
        return count
    return (end_ms - start_ms) // interval_ms + 1

# Type aliases
ReferenceTimeProvider = Callable[[str, str, str, str], Awaitable[int | None]]
GapFilter = Callable[[GapInfo], bool]
GapCallback = Callable[[GapInfo], Awaitable[None]]


class GapDetector:
    """Scans storage for missing data and emits GapInfo objects.

    The detector compares what *should* exist (based on the live edge or
    a user-specified reference time) with what *does* exist in the
    ``StorageBackend``, and reports any discrepancies.
    """

    def __init__(
        self,
        config: BackfillConfig,
        storage: StorageBackend,
    ) -> None:
        self._cfg = config
        self._storage = storage
        self._metrics = LayerMetrics("GapDetector")

        # Extension points
        self._reference_time_provider: ReferenceTimeProvider | None = None
        self._gap_filter: GapFilter | None = None
        self._gap_callbacks: list[GapCallback] = []

        # Cached ingestion reference times (symbol@interval → ms)
        self._ingestion_reference: dict[str, int] = {}

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "component": "GapDetector",
            "ingestion_references": dict(self._ingestion_reference),
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Extension points ─────────────────────────────

    def set_reference_time_provider(
        self, provider: ReferenceTimeProvider,
    ) -> None:
        """Override the default reference-time source.

        The provider is an async function ``(symbol, interval) → int | None``
        that returns the latest known open_time in milliseconds.

        If not set, the detector uses ``int(time.time() * 1000)`` as the
        live edge, which is correct for most real-time scenarios.

        Example — using ingestion L6 Delivery as reference::

            async def live_ref(symbol, interval):
                event = delivery.latest_event  # hypothetical
                return event.data.get("open_time") if event else None
            detector.set_reference_time_provider(live_ref)
        """
        self._reference_time_provider = provider

    def set_gap_filter(self, filter_fn: GapFilter) -> None:
        """Set a custom filter to ignore certain gaps.

        The filter receives a ``GapInfo`` and should return ``True`` to
        **keep** it, ``False`` to discard.

        Example — ignore gaps smaller than 5 bars::

            detector.set_gap_filter(lambda g: g.missing_bars >= 5)
        """
        self._gap_filter = filter_fn

    def on_gap_detected(self, callback: GapCallback) -> None:
        """Register a callback invoked for each detected gap.

        Multiple callbacks can be registered.
        """
        self._gap_callbacks.append(callback)

    def remove_gap_callback(self, callback: GapCallback) -> None:
        """Remove a previously registered gap callback."""
        self._gap_callbacks = [cb for cb in self._gap_callbacks if cb is not callback]

    # ── Public: Update ingestion reference ───────────────────

    def update_ingestion_reference(
        self,
        symbol: str,
        interval: str,
        open_time_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Update the cached live-edge time from ingestion.

        This is typically called from a ``DeliveryLayer.on_market_event()``
        callback to keep the detector aware of the latest data the
        ingestion pipeline has seen.

        Args:
            symbol:       Trading pair, e.g. "BTCUSDT".
            interval:     K-line interval, e.g. "1m".
            open_time_ms: The open_time of the latest closed bar (ms).
        """
        key = f"{exchange.strip().lower()}:{market_type.strip().lower()}:{symbol}@{interval}"
        current = self._ingestion_reference.get(key)
        if current is None or open_time_ms > current:
            self._ingestion_reference[key] = open_time_ms
            self._metrics.inc("ingestion_references_updated")

    # ── Public: Detect gaps ──────────────────────────────────

    async def detect(
        self,
        symbol: str,
        intervals: list[str] | None = None,
        range_start_ms: int | None = None,
        range_end_ms: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> list[GapInfo]:
        """Scan for gaps across the specified intervals.

        Args:
            symbol:         Trading pair to scan.
            intervals:      Intervals to check (default: config.gap_scan_intervals).
            range_start_ms: Start of the desired data range (ms).
                            Default: ``range_end_ms - gap_max_scan_range_ms``.
            range_end_ms:   End of the desired data range (ms).
                            Default: current time.

        Returns:
            A list of ``GapInfo`` objects describing all detected gaps.
        """
        intervals = intervals or list(self._cfg.gap_scan_intervals)
        if range_end_ms is None:
            range_end_ms = int(time.time() * 1000)
        if range_start_ms is None:
            range_start_ms = range_end_ms - self._cfg.gap_max_scan_range_ms

        self._metrics.inc("detect_runs")
        self._metrics.mark("last_detect_at")
        logger.info(
            "Gap detection started: symbol=%s intervals=%s range=[%d, %d]",
            symbol, intervals, range_start_ms, range_end_ms,
        )

        all_gaps: list[GapInfo] = []

        for interval in intervals:
            try:
                gaps = await self._detect_interval(
                    symbol,
                    interval,
                    range_start_ms,
                    range_end_ms,
                    exchange=exchange,
                    market_type=market_type,
                )
                all_gaps.extend(gaps)
            except Exception as exc:
                self._metrics.inc("detect_errors")
                logger.error(
                    "Gap detection failed for %s@%s: %s",
                    symbol, interval, exc, exc_info=True,
                )

        self._metrics.inc("gaps_detected", len(all_gaps))
        logger.info(
            "Gap detection completed: %d gaps found across %d intervals",
            len(all_gaps), len(intervals),
        )
        return all_gaps

    # ── Internal: Per-interval detection ─────────────────────

    async def _detect_interval(
        self,
        symbol: str,
        interval: str,
        range_start_ms: int,
        range_end_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> list[GapInfo]:
        """Detect gaps for a single symbol + interval."""
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None:
            logger.warning("Cannot parse interval '%s', skipping", interval)
            return []

        # Determine reference (live edge)
        reference_ms = await self._get_reference_time(
            symbol,
            interval,
            range_end_ms,
            exchange=exchange,
            market_type=market_type,
        )

        # Query storage boundaries
        db_earliest = await self._storage.get_earliest_time(
            symbol, interval, exchange=exchange, market_type=market_type,
        )
        db_latest = await self._storage.get_latest_time(
            symbol, interval, exchange=exchange, market_type=market_type,
        )

        gaps: list[GapInfo] = []

        # ── Case 1: Empty storage — one big gap ──
        if db_earliest is None or db_latest is None:
            first_expected = _first_expected_open_ms(range_start_ms, interval, interval_ms)
            last_expected = _last_expected_open_ms(reference_ms, interval, interval_ms)
            missing = _count_expected_opens(
                first_expected,
                last_expected,
                interval,
                interval_ms,
            )
            if missing > self._cfg.gap_tolerance_bars:
                gap = GapInfo(
                    symbol=symbol,
                    interval=interval,
                    gap_type=GapType.TAIL,
                    start_ms=first_expected,
                    end_ms=last_expected,
                    missing_bars=missing,
                    exchange=exchange,
                    db_latest_ms=None,
                    reference_ms=reference_ms,
                    market_type=market_type,
                )
                gaps.append(gap)
            return await self._apply_filter_and_notify(gaps)

        # ── Case 2: Head gap — DB starts later than requested range ──
        first_expected = _first_expected_open_ms(range_start_ms, interval, interval_ms)
        head_end = _previous_expected_open_ms(db_earliest, interval, interval_ms)
        if first_expected <= head_end:
            missing = _count_expected_opens(
                first_expected,
                head_end,
                interval,
                interval_ms,
            )
            if missing > self._cfg.gap_tolerance_bars:
                gap = GapInfo(
                    symbol=symbol,
                    interval=interval,
                    gap_type=GapType.HEAD,
                    start_ms=first_expected,
                    end_ms=head_end,
                    missing_bars=missing,
                    exchange=exchange,
                    db_latest_ms=db_latest,
                    reference_ms=reference_ms,
                    market_type=market_type,
                )
                gaps.append(gap)

        # ── Case 3: Tail gap — DB is behind the live edge ──
        if _is_monthly(interval):
            month_count = parse_monthly_count(interval) or 1
            next_expected = _next_month_open_ms(db_latest, month_count)
            last_expected = _last_expected_open_ms(reference_ms, interval, interval_ms)
            if next_expected <= last_expected:
                missing = _count_expected_opens(
                    next_expected,
                    last_expected,
                    interval,
                    interval_ms,
                )
                if missing > self._cfg.gap_tolerance_bars:
                    gap = GapInfo(
                        symbol=symbol,
                        interval=interval,
                        gap_type=GapType.TAIL,
                        start_ms=next_expected,
                        end_ms=last_expected,
                        missing_bars=missing,
                        exchange=exchange,
                        db_latest_ms=db_latest,
                        reference_ms=reference_ms,
                        market_type=market_type,
                    )
                    gaps.append(gap)
        elif db_latest < reference_ms - interval_ms * self._cfg.gap_tolerance_bars:
            next_expected = db_latest + interval_ms
            missing = (reference_ms - next_expected) // interval_ms + 1
            if missing > self._cfg.gap_tolerance_bars:
                gap = GapInfo(
                    symbol=symbol,
                    interval=interval,
                    gap_type=GapType.TAIL,
                    start_ms=next_expected,
                    end_ms=reference_ms,
                    missing_bars=missing,
                    exchange=exchange,
                    db_latest_ms=db_latest,
                    reference_ms=reference_ms,
                    market_type=market_type,
                )
                gaps.append(gap)

        # ── Case 4: Interior holes ──
        if self._cfg.gap_scan_interior:
            interior_gaps = await self._detect_interior_gaps(
                symbol,
                interval,
                interval_ms,
                max(range_start_ms, db_earliest),
                min(range_end_ms, db_latest),
                reference_ms,
                exchange=exchange,
                market_type=market_type,
            )
            gaps.extend(interior_gaps)

        return await self._apply_filter_and_notify(gaps)

    # ── Internal: Interior hole detection ────────────────────

    async def _detect_interior_gaps(
        self,
        symbol: str,
        interval: str,
        interval_ms: int,
        scan_start: int,
        scan_end: int,
        reference_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> list[GapInfo]:
        """Scan for holes inside the stored data range.

        Queries all existing open_times and checks for non-contiguous
        sequences.
        """
        if scan_start >= scan_end:
            return []

        try:
            existing_times = await self._storage.get_existing_open_times(
                symbol,
                interval,
                scan_start,
                scan_end,
                exchange=exchange,
                market_type=market_type,
            )
        except Exception as exc:
            logger.warning(
                "get_existing_open_times not available, falling back to "
                "query_time_range: %s", exc,
            )
            # Fallback: fetch full rows and extract open_times
            rows = await self._storage.query_time_range(
                symbol,
                interval,
                scan_start,
                scan_end,
                exchange=exchange,
                market_type=market_type,
            )
            existing_times = {int(r["open_time"]) for r in rows}

        first_expected = _first_expected_open_ms(scan_start, interval, interval_ms)
        last_expected = _last_expected_open_ms(scan_end, interval, interval_ms)
        if first_expected > last_expected:
            return []

        if not existing_times:
            missing = _count_expected_opens(
                first_expected,
                last_expected,
                interval,
                interval_ms,
            )
            if missing <= self._cfg.gap_tolerance_bars:
                return []
            gap = GapInfo(
                symbol=symbol,
                interval=interval,
                gap_type=GapType.INTERIOR,
                start_ms=first_expected,
                end_ms=last_expected,
                missing_bars=missing,
                exchange=exchange,
                db_latest_ms=None,
                reference_ms=reference_ms,
                market_type=market_type,
            )
            self._metrics.inc("interior_holes_found", 1)
            return [gap]

        sorted_times = sorted(
            ts for ts in existing_times
            if first_expected <= ts <= last_expected
        )
        if not sorted_times:
            missing = _count_expected_opens(
                first_expected,
                last_expected,
                interval,
                interval_ms,
            )
            if missing <= self._cfg.gap_tolerance_bars:
                return []
            gap = GapInfo(
                symbol=symbol,
                interval=interval,
                gap_type=GapType.INTERIOR,
                start_ms=first_expected,
                end_ms=last_expected,
                missing_bars=missing,
                exchange=exchange,
                db_latest_ms=None,
                reference_ms=reference_ms,
                market_type=market_type,
            )
            self._metrics.inc("interior_holes_found", 1)
            return [gap]

        gaps: list[GapInfo] = []
        hole_count = 0

        if sorted_times[0] > first_expected:
            gap_end = _previous_expected_open_ms(sorted_times[0], interval, interval_ms)
            missing = _count_expected_opens(
                first_expected,
                gap_end,
                interval,
                interval_ms,
            )
            if missing > self._cfg.gap_tolerance_bars:
                gaps.append(GapInfo(
                    symbol=symbol,
                    interval=interval,
                    gap_type=GapType.INTERIOR,
                    start_ms=first_expected,
                    end_ms=gap_end,
                    missing_bars=missing,
                    exchange=exchange,
                    db_latest_ms=sorted_times[-1],
                    reference_ms=reference_ms,
                    market_type=market_type,
                ))
                hole_count += 1

        for i in range(len(sorted_times) - 1):
            if hole_count >= self._cfg.gap_max_interior_holes:
                logger.warning(
                    "Hit interior hole limit (%d) for %s@%s",
                    self._cfg.gap_max_interior_holes, symbol, interval,
                )
                break

            current = sorted_times[i]
            next_time = sorted_times[i + 1]

            expected_next = _next_expected_open_ms(current, interval, interval_ms)

            if next_time > expected_next:
                gap_end = _previous_expected_open_ms(next_time, interval, interval_ms)
                missing = _count_expected_opens(
                    expected_next,
                    gap_end,
                    interval,
                    interval_ms,
                )
                if missing > self._cfg.gap_tolerance_bars:
                    gap = GapInfo(
                        symbol=symbol,
                        interval=interval,
                        gap_type=GapType.INTERIOR,
                        start_ms=expected_next,
                        end_ms=gap_end,
                        missing_bars=missing,
                        exchange=exchange,
                        db_latest_ms=sorted_times[-1],
                        reference_ms=reference_ms,
                        market_type=market_type,
                    )
                    gaps.append(gap)
                    hole_count += 1

        if (
            hole_count < self._cfg.gap_max_interior_holes
            and _next_expected_open_ms(sorted_times[-1], interval, interval_ms) <= last_expected
        ):
            start_ms = _next_expected_open_ms(sorted_times[-1], interval, interval_ms)
            missing = _count_expected_opens(
                start_ms,
                last_expected,
                interval,
                interval_ms,
            )
            if missing > self._cfg.gap_tolerance_bars:
                gaps.append(GapInfo(
                    symbol=symbol,
                    interval=interval,
                    gap_type=GapType.INTERIOR,
                    start_ms=start_ms,
                    end_ms=last_expected,
                    missing_bars=missing,
                    exchange=exchange,
                    db_latest_ms=sorted_times[-1],
                    reference_ms=reference_ms,
                    market_type=market_type,
                ))

        self._metrics.inc("interior_holes_found", len(gaps))
        return gaps

    # ── Internal: Reference time resolution ──────────────────

    async def _get_reference_time(
        self,
        symbol: str,
        interval: str,
        fallback_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> int:
        """Resolve the "live edge" time for gap comparison.

        Priority:
          1. User-supplied reference_time_provider
          2. Cached ingestion reference (from update_ingestion_reference)
          3. Fallback (usually current time)
        """
        # 1. Custom provider
        if self._reference_time_provider is not None:
            try:
                ref = await self._reference_time_provider(symbol, interval, exchange, market_type)
                if ref is not None:
                    return ref
            except Exception as exc:
                logger.warning("Reference time provider failed: %s", exc)

        # 2. Ingestion reference cache
        key = f"{exchange.strip().lower()}:{market_type.strip().lower()}:{symbol}@{interval}"
        cached_ref = self._ingestion_reference.get(key)
        if cached_ref is not None:
            return cached_ref

        # 3. Fallback
        return fallback_ms

    # ── Internal: Filter and notify ──────────────────────────

    async def _apply_filter_and_notify(
        self, gaps: list[GapInfo],
    ) -> list[GapInfo]:
        """Apply the user-defined gap filter and fire callbacks."""
        if self._gap_filter is not None:
            gaps = [g for g in gaps if self._gap_filter(g)]

        for gap in gaps:
            for cb in self._gap_callbacks:
                try:
                    await cb(gap)
                except Exception as exc:
                    self._metrics.inc("callback_errors")
                    logger.error("Gap callback error: %s", exc, exc_info=True)

        return gaps
