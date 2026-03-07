"""
Indicator API — powered by the new Indicator Engine.

Endpoints:
  GET  /indicators/registry           → list all registered indicator specs
  GET  /indicators/registry/{name}    → get single indicator spec
  POST /indicators/compute            → compute indicator on provided bars (new engine)

  # Preset-compatible endpoints (for frontend IndicatorPanel)
  GET  /indicators/presets            → list presets (maps to registry)
  GET  /indicators/presets/{id}       → get preset with script (maps to registry)
"""
from __future__ import annotations

import textwrap
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.data_engine.data_manager.models import BarData
from app.indicator import registry, IndicatorEngine, create_engine

router = APIRouter(prefix="/indicators", tags=["indicators"])

# Module-level engine singleton — reuses cached indicator instances across requests
_engine = create_engine()


# ── Pydantic models ──────────────────────────────────────────

class ComputeRequest(BaseModel):
    """Request body for indicator computation.

    Supports two modes:
      1. Engine mode: provide ``name`` + ``params`` → uses the new engine
      2. Script mode: provide ``script`` + ``params`` → legacy Python exec
    """
    name: str | None = Field(None, description="Indicator name (e.g. 'MA', 'MACD')")
    params: dict[str, Any] = Field(default_factory=dict, description="Indicator parameters")
    symbol: str = Field("UNKNOWN", description="Symbol for context")
    interval: str = Field("1m", description="Interval for context")
    ohlcv: list[dict[str, Any]] = Field(default_factory=list, description="OHLCV bar data array")
    script: str | None = Field(None, description="Legacy Python script (optional)")


# ═══════════════════════════════════════════════════════════════
#  Registry endpoints (new engine)
# ═══════════════════════════════════════════════════════════════

@router.get("/registry")
async def list_indicators():
    """Return all registered indicator specifications."""
    specs = registry.list_specs()
    return [s.to_dict() for s in specs]


@router.get("/registry/{name}")
async def get_indicator_spec(name: str):
    """Return the spec for a single indicator by name."""
    spec = registry.get_spec(name.upper())
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Indicator '{name}' not found")
    return spec.to_dict()


# ═══════════════════════════════════════════════════════════════
#  Preset-compatible endpoints (for frontend IndicatorPanel)
# ═══════════════════════════════════════════════════════════════

# Script templates that map indicator engine calls to the legacy
# script interface the frontend expects.  The frontend sends these
# scripts back in the compute endpoint, but we intercept them and
# route to the new engine instead.
_ENGINE_SCRIPT_MARKER = "# __ENGINE__:"


def _build_preset_script(name: str, spec_dict: dict) -> str:
    """Build a pseudo-script that the compute endpoint recognizes as engine-backed."""
    return f"{_ENGINE_SCRIPT_MARKER}{name}\n# This indicator is computed by the built-in engine.\n# Parameters are configured via the params panel."


def _spec_to_preset(spec_dict: dict) -> dict:
    """Convert an IndicatorSpec dict to the preset format the frontend expects."""
    name = spec_dict["name"]
    return {
        "id": name.lower(),
        "name": spec_dict.get("display_name") or name,
        "engineName": name,  # registry key for compute API (e.g. "BOLL", "MA")
        "description": spec_dict.get("description", ""),
        "category": spec_dict.get("category", ""),
        "script": _build_preset_script(name, spec_dict),
        "params": spec_dict.get("params", {}),
        "paramSchema": spec_dict.get("paramSchema", []),
        "outputs": spec_dict.get("outputs", []),
        "is_builtin": spec_dict.get("is_builtin", True),
        "defaultEnabled": name == "VOL",  # auto-enable volume
    }


@router.get("/presets")
async def list_presets():
    """List all indicator presets (maps registry → preset format for frontend)."""
    specs = registry.list_specs()
    return [_spec_to_preset(s.to_dict()) for s in specs]


