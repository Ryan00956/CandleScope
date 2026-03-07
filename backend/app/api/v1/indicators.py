"""
Indicator API routes.

- GET  /indicators/presets          → list built-in presets
- GET  /indicators/custom           → list user-saved custom indicators
- POST /indicators/custom           → create / update custom indicator
- DELETE /indicators/custom/{id}    → delete custom indicator
- POST /indicators/compute          → run indicator script against OHLCV data
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.indicators import (
    PRESET_INDICATORS,
    compute_indicator,
    delete_custom_indicator,
    get_custom_indicator,
    get_preset_by_id,
    list_custom_indicators,
    save_custom_indicator,
)

router = APIRouter(prefix="/indicators", tags=["indicators"])


# ── Pydantic models ──────────────────────────────────────────

class ComputeRequest(BaseModel):
    script: str = Field(..., description="Python indicator script")
    ohlcv: list[dict[str, Any]] = Field(..., description="OHLCV data array")
    params: dict[str, Any] | None = Field(None, description="Extra parameters injected into the script")


class SaveCustomRequest(BaseModel):
    id: str | None = Field(None, description="Indicator id (omit to create new)")
    name: str = Field(..., min_length=1, max_length=100)
    script: str = Field(..., min_length=1)
    description: str = Field("", max_length=500)
    params: dict[str, Any] | None = None
    paramSchema: list[dict[str, Any]] | None = None


# ── Preset endpoints ─────────────────────────────────────────

@router.get("/presets")
async def get_presets():
    """Return all built-in indicator presets (name, id, category, paramSchema, etc.)."""
    # Don't expose the actual script to the listing — frontend only needs metadata
    result = []
    for p in PRESET_INDICATORS:
        entry = {
            "id": p["id"],
            "name": p["name"],
            "description": p.get("description", ""),
            "category": p.get("category", ""),
            "params": p.get("params", {}),
            "paramSchema": p.get("paramSchema", []),
        }
        if p.get("defaultEnabled"):
            entry["defaultEnabled"] = True
        result.append(entry)
    return result


@router.get("/presets/{preset_id}")
async def get_preset(preset_id: str):
    """Return full preset detail including script source."""
    p = get_preset_by_id(preset_id)
    if not p:
        raise HTTPException(status_code=404, detail=f"Preset '{preset_id}' not found")
    return p


# ── Custom indicator CRUD ────────────────────────────────────

@router.get("/custom")
async def list_custom():
    """Return all user-saved custom indicators."""
    return list_custom_indicators()


@router.post("/custom")
async def save_custom(req: SaveCustomRequest):
    """Create or update a custom indicator."""
    saved = save_custom_indicator(
        name=req.name,
        script=req.script,
        indicator_id=req.id,
        params=req.params,
        param_schema=req.paramSchema,
        description=req.description,
    )
    return saved


@router.delete("/custom/{indicator_id}")
async def delete_custom(indicator_id: str):
    """Delete a custom indicator."""
    ok = delete_custom_indicator(indicator_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Indicator not found")
    return {"deleted": True, "id": indicator_id}


# ── Compute endpoint ─────────────────────────────────────────

@router.post("/compute")
async def compute(req: ComputeRequest):
    """Execute an indicator script against the provided OHLCV data.

    Returns computed line data ready for lightweight-charts rendering.
    """
    if len(req.ohlcv) > 50000:
        raise HTTPException(status_code=400, detail="Too many data points (max 50000)")

    result = await asyncio.to_thread(
        compute_indicator,
        script=req.script,
        ohlcv_data=req.ohlcv,
        params=req.params,
        timeout=10,
    )

    if result.get("error"):
        return {
            "ok": False,
            "error": result["error"],
            "lines": [],
        }

    return {
        "ok": True,
        "error": None,
        "lines": result["lines"],
    }
