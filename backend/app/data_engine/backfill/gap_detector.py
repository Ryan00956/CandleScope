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
from typing import Awaitable, Callable

from app.data_engine.history.calendar import (
    AlwaysOpenCalendar,
    CalendarRegistry,
    TradingCalendar,
)
from app.data_engine.interval_policy import (
    last_closed_bar_open_ms,
    parse_interval_ms,
)

from ..ingestion.metrics import LayerMetrics
from .config import BackfillConfig
from .models import (
    GapInfo,
    GapType,
    StorageBackend,
)

logger = logging.getLogger("backfill.GapDetector")


# Type aliases
ReferenceTimeProvider = Callable[[str, str, str, str], Awaitable[int | None]]
GapFilter = Callable[[GapInfo], bool]
GapCallback = Callable[[GapInfo], Awaitable[None]]
CalendarResolver = Callable[
    [str, str, str],
    TradingCalendar | str | None,
]


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
        *,
        calendar_resolver: CalendarResolver | None = None,
        calendar_registry: CalendarRegistry | None = None,
    ) -> None:
        self._cfg = config
        self._storage = storage
        self._metrics = LayerMetrics("GapDetector")
        self._calendar_registry = calendar_registry or CalendarRegistry()
        self._calendar_resolver = calendar_resolver
        self._default_calendar = (
            self._calendar_registry.get("crypto.24x7.utc")
            or AlwaysOpenCalendar()
        )

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

    def set_calendar_resolver(
        self,
        resolver: CalendarResolver | None,
        *,
        registry: CalendarRegistry | None = None,
    ) -> None:
        """Set the per-series trading-calendar resolver.

        The resolver receives ``(exchange, market_type, symbol)`` and may
        return either a calendar object, a registered calendar id, or ``None``
        to use the continuously traded default.  An unknown explicit id is
        handled fail-closed: the affected series is not reported as gapped.
        """
        if registry is not None:
            self._calendar_registry = registry
            self._default_calendar = (
                registry.get("crypto.24x7.utc") or AlwaysOpenCalendar()
            )
        self._calendar_resolver = resolver

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

        calendar = self._resolve_calendar(exchange, market_type, symbol)
        if calendar is None:
            self._metrics.inc("calendar_resolution_failures")
            return []

        # Determine reference (live edge)
        reference_ms = await self._get_reference_time(
            symbol,
            interval,
            range_end_ms,
            exchange=exchange,
            market_type=market_type,
        )
        # A reference can be a wall-clock timestamp or an open time from a
        # different interval.  Neither makes the target interval's current
        # forming bucket eligible for historical repair.  Preserve an older
        # ingestion reference while capping newer references at the latest
        # fully closed target bucket.
        last_closed_ms = last_closed_bar_open_ms(
            int(time.time() * 1000),
            interval,
        )
        if last_closed_ms is None:
            return []
        reference_ms = min(reference_ms, last_closed_ms)

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
            first_expected = calendar.first_expected_open(
                range_start_ms, reference_ms, interval
            )
            last_expected = calendar.last_expected_open(
                range_start_ms, reference_ms, interval
            )
            if first_expected is None or last_expected is None:
                return []
            missing = calendar.count_expected(first_expected, last_expected, interval)
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
        first_expected = calendar.first_expected_open(
            range_start_ms,
            min(reference_ms, db_earliest - 1),
            interval,
        )
        head_end = calendar.previous_expected_open(db_earliest, interval)
        if (
            first_expected is not None
            and head_end is not None
            and first_expected <= head_end
        ):
            missing = calendar.count_expected(first_expected, head_end, interval)
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
        # Calendar stepping skips market closures and also handles monthly bars.
        next_expected = calendar.next_expected_open(db_latest, interval)
        last_expected = calendar.last_expected_open(
            db_latest + 1,
            reference_ms,
            interval,
        )
        if (
            next_expected is not None
            and last_expected is not None
            and next_expected <= last_expected
        ):
            missing = calendar.count_expected(next_expected, last_expected, interval)
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

        # ── Case 4: Interior holes ──
        if self._cfg.gap_scan_interior:
            interior_gaps = await self._detect_interior_gaps(
                symbol,
                interval,
                max(range_start_ms, db_earliest),
                min(range_end_ms, db_latest),
                reference_ms,
                exchange=exchange,
                market_type=market_type,
                calendar=calendar,
            )
            gaps.extend(interior_gaps)

        return await self._apply_filter_and_notify(gaps)

    # ── Internal: Interior hole detection ────────────────────

    async def _detect_interior_gaps(
        self,
        symbol: str,
        interval: str,
        scan_start: int,
        scan_end: int,
        reference_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
        calendar: TradingCalendar | None = None,
    ) -> list[GapInfo]:
        """Scan for holes inside the stored data range.

        Queries all existing open_times and checks for non-contiguous
        sequences.
        """
        if scan_start > scan_end:
            return []
        calendar = calendar or self._default_calendar

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

        first_expected = calendar.first_expected_open(scan_start, scan_end, interval)
        last_expected = calendar.last_expected_open(scan_start, scan_end, interval)
        if first_expected is None or last_expected is None:
            return []

        if not existing_times:
            missing = calendar.count_expected(first_expected, last_expected, interval)
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
            missing = calendar.count_expected(first_expected, last_expected, interval)
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
            gap_end = calendar.previous_expected_open(sorted_times[0], interval)
            missing = (
                calendar.count_expected(first_expected, gap_end, interval)
                if gap_end is not None and first_expected <= gap_end
                else 0
            )
            if gap_end is not None and missing > self._cfg.gap_tolerance_bars:
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

            expected_next = calendar.next_expected_open(current, interval)

            if expected_next is not None and next_time > expected_next:
                gap_end = calendar.previous_expected_open(next_time, interval)
                missing = (
                    calendar.count_expected(expected_next, gap_end, interval)
                    if gap_end is not None and expected_next <= gap_end
                    else 0
                )
                if gap_end is not None and missing > self._cfg.gap_tolerance_bars:
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

        trailing_start = calendar.next_expected_open(sorted_times[-1], interval)
        if (
            hole_count < self._cfg.gap_max_interior_holes
            and trailing_start is not None
            and trailing_start <= last_expected
        ):
            start_ms = trailing_start
            missing = calendar.count_expected(start_ms, last_expected, interval)
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

    def _resolve_calendar(
        self,
        exchange: str,
        market_type: str,
        symbol: str,
    ) -> TradingCalendar | None:
        if self._calendar_resolver is None:
            return self._default_calendar
        try:
            resolved = self._calendar_resolver(exchange, market_type, symbol)
        except Exception as exc:
            logger.warning(
                "Trading calendar resolver failed for %s:%s:%s: %s",
                exchange,
                market_type,
                symbol,
                exc,
            )
            return None
        if resolved is None:
            return self._default_calendar
        if isinstance(resolved, str):
            calendar = self._calendar_registry.get(resolved)
            if calendar is None:
                logger.warning(
                    "Unknown trading calendar %r for %s:%s:%s; gap scan skipped",
                    resolved,
                    exchange,
                    market_type,
                    symbol,
                )
            return calendar
        if isinstance(resolved, TradingCalendar):
            return resolved
        logger.warning(
            "Invalid trading calendar resolver result for %s:%s:%s: %r",
            exchange,
            market_type,
            symbol,
            resolved,
        )
        return None

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
