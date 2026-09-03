"""
Settings API routes — proxy configuration and connectivity test.

Provides endpoints for:
  * GET  /settings/proxy       — read current proxy configuration
  * PUT  /settings/proxy       — update proxy configuration at runtime
  * POST /settings/proxy/test  — test proxy connectivity to all exchanges
"""

from __future__ import annotations

from app.core.config import getenv as app_getenv

import asyncio
import logging
import time
from typing import Any

import aiohttp
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.config import KLINES_DB_PATH
from app.core.executors import run_storage
from app.core.market import MarketType
from app.core.config import (
    load_proxy_settings,
    normalize_proxy_settings,
    save_proxy_settings,
)
from app.exchanges.symbols import normalize_symbol
from app.data_engine.storage.klines_repo import list_series_summaries
from app.data_engine.data_manager.runtime_pressure import (
    build_storage_watermarks,
    disk_pressure_snapshot,
    storage_file_snapshot,
)
from app.data_engine.data_manager.cache_behavior import MAX_FUTURE_EVENT_SKEW_MS
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

    mode: str = "system"  # "none" | "system" | "custom"
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
        app_getenv("HTTPS_PROXY")
        or app_getenv("HTTP_PROXY")
        or app_getenv("https_proxy")
        or app_getenv("http_proxy")
        or app_getenv("ALL_PROXY")
        or app_getenv("all_proxy")
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


def _storage_file_snapshot() -> dict:
    return storage_file_snapshot(KLINES_DB_PATH)


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
        interval_bucket = by_interval.setdefault(
            interval, {"series_count": 0, "total_rows": 0}
        )
        interval_bucket["series_count"] += 1
        interval_bucket["total_rows"] += rows
        market_bucket = by_market.setdefault(
            market_key, {"series_count": 0, "total_rows": 0}
        )
        market_bucket["series_count"] += 1
        market_bucket["total_rows"] += rows
    return {
        "series_count": len(series),
        "total_rows": total_rows,
        "by_interval": by_interval,
        "by_market": by_market,
        "largest_series": largest_series,
    }


def _normalize_inventory_filter(value: str | None) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


def _build_storage_inventory_snapshot(
    *,
    exchange: str | None,
    market_type: str | None,
    symbol: str | None,
    interval: str | None,
    limit: int,
) -> dict:
    """Build a strictly read-only inventory snapshot for the data workbench."""
    series = list_series_summaries(read_only=True)

    def matches(item: dict) -> bool:
        if exchange and item.get("exchange") != exchange:
            return False
        if market_type and item.get("market_type") != market_type:
            return False
        if symbol and str(item.get("symbol") or "").upper() != symbol:
            return False
        if interval and item.get("interval") != interval:
            return False
        return True

    matched = [item for item in series if matches(item)]
    matched.sort(
        key=lambda item: (
            -int(item.get("total_count", 0) or 0),
            str(item.get("exchange") or ""),
            str(item.get("market_type") or ""),
            str(item.get("symbol") or ""),
            str(item.get("interval") or ""),
        )
    )
    returned = matched[:limit]
    storage_files = _storage_file_snapshot()

    return {
        "snapshot": storage_files,
        "inventory": {
            "total_series": len(series),
            "total_rows": sum(int(item.get("total_count", 0) or 0) for item in series),
            "matching_series": len(matched),
            "matching_rows": sum(int(item.get("total_count", 0) or 0) for item in matched),
            "returned_series": len(returned),
            "truncated": len(returned) < len(matched),
        },
        "series": [
            {
                "exchange": str(item.get("exchange") or ""),
                "market_type": str(item.get("market_type") or ""),
                "symbol": str(item.get("symbol") or ""),
                "interval": str(item.get("interval") or ""),
                "earliest_open_ms": item.get("earliest_open_time"),
                "latest_open_ms": item.get("latest_open_time"),
                "total_count": int(item.get("total_count", 0) or 0),
            }
            for item in returned
        ],
    }


def _manual_ownership_snapshot(request: Request) -> dict:
    """Read-only durable/transient ownership overlay.  Never writes."""
    dm = _get_data_manager(request)
    registry = getattr(dm, "durable_protections", None) if dm is not None else None
    clone = getattr(registry, "clone", None) if registry is not None else None
    if not callable(clone):
        return {"available": False, "series": []}
    floors = clone()
    series = []
    for key, floor in list(floors.items())[:500]:
        series.append({
            "exchange": key.exchange,
            "market_type": key.market_type,
            "symbol": key.symbol,
            "interval": key.interval,
            "protected_start_ms": floor.protected_start_ms,
            "manual_owner_count": floor.owner_count,
            "manual_protection": (
                "DURABLE" if floor.durable_owner_count else "TRANSIENT"
            ),
            "owners_truncated": False,
        })
    return {"available": True, "series": series}


