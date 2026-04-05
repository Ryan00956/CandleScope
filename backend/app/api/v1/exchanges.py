from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.exchanges import bootstrap_default_adapters, get_exchange_registry

router = APIRouter(prefix="/exchanges", tags=["exchanges"])


@router.get("/")
async def list_exchanges() -> dict:
    """List all registered exchanges and their capabilities."""
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    exchanges = [adapter.capabilities().to_dict() for adapter in registry.list()]
    return {
        "count": len(exchanges),
        "exchanges": exchanges,
    }


@router.get("/{exchange}/capabilities")
async def get_exchange_capabilities(exchange: str) -> dict:
    """Return capabilities for a single registered exchange."""
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    try:
        adapter = registry.get(exchange)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return adapter.capabilities().to_dict()
