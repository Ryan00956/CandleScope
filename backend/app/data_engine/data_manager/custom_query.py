"""Custom interval query service for QueryEngine."""
from __future__ import annotations

import time
import logging
import threading
from bisect import bisect_right
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import replace
from typing import Any

from app.data_engine.interval_policy import (
    IntervalAlignment,
    aggregate_tail_is_closed,
    aggregate_rows_by_month,
    compute_bucket_end_ms,
    compute_bucket_start,
    compute_bucket_start_ms,
    compute_month_bucket_ms,
    enhanced_components_are_complete,
    find_best_base_interval,
    next_month_bucket,
    parse_custom_interval,
    parse_interval_ms,
    parse_interval_spec,
    parse_monthly_count,
    row_is_closed,
)
from app.data_engine.market_data.kline_metrics import (
    serialize_kline_enhancements,
)
from app.data_engine.interval_resolution import IntervalRoute
from app.data_engine.history.calendar import (
    AlwaysOpenCalendar,
    containing_expected_open_ms,
    expected_bucket_end_ms,
)

from .cache import BarCache, HistoryCapacityReservation
from .config import QueryConfig
from .models import BarData, MissingRange, QueryResult, QuerySource, SeriesKey

BaseQuery = Callable[..., QueryResult]
BaseQueryBefore = Callable[..., QueryResult]
CalendarProvider = Callable[[SeriesKey], Any | None]
logger = logging.getLogger("data_manager.custom_query")


_MAX_CUSTOM_BASE_PAGES = 32
_IO_COUNT_FIELDS = (
    "storage_reads",
    "storage_rows",
    "storage_failures",
    "projected_storage_reads",
    "projected_storage_rows",
    "row_decode_rows",
    "compact_row_decode_rows",
    "fast_row_decode_rows",
    "compact_decode_fallback_rows",
    "legacy_row_decode_rows",
)
_IO_TIME_FIELDS = (
    "storage_read_ms",
    "row_decode_ms",
)


def _bar_data_to_storage_rows(
    bars: list[BarData],
    source_interval: str,
) -> list[dict]:
    """Compatibility conversion used by interval-contract tests/tools."""
    source_ms = parse_interval_ms(source_interval) or 60_000
    return [{
        "open_time": bar.time_ms,
        "close_time": bar.time_ms + source_ms - 1,
        "open": bar.open,
        "high": bar.high,
        "low": bar.low,
        "close": bar.close,
        "volume": bar.volume,
        "quote_volume": bar.quote_volume,
        "trades": bar.trades,
        "taker_buy_base": bar.taker_buy_base,
        "taker_buy_quote": bar.taker_buy_quote,
        "enhanced_fields": sorted(bar.enhanced_fields),
        "is_closed": bool(bar.is_closed),
    } for bar in bars]


def _aggregate_rows_to_interval(
    base_rows: list[dict],
    custom_interval_seconds: int,
    *,
    interval: str | None = None,
    source_interval: str | None = None,
    source_interval_seconds: int | None = None,
    calendar: Any | None = None,
) -> list[dict]:
    """Aggregate lightweight-chart rows into a custom interval."""
    if not base_rows:
        return []

    expected_bucket_starts: list[int] = []
    if calendar is not None and interval is not None:
        first_ms = min(int(row["time"]) for row in base_rows) * 1000
        last_ms = max(int(row["time"]) for row in base_rows) * 1000
        first_bucket_ms = containing_expected_open_ms(
            calendar,
            first_ms,
            interval,
        )
        expected_bucket_starts = list(calendar.expected_opens(
            first_bucket_ms if first_bucket_ms is not None else first_ms,
            last_ms,
            interval,
        ))

    buckets: dict[int, list[dict]] = {}
    for row in base_rows:
        ts = row["time"]
        if expected_bucket_starts:
            position = bisect_right(expected_bucket_starts, int(ts) * 1000) - 1
            if position < 0:
                continue
            bucket_start = expected_bucket_starts[position] // 1000
            if int(ts) * 1000 >= expected_bucket_end_ms(
                calendar,
                expected_bucket_starts[position],
                interval,
            ):
                continue
        else:
            bucket_start = compute_bucket_start(
                ts,
                custom_interval_seconds,
                interval=interval,
            )
        buckets.setdefault(bucket_start, []).append(row)

    result: list[dict] = []
    for bucket_start in sorted(buckets):
        rows = sorted(buckets[bucket_start], key=lambda row: row["time"])
        bucket_end = (
            expected_bucket_end_ms(calendar, bucket_start * 1000, interval) // 1000
            if calendar is not None and interval is not None
            else bucket_start + custom_interval_seconds
        )
        expected_source_opens: list[int] | None = None
        if calendar is not None and source_interval is not None:
            expected_source_opens = [
                int(open_ms) // 1000
                for open_ms in calendar.expected_opens(
                    bucket_start * 1000,
                    bucket_end * 1000 - 1,
                    source_interval,
                )
            ]
            actual_source_opens = [int(row["time"]) for row in rows]
            is_expected_prefix = bool(
                expected_source_opens
                and actual_source_opens
                == expected_source_opens[:len(actual_source_opens)]
            )
            reaches_expected_tail = bool(
                is_expected_prefix
                and len(actual_source_opens) == len(expected_source_opens)
            )
            enhanced_complete = bool(
                is_expected_prefix
                and (reaches_expected_tail or not row_is_closed(rows[-1]))
            )
        else:
            reaches_expected_tail = False
            enhanced_complete = enhanced_components_are_complete(
                rows,
                bucket_start_seconds=bucket_start,
                bucket_end_seconds=bucket_end,
                source_interval_seconds=source_interval_seconds,
            )
        enhanced_rows = [
            serialize_kline_enhancements(
                volume=row.get("volume"),
                quote_volume=row.get("quote_volume"),
                trades=row.get("trades"),
                taker_buy_base=row.get("taker_buy_base"),
                taker_buy_quote=row.get("taker_buy_quote"),
            )
            for row in rows
        ]
        result.append({
            "time": bucket_start,
            "open": rows[0]["open"],
            "high": max(row["high"] for row in rows),
            "low": min(row["low"] for row in rows),
            "close": rows[-1]["close"],
            "volume": round(sum(row["volume"] for row in rows), 8),
            "quote_volume": _sum_optional_field(enhanced_rows, "quote_volume")
            if enhanced_complete else None,
            "trades": _sum_optional_field(enhanced_rows, "trades", integer=True)
            if enhanced_complete else None,
            "taker_buy_base": _sum_optional_field(enhanced_rows, "taker_buy_base")
            if enhanced_complete else None,
            "taker_buy_quote": _sum_optional_field(enhanced_rows, "taker_buy_quote")
            if enhanced_complete else None,
            "is_closed": bool(
                enhanced_complete
                and (
                    row_is_closed(rows[-1]) and reaches_expected_tail
                    if expected_source_opens is not None
                    else aggregate_tail_is_closed(
                        rows,
                        bucket_end_seconds=bucket_end,
                        source_interval_seconds=source_interval_seconds,
                    )
                )
            ),
        })
    return result


