"""Indicator WebSocket payload and range computation helpers."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from app.core import config
from app.core.executors import run_indicator, run_pyne_wait
from app.data_engine.interval_policy import parse_interval_ms
from app.indicator import create_engine
from app.indicator.errors import error_detail
from app.indicator.events import IndicatorEvent, IndicatorEventType
from app.indicator.pyne import (
    PyneIncrementalSession,
    PyneIncrementalSessionManager,
    PyneResult,
    SharedPyneIncrementalSession,
)
from app.indicator.pyne.executor import execute_pyne_script
from app.indicator.pyne.security import PyneSecurityError, PyneTimeoutError
from app.indicator.serialization import (
    build_indicator_snapshot_payload,
    build_pyne_snapshot_payload,
    build_ws_error_payload,
)

INDICATOR_DEFAULT_PAGE_BARS = 500
INDICATOR_MAX_RANGE_BARS = 5000
_pyne_incremental_sessions = PyneIncrementalSessionManager()


def _clamp_indicator_bars(value: Any, default: int = INDICATOR_DEFAULT_PAGE_BARS) -> int:
    try:
        bars = int(value)
    except (TypeError, ValueError):
        bars = default
    return min(max(bars, 1), INDICATOR_MAX_RANGE_BARS)


def _indicator_warmup_bars(name: str, params: dict[str, Any]) -> int:
    normalized = str(name or "").upper().strip()

    def _param_int(key: str, fallback: int) -> int:
        try:
            return max(1, int(params.get(key, fallback)))
        except (TypeError, ValueError):
            return fallback

    if normalized == "VOL":
        return 0
    if normalized in {"MA", "SMA", "BOLL"}:
        return max(0, _param_int("period", 20) - 1)
    if normalized in {"RSI", "ATR"}:
        return _param_int("period", 14) * 3
    if normalized == "EMA":
        return _param_int("period", 20) * 5
    if normalized == "MACD":
        return _param_int("slow", 26) * 5 + _param_int("signal", 9) * 3
    return _param_int("warmup", 200)


def _range_from_indicator_command(
    *,
    action: str,
    msg: dict,
    interval: str,
) -> tuple[int, int, int]:
    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0:
        raise ValueError(f"Unsupported interval: {interval}")
    interval_s = interval_ms // 1000

    if action == "load_before":
        before = int(msg.get("before") or 0)
        if before <= 0:
            raise ValueError("before must be a positive unix timestamp")
        bars = _clamp_indicator_bars(msg.get("bars"))
        end_s = before - interval_s
        start_s = end_s - (bars - 1) * interval_s
        return start_s, end_s, bars

    start_s = int(msg.get("start") or 0)
    end_s = int(msg.get("end") or 0)
    if start_s <= 0 or end_s <= 0 or start_s > end_s:
        raise ValueError("start/end must be positive unix timestamps with start <= end")
    bars = ((end_s - start_s) // interval_s) + 1
    if bars > INDICATOR_MAX_RANGE_BARS:
        raise ValueError(f"range too large: {bars} bars > {INDICATOR_MAX_RANGE_BARS}")
    return start_s, end_s, int(bars)


def _missing_overlaps_target(missing_ranges: list[Any], start_ms: int, end_ms: int) -> bool:
    for missing in missing_ranges or []:
        m_start = getattr(missing, "start_ms", None)
        m_end = getattr(missing, "end_ms", None)
        if m_start is None or m_end is None:
            continue
        if int(m_start) <= end_ms and int(m_end) >= start_ms:
            return True
    return False


def _filter_points_to_range(points: list[dict[str, Any]], start_s: int, end_s: int) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    for point in points or []:
        try:
            ts = int(point.get("time"))
        except (TypeError, ValueError):
            continue
        if start_s <= ts <= end_s:
            filtered.append(point)
    return filtered


def _filter_payload_to_range(payload: dict[str, Any], start_s: int, end_s: int) -> dict[str, Any]:
    """Trim a snapshot-like indicator payload down to a range patch."""
    next_payload = dict(payload)

    if isinstance(next_payload.get("lines"), list):
        next_payload["lines"] = [
            {
                **line,
                "data": _filter_points_to_range(line.get("data") or [], start_s, end_s),
                **(
                    {"colorData": _filter_points_to_range(line.get("colorData") or [], start_s, end_s)}
                    if line.get("colorData")
                    else {}
                ),
            }
            for line in next_payload["lines"]
        ]

    if isinstance(next_payload.get("series"), list):
        series = []
        for item in next_payload["series"]:
            style = dict(item.get("style") or {})
            if style.get("colorData"):
                style["colorData"] = _filter_points_to_range(style.get("colorData") or [], start_s, end_s)
            series.append({
                **item,
                "data": _filter_points_to_range(item.get("data") or [], start_s, end_s),
                "style": style,
            })
        next_payload["series"] = series

    if isinstance(next_payload.get("annotations"), list):
        annotations = []
        for item in next_payload["annotations"]:
            data = item.get("data") or []
            if data and isinstance(data[0], dict) and "time" in data[0]:
                data = _filter_points_to_range(data, start_s, end_s)
            annotations.append({**item, "data": data})
        next_payload["annotations"] = annotations

    for key in ("markers", "bgcolors", "barcolors", "signals"):
        if isinstance(next_payload.get(key), list):
            next_payload[key] = [
                {**group, "data": _filter_points_to_range(group.get("data") or [], start_s, end_s)}
                for group in next_payload[key]
            ]

    return next_payload


def _patch_from_snapshot(
    payload: dict[str, Any],
    *,
    reason: str,
    start_s: int,
    end_s: int,
) -> dict[str, Any]:
    patch = _filter_payload_to_range(payload, start_s, end_s)
    patch.update({
        "type": "indicator.patch",
        "reason": reason,
        "range": {"start": start_s, "end": end_s},
    })
    return patch


async def _handle_indicator_range_request(
    *,
    dm,
    client_meta: dict[str, dict],
    client_id: str,
    action: str,
    msg: dict,
    send_json,
) -> None:
    if not client_id:
        await send_json(build_ws_error_payload(
            "INDICATOR_CLIENT_ID_REQUIRED",
            "clientId is required.",
            hint="load_range/load_before 需要指定已有指标订阅的 clientId。",
        ))
        return

    meta = client_meta.get(client_id)
    if meta is None:
        await send_json(build_ws_error_payload(
            "INDICATOR_CLIENT_NOT_FOUND",
            f"Indicator client '{client_id}' is not subscribed.",
            client_id=client_id,
            hint="请先 subscribe，再请求指标历史 patch。",
        ))
        return

    try:
        start_s, end_s, target_bars = _range_from_indicator_command(
            action=action,
            msg=msg,
            interval=meta["interval"],
        )
    except ValueError as exc:
        await send_json(build_ws_error_payload(
            "INVALID_INDICATOR_RANGE",
            str(exc),
            client_id=client_id,
            hint="请检查 start/end 或 before/bars 参数。",
        ))
        return

    try:
        if meta.get("kind") == "script":
            payload = await _compute_pyne_range_patch_async(client_id, dm, meta, start_s, end_s, reason=action)
        else:
            payload = await run_indicator(
                _compute_builtin_range_patch,
                client_id,
                dm,
                meta,
                start_s,
                end_s,
                action,
                target_bars,
            )
    except RuntimeError as exc:
        await send_json(build_ws_error_payload(
            "INDICATOR_RANGE_NOT_READY",
            str(exc),
            client_id=client_id,
            detail={
                "range": {"start": start_s, "end": end_s},
                "retryAfterMs": 3000,
            },
            hint="K 线历史仍在补齐，稍后重试该指标区间。",
        ))
        return
    except Exception as exc:
        await send_json(build_ws_error_payload(
            "INDICATOR_RANGE_COMPUTE_FAILED",
            str(exc),
            client_id=client_id,
            detail={"range": {"start": start_s, "end": end_s}},
            hint="指标历史区间计算失败，请检查指标参数或脚本。",
        ))
        return

    await send_json(payload)


def _query_indicator_compute_bars(
    dm,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    *,
    warmup_bars: int,
) -> list[Any]:
    interval_ms = parse_interval_ms(meta["interval"])
    if interval_ms is None or interval_ms <= 0:
        raise ValueError(f"Unsupported interval: {meta['interval']}")
    start_ms = start_s * 1000
    end_ms = end_s * 1000
    compute_start_ms = max(0, start_ms - warmup_bars * interval_ms)
    needed = int((end_ms - compute_start_ms) // interval_ms) + 1
    result = dm.query(
        meta["symbol"],
        meta["interval"],
        start_ms=compute_start_ms,
        end_ms=end_ms,
        limit=needed + 5,
        exchange=meta["exchange"],
        market_type=meta["market_type"],
        auto_backfill=True,
    )
    if _missing_overlaps_target(result.missing_ranges, start_ms, end_ms):
        raise RuntimeError("target K-line range is still backfilling")
    bars = [bar for bar in result.bars if bar.time <= end_s]
    if not any(start_s <= bar.time <= end_s for bar in bars):
        raise RuntimeError("target K-line range is not available yet")
    return bars


def _compute_builtin_range_patch(
    client_id: str,
    dm,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    reason: str,
    target_bars: int,
) -> dict[str, Any]:
    name = str(meta.get("name") or "").upper()
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup = _indicator_warmup_bars(name, params)
    bars = _query_indicator_compute_bars(dm, meta, start_s, end_s, warmup_bars=warmup)

    engine = create_engine()
    result = engine.compute(
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        indicator_name=name,
        params=params,
        bars=bars,
        exchange=meta["exchange"],
    )
    payload = build_indicator_snapshot_payload(
        client_id=client_id,
        indicator_id=meta.get("indicatorId") or f"{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{name}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=name,
        params=params,
        result=result,
    )
    patch = _patch_from_snapshot(payload, reason=reason, start_s=start_s, end_s=end_s)
    patch["warmupBars"] = warmup
    patch["targetBars"] = target_bars
    return patch


def _compute_pyne_snapshot_message(
    client_id: str,
    dm,
    meta: dict,
    bar_time: int = 0,
) -> dict:
    if meta.get("scriptMode") == "incremental" and not bar_time:
        return _compute_incremental_pyne_snapshot_message(client_id, dm, meta)

    query_result = dm.query_latest(
        meta["symbol"],
        meta["interval"],
        limit=meta["historyLimit"],
        exchange=meta["exchange"],
        market_type=meta["market_type"],
    )
    ohlcv = [bar.to_dict() for bar in query_result.bars]
    result = execute_pyne_script(
        script=meta["script"],
        ohlcv=ohlcv,
        params=meta["params"],
        security_mode=meta.get("securityMode"),
    )
    payload = build_pyne_snapshot_payload(
        client_id=client_id,
        indicator_id=meta.get("indicatorId") or f"pyne:{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{client_id}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=meta["name"],
        params=meta["params"],
        result=result,
        bar_time=bar_time,
    )
    if bar_time:
        return _patch_from_snapshot(
            payload,
            reason="bar_update",
            start_s=int(bar_time),
            end_s=int(bar_time),
        )
    return payload


def _pyne_incremental_session_key(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
    script: str,
    params: dict[str, Any],
    security_mode: str | None,
    history_limit: int,
) -> str:
    raw = json.dumps(
        {
            "exchange": exchange,
            "marketType": market_type,
            "symbol": symbol,
            "interval": interval,
            "script": script,
            "params": params,
            "securityMode": security_mode or "",
            "historyLimit": int(history_limit),
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _release_pyne_incremental_meta(meta: dict[str, Any]) -> None:
    key = meta.get("pyneSessionKey")
    if isinstance(key, str) and key:
        _pyne_incremental_sessions.release(key)


def _pyne_result_from_incremental(result) -> PyneResult:
    return PyneResult(
        ok=result.ok,
        error=result.error,
        code=result.code,
        line=result.line,
        column=result.column,
        hint=result.hint,
        lines=result.lines,
        output=result.output,
        param_schema=result.param_schema,
        meta=result.meta,
    )


def _pyne_error_result_from_exception(exc: Exception) -> PyneResult:
    if isinstance(exc, PyneTimeoutError):
        return PyneResult(
            ok=False,
            code="PYNE_TIMEOUT",
            error=str(exc),
            hint="脚本执行超时。请减少循环、缩小窗口，或调整 PYNE_EXEC_TIMEOUT_SECONDS。",
        )
    if isinstance(exc, PyneSecurityError):
        return PyneResult(
            ok=False,
            code="PYNE_SECURITY_ERROR",
            error=str(exc),
            hint="当前 Pyne 安全策略拒绝执行该脚本。",
        )
    return PyneResult(
        ok=False,
        code="PYNE_RUNTIME_ERROR",
        error=f"Script error: {exc}",
        hint="脚本运行时失败。请检查 incremental state、window、helper 和 on_bar/on_preview 逻辑。",
    )


def _build_pyne_ws_payload_from_result(
    *,
    client_id: str,
    meta: dict,
    result: PyneResult,
    bar_time: int = 0,
) -> dict:
    return build_pyne_snapshot_payload(
        client_id=client_id,
        indicator_id=meta.get("indicatorId") or f"pyne:{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{client_id}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=meta["name"],
        params=meta.get("params") if isinstance(meta.get("params"), dict) else {},
        result=result,
        bar_time=bar_time,
    )


def _compute_incremental_pyne_snapshot_message(
    client_id: str,
    dm,
    meta: dict,
) -> dict:
    shared = meta.get("pyneSharedSession")
    if not isinstance(shared, SharedPyneIncrementalSession):
        session = meta.get("pyneSession")
    else:
        session = None
    if shared is None and not isinstance(session, PyneIncrementalSession):
        session = PyneIncrementalSession(
            script=meta["script"],
            params=meta.get("params") if isinstance(meta.get("params"), dict) else {},
            security_mode=meta.get("securityMode"),
        )
        meta["pyneSession"] = session

    query_result = dm.query_latest(
        meta["symbol"],
        meta["interval"],
        limit=meta["historyLimit"],
        exchange=meta["exchange"],
        market_type=meta["market_type"],
    )
    ohlcv = [bar.to_dict() for bar in query_result.bars]
    try:
        if isinstance(shared, SharedPyneIncrementalSession):
            incremental_result = _pyne_incremental_sessions.seed_or_snapshot(shared, ohlcv)
        else:
            incremental_result = session.seed(ohlcv)
        result = _pyne_result_from_incremental(incremental_result)
    except Exception as exc:
        result = _pyne_error_result_from_exception(exc)
    return _build_pyne_ws_payload_from_result(client_id=client_id, meta=meta, result=result)


def _compute_incremental_pyne_bar_message(
    client_id: str,
    meta: dict,
    bar: dict[str, Any],
    *,
    preview: bool,
) -> dict:
    shared = meta.get("pyneSharedSession")
    try:
        if isinstance(shared, SharedPyneIncrementalSession):
            incremental_result = _pyne_incremental_sessions.process_bar(shared, bar, preview=preview)
        else:
            session = meta.get("pyneSession")
            if not isinstance(session, PyneIncrementalSession):
                raise RuntimeError("incremental Pyne session is not initialized")
            incremental_result = session.on_bar_updated(bar) if preview else session.on_bar_closed(bar)
        result = _pyne_result_from_incremental(incremental_result)
    except Exception as exc:
        result = _pyne_error_result_from_exception(exc)
    bar_time = int(bar.get("time") or 0)
    payload = _build_pyne_ws_payload_from_result(
        client_id=client_id,
        meta=meta,
        result=result,
        bar_time=bar_time,
    )
    return _patch_from_snapshot(
        payload,
        reason="bar_update" if preview else "bar_closed",
        start_s=bar_time,
        end_s=bar_time,
    )


def _compute_pyne_range_patch(
    client_id: str,
    dm,
    meta: dict,
    start_s: int,
    end_s: int,
    reason: str = "load_range",
) -> dict:
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup = _indicator_warmup_bars("PYNE", params)
    bars = _query_indicator_compute_bars(dm, meta, start_s, end_s, warmup_bars=warmup)
    if len(bars) > max(int(config.PYNE_MAX_BARS), 1):
        raise ValueError(f"Too many Pyne bars: {len(bars)} > {config.PYNE_MAX_BARS}")
    ohlcv = [bar.to_dict() for bar in bars]
    if meta.get("scriptMode") == "incremental":
        session = PyneIncrementalSession(
            script=meta["script"],
            params=params,
            security_mode=meta.get("securityMode"),
        )
        result = _pyne_result_from_incremental(session.seed(ohlcv, start_s=start_s, end_s=end_s))
    else:
        result = execute_pyne_script(
            script=meta["script"],
            ohlcv=ohlcv,
            params=params,
            security_mode=meta.get("securityMode"),
        )
    payload = build_pyne_snapshot_payload(
        client_id=client_id,
        indicator_id=meta.get("indicatorId") or f"pyne:{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{client_id}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=meta["name"],
        params=params,
        result=result,
    )
    patch = _patch_from_snapshot(payload, reason=reason, start_s=start_s, end_s=end_s)
    patch["warmupBars"] = warmup
    return patch


async def _compute_pyne_snapshot_message_async(
    client_id: str,
    dm,
    meta: dict,
    bar_time: int = 0,
) -> dict:
    """Compute a Pyne snapshot off the event loop."""
    return await run_pyne_wait(
        _compute_pyne_snapshot_message,
        client_id,
        dm,
        meta,
        bar_time,
    )


async def _compute_incremental_pyne_bar_message_async(
    client_id: str,
    meta: dict,
    bar: dict[str, Any],
    *,
    preview: bool,
) -> dict:
    return await run_pyne_wait(
        _compute_incremental_pyne_bar_message,
        client_id,
        meta,
        bar,
        preview=preview,
    )


async def _compute_pyne_range_patch_async(
    client_id: str,
    dm,
    meta: dict,
    start_s: int,
    end_s: int,
    reason: str = "load_range",
) -> dict:
    return await run_pyne_wait(
        _compute_pyne_range_patch,
        client_id,
        dm,
        meta,
        start_s,
        end_s,
        reason,
    )


def _indicator_event_to_ws_message(
    client_id: str,
    event: IndicatorEvent,
    meta: dict,
) -> dict | None:
    base = {
        "clientId": client_id,
        "indicatorId": event.key.uid,
        "exchange": event.key.exchange,
        "symbol": event.key.symbol,
        "interval": event.key.interval,
        "market_type": event.key.market_type,
        "barTime": event.bar_timestamp,
        "timestampMs": event.timestamp_ms,
    }

    if event.event_type == IndicatorEventType.INDICATOR_PREVIEW:
        return {**base, "type": "indicator.preview", "values": event.values}
    if event.event_type == IndicatorEventType.INDICATOR_UPDATED:
        return {**base, "type": "indicator.update", "values": event.values}
    if event.event_type == IndicatorEventType.INDICATOR_RECOMPUTED:
        result = event.full_result
        return build_indicator_snapshot_payload(
            client_id=client_id,
            indicator_id=event.key.uid,
            exchange=event.key.exchange,
            symbol=event.key.symbol,
            interval=event.key.interval,
            market_type=event.key.market_type,
            name=event.key.indicator_name,
            params=dict(event.key.params),
            result=result,
            bar_time=event.bar_timestamp,
        )
    if event.event_type == IndicatorEventType.INDICATOR_ERROR:
        message = str(event.detail or "Indicator compute error")
        return {
            **base,
            "type": "indicator.error",
            "code": "INDICATOR_COMPUTE_ERROR",
            "error": message,
            "detail": event.detail,
            "errorDetail": error_detail(
                "INDICATOR_COMPUTE_ERROR",
                message,
                hint="指标增量计算失败。请检查参数和最近 K 线数据。",
            ),
        }
    return None
