from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.exchanges import (
    bootstrap_default_adapters,
    get_exchange_registry,
    serialize_exchange_capabilities,
)
from app.exchanges.ccxt_ext.catalog import ccxt_catalog_summary
from app.exchanges.support import serialize_exchange_support

router = APIRouter(prefix="/exchanges", tags=["exchanges"])


def _serialize_plugin_capabilities(registry: object, plugin: object) -> dict:
    capabilities = registry.get_capabilities(plugin.id)
    payload = serialize_exchange_capabilities(capabilities)
    payload["support"] = serialize_exchange_support(plugin, capabilities)
    return payload


@router.get("/")
async def list_exchanges() -> dict:
    """List all registered exchanges and their capabilities."""
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    exchanges = [
        _serialize_plugin_capabilities(registry, plugin)
        for plugin in registry.list_plugins()
    ]
    return {
        "count": len(exchanges),
        "ccxt": ccxt_catalog_summary(),
        "exchanges": exchanges,
    }


@router.get("/diagnostics")
async def get_exchange_diagnostics() -> dict:
    """Return exchange plugin load status and compatibility diagnostics."""
    bootstrap_default_adapters()
    return get_exchange_registry().diagnostics()


@router.get("/{exchange}/capabilities")
async def get_exchange_capabilities(exchange: str) -> dict:
    """Return capabilities for a single registered exchange."""
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    try:
        plugin = registry.get_plugin(exchange)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _serialize_plugin_capabilities(registry, plugin)
