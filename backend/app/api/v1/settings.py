"""
Settings API routes — proxy configuration and connectivity test.

Provides endpoints for:
  * GET  /settings/proxy       — read current proxy configuration
  * PUT  /settings/proxy       — update proxy configuration at runtime
  * POST /settings/proxy/test  — test proxy connectivity to Binance
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

import aiohttp
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core.market import find_best_base_interval, parse_custom_interval
from app.data_engine.bar_aggregator import BarAggregator, BarAggregatorConfig
from app.data_engine.data_manager.models import BarData
from app.data_engine.storage.klines_repo import list_series_summaries

logger = logging.getLogger("candlescope.settings")

router = APIRouter(prefix="/settings", tags=["settings"])

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


# ═══════════════════════════════════════════════════════════════
#  Models
# ═══════════════════════════════════════════════════════════════


class ProxyConfig(BaseModel):
    """Proxy configuration payload."""
    mode: str = "system"          # "none" | "system" | "custom"
    custom_proxy: str | None = None  # e.g. "http://127.0.0.1:7890"


class ProxyTestRequest(BaseModel):
    """Request body for testing proxy connectivity."""
    mode: str = "system"
    custom_proxy: str | None = None


# ═══════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════


def _get_system_proxy() -> str | None:
    """Read proxy from environment variables, fallback to OS-level settings.

    On Windows, v2rayN / Clash etc. set the proxy in the registry
    (Internet Settings → ProxyServer) rather than env vars.
    ``urllib.request.getproxies()`` reads these OS-level settings
    as a cross-platform fallback.
    """
    env_proxy = (
        os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or os.getenv("https_proxy")
        or os.getenv("http_proxy")
    )
    if env_proxy:
        return env_proxy

    # Fallback: read from Windows registry / macOS scutil / etc.
    from urllib.request import getproxies
    proxies = getproxies()
    return proxies.get("https") or proxies.get("http") or None


def _resolve_proxy_url(mode: str, custom_proxy: str | None) -> str | None:
    """Resolve the effective proxy URL for a given mode."""
    if mode == "none":
        return None
    if mode == "custom":
        return custom_proxy if custom_proxy else None
    # mode == "system"
    return _get_system_proxy()


def _get_ingestion_config(request: Request):
    """Get the IngestionConfig from app state (if available)."""
    # Try backfill transport first (it holds the shared IngestionConfig)
    transport = getattr(request.app.state, "backfill_transport", None)
    if transport is not None:
        return transport._cfg
    return None


def _get_transports(request: Request) -> list:
    """Collect all TransportLayer instances from app state."""
    transports = []
    # Backfill transport
    bt = getattr(request.app.state, "backfill_transport", None)
    if bt is not None:
        transports.append(bt)
    # Ingestion factory may hold transport(s) too
    factory = getattr(request.app.state, "ingestion_factory", None)
    if factory is not None and hasattr(factory, "_ingress"):
        ingress = factory._ingress
        if ingress is not None and hasattr(ingress, "_transport"):
            transports.append(ingress._transport)
    return transports


def _get_data_manager(request: Request):
    """Return the app-wide DataManager."""
    return getattr(request.app.state, "data_manager", None)


def _get_backfill_engine(request: Request):
    """Return the app-wide BackfillEngine."""
    return getattr(request.app.state, "backfill_engine", None)


def _get_storage_repair_lock(request: Request) -> asyncio.Lock:
    """Return a shared lock guarding manual storage repair."""
    lock = getattr(request.app.state, "storage_repair_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        request.app.state.storage_repair_lock = lock
    return lock


def _normalize_storage_row(row: dict) -> dict:
    """Normalize a storage row for deterministic comparison/writes."""
    normalized: dict[str, int | float] = {}
    for field in _STORAGE_ROW_INT_FIELDS:
        normalized[field] = int(row.get(field, 0) or 0)
    for field in _STORAGE_ROW_FLOAT_FIELDS:
        normalized[field] = float(row.get(field, 0) or 0.0)
    return normalized


def _rows_match(left: dict, right: dict, tol: float = 1e-8) -> bool:
    """Compare two normalized storage rows."""
    for field in _STORAGE_ROW_INT_FIELDS:
        if int(left.get(field, 0)) != int(right.get(field, 0)):
            return False
    for field in _STORAGE_ROW_FLOAT_FIELDS:
        if abs(float(left.get(field, 0.0)) - float(right.get(field, 0.0))) > tol:
            return False
    return True


def _count_row_differences(existing_rows: list[dict], rebuilt_rows: list[dict]) -> int:
    """Count per-open-time differences between stored and rebuilt rows."""
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


def _is_closed_bucket(open_time_ms: int, interval_ms: int, now_ms: int) -> bool:
    """Return True when the bucket is fully closed by now."""
    return open_time_ms + interval_ms <= now_ms


def _list_custom_series(storage) -> list[dict]:
    """Return stored custom-interval series summaries."""
    if storage is not None and hasattr(storage, "list_series"):
        return storage.list_series(custom_only=True)
    return list_series_summaries(custom_only=True)


async def _ensure_base_series_complete(
    backfill_engine,
    symbol: str,
    base_interval: str,
    start_ms: int,
    end_ms: int,
    metadata: dict,
) -> tuple[bool, int, list[str]]:
    """Ensure the authoritative base interval is gap-free for repair."""
    gap_runs = 0
    errors: list[str] = []

    gaps = await backfill_engine.detect_only(
        symbol=symbol,
        intervals=[base_interval],
        range_start_ms=start_ms,
        range_end_ms=end_ms,
    )
    if not gaps:
        return True, gap_runs, errors

    gap_runs += 1
    report = await backfill_engine.run(
        symbol=symbol,
        intervals=[base_interval],
        range_start_ms=start_ms,
        range_end_ms=end_ms,
        metadata=metadata,
    )
    if report.errors:
        errors.extend(report.errors)

    remaining = await backfill_engine.detect_only(
        symbol=symbol,
        intervals=[base_interval],
        range_start_ms=start_ms,
        range_end_ms=end_ms,
    )
    if remaining:
        errors.append(f"{len(remaining)} base gap(s) remain after repair")
        return False, gap_runs, errors

    return True, gap_runs, errors


async def _aggregate_custom_rows(
    symbol: str,
    custom_interval: str,
    base_interval: str,
    base_rows: list[dict],
    aggregator_config: dict,
) -> list[dict]:
    """Rebuild custom rows through a fresh BarAggregator instance."""
    symbol = symbol.upper()
    agg = BarAggregator(BarAggregatorConfig(**aggregator_config))
    agg.add_target(symbol, custom_interval)

    rows_by_open_time: dict[int, dict] = {}

    async def _capture(event) -> None:
        row = _normalize_storage_row(event.bar.to_storage_dict())
        rows_by_open_time[int(row["open_time"])] = row

    agg.publisher.on_bar_closed(_capture)
    agg.publisher.on_bar_amended(_capture)

    batch_size = 1000
    for idx in range(0, len(base_rows), batch_size):
        await agg.on_backfill_bars(
            symbol,
            base_interval,
            base_rows[idx : idx + batch_size],
        )

    return [rows_by_open_time[key] for key in sorted(rows_by_open_time)]


async def _warm_repaired_series(dm, storage, symbol: str, interval: str) -> None:
    """Invalidate cache, warm latest repaired bars, and reseed active custom tails."""
    symbol = symbol.upper()
    dm.cache_invalidate(symbol, interval)

    rows = await asyncio.to_thread(
        storage.query_bars,
        symbol,
        interval,
        None,
        None,
        500,
        "DESC",
    )
    if rows:
        bars = [BarData.from_storage_row(row) for row in reversed(rows)]
        await dm.on_bars_backfilled(symbol, interval, bars)

    if (symbol, interval) in set(dm.bar_aggregator.get_targets()):
        try:
            await dm._seed_custom_interval(symbol, interval)
        except Exception as exc:
            logger.warning("Failed to reseed repaired custom tail for %s@%s: %s", symbol, interval, exc)


# ═══════════════════════════════════════════════════════════════
#  Endpoints
# ═══════════════════════════════════════════════════════════════


@router.get("/proxy")
async def get_proxy_settings(request: Request) -> dict:
    """Return the current proxy configuration."""
    cfg = _get_ingestion_config(request)

    if cfg is not None:
        mode = getattr(cfg, "proxy_mode", "system")
        custom_proxy = cfg.http_proxy
    else:
        mode = "system"
        custom_proxy = None

    system_proxy = _get_system_proxy()
    effective = _resolve_proxy_url(mode, custom_proxy)

    return {
        "mode": mode,
        "custom_proxy": custom_proxy or "",
        "system_proxy": system_proxy or "",
        "effective_proxy": effective or "",
    }


@router.put("/proxy")
async def update_proxy_settings(request: Request, body: ProxyConfig) -> dict:
    """Update proxy configuration at runtime.

    This updates the IngestionConfig and restarts HTTP sessions
    so the new proxy takes effect immediately.
    """
    cfg = _get_ingestion_config(request)

    if cfg is None:
        return {
            "status": "warning",
            "message": "IngestionConfig not available (DataManager not initialized). "
                       "Settings saved in-memory only.",
            "mode": body.mode,
            "custom_proxy": body.custom_proxy or "",
        }

    # Update config
    cfg.update(
        proxy_mode=body.mode,
        http_proxy=body.custom_proxy if body.mode == "custom" else cfg.http_proxy,
    )

    # Restart all transport HTTP sessions to apply new proxy
    transports = _get_transports(request)
    for transport in transports:
        try:
            await transport.restart_http_session()
        except Exception as exc:
            logger.warning("Failed to restart transport session: %s", exc)

    effective = _resolve_proxy_url(body.mode, body.custom_proxy)
    logger.info(
        "Proxy settings updated: mode=%s, effective=%s",
        body.mode, effective or "none",
    )

    return {
        "status": "ok",
        "mode": body.mode,
        "custom_proxy": body.custom_proxy or "",
        "effective_proxy": effective or "",
    }


@router.post("/proxy/test")
async def test_proxy_connection(body: ProxyTestRequest) -> dict:
    """Test proxy connectivity by making a request to Binance API.

    Uses the provided proxy settings (not the current config) to
    test if the proxy works before the user commits the change.
    """
    proxy_url = _resolve_proxy_url(body.mode, body.custom_proxy)
    test_url = "https://api.binance.com/api/v3/ping"

    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(test_url, proxy=proxy_url) as resp:
                status_code = resp.status
                if status_code == 200:
                    return {
                        "success": True,
                        "status_code": status_code,
                        "proxy_used": proxy_url or "(direct)",
                        "message": "连接成功 — Binance API 可达",
                    }
                else:
                    body_text = await resp.text()
                    return {
                        "success": False,
                        "status_code": status_code,
                        "proxy_used": proxy_url or "(direct)",
                        "message": f"HTTP {status_code}: {body_text[:200]}",
                    }
    except aiohttp.ClientProxyConnectionError as exc:
        return {
            "success": False,
            "status_code": None,
            "proxy_used": proxy_url or "(direct)",
            "message": f"代理连接失败: {exc}",
        }
    except aiohttp.ClientConnectorError as exc:
        return {
            "success": False,
            "status_code": None,
            "proxy_used": proxy_url or "(direct)",
            "message": f"连接失败: {exc}",
        }
    except Exception as exc:
        return {
            "success": False,
            "status_code": None,
            "proxy_used": proxy_url or "(direct)",
            "message": f"测试失败: {type(exc).__name__}: {exc}",
        }


@router.post("/storage/repair")
async def repair_custom_storage(request: Request) -> dict:
    """Check and rebuild stored custom-interval rows from authoritative base data."""
    dm = _get_data_manager(request)
    backfill_engine = _get_backfill_engine(request)
    if dm is None or backfill_engine is None:
        raise HTTPException(status_code=503, detail="DataManager/BackfillEngine 尚未初始化")

    storage = getattr(dm.query_engine, "_storage", None)
    if storage is None:
        raise HTTPException(status_code=503, detail="Storage backend 尚未初始化")

    lock = _get_storage_repair_lock(request)
    if lock.locked():
        raise HTTPException(status_code=409, detail="库修复任务正在运行，请稍后再试")

    async with lock:
        started_at_ms = int(time.time() * 1000)
        now_ms = started_at_ms
        aggregator_config = dm.bar_aggregator.config.snapshot()
        series = await asyncio.to_thread(_list_custom_series, storage)

        if not series:
            return {
                "status": "warning",
                "message": "未发现已落库的自定义周期数据，无需修复",
                "checked_series": 0,
                "repaired_series": 0,
                "unchanged_series": 0,
                "failed_series": 0,
                "total_deleted_rows": 0,
                "total_written_rows": 0,
                "total_stale_rows_removed": 0,
                "base_backfill_runs": 0,
                "elapsed_ms": int(time.time() * 1000) - started_at_ms,
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
                "symbol": symbol,
                "interval": interval,
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
                symbol,
                interval,
                earliest_open,
                latest_open,
                None,
                "ASC",
            )
            existing_rows = [_normalize_storage_row(row) for row in existing_rows]
            closed_existing = [
                row for row in existing_rows
                if _is_closed_bucket(int(row["open_time"]), custom_ms, now_ms)
            ]
            stale_existing = [
                row for row in existing_rows
                if not _is_closed_bucket(int(row["open_time"]), custom_ms, now_ms)
            ]
            result["stale_rows_removed"] = len(stale_existing)

            if not closed_existing:
                if stale_existing:
                    deleted = await asyncio.to_thread(
                        storage.delete_bars,
                        symbol,
                        interval,
                        int(stale_existing[0]["open_time"]),
                        int(stale_existing[-1]["open_time"]),
                    )
                    total_deleted_rows += deleted
                    total_stale_rows_removed += len(stale_existing)
                    repaired_series += 1
                    result["deleted_rows"] = deleted
                    result["status"] = "repaired"
                    result["message"] = "仅发现未封口尾部数据，已删除脏尾巴"
                    await _warm_repaired_series(dm, storage, symbol, interval)
                else:
                    unchanged_series += 1
                    result["message"] = "没有可修复的数据"
                results.append(result)
                continue

            repair_start_open = int(closed_existing[0]["open_time"])
            repair_end_open = int(closed_existing[-1]["open_time"])
            base_interval, _ = find_best_base_interval(custom_seconds, interval=interval)
            result["base_interval"] = base_interval

            base_ok, gap_runs, base_errors = await _ensure_base_series_complete(
                backfill_engine,
                symbol,
                base_interval,
                repair_start_open,
                repair_end_open + custom_ms - 1,
                metadata={
                    "origin": "settings_storage_repair",
                    "target_interval": interval,
                    "phase": "base_repair",
                },
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
                symbol,
                base_interval,
                repair_start_open,
                repair_end_open + custom_ms - 1,
                None,
                "ASC",
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
            )
            rebuilt_rows = [
                row for row in rebuilt_rows
                if repair_start_open <= int(row["open_time"]) <= repair_end_open
                and _is_closed_bucket(int(row["open_time"]), custom_ms, now_ms)
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
                symbol,
                interval,
                earliest_open,
                latest_open,
            )
            written = 0
            if rebuilt_rows:
                written = await asyncio.to_thread(
                    storage.upsert_bars,
                    symbol,
                    interval,
                    rebuilt_rows,
                    "settings_manual_repair",
                )

            total_deleted_rows += deleted
            total_written_rows += written
            total_stale_rows_removed += len(stale_existing)
            repaired_series += 1

            result["deleted_rows"] = deleted
            result["repaired_rows"] = written
            result["status"] = "repaired"
            result["message"] = "已按基础周期重建并回写自定义周期数据"

            await _warm_repaired_series(dm, storage, symbol, interval)
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
            "elapsed_ms": int(time.time() * 1000) - started_at_ms,
            "results": results,
        }


@router.post("/storage/gap-scan")
async def scan_and_fill_gaps(request: Request) -> dict:
    """Scan all standard intervals for data gaps and fill them from Binance REST.

    This is a manual "repair all gaps" button.  Unlike the startup scan
    (which only checks prewarm intervals), this endpoint checks every
    standard interval that has data in storage and fills any gap larger than
    3 intervals.

    Returns a detailed report with per-interval results.
    """
    dm = _get_data_manager(request)
    backfill_engine = _get_backfill_engine(request)
    if dm is None or backfill_engine is None:
        raise HTTPException(status_code=503, detail="DataManager/BackfillEngine 尚未初始化")

    storage = getattr(dm.query_engine, "_storage", None)
    if storage is None:
        raise HTTPException(status_code=503, detail="Storage backend 尚未初始化")

    lock = _get_storage_repair_lock(request)
    if lock.locked():
        raise HTTPException(status_code=409, detail="修复任务正在运行，请稍后再试")

    async with lock:
        started_at_ms = int(time.time() * 1000)
        now_ms = started_at_ms

        # Scan all standard intervals that have data
        all_intervals = [
            "1m", "3m", "5m", "15m", "30m",
            "1h", "2h", "4h", "6h", "8h", "12h",
            "1d", "3d", "1w",
        ]
        symbol = "BTCUSDT"

        results = []
        total_bars_filled = 0
        gaps_found = 0
        gaps_filled = 0

        for iv in all_intervals:
            try:
                bounds = await asyncio.to_thread(storage.get_bounds, symbol, iv)
                latest = bounds.get("latest_open_time")
                earliest = bounds.get("earliest_open_time")
                total_count = bounds.get("total_count", 0)
                if not latest or not total_count:
                    continue

                from app.data_engine.bar_aggregator.models import parse_interval_ms
                interval_ms = parse_interval_ms(iv) or 60_000
                gap_ms = now_ms - latest

                entry = {
                    "interval": iv,
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

                # Check for tail gap
                if gap_ms > interval_ms * 3:
                    gaps_found += 1
                    entry["status"] = "gap_found"
                    entry["message"] = f"尾部缺口 {entry['gap_hours']}h"

                    report = await backfill_engine.run(
                        symbol=symbol,
                        intervals=[iv],
                        range_start_ms=latest,
                        range_end_ms=now_ms,
                    )
                    bars_written = (
                        report.reconcile_result.bars_written
                        if report.reconcile_result else 0
                    )

                    if bars_written > 0:
                        entry["bars_filled"] = bars_written
                        entry["status"] = "filled"
                        entry["message"] = f"已补 {bars_written} 条"
                        total_bars_filled += bars_written
                        gaps_filled += 1

                        # Load into cache
                        from app.data_engine.data_manager.models import BarData
                        rows = storage.query_bars(
                            symbol=symbol, interval=iv,
                            start_ms=latest, end_ms=now_ms,
                            order="ASC",
                        )
                        bars = [BarData.from_storage_row(r) for r in rows]
                        if bars:
                            await dm.on_bars_backfilled(symbol, iv, bars)
                    else:
                        entry["message"] = "尝试回补但无新数据（可能是网络问题）"

                # Also check for interior gaps (sample the most recent data)
                rows = await asyncio.to_thread(
                    storage.query_bars,
                    symbol, iv, None, None, 2000, "DESC",
                )
                if len(rows) >= 2:
                    times = sorted([int(r["open_time"]) for r in rows])
                    threshold = interval_ms * 1.5
                    interior_gaps = []
                    for i in range(1, len(times)):
                        diff = times[i] - times[i - 1]
                        if diff > threshold:
                            interior_gaps.append((times[i - 1], times[i], diff))

                    if interior_gaps:
                        gaps_found += len(interior_gaps)
                        for gap_start, gap_end, gap_diff in interior_gaps:
                            gap_report = await backfill_engine.run(
                                symbol=symbol,
                                intervals=[iv],
                                range_start_ms=gap_start,
                                range_end_ms=gap_end,
                            )
                            gap_bars = (
                                gap_report.reconcile_result.bars_written
                                if gap_report.reconcile_result else 0
                            )
                            if gap_bars > 0:
                                total_bars_filled += gap_bars
                                gaps_filled += 1
                                entry["bars_filled"] += gap_bars

                                from app.data_engine.data_manager.models import BarData
                                fill_rows = storage.query_bars(
                                    symbol=symbol, interval=iv,
                                    start_ms=gap_start, end_ms=gap_end,
                                    order="ASC",
                                )
                                fill_bars = [BarData.from_storage_row(r) for r in fill_rows]
                                if fill_bars:
                                    await dm.on_bars_backfilled(symbol, iv, fill_bars)

                        if entry["bars_filled"] > 0:
                            entry["status"] = "filled"
                            gap_desc = f"{len(interior_gaps)} 个内部缺口"
                            if entry["message"]:
                                entry["message"] += f" + {gap_desc}"
                            else:
                                entry["message"] = f"发现并修复 {gap_desc}，已补 {entry['bars_filled']} 条"
                        elif entry["status"] == "ok":
                            entry["status"] = "gap_found"
                            entry["message"] = f"发现 {len(interior_gaps)} 个内部缺口但无法补回"

                if entry["status"] == "ok":
                    entry["message"] = "数据完整 ✓"

                results.append(entry)

            except Exception as exc:
                results.append({
                    "interval": iv,
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
            message = f"发现 {gaps_found} 个缺口，修复 {gaps_filled} 个，{gaps_found - gaps_filled} 个未修复"
        else:
            status = "error"
            message = f"发现 {gaps_found} 个缺口，均未能修复"

        return {
            "status": status,
            "message": message,
            "gaps_found": gaps_found,
            "gaps_filled": gaps_filled,
            "total_bars_filled": total_bars_filled,
            "elapsed_ms": elapsed_ms,
            "results": results,
        }

