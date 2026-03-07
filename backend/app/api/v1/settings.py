"""
Settings API routes — proxy configuration and connectivity test.

Provides endpoints for:
  * GET  /settings/proxy       — read current proxy configuration
  * PUT  /settings/proxy       — update proxy configuration at runtime
  * POST /settings/proxy/test  — test proxy connectivity to Binance
"""
from __future__ import annotations

import logging
import os

import aiohttp
from fastapi import APIRouter, Request
from pydantic import BaseModel

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
