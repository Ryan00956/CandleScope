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
import json
import logging

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

logger = logging.getLogger("candlescope.subscription_api")

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])


# ── Request / Response models ────────────────────────────────

class SetTierRequest(BaseModel):
    tier: str  # "full" | "price" | "none"


class SyncWatchlistRequest(BaseModel):
    """Symbols currently in the user's watchlist."""
    symbols: list[str]


# ── Helpers ──────────────────────────────────────────────────

def _get_sub_manager(request: Request):
    mgr = getattr(request.app.state, "subscription_manager", None)
    if mgr is None:
        raise HTTPException(503, "SubscriptionManager not initialized")
    return mgr


def _get_price_ticker(request: Request):
    return getattr(request.app.state, "price_ticker", None)


# ── REST endpoints ───────────────────────────────────────────


@router.get("/")
async def list_subscriptions(request: Request):
    """List all symbol subscriptions."""
    mgr = _get_sub_manager(request)
    return {"subscriptions": mgr.get_all()}


@router.get("/prices")
async def get_prices(request: Request):
    """Snapshot of current prices for all watched symbols."""
    pt = _get_price_ticker(request)
    if pt is None:
        return {"prices": []}
    return {"prices": pt.get_prices_snapshot()}


@router.post("/sync")
async def sync_watchlist(request: Request, body: SyncWatchlistRequest):
    """Sync watchlist symbols to the subscription system.

    Any symbol in the watchlist that has no subscription yet will be
    auto-registered as PRICE_ONLY so prices start flowing immediately.
    Symbols that were previously subscribed but are no longer in any
    watchlist are downgraded to NONE.
    """
    from app.data_engine.services.subscription_manager import SubscriptionTier

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
        return {"symbol": mgr.normalize_symbol(symbol), "tier": "none"}
    return sub.to_dict()


@router.put("/{symbol:path}")
async def set_subscription_tier(request: Request, symbol: str, body: SetTierRequest):
    """Set the subscription tier for a symbol (supports composite keys)."""
    from app.data_engine.services.subscription_manager import SubscriptionTier

    tier_str = body.tier.strip().lower()
    try:
        tier = SubscriptionTier(tier_str)
    except ValueError:
        raise HTTPException(400, f"Invalid tier: '{tier_str}'. Must be 'full', 'price', or 'none'.")

    mgr = _get_sub_manager(request)
    try:
        result = await mgr.set_tier(symbol, tier)
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
    arrive from PriceTickerService.
    """
    pt = getattr(websocket.app.state, "price_ticker", None)
    if pt is None:
        await websocket.accept()
        await websocket.send_json({"type": "error", "detail": "PriceTickerService not available"})
        await websocket.close(code=1011)
        return

    await websocket.accept()
    await websocket.send_json({"type": "connected"})

    queue: asyncio.Queue = asyncio.Queue(maxsize=500)

    async def _on_prices(ticks):
        try:
            data = [t.to_dict() for t in ticks]
            await queue.put(data)
        except asyncio.QueueFull:
            pass  # drop if consumer is too slow

    pt.on_price_update(_on_prices)

    try:
        # Task to forward price updates
        async def _forwarder():
            while True:
                batch = await queue.get()
                await websocket.send_json({"type": "prices", "data": batch})

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
        # Remove callback
        if _on_prices in pt._callbacks:
            pt._callbacks.remove(_on_prices)
        try:
            await websocket.close()
        except Exception:
            pass
