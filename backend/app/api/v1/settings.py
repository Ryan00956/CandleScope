"""
Settings API routes — proxy configuration and connectivity test.

Provides endpoints for:
  * GET  /settings/proxy       — read current proxy configuration
  * PUT  /settings/proxy       — update proxy configuration at runtime
  * POST /settings/proxy/test  — test proxy connectivity to all exchanges
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any

import aiohttp
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core.config import KLINES_DB_PATH
from app.core.executors import run_storage
from app.core.market import MarketType
from app.core.config import load_proxy_settings, normalize_proxy_settings, save_proxy_settings
from app.indicator.pyne.cache import pyne_cache
from app.exchanges.symbols import normalize_symbol
from app.data_engine.storage.klines_repo import list_series_summaries
from app.data_engine.data_manager.runtime_pressure import build_storage_watermarks, disk_pressure_snapshot
from app.data_engine.data_manager import (
    MaintenanceBusyError,
    MaintenanceUnavailableError,
)

logger = logging.getLogger("candlescope.settings")

router = APIRouter(prefix="/settings", tags=["settings"])

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


class StorageMaintenanceRequest(BaseModel):
    """Optional scope for storage repair/gap scan operations."""
    symbols: list[str] = []


# ═══════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════


def _normalize_market_type(value: str | None) -> str:
    """Normalize API market type values to the internal canonical form."""
    return MarketType.from_str(value).value


def _normalize_exchange(value: str | None) -> str:
    """Normalize API exchange values to a canonical lowercase key."""
    return str(value or "binance").strip().lower() or "binance"


def _normalize_symbol_list(
    symbols: list[str] | None,
    exchange: str = "binance",
    market_type: str = "spot",
) -> list[str]:
    """Normalize a user-supplied symbol filter."""
    normalized: list[str] = []
    seen: set[str] = set()
    for symbol in symbols or []:
        sym = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
        if not sym or sym in seen:
            continue
        seen.add(sym)
        normalized.append(sym)
    return normalized


def _get_system_proxy() -> str | None:
    """Read proxy from environment variables, fallback to OS-level settings.

    On Windows, v2rayN / Clash etc. set the proxy in the registry
    (Internet Settings → ProxyServer) rather than env vars.

    Note: ``urllib.request.getproxies()`` short-circuits when
    ``getproxies_environment()`` returns any entry (e.g. ``no_proxy``),
    skipping ``getproxies_registry()`` entirely.  We call the registry
    reader directly on Windows to avoid this.
    """
    env_proxy = (
        os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or os.getenv("https_proxy")
        or os.getenv("http_proxy")
        or os.getenv("ALL_PROXY")
        or os.getenv("all_proxy")
    )
    if env_proxy:
        return env_proxy

    # Fallback: read from Windows registry / macOS scutil / etc.
    import sys
    if sys.platform == "win32":
        from urllib.request import getproxies_registry
        proxies = getproxies_registry()
    else:
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


def _get_data_engine_runtime(request: Request):
    """Return the app-wide DataEngineRuntime, if initialized."""
    return getattr(request.app.state, "data_engine_runtime", None)


def _get_ingestion_config(request: Request):
    """Get the IngestionConfig through the runtime facade."""
    runtime = _get_data_engine_runtime(request)
    if runtime is None:
        return None
    get_config = getattr(runtime, "get_ingestion_config", None)
    if not callable(get_config):
        return None
    return get_config()


async def _restart_runtime_transports(request: Request) -> None:
    """Restart runtime-owned transports after proxy config changes."""
    runtime = _get_data_engine_runtime(request)
    if runtime is None:
        return
    restart = getattr(runtime, "restart_transports", None)
    if callable(restart):
        await restart()


def _get_data_manager(request: Request):
    """Return the app-wide DataManager."""
    return getattr(request.app.state, "data_manager", None)


def _get_backfill_coordinator(request: Request):
    """Return the app-wide BackfillCoordinator through the runtime facade."""
    runtime = _get_data_engine_runtime(request)
    if runtime is None:
        return None
    get_coordinator = getattr(runtime, "get_backfill_coordinator", None)
    if not callable(get_coordinator):
        return None
    return get_coordinator()


def _get_backfill_engine(request: Request):
    """Return the app-wide BackfillEngine through the runtime facade."""
    runtime = _get_data_engine_runtime(request)
    if runtime is None:
        return None
    get_engine = getattr(runtime, "get_backfill_engine", None)
    if not callable(get_engine):
        return None
    return get_engine()


def _call_runtime_list(obj, method_name: str) -> list:
    method = getattr(obj, method_name, None)
    if not callable(method):
        return []
    try:
        return list(method())
    except Exception:
        logger.exception("Failed to read runtime list via %s", method_name)
        return []


def _model_field_was_set(model: BaseModel, field: str) -> bool:
    fields = getattr(model, "model_fields_set", None)
    if fields is None:
        fields = getattr(model, "__fields_set__", set())
    return field in fields


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.exists() else 0
    except OSError:
        logger.exception("Failed to stat %s", path)
        return 0


def _storage_file_snapshot() -> dict:
    db_path = Path(KLINES_DB_PATH)
    wal_path = Path(f"{db_path}-wal")
    shm_path = Path(f"{db_path}-shm")
    return {
        "path": str(db_path),
        "exists": db_path.exists(),
        "db_size_bytes": _file_size(db_path),
        "wal_size_bytes": _file_size(wal_path),
        "shm_size_bytes": _file_size(shm_path),
        "total_size_bytes": _file_size(db_path) + _file_size(wal_path) + _file_size(shm_path),
    }


def _storage_series_snapshot() -> dict:
    series = list_series_summaries()
    total_rows = sum(int(item.get("total_count", 0) or 0) for item in series)
    by_interval: dict[str, dict] = {}
    by_market: dict[str, dict] = {}
    largest_series = sorted(
        series,
        key=lambda item: int(item.get("total_count", 0) or 0),
        reverse=True,
    )[:12]
    for item in series:
        interval = str(item.get("interval") or "")
        market_key = f"{item.get('exchange', '')}:{item.get('market_type', '')}"
        rows = int(item.get("total_count", 0) or 0)
        interval_bucket = by_interval.setdefault(interval, {"series_count": 0, "total_rows": 0})
        interval_bucket["series_count"] += 1
        interval_bucket["total_rows"] += rows
        market_bucket = by_market.setdefault(market_key, {"series_count": 0, "total_rows": 0})
        market_bucket["series_count"] += 1
        market_bucket["total_rows"] += rows
    return {
        "series_count": len(series),
        "total_rows": total_rows,
        "by_interval": by_interval,
        "by_market": by_market,
        "largest_series": largest_series,
    }


async def _build_cache_diagnostics(request: Request) -> dict:
    dm = _get_data_manager(request)
    dm_snapshot = dm.snapshot() if dm is not None else None
    storage_files, storage_series = await asyncio.gather(
        run_storage(_storage_file_snapshot),
        run_storage(_storage_series_snapshot),
    )
    pyne_stats = pyne_cache.stats()
    runtime_pressure = (dm_snapshot or {}).get("runtimePressure") or {
        "disk": disk_pressure_snapshot(storage_files.get("path") or KLINES_DB_PATH),
    }
    retention_settings = (dm_snapshot or {}).get("retention", {})
    storage_watermarks = build_storage_watermarks(
        storage_files=storage_files,
        disk=(runtime_pressure or {}).get("disk") or {},
        sqlite_budget_bytes=retention_settings.get("sqlite_budget_bytes"),
    )
    return {
        "mode": "diagnostics",
        "runtimePressure": runtime_pressure,
        "data_manager": {
            "available": dm_snapshot is not None,
            "cache": (dm_snapshot or {}).get("cache", {}),
            "auto_gc": (dm_snapshot or {}).get("auto_gc", {}),
            "memory_gc": (dm_snapshot or {}).get("memory_gc", {}),
            "storage_gc": (dm_snapshot or {}).get("storage_gc", {}),
            "retention": retention_settings,
            "storage_intents": (dm_snapshot or {}).get("storage_intents", {}),
            "behavior_heat": (dm_snapshot or {}).get("behavior_heat", {}),
            "coordinator": (dm_snapshot or {}).get("coordinator", {}),
            "price_cache": (dm_snapshot or {}).get("price_cache", {}),
        },
        "storage": {
            "files": storage_files,
            "series": storage_series,
            "watermarks": storage_watermarks,
        },
        "indicator": {
            "pyne_cache": dict(pyne_stats) if isinstance(pyne_stats, dict) else {},
        },
    }


# ═══════════════════════════════════════════════════════════════
#  Endpoints
# ═══════════════════════════════════════════════════════════════


@router.get("/proxy")
async def get_proxy_settings(request: Request) -> dict:
    """Return the current proxy configuration."""
    cfg = _get_ingestion_config(request)

    if cfg is not None:
        mode, custom_proxy = normalize_proxy_settings(
            getattr(cfg, "proxy_mode", "system"),
            getattr(cfg, "http_proxy", None),
        )
    else:
        persisted = load_proxy_settings()
        mode, custom_proxy = normalize_proxy_settings(
            persisted.get("mode"),
            persisted.get("custom_proxy"),
        )

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
    mode, custom_proxy = normalize_proxy_settings(body.mode, body.custom_proxy)
    cfg = _get_ingestion_config(request)

    if cfg is None:
        # Even without IngestionConfig, persist the settings to disk
        save_proxy_settings(mode, custom_proxy)
        return {
            "status": "warning",
            "message": "IngestionConfig not available (DataManager not initialized). "
                       "Settings saved to disk for next startup.",
            "mode": mode,
            "custom_proxy": custom_proxy or "",
        }

    # Persist to disk so settings survive restarts
    save_proxy_settings(mode, custom_proxy)

    runtime = _get_data_engine_runtime(request)
    update_config = getattr(runtime, "update_ingestion_config", None)
    if callable(update_config):
        update_config(proxy_mode=mode, http_proxy=custom_proxy)
    else:
        cfg.update(proxy_mode=mode, http_proxy=custom_proxy)

    # Restart all active runtime transports to apply the new proxy.
    await _restart_runtime_transports(request)

    effective = _resolve_proxy_url(mode, custom_proxy)
    logger.info(
        "Proxy settings updated: mode=%s, effective=%s",
        mode, effective or "none",
    )

    return {
        "status": "ok",
        "mode": mode,
        "custom_proxy": custom_proxy or "",
        "effective_proxy": effective or "",
    }


@router.post("/proxy/test")
async def test_proxy_connection(body: ProxyTestRequest) -> dict:
    """Test proxy connectivity by making requests to all registered exchange APIs.

    Uses the provided proxy settings (not the current config) to
    test if the proxy works before the user commits the change.
    Returns per-exchange results so the user can see which exchanges
    are reachable.
    """
    proxy_url = _resolve_proxy_url(body.mode, body.custom_proxy)

    # Define test targets for each exchange
    test_targets = [
        {
            "exchange": "binance",
            "label": "Binance Spot",
            "url": "https://api.binance.com/api/v3/ping",
        },
        {
            "exchange": "binance_futures",
            "label": "Binance Futures",
            "url": "https://fapi.binance.com/fapi/v1/ping",
        },
        {
            "exchange": "okx",
            "label": "OKX",
            "url": "https://www.okx.com/api/v5/public/time",
        },
    ]

    async def _test_one(target: dict) -> dict:
        """Test a single exchange endpoint."""
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(target["url"], proxy=proxy_url) as resp:
                    status_code = resp.status
                    if status_code == 200:
                        return {
                            "exchange": target["exchange"],
                            "label": target["label"],
                            "success": True,
                            "status_code": status_code,
                            "message": "可达",
                        }
                    else:
                        resp_text = await resp.text()
                        return {
                            "exchange": target["exchange"],
                            "label": target["label"],
                            "success": False,
                            "status_code": status_code,
                            "message": f"HTTP {status_code}: {resp_text[:200]}",
                        }
        except aiohttp.ClientProxyConnectionError as exc:
            return {
                "exchange": target["exchange"],
                "label": target["label"],
                "success": False,
                "status_code": None,
                "message": f"代理连接失败: {exc}",
            }
        except aiohttp.ClientConnectorError as exc:
            return {
                "exchange": target["exchange"],
                "label": target["label"],
                "success": False,
                "status_code": None,
                "message": f"连接失败: {exc}",
            }
        except Exception as exc:
            return {
                "exchange": target["exchange"],
                "label": target["label"],
                "success": False,
                "status_code": None,
                "message": f"测试失败: {type(exc).__name__}: {exc}",
            }

    # Test all exchanges concurrently
    results = await asyncio.gather(*[_test_one(t) for t in test_targets])

    all_success = all(r["success"] for r in results)
    any_success = any(r["success"] for r in results)
    success_count = sum(1 for r in results if r["success"])
    total_count = len(results)

    if all_success:
        message = f"全部连接成功 — {total_count}/{total_count} 个交易所 API 可达"
    elif any_success:
        message = f"部分连接成功 — {success_count}/{total_count} 个交易所 API 可达"
    else:
        message = f"全部连接失败 — 0/{total_count} 个交易所 API 均不可达"

    return {
        "success": all_success,
        "partial": any_success and not all_success,
        "proxy_used": proxy_url or "(direct)",
        "message": message,
        "results": results,
    }


@router.post("/storage/repair")
async def repair_custom_storage(
    request: Request,
    body: StorageMaintenanceRequest | None = None,
    market_type: str = "spot",
    exchange: str = "binance",
) -> dict:
    """Check and rebuild stored custom-interval rows from authoritative base data."""
    exchange = _normalize_exchange(exchange)
    market_type = _normalize_market_type(market_type)
    symbols_filter = _normalize_symbol_list(
        body.symbols if body else [],
        exchange=exchange,
        market_type=market_type,
    )
    dm = _get_data_manager(request)
    backfill_coordinator = _get_backfill_coordinator(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")

    try:
        return await dm.repair_custom_storage(
            symbols_filter=symbols_filter,
            backfill_coordinator=backfill_coordinator,
            exchange=exchange,
            market_type=market_type,
        )
    except MaintenanceBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except MaintenanceUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/storage/gap-scan")
async def scan_and_fill_gaps(
    request: Request,
    body: StorageMaintenanceRequest | None = None,
    market_type: str = "spot",
    exchange: str = "binance",
) -> dict:
    """Scan all standard intervals for data gaps and fill them from Binance REST.

    This is a manual "repair all gaps" button.  Unlike the startup scan
    (which only checks prewarm intervals), this endpoint checks every
    standard interval that has data in storage and fills any gap larger than
    3 intervals.

    Returns a detailed report with per-interval results.
    """
    exchange = _normalize_exchange(exchange)
    market_type = _normalize_market_type(market_type)
    symbols_filter = _normalize_symbol_list(
        body.symbols if body else [],
        exchange=exchange,
        market_type=market_type,
    )
    dm = _get_data_manager(request)
    backfill_coordinator = _get_backfill_coordinator(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")

    try:
        return await dm.scan_and_fill_storage_gaps(
            symbols_filter=symbols_filter,
            backfill_coordinator=backfill_coordinator,
            exchange=exchange,
            market_type=market_type,
        )
    except MaintenanceBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except MaintenanceUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/storage/health")
async def storage_health(request: Request) -> dict:
    """Return gap repair health without triggering new repair work."""
    dm = _get_data_manager(request)
    backfill_coordinator = _get_backfill_coordinator(request)
    backfill_engine = _get_backfill_engine(request)
    if dm is None or backfill_coordinator is None:
        raise HTTPException(status_code=503, detail="DataEngine 尚未初始化")

    snapshot = backfill_coordinator.snapshot()
    engine_snapshot = (
        backfill_engine.snapshot()
        if backfill_engine is not None and callable(getattr(backfill_engine, "snapshot", None))
        else None
    )
    open_gaps = snapshot.get("gap_ledger_open") or []
    return {
        "status": "ok",
        "targets": _call_runtime_list(dm, "prewarm_targets"),
        "intervals": _call_runtime_list(dm, "prewarm_intervals"),
        "audit_series": _call_runtime_list(dm, "gap_audit_series"),
        "open_gap_count": len(open_gaps),
        "backfill": snapshot,
        "backfill_engine": engine_snapshot,
    }


@router.get("/cache-diagnostics")
async def cache_diagnostics(request: Request) -> dict:
    """Return read-only frontend-facing cache/storage diagnostics."""
    try:
        return await _build_cache_diagnostics(request)
    except Exception as exc:
        logger.exception("Cache diagnostics failed")
        raise HTTPException(status_code=500, detail=f"Cache diagnostics failed: {exc}") from exc


class CacheLimitsRequest(BaseModel):
    """Request body for updating data retention limits."""
    db_limits: dict[str, int] | None = None     # {"minutes": N, "hours": N, "daily": N}
    ephemeral_bars: int | None = None            # max bars for ephemeral series (1s)
    sqlite_budget_bytes: int | None = None
    storage_row_limits_enabled: bool | None = None


class BackendMemoryGcRequest(BaseModel):
    """Optional policy overrides for backend memory GC."""
    cold_idle_seconds: int | None = None
    max_total_bars: int | None = None
    max_series: int | None = None
    max_victims: int | None = None
    preserve_active: bool = True
    preserve_subscribed: bool = True
    ephemeral_keep_bars: int | None = None

    def policy(self) -> dict:
        values = {
            "cold_idle_seconds": self.cold_idle_seconds,
            "max_total_bars": self.max_total_bars,
            "max_series": self.max_series,
            "max_victims": self.max_victims,
            "preserve_active": self.preserve_active,
            "preserve_subscribed": self.preserve_subscribed,
            "ephemeral_keep_bars": self.ephemeral_keep_bars,
        }
        return {key: value for key, value in values.items() if value is not None}


class StorageGcRequest(BaseModel):
    """Optional policy overrides for SQLite storage GC dry-run."""
    db_limits: dict[str, int] | None = None
    sqlite_budget_bytes: int | None = None
    storage_row_limits_enabled: bool | None = None


class StorageGcRunRequest(BaseModel):
    """Confirmed request for SQLite storage GC execution."""
    confirm: bool = False
    db_limits: dict[str, int] | None = None
    sqlite_budget_bytes: int | None = None
    storage_row_limits_enabled: bool | None = None
    batch_size: int = 10_000


class StorageVacuumRequest(BaseModel):
    """Confirmed request for manual SQLite VACUUM."""
    confirm: bool = False


class AutoGcRunRequest(BaseModel):
    """Optional conservative auto GC policy overrides."""
    enabled: bool | None = None
    mode: str | None = None
    cooldown_ms: int | None = None
    max_bytes_per_run: int | None = None
    max_entries_per_run: int | None = None
    min_final_evict_score: float | None = None
    never_evict_active_within_ms: int | None = None
    never_evict_accessed_within_ms: int | None = None
    storage_batch_size: int | None = None
    sqlite_auto_vacuum: bool | None = None

    def policy(self) -> dict[str, Any]:
        values = self.model_dump() if hasattr(self, "model_dump") else self.dict()
        return {key: value for key, value in values.items() if value is not None}


class CacheAccessRecordRequest(BaseModel):
    """Frontend-origin cache access signal for behavior learning."""
    exchange: str = "binance"
    market_type: str | None = None
    marketType: str | None = None
    symbol: str
    interval: str = "*"
    action: str = "frontend-access"
    source: str = "frontend"
    weight: float | None = None
    detail: dict[str, Any] | None = None
    occurred_at_ms: int | None = None


@router.post("/cache-access")
async def record_cache_access(request: Request, body: CacheAccessRecordRequest) -> dict:
    """Record a lightweight frontend cache access signal."""
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    record = getattr(dm, "record_cache_access", None)
    if not callable(record):
        raise HTTPException(status_code=503, detail="DataManager 不支持 cache behavior learning")
    heat = await run_storage(
        record,
        body.symbol,
        body.interval,
        exchange=body.exchange,
        market_type=body.market_type or body.marketType or "spot",
        action=body.action,
        source=body.source,
        weight=body.weight,
        detail=body.detail,
        occurred_at_ms=body.occurred_at_ms,
    )
    return {
        "ok": True,
        "heat": heat,
    }


@router.post("/cache-gc/backend-memory/dry-run")
async def backend_memory_gc_dry_run(
    request: Request,
    body: BackendMemoryGcRequest | None = None,
) -> dict:
    """Plan DataManager memory cache cleanup without modifying cache state."""
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    plan = getattr(dm, "plan_memory_gc", None)
    if not callable(plan):
        raise HTTPException(status_code=503, detail="DataManager 不支持 memory GC")
    return await run_storage(plan, (body or BackendMemoryGcRequest()).policy())


@router.post("/cache-gc/backend-memory/run")
async def backend_memory_gc_run(
    request: Request,
    body: BackendMemoryGcRequest | None = None,
) -> dict:
    """Execute DataManager memory cache cleanup."""
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    run = getattr(dm, "run_memory_gc", None)
    if not callable(run):
        raise HTTPException(status_code=503, detail="DataManager 不支持 memory GC")
    return await run_storage(run, (body or BackendMemoryGcRequest()).policy())


@router.post("/cache-gc/auto/run")
async def auto_gc_run(
    request: Request,
    body: AutoGcRunRequest | None = None,
) -> dict:
    """Execute one conservative automatic GC pass without user confirmation."""
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    run = getattr(dm, "run_auto_gc", None)
    if not callable(run):
        raise HTTPException(status_code=503, detail="DataManager 不支持 auto GC")
    return await run((body or AutoGcRunRequest()).policy())


@router.post("/cache-gc/storage/dry-run")
async def storage_gc_dry_run(
    request: Request,
    body: StorageGcRequest | None = None,
) -> dict:
    """Plan SQLite retention cleanup without deleting rows."""
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    plan = getattr(dm, "plan_storage_gc", None)
    if not callable(plan):
        raise HTTPException(status_code=503, detail="DataManager 不支持 storage GC")
    file_snapshot = await run_storage(_storage_file_snapshot)
    return await run_storage(
        plan,
        db_limits=(body.db_limits if body else None),
        sqlite_budget_bytes=(body.sqlite_budget_bytes if body else None),
        storage_row_limits_enabled=(body.storage_row_limits_enabled if body else None),
        file_snapshot=file_snapshot,
    )


@router.post("/cache-gc/storage/run")
async def storage_gc_run(
    request: Request,
    body: StorageGcRunRequest,
) -> dict:
    """Execute SQLite retention cleanup with bounded batches."""
    if not body.confirm:
        raise HTTPException(status_code=400, detail="数据库清理需要 confirm=true")
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    run = getattr(dm, "run_storage_gc", None)
    if not callable(run):
        raise HTTPException(status_code=503, detail="DataManager 不支持 storage GC")
    try:
        file_snapshot = await run_storage(_storage_file_snapshot)
        report = await run(
            db_limits=body.db_limits,
            sqlite_budget_bytes=body.sqlite_budget_bytes,
            storage_row_limits_enabled=body.storage_row_limits_enabled,
            file_snapshot=file_snapshot,
            batch_size=body.batch_size,
        )
        report["storage_files_after"] = await run_storage(_storage_file_snapshot)
        return report
    except MaintenanceBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except MaintenanceUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/cache-gc/storage/vacuum")
async def storage_gc_vacuum(
    request: Request,
    body: StorageVacuumRequest,
) -> dict:
    """Run manual SQLite VACUUM. This can take time and lock the DB."""
    if not body.confirm:
        raise HTTPException(status_code=400, detail="VACUUM 需要 confirm=true")
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    vacuum = getattr(dm, "vacuum_storage", None)
    if not callable(vacuum):
        raise HTTPException(status_code=503, detail="DataManager 不支持 VACUUM")
    try:
        before = await run_storage(_storage_file_snapshot)
        report = await vacuum()
        report["storage_files_before"] = before
        report["storage_files_after"] = await run_storage(_storage_file_snapshot)
        return report
    except MaintenanceBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except MaintenanceUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/cache-limits")
async def update_cache_limits(request: Request, body: CacheLimitsRequest) -> dict:
    """Update data retention limits from frontend settings.

    Accepts:
      - db_limits: per-tier max bar counts for DB-persisted intervals
      - ephemeral_bars: max bar count for in-memory-only intervals (e.g. 1s)
      - sqlite_budget_bytes: soft SQLite file budget for budget-driven GC
      - storage_row_limits_enabled: enable per-tier hard row-limit cleanup

    The row limits are applied only when explicitly enabled. The ephemeral
    limit takes effect immediately (next trim cycle or on new series creation).
    """
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")

    sqlite_budget_bytes = (
        body.sqlite_budget_bytes
        if _model_field_was_set(body, "sqlite_budget_bytes") and body.sqlite_budget_bytes is not None
        else 0 if _model_field_was_set(body, "sqlite_budget_bytes")
        else None
    )
    dm.update_retention_limits(
        db_limits=body.db_limits,
        ephemeral_bars=body.ephemeral_bars,
        sqlite_budget_bytes=sqlite_budget_bytes,
        storage_row_limits_enabled=body.storage_row_limits_enabled,
    )

    return {
        "status": "ok",
        **dm.retention_snapshot(),
    }
