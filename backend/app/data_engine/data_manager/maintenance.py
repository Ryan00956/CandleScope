"""Storage maintenance workflows for DataManager."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Iterable
from typing import Any, Protocol

from app.core.executors import run_storage
from app.data_engine.bar_aggregator import BarAggregator, BarAggregatorConfig
from app.data_engine.interval_policy import (
    STANDARD_INTERVAL_MS,
    compute_bucket_close_ms,
    find_best_base_interval,
    parse_custom_interval,
    parse_interval_ms,
)

from .backfill_coordinator import RepairRequest
from .models import BarData, SeriesKey

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
_MAX_STORAGE_GC_BATCH_ROWS = 1_000


class MaintenanceBusyError(RuntimeError):
    """Raised when another storage maintenance task is already running."""


class MaintenanceUnavailableError(RuntimeError):
    """Raised when required maintenance dependencies are not available."""


async def _run_storage_batch(
    func: Callable[..., Any],
    *args: Any,
    _on_completed: Callable[[Any], None] | None = None,
    **kwargs: Any,
) -> Any:
    """Let an in-flight storage transaction finish before honoring cancellation.

    ``_on_completed`` runs on the event-loop thread after the storage worker has
    finished, including when cancellation arrived while the transaction was in
    flight.  Destructive callers use it to restore cache coherence before the
    cancellation is propagated.
    """
    task = asyncio.create_task(run_storage(func, *args, **kwargs))
    try:
        result = await asyncio.shield(task)
        if _on_completed is not None:
            _on_completed(result)
        return result
    except asyncio.CancelledError as cancelled:
        # A task can be cancelled repeatedly during shutdown.  Keep shielding
        # the executor future until the transaction really finishes so the
        # maintenance mutex cannot be released while SQLite is still mutating.
        storage_failed = False
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                logger.exception(
                    "storage batch failed while shutdown waited for completion"
                )
                storage_failed = True
                break
        if task.done() and not task.cancelled() and not storage_failed:
            try:
                result = task.result()
                if _on_completed is not None:
                    _on_completed(result)
            except Exception:
                logger.exception(
                    "storage batch failed while shutdown waited for completion"
                )
        raise cancelled


def _storage_victim_identity(victim: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(victim.get("exchange") or "binance").strip().lower(),
        str(victim.get("market_type") or "spot").strip().lower(),
        str(victim.get("symbol") or "").strip().upper(),
        str(victim.get("interval") or "").strip(),
    )


def _intersect_revalidated_storage_series(
    original_series: list[dict[str, Any]],
    fresh_series: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Never let execution exceed either the confirmed or the fresh plan."""
    fresh_by_key = {
        _storage_victim_identity(victim): victim
        for victim in fresh_series
    }
    selected: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for original in original_series:
        fresh = fresh_by_key.get(_storage_victim_identity(original))
        original_rows = max(0, int(original.get("would_delete_rows", 0) or 0))
        if fresh is None or original_rows <= 0:
            skipped.append({
                **original,
                "deleted_rows": 0,
                "batches": 0,
                "status": "adjusted-at-revalidation",
                "message": "fresh storage plan no longer authorizes this deletion",
            })
            continue

        fresh_rows = max(0, int(fresh.get("would_delete_rows", 0) or 0))
        keep_rows = max(
            int(original.get("keep_rows", 0) or 0),
            int(fresh.get("keep_rows", 0) or 0),
        )
        fresh_current_rows = max(0, int(fresh.get("current_rows", 0) or 0))
        allowed_rows = min(
            original_rows,
            fresh_rows,
            max(0, fresh_current_rows - keep_rows),
        )
        if allowed_rows <= 0:
            skipped.append({
                **original,
                "deleted_rows": 0,
                "batches": 0,
                "status": "adjusted-at-revalidation",
                "message": "fresh storage pressure/retention state requires no rows",
                "current_rows_at_revalidation": fresh_current_rows,
                "keep_rows_at_revalidation": keep_rows,
            })
            continue

        original_estimate = max(
            0,
            int(original.get("would_free_estimated_bytes", 0) or 0),
        )
        selected.append({
            **original,
            "keep_rows": keep_rows,
            "would_delete_rows": allowed_rows,
            "would_free_estimated_bytes": int(
                original_estimate * allowed_rows / original_rows
            ) if original_rows else 0,
            "execution_revalidated": True,
            "current_rows_at_revalidation": fresh_current_rows,
            "fresh_would_delete_rows": fresh_rows,
            "fresh_reason": fresh.get("reason"),
        })
    return selected, skipped


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
        storage_gc_protection: Callable[[SeriesKey, list[dict[str, Any]], int | None], str | None] | None = None,
        storage_gc_delete_batch: Callable[..., dict[str, Any]] | None = None,
        storage_gc_replanner: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    ) -> None:
        self._storage_provider = storage_provider
        self._aggregator_config_snapshot = aggregator_config_snapshot
        self._cache_invalidator = cache_invalidator
        self._bars_backfilled = bars_backfilled
        self._active_targets = active_targets
        self._seed_active_bar = seed_active_bar
        self._storage_gc_protection = storage_gc_protection
        self._storage_gc_delete_batch = storage_gc_delete_batch
        self._storage_gc_replanner = storage_gc_replanner
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
            series = await run_storage(
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
                existing_rows = await run_storage(
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
                        deleted = await run_storage(
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

                base_rows = await run_storage(
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

                deleted = await run_storage(
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
                    written = await run_storage(
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

            series = await run_storage(storage.list_series, False, exchange, market_type)
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

                    rows = await run_storage(
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
        deleted = await run_storage(
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

    async def run_storage_gc(
        self,
        *,
        plan: dict,
        batch_size: int = 10_000,
    ) -> dict:
        """Execute a previously generated SQLite retention GC plan."""
        storage = self._storage()
        if self._lock.locked():
            raise MaintenanceBusyError("库维护任务正在运行，请稍后再试")

        async with self._lock:
            started_at_ms = int(time.time() * 1000)
            batch_size = min(
                _MAX_STORAGE_GC_BATCH_ROWS,
                max(1, int(batch_size or 1)),
            )
            expires_at_ms = int(plan.get("expires_at_ms", 0) or 0)
            if expires_at_ms and started_at_ms > expires_at_ms:
                return {
                    **plan,
                    "mode": "execute",
                    "status": "stale",
                    "stale_reason": "plan-expired",
                    "batch_size": batch_size,
                    "deleted_rows": 0,
                    "affected_series": 0,
                    "elapsed_ms": 0,
                    "errors": [],
                    "checkpoint_result": None,
                    "results": [],
                }
            results: list[dict] = []
            errors: list[str] = []
            total_deleted = 0
            affected_series = 0
            checkpoint = getattr(storage, "wal_checkpoint_truncate", None)
            checkpoint_before_result = None
            checkpoint_blocked = False
            revalidation_blocked = False
            execution_revalidation: dict[str, Any] | None = None
            checkpoint_recommended = bool(plan.get("checkpoint_recommended"))
            if checkpoint_recommended and not callable(checkpoint):
                checkpoint_blocked = True
                errors.append("wal_checkpoint_truncate: unsupported")
                checkpoint_before_result = {
                    "status": "blocked",
                    "error": "checkpoint-unsupported",
                }
            elif callable(checkpoint) and checkpoint_recommended:
                try:
                    checkpoint_before_result = await _run_storage_batch(checkpoint)
                    if int((checkpoint_before_result or {}).get("busy", 0) or 0) > 0:
                        checkpoint_blocked = True
                        errors.append("wal_checkpoint_truncate: checkpoint-busy")
                        checkpoint_before_result = {
                            **(checkpoint_before_result or {}),
                            "status": "blocked",
                            "error": "checkpoint-busy",
                        }
                except Exception as exc:
                    checkpoint_blocked = True
                    errors.append(f"wal_checkpoint_truncate: {exc}")
                    checkpoint_before_result = {"status": "error", "error": str(exc)}

            original_series = list(plan.get("series", []) or [])
            planned_series = [] if checkpoint_blocked else original_series
            budget_revalidation_required = bool(
                plan.get("planner_version")
                and any(
                    "sqlite-budget" in str(victim.get("reason") or "")
                    for victim in original_series
                )
            )
            if not checkpoint_blocked and budget_revalidation_required:
                if self._storage_gc_replanner is None:
                    revalidation_blocked = True
                    errors.append("storage execution revalidation is unsupported")
                    execution_revalidation = {
                        "status": "blocked",
                        "reason": "execution-replanner-unsupported",
                    }
                    planned_series = []
                else:
                    try:
                        fresh_plan = await _run_storage_batch(
                            self._storage_gc_replanner,
                            plan,
                        )
                        if fresh_plan.get("available") is False:
                            revalidation_blocked = True
                            errors.append(
                                "storage execution revalidation unavailable: "
                                f"{fresh_plan.get('reason') or 'unknown'}"
                            )
                            execution_revalidation = {
                                "status": "blocked",
                                "reason": fresh_plan.get("reason") or "unavailable",
                                "fresh_plan": fresh_plan,
                            }
                            planned_series = []
                        else:
                            fresh_watermarks = dict(
                                fresh_plan.get("watermarks") or {}
                            )
                            fresh_required_logical_relief = int(
                                fresh_watermarks.get(
                                    "required_logical_relief_bytes",
                                    fresh_plan.get(
                                        "required_logical_relief_bytes",
                                        0,
                                    ),
                                ) or 0
                            )
                            fresh_required_physical_relief = int(
                                fresh_watermarks.get(
                                    "required_physical_relief_bytes",
                                    fresh_plan.get(
                                        "required_physical_relief_bytes",
                                        0,
                                    ),
                                ) or 0
                            )
                            fresh_planning_blocked = bool(
                                (
                                    fresh_required_physical_relief > 0
                                    and fresh_watermarks.get(
                                        "relief_planning_available"
                                    ) is False
                                )
                                or (
                                    fresh_required_logical_relief > 0
                                    and fresh_watermarks.get(
                                        "klines_budget_planning_available"
                                    ) is False
                                )
                            )
                            if fresh_planning_blocked:
                                revalidation_blocked = True
                                planned_series = []
                                blocked_reason = str(
                                    fresh_watermarks.get(
                                        "owner_planning_blocked_reason"
                                    )
                                    or fresh_watermarks.get(
                                        "planning_blocked_reason"
                                    )
                                    or "fresh-budget-relief-planning-unavailable"
                                )
                                errors.append(
                                    "storage execution revalidation blocked: "
                                    f"{blocked_reason}"
                                )
                                execution_revalidation = {
                                    "status": "blocked",
                                    "reason": blocked_reason,
                                    "fresh_plan": fresh_plan,
                                }
                            else:
                                planned_series, revalidation_skipped = (
                                    _intersect_revalidated_storage_series(
                                        original_series,
                                        list(fresh_plan.get("series", []) or []),
                                    )
                                )
                                results.extend(revalidation_skipped)
                                execution_revalidation = {
                                    "status": "ok",
                                    "original_victim_count": len(original_series),
                                    "authorized_victim_count": len(planned_series),
                                    "skipped_victim_count": len(revalidation_skipped),
                                    "fresh_generated_at_ms": fresh_plan.get("generated_at_ms"),
                                    "fresh_expires_at_ms": fresh_plan.get("expires_at_ms"),
                                    "fresh_watermarks": fresh_plan.get("watermarks"),
                                    "fresh_file_snapshot": fresh_plan.get(
                                        "execution_file_snapshot"
                                    ),
                                    "fresh_mode": fresh_plan.get("mode"),
                                    "fresh_auto_skipped": fresh_plan.get(
                                        "autoSkipped"
                                    ),
                                    "adjusted": bool(
                                        revalidation_skipped
                                        or len(planned_series) != len(original_series)
                                        or sum(
                                            int(victim.get("would_delete_rows", 0) or 0)
                                            for victim in planned_series
                                        ) < sum(
                                            int(victim.get("would_delete_rows", 0) or 0)
                                            for victim in original_series
                                        )
                                    ),
                                }
                    except Exception as exc:
                        revalidation_blocked = True
                        planned_series = []
                        errors.append(f"storage execution revalidation: {exc}")
                        execution_revalidation = {
                            "status": "error",
                            "reason": str(exc),
                        }
            declared_backend_batch_limit = max(
                0,
                int(
                    getattr(
                        storage,
                        "storage_gc_delete_max_batch_rows",
                        0,
                    ) or 0
                ),
            )
            declared_backend_deadline_ms = max(
                0,
                int(
                    getattr(
                        storage,
                        "storage_gc_delete_deadline_ms",
                        0,
                    ) or 0
                ),
            )
            bounded_delete_candidate = getattr(storage, "delete_oldest_batch", None)
            guarded_delete_batch = self._storage_gc_delete_batch
            bounded_delete = (
                bounded_delete_candidate
                if callable(bounded_delete_candidate)
                and declared_backend_batch_limit > 0
                and declared_backend_deadline_ms > 0
                and callable(guarded_delete_batch)
                else None
            )
            if declared_backend_batch_limit > 0:
                batch_size = min(batch_size, declared_backend_batch_limit)
            for victim in planned_series:
                symbol = str(victim.get("symbol") or "").upper()
                interval = str(victim.get("interval") or "")
                exchange = str(victim.get("exchange") or "binance")
                market_type = str(victim.get("market_type") or "spot")
                keep_rows = int(victim.get("keep_rows", 0) or 0)
                expected = int(victim.get("would_delete_rows", 0) or 0)
                deleted = 0
                batches = 0
                status = "skipped"
                message = ""
                last_protection_epoch: int | None = None
                max_guard_wait_ms = 0
                max_guard_hold_ms = 0
                total_guard_wait_ms = 0
                total_guard_hold_ms = 0
                max_backend_delete_elapsed_ms = 0.0
                total_backend_delete_elapsed_ms = 0.0
                last_contract_error = ""

                key = SeriesKey(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                ) if symbol and interval else None
                protection_reason = (
                    self._storage_gc_protection(
                        key,
                        list(victim.get("storage_intents") or []),
                        keep_rows,
                    )
                    if key is not None and self._storage_gc_protection is not None
                    else None
                )

                if expires_at_ms and int(time.time() * 1000) > expires_at_ms:
                    results.append({
                        **victim,
                        "deleted_rows": 0,
                        "batches": 0,
                        "status": "stale",
                        "message": "storage GC plan expired before this victim executed",
                    })
                    continue

                if not symbol or not interval or expected <= 0:
                    results.append({
                        **victim,
                        "deleted_rows": 0,
                        "batches": 0,
                        "status": status,
                        "message": "没有可删除行",
                    })
                    continue
                if protection_reason:
                    results.append({
                        **victim,
                        "deleted_rows": 0,
                        "batches": 0,
                        "status": "protected-at-execute",
                        "message": protection_reason,
                    })
                    continue
                if not callable(bounded_delete):
                    unsupported = (
                        f"{exchange}:{market_type}:{symbol}@{interval}: "
                        "bounded delete_oldest_batch is unsupported"
                    )
                    errors.append(unsupported)
                    results.append({
                        **victim,
                        "deleted_rows": 0,
                        "batches": 0,
                        "status": "unsupported",
                        "message": (
                            "storage GC integration does not publish bounded "
                            "row/latency and guarded-ordering contracts"
                        ),
                    })
                    continue

                try:
                    while deleted < expected:
                        if expires_at_ms and int(time.time() * 1000) > expires_at_ms:
                            status = "stale"
                            message = "storage GC plan expired between delete batches"
                            break
                        protection_reason = (
                            self._storage_gc_protection(
                                key,
                                list(victim.get("storage_intents") or []),
                                keep_rows,
                            )
                            if key is not None and self._storage_gc_protection is not None
                            else None
                        )
                        if protection_reason:
                            status = "protected-at-execute"
                            message = protection_reason
                            break
                        remaining = expected - deleted
                        step = min(batch_size, remaining)
                        delete_kwargs = {
                            "symbol": symbol,
                            "interval": interval,
                            "keep": keep_rows,
                            "batch_size": step,
                            "exchange": exchange,
                            "market_type": market_type,
                        }

                        def invalidate_completed_batch(batch_result: Any) -> None:
                            if (
                                isinstance(batch_result, dict)
                                and bool(batch_result.get("cache_invalidated"))
                            ):
                                return
                            completed_count = (
                                (batch_result or {}).get("deleted_rows", 0)
                                if isinstance(batch_result, dict)
                                else batch_result
                            )
                            if int(completed_count or 0) > 0:
                                self._cache_invalidator(
                                    symbol,
                                    interval,
                                    exchange=exchange,
                                    market_type=market_type,
                                )

                        batch_result = await _run_storage_batch(
                            guarded_delete_batch,
                            key=key,
                            planned_intents=list(victim.get("storage_intents") or []),
                            planned_keep_rows=keep_rows,
                            planned_protection_epoch=int(
                                plan.get("protection_epoch_at_plan", 0) or 0
                            ),
                            expires_at_ms=expires_at_ms,
                            delete_func=bounded_delete,
                            delete_kwargs=delete_kwargs,
                            _on_completed=invalidate_completed_batch,
                        )
                        stale_reason = str(
                            (batch_result or {}).get("stale_reason") or ""
                        )
                        protection_reason = str(
                            (batch_result or {}).get("protection_reason") or ""
                        )
                        last_protection_epoch = int(
                            (batch_result or {}).get(
                                "protection_epoch_at_completion",
                                (batch_result or {}).get("protection_epoch", 0),
                            ) or 0
                        )
                        guard_wait_ms = int(
                            (batch_result or {}).get("guard_wait_ms", 0) or 0
                        )
                        guard_hold_ms = int(
                            (batch_result or {}).get("guard_hold_ms", 0) or 0
                        )
                        max_guard_wait_ms = max(max_guard_wait_ms, guard_wait_ms)
                        max_guard_hold_ms = max(max_guard_hold_ms, guard_hold_ms)
                        total_guard_wait_ms += guard_wait_ms
                        total_guard_hold_ms += guard_hold_ms
                        backend_delete_elapsed_ms = float(
                            (batch_result or {}).get(
                                "backend_delete_elapsed_ms",
                                0.0,
                            ) or 0.0
                        )
                        max_backend_delete_elapsed_ms = max(
                            max_backend_delete_elapsed_ms,
                            backend_delete_elapsed_ms,
                        )
                        total_backend_delete_elapsed_ms += (
                            backend_delete_elapsed_ms
                        )
                        if stale_reason:
                            status = "stale"
                            message = stale_reason
                            break
                        if protection_reason:
                            status = "protected-at-execute"
                            message = protection_reason
                            break
                        count = (batch_result or {}).get("deleted_rows", 0)
                        backend_contract_error = str(
                            (batch_result or {}).get("contract_error") or ""
                        )
                        deadline_contract_error = (
                            "bounded delete exceeded declared deadline target: "
                            f"{backend_delete_elapsed_ms:.3f}ms > "
                            f"{declared_backend_deadline_ms}ms"
                            if (
                                declared_backend_deadline_ms > 0
                                and backend_delete_elapsed_ms
                                > declared_backend_deadline_ms
                            )
                            else ""
                        )
                        contract_error = "; ".join(
                            error
                            for error in (
                                backend_contract_error,
                                deadline_contract_error,
                            )
                            if error
                        )
                        last_contract_error = contract_error or last_contract_error
                        count = int(count or 0)
                        if count <= 0:
                            if contract_error:
                                status = "error"
                                message = contract_error
                                errors.append(
                                    f"{exchange}:{market_type}:{symbol}@{interval}: "
                                    f"{contract_error}"
                                )
                            break
                        first_successful_batch = deleted == 0
                        deleted += count
                        total_deleted += count
                        batches += 1
                        if first_successful_batch:
                            affected_series += 1
                        if contract_error:
                            status = "error"
                            message = contract_error
                            errors.append(
                                f"{exchange}:{market_type}:{symbol}@{interval}: "
                                f"{contract_error}"
                            )
                            break

                    if deleted > 0:
                        if status == "skipped":
                            status = "deleted"
                            message = f"已删除 {deleted} 行"
                    else:
                        if status == "skipped":
                            status = "unchanged"
                            message = "执行时已无需删除"
                except Exception as exc:
                    status = "error"
                    message = str(exc)
                    errors.append(f"{exchange}:{market_type}:{symbol}@{interval}: {exc}")

                results.append({
                    **victim,
                    "deleted_rows": deleted,
                    "batches": batches,
                    "status": status,
                    "message": message,
                    "protection_epoch": last_protection_epoch,
                    "max_guard_wait_ms": max_guard_wait_ms,
                    "max_guard_hold_ms": max_guard_hold_ms,
                    "total_guard_wait_ms": total_guard_wait_ms,
                    "total_guard_hold_ms": total_guard_hold_ms,
                    "max_backend_delete_elapsed_ms": round(
                        max_backend_delete_elapsed_ms,
                        3,
                    ),
                    "total_backend_delete_elapsed_ms": round(
                        total_backend_delete_elapsed_ms,
                        3,
                    ),
                    "contract_error": last_contract_error or None,
                })

            checkpoint_result = checkpoint_before_result
            if callable(checkpoint) and total_deleted > 0:
                try:
                    checkpoint_result = await _run_storage_batch(checkpoint)
                    if int((checkpoint_result or {}).get("busy", 0) or 0) > 0:
                        errors.append("wal_checkpoint_truncate: checkpoint-busy")
                        checkpoint_result = {
                            **(checkpoint_result or {}),
                            "status": "blocked",
                            "error": "checkpoint-busy",
                        }
                except Exception as exc:
                    errors.append(f"wal_checkpoint_truncate: {exc}")
                    checkpoint_result = {"status": "error", "error": str(exc)}

            execution_drift = any(
                (
                    str(result.get("status") or "") in {
                        "protected-at-execute",
                        "stale",
                        "skipped",
                    }
                    or (
                        str(result.get("status") or "")
                        != "adjusted-at-revalidation"
                        and int(result.get("deleted_rows", 0) or 0)
                        < int(result.get("would_delete_rows", 0) or 0)
                    )
                )
                for result in results
            )
            return {
                **plan,
                "mode": "execute",
                "status": (
                    "blocked"
                    if checkpoint_blocked or revalidation_blocked
                    else "partial"
                    if errors
                    else "constrained"
                    if execution_drift
                    else "ok"
                ),
                "batch_size": batch_size,
                "backend_delete_contract": {
                    "max_batch_rows": declared_backend_batch_limit or None,
                    "deadline_ms": declared_backend_deadline_ms or None,
                    "deadline_target_ms": declared_backend_deadline_ms or None,
                    "deadline_semantics": "observable-target-not-hard-realtime-guarantee",
                    "ordering_guard_supported": callable(guarded_delete_batch),
                    "supported": bounded_delete is not None,
                },
                "deleted_rows": total_deleted,
                "affected_series": affected_series,
                "elapsed_ms": int(time.time() * 1000) - started_at_ms,
                "errors": errors,
                "checkpoint_before_result": checkpoint_before_result,
                "checkpoint_result": checkpoint_result,
                "execution_revalidation": execution_revalidation,
                "max_guard_wait_ms": max(
                    (int(result.get("max_guard_wait_ms", 0) or 0) for result in results),
                    default=0,
                ),
                "max_guard_hold_ms": max(
                    (int(result.get("max_guard_hold_ms", 0) or 0) for result in results),
                    default=0,
                ),
                "max_backend_delete_elapsed_ms": max(
                    (
                        float(
                            result.get(
                                "max_backend_delete_elapsed_ms",
                                0.0,
                            ) or 0.0
                        )
                        for result in results
                    ),
                    default=0.0,
                ),
                "vacuum_recommended": bool(plan.get("vacuum_recommended")) or total_deleted > 0,
                "results": results,
            }

    async def vacuum_storage(self) -> dict:
        """Run SQLite VACUUM under the maintenance lock."""
        storage = self._storage()
        if self._lock.locked():
            raise MaintenanceBusyError("库维护任务正在运行，请稍后再试")
        vacuum = getattr(storage, "vacuum", None)
        if not callable(vacuum):
            raise MaintenanceUnavailableError("Storage backend 不支持 VACUUM")

        async with self._lock:
            started_at_ms = int(time.time() * 1000)
            result = await _run_storage_batch(vacuum)
            return {
                "mode": "vacuum",
                "owner": "sqlite-storage",
                "status": "ok",
                "elapsed_ms": int(time.time() * 1000) - started_at_ms,
                "result": result,
            }

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

        rows = await run_storage(
            storage.query_bars,
            symbol=symbol,
            interval=interval,
            limit=500,
            order="DESC",
            exchange=exchange,
            market_type=market_type,
        )
        if rows:
            bars = [
                BarData.from_storage_row(
                    row,
                    exchange=exchange,
                    market_type=market_type,
                )
                for row in reversed(rows)
            ]
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
    rows = await run_storage(
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
