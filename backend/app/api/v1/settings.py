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

import aiohttp
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core.market import MarketType
from app.core.config import load_proxy_settings, normalize_proxy_settings, save_proxy_settings
from app.exchanges.symbols import normalize_symbol
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


def _call_runtime_list(obj, method_name: str) -> list:
    method = getattr(obj, method_name, None)
    if not callable(method):
        return []
    try:
        return list(method())
    except Exception:
        logger.exception("Failed to read runtime list via %s", method_name)
        return []


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
    if dm is None or backfill_coordinator is None:
        raise HTTPException(status_code=503, detail="DataEngine 尚未初始化")

    snapshot = backfill_coordinator.snapshot()
    open_gaps = snapshot.get("gap_ledger_open") or []
    return {
        "status": "ok",
        "targets": _call_runtime_list(dm, "prewarm_targets"),
        "intervals": _call_runtime_list(dm, "prewarm_intervals"),
        "audit_series": _call_runtime_list(dm, "gap_audit_series"),
        "open_gap_count": len(open_gaps),
        "backfill": snapshot,
    }


class CacheLimitsRequest(BaseModel):
    """Request body for updating data retention limits."""
    db_limits: dict[str, int] | None = None     # {"minutes": N, "hours": N, "daily": N}
    ephemeral_bars: int | None = None            # max bars for ephemeral series (1s)


@router.post("/cache-limits")
async def update_cache_limits(request: Request, body: CacheLimitsRequest) -> dict:
    """Update data retention limits from frontend settings.

    Accepts:
      - db_limits: per-tier max bar counts for DB-persisted intervals
      - ephemeral_bars: max bar count for in-memory-only intervals (e.g. 1s)

    The DB limits are applied at next startup.  The ephemeral limit
    takes effect immediately (next trim cycle or on new series creation).
    """
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")

    dm.update_retention_limits(
        db_limits=body.db_limits,
        ephemeral_bars=body.ephemeral_bars,
    )

    return {
        "status": "ok",
        **dm.retention_snapshot(),
    }
