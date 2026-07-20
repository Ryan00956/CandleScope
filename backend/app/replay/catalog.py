"""Deterministic BAR replay catalog and compact eligible-window planning."""

from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Callable, Mapping, Protocol, Sequence

from app.data_engine.interval_policy import (
    compute_bucket_start_ms,
    is_ephemeral_interval,
    is_monthly_interval,
    last_closed_bar_open_ms,
    parse_interval_ms,
)

from .canonical import canonical_sha256
from .constants import DataFidelity, QualityMode
from .errors import ReplayDomainError, ReplayErrorCode
from .models import (
    MAX_RANDOM_SEED,
    validate_counter,
    validate_identifier,
    validate_timestamp_ms,
)


CATALOG_SCHEMA_VERSION = "replay-catalog.v1"
CATALOG_SAMPLE_SCHEMA_VERSION = "replay-catalog-sample.v1"


class KlinesReadRepository(Protocol):
    def list_series(
        self,
        custom_only: bool = False,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict]: ...

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict: ...

    def scan_gaps(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        limit: int = 50_000,
        calendar: object | None = None,
    ) -> dict: ...

    def query_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict]: ...


@dataclass(frozen=True, order=True, slots=True)
class ReplaySeriesIdentity:
    exchange: str
    market_type: str
    symbol: str

    def __post_init__(self) -> None:
        for field_name in ("exchange", "market_type", "symbol"):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )

    @property
    def key(self) -> str:
        return f"{self.exchange}:{self.market_type}:{self.symbol}"

    def to_dict(self) -> dict[str, str]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplaySeriesIdentity":
        if set(payload) != {"exchange", "market_type", "symbol"}:
            raise ValueError("replay series identity fields are incompatible")
        return cls(
            exchange=payload["exchange"],  # type: ignore[arg-type]
            market_type=payload["market_type"],  # type: ignore[arg-type]
            symbol=payload["symbol"],  # type: ignore[arg-type]
        )


@dataclass(frozen=True, slots=True)
class SeriesBounds:
    earliest_open_ms: int
    latest_source_open_ms: int
    latest_closed_open_ms: int
    total_count: int

    def to_dict(self) -> dict[str, int]:
        return {
            "earliest_open_ms": self.earliest_open_ms,
            "latest_source_open_ms": self.latest_source_open_ms,
            "latest_closed_open_ms": self.latest_closed_open_ms,
            "total_count": self.total_count,
        }