@router.get("/presets/{preset_id}")
async def get_preset(preset_id: str):
    """Get a single preset with full script (maps registry → preset format)."""
    name = preset_id.upper()
    spec = registry.get_spec(name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Preset '{preset_id}' not found")
    return _spec_to_preset(spec.to_dict())


# ═══════════════════════════════════════════════════════════════
#  Compute endpoint — unified
# ═══════════════════════════════════════════════════════════════

@router.post("/compute")
async def compute(req: ComputeRequest):
    """Compute an indicator on the provided OHLCV data.

    Supports two modes:
      1. If ``name`` is provided (or script starts with ENGINE marker),
         uses the new indicator engine.
      2. If only ``script`` is provided, runs legacy Python exec mode.

    Returns ``{ok, error, lines, result}`` — ``lines`` is the flat list
    for direct frontend rendering, ``result`` is the full structured output.
    """
    # Determine which indicator to use
    indicator_name = req.name
    use_engine = indicator_name is not None

    # Check if script is an engine-backed pseudo-script
    if not use_engine and req.script and req.script.startswith(_ENGINE_SCRIPT_MARKER):
        first_line = req.script.split("\n")[0]
        indicator_name = first_line[len(_ENGINE_SCRIPT_MARKER):].strip().upper()
        use_engine = True

    if use_engine and indicator_name:
        return await _compute_engine(indicator_name, req)
    elif req.script:
        return await _compute_script(req)
    else:
        return {"ok": False, "error": "Provide either 'name' or 'script'", "lines": [], "result": None}


async def _compute_engine(name: str, req: ComputeRequest) -> dict:
    """Compute using the new indicator engine."""
    name = name.upper()

    if not registry.has(name):
        return {"ok": False, "error": f"Indicator '{name}' not registered", "lines": [], "result": None}

    ohlcv = req.ohlcv
    if not ohlcv:
        return {"ok": False, "error": "No OHLCV data provided", "lines": [], "result": None}
    if len(ohlcv) > 50_000:
        return {"ok": False, "error": "Too many data points (max 50000)", "lines": [], "result": None}

    try:
        bars = [BarData.from_dict(d) for d in ohlcv]
    except (KeyError, ValueError, TypeError) as exc:
        return {"ok": False, "error": f"Invalid OHLCV data: {exc}", "lines": [], "result": None}

    try:
        result = _engine.compute(
            symbol=req.symbol,
            interval=req.interval,
            indicator_name=name,
            params=req.params,
            bars=bars,
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc), "lines": [], "result": None}

    if result is None:
        return {"ok": False, "error": f"Indicator '{name}' computation returned None", "lines": [], "result": None}

    if result.error:
        return {"ok": False, "error": result.error, "lines": [], "result": result.to_dict()}

    return {
        "ok": True,
        "error": None,
        "lines": result.lines,  # flat list of output dicts for frontend
        "result": result.to_dict(),
    }


async def _compute_script(req: ComputeRequest) -> dict:
    """Compute using legacy Python script execution.

    Provides numpy arrays and an add_line() function to the script.
    """
    import numpy as np
    import math as _math

    ohlcv = req.ohlcv
    if not ohlcv:
        return {"ok": False, "error": "No OHLCV data provided", "lines": [], "result": None}
    if len(ohlcv) > 50_000:
        return {"ok": False, "error": "Too many data points (max 50000)", "lines": [], "result": None}

    # Build numpy arrays
    times = [d.get("time", 0) for d in ohlcv]
    opens = np.array([d.get("open", 0) for d in ohlcv], dtype=float)
    highs = np.array([d.get("high", 0) for d in ohlcv], dtype=float)
    lows = np.array([d.get("low", 0) for d in ohlcv], dtype=float)
    closes = np.array([d.get("close", 0) for d in ohlcv], dtype=float)
    volumes = np.array([d.get("volume", 0) for d in ohlcv], dtype=float)

    lines: list[dict] = []

    def add_line(
        data,
        color="#f59e0b",
        title="",
        line_width=2,
        line_style=0,
        overlay=True,
        type="line",
        pane=None,
        color_data=None,
    ):
        if pane is None:
            pane = "main" if overlay else "separate"

        points = []
        for i, val in enumerate(data):
            if val is None or (isinstance(val, float) and (np.isnan(val) or np.isinf(val))):
                continue
            points.append({"time": times[i], "value": float(val)})

        line_entry = {
            "name": title or f"Line {len(lines) + 1}",
            "color": color,
            "type": type,
            "pane": pane,
            "lineWidth": line_width,
            "lineStyle": line_style,
            "data": points,
        }
        if color_data:
            line_entry["colorData"] = color_data
        lines.append(line_entry)

    # Execute script
    script_globals = {
        "np": np,
        "math": _math,
        "open": opens,
        "high": highs,
        "low": lows,
        "close": closes,
        "volume": volumes,
        "time": times,
        "params": req.params or {},
        "add_line": add_line,
    }

    try:
        exec(req.script, script_globals)  # noqa: S102
    except Exception as exc:
        return {"ok": False, "error": f"Script error: {exc}", "lines": [], "result": None}

    return {"ok": True, "error": None, "lines": lines, "result": None}
