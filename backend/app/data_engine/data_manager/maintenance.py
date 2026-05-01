"""Storage maintenance workflows for DataManager."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Iterable
from typing import Any, Protocol

from app.data_engine.bar_aggregator import BarAggregator, BarAggregatorConfig
from app.data_engine.interval_policy import (
    STANDARD_INTERVAL_MS,
    compute_bucket_close_ms,
    find_best_base_interval,
    parse_custom_interval,
    parse_interval_ms,
)

from .backfill_coordinator import RepairRequest
from .models import BarData

logger = logging.getLogger("data_manager.maintenance")

_STORAGE_ROW_FLOAT_FIELDS = (
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "taker_buy_base",
    "taker_buy_quote",
)
_STORAGE_ROW_INT_FIELDS = ("open_time", "close_time", "trades")
_STANDARD_INTERVALS = set(STANDARD_INTERVAL_MS) - {"1s", "1M"}


class MaintenanceBusyError(RuntimeError):
    """Raised when another storage maintenance task is already running."""


class MaintenanceUnavailableError(RuntimeError):
    """Raised when required maintenance dependencies are not available."""


class RepairRequester(Protocol):
    """Minimal repair coordinator contract used by maintenance workflows."""

    async def request_and_wait(self, request: RepairRequest) -> Any:
        ...


class MaintenanceService:
    """Owns manual storage repair and gap scan workflows."""

    def __init__(
        self,
        *,
        storage_provider: Callable[[], Any | None],
        aggregator_config_snapshot: Callable[[], dict],
        cache_invalidator: Callable[..., None],
        bars_backfilled: Callable[..., Awaitable[None]],
        active_targets: Callable[[], Iterable[tuple[str, str, str, str]]],
        seed_active_bar: Callable[..., Awaitable[None]],
    ) -> None:
        self._storage_provider = storage_provider
        self._aggregator_config_snapshot = aggregator_config_snapshot
        self._cache_invalidator = cache_invalidator
        self._bars_backfilled = bars_backfilled
        self._active_targets = active_targets
        self._seed_active_bar = seed_active_bar
        self._lock = asyncio.Lock()

    async def repair_custom_storage(
        self,
        *,
        symbols_filter: list[str] | None,
        backfill_coordinator: RepairRequester | None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> dict:
        """Check and rebuild stored custom-interval rows from base data."""
        storage = self._storage()
        self._require_backfill(backfill_coordinator)
        symbols_filter = list(symbols_filter or [])

        if self._lock.locked():
            raise MaintenanceBusyError("库修复任务正在运行，请稍后再试")

        async with self._lock:
            started_at_ms = int(time.time() * 1000)
            now_ms = started_at_ms
            aggregator_config = self._aggregator_config_snapshot()
            series = await asyncio.to_thread(
                self._list_custom_series,
                storage,
                market_type,
                exchange,
            )
            if symbols_filter:
                allowed = set(symbols_filter)
                series = [
                    item for item in series
                    if str(item.get("symbol", "")).upper() in allowed
                ]

            if not series:
                return {
                    "status": "warning",
                    "message": (
                        "指定范围内未发现已落库的自定义周期数据，无需修复"
                        if symbols_filter else
                        "未发现已落库的自定义周期数据，无需修复"
                    ),
                    "checked_series": 0,
                    "repaired_series": 0,
                    "unchanged_series": 0,
                    "failed_series": 0,
                    "total_deleted_rows": 0,
                    "total_written_rows": 0,
                    "total_stale_rows_removed": 0,
                    "base_backfill_runs": 0,
                    "elapsed_ms": int(time.time() * 1000) - started_at_ms,
                    "exchange": exchange,
                    "market_type": market_type,
                    "symbols_filter": symbols_filter,
                    "results": [],
                }

            results: list[dict] = []
            repaired_series = 0
            unchanged_series = 0
            failed_series = 0
            total_deleted_rows = 0
            total_written_rows = 0
            total_stale_rows_removed = 0
            base_backfill_runs = 0

            for item in series:
                symbol = str(item["symbol"]).upper()
                interval = str(item["interval"])
                custom_seconds = parse_custom_interval(interval)
                result = {
                    "exchange": exchange,
                    "symbol": symbol,
                    "interval": interval,
                    "market_type": market_type,
                    "existing_rows": int(item.get("total_count", 0) or 0),
                    "repaired_rows": 0,
                    "deleted_rows": 0,
                    "stale_rows_removed": 0,
                    "difference_rows": 0,
                    "base_interval": None,
                    "base_backfill_runs": 0,
                    "status": "checked",
                    "message": "",
                }

                if custom_seconds is None:
                    result["status"] = "failed"
                    result["message"] = "无法解析该自定义周期"
                    failed_series += 1
                    results.append(result)
                    continue

                custom_ms = custom_seconds * 1000
                earliest_open = int(item["earliest_open_time"])
                latest_open = int(item["latest_open_time"])
                existing_rows = await asyncio.to_thread(
                    storage.query_bars,
                    symbol=symbol,
                    interval=interval,
                    start_ms=earliest_open,
                    end_ms=latest_open,
                    order="ASC",
                    exchange=exchange,
                    market_type=market_type,
                )
                existing_rows = [_normalize_storage_row(row) for row in existing_rows]
                closed_existing = [
                    row for row in existing_rows
                    if _is_closed_bucket(int(row["open_time"]), custom_ms, now_ms, interval=interval)
                ]
                stale_existing = [
                    row for row in existing_rows
                    if not _is_closed_bucket(int(row["open_time"]), custom_ms, now_ms, interval=interval)
                ]
                result["stale_rows_removed"] = len(stale_existing)

                if not closed_existing:
                    if stale_existing:
                        deleted = await asyncio.to_thread(
                            storage.delete_bars,
                            symbol=symbol,
                            interval=interval,
                            start_ms=int(stale_existing[0]["open_time"]),
                            end_ms=int(stale_existing[-1]["open_time"]),
                            exchange=exchange,
                            market_type=market_type,
                        )
                        total_deleted_rows += deleted
                        total_stale_rows_removed += len(stale_existing)
                        repaired_series += 1
                        result["deleted_rows"] = deleted
                        result["status"] = "repaired"
                        result["message"] = "仅发现未封口尾部数据，已删除脏尾巴"
                        await self._warm_repaired_series(
                            storage,
                            symbol,
                            interval,
                            exchange=exchange,
                            market_type=market_type,
                        )
                    else:
                        unchanged_series += 1
                        result["message"] = "没有可修复的数据"
                    results.append(result)
                    continue

                repair_start_open = int(closed_existing[0]["open_time"])
                repair_end_open = int(closed_existing[-1]["open_time"])
                repair_end_close = compute_bucket_close_ms(
                    repair_end_open,
                    custom_ms,
                    interval=interval,
                )
                base_interval, _ = find_best_base_interval(custom_seconds, interval=interval)
                result["base_interval"] = base_interval

                base_ok, gap_runs, base_errors = await self._ensure_base_series_complete(
                    backfill_coordinator,
                    storage,
                    symbol,
                    base_interval,
                    repair_start_open,
                    repair_end_close,
                    metadata={
                        "origin": "settings_storage_repair",
                        "target_interval": interval,
                        "phase": "base_repair",
                    },
                    exchange=exchange,
                    market_type=market_type,
                )
                base_backfill_runs += gap_runs
                result["base_backfill_runs"] = gap_runs

                if not base_ok:
                    result["status"] = "failed"
                    result["message"] = "基础周期存在缺口，自动回补后仍未完全修复"
                    if base_errors:
                        result["errors"] = base_errors
                    failed_series += 1
                    results.append(result)
                    continue

                base_rows = await asyncio.to_thread(
                    storage.query_bars,
                    symbol=symbol,
                    interval=base_interval,
                    start_ms=repair_start_open,
                    end_ms=repair_end_close,
                    order="ASC",
                    exchange=exchange,
                    market_type=market_type,
                )
                if not base_rows:
                    result["status"] = "failed"
                    result["message"] = "基础周期数据为空，无法重建"
                    failed_series += 1
                    results.append(result)
                    continue

                rebuilt_rows = await _aggregate_custom_rows(
                    symbol=symbol,
                    custom_interval=interval,
                    base_interval=base_interval,
                    base_rows=base_rows,
                    aggregator_config=aggregator_config,
                    exchange=exchange,
                    market_type=market_type,
                )
                rebuilt_rows = [
                    row for row in rebuilt_rows
                    if repair_start_open <= int(row["open_time"]) <= repair_end_open
                    and _is_closed_bucket(int(row["open_time"]), custom_ms, now_ms, interval=interval)
                ]

                if not rebuilt_rows and closed_existing:
                    result["status"] = "failed"
                    result["message"] = "重建结果为空，已中止回写以避免误删原有数据"
                    failed_series += 1
                    results.append(result)
                    continue

                difference_rows = _count_row_differences(closed_existing, rebuilt_rows)
                result["difference_rows"] = difference_rows

                if difference_rows == 0 and not stale_existing:
                    unchanged_series += 1
                    result["message"] = "检查通过，库内容已正确"
                    results.append(result)
                    continue

                deleted = await asyncio.to_thread(
                    storage.delete_bars,
                    symbol=symbol,
                    interval=interval,
                    start_ms=earliest_open,
                    end_ms=latest_open,
                    exchange=exchange,
                    market_type=market_type,
                )
                written = 0
                if rebuilt_rows:
                    written = await asyncio.to_thread(
                        storage.upsert_bars,
                        symbol=symbol,
                        interval=interval,
                        rows=rebuilt_rows,
                        source="settings_manual_repair",
                        exchange=exchange,
                        market_type=market_type,
                    )

                total_deleted_rows += deleted
                total_written_rows += written
                total_stale_rows_removed += len(stale_existing)
                repaired_series += 1

                result["deleted_rows"] = deleted
                result["repaired_rows"] = written
                result["status"] = "repaired"
                result["message"] = "已按基础周期重建并回写自定义周期数据"

                await self._warm_repaired_series(
                    storage,
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                )
                results.append(result)

            if failed_series == 0:
                overall_status = "ok"
                message = "库检查完成"
            elif repaired_series > 0 or unchanged_series > 0:
                overall_status = "partial"
                message = "库检查完成，但仍有部分周期未修复"
            else:
                overall_status = "error"
                message = "库检查失败，未完成修复"

            return {
                "status": overall_status,
                "message": message,
                "checked_series": len(results),
                "repaired_series": repaired_series,
                "unchanged_series": unchanged_series,
                "failed_series": failed_series,
                "total_deleted_rows": total_deleted_rows,
                "total_written_rows": total_written_rows,
                "total_stale_rows_removed": total_stale_rows_removed,
                "base_backfill_runs": base_backfill_runs,
                "exchange": exchange,
                "market_type": market_type,
                "symbols_filter": symbols_filter,
                "elapsed_ms": int(time.time() * 1000) - started_at_ms,
                "results": results,
            }

    async def scan_and_fill_gaps(
        self,
        *,
        symbols_filter: list[str] | None,
        backfill_coordinator: RepairRequester | None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> dict:
        """Scan standard intervals for storage gaps and repair them."""
        storage = self._storage()
        self._require_backfill(backfill_coordinator)
        symbols_filter = list(symbols_filter or [])

        if self._lock.locked():
            raise MaintenanceBusyError("修复任务正在运行，请稍后再试")

        async with self._lock:
            started_at_ms = int(time.time() * 1000)
            now_ms = started_at_ms

            series = await asyncio.to_thread(storage.list_series, False, exchange, market_type)
            standard_series = [
                item for item in series
                if str(item.get("interval", "")) in _STANDARD_INTERVALS
            ]
            if symbols_filter:
                allowed = set(symbols_filter)
                standard_series = [
                    item for item in standard_series
                    if str(item.get("symbol", "")).upper() in allowed
                ]

            results = []
            total_bars_filled = 0
            gaps_found = 0
            gaps_filled = 0

            for item in standard_series:
                symbol = str(item["symbol"]).upper()
                interval = str(item["interval"])
                try:
                    latest = item.get("latest_open_time")
                    total_count = item.get("total_count", 0)
                    if not latest or not total_count:
                        continue

                    interval_ms = parse_interval_ms(interval) or 60_000
                    gap_ms = now_ms - latest

                    entry = {
                        "exchange": exchange,
                        "symbol": symbol,
                        "interval": interval,
                        "market_type": market_type,
                        "total_bars": total_count,
                        "latest_data": time.strftime(
                            "%Y-%m-%d %H:%M",
                            time.localtime(latest / 1000),
                        ),
                        "gap_hours": round(gap_ms / 3_600_000, 1),
                        "bars_filled": 0,
                        "status": "ok",
                        "message": "",
                    }

                    if gap_ms > interval_ms * 3:
                        gaps_found += 1
                        entry["status"] = "gap_found"
                        entry["message"] = f"尾部缺口 {entry['gap_hours']}h"

                        outcome = await backfill_coordinator.request_and_wait(RepairRequest(
                            symbol=symbol,
                            interval=interval,
                            start_ms=int(latest),
                            end_ms=now_ms,
                            exchange=exchange,
                            market_type=market_type,
                            reason="settings_tail_gap_scan",
                            metadata={"origin": "settings_gap_scan", "gap_type": "tail"},
                        ))
                        bars_written = _outcome_bars_written(outcome)

                        if _outcome_failed(outcome):
                            errors = _outcome_errors(outcome)
                            entry["status"] = "error"
                            entry["message"] = (
                                "回补失败: " + "; ".join(errors)
                                if errors else
                                "回补失败"
                            )
                        elif bars_written > 0:
                            entry["bars_filled"] = bars_written
                            entry["status"] = "filled"
                            entry["message"] = f"已补 {bars_written} 条"
                            total_bars_filled += bars_written
                            gaps_filled += 1
                        else:
                            entry["message"] = "尝试回补但无新数据（可能是网络问题）"

                    rows = await asyncio.to_thread(
                        storage.query_bars,
                        symbol=symbol,
                        interval=interval,
                        limit=2000,
                        order="DESC",
                        exchange=exchange,
                        market_type=market_type,
                    )
                    if len(rows) >= 2:
                        times = sorted([int(row["open_time"]) for row in rows])
                        threshold = interval_ms * 1.5
                        interior_gaps = []
                        for idx in range(1, len(times)):
                            diff = times[idx] - times[idx - 1]
                            if diff > threshold:
                                interior_gaps.append((times[idx - 1], times[idx], diff))

                        if interior_gaps:
                            gaps_found += len(interior_gaps)
                            gap_errors: list[str] = []
                            for gap_start, gap_end, _gap_diff in interior_gaps:
                                missing_start = int(gap_start) + interval_ms
                                missing_end = int(gap_end) - interval_ms
                                if missing_start > missing_end:
                                    continue
                                outcome = await backfill_coordinator.request_and_wait(RepairRequest(
                                    symbol=symbol,
                                    interval=interval,
                                    start_ms=missing_start,
                                    end_ms=missing_end,
                                    exchange=exchange,
                                    market_type=market_type,
                                    reason="settings_interior_gap_scan",
                                    metadata={
                                        "origin": "settings_gap_scan",
                                        "gap_type": "interior",
                                    },
                                ))
                                if _outcome_failed(outcome):
                                    gap_errors.extend(_outcome_errors(outcome))
                                    continue

                                gap_bars = _outcome_bars_written(outcome)
                                if gap_bars > 0:
                                    total_bars_filled += gap_bars
                                    gaps_filled += 1
                                    entry["bars_filled"] += gap_bars

                            if entry["bars_filled"] > 0:
                                entry["status"] = "filled"
                                gap_desc = f"{len(interior_gaps)} 个内部缺口"
                                if entry["message"]:
                                    entry["message"] += f" + {gap_desc}"
                                else:
                                    entry["message"] = (
                                        f"发现并修复 {gap_desc}，已补 {entry['bars_filled']} 条"
                                    )
                            elif entry["status"] == "ok":
                                entry["status"] = "gap_found"
                                entry["message"] = (
                                    f"发现 {len(interior_gaps)} 个内部缺口但无法补回: "
                                    + "; ".join(gap_errors)
                                    if gap_errors else
                                    f"发现 {len(interior_gaps)} 个内部缺口但无法补回"
                                )

                    if entry["status"] == "ok":
                        entry["message"] = "数据完整 ✓"

                    results.append(entry)

                except Exception as exc:
                    results.append({
                        "exchange": exchange,
                        "symbol": symbol,
                        "interval": interval,
                        "market_type": market_type,
                        "total_bars": 0,
                        "latest_data": "",
                        "gap_hours": 0,
                        "bars_filled": 0,
                        "status": "error",
                        "message": f"检查失败: {exc}",
                    })

            elapsed_ms = int(time.time() * 1000) - started_at_ms

            if gaps_found == 0:
                status = "ok"
                message = "所有周期数据完整，无缺口 ✓"
            elif gaps_filled == gaps_found:
                status = "ok"
                message = f"发现 {gaps_found} 个缺口，全部已修复 ✓"
            elif gaps_filled > 0:
                status = "partial"
                message = (
                    f"发现 {gaps_found} 个缺口，修复 {gaps_filled} 个，"
                    f"{gaps_found - gaps_filled} 个未修复"
                )
            else:
                status = "error"
                message = f"发现 {gaps_found} 个缺口，均未能修复"

            return {
                "status": status,
                "message": message,
                "exchange": exchange,
                "market_type": market_type,
                "symbols_filter": symbols_filter,
                "scanned_series": len(results),
                "gaps_found": gaps_found,
                "gaps_filled": gaps_filled,
                "total_bars_filled": total_bars_filled,
                "elapsed_ms": elapsed_ms,
                "results": results,
            }

    async def delete_storage_data(
        self,
        *,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> int:
        """Delete stored bars for a series through the configured storage backend."""
        storage = self._storage()
        deleted = await asyncio.to_thread(
            storage.delete_bars,
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
        )
        self._cache_invalidator(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        return int(deleted or 0)

    def _storage(self) -> Any:
        storage = self._storage_provider()
        if storage is None:
            raise MaintenanceUnavailableError("Storage backend 尚未初始化")
        return storage

    @staticmethod
    def _require_backfill(backfill_coordinator: RepairRequester | None) -> None:
        if backfill_coordinator is None:
            raise MaintenanceUnavailableError("BackfillCoordinator 尚未初始化")

    @staticmethod
    def _list_custom_series(
        storage: Any,
        market_type: str = "spot",
        exchange: str = "binance",
    ) -> list[dict]:
        if storage is not None and hasattr(storage, "list_series"):
            return storage.list_series(custom_only=True, exchange=exchange, market_type=market_type)
        from app.data_engine.storage.klines_repo import list_series_summaries
        return list_series_summaries(custom_only=True, exchange=exchange, market_type=market_type)

    async def _ensure_base_series_complete(
        self,
        backfill_coordinator: RepairRequester,
        storage: Any,
        symbol: str,
        base_interval: str,
        start_ms: int,
        end_ms: int,
        metadata: dict,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> tuple[bool, int, list[str]]:
        gap_runs = 0
        errors: list[str] = []

        gaps = await _find_storage_gap_ranges(
            storage,
            symbol,
            base_interval,
            start_ms,
            end_ms,
            exchange=exchange,
            market_type=market_type,
        )
        if not gaps:
            return True, gap_runs, errors

        gap_runs += 1
        outcome = await backfill_coordinator.request_and_wait(RepairRequest(
            symbol=symbol,
            interval=base_interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
            reason="settings_base_gap_repair",
            metadata=metadata,
        ))
        if _outcome_failed(outcome):
            errors.extend(_outcome_errors(outcome))

        remaining = await _find_storage_gap_ranges(
            storage,
            symbol,
            base_interval,
            start_ms,
            end_ms,
            exchange=exchange,
            market_type=market_type,
        )
        if remaining:
            errors.append(f"{len(remaining)} base gap(s) remain after repair")
            return False, gap_runs, errors

        return True, gap_runs, errors

    async def _warm_repaired_series(
        self,
        storage: Any,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        symbol = symbol.upper()
        self._cache_invalidator(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )

        rows = await asyncio.to_thread(
            storage.query_bars,
            symbol=symbol,
            interval=interval,
            limit=500,
            order="DESC",
            exchange=exchange,
            market_type=market_type,
        )
        if rows:
            bars = [BarData.from_storage_row(row) for row in reversed(rows)]
            await self._bars_backfilled(
                symbol,
                interval,
                bars,
                exchange=exchange,
                market_type=market_type,
            )

        if (exchange, market_type, symbol, interval) in set(self._active_targets()):
            try:
                await self._seed_active_bar(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    had_stream=True,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to reseed repaired custom tail for %s:%s:%s@%s: %s",
                    exchange,
                    market_type,
                    symbol,
                    interval,
                    exc,
                )


def _normalize_storage_row(row: dict) -> dict:
    normalized: dict[str, int | float] = {}
    for field in _STORAGE_ROW_INT_FIELDS:
        normalized[field] = int(row.get(field, 0) or 0)
    for field in _STORAGE_ROW_FLOAT_FIELDS:
        normalized[field] = float(row.get(field, 0) or 0.0)
    return normalized


def _rows_match(left: dict, right: dict, tol: float = 1e-8) -> bool:
    for field in _STORAGE_ROW_INT_FIELDS:
        if int(left.get(field, 0)) != int(right.get(field, 0)):
            return False
    for field in _STORAGE_ROW_FLOAT_FIELDS:
        if abs(float(left.get(field, 0.0)) - float(right.get(field, 0.0))) > tol:
            return False
    return True


def _count_row_differences(existing_rows: list[dict], rebuilt_rows: list[dict]) -> int:
    existing_map = {int(row["open_time"]): _normalize_storage_row(row) for row in existing_rows}
    rebuilt_map = {int(row["open_time"]): _normalize_storage_row(row) for row in rebuilt_rows}
    differences = 0

    for open_time in sorted(set(existing_map) | set(rebuilt_map)):
        left = existing_map.get(open_time)
        right = rebuilt_map.get(open_time)
        if left is None or right is None:
            differences += 1
            continue
        if not _rows_match(left, right):
            differences += 1
    return differences


def _is_closed_bucket(
    open_time_ms: int,
    interval_ms: int,
    now_ms: int,
    *,
    interval: str | None = None,
) -> bool:
    return compute_bucket_close_ms(open_time_ms, interval_ms, interval=interval) < now_ms


def _status_value(status: Any) -> str:
    return getattr(status, "value", str(status))


def _outcome_failed(outcome: Any) -> bool:
    return _status_value(getattr(outcome, "status", "failed")) == "failed"


def _outcome_bars_written(outcome: Any) -> int:
    report = getattr(outcome, "report", None)
    reconcile_result = getattr(report, "reconcile_result", None)
    return int(getattr(reconcile_result, "bars_written", 0) or 0)


def _outcome_errors(outcome: Any) -> list[str]:
    errors: list[str] = []
    report = getattr(outcome, "report", None)
    errors.extend(str(err) for err in getattr(report, "errors", []) or [])
    error = getattr(outcome, "error", None)
    if error:
        errors.append(str(error))
    return errors


async def _find_storage_gap_ranges(
    storage: Any,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    exchange: str = "binance",
    market_type: str = "spot",
) -> list[tuple[int, int]]:
    interval_ms = parse_interval_ms(interval) or 60_000
    rows = await asyncio.to_thread(
        storage.query_bars,
        symbol=symbol,
        interval=interval,
        start_ms=start_ms,
        end_ms=end_ms,
        order="ASC",
        exchange=exchange,
        market_type=market_type,
    )
    times = sorted({int(row["open_time"]) for row in rows})
    if not times:
        return [(start_ms, end_ms)]

    gaps: list[tuple[int, int]] = []
    expected = int(start_ms)
    for open_time in times:
        if open_time < expected:
            continue
        if open_time > end_ms:
            break
        if open_time > expected:
            gaps.append((expected, min(open_time - 1, end_ms)))
        expected = open_time + interval_ms

    if expected <= end_ms:
        gaps.append((expected, end_ms))
    return gaps


async def _aggregate_custom_rows(
    symbol: str,
    custom_interval: str,
    base_interval: str,
    base_rows: list[dict],
    aggregator_config: dict,
    exchange: str = "binance",
    market_type: str = "spot",
) -> list[dict]:
    symbol = symbol.upper()
    agg = BarAggregator(BarAggregatorConfig(**aggregator_config))
    states = await agg.aggregate_batch(
        symbol,
        custom_interval,
        base_interval,
        base_rows,
        exchange=exchange,
        market_type=market_type,
    )
    return [_normalize_storage_row(state.to_storage_dict()) for state in states]