@dataclass(frozen=True, order=True, slots=True)
class GapRange:
    start_ms: int
    end_ms: int
    missing_bars: int
    reason: str

    def to_dict(self) -> dict[str, object]:
        return {
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "missing_bars": self.missing_bars,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class GapSummary:
    gaps: tuple[GapRange, ...]
    scanned_bars: int
    scan_calls: int
    calendar_id: str

    @property
    def gap_count(self) -> int:
        return len(self.gaps)

    @property
    def missing_bars(self) -> int:
        return sum(gap.missing_bars for gap in self.gaps)

    def to_dict(self) -> dict[str, object]:
        return {
            "gaps": [gap.to_dict() for gap in self.gaps],
            "gap_count": self.gap_count,
            "missing_bars": self.missing_bars,
            "scanned_bars": self.scanned_bars,
            "scan_calls": self.scan_calls,
            "calendar_id": self.calendar_id,
        }


EMPTY_GAP_SUMMARY = GapSummary((), 0, 0, "")


@dataclass(frozen=True, slots=True)
class EligibleWindow:
    interval: str
    interval_ms: int
    warmup_start_ms: int
    replay_start_ms: int
    replay_end_open_ms: int
    warmup_bars: int
    replay_bars: int

    @property
    def total_rows(self) -> int:
        return self.warmup_bars + self.replay_bars

    @property
    def horizon_ms(self) -> int:
        return self.replay_bars * self.interval_ms

    def to_dict(self) -> dict[str, object]:
        return {
            "interval": self.interval,
            "interval_ms": self.interval_ms,
            "warmup_start_ms": self.warmup_start_ms,
            "replay_start_ms": self.replay_start_ms,
            "replay_end_open_ms": self.replay_end_open_ms,
            "warmup_bars": self.warmup_bars,
            "replay_bars": self.replay_bars,
            "total_rows": self.total_rows,
        }


@dataclass(frozen=True, slots=True)
class EligibleWindowRange:
    interval: str
    interval_ms: int
    first_start_ms: int
    last_start_ms: int
    count: int
    warmup_bars: int
    replay_bars: int

    def materialize(self, offset: int) -> EligibleWindow:
        if isinstance(offset, bool) or not isinstance(offset, int):
            raise TypeError("eligible window offset must be an integer")
        if offset < 0 or offset >= self.count:
            raise IndexError("eligible window offset outside compact range")
        replay_start_ms = self.first_start_ms + offset * self.interval_ms
        return EligibleWindow(
            interval=self.interval,
            interval_ms=self.interval_ms,
            warmup_start_ms=replay_start_ms - self.warmup_bars * self.interval_ms,
            replay_start_ms=replay_start_ms,
            replay_end_open_ms=(
                replay_start_ms + (self.replay_bars - 1) * self.interval_ms
            ),
            warmup_bars=self.warmup_bars,
            replay_bars=self.replay_bars,
        )

    def contains(self, start_ms: int) -> bool:
        return (
            self.first_start_ms <= start_ms <= self.last_start_ms
            and (start_ms - self.first_start_ms) % self.interval_ms == 0
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "interval": self.interval,
            "interval_ms": self.interval_ms,
            "first_start_ms": self.first_start_ms,
            "last_start_ms": self.last_start_ms,
            "count": self.count,
            "warmup_bars": self.warmup_bars,
            "replay_bars": self.replay_bars,
        }


@dataclass(frozen=True, slots=True)
class ReplayCatalogEntry:
    identity: ReplaySeriesIdentity
    base_intervals: tuple[str, ...]
    selected_base_interval: str | None
    bounds: SeriesBounds | None
    gap_summary: GapSummary
    eligible_ranges: tuple[EligibleWindowRange, ...]
    quality: DataFidelity | None
    source_fingerprint: str
    catalog_epoch: str
    limitations: tuple[str, ...]

    @property
    def eligible_window_count(self) -> int:
        return sum(item.count for item in self.eligible_ranges)

    def to_hash_dict(self) -> dict[str, object]:
        return {
            "identity": self.identity.to_dict(),
            "base_intervals": list(self.base_intervals),
            "selected_base_interval": self.selected_base_interval,
            "bounds": self.bounds.to_dict() if self.bounds is not None else None,
            "gap_summary": self.gap_summary.to_dict(),
            "eligible_ranges": [item.to_dict() for item in self.eligible_ranges],
            "eligible_window_count": self.eligible_window_count,
            "quality": self.quality.value if self.quality is not None else None,
            "source_fingerprint": self.source_fingerprint,
            "limitations": list(self.limitations),
        }


@dataclass(frozen=True, slots=True)
class ReplayCatalogSnapshot:
    schema_version: str
    source_fingerprint: str
    catalog_epoch: str
    generated_at_ms: int
    warmup_bars: int
    horizon_ms: int
    quality_mode: QualityMode
    entries: tuple[ReplayCatalogEntry, ...]

    def require_entry(self, identity: ReplaySeriesIdentity) -> ReplayCatalogEntry:
        for entry in self.entries:
            if entry.identity == identity:
                return entry
        raise ReplayDomainError(
            ReplayErrorCode.UNSUPPORTED_SOURCE,
            f"replay series is not present in catalog: {identity.key}",
            details={"identity": identity.to_dict()},
        )


@dataclass(frozen=True, slots=True)
class _CacheRecord:
    created_monotonic: float
    snapshot: ReplayCatalogSnapshot


class ReplayCatalog:
    """Build and cache exact BAR replay windows using only repository contracts."""

    def __init__(
        self,
        repository: KlinesReadRepository,
        *,
        native_intervals: Callable[[ReplaySeriesIdentity], Sequence[str]],
        now_ms: Callable[[], int],
        monotonic: Callable[[], float] = time.monotonic,
        max_scan_rows: int = 50_000,
        max_gap_records: int = 10_000,
        max_warmup_bars: int = 5_000,
        max_horizon_days: int = 30,
        max_dataset_rows: int = 100_000,
        cache_ttl_seconds: float = 30.0,
        max_cache_entries: int = 16,
    ) -> None:
        if max_scan_rows < 1:
            raise ValueError("max_scan_rows must be positive")
        if max_gap_records < 1:
            raise ValueError("max_gap_records must be positive")
        if max_cache_entries < 1:
            raise ValueError("max_cache_entries must be positive")
        if cache_ttl_seconds < 0:
            raise ValueError("cache_ttl_seconds cannot be negative")
        self._repository = repository
        self._native_intervals = native_intervals
        self._now_ms = now_ms
        self._monotonic = monotonic
        self._max_scan_rows = max_scan_rows
        self._max_gap_records = max_gap_records
        self._max_warmup_bars = max_warmup_bars
        self._max_horizon_ms = max_horizon_days * 86_400_000
        self._max_dataset_rows = max_dataset_rows
        self._cache_ttl_seconds = cache_ttl_seconds
        self._max_cache_entries = max_cache_entries
        self._cache: OrderedDict[tuple[object, ...], _CacheRecord] = OrderedDict()
        self._lock = threading.RLock()
        self._diagnostics: dict[str, int | float | str | None] = {
            "cache_hits": 0,
            "cache_misses": 0,
            "builds": 0,
            "scan_calls": 0,
            "scanned_bars": 0,
            "last_build_ms": None,
            "last_source_fingerprint": None,
        }

    def build(
        self,
        *,
        warmup_bars: int,
        horizon_ms: int,
        quality_mode: QualityMode | str = QualityMode.EXACT,
    ) -> ReplayCatalogSnapshot:
        warmup = validate_counter(warmup_bars, field_name="warmup_bars")
        horizon = validate_counter(horizon_ms, field_name="horizon_ms")
        if warmup > self._max_warmup_bars:
            raise ReplayDomainError(
                ReplayErrorCode.NO_ELIGIBLE_WINDOW,
                f"warmup exceeds replay limit {self._max_warmup_bars}",
                details={"warmup_bars": warmup, "limit": self._max_warmup_bars},
            )
        if horizon < 1 or horizon > self._max_horizon_ms:
            raise ReplayDomainError(
                ReplayErrorCode.NO_ELIGIBLE_WINDOW,
                f"horizon must be between 1 and {self._max_horizon_ms} ms",
                details={"horizon_ms": horizon, "limit": self._max_horizon_ms},
            )
        try:
            quality = (
                quality_mode
                if isinstance(quality_mode, QualityMode)
                else QualityMode(quality_mode)
            )
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                f"unsupported quality_mode: {quality_mode}",
            ) from exc

        with self._lock:
            now_ms = validate_timestamp_ms(self._now_ms(), field_name="now_ms")
            summaries = self._load_series_summaries()
            native_by_identity = self._native_interval_snapshot(summaries)
            source_fingerprint = self._source_fingerprint(
                summaries,
                native_by_identity,
                now_ms=now_ms,
            )
            cache_key = (warmup, horizon, quality.value, source_fingerprint)
            cached = self._cache.get(cache_key)
            current_monotonic = self._monotonic()
            if (
                cached is not None
                and current_monotonic - cached.created_monotonic
                <= self._cache_ttl_seconds
            ):
                self._cache.move_to_end(cache_key)
                self._diagnostics["cache_hits"] = int(
                    self._diagnostics["cache_hits"] or 0
                ) + 1
                return cached.snapshot

            self._diagnostics["cache_misses"] = int(
                self._diagnostics["cache_misses"] or 0
            ) + 1
            build_started = self._monotonic()
            scan_calls_before = int(self._diagnostics["scan_calls"] or 0)
            scanned_before = int(self._diagnostics["scanned_bars"] or 0)
            entries = self._build_entries(
                summaries,
                native_by_identity,
                source_fingerprint=source_fingerprint,
                now_ms=now_ms,
                warmup_bars=warmup,
                horizon_ms=horizon,
            )
            epoch_payload = {
                "schema_version": CATALOG_SCHEMA_VERSION,
                "source_fingerprint": source_fingerprint,
                "warmup_bars": warmup,
                "horizon_ms": horizon,
                "quality_mode": quality.value,
                "entries": [entry.to_hash_dict() for entry in entries],
            }
            catalog_epoch = canonical_sha256(epoch_payload)
            finalized_entries = tuple(
                replace(entry, catalog_epoch=catalog_epoch) for entry in entries
            )
            snapshot = ReplayCatalogSnapshot(
                schema_version=CATALOG_SCHEMA_VERSION,
                source_fingerprint=source_fingerprint,
                catalog_epoch=catalog_epoch,
                generated_at_ms=now_ms,
                warmup_bars=warmup,
                horizon_ms=horizon,
                quality_mode=quality,
                entries=finalized_entries,
            )
            self._cache[cache_key] = _CacheRecord(current_monotonic, snapshot)
            self._cache.move_to_end(cache_key)
            while len(self._cache) > self._max_cache_entries:
                self._cache.popitem(last=False)
            self._diagnostics["builds"] = int(self._diagnostics["builds"] or 0) + 1
            self._diagnostics["last_build_ms"] = round(
                max(0.0, self._monotonic() - build_started) * 1000,
                3,
            )
            self._diagnostics["last_source_fingerprint"] = source_fingerprint
            self._diagnostics["last_build_scan_calls"] = (
                int(self._diagnostics["scan_calls"] or 0) - scan_calls_before
            )
            self._diagnostics["last_build_scanned_bars"] = (
                int(self._diagnostics["scanned_bars"] or 0) - scanned_before
            )
            return snapshot

    def select_random(
        self,
        entry: ReplayCatalogEntry,
        *,
        seed: int,
    ) -> EligibleWindow:
        if (
            isinstance(seed, bool)
            or not isinstance(seed, int)
            or seed < 0
            or seed > MAX_RANDOM_SEED
        ):
            raise ValueError(
                f"random seed must be an integer between 0 and {MAX_RANDOM_SEED}"
            )
        total = entry.eligible_window_count
        if total < 1:
            raise ReplayDomainError(
                ReplayErrorCode.NO_ELIGIBLE_WINDOW,
                f"no eligible replay window for {entry.identity.key}",
                details={"identity": entry.identity.to_dict()},
            )
        selected_index = self._stable_sample_index(
            seed=seed,
            catalog_epoch=entry.catalog_epoch,
            population_size=total,
        )
        for eligible_range in entry.eligible_ranges:
            if selected_index < eligible_range.count:
                return eligible_range.materialize(selected_index)
            selected_index -= eligible_range.count
        raise RuntimeError("eligible-window index mapping drifted")

    def select_manual(
        self,
        entry: ReplayCatalogEntry,
        *,
        start_ms: int,
    ) -> EligibleWindow:
        start = validate_timestamp_ms(start_ms, field_name="start_ms")
        if entry.selected_base_interval is None or entry.bounds is None:
            raise ReplayDomainError(
                ReplayErrorCode.NO_ELIGIBLE_WINDOW,
                f"no eligible replay base for {entry.identity.key}",
                details={"reason": "no_eligible_base_interval"},
            )
        interval_ms = parse_interval_ms(entry.selected_base_interval)
        if interval_ms is None or compute_bucket_start_ms(
            start,
            interval_ms,
            interval=entry.selected_base_interval,
        ) != start:
            self._raise_manual_start(entry, start, "start_not_aligned")
        for eligible_range in entry.eligible_ranges:
            if eligible_range.contains(start):
                return eligible_range.materialize(
                    (start - eligible_range.first_start_ms) // eligible_range.interval_ms
                )
        replay_bars = (
            entry.eligible_ranges[0].replay_bars
            if entry.eligible_ranges
            else 1
        )
        if start + (replay_bars - 1) * interval_ms > entry.bounds.latest_closed_open_ms:
            self._raise_manual_start(entry, start, "future_or_forming_horizon")
        self._raise_manual_start(
            entry,
            start,
            "intersects_gap_or_insufficient_context",
        )

    def diagnostics(self) -> dict[str, int | float | str | None]:
        with self._lock:
            return {
                **self._diagnostics,
                "cache_entries": len(self._cache),
                "max_cache_entries": self._max_cache_entries,
                "max_scan_rows": self._max_scan_rows,
            }

    def _load_series_summaries(self) -> list[dict[str, object]]:
        list_all = getattr(self._repository, "list_all_series", None)
        raw_summaries = (
            list_all(custom_only=False)
            if callable(list_all)
            else self._repository.list_series(custom_only=False)
        )
        summaries: list[dict[str, object]] = []
        for raw in raw_summaries:
            try:
                identity = ReplaySeriesIdentity(
                    str(raw["exchange"]),
                    str(raw["market_type"]),
                    str(raw["symbol"]),
                )
                interval = validate_identifier(raw["interval"], field_name="interval")
                earliest = validate_timestamp_ms(
                    raw["earliest_open_time"], field_name="earliest_open_time"
                )
                latest = validate_timestamp_ms(
                    raw["latest_open_time"], field_name="latest_open_time"
                )
                total_count = validate_counter(
                    raw["total_count"], field_name="total_count"
                )
            except (KeyError, TypeError, ValueError):
                continue
            if total_count < 1 or earliest > latest:
                continue
            summaries.append(
                {
                    **identity.to_dict(),
                    "interval": interval,
                    "earliest_open_time": earliest,
                    "latest_open_time": latest,
                    "total_count": total_count,
                }
            )
        return sorted(
            summaries,
            key=lambda item: (
                str(item["exchange"]),
                str(item["market_type"]),
                str(item["symbol"]),
                str(item["interval"]),
            ),
        )

    def _native_interval_snapshot(
        self,
        summaries: Sequence[Mapping[str, object]],
    ) -> dict[ReplaySeriesIdentity, tuple[str, ...]]:
        identities = {
            ReplaySeriesIdentity(
                str(item["exchange"]),
                str(item["market_type"]),
                str(item["symbol"]),
            )
            for item in summaries
        }
        result: dict[ReplaySeriesIdentity, tuple[str, ...]] = {}
        for identity in sorted(identities):
            try:
                candidates = self._native_intervals(identity)
            except Exception:
                candidates = ()
            result[identity] = tuple(
                sorted(
                    {
                        value
                        for value in candidates
                        if isinstance(value, str) and parse_interval_ms(value) is not None
                    },
                    key=lambda interval: (parse_interval_ms(interval) or 0, interval),
                )
            )
        return result

    def _source_fingerprint(
        self,
        summaries: Sequence[Mapping[str, object]],
        native_by_identity: Mapping[ReplaySeriesIdentity, tuple[str, ...]],
        *,
        now_ms: int,
    ) -> str:
        closed_boundaries = []
        for summary in summaries:
            interval = str(summary["interval"])
            closed_boundaries.append(
                {
                    "identity": {
                        "exchange": summary["exchange"],
                        "market_type": summary["market_type"],
                        "symbol": summary["symbol"],
                    },
                    "interval": interval,
                    "last_closed_open_ms": last_closed_bar_open_ms(now_ms, interval),
                }
            )
        return canonical_sha256(
            {
                "schema_version": "replay-catalog-source-fingerprint.v1",
                "series": list(summaries),
                "native_intervals": [
                    {
                        "identity": identity.to_dict(),
                        "intervals": list(native_by_identity[identity]),
                    }
                    for identity in sorted(native_by_identity)
                ],
                "closed_boundaries": closed_boundaries,
            }
        )

    def _build_entries(
        self,
        summaries: Sequence[Mapping[str, object]],
        native_by_identity: Mapping[ReplaySeriesIdentity, tuple[str, ...]],
        *,
        source_fingerprint: str,
        now_ms: int,
        warmup_bars: int,
        horizon_ms: int,
    ) -> tuple[ReplayCatalogEntry, ...]:
        grouped: dict[ReplaySeriesIdentity, dict[str, Mapping[str, object]]] = {}
        for summary in summaries:
            identity = ReplaySeriesIdentity(
                str(summary["exchange"]),
                str(summary["market_type"]),
                str(summary["symbol"]),
            )
            grouped.setdefault(identity, {})[str(summary["interval"])] = summary

        entries: list[ReplayCatalogEntry] = []
        for identity in sorted(grouped):
            by_interval = grouped[identity]
            native = set(native_by_identity.get(identity, ()))
            candidates = tuple(
                sorted(
                    (
                        interval
                        for interval in by_interval
                        if interval in native
                        and not is_ephemeral_interval(interval)
                        and parse_interval_ms(interval) is not None
                    ),
                    key=lambda interval: (parse_interval_ms(interval) or 0, interval),
                )
            )
            limitations: list[str] = []
            if not candidates:
                limitations.append("no_native_local_interval")
            selected: str | None = None
            selected_bounds: SeriesBounds | None = None
            selected_gaps = EMPTY_GAP_SUMMARY
            selected_ranges: tuple[EligibleWindowRange, ...] = ()
            for interval in candidates:
                try:
                    bounds, gaps, ranges = self._plan_interval(
                        identity,
                        interval,
                        now_ms=now_ms,
                        warmup_bars=warmup_bars,
                        horizon_ms=horizon_ms,
                    )
                except ReplayDomainError as exc:
                    reason = str(exc.details.get("reason", exc.code.value.lower()))
                    limitations.append(f"{interval}:{reason}")
                    continue
                if selected_bounds is None:
                    selected_bounds = bounds
                    selected_gaps = gaps
                if ranges:
                    selected = interval
                    selected_bounds = bounds
                    selected_gaps = gaps
                    selected_ranges = ranges
                    break
                limitations.append(f"{interval}:insufficient_contiguous_coverage")
            entries.append(
                ReplayCatalogEntry(
                    identity=identity,
                    base_intervals=candidates,
                    selected_base_interval=selected,
                    bounds=selected_bounds,
                    gap_summary=selected_gaps,
                    eligible_ranges=selected_ranges,
                    quality=(
                        DataFidelity.EXACT_BAR_COVERAGE
                        if selected is not None
                        else None
                    ),
                    source_fingerprint=source_fingerprint,
                    catalog_epoch="",
                    limitations=tuple(limitations),
                )
            )
        return tuple(entries)

    def _plan_interval(
        self,
        identity: ReplaySeriesIdentity,
        interval: str,
        *,
        now_ms: int,
        warmup_bars: int,
        horizon_ms: int,
    ) -> tuple[SeriesBounds, GapSummary, tuple[EligibleWindowRange, ...]]:
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0 or is_monthly_interval(interval):
            self._candidate_error("calendar_interval_not_supported_as_base")
        if horizon_ms % interval_ms != 0:
            self._candidate_error("horizon_not_aligned_to_interval")
        replay_bars = horizon_ms // interval_ms
        if replay_bars < 1:
            self._candidate_error("horizon_shorter_than_interval")
        if warmup_bars + replay_bars > self._max_dataset_rows:
            self._candidate_error("dataset_row_limit_exceeded")

        raw_bounds = self._repository.get_bounds(
            identity.symbol,
            interval,
            exchange=identity.exchange,
            market_type=identity.market_type,
        )
        try:
            earliest = validate_timestamp_ms(
                raw_bounds["earliest_open_time"], field_name="earliest_open_time"
            )
            latest_source = validate_timestamp_ms(
                raw_bounds["latest_open_time"], field_name="latest_open_time"
            )
            total_count = validate_counter(
                raw_bounds["total_count"], field_name="total_count"
            )
        except (KeyError, TypeError, ValueError) as exc:
            self._candidate_error("invalid_source_bounds", cause=exc)
        if total_count < 1 or earliest > latest_source:
            self._candidate_error("empty_source_bounds")
        if (
            compute_bucket_start_ms(earliest, interval_ms, interval=interval) != earliest
            or compute_bucket_start_ms(
                latest_source,
                interval_ms,
                interval=interval,
            )
            != latest_source
        ):
            self._candidate_error("interval_alignment_invalid")
        last_closed = last_closed_bar_open_ms(now_ms, interval)
        if last_closed is None or earliest > last_closed:
            self._candidate_error("no_closed_bars")
        latest_closed = min(latest_source, last_closed)
        bounds = SeriesBounds(earliest, latest_source, latest_closed, total_count)
        gap_summary = self._scan_gap_chunks(
            identity,
            interval,
            interval_ms=interval_ms,
            start_ms=earliest,
            end_ms=latest_closed,
        )
        if gap_summary.calendar_id not in {"", "crypto.24x7.utc"}:
            self._candidate_error("non_continuous_calendar_not_supported")
        ranges = self._eligible_ranges(
            interval,
            interval_ms=interval_ms,
            earliest_ms=earliest,
            latest_ms=latest_closed,
            gaps=gap_summary.gaps,
            warmup_bars=warmup_bars,
            replay_bars=replay_bars,
        )
        return bounds, gap_summary, ranges

    def _scan_gap_chunks(
        self,
        identity: ReplaySeriesIdentity,
        interval: str,
        *,
        interval_ms: int,
        start_ms: int,
        end_ms: int,
    ) -> GapSummary:
        gaps: list[GapRange] = []
        scanned_bars = 0
        scan_calls = 0
        calendar_id = ""
        chunk_start = start_ms
        while chunk_start <= end_ms:
            chunk_end = min(
                end_ms,
                chunk_start + (self._max_scan_rows - 1) * interval_ms,
            )
            result = self._repository.scan_gaps(
                identity.symbol,
                interval,
                start_ms=chunk_start,
                end_ms=chunk_end,
                exchange=identity.exchange,
                market_type=identity.market_type,
                limit=self._max_scan_rows,
            )
            scan_calls += 1
            self._diagnostics["scan_calls"] = int(
                self._diagnostics["scan_calls"] or 0
            ) + 1
            if result.get("error"):
                self._candidate_error(
                    "gap_scan_error",
                    details={"error": str(result["error"])},
                )
            if bool(result.get("truncated")):
                self._candidate_error("gap_scan_truncated")
            scanned = validate_counter(
                result.get("scanned_bars", 0), field_name="scanned_bars"
            )
            scanned_bars += scanned
            self._diagnostics["scanned_bars"] = int(
                self._diagnostics["scanned_bars"] or 0
            ) + scanned
            result_calendar = result.get("calendar_id")
            if isinstance(result_calendar, str) and result_calendar:
                if calendar_id and result_calendar != calendar_id:
                    self._candidate_error("calendar_identity_changed")
                calendar_id = result_calendar
            for raw_gap in result.get("gaps", []):
                if not isinstance(raw_gap, Mapping):
                    self._candidate_error("invalid_gap_payload")
                gap_start = validate_timestamp_ms(
                    raw_gap.get("start_ms"), field_name="gap.start_ms"
                )
                gap_end = validate_timestamp_ms(
                    raw_gap.get("end_ms"), field_name="gap.end_ms"
                )
                missing_bars = validate_counter(
                    raw_gap.get("missing_bars"), field_name="gap.missing_bars"
                )
                if gap_start > gap_end or missing_bars < 1:
                    self._candidate_error("invalid_gap_payload")
                gaps.append(
                    GapRange(
                        start_ms=max(start_ms, gap_start),
                        end_ms=min(end_ms, gap_end),
                        missing_bars=missing_bars,
                        reason=str(raw_gap.get("reason", "gap")),
                    )
                )
                if len(gaps) > self._max_gap_records:
                    self._candidate_error("gap_record_limit_exceeded")
            chunk_start = chunk_end + interval_ms
        merged = self._merge_gaps(gaps, interval_ms=interval_ms)
        return GapSummary(tuple(merged), scanned_bars, scan_calls, calendar_id)

    @staticmethod
    def _merge_gaps(gaps: Sequence[GapRange], *, interval_ms: int) -> list[GapRange]:
        merged: list[GapRange] = []
        for gap in sorted(gaps):
            if not merged or gap.start_ms > merged[-1].end_ms + interval_ms:
                merged.append(gap)
                continue
            previous = merged[-1]
            end_ms = max(previous.end_ms, gap.end_ms)
            merged[-1] = GapRange(
                start_ms=previous.start_ms,
                end_ms=end_ms,
                missing_bars=((end_ms - previous.start_ms) // interval_ms) + 1,
                reason=(
                    previous.reason
                    if previous.reason == gap.reason
                    else "multiple_gap_reasons"
                ),
            )
        return merged

    @staticmethod
    def _eligible_ranges(
        interval: str,
        *,
        interval_ms: int,
        earliest_ms: int,
        latest_ms: int,
        gaps: Sequence[GapRange],
        warmup_bars: int,
        replay_bars: int,
    ) -> tuple[EligibleWindowRange, ...]:
        segments: list[tuple[int, int]] = []
        cursor = earliest_ms
        for gap in gaps:
            segment_end = gap.start_ms - interval_ms
            if cursor <= segment_end:
                segments.append((cursor, segment_end))
            cursor = max(cursor, gap.end_ms + interval_ms)
        if cursor <= latest_ms:
            segments.append((cursor, latest_ms))

        ranges: list[EligibleWindowRange] = []
        for segment_start, segment_end in segments:
            first_start = segment_start + warmup_bars * interval_ms
            last_start = segment_end - (replay_bars - 1) * interval_ms
            if first_start > last_start:
                continue
            count = ((last_start - first_start) // interval_ms) + 1
            ranges.append(
                EligibleWindowRange(
                    interval=interval,
                    interval_ms=interval_ms,
                    first_start_ms=first_start,
                    last_start_ms=last_start,
                    count=count,
                    warmup_bars=warmup_bars,
                    replay_bars=replay_bars,
                )
            )
        return tuple(ranges)

    @staticmethod
    def _stable_sample_index(
        *,
        seed: int,
        catalog_epoch: str,
        population_size: int,
    ) -> int:
        modulus = 1 << 256
        acceptance_limit = modulus - (modulus % population_size)
        counter = 0
        while True:
            material = (
                f"{CATALOG_SAMPLE_SCHEMA_VERSION}\0{catalog_epoch}\0{seed}\0{counter}"
            ).encode("utf-8")
            candidate = int.from_bytes(hashlib.sha256(material).digest(), "big")
            if candidate < acceptance_limit:
                return candidate % population_size
            counter += 1

    @staticmethod
    def _raise_manual_start(
        entry: ReplayCatalogEntry,
        start_ms: int,
        reason: str,
    ) -> None:
        raise ReplayDomainError(
            ReplayErrorCode.NO_ELIGIBLE_WINDOW,
            f"manual replay start is not eligible: {reason}",
            details={
                "reason": reason,
                "requested_start_ms": start_ms,
                "identity": entry.identity.to_dict(),
                "interval": entry.selected_base_interval,
            },
        )

    @staticmethod
    def _candidate_error(
        reason: str,
        *,
        cause: Exception | None = None,
        details: Mapping[str, object] | None = None,
    ) -> None:
        error = ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            f"catalog candidate rejected: {reason}",
            details={"reason": reason, **dict(details or {})},
        )
        if cause is not None:
            raise error from cause
        raise error
