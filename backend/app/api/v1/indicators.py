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

import asyncio
import time
import textwrap
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.api.v1.stream_indicator_payloads import (
    IndicatorRangeEmptyError,
    IndicatorRangeNotReadyError,
    _replace_range_from_snapshot,
    compute_indicator_range_payload_async,
)
from app.api.v1.indicator_range_batch import (
    IndicatorRangeBatchJob,
    compute_indicator_range_batch_async,
)
from app.api.v1.stream_utils import (
    normalize_exchange as _normalize_exchange,
    normalize_market_type as _normalize_market_type,
    validate_ws_interval as _validate_interval_name,
)
from app.core import config
from app.core.executors import executors_snapshot, run_indicator, run_pyne_wait, run_storage
from app.core.runtime_metrics import ws_runtime_metrics
from app.data_engine.data_manager.models import BarData
from app.indicator import registry, IndicatorEngine, create_engine
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.pyne.cache import pyne_cache
from app.indicator.pyne import is_incremental_pyne_script
from app.indicator.pyne.executor import execute_pyne_script
from app.indicator.pyne.external_runtime import RuntimeBackendSnapshot, cache_stats
from app.indicator.script_identity import script_hash, short_script_hash
from app.indicator.engine import indicator_code_hash
from app.indicator.types import IndicatorKey
from app.indicator.pyne.security import PyneSecurityPolicy
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.serialization import (
    build_error_payload,
    serialize_indicator_result,
    serialize_pyne_result,
)

router = APIRouter(prefix="/indicators", tags=["indicators"])

# Module-level singletons
_engine = create_engine()
_custom_store = CustomIndicatorStore()


# ── Pydantic models ──────────────────────────────────────────

class ComputeRequest(BaseModel):
    """Request body for indicator computation.

    Supports two modes:
      1. Engine mode: provide ``name`` + ``params`` → uses the new engine
      2. Script mode: provide ``script`` + ``params`` → legacy Python exec
    """
    name: str | None = Field(None, description="Indicator name (e.g. 'MA', 'MACD')")
    mode: str | None = Field(None, description="'builtin' for engine mode or 'script' for Pyne mode")
    params: dict[str, Any] = Field(default_factory=dict, description="Indicator parameters")
    exchange: str = Field("binance", description="Exchange context")
    symbol: str = Field("UNKNOWN", description="Symbol for context")
    interval: str = Field("1m", description="Interval for context")
    market_type: str = Field("spot", description="Market type context")
    ohlcv: list[dict[str, Any]] = Field(default_factory=list, description="OHLCV bar data array")
    script: str | None = Field(None, description="Legacy Python script (optional)")
    securityMode: str | None = Field(None, description="'safe', 'research', or 'unsafe' for Pyne scripts")


class CustomIndicatorPayload(BaseModel):
    """Create/update payload for a user-defined indicator."""

    schemaVersion: int = Field(1, description="Custom indicator schema version")
    id: str | None = Field(None, description="Stable custom indicator id")
    kind: str = Field("script", description="'script' or 'custom'")
    name: str = Field(..., description="Display name")
    description: str = Field("", description="Description")
    script: str = Field(..., description="Pyne/Python script")
    params: dict[str, Any] = Field(default_factory=dict, description="Default params")
    paramSchema: list[dict[str, Any]] = Field(default_factory=list, description="Parameter schema")
    renderHints: dict[str, Any] = Field(default_factory=dict, description="Optional rendering hints")
    securityMode: str | None = Field(None, description="Preferred Pyne security mode")


class IndicatorRangeRequest(BaseModel):
    """HTTP request for server-side indicator history/range computation."""

    clientId: str = Field(..., description="Frontend indicator client id")
    kind: str | None = Field(None, description="'builtin', 'script', 'custom', or 'pyne'")
    exchange: str = Field("binance", description="Exchange context")
    marketType: str | None = Field(None, description="Camel-case market type context")
    market_type: str | None = Field(None, description="Snake-case market type context")
    symbol: str = Field("BTCUSDT", description="Trading symbol")
    interval: str = Field("1m", description="K-line interval")
    name: str | None = Field(None, description="Builtin indicator name or display name")
    customId: str | None = Field(None, description="Saved custom indicator id")
    customIndicatorId: str | None = Field(None, description="Saved custom indicator id alias")
    script: str | None = Field(None, description="Pyne/custom script")
    securityMode: str | None = Field(None, description="Pyne security mode")
    params: dict[str, Any] = Field(default_factory=dict, description="Indicator parameters")
    start: int = Field(..., description="Inclusive range start, unix seconds")
    end: int = Field(..., description="Inclusive range end, unix seconds")
    reason: str = Field("range", description="Client reason for the range compute")