def _sum_optional_field(
    rows: list[dict],
    field: str,
    *,
    integer: bool = False,
) -> float | int | None:
    """Sum an additive field only when every component provides it."""
    values = [row.get(field) for row in rows]
    if any(value is None for value in values):
        return None
    if integer:
        return sum(int(value) for value in values)
    return round(sum(float(value) for value in values), 8)


def _aggregate_fixed_bars_to_interval(
    base_bars: list[BarData],
    custom_interval_seconds: int,
    *,
    source_interval_seconds: int | None,
) -> list[BarData]:
    """Aggregate epoch-aligned ``BarData`` in one ordered pass.

    ``_aggregate_rows_to_interval`` remains the canonical compatibility path
    for calendar/session-aware callers.  Query results, however, are already
    ``BarData`` and overwhelmingly use fixed-width epoch buckets.  Converting
    those bars to dictionaries, grouping them into lists, sorting every list,
    and then scanning each list once per output field was the dominant CPU
    cost for cold custom-interval reads.

    The fast path preserves the existing two-pass enhanced-field validation
    and eight-decimal normalization boundary through a raw-field-only helper;
    it does not calculate discarded order-flow ratios or allocate per-row
    dictionaries.
    """
    if not base_bars:
        return []

    bars = base_bars
    if any(
        current.time < previous.time
        for previous, current in zip(base_bars, base_bars[1:])
    ):
        # QueryEngine normally returns ordered bars, but callers and tests are
        # not required to do so.  Keep the old order-independent contract and
        # pay for sorting only when an inversion is actually present.
        bars = sorted(base_bars, key=lambda bar: bar.time)

    source_seconds = (
        int(source_interval_seconds)
        if source_interval_seconds is not None and source_interval_seconds > 0
        else None
    )
    result: list[BarData] = []

    bucket_start: int | None = None
    first_time = 0
    last_time = 0
    last_is_closed = False
    contiguous = True
    open_value = 0.0
    high_value = 0.0
    low_value = 0.0
    close_value = 0.0
    volume_values: list[float] = []
    quote_values: list[float] = []
    trades_values: list[int] = []
    taker_base_values: list[float] = []
    taker_quote_values: list[float] = []
    quote_complete = True
    trades_complete = True
    taker_base_complete = True
    taker_quote_complete = True

    def append_bucket() -> None:
        if bucket_start is None:
            return
        bucket_end = bucket_start + custom_interval_seconds
        reaches_bucket_end = bool(
            source_seconds is not None
            and last_time + source_seconds >= bucket_end
        )
        enhanced_complete = bool(
            source_seconds is not None
            and first_time == bucket_start
            and contiguous
            and (reaches_bucket_end or not last_is_closed)
        )
        result.append(BarData(
            time=bucket_start,
            open=open_value,
            high=high_value,
            low=low_value,
            close=close_value,
            volume=round(sum(volume_values), 8),
            is_closed=bool(
                enhanced_complete and last_is_closed and reaches_bucket_end
            ),
            quote_volume=(
                round(sum(quote_values), 8)
                if enhanced_complete and quote_complete
                else None
            ),
            trades=(
                sum(trades_values)
                if enhanced_complete and trades_complete
                else None
            ),
            taker_buy_base=(
                round(sum(taker_base_values), 8)
                if enhanced_complete and taker_base_complete
                else None
            ),
            taker_buy_quote=(
                round(sum(taker_quote_values), 8)
                if enhanced_complete and taker_quote_complete
                else None
            ),
        ))

    for bar in bars:
        (
            row_time,
            row_open,
            row_high,
            row_low,
            row_close,
            row_volume,
            row_is_closed,
            quote_volume,
            trades,
            taker_buy_base,
            taker_buy_quote,
        ) = bar.normalized_aggregation_values()
        row_bucket = (
            row_time // custom_interval_seconds
        ) * custom_interval_seconds

        if bucket_start != row_bucket:
            append_bucket()
            bucket_start = row_bucket
            first_time = row_time
            last_time = row_time
            contiguous = True
            open_value = row_open
            high_value = row_high
            low_value = row_low
            volume_values = []
            quote_values = []
            trades_values = []
            taker_base_values = []
            taker_quote_values = []
            quote_complete = True
            trades_complete = True
            taker_base_complete = True
            taker_quote_complete = True
        elif source_seconds is not None and row_time - last_time != source_seconds:
            contiguous = False

        high_value = max(high_value, row_high)
        low_value = min(low_value, row_low)
        close_value = row_close
        volume_values.append(float(row_volume))
        last_time = row_time
        last_is_closed = row_is_closed

        if quote_volume is None:
            quote_complete = False
        else:
            quote_values.append(float(quote_volume))

        if trades is None:
            trades_complete = False
        else:
            trades_values.append(int(trades))

        if taker_buy_base is None:
            taker_base_complete = False
        else:
            taker_base_values.append(float(taker_buy_base))

        if taker_buy_quote is None:
            taker_quote_complete = False
        else:
            taker_quote_values.append(float(taker_buy_quote))

    append_bucket()
    return result


def _base_capacity_factor(
    target_interval: str,
    base_interval: str,
    nominal_factor: int,
) -> int:
    """Return a safe source-row capacity for one target bucket.

    Month intervals use a nominal 30-day duration for parsing, while real
    calendar buckets can contain 31 days per component month.  Capacity must
    use the maximum calendar width or long 2M/3M pagination can stop early.
    """
    months = parse_monthly_count(target_interval)
    base_ms = parse_interval_ms(base_interval)
    if months is None or base_ms is None or base_ms <= 0:
        return max(1, int(nominal_factor))
    maximum_month_bucket_ms = months * 31 * 86_400_000
    return max(
        int(nominal_factor),
        (maximum_month_bucket_ms + base_ms - 1) // base_ms,
    )


