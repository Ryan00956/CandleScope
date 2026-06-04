"""
Subscription & Price API routes.

Endpoints:
  * GET  /subscriptions            — list all subscriptions
  * GET  /subscriptions/:symbol    — get tier for a symbol
  * PUT  /subscriptions/:symbol    — set tier for a symbol
  * DELETE /subscriptions/:symbol  — remove subscription
  * GET  /subscriptions/prices     — snapshot of current prices
  * WS   /stream/prices            — real-time price push
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.data_engine.data_manager.models import DataEventType
from app.data_engine.data_manager.subscriptions import SubscriptionTier

logger = logging.getLogger("candlescope.subscription_api")

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])


# ── Request / Response models ────────────────────────────────

class SetTierRequest(BaseModel):
    tier: str  # "full" | "price" | "none"
    intervals: list[str] | None = None
    consumer_id: str | None = None


class SyncWatchlistRequest(BaseModel):
    """Symbols currently in the user's watchlist."""
    symbols: list[str]


# ── Helpers ──────────────────────────────────────────────────

def _get_sub_manager(request: Request):
    dm = getattr(request.app.state, "data_manager", None)
    get_service = getattr(dm, "get_subscription_service", None) if dm is not None else None
    mgr = get_service() if callable(get_service) else None
    if mgr is None:
        raise HTTPException(503, "SubscriptionService not initialized")
    return mgr


def _get_data_manager(request: Request):
    dm = getattr(request.app.state, "data_manager", None)
    if dm is None:
        raise HTTPException(503, "DataManager not initialized")
    return dm


# ── REST endpoints ───────────────────────────────────────────


@router.get("/")
async def list_subscriptions(request: Request):
    """List all symbol subscriptions."""
    mgr = _get_sub_manager(request)
    return {"subscriptions": mgr.get_all()}


@router.get("/prices")
async def get_prices(request: Request):
    """Snapshot of current prices for all watched symbols."""
    dm = _get_data_manager(request)
    return {"prices": dm.get_prices_snapshot()}


@router.post("/sync")
async def sync_watchlist(request: Request, body: SyncWatchlistRequest):
    """Sync watchlist symbols to the subscription system.

    Any symbol in the watchlist that has no subscription yet will be
    auto-registered as PRICE_ONLY so prices start flowing immediately.
    Symbols that were previously subscribed but are no longer in any
    watchlist are downgraded to NONE.
    """
    mgr = _get_sub_manager(request)
    watchlist_set = {
        mgr.normalize_symbol(s)
        for s in body.symbols
        if s.strip()
    }

    # Auto-register new symbols as PRICE_ONLY
    results = []
    for sym in watchlist_set:
        current = mgr.get_tier(sym)
        if current == SubscriptionTier.NONE:
            r = await mgr.set_tier(sym, SubscriptionTier.PRICE_ONLY)
            results.append(r)

    # Downgrade removed symbols (symbols in backend but not in watchlist)
    for sub in mgr.get_all():
        if sub["symbol"] not in watchlist_set and sub["tier"] != "none":
            await mgr.set_tier(sub["symbol"], SubscriptionTier.NONE)

    return {"synced": len(watchlist_set), "auto_registered": len(results)}


@router.get("/{symbol:path}")
async def get_subscription(request: Request, symbol: str):
    """Get subscription info for a symbol (supports composite keys like 'spot:BTCUSDT')."""
    mgr = _get_sub_manager(request)
    sub = mgr.get(symbol)
    if sub is None:
        return {"symbol": mgr.normalize_symbol(symbol), "tier": "none", "intervals": []}
    return sub.to_dict()


@router.put("/{symbol:path}")
async def set_subscription_tier(request: Request, symbol: str, body: SetTierRequest):
    """Set the subscription tier for a symbol (supports composite keys)."""
    tier_str = body.tier.strip().lower()
    try:
        tier = SubscriptionTier(tier_str)
    except ValueError:
        raise HTTPException(400, f"Invalid tier: '{tier_str}'. Must be 'full', 'price', or 'none'.")

    mgr = _get_sub_manager(request)
    try:
        result = await mgr.set_tier(
            symbol,
            tier,
            intervals=body.intervals,
            consumer_id=body.consumer_id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return result


@router.delete("/{symbol:path}")
async def remove_subscription(request: Request, symbol: str):
    """Remove a symbol subscription entirely."""
    mgr = _get_sub_manager(request)
    await mgr.remove(symbol)
    return {"symbol": mgr.normalize_symbol(symbol), "removed": True}


# ── WebSocket: real-time price stream ────────────────────────

# This is registered on the /stream router in stream.py or can be
# mounted independently.  We define a standalone WS router here.

price_ws_router = APIRouter(prefix="/stream", tags=["stream"])


@price_ws_router.websocket("/prices")
async def price_stream(websocket: WebSocket):
    """Push real-time price ticks to the frontend.

    The client connects, and we send batches of price updates as they
    arrive on the DataManager event bus.
    """
    dm = getattr(websocket.app.state, "data_manager", None)
    if dm is None:
        await websocket.accept()
        await websocket.send_json({"type": "error", "detail": "DataManager not available"})
        await websocket.close(code=1011)
        return

    await websocket.accept()
    await websocket.send_json({"type": "connected"})
    await websocket.send_json({"type": "prices", "data": dm.get_prices_snapshot()})

    try:
        # Task to forward price updates
        async def _forwarder():
            async for event in dm.subscribe_iter(
                event_types={DataEventType.PRICE_UPDATED},
            ):
                price = event.detail.get("price")
                if price is None:
                    continue
                await websocket.send_json({"type": "prices", "data": [price]})

        # Task to read client messages (keepalive pings)
        async def _reader():
            while True:
                msg = await websocket.receive_text()
                if msg == "ping":
                    await websocket.send_text("pong")

        forward_task = asyncio.create_task(_forwarder())
        reader_task = asyncio.create_task(_reader())

        done, pending = await asyncio.wait(
            {forward_task, reader_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
        for t in done:
            try:
                t.result()
            except (WebSocketDisconnect, Exception):
                pass

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("Price WS error: %s", exc)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