class IndicatorRangeBatchRequest(BaseModel):
    """Same-series indicator range requests coalesced into one HTTP call."""

    requests: list[IndicatorRangeRequest] = Field(default_factory=list)


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

# ── Readable reference scripts for built-in indicators ───────
# These are equivalent Python scripts shown to users so they can
# understand the algorithm and use them as templates for custom
# indicators.  The engine marker on line 1 ensures compute still
# routes through the optimised C/engine path at runtime.

_PRESET_SCRIPTS: dict[str, str] = {
    "MA": textwrap.dedent("""\
        # __ENGINE__:MA
        indicator("MA", overlay=True)

        period = input.int(20, "Period", minval=1, maxval=500)
        src = input.source(close, "Source")
        line_color = input.color(color.orange, "Color")

        ma = ta.sma(src, period)
        plot(ma, title=f"MA({period})", color=line_color, overlay=True)
    """),

    "EMA": textwrap.dedent("""\
        # __ENGINE__:EMA
        indicator("EMA", overlay=True)

        period = input.int(20, "Period", minval=1, maxval=500)
        src = input.source(close, "Source")
        line_color = input.color(color.blue, "Color")

        ema_line = ta.ema(src, period)
        plot(ema_line, title=f"EMA({period})", color=line_color, overlay=True)
    """),

    "BOLL": textwrap.dedent("""\
        # __ENGINE__:BOLL
        indicator("BOLL", overlay=True)

        period = input.int(20, "Period", minval=1, maxval=500)
        mult = input.float(2.0, "Multiplier", minval=0.1, step=0.1)
        src = input.source(close, "Source")
        mid_color = input.color(color.orange, "Middle Color")
        upper_color = input.color(color.red, "Upper Color")
        lower_color = input.color(color.green, "Lower Color")
        fill_color = input.color(color.new(color.blue, 88), "Fill Color")

        upper, middle, lower = ta.bb(src, period, mult)
        upper_plot = plot(upper, title="BOLL Upper", color=upper_color, overlay=True)
        middle_plot = plot(middle, title=f"BOLL Mid({period})", color=mid_color, overlay=True)
        lower_plot = plot(lower, title="BOLL Lower", color=lower_color, overlay=True)
        fill(upper_plot, lower_plot, color=fill_color, title="BOLL Band")
    """),

    "RSI": textwrap.dedent("""\
        # __ENGINE__:RSI
        indicator("RSI", overlay=False)

        period = input.int(14, "Period", minval=1, maxval=200)
        src = input.source(close, "Source")
        line_color = input.color(color.purple, "Color")
        overbought = input.float(70.0, "Overbought", minval=0, maxval=100, step=1)
        oversold = input.float(30.0, "Oversold", minval=0, maxval=100, step=1)

        rsi_line = ta.rsi(src, period)
        plot(rsi_line, title=f"RSI({period})", color=line_color, overlay=False, pane="separate")
        hline(overbought, title="Overbought", color=color.red, pane="separate")
        hline(50, title="Middle", color=color.gray, pane="separate")
        hline(oversold, title="Oversold", color=color.green, pane="separate")
    """),

    "MACD": textwrap.dedent("""\
        # __ENGINE__:MACD
        indicator("MACD", overlay=False)

        fast_period = input.int(12, "Fast Period", minval=1, maxval=200)
        slow_period = input.int(26, "Slow Period", minval=1, maxval=300)
        signal_period = input.int(9, "Signal Period", minval=1, maxval=100)
        src = input.source(close, "Source")
        dif_color = input.color(color.blue, "DIF Color")
        dea_color = input.color(color.orange, "DEA Color")
        hist_up_color = input.color(color.green, "Histogram Up Color")
        hist_down_color = input.color(color.red, "Histogram Down Color")

        dif, dea, hist = ta.macd(src, fast_period, slow_period, signal_period)
        plot(dif, title="DIF", color=dif_color, overlay=False, pane="separate")
        plot(dea, title="DEA", color=dea_color, overlay=False, pane="separate")
        bar(hist, title="MACD Hist", color_up=hist_up_color, color_down=hist_down_color, pane="separate")
        hline(0, title="Zero", color=color.gray, pane="separate")
    """),

    "ATR": textwrap.dedent("""\
        # __ENGINE__:ATR
        indicator("ATR", overlay=False)

        period = input.int(14, "Period", minval=1, maxval=200)
        line_color = input.color(color.aqua, "Color")

        atr_line = ta.atr(period)
        plot(atr_line, title=f"ATR({period})", color=line_color, overlay=False, pane="separate")
    """),

    "VOL": textwrap.dedent("""\
        # __ENGINE__:VOL
        indicator("VOL", overlay=False)

        up_color = input.color(color.green, "Up Color")
        down_color = input.color(color.red, "Down Color")

        volume_colors = color.when(close >= open, up_color, down_color)
        plot(
            volume,
            title="VOL",
            color=volume_colors,
            style=plot.style_histogram,
            overlay=False,
            pane="volume",
        )
    """),
}