def _resolved_base(
    route: IntervalRoute | None,
    *,
    interval: str,
    custom_seconds: int,
) -> tuple[str, int]:
    """Use the exchange-aware route, retaining a compatibility fallback."""
    if route is None:
        return find_best_base_interval(custom_seconds, interval=interval)
    if route.base_interval is None:
        raise ValueError(f"derived interval route has no base: {route}")
    base_ms = parse_interval_ms(route.base_interval)
    if base_ms is None or base_ms <= 0:
        raise ValueError(f"invalid resolved base interval: {route.base_interval!r}")
    return route.base_interval, max(1, route.spec.nominal_ms // base_ms)


class CustomIntervalQueryService:
    """Build custom interval responses from standard interval bars."""

    def __init__(
        self,
        *,
        cache: BarCache,
        config: QueryConfig,
        base_query: BaseQuery,
        base_query_before: BaseQueryBefore | None = None,
        target_query: BaseQuery | None = None,
        target_query_before: BaseQueryBefore | None = None,
        calendar_provider: CalendarProvider | None = None,
        bar_aggregator: Any | None = None,
    ) -> None:
        self._cache = cache
        self._cfg = config
        self._base_query = base_query
        self._base_query_before = base_query_before
        self._target_query = target_query
        self._target_query_before = target_query_before
        self._calendar_provider = calendar_provider
        self._bar_aggregator = bar_aggregator
        self._flight_lock = threading.Lock()
        self._flights: dict[tuple[Any, ...], Future[QueryResult]] = {}
        self._metrics_lock = threading.Lock()
        self._logical_queries = 0
        self._singleflight_owners = 0
        self._singleflight_joins = 0
        self._query_failures = 0
        self._materialized_hits = 0
        self._derived_queries = 0
        self._base_pages = 0
        self._base_rows = 0
        self._base_overfetch_rows = 0
        self._base_cache_reservations = 0
        self._base_cache_reservation_caps = 0
        self._materialized_probe_seconds = 0.0
        self._base_query_seconds = 0.0
        self._aggregation_seconds = 0.0

    def set_bar_aggregator(self, bar_aggregator: Any | None) -> None:
        """Retain runtime wiring compatibility; reads use the pure bulk reducer."""
        self._bar_aggregator = bar_aggregator

    def snapshot(self) -> dict[str, int | float]:
        """Return cumulative custom-query work, including joined singleflights."""
        with self._metrics_lock:
            return {
                "logical_queries": self._logical_queries,
                "singleflight_owners": self._singleflight_owners,
                "singleflight_joins": self._singleflight_joins,
                "query_failures": self._query_failures,
                "materialized_hits": self._materialized_hits,
                "derived_queries": self._derived_queries,
                "base_pages": self._base_pages,
                "base_rows": self._base_rows,
                "base_overfetch_rows": self._base_overfetch_rows,
                "base_cache_reservations": self._base_cache_reservations,
                "base_cache_reservation_caps": (
                    self._base_cache_reservation_caps
                ),
                "materialized_probe_ms": round(
                    self._materialized_probe_seconds * 1000,
                    2,
                ),
                "base_query_ms": round(self._base_query_seconds * 1000, 2),
                "aggregation_ms": round(self._aggregation_seconds * 1000, 2),
            }

    def _record_owner_result(self, result: QueryResult) -> None:
        metadata = result.metadata
        with self._metrics_lock:
            if metadata.get("target_materialized") is True:
                self._materialized_hits += 1
            elif metadata.get("target_materialized") is False:
                self._derived_queries += 1
            self._base_pages += int(metadata.get("base_page_count") or 0)
            self._base_rows += int(metadata.get("base_rows_fetched") or 0)
            self._base_overfetch_rows += int(
                metadata.get("base_page_overfetch_rows") or 0
            )
            self._base_cache_reservations += int(
                metadata.get("base_cache_reservation_active") is True
            )
            self._base_cache_reservation_caps += int(
                metadata.get("base_cache_reservation_capped") is True
            )
            self._materialized_probe_seconds += (
                float(metadata.get("materialized_probe_ms") or 0.0) / 1000
            )
            self._base_query_seconds += (
                float(metadata.get("base_query_ms") or 0.0) / 1000
            )
            self._aggregation_seconds += (
                float(metadata.get("aggregation_ms") or 0.0) / 1000
            )

    def _calendar_for(self, key: SeriesKey) -> Any | None:
        if self._calendar_provider is None:
            return None
        try:
            return self._calendar_provider(key)
        except Exception as exc:
            logger.error("Custom interval calendar resolution failed for %s: %s", key, exc)
            return None

    @staticmethod
    def _clone_result(result: QueryResult) -> QueryResult:
        """Detach mutable response containers before sharing a flight result."""
        return replace(
            result,
            bars=list(result.bars),
            missing_ranges=[replace(item) for item in result.missing_ranges],
            metadata=dict(result.metadata),
            excluded_ranges=[dict(item) for item in result.excluded_ranges],
        )

    @staticmethod
    def _metric_value(result: QueryResult | None, name: str) -> int | float:
        if result is None:
            return 0
        value = result.metadata.get(name, 0)
        try:
            return float(value) if name in _IO_TIME_FIELDS else int(value)
        except (TypeError, ValueError):
            return 0

    @classmethod
    def _combined_io_metadata(
        cls,
        target_result: QueryResult | None,
        base_result: QueryResult | None,
    ) -> dict[str, int | float]:
        metadata: dict[str, int | float] = {}
        for name in _IO_COUNT_FIELDS:
            target_value = int(cls._metric_value(target_result, name))
            base_value = int(cls._metric_value(base_result, name))
            metadata[name] = target_value + base_value
            metadata[f"target_{name}"] = target_value
            metadata[f"base_{name}"] = base_value
        for name in _IO_TIME_FIELDS:
            target_value = float(cls._metric_value(target_result, name))
            base_value = float(cls._metric_value(base_result, name))
            metadata[name] = round(target_value + base_value, 2)
            metadata[f"target_{name}"] = round(target_value, 2)
            metadata[f"base_{name}"] = round(base_value, 2)
        return metadata

    @staticmethod
    def _base_cache_metadata(
        reservation: HistoryCapacityReservation,
    ) -> dict[str, int | bool]:
        return {
            "base_cache_requested_rows": reservation.requested_bars,
            "base_cache_reserved_rows": reservation.capacity_bars,
            "base_cache_reservation_active": reservation.active,
            "base_cache_reservation_capped": reservation.capped,
        }

    @staticmethod
    def _annotate_single_base_page(result: QueryResult) -> None:
        result.metadata.setdefault("base_page_count", 1)
        result.metadata.setdefault("base_rows_fetched", len(result.bars))
        result.metadata.setdefault("base_rows_unique", len(result.bars))
        result.metadata.setdefault("base_rows_returned", len(result.bars))
        result.metadata.setdefault("base_page_overfetch_rows", 0)

    def _run_singleflight(
        self,
        identity: tuple[Any, ...],
        compute: Callable[[], QueryResult],
    ) -> QueryResult:
        """Share one synchronous derivation for an identical series/range."""
        with self._flight_lock:
            flight = self._flights.get(identity)
            owner = flight is None
            if flight is None:
                flight = Future()
                self._flights[identity] = flight

        with self._metrics_lock:
            self._logical_queries += 1
            if owner:
                self._singleflight_owners += 1
            else:
                self._singleflight_joins += 1

        if not owner:
            joined = self._clone_result(flight.result())
            joined.metadata["singleflight_role"] = "join"
            return joined

        try:
            result = compute()
        except BaseException as exc:
            with self._metrics_lock:
                self._query_failures += 1
            flight.set_exception(exc)
            raise
        else:
            result.metadata["singleflight_role"] = "owner"
            self._record_owner_result(result)
            flight.set_result(self._clone_result(result))
            return result
        finally:
            with self._flight_lock:
                if self._flights.get(identity) is flight:
                    self._flights.pop(identity, None)

    @staticmethod
    def _canonical_materialized_bars(
        bars: list[BarData],
        *,
        interval: str,
        calendar: Any | None,
    ) -> list[BarData]:
        """Keep only rows whose timestamps are valid target-bucket opens."""
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            return []
        trusted: list[BarData] = []
        for bar in bars:
            if calendar is None:
                expected_open_ms = compute_bucket_start_ms(
                    bar.time_ms,
                    interval_ms,
                    interval=interval,
                )
            else:
                expected_open_ms = containing_expected_open_ms(
                    calendar,
                    bar.time_ms,
                    interval,
                )
            if expected_open_ms == bar.time_ms:
                trusted.append(bar)
        return trusted

    @staticmethod
    def _materialized_is_complete(
        result: QueryResult | None,
        bars: list[BarData],
        *,
        effective_limit: int,
        explicit_range: bool,
    ) -> bool:
        if (
            result is None
            or not bars
            or len(bars) != len(result.bars)
            or result.missing_ranges
            or result.retryable
            or not result.complete
        ):
            return False
        # A materialized range may legitimately contain fewer rows than the
        # limit when both requested edges are covered.  Count/directional
        # queries require a full page: a target-storage left edge is not proof
        # that authoritative base history is exhausted.
        return explicit_range or len(bars) >= effective_limit

    @classmethod
    def _materialized_result(
        cls,
        result: QueryResult,
        bars: list[BarData],
        *,
        base_interval: str,
        factor: int,
        started_at: float,
        materialized_probe_ms: float,
    ) -> QueryResult:
        cloned = cls._clone_result(result)
        cloned.bars = list(bars)
        cloned.total = len(bars)
        cloned.metadata.update({
            **cls._combined_io_metadata(result, None),
            "elapsed_ms": round((time.monotonic() - started_at) * 1000, 2),
            "derived_from": base_interval,
            "aggregation_factor": factor,
            "materialized_probe_ms": round(materialized_probe_ms, 2),
            "base_query_ms": 0.0,
            "aggregation_ms": 0.0,
            "base_page_count": 0,
            "base_rows_fetched": 0,
            "base_page_overfetch_rows": 0,
            "target_materialized": True,
            "target_materialized_rows": len(bars),
        })
        return cloned

    def _read_materialized_target(
        self,
        *,
        symbol: str,
        interval: str,
        start_ms: int | None,
        end_ms: int | None,
        limit: int,
        exchange: str,
        market_type: str,
    ) -> QueryResult | None:
        if self._target_query is None:
            return None
        try:
            return self._target_query(
                symbol,
                interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=False,
            )
        except Exception as exc:
            logger.warning("Materialized custom target read failed for %s: %s", interval, exc)
            return None

    def _read_materialized_target_before(
        self,
        *,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int,
        exchange: str,
        market_type: str,
    ) -> QueryResult | None:
        if self._target_query_before is None:
            return None
        try:
            return self._target_query_before(
                symbol,
                interval,
                before_ms,
                limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=False,
            )
        except Exception as exc:
            logger.warning(
                "Materialized custom target pagination read failed for %s: %s",
                interval,
                exc,
            )
            return None

    def project_base_repair_to_target(
        self,
        *,
        symbol: str,
        target_interval: str,
        base_interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str,
        market_type: str,
    ) -> dict[str, int | str] | None:
        """Project a durable base gap onto affected derived candle opens."""
        if (
            target_interval == base_interval
            or parse_custom_interval(target_interval) is None
            or int(start_ms) > int(end_ms)
        ):
            return None
        key = SeriesKey(
            symbol,
            target_interval,
            exchange=exchange,
            market_type=market_type,
        )
        calendar = self._calendar_for(key)
        interval_ms = parse_interval_ms(target_interval)
        if interval_ms is None or interval_ms <= 0:
            interval_ms = (parse_custom_interval(target_interval) or 60) * 1000

        def _containing_open(component_open_ms: int) -> int | None:
            if calendar is None:
                return compute_bucket_start_ms(
                    component_open_ms,
                    interval_ms,
                    interval=target_interval,
                )
            return containing_expected_open_ms(
                calendar,
                int(component_open_ms),
                target_interval,
            )

        target_start_ms = _containing_open(int(start_ms))
        target_end_ms = _containing_open(int(end_ms))
        if (
            target_start_ms is None
            or target_end_ms is None
            or target_start_ms > target_end_ms
        ):
            return None
        return {
            "interval": target_interval,
            "start_ms": target_start_ms,
            "end_ms": target_end_ms,
        }

    @staticmethod
    def _merge_base_page_results(
        results: list[QueryResult],
        bars: list[BarData],
    ) -> QueryResult:
        """Combine directional base pages without losing history semantics."""
        if not results:
            return QueryResult(bars=bars, total=len(bars))
        if len(results) == 1 and bars == results[0].bars:
            return results[0]

        newest = results[0]
        oldest = results[-1]
        missing_by_identity = {}
        exclusions_by_identity: dict[tuple[Any, ...], dict[str, Any]] = {}
        for result in results:
            for item in result.missing_ranges:
                missing_by_identity.setdefault(
                    (
                        item.symbol,
                        item.interval,
                        item.exchange,
                        item.market_type,
                        item.start_ms,
                        item.end_ms,
                        item.reason,
                    ),
                    item,
                )
            for exclusion in result.excluded_ranges:
                identity = (
                    exclusion.get("start_ms"),
                    exclusion.get("end_ms"),
                    exclusion.get("disposition"),
                    exclusion.get("reason"),
                )
                exclusions_by_identity.setdefault(identity, dict(exclusion))

        missing_ranges = list(missing_by_identity.values())
        pending = bool(
            missing_ranges
            or any(result.retryable or result.history_state == "pending" for result in results)
        )
        if pending:
            history_state = "pending"
            complete = False
            retryable = True
            terminal_reason = oldest.terminal_reason
            has_more = True
        else:
            history_state = oldest.history_state
            complete = all(result.complete for result in results)
            retryable = False
            terminal_reason = oldest.terminal_reason
            has_more = oldest.has_more

        sources = {result.source for result in results}
        source = next(iter(sources)) if len(sources) == 1 else QuerySource.MIXED
        revisions = [result.availability_revision for result in results if result.availability_revision]
        earliest_values = [
            result.earliest_available_ms
            for result in results
            if result.earliest_available_ms is not None
        ]
        return QueryResult(
            bars=bars,
            symbol=newest.symbol,
            interval=newest.interval,
            exchange=newest.exchange,
            market_type=newest.market_type,
            source=source,
            total=len(bars),
            has_more=has_more,
            cache_hit=any(result.cache_hit for result in results),
            backfill_triggered=any(result.backfill_triggered for result in results),
            has_tail_gap=any(result.has_tail_gap for result in results),
            missing_ranges=missing_ranges,
            metadata={
                **newest.metadata,
                "base_page_count": len(results),
            },
            history_state=history_state,
            complete=complete,
            retryable=retryable,
            terminal_reason=terminal_reason,
            earliest_available_ms=min(earliest_values) if earliest_values else None,
            next_before_ms=oldest.next_before_ms,
            availability_revision=revisions[-1] if revisions else None,
            excluded_ranges=list(exclusions_by_identity.values()),
        )

    def _page_base_history(
        self,
        *,
        symbol: str,
        interval: str,
        before_ms: int,
        target_limit: int,
        lower_bound_ms: int | None,
        exchange: str,
        market_type: str,
        auto_backfill: bool | None,
        initial_result: QueryResult | None = None,
    ) -> QueryResult:
        """Read enough base rows across the per-query limit, newest to oldest."""
        if self._base_query_before is None:
            if initial_result is not None:
                return initial_result
            return self._base_query(
                symbol,
                interval,
                end_ms=before_ms - 1,
                limit=min(target_limit, self._cfg.max_limit),
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
            )

        results: list[QueryResult] = []
        by_time: dict[int, BarData] = {}
        cursor_ms = int(before_ms)
        if initial_result is not None:
            results.append(initial_result)
            for bar in initial_result.bars:
                by_time[bar.time] = bar
            if initial_result.bars:
                cursor_ms = min(bar.time_ms for bar in initial_result.bars)

        source_interval_ms = parse_interval_ms(interval)
        page_capacity = max(1, int(target_limit))
        if lower_bound_ms is not None:
            if source_interval_ms is not None and source_interval_ms > 0:
                span_capacity = (
                    max(0, int(before_ms) - int(lower_bound_ms))
                    + source_interval_ms
                    - 1
                ) // source_interval_ms
                page_capacity = max(page_capacity, span_capacity)
        requested_max_pages = max(
            2,
            (page_capacity + self._cfg.max_limit - 1) // self._cfg.max_limit + 4,
        )
        max_pages = min(requested_max_pages, _MAX_CUSTOM_BASE_PAGES)
        while len(results) < max_pages:
            reached_lower_bound = bool(
                lower_bound_ms is not None
                and by_time
                and min(bar.time_ms for bar in by_time.values()) <= lower_bound_ms
            )
            reached_count = lower_bound_ms is None and len(by_time) >= target_limit
            if reached_lower_bound or reached_count:
                break
            if results:
                previous = results[-1]
                if (
                    not previous.has_more
                    and not previous.retryable
                    and not previous.missing_ranges
                ):
                    break

            remaining = max(1, target_limit - len(by_time))
            page_limit = min(self._cfg.max_limit, remaining)
            if (
                lower_bound_ms is not None
                and source_interval_ms is not None
                and source_interval_ms > 0
            ):
                remaining_span_rows = max(
                    1,
                    (
                        max(0, cursor_ms - int(lower_bound_ms))
                        + source_interval_ms
                        - 1
                    ) // source_interval_ms,
                )
                page_limit = min(page_limit, remaining_span_rows)
            page = self._base_query_before(
                symbol,
                interval,
                cursor_ms,
                page_limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
            )
            results.append(page)
            if not page.bars:
                break
            next_cursor_ms = min(bar.time_ms for bar in page.bars)
            for bar in page.bars:
                by_time[bar.time] = bar
            if next_cursor_ms >= cursor_ms:
                logger.error(
                    "Custom base pagination made no progress for %s %s at %d",
                    symbol,
                    interval,
                    cursor_ms,
                )
                break
            cursor_ms = next_cursor_ms

        bars = sorted(by_time.values(), key=lambda bar: bar.time)
        if lower_bound_ms is not None:
            bars = [bar for bar in bars if bar.time_ms >= lower_bound_ms]
        merged = self._merge_base_page_results(results, bars)
        for name in _IO_COUNT_FIELDS:
            merged.metadata[name] = sum(
                int(self._metric_value(result, name))
                for result in results
            )
        for name in _IO_TIME_FIELDS:
            merged.metadata[name] = round(sum(
                float(self._metric_value(result, name))
                for result in results
            ), 2)
        merged.metadata.update({
            "base_page_count": len(results),
            "base_rows_fetched": sum(len(result.bars) for result in results),
            "base_rows_unique": len(by_time),
            "base_rows_returned": len(bars),
            "base_page_overfetch_rows": max(0, len(by_time) - len(bars)),
        })
        still_needs_rows = bool(
            (
                lower_bound_ms is not None
                and (not bars or bars[0].time_ms > lower_bound_ms)
            )
            or (lower_bound_ms is None and len(bars) < target_limit)
        )
        page_capped = bool(
            requested_max_pages > max_pages
            and len(results) >= max_pages
            and still_needs_rows
            and results
            and (
                results[-1].has_more
                or results[-1].retryable
                or bool(results[-1].missing_ranges)
            )
        )
        if page_capped:
            # This is deliberate pagination, not evidence of missing source
            # history.  Advertising a synthetic MissingRange here would send
            # the verifier/backfill path after data that already exists and
            # recreate the repair storm this budget is meant to prevent.
            merged.has_more = True
            merged.metadata["base_pagination_capped"] = True
            merged.metadata["base_page_limit"] = max_pages
        return merged

    def query_from_base(
        self,
        *,
        symbol: str,
        interval: str,
        start_ms: int | None,
        end_ms: int | None,
        limit: int | None,
        started_at: float,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
        route: IntervalRoute | None = None,
    ) -> QueryResult:
        identity = (
            "range",
            exchange.strip().lower(),
            market_type.strip().lower(),
            symbol.strip().upper(),
            interval,
            start_ms,
            end_ms,
            limit,
            auto_backfill,
            route.base_interval if route is not None else None,
        )
        return self._run_singleflight(
            identity,
            lambda: self._query_from_base_impl(
                symbol=symbol,
                interval=interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
                started_at=started_at,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                route=route,
            ),
        )

    def _query_from_base_impl(
        self,
        *,
        symbol: str,
        interval: str,
        start_ms: int | None,
        end_ms: int | None,
        limit: int | None,
        started_at: float,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
        route: IntervalRoute | None = None,
    ) -> QueryResult:
        """Serve custom intervals by aggregating a standard interval on read."""
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None:
            return QueryResult(
                bars=[],
                symbol=symbol.upper(),
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
                metadata={"elapsed_ms": round((time.monotonic() - started_at) * 1000, 2)},
            )

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        calendar = self._calendar_for(key)
        effective_limit = min(limit or self._cfg.default_limit, self._cfg.max_limit)
        base_interval, factor = _resolved_base(
            route,
            interval=interval,
            custom_seconds=custom_seconds,
        )
        capacity_factor = _base_capacity_factor(interval, base_interval, factor)
        custom_ms = custom_seconds * 1000
        materialized_started_at = time.monotonic()
        materialized_result = self._read_materialized_target(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=effective_limit,
            exchange=exchange,
            market_type=market_type,
        )
        materialized_bars = self._canonical_materialized_bars(
            materialized_result.bars if materialized_result is not None else [],
            interval=interval,
            calendar=calendar,
        )
        materialized_probe_ms = (time.monotonic() - materialized_started_at) * 1000
        if self._materialized_is_complete(
            materialized_result,
            materialized_bars,
            effective_limit=effective_limit,
            explicit_range=start_ms is not None or end_ms is not None,
        ):
            return self._materialized_result(
                materialized_result,
                materialized_bars,
                base_interval=base_interval,
                factor=factor,
                started_at=started_at,
                materialized_probe_ms=materialized_probe_ms,
            )

        month_count = parse_monthly_count(interval)
        aligned_start_ms = None
        if start_ms is not None:
            if calendar is not None:
                alignment_end_ms = (
                    int(end_ms)
                    if end_ms is not None
                    else int(start_ms) + max(custom_ms, 366 * 86_400_000)
                )
                aligned_start_ms = calendar.first_expected_open(
                    int(start_ms),
                    alignment_end_ms,
                    interval,
                )
            elif month_count is not None:
                aligned_start_ms = compute_month_bucket_ms(start_ms, month_count)
            else:
                aligned_start_ms = compute_bucket_start_ms(
                    start_ms,
                    custom_ms,
                    interval=interval,
                )
            if aligned_start_ms is None:
                aligned_start_ms = int(start_ms)

        # ``end_ms`` addresses custom bar opens.  The base read must cover the
        # complete final custom bucket; otherwise a timestamp-complete custom
        # response can silently contain a one-component partial aggregate.
        base_end_ms = end_ms
        if end_ms is not None:
            if calendar is not None:
                end_bucket_start_ms = containing_expected_open_ms(
                    calendar,
                    int(end_ms),
                    interval,
                )
                if end_bucket_start_ms is not None:
                    base_end_ms = expected_bucket_end_ms(
                        calendar,
                        end_bucket_start_ms,
                        interval,
                    ) - 1
            elif month_count is not None:
                end_bucket_start_ms = compute_month_bucket_ms(end_ms, month_count)
                base_end_ms = (
                    next_month_bucket(end_bucket_start_ms // 1000, month_count) * 1000
                    - 1
                )
            else:
                end_bucket_start_ms = compute_bucket_start_ms(
                    end_ms,
                    custom_ms,
                    interval=interval,
                )
                base_end_ms = end_bucket_start_ms + custom_ms - 1

        if start_ms is not None and end_ms is not None:
            estimated_custom = max(1, ((end_ms - aligned_start_ms) // custom_ms) + 2)
            base_limit = estimated_custom * capacity_factor + capacity_factor
        else:
            base_limit = (effective_limit + 2) * capacity_factor + capacity_factor

        base_cache_reservation = self._cache.reserve_history_capacity(
            SeriesKey(
                symbol,
                base_interval,
                exchange=exchange,
                market_type=market_type,
            ),
            base_limit,
        )

        seed_limit = min(base_limit, self._cfg.max_limit)
        seed_start_ms = aligned_start_ms if base_limit <= self._cfg.max_limit else None
        base_started_at = time.monotonic()
        base_result = self._base_query(
            symbol,
            base_interval,
            start_ms=seed_start_ms,
            end_ms=base_end_ms,
            limit=seed_limit,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
        )
        if base_limit > self._cfg.max_limit and self._base_query_before is not None:
            base_result = self._page_base_history(
                symbol=symbol,
                interval=base_interval,
                before_ms=(
                    int(base_end_ms) + 1
                    if base_end_ms is not None
                    else int(time.time() * 1000) + 1
                ),
                target_limit=base_limit,
                lower_bound_ms=aligned_start_ms,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                initial_result=base_result,
            )
        self._annotate_single_base_page(base_result)
        base_query_ms = (time.monotonic() - base_started_at) * 1000
        aggregation_started_at = time.monotonic()
        derived_bars = self.aggregate_custom_bars(
            base_result.bars,
            symbol=symbol,
            interval=interval,
            source_interval=base_interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
        )
        derived_bars, omitted_incomplete = self._omit_bars_overlapping_base_gaps(
            derived_bars,
            base_result.missing_ranges,
            interval=interval,
            calendar=calendar,
        )
        aggregation_ms = (time.monotonic() - aggregation_started_at) * 1000
        if materialized_bars:
            combined = {bar.time: bar for bar in derived_bars}
            # A structurally valid target row is the already-materialized
            # canonical result; prefer it over an on-read rebuild at the same
            # open (notably for the live/forming tail).
            combined.update({bar.time: bar for bar in materialized_bars})
            derived_bars = sorted(combined.values(), key=lambda bar: bar.time)
            if start_ms is not None:
                derived_bars = [bar for bar in derived_bars if bar.time_ms >= start_ms]
            if end_ms is not None:
                derived_bars = [bar for bar in derived_bars if bar.time_ms <= end_ms]
        derived_total = len(derived_bars)
        if derived_total > effective_limit:
            derived_bars = derived_bars[-effective_limit:]

        if derived_bars:
            self._cache.bulk_load(key, derived_bars)

        elapsed = time.monotonic() - started_at
        has_more = bool(
            base_result.has_more
            or derived_total > effective_limit
            or base_result.missing_ranges
            or base_result.retryable
        )
        result_source = (
            QuerySource.MIXED
            if materialized_bars and base_result.bars
            else materialized_result.source
            if materialized_bars and materialized_result is not None
            else base_result.source
        )
        return QueryResult(
            bars=derived_bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=result_source,
            total=len(derived_bars),
            has_more=has_more,
            cache_hit=base_result.cache_hit or bool(
                materialized_result is not None and materialized_result.cache_hit
            ),
            backfill_triggered=base_result.backfill_triggered,
            has_tail_gap=base_result.has_tail_gap,
            missing_ranges=base_result.missing_ranges,
            metadata={
                **base_result.metadata,
                **self._combined_io_metadata(materialized_result, base_result),
                **self._base_cache_metadata(base_cache_reservation),
                "elapsed_ms": round(elapsed * 1000, 2),
                "derived_from": base_interval,
                "aggregation_factor": factor,
                "materialized_probe_ms": round(materialized_probe_ms, 2),
                "base_query_ms": round(base_query_ms, 2),
                "aggregation_ms": round(aggregation_ms, 2),
                "base_source": base_result.source.value,
                "omitted_incomplete_aggregates": omitted_incomplete,
                "target_materialized": False,
                "target_materialized_rows": len(materialized_bars),
            },
            history_state=base_result.history_state,
            complete=base_result.complete,
            retryable=base_result.retryable,
            terminal_reason=base_result.terminal_reason,
            earliest_available_ms=(
                derived_bars[0].time_ms
                if base_result.history_state == "exhausted" and derived_bars
                else base_result.earliest_available_ms
            ),
            next_before_ms=(
                derived_bars[0].time_ms if has_more and derived_bars else None
            ),
            availability_revision=base_result.availability_revision,
            excluded_ranges=list(base_result.excluded_ranges),
        )

    def query_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
        route: IntervalRoute | None = None,
    ) -> QueryResult:
        identity = (
            "before",
            exchange.strip().lower(),
            market_type.strip().lower(),
            symbol.strip().upper(),
            interval,
            int(before_ms),
            int(limit),
            auto_backfill,
            route.base_interval if route is not None else None,
        )
        return self._run_singleflight(
            identity,
            lambda: self._query_before_impl(
                symbol,
                interval,
                before_ms,
                limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                route=route,
            ),
        )

    def _query_before_impl(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
        route: IntervalRoute | None = None,
    ) -> QueryResult:
        """Paginate custom intervals by rebuilding them from base bars."""
        started_at = time.monotonic()
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None:
            return QueryResult(
                bars=[],
                symbol=symbol.upper(),
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
            )

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        calendar = self._calendar_for(key)
        effective_limit = min(limit, self._cfg.max_limit)
        base_interval, factor = _resolved_base(
            route,
            interval=interval,
            custom_seconds=custom_seconds,
        )
        capacity_factor = _base_capacity_factor(interval, base_interval, factor)
        custom_ms = custom_seconds * 1000
        materialized_started_at = time.monotonic()
        materialized_result = self._read_materialized_target_before(
            symbol=symbol,
            interval=interval,
            before_ms=before_ms,
            limit=effective_limit,
            exchange=exchange,
            market_type=market_type,
        )
        materialized_bars = self._canonical_materialized_bars(
            materialized_result.bars if materialized_result is not None else [],
            interval=interval,
            calendar=calendar,
        )
        materialized_probe_ms = (time.monotonic() - materialized_started_at) * 1000
        if self._materialized_is_complete(
            materialized_result,
            materialized_bars,
            effective_limit=effective_limit,
            explicit_range=False,
        ):
            return self._materialized_result(
                materialized_result,
                materialized_bars,
                base_interval=base_interval,
                factor=factor,
                started_at=started_at,
                materialized_probe_ms=materialized_probe_ms,
            )

        month_count = parse_monthly_count(interval)
        if calendar is not None:
            last_bucket_start_ms = containing_expected_open_ms(
                calendar,
                int(before_ms) - 1,
                interval,
            )
            if last_bucket_start_ms is None:
                last_bucket_start_ms = compute_bucket_start_ms(
                    before_ms - 1,
                    custom_ms,
                    interval=interval,
                )
            base_end_ms = expected_bucket_end_ms(
                calendar,
                last_bucket_start_ms,
                interval,
            ) - 1
        elif month_count is not None:
            last_bucket_start_ms = compute_month_bucket_ms(before_ms - 1, month_count)
            base_end_ms = next_month_bucket(
                last_bucket_start_ms // 1000,
                month_count,
            ) * 1000 - 1
        else:
            last_bucket_start_ms = compute_bucket_start_ms(
                before_ms - 1,
                custom_ms,
                interval=interval,
            )
            base_end_ms = last_bucket_start_ms + custom_ms - 1
        base_limit = (effective_limit + 2) * capacity_factor

        base_cache_reservation = self._cache.reserve_history_capacity(
            SeriesKey(
                symbol,
                base_interval,
                exchange=exchange,
                market_type=market_type,
            ),
            base_limit,
        )

        base_started_at = time.monotonic()
        base_result = self._page_base_history(
            symbol=symbol,
            interval=base_interval,
            before_ms=base_end_ms + 1,
            target_limit=base_limit,
            lower_bound_ms=None,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
        )
        self._annotate_single_base_page(base_result)
        base_query_ms = (time.monotonic() - base_started_at) * 1000
        aggregation_started_at = time.monotonic()
        derived_bars = self.aggregate_custom_bars(
            base_result.bars,
            symbol=symbol,
            interval=interval,
            source_interval=base_interval,
            end_ms=base_end_ms,
            exchange=exchange,
            market_type=market_type,
        )
        derived_bars, omitted_incomplete = self._omit_bars_overlapping_base_gaps(
            derived_bars,
            base_result.missing_ranges,
            interval=interval,
            calendar=calendar,
        )
        aggregation_ms = (time.monotonic() - aggregation_started_at) * 1000
        derived_bars = [bar for bar in derived_bars if bar.time_ms < before_ms]
        if materialized_bars:
            combined = {bar.time: bar for bar in derived_bars}
            combined.update({bar.time: bar for bar in materialized_bars})
            derived_bars = sorted(
                (bar for bar in combined.values() if bar.time_ms < before_ms),
                key=lambda bar: bar.time,
            )
        derived_total = len(derived_bars)
        if derived_total > effective_limit:
            derived_bars = derived_bars[-effective_limit:]

        if derived_bars:
            self._cache.bulk_load(key, derived_bars)

        has_more = bool(
            base_result.has_more
            or derived_total > effective_limit
            or base_result.missing_ranges
            or base_result.retryable
        )
        result_source = (
            QuerySource.MIXED
            if materialized_bars and base_result.bars
            else materialized_result.source
            if materialized_bars and materialized_result is not None
            else base_result.source
        )
        return QueryResult(
            bars=derived_bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=result_source,
            total=len(derived_bars),
            has_more=has_more,
            cache_hit=base_result.cache_hit or bool(
                materialized_result is not None and materialized_result.cache_hit
            ),
            backfill_triggered=base_result.backfill_triggered,
            has_tail_gap=base_result.has_tail_gap,
            missing_ranges=base_result.missing_ranges,
            metadata={
                **base_result.metadata,
                **self._combined_io_metadata(materialized_result, base_result),
                **self._base_cache_metadata(base_cache_reservation),
                "elapsed_ms": round((time.monotonic() - started_at) * 1000, 2),
                "derived_from": base_interval,
                "aggregation_factor": factor,
                "materialized_probe_ms": round(materialized_probe_ms, 2),
                "base_query_ms": round(base_query_ms, 2),
                "aggregation_ms": round(aggregation_ms, 2),
                "base_source": base_result.source.value,
                "omitted_incomplete_aggregates": omitted_incomplete,
                "target_materialized": False,
                "target_materialized_rows": len(materialized_bars),
            },
            history_state=base_result.history_state,
            complete=base_result.complete,
            retryable=base_result.retryable,
            terminal_reason=base_result.terminal_reason,
            earliest_available_ms=(
                derived_bars[0].time_ms
                if base_result.history_state == "exhausted" and derived_bars
                else base_result.earliest_available_ms
            ),
            next_before_ms=(
                derived_bars[0].time_ms if has_more and derived_bars else None
            ),
            availability_revision=base_result.availability_revision,
            excluded_ranges=list(base_result.excluded_ranges),
        )

    def aggregate_custom_bars(
        self,
        base_bars: list[BarData],
        symbol: str,
        interval: str,
        source_interval: str | None = None,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> list[BarData]:
        """Aggregate through the canonical pure bulk reducer exactly once."""
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None or not base_bars:
            return []

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        calendar = self._calendar_for(key)

        result = self._aggregate_read_only(
            base_bars,
            interval,
            custom_seconds,
            source_interval=source_interval,
            calendar=calendar,
        )

        if start_ms is not None:
            result = [bar for bar in result if bar.time_ms >= start_ms]
        if end_ms is not None:
            result = [bar for bar in result if bar.time_ms <= end_ms]
        return result

    @staticmethod
    def _omit_bars_overlapping_base_gaps(
        bars: list[BarData],
        missing_ranges: list[MissingRange],
        *,
        interval: str,
        calendar: Any | None,
    ) -> tuple[list[BarData], int]:
        """Never publish an OHLCV aggregate built across a known base-series hole."""
        if not bars or not missing_ranges:
            return bars, 0

        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            custom_seconds = parse_custom_interval(interval)
            interval_ms = (custom_seconds or 60) * 1000

        month_count = parse_monthly_count(interval)
        safe: list[BarData] = []
        for bar in bars:
            start_ms = int(bar.time_ms)
            if calendar is not None:
                end_exclusive_ms = expected_bucket_end_ms(
                    calendar,
                    start_ms,
                    interval,
                )
            elif month_count is not None:
                end_exclusive_ms = next_month_bucket(
                    start_ms // 1000,
                    month_count,
                ) * 1000
            else:
                end_exclusive_ms = compute_bucket_end_ms(
                    start_ms,
                    interval_ms,
                    interval=interval,
                )
            overlaps = any(
                int(item.start_ms) < end_exclusive_ms
                and int(item.end_ms) >= start_ms
                for item in missing_ranges
            )
            if not overlaps:
                safe.append(bar)
        return safe, len(bars) - len(safe)

    @staticmethod
    def _aggregate_read_only(
        base_bars: list[BarData],
        interval: str,
        custom_seconds: int,
        *,
        source_interval: str | None = None,
        calendar: Any | None = None,
    ) -> list[BarData]:
        """Read-only aggregation used for partial buckets and fallback."""
        source_interval_ms = parse_interval_ms(source_interval) if source_interval else None
        source_interval_seconds = (
            source_interval_ms // 1000
            if source_interval_ms is not None
            else None
        )
        interval_spec = parse_interval_spec(interval)
        month_count = parse_monthly_count(interval)
        if (
            (calendar is None or isinstance(calendar, AlwaysOpenCalendar))
            and month_count is None
            and interval_spec is not None
            and interval_spec.alignment is IntervalAlignment.FIXED_EPOCH
        ):
            return _aggregate_fixed_bars_to_interval(
                base_bars,
                custom_seconds,
                source_interval_seconds=source_interval_seconds,
            )
        if month_count is not None and calendar is None:
            aggregated = aggregate_rows_by_month(
                [bar.to_aggregation_dict() for bar in base_bars],
                months=month_count,
                source_interval_seconds=source_interval_seconds,
            )
        else:
            aggregated = _aggregate_rows_to_interval(
                [bar.to_aggregation_dict() for bar in base_bars],
                custom_seconds,
                interval=interval,
                source_interval=source_interval,
                source_interval_seconds=source_interval_seconds,
                calendar=calendar,
            )

        return [BarData.from_dict(row) for row in aggregated]