async def _storage_integrity_snapshot(request: Request) -> dict:
    """Return known gap-ledger state without running any scan or repair."""
    backfill_coordinator = _get_backfill_coordinator(request)
    if backfill_coordinator is None:
        return {
            "available": False,
            "reason": "BackfillCoordinator 尚未初始化，不能将完整性状态视为正常",
        }

    try:
        snapshot_async = getattr(backfill_coordinator, "snapshot_async", None)
        snapshot = (
            await snapshot_async()
            if callable(snapshot_async)
            else backfill_coordinator.snapshot()
        )
        if not isinstance(snapshot, dict):
            raise TypeError("BackfillCoordinator returned an invalid snapshot")
    except Exception as exc:
        logger.exception("Storage integrity snapshot failed")
        return {
            "available": False,
            "reason": f"无法读取 gap ledger: {exc}",
        }

    try:
        ledger_health = snapshot.get("gap_ledger_health") or {}
        open_gaps = snapshot.get("gap_ledger_open") or []
        if not isinstance(ledger_health, dict) or not isinstance(open_gaps, list):
            raise TypeError("gap ledger snapshot has an invalid shape")

        def non_negative_int(value: Any) -> int:
            parsed = int(value or 0)
            if parsed < 0:
                raise ValueError("gap ledger count cannot be negative")
            return parsed

        def optional_non_negative_int(value: Any) -> int | None:
            if value is None:
                return None
            return non_negative_int(value)

        def count_map(value: Any) -> dict[str, int]:
            if not isinstance(value, dict):
                raise TypeError("gap ledger count map has an invalid shape")
            return {str(key): non_negative_int(count) for key, count in value.items()}

        gap_samples: list[dict] = []
        for item in open_gaps:
            if not isinstance(item, dict):
                raise TypeError("gap ledger sample has an invalid shape")
            gap_samples.append({
                "exchange": str(item.get("exchange") or ""),
                "market_type": str(item.get("market_type") or ""),
                "symbol": str(item.get("symbol") or ""),
                "interval": str(item.get("interval") or ""),
                "status": str(item.get("status") or "unknown"),
                "missing_bars": non_negative_int(item.get("missing_count")),
                "first_seen_at_ms": optional_non_negative_int(item.get("first_seen_at")),
                "last_checked_at_ms": optional_non_negative_int(item.get("last_checked_at")),
            })
        return {
            "available": True,
            "open_gap_count": non_negative_int(ledger_health.get("open_total", len(open_gaps))),
            "open_gap_by_status": count_map(ledger_health.get("by_status") or {}),
            "open_gap_age_buckets": count_map(ledger_health.get("age_buckets") or {}),
            "oldest_open_gap_at_ms": optional_non_negative_int(ledger_health.get("oldest_open_at")),
            "gap_samples": gap_samples,
            "sample_limit": non_negative_int(ledger_health.get("sample_limit", len(gap_samples))),
        }
    except (TypeError, ValueError) as exc:
        logger.warning("Storage integrity snapshot is invalid: %s", exc)
        return {
            "available": False,
            "reason": f"gap ledger 返回了无效状态: {exc}",
        }