def _build_preset_script(name: str, spec_dict: dict) -> str:
    """Build a readable reference script for a built-in indicator.

    If a hand-written script is available in ``_PRESET_SCRIPTS``, return it.
    Otherwise fall back to a minimal engine-marker stub.
    """
    if name.upper() in _PRESET_SCRIPTS:
        return _PRESET_SCRIPTS[name.upper()]
    return f"{_ENGINE_SCRIPT_MARKER}{name}\n# This indicator is computed by the built-in engine.\n# Parameters are configured via the params panel."


def _spec_to_preset(spec_dict: dict) -> dict:
    """Convert an IndicatorSpec dict to the preset format the frontend expects."""
    name = spec_dict["name"]

    # Determine pane target from the actual indicator class metadata
    cls = registry.get(name)
    pane_target = "sub"  # default to sub-pane
    if cls is not None:
        try:
            instance = cls(params=spec_dict.get("params", {}))
            meta = instance.get_meta()
            if meta.pane.value == "main":
                pane_target = "main"
            else:
                pane_target = "sub"
        except Exception:
            pass

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
        "paneTarget": pane_target,  # "main" = overlay on price chart, "sub" = separate pane
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
#  Custom indicator CRUD
# ═══════════════════════════════════════════════════════════════

@router.get("/custom")
async def list_custom_indicators():
    """List all user-saved custom indicators."""
    try:
        return _custom_store.list()
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/custom")
async def save_custom_indicator(payload: CustomIndicatorPayload):
    """Create or update a user-saved custom indicator."""
    try:
        data = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
        return _custom_store.upsert(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/custom/{indicator_id}")
async def delete_custom_indicator(indicator_id: str):
    """Delete a user-saved custom indicator."""
    try:
        deleted = _custom_store.delete(indicator_id)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Custom indicator '{indicator_id}' not found")
    return {"ok": True, "id": indicator_id}


@router.get("/pyne/security")
async def get_pyne_security_policy():
    """Return the default Pyne security policy advertised to the UI."""
    return PyneSecurityPolicy.from_config().to_public_dict()


def _resolve_runtime_engine(request: Request | None) -> IndicatorEngine:
    """Prefer the app-wide runtime engine when the endpoint is called via ASGI."""
    if request is not None:
        try:
            engine = getattr(request.app.state, "indicator_engine", None)
            if isinstance(engine, IndicatorEngine):
                return engine
        except Exception:
            pass
    return _engine


def _build_diagnostics_snapshot(
    *,
    engine: IndicatorEngine,
    store: CustomIndicatorStore,
    range_service: IndicatorRangeResultService | None = None,
) -> dict[str, Any]:
    """Build a compact, stable diagnostics payload for support/debugging."""
    custom_error = None
    custom_count = 0
    try:
        custom_count = len(store.list())
    except ValueError as exc:
        custom_error = str(exc)

    policy = PyneSecurityPolicy.from_config().to_public_dict()

    return {
        "ok": True,
        "schemaVersion": 1,
        "generatedAt": int(time.time()),
        "registry": {
            "count": len(registry.list_names()),
            "indicators": registry.list_names(),
        },
        "engine": engine.snapshot(),
        "customIndicators": {
            "count": custom_count,
            "path": str(store.path),
            "error": custom_error,
        },
        "pyne": {
            "runtimeBackend": RuntimeBackendSnapshot.current().to_dict(),
            "security": policy,
            "executor": {
                "mode": config.PYNE_EXECUTOR_MODE,
                "timeoutSeconds": config.PYNE_EXEC_TIMEOUT_SECONDS,
                "processGraceSeconds": config.PYNE_PROCESS_GRACE_SECONDS,
            },
            "limits": {
                "maxBars": config.PYNE_MAX_BARS,
                "maxOutputSeries": config.PYNE_MAX_OUTPUT_SERIES,
                "maxOutputPoints": config.PYNE_MAX_OUTPUT_POINTS,
            },
            "cache": cache_stats() or pyne_cache.stats(),
        },
        "websocket": {
            "maxSubscriptions": config.INDICATOR_WS_MAX_SUBSCRIPTIONS,
            "queueSize": config.INDICATOR_WS_QUEUE_SIZE,
            "heartbeatSeconds": config.INDICATOR_WS_HEARTBEAT_SECONDS,
            "metrics": ws_runtime_metrics.snapshot(),
        },
        "executors": executors_snapshot(),
        "rangeCache": range_service.snapshot() if range_service is not None else None,
    }


@router.get("/diagnostics")
async def get_indicator_diagnostics(request: Request):
    """Return a read-only diagnostics snapshot for the indicator subsystem."""
    return _build_diagnostics_snapshot(
        engine=_resolve_runtime_engine(request),
        store=_custom_store,
        range_service=getattr(request.app.state, "indicator_range_service", None),
    )


# ═══════════════════════════════════════════════════════════════
#  HTTP range endpoint — chart history/backfill path
# ═══════════════════════════════════════════════════════════════

def _require_data_manager(request: Request):
    dm = getattr(request.app.state, "data_manager", None)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager not initialized")
    return dm


def _resolve_indicator_range_service(request: Request) -> IndicatorRangeResultService:
    service = getattr(request.app.state, "indicator_range_service", None)
    if isinstance(service, IndicatorRangeResultService):
        return service
    revision_registry = getattr(request.app.state, "indicator_series_revisions", None)
    service = IndicatorRangeResultService.from_config(revision_registry=revision_registry)
    request.app.state.indicator_range_service = service
    engine = getattr(request.app.state, "indicator_engine", None)
    if isinstance(engine, IndicatorEngine):
        service.bind_engine(engine)
    return service


def _resolve_backfill_coordinator(request: Request) -> Any | None:
    runtime = getattr(request.app.state, "data_engine_runtime", None)
    get_coordinator = getattr(runtime, "get_backfill_coordinator", None)
    if callable(get_coordinator):
        return get_coordinator()
    return getattr(request.app.state, "backfill_coordinator", None)


def _resolve_range_market_type(req: IndicatorRangeRequest) -> str:
    return _normalize_market_type(str(req.market_type or req.marketType or "spot"))


def _resolve_range_script(req: IndicatorRangeRequest) -> tuple[str, str, str | None]:
    script = req.script or ""
    custom_id = (req.customId or req.customIndicatorId or "").strip()
    name = req.name or req.clientId
    security_mode = req.securityMode
    if custom_id and not script.strip():
        try:
            record = _custom_store.get(custom_id)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        if record is None:
            raise LookupError(f"Custom indicator '{custom_id}' not found.")
        script = str(record.get("script") or "")
        name = str(req.name or record.get("name") or custom_id)
        if not req.params and isinstance(record.get("params"), dict):
            req.params.update(record["params"])
        if security_mode is None:
            security_mode = record.get("securityMode")
    return script, name, security_mode


def _build_range_meta(req: IndicatorRangeRequest) -> dict[str, Any]:
    exchange = _normalize_exchange(req.exchange)
    market_type = _resolve_range_market_type(req)
    symbol = req.symbol.upper().strip()
    interval = req.interval.strip()
    params = req.params if isinstance(req.params, dict) else {}
    kind = str(req.kind or "").strip().lower()
    script = req.script or ""
    name = (req.name or "").strip()
    custom_id = (req.customId or req.customIndicatorId or "").strip()
    indicator_name = name.upper()

    if not _validate_interval_name(interval):
        raise ValueError(f"Unsupported interval: {interval}.")

    is_script = kind in {"script", "custom", "pyne"} or bool(custom_id) or (script and not indicator_name)
    if is_script:
        script, display_name, security_mode = _resolve_range_script(req)
        if not script.strip():
            raise ValueError("Pyne script is required.")
        digest = script_hash(script)
        meta = {
            "kind": "script",
            "exchange": exchange,
            "symbol": symbol,
            "interval": interval,
            "market_type": market_type,
            "name": display_name,
            "customId": custom_id or None,
            "indicatorId": f"pyne:{exchange}:{market_type}:{symbol}:{interval}:{short_script_hash(script)}:{req.clientId}",
            "scriptHash": digest,
            "script": script,
            "params": params,
            "securityMode": security_mode,
        }
        try:
            if is_incremental_pyne_script(script):
                meta["scriptMode"] = "incremental"
        except SyntaxError:
            pass
        return meta

    if not indicator_name and script.startswith(_ENGINE_SCRIPT_MARKER):
        first_line = script.split("\n")[0]
        indicator_name = first_line[len(_ENGINE_SCRIPT_MARKER):].strip().upper()
    if not indicator_name:
        raise ValueError("Builtin indicator name is required.")
    if registry.get(indicator_name) is None:
        raise LookupError(f"Unknown builtin indicator: {indicator_name}.")
    code_hash = indicator_code_hash(indicator_name)
    key = IndicatorKey(
        symbol,
        interval,
        indicator_name,
        params,
        market_type=market_type,
        exchange=exchange,
        code_hash=code_hash,
    )
    return {
        "kind": "builtin",
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": indicator_name,
        "params": params,
        "indicatorId": key.uid,
        "codeHash": code_hash,
        "paramsHash": key.params_hash,
    }


@router.post("/range")
async def compute_range(req: IndicatorRangeRequest, request: Request):
    """Compute an indicator over a server-side K-line range.

    This is the chart history/backfill transport. Realtime updates remain on
    the indicator WebSocket; range requests return replace-range payloads.
    """
    client_id = str(req.clientId or "").strip()
    if not client_id:
        return build_error_payload(
            "INDICATOR_CLIENT_ID_REQUIRED",
            "clientId is required.",
            hint="每个指标历史请求都需要稳定 clientId，用于合并结果。",
        )
    start_s = int(req.start or 0)
    end_s = int(req.end or 0)
    if start_s <= 0 or end_s <= 0 or start_s > end_s:
        return build_error_payload(
            "INVALID_INDICATOR_RANGE",
            "start/end must be positive unix timestamps with start <= end",
            hint="请检查指标历史请求的 start/end 参数。",
        )

    try:
        meta = _build_range_meta(req)
        dm = _require_data_manager(request)
        range_service = _resolve_indicator_range_service(request)
        backfill_coordinator = _resolve_backfill_coordinator(request)
        record_access = getattr(dm, "record_cache_access", None)
        if callable(record_access):
            await run_storage(
                record_access,
                meta["symbol"],
                meta["interval"],
                exchange=meta["exchange"],
                market_type=meta["market_type"],
                action="indicator-range",
                source=meta.get("kind") or "indicator",
                detail={"clientId": client_id, "indicatorId": meta.get("indicatorId")},
            )
    except LookupError as exc:
        return build_error_payload(
            "INDICATOR_NOT_FOUND",
            str(exc),
            hint="请检查指标名称或自定义指标 id 是否存在。",
        )
    except ValueError as exc:
        return build_error_payload(
            "INVALID_INDICATOR_RANGE_REQUEST",
            str(exc),
            hint="请检查指标类型、周期、脚本和参数。",
        )

    try:
        async def _compute_uncached() -> dict[str, Any]:
            return await compute_indicator_range_payload_async(
                dm=dm,
                meta=meta,
                client_id=client_id,
                start_s=start_s,
                end_s=end_s,
                reason=req.reason or "range",
                backfill_coordinator=backfill_coordinator,
            )

        snapshot, cache_hit, data_revision = await range_service.get_or_compute(
            meta=meta,
            start=start_s,
            end=end_s,
            compute=_compute_uncached,
        )
        snapshot_range = snapshot.get("range") if isinstance(snapshot, dict) else None
        available_start = (
            int(snapshot_range.get("start", start_s))
            if isinstance(snapshot_range, dict)
            else start_s
        )
        available_end = (
            int(snapshot_range.get("end", end_s))
            if isinstance(snapshot_range, dict)
            else end_s
        )
        payload = _replace_range_from_snapshot(
            snapshot,
            reason=req.reason or "range",
            start_s=max(start_s, available_start),
            end_s=min(end_s, available_end),
        )
        payload["clientId"] = client_id
        payload["dataRevision"] = data_revision
        meta_payload = payload.get("meta")
        if not isinstance(meta_payload, dict):
            meta_payload = {}
            payload["meta"] = meta_payload
        meta_payload["dataRevision"] = data_revision
        payload["cacheHit"] = cache_hit
    except IndicatorRangeEmptyError as exc:
        payload = build_error_payload(
            "INDICATOR_RANGE_EMPTY",
            str(exc),
            hint=(
                "目标区间没有应生成的已收盘 K 线，无需继续重试。"
                if not exc.retryable
                else "目标区间暂时没有已收盘 K 线，等待下一根 K 线后会自动更新。"
            ),
        )
        availability = {
            "history_state": (
                exc.history_state
                or ("exhausted" if not exc.retryable else "pending")
            ),
            "complete": not exc.retryable,
            "retryable": exc.retryable,
            "terminal_reason": exc.terminal_reason,
            "earliest_available_ms": exc.earliest_available_ms,
            "availability_revision": exc.availability_revision,
            "excluded_ranges": exc.excluded_ranges,
        }
        payload.update(availability)
        payload["detail"] = {
            "range": {"start": start_s, "end": end_s},
            "availability": availability,
        }
        return payload
    except IndicatorRangeNotReadyError as exc:
        payload = build_error_payload(
            "INDICATOR_RANGE_NOT_READY",
            str(exc),
            hint="K 线历史仍在补齐；后端已等待对应修复任务，无需定时盲重试。",
        )
        payload["detail"] = {
            "range": {"start": start_s, "end": end_s},
            "backfillRequestIds": exc.request_ids,
            "waitedMs": exc.waited_ms,
        }
        return JSONResponse(status_code=202, content=payload)
    except RuntimeError as exc:
        payload = build_error_payload(
            "INDICATOR_RANGE_NOT_READY",
            str(exc),
            hint="K 线历史仍在补齐，稍后重试该指标区间。",
        )
        payload["detail"] = {
            "range": {"start": start_s, "end": end_s},
            "retryAfterMs": 3000,
        }
        return payload
    except ValueError as exc:
        payload = build_error_payload(
            "INDICATOR_RANGE_LIMIT",
            str(exc),
            hint="指标历史区间超过运行时限制，请缩小窗口或提高后端安全上限。",
        )
        payload["detail"] = {"range": {"start": start_s, "end": end_s}}
        return payload
    except Exception as exc:
        payload = build_error_payload(
            "INDICATOR_RANGE_COMPUTE_FAILED",
            str(exc),
            hint="指标历史区间计算失败，请检查指标参数或脚本。",
        )
        payload["detail"] = {"range": {"start": start_s, "end": end_s}}
        return payload
    return payload


def _batch_range_error_payload(
    exc: BaseException,
    *,
    start_s: int,
    end_s: int,
) -> dict[str, Any]:
    if isinstance(exc, IndicatorRangeEmptyError):
        payload = build_error_payload(
            "INDICATOR_RANGE_EMPTY",
            str(exc),
            hint=(
                "目标区间没有应生成的已收盘 K 线，无需继续重试。"
                if not exc.retryable
                else "目标区间暂时没有已收盘 K 线，等待下一根 K 线后会自动更新。"
            ),
        )
        availability = {
            "history_state": (
                exc.history_state
                or ("exhausted" if not exc.retryable else "pending")
            ),
            "complete": not exc.retryable,
            "retryable": exc.retryable,
            "terminal_reason": exc.terminal_reason,
            "earliest_available_ms": exc.earliest_available_ms,
            "availability_revision": exc.availability_revision,
            "excluded_ranges": exc.excluded_ranges,
        }
        payload.update(availability)
        payload["detail"] = {
            "range": {"start": start_s, "end": end_s},
            "availability": availability,
        }
        return payload
    elif isinstance(exc, IndicatorRangeNotReadyError):
        payload = build_error_payload(
            "INDICATOR_RANGE_NOT_READY",
            str(exc),
            hint="K 线历史仍在补齐；后端已等待对应修复任务，无需定时盲重试。",
        )
        payload["detail"] = {
            "range": {"start": start_s, "end": end_s},
            "backfillRequestIds": exc.request_ids,
            "waitedMs": exc.waited_ms,
        }
        return payload
    elif isinstance(exc, RuntimeError):
        payload = build_error_payload(
            "INDICATOR_RANGE_NOT_READY",
            str(exc),
            hint="K 线历史仍在补齐，等待完成事件后再请求该区间。",
        )
    elif isinstance(exc, ValueError):
        payload = build_error_payload(
            "INDICATOR_RANGE_LIMIT",
            str(exc),
            hint="指标历史区间超过运行时限制，请缩小窗口或提高后端安全上限。",
        )
    else:
        payload = build_error_payload(
            "INDICATOR_RANGE_COMPUTE_FAILED",
            str(exc),
            hint="指标历史区间计算失败，请检查指标参数或脚本。",
        )
    payload["detail"] = {"range": {"start": start_s, "end": end_s}}
    return payload


@router.post("/range/batch")
async def compute_range_batch(req: IndicatorRangeBatchRequest, request: Request):
    """Compute up to 32 same-series indicators with one shared K-line query."""
    if not req.requests or len(req.requests) > 32:
        return build_error_payload(
            "INVALID_INDICATOR_RANGE_BATCH",
            "requests must contain between 1 and 32 indicator range items.",
            hint="请把同一商品和周期下的指标合并为不超过 32 项的一批。",
        )

    jobs: list[IndicatorRangeBatchJob] = []
    try:
        dm = _require_data_manager(request)
        range_service = _resolve_indicator_range_service(request)
        backfill_coordinator = _resolve_backfill_coordinator(request)
        for item in req.requests:
            client_id = str(item.clientId or "").strip()
            start_s = int(item.start or 0)
            end_s = int(item.end or 0)
            if not client_id:
                raise ValueError("clientId is required for every batch item")
            if start_s <= 0 or end_s <= 0 or start_s > end_s:
                raise ValueError("every batch item requires positive start <= end")
            jobs.append(IndicatorRangeBatchJob(
                client_id=client_id,
                meta=_build_range_meta(item),
                start=start_s,
                end=end_s,
                reason=item.reason or "range",
            ))
        series_keys = {
            IndicatorRangeResultService.series_key_from_meta(job.meta)
            for job in jobs
        }
        if len(series_keys) != 1:
            raise ValueError("all batch items must use the same exchange/market/symbol/interval")

        first_meta = jobs[0].meta
        record_access = getattr(dm, "record_cache_access", None)
        if callable(record_access):
            await run_storage(
                record_access,
                first_meta["symbol"],
                first_meta["interval"],
                exchange=first_meta["exchange"],
                market_type=first_meta["market_type"],
                action="indicator-range-batch",
                source="indicator",
                detail={"clientIds": [job.client_id for job in jobs]},
            )
    except (LookupError, ValueError) as exc:
        return build_error_payload(
            "INVALID_INDICATOR_RANGE_BATCH",
            str(exc),
            hint="请检查批量指标的类型、商品、周期、脚本、参数和范围。",
        )

    computed = await compute_indicator_range_batch_async(
        dm=dm,
        jobs=jobs,
        range_service=range_service,
        backfill_coordinator=backfill_coordinator,
    )
    results = []
    for job, value in zip(jobs, computed, strict=True):
        payload = (
            _batch_range_error_payload(value, start_s=job.start, end_s=job.end)
            if isinstance(value, BaseException)
            else value
        )
        results.append({"clientId": job.client_id, "payload": payload})
    return {
        "schemaVersion": 1,
        "ok": all(item["payload"].get("ok") is not False for item in results),
        "type": "indicator.range_batch",
        "dataRevision": range_service.data_revision_for_meta(jobs[0].meta),
        "results": results,
    }


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
    mode = req.mode.strip().lower() if req.mode else None
    if mode and mode not in {"builtin", "script"}:
        return build_error_payload(
            "INVALID_MODE",
            "mode must be 'builtin' or 'script'",
            hint="内置指标使用 mode='builtin'，自定义 Pyne 脚本使用 mode='script'。",
        )

    indicator_name = req.name

    if mode == "script":
        if not req.script:
            return build_error_payload(
                "PYNE_SCRIPT_REQUIRED",
                "Script mode requires 'script'",
                hint="请提交 Pyne 脚本文本，或切换到 builtin 模式。",
            )
        return await _compute_script(req)

    if mode == "builtin":
        if not indicator_name and req.script and req.script.startswith(_ENGINE_SCRIPT_MARKER):
            first_line = req.script.split("\n")[0]
            indicator_name = first_line[len(_ENGINE_SCRIPT_MARKER):].strip().upper()
        if not indicator_name:
            return build_error_payload(
                "INDICATOR_NAME_REQUIRED",
                "Builtin mode requires 'name'",
                hint="请传入内置指标名称，例如 MA、MACD、RSI。",
            )
        return await _compute_engine(indicator_name, req)

    # Legacy mode: preserve old behavior for existing frontend/localStorage data.
    use_engine = indicator_name is not None
    if not use_engine and req.script and req.script.startswith(_ENGINE_SCRIPT_MARKER):
        first_line = req.script.split("\n")[0]
        indicator_name = first_line[len(_ENGINE_SCRIPT_MARKER):].strip().upper()
        use_engine = True

    if use_engine and indicator_name:
        return await _compute_engine(indicator_name, req)
    if req.script:
        return await _compute_script(req)
    return build_error_payload(
        "INDICATOR_REQUEST_EMPTY",
        "Provide either 'name' or 'script'",
        hint="内置指标传 name，自定义指标传 script。",
    )


async def _compute_engine(name: str, req: ComputeRequest) -> dict:
    """Compute using the new indicator engine."""
    name = name.upper()

    if not registry.has(name):
        return build_error_payload(
            "INDICATOR_NOT_FOUND",
            f"Indicator '{name}' not registered",
            hint="请检查指标名称是否存在于 /api/v1/indicators/registry。",
        )

    ohlcv = req.ohlcv
    if not ohlcv:
        return build_error_payload(
            "INVALID_OHLCV",
            "No OHLCV data provided",
            hint="请确认前端已经加载 K 线数据后再计算指标。",
        )
    if len(ohlcv) > 50_000:
        return build_error_payload(
            "INVALID_OHLCV",
            "Too many data points (max 50000)",
            hint="请缩小历史窗口，或为后端指标计算增加分页/窗口策略。",
        )

    try:
        bars = [BarData.from_dict(d) for d in ohlcv]
    except (KeyError, ValueError, TypeError) as exc:
        return build_error_payload(
            "INVALID_OHLCV",
            f"Invalid OHLCV data: {exc}",
            hint="OHLCV 每根 K 线需要包含 time/open/high/low/close/volume。",
        )

    try:
        result = await _run_indicator_http_compute(
            _compute_builtin_once,
            name,
            req,
            bars,
        )
    except asyncio.TimeoutError:
        return build_error_payload(
            "INDICATOR_COMPUTE_TIMEOUT",
            f"Indicator compute exceeded {config.INDICATOR_HTTP_TIMEOUT_SECONDS:g}s timeout",
            hint="指标计算超时，请缩小历史窗口或优化参数。",
        )
    except Exception as exc:
        return build_error_payload(
            "INDICATOR_COMPUTE_FAILED",
            str(exc),
            hint="内置指标计算失败，请检查参数类型和历史数据长度。",
        )

    if result is None:
        return build_error_payload(
            "INDICATOR_RESULT_EMPTY",
            f"Indicator '{name}' computation returned None",
        )

    return serialize_indicator_result(result)


async def _compute_script(req: ComputeRequest) -> dict:
    """Compute using Pyne runtime (with full legacy backward compatibility).

    The Pyne runtime provides a rich Pine-style namespace including
    ta.*, input.*, plot(), color.*, math.*, crossover(), etc.
    Legacy scripts using add_line() continue to work unchanged.
    """
    try:
        result = await _run_indicator_http_compute(
            execute_pyne_script,
            executor_kind="pyne",
            script=req.script,
            ohlcv=req.ohlcv,
            params=req.params or {},
            security_mode=req.securityMode,
        )
    except asyncio.TimeoutError:
        return build_error_payload(
            "PYNE_TIMEOUT",
            f"Pyne script exceeded {config.INDICATOR_HTTP_TIMEOUT_SECONDS:g}s HTTP timeout",
            hint="脚本执行超时，请减少循环、缩小窗口，或调整 INDICATOR_HTTP_TIMEOUT_SECONDS。",
        )

    payload = serialize_pyne_result(result)
    payload["scriptHash"] = script_hash(req.script or "")
    return payload


async def _run_indicator_http_compute(func, *args, executor_kind: str = "indicator", **kwargs):
    """Run heavy HTTP indicator work off the event loop with a hard wait cap."""
    runner = run_pyne_wait if executor_kind == "pyne" else run_indicator
    return await asyncio.wait_for(
        runner(func, *args, **kwargs),
        timeout=max(float(config.INDICATOR_HTTP_TIMEOUT_SECONDS), 0.1),
    )


def _compute_builtin_once(name: str, req: ComputeRequest, bars: list[BarData]):
    """Compute a builtin indicator without touching the runtime IndicatorEngine.

    HTTP compute is one-shot work. Using a temporary engine keeps it isolated
    from the app-wide realtime IndicatorEngine, whose cached instances are
    mutated by WebSocket subscriptions and DataManager events.
    """
    engine = create_engine()
    try:
        return engine.compute(
            symbol=req.symbol,
            interval=req.interval,
            market_type=req.market_type,
            indicator_name=name,
            params=req.params,
            bars=bars,
            exchange=req.exchange,
        )
    finally:
        engine.stop()
