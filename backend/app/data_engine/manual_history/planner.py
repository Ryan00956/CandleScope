"""Read-only expansion of manual-history targets and storage risk."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from app.core.config import (
    HISTORY_ARCHIVE_ENABLED,
    MANUAL_HISTORY_MAX_TARGETS,
    MANUAL_HISTORY_PLAN_TTL_SECONDS,
)
from app.data_engine.interval_policy import (
    compute_bucket_start_ms,
    intervals_equivalent,
    last_closed_bar_open_ms,
    parse_interval_ms,
    parse_interval_spec,
)
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolver,
    IntervalRouteKind,
)
from app.exchanges.symbols import normalize_symbol

PLANNER_VERSION = "manual-history.planner.v1"
DEFAULT_MEASURED_BYTES_PER_ROW = 232.711
REST_PAGE_BARS = 1_000
ARCHIVE_MIN_REST_PAGES = 3


class PlanErrorCode(str):
    FEATURE_FLAG_DISABLED = "feature_flag_disabled"
    INVALID_SELECTION = "invalid_selection"
    TOO_MANY_TARGETS = "too_many_targets"
    INTERVAL_UNROUTABLE = "interval_unroutable"
    START_IN_FUTURE = "start_in_future"
    START_AFTER_LAST_CLOSED = "start_after_last_closed"
    STORAGE_CONFLICT = "storage_conflict"
    ESTIMATE_UNAVAILABLE = "estimate_unavailable"


@dataclass(frozen=True, slots=True)
class PlannedTarget:
    symbol: str
    requested_interval: str
    canonical_interval: str
    route_kind: str
    source_interval: str
    effective_start_ms: int
    initial_end_open_ms: int
    source_strategy: str
    estimated_target_rows: int | None
    estimated_source_rows: int | None
    existing_coverage: str
    error: str | None = None
    boundary_reason: str | None = None


@dataclass(frozen=True, slots=True)
class SourceDemand:
    exchange: str
    market_type: str
    symbol: str
    source_interval: str
    start_ms: int
    end_open_ms: int


BoundsFn = Callable[..., Mapping[str, Any]]
DiskFn = Callable[[], Mapping[str, Any]]
ClockFn = Callable[[], int]


class ManualHistoryPlanner:
    """Pure planning over resolver/calendar/storage snapshots.  No writes."""

    def __init__(
        self,
        *,
        resolver: IntervalResolver | None = None,
        clock_ms: ClockFn | None = None,
        get_bounds: BoundsFn | None = None,
        disk_snapshot: DiskFn | None = None,
        sqlite_budget_bytes: int | None = None,
        reserved_bytes: int = 0,
        measured_bytes_per_row: float | None = DEFAULT_MEASURED_BYTES_PER_ROW,
        archive_enabled: bool | None = None,
        max_targets: int | None = None,
        plan_ttl_seconds: int | None = None,
        feature_enabled: bool = True,
        normalize_symbol_fn: Callable[..., str] | None = None,
    ) -> None:
        self._resolver = resolver or IntervalResolver()
        self._clock_ms = clock_ms
        self._get_bounds = get_bounds
        self._disk_snapshot = disk_snapshot
        self._sqlite_budget_bytes = sqlite_budget_bytes
        self._reserved_bytes = max(0, int(reserved_bytes))
        self._measured_bytes_per_row = measured_bytes_per_row
        self._archive_enabled = (
            HISTORY_ARCHIVE_ENABLED if archive_enabled is None else bool(archive_enabled)
        )
        self._max_targets = int(max_targets or MANUAL_HISTORY_MAX_TARGETS)
        self._plan_ttl_ms = int(plan_ttl_seconds or MANUAL_HISTORY_PLAN_TTL_SECONDS) * 1000
        self._feature_enabled = bool(feature_enabled)
        self._normalize_symbol = normalize_symbol_fn

    def plan(
        self,
        *,
        exchange: str,
        market_type: str,
        symbols: Sequence[str],
        intervals: Sequence[str],
        start_ms: int,
        now_ms: int | None = None,
    ) -> dict[str, Any]:
        captured_at_ms = int(now_ms if now_ms is not None else self._now_ms())
        blocking: list[str] = []
        warnings: list[str] = []
        normalized_exchange = str(exchange or "").strip().lower() or "binance"
        market_value = str(market_type or "spot").strip().lower()
        if market_value in {"futures", "perpetual", "perp", "usdt-m"}:
            normalized_market = "futures"
        elif market_value in {"spot", ""}:
            normalized_market = "spot"
        else:
            normalized_market = market_value
            blocking.append(PlanErrorCode.INVALID_SELECTION)

        normalized_symbols = self._normalize_symbols(
            symbols, exchange=normalized_exchange, market_type=normalized_market
        )
        normalized_intervals = self._dedupe_intervals(intervals)
        if not normalized_symbols or not normalized_intervals or int(start_ms) < 0:
            blocking.append(PlanErrorCode.INVALID_SELECTION)

        cartesian = len(normalized_symbols) * len(normalized_intervals)
        if cartesian > self._max_targets:
            blocking.append(PlanErrorCode.TOO_MANY_TARGETS)

        if int(start_ms) > captured_at_ms:
            blocking.append(PlanErrorCode.START_IN_FUTURE)

        targets: list[PlannedTarget] = []
        source_demands: dict[tuple[str, str, str, str], SourceDemand] = {}
        if PlanErrorCode.INVALID_SELECTION not in blocking:
            for symbol in normalized_symbols:
                for interval in normalized_intervals:
                    target = self._plan_target(
                        exchange=normalized_exchange,
                        market_type=normalized_market,
                        symbol=symbol,
                        interval=interval,
                        requested_start_ms=int(start_ms),
                        captured_at_ms=captured_at_ms,
                    )
                    targets.append(target)
                    if target.error:
                        blocking.append(target.error)
                        continue
                    target_width = parse_interval_ms(target.canonical_interval) or 0
                    source_width = parse_interval_ms(target.source_interval) or target_width
                    source_end_open_ms = int(target.initial_end_open_ms)
                    if (
                        target.route_kind == "DERIVED"
                        and target_width > source_width > 0
                    ):
                        source_end_open_ms += target_width - source_width
                    source_last_closed = last_closed_bar_open_ms(
                        captured_at_ms,
                        target.source_interval,
                    )
                    if source_last_closed is not None:
                        source_end_open_ms = min(source_end_open_ms, source_last_closed)
                    demand_key = (
                        normalized_exchange,
                        normalized_market,
                        symbol,
                        target.source_interval,
                    )
                    existing = source_demands.get(demand_key)
                    if existing is None:
                        source_demands[demand_key] = SourceDemand(
                            exchange=normalized_exchange,
                            market_type=normalized_market,
                            symbol=symbol,
                            source_interval=target.source_interval,
                            start_ms=target.effective_start_ms,
                            end_open_ms=source_end_open_ms,
                        )
                    else:
                        source_demands[demand_key] = SourceDemand(
                            exchange=existing.exchange,
                            market_type=existing.market_type,
                            symbol=existing.symbol,
                            source_interval=existing.source_interval,
                            start_ms=min(existing.start_ms, target.effective_start_ms),
                            end_open_ms=max(existing.end_open_ms, source_end_open_ms),
                        )

        unique_blocking = list(dict.fromkeys(blocking))
        storage = self._storage_estimate(
            targets=targets,
            source_demands=tuple(source_demands.values()),
            captured_at_ms=captured_at_ms,
        )
        if storage.get("blocking_reasons"):
            unique_blocking.extend(
                reason for reason in storage["blocking_reasons"]
                if reason not in unique_blocking
            )
        if not self._feature_enabled:
            unique_blocking.append(PlanErrorCode.FEATURE_FLAG_DISABLED)

        can_start = not unique_blocking
        selection = {
            "exchange": normalized_exchange,
            "market_type": normalized_market,
            "symbols": normalized_symbols,
            "intervals": normalized_intervals,
            "requested_start_ms": int(start_ms),
            "target_count": len(targets),
        }
        hash_payload = {
            "planner_version": PLANNER_VERSION,
            "selection": selection,
            "routes": [
                {
                    "symbol": target.symbol,
                    "canonical_interval": target.canonical_interval,
                    "route_kind": target.route_kind,
                    "source_interval": target.source_interval,
                    "effective_start_ms": target.effective_start_ms,
                }
                for target in targets
            ],
            "archive_enabled": self._archive_enabled,
            "max_targets": self._max_targets,
        }
        plan_hash = "sha256:" + hashlib.sha256(
            json.dumps(hash_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return {
            "status": "ok",
            "can_start": can_start,
            "plan_hash": plan_hash,
            "captured_at_ms": captured_at_ms,
            "expires_at_ms": captured_at_ms + self._plan_ttl_ms,
            "planner_version": PLANNER_VERSION,
            "selection": selection,
            "targets": [self._target_dict(target) for target in targets],
            "source_demands": [
                {
                    "exchange": demand.exchange,
                    "market_type": demand.market_type,
                    "symbol": demand.symbol,
                    "source_interval": demand.source_interval,
                    "start_ms": demand.start_ms,
                    "end_open_ms": demand.end_open_ms,
                }
                for demand in source_demands.values()
            ],
            "storage": storage,
            "blocking_reasons": unique_blocking,
            "warnings": warnings,
        }

    def _now_ms(self) -> int:
        if self._clock_ms is not None:
            return int(self._clock_ms())
        import time

        return int(time.time() * 1000)

    def _normalize_symbols(
        self,
        symbols: Sequence[str],
        *,
        exchange: str,
        market_type: str,
    ) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for symbol in symbols or []:
            value = self._normalize_one(symbol, exchange=exchange, market_type=market_type)
            if not value or value in seen:
                continue
            seen.add(value)
            normalized.append(value)
        return sorted(normalized)

    def _dedupe_intervals(self, intervals: Sequence[str]) -> list[str]:
        unique: list[str] = []
        for interval in intervals or []:
            spec = parse_interval_spec(interval)
            if spec is None:
                unique.append(str(interval).strip())
                continue
            if any(intervals_equivalent(existing, spec.canonical) for existing in unique):
                continue
            unique.append(spec.canonical)
        return sorted(unique)

    def _normalize_one(self, symbol: str, *, exchange: str, market_type: str) -> str:
        if self._normalize_symbol is not None:
            return str(self._normalize_symbol(
                symbol, exchange=exchange, market_type=market_type
            ) or "").strip()
        try:
            return normalize_symbol(symbol, exchange=exchange, market_type=market_type)
        except Exception:
            raw = str(symbol or "").strip()
            return raw.replace("-", "").upper() if raw else ""

    def _plan_target(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        requested_start_ms: int,
        captured_at_ms: int,
    ) -> PlannedTarget:
        try:
            route = self._resolver.resolve(
                exchange=exchange,
                market_type=market_type,
                interval=interval,
                purpose=IntervalPurpose.HISTORY,
            )
        except IntervalResolutionError as exc:
            return PlannedTarget(
                symbol=symbol,
                requested_interval=interval,
                canonical_interval=interval,
                route_kind="UNROUTABLE",
                source_interval=interval,
                effective_start_ms=requested_start_ms,
                initial_end_open_ms=requested_start_ms,
                source_strategy="UNAVAILABLE",
                estimated_target_rows=None,
                estimated_source_rows=None,
                existing_coverage="UNKNOWN",
                error=(
                    PlanErrorCode.INTERVAL_UNROUTABLE
                    if exc.code.value != "no_exact_base"
                    else PlanErrorCode.INTERVAL_UNROUTABLE
                ),
            )

        width_ms = parse_interval_ms(route.canonical_interval) or 0
        spec = parse_interval_spec(route.canonical_interval)
        if spec is not None:
            aligned = spec.floor_ms(int(requested_start_ms))
            if aligned < int(requested_start_ms):
                aligned = spec.next_ms(aligned)
        else:
            aligned = compute_bucket_start_ms(
                requested_start_ms,
                width_ms or 1,
                interval=route.canonical_interval,
            )
            if aligned < requested_start_ms and width_ms:
                aligned += width_ms
        last_closed = last_closed_bar_open_ms(captured_at_ms, route.canonical_interval)
        error = None
        if last_closed is None or aligned > last_closed:
            error = PlanErrorCode.START_AFTER_LAST_CLOSED
        source_width = parse_interval_ms(route.source_interval) or width_ms
        target_rows = None
        source_rows = None
        if error is None and last_closed is not None and width_ms > 0:
            target_rows = max(0, ((last_closed - aligned) // width_ms) + 1)
            if source_width:
                source_end = int(last_closed)
                if route.kind is not IntervalRouteKind.NATIVE and width_ms > source_width:
                    source_end += width_ms - source_width
                source_last_closed = last_closed_bar_open_ms(
                    captured_at_ms,
                    route.source_interval,
                )
                if source_last_closed is not None:
                    source_end = min(source_end, source_last_closed)
                source_rows = max(0, ((source_end - aligned) // source_width) + 1)
        strategy = "REST"
        if error is None and self._archive_enabled and (source_rows or 0) >= REST_PAGE_BARS * ARCHIVE_MIN_REST_PAGES:
            strategy = "ARCHIVE_PREFERRED_WITH_REST_TAIL"
        elif not self._archive_enabled:
            strategy = "REST"
        coverage = self._existing_coverage(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=route.canonical_interval,
            effective_start_ms=aligned,
            initial_end_open_ms=last_closed or aligned,
        )
        return PlannedTarget(
            symbol=symbol,
            requested_interval=interval,
            canonical_interval=route.canonical_interval,
            route_kind=(
                "NATIVE" if route.kind is IntervalRouteKind.NATIVE else "DERIVED"
            ),
            source_interval=route.source_interval,
            effective_start_ms=aligned,
            initial_end_open_ms=int(last_closed or aligned),
            source_strategy=strategy,
            estimated_target_rows=target_rows,
            estimated_source_rows=source_rows,
            existing_coverage=coverage,
            error=error,
        )

    def _existing_coverage(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        effective_start_ms: int,
        initial_end_open_ms: int,
    ) -> str:
        if self._get_bounds is None:
            return "UNKNOWN"
        bounds = self._get_bounds(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        earliest = bounds.get("earliest_open_time")
        latest = bounds.get("latest_open_time")
        count = int(bounds.get("total_count", 0) or 0)
        if count <= 0 or earliest is None or latest is None:
            return "NONE"
        if int(earliest) <= effective_start_ms and int(latest) >= initial_end_open_ms:
            return "FULL"
        return "PARTIAL"

    def _storage_estimate(
        self,
        *,
        targets: Sequence[PlannedTarget],
        source_demands: Sequence[SourceDemand],
        captured_at_ms: int,
    ) -> dict[str, Any]:
        disk = self._disk_snapshot() if self._disk_snapshot is not None else {}
        physical = int(disk.get("physical_size_bytes") or disk.get("used_bytes") or 0)
        disk_free = disk.get("free_bytes")
        bytes_per_row = self._measured_bytes_per_row
        row_sum = 0
        known = True
        for demand in source_demands:
            source_width = parse_interval_ms(demand.source_interval)
            if source_width is None or source_width <= 0:
                known = False
                continue
            row_sum += max(0, ((demand.end_open_ms - demand.start_ms) // source_width) + 1)
        for target in targets:
            if target.route_kind != "DERIVED":
                continue
            if target.estimated_target_rows is None:
                known = False
                continue
            row_sum += int(target.estimated_target_rows)
        if bytes_per_row is None or bytes_per_row <= 0:
            growth = None
            confidence = "LOW"
        elif not known:
            growth = None
            confidence = "LOW"
        else:
            growth = int(row_sum * float(bytes_per_row))
            confidence = "MEDIUM"
        blocking: list[str] = []
        budget = self._sqlite_budget_bytes
        if (
            budget is not None
            and growth is not None
            and physical + growth + self._reserved_bytes > int(budget)
        ):
            blocking.append(PlanErrorCode.STORAGE_CONFLICT)
        if disk_free is not None and growth is not None:
            if int(disk_free) < growth + self._reserved_bytes:
                blocking.append(PlanErrorCode.STORAGE_CONFLICT)
        return {
            "sqlite_budget_bytes": budget,
            "physical_size_bytes": physical,
            "estimated_db_growth_bytes": growth,
            "estimated_temp_bytes": None if growth is None else int(growth * 0.15),
            "estimate_confidence": confidence,
            "disk_free_bytes": disk_free,
            "reserved_bytes": self._reserved_bytes,
            "measured_bytes_per_row": bytes_per_row,
            "blocking_reasons": blocking,
            "warnings": [],
            "captured_at_ms": captured_at_ms,
        }

    @staticmethod
    def _target_dict(target: PlannedTarget) -> dict[str, Any]:
        return {
            "symbol": target.symbol,
            "requested_interval": target.requested_interval,
            "canonical_interval": target.canonical_interval,
            "route_kind": target.route_kind,
            "source_interval": target.source_interval,
            "effective_start_ms": target.effective_start_ms,
            "initial_end_open_ms": target.initial_end_open_ms,
            "source_strategy": target.source_strategy,
            "estimated_target_rows": target.estimated_target_rows,
            "estimated_source_rows": target.estimated_source_rows,
            "existing_coverage": target.existing_coverage,
            "error": target.error,
            "boundary_reason": target.boundary_reason,
        }