async def _build_cache_diagnostics(request: Request) -> dict:
    dm = _get_data_manager(request)
    dm_snapshot = dm.snapshot() if dm is not None else None
    storage_files, storage_series = await asyncio.gather(
        run_storage(_storage_file_snapshot),
        run_storage(_storage_series_snapshot),
    )
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
            "pyne_cache": {
                "size": 0,
                "max_items": 0,
                "scope": "sidecar",
                "available_to_host": False,
            },
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
        mode,
        effective or "none",
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
    """Return storage/control-plane health without triggering repair work."""
    dm = _get_data_manager(request)
    backfill_coordinator = _get_backfill_coordinator(request)
    backfill_engine = _get_backfill_engine(request)
    if dm is None or backfill_coordinator is None:
        raise HTTPException(status_code=503, detail="DataEngine 尚未初始化")

    snapshot_async = getattr(backfill_coordinator, "snapshot_async", None)
    snapshot = (
        await snapshot_async()
        if callable(snapshot_async)
        else backfill_coordinator.snapshot()
    )
    engine_snapshot = (
        backfill_engine.snapshot()
        if backfill_engine is not None
        and callable(getattr(backfill_engine, "snapshot", None))
        else None
    )
    open_gaps = snapshot.get("gap_ledger_open") or []
    ledger_health = snapshot.get("gap_ledger_health") or {}
    control_snapshot = getattr(dm, "market_data_control_snapshot", None)
    market_data_control = (
        control_snapshot()
        if callable(control_snapshot)
        else {"status": "unavailable"}
    )
    storage_bootstrap = getattr(request.app.state, "market_storage_bootstrap", None)
    bootstrap_serializer = getattr(storage_bootstrap, "to_dict", None)
    if callable(bootstrap_serializer):
        storage_bootstrap = bootstrap_serializer()
    return {
        "status": "ok",
        "targets": _call_runtime_list(dm, "prewarm_targets"),
        "intervals": _call_runtime_list(dm, "prewarm_intervals"),
        "audit_series": _call_runtime_list(dm, "gap_audit_series"),
        "open_gap_count": int(ledger_health.get("open_total", len(open_gaps))),
        "open_gap_by_status": ledger_health.get("by_status", {}),
        "open_gap_age_buckets": ledger_health.get("age_buckets", {}),
        "oldest_open_gap_at": ledger_health.get("oldest_open_at"),
        "backfill": snapshot,
        "backfill_engine": engine_snapshot,
        "market_data_control": market_data_control,
        "storage_bootstrap": storage_bootstrap,
    }


@router.get("/storage/inventory")
async def storage_inventory(
    request: Request,
    exchange: str | None = None,
    market_type: str | None = None,
    symbol: str | None = None,
    interval: str | None = None,
    limit: int = Query(default=500, ge=1, le=1_000),
) -> dict:
    """Return a live, read-only SQLite inventory and known gap-ledger state.

    This endpoint intentionally performs no backfill, repair, delete, or
    compaction work.  When the integrity service is unavailable its state is
    reported as unavailable instead of being inferred as healthy.
    """
    normalized_exchange = _normalize_exchange(exchange) if exchange else None
    normalized_market_type = _normalize_market_type(market_type) if market_type else None
    normalized_symbol = _normalize_inventory_filter(symbol)
    if normalized_symbol:
        normalized_symbol = normalized_symbol.upper()
    normalized_interval = _normalize_inventory_filter(interval)
    try:
        inventory = await run_storage(
            _build_storage_inventory_snapshot,
            exchange=normalized_exchange,
            market_type=normalized_market_type,
            symbol=normalized_symbol,
            interval=normalized_interval,
            limit=limit,
        )
    except Exception as exc:
        logger.exception("Storage inventory failed")
        raise HTTPException(status_code=500, detail=f"Storage inventory failed: {exc}") from exc

    integrity = await _storage_integrity_snapshot(request)
    snapshot = inventory.get("snapshot") or {}
    ownership = _manual_ownership_snapshot(request)
    return {
        "status": "ok",
        "mode": "live",
        "read_only": True,
        "captured_at_ms": int(snapshot.get("captured_at_ms", time.time() * 1000) or 0),
        "filters": {
            "exchange": normalized_exchange,
            "market_type": normalized_market_type,
            "symbol": normalized_symbol,
            "interval": normalized_interval,
        },
        **inventory,
        "integrity": integrity,
        "manual_ownership": ownership,
    }


@router.get("/cache-diagnostics")
async def cache_diagnostics(request: Request) -> dict:
    """Return read-only frontend-facing cache/storage diagnostics."""
    try:
        return await _build_cache_diagnostics(request)
    except Exception as exc:
        logger.exception("Cache diagnostics failed")
        raise HTTPException(
            status_code=500, detail=f"Cache diagnostics failed: {exc}"
        ) from exc


class StoragePolicyRequest(BaseModel):
    """Validated shared storage-retention policy fields."""

    db_limits: dict[str, int] | None = None
    sqlite_budget_bytes: int | None = Field(default=None, ge=1, le=16 * 1024**4)
    storage_row_limits_enabled: bool | None = None

    @field_validator("db_limits")
    @classmethod
    def validate_db_limits(cls, value: dict[str, int] | None) -> dict[str, int] | None:
        if value is None:
            return None
        unknown = set(value) - {"minutes", "hours", "daily"}
        if unknown:
            raise ValueError(f"unsupported DB retention tiers: {sorted(unknown)}")
        for tier, limit in value.items():
            if isinstance(limit, bool) or not 0 <= int(limit) <= 100_000_000:
                raise ValueError(f"invalid DB retention limit for {tier}")
        return {tier: int(limit) for tier, limit in value.items()}


