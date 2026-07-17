from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.exchanges import (
    bootstrap_default_adapters,
    get_exchange_registry,
    serialize_exchange_capabilities,
)

router = APIRouter(prefix="/exchanges", tags=["exchanges"])


@router.get("/")
async def list_exchanges() -> dict:
    """List all registered exchanges and their capabilities."""
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    exchanges = [
        serialize_exchange_capabilities(registry.get_capabilities(plugin.id))
        for plugin in registry.list_plugins()
    ]
    return {
        "count": len(exchanges),
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
    return serialize_exchange_capabilities(registry.get_capabilities(plugin.id))