class CacheLimitsRequest(StoragePolicyRequest):
    """Request body for updating data retention limits."""

    ephemeral_bars: int | None = Field(default=None, ge=1, le=1_000_000)


class BackendMemoryGcRequest(BaseModel):
    """Optional policy overrides for backend memory GC."""

    cold_idle_seconds: int | None = Field(default=None, ge=0, le=30 * 24 * 60 * 60)
    max_total_bars: int | None = Field(default=None, ge=1, le=100_000_000)
    max_series: int | None = Field(default=None, ge=1, le=100_000)
    max_victims: int | None = Field(default=None, ge=1, le=10_000)
    preserve_active: bool = True
    preserve_subscribed: bool = True
    ephemeral_keep_bars: int | None = Field(default=None, ge=1, le=1_000_000)

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


class StorageGcRequest(StoragePolicyRequest):
    """Optional policy overrides for SQLite storage GC dry-run."""


class StorageGcRunRequest(StoragePolicyRequest):
    """Confirmed request for SQLite storage GC execution."""

    confirm: bool = False
    batch_size: int = Field(default=1_000, ge=1, le=1_000)


class StorageVacuumRequest(BaseModel):
    """Confirmed request for manual SQLite VACUUM."""

    confirm: bool = False


class AutoGcRunRequest(BaseModel):
    """Optional conservative auto GC policy overrides."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    mode: str | None = None
    cooldown_ms: int | None = Field(default=None, ge=10_000, le=24 * 60 * 60 * 1000)
    max_bytes_per_run: int | None = Field(default=None, ge=1, le=16 * 1024**3)
    max_entries_per_run: int | None = Field(default=None, ge=1, le=10_000)
    min_final_evict_score: float | None = Field(default=None, ge=0, le=1_000)
    never_evict_accessed_within_ms: int | None = Field(
        default=None, ge=0, le=7 * 24 * 60 * 60 * 1000
    )
    storage_batch_size: int | None = Field(default=None, ge=1, le=1_000)
    sqlite_auto_vacuum: bool | None = None

    @field_validator("sqlite_auto_vacuum")
    @classmethod
    def validate_sqlite_auto_vacuum(cls, value: bool | None) -> bool | None:
        if value:
            raise ValueError(
                "automatic SQLite VACUUM is unsupported; use the confirmed manual vacuum endpoint"
            )
        return value

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
    occurred_at_ms: int | None = Field(default=None, ge=0)


@router.post("/cache-access")
async def record_cache_access(request: Request, body: CacheAccessRecordRequest) -> dict:
    """Record a lightweight frontend cache access signal."""
    if (
        body.occurred_at_ms is not None
        and body.occurred_at_ms > int(time.time() * 1000) + MAX_FUTURE_EVENT_SKEW_MS
    ):
        raise HTTPException(
            status_code=422,
            detail="occurred_at_ms exceeds the allowed client clock skew",
        )
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    record = getattr(dm, "record_cache_access", None)
    if not callable(record):
        raise HTTPException(
            status_code=503, detail="DataManager 不支持 cache behavior learning"
        )
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
    policy = (body or BackendMemoryGcRequest()).policy()
    async_plan = getattr(dm, "plan_memory_gc_async", None)
    if callable(async_plan):
        return await async_plan(policy)
    plan = getattr(dm, "plan_memory_gc", None)
    if not callable(plan):
        raise HTTPException(status_code=503, detail="DataManager 不支持 memory GC")
    return plan(policy)


@router.post("/cache-gc/backend-memory/run")
async def backend_memory_gc_run(
    request: Request,
    body: BackendMemoryGcRequest | None = None,
) -> dict:
    """Execute DataManager memory cache cleanup."""
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    policy = (body or BackendMemoryGcRequest()).policy()
    async_run = getattr(dm, "run_memory_gc_async", None)
    if callable(async_run):
        return await async_run(policy)
    run = getattr(dm, "run_memory_gc", None)
    if not callable(run):
        raise HTTPException(status_code=503, detail="DataManager 不支持 memory GC")
    return run(policy)


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
    async_plan = getattr(dm, "plan_storage_gc_async", None)
    if callable(async_plan):
        return await async_plan(
            db_limits=(body.db_limits if body else None),
            sqlite_budget_bytes=(body.sqlite_budget_bytes if body else None),
            storage_row_limits_enabled=(
                body.storage_row_limits_enabled if body else None
            ),
            file_snapshot=file_snapshot,
        )
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
        if _model_field_was_set(body, "sqlite_budget_bytes")
        and body.sqlite_budget_bytes is not None
        else 0
        if _model_field_was_set(body, "sqlite_budget_bytes")
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
