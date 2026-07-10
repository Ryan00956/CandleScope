"""Indicator WebSocket payload and range computation helpers."""
from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

from app.core import config
from app.core.executors import run_indicator, run_pyne_wait, run_storage
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
from app.indicator.script_identity import script_hash
from app.indicator.serialization import (
    build_indicator_snapshot_payload,
    build_pyne_snapshot_payload,
    build_ws_error_payload,
)

_pyne_incremental_sessions = PyneIncrementalSessionManager()


class IndicatorRangeEmptyError(RuntimeError):
    """Target range has no closed bars yet, usually because it is forming-only."""


class IndicatorRangeNotReadyError(RuntimeError):
    """Exact K-line repair did not finish inside the bounded request wait."""

    def __init__(
        self,
        message: str,
        *,
        request_ids: list[str] | None = None,
        waited_ms: int = 0,
    ) -> None:
        super().__init__(message)
        self.request_ids = list(request_ids or [])
        self.waited_ms = max(0, int(waited_ms))


def confirmed_indicator_seed_bars(bars: list[Any]) -> list[Any]:
    """Return only bars that are safe to commit into indicator history."""
    return [bar for bar in bars or [] if getattr(bar, "is_closed", True)]


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
        try:
            bars = int(msg.get("bars") or 500)
        except (TypeError, ValueError):
            bars = 500
        bars = max(bars, 1)
        end_s = before - interval_s
        start_s = end_s - (bars - 1) * interval_s
        return start_s, end_s, bars

    start_s = int(msg.get("start") or 0)
    end_s = int(msg.get("end") or 0)
    if start_s <= 0 or end_s <= 0 or start_s > end_s:
        raise ValueError("start/end must be positive unix timestamps with start <= end")
    bars = ((end_s - start_s) // interval_s) + 1
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

    # Builtin snapshots also carry the legacy ``result.outputs`` envelope.
    # Leaving it unsliced would make a tiny cache hit serialize the complete
    # WS seed history even though ``lines``/``series`` were correctly trimmed.
    nested_result = next_payload.get("result")
    if isinstance(nested_result, dict) and isinstance(nested_result.get("outputs"), dict):
        filtered_result = dict(nested_result)
        filtered_outputs: dict[str, Any] = {}
        for name, output in nested_result["outputs"].items():
            if not isinstance(output, dict):
                filtered_outputs[name] = output
                continue
            filtered_outputs[name] = {
                **output,
                "data": _filter_points_to_range(output.get("data") or [], start_s, end_s),
                **(
                    {
                        "colorData": _filter_points_to_range(
                            output.get("colorData") or [], start_s, end_s,
                        )
                    }
                    if output.get("colorData")
                    else {}
                ),
            }
        filtered_result["outputs"] = filtered_outputs
        next_payload["result"] = filtered_result

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


def _replace_range_from_snapshot(
    payload: dict[str, Any],
    *,
    reason: str,
    start_s: int,
    end_s: int,
) -> dict[str, Any]:
    replacement = _filter_payload_to_range(payload, start_s, end_s)
    replacement.update({
        "type": "indicator.replace_range",
        "reason": reason,
        "range": {"start": start_s, "end": end_s},
    })
    return replacement


def _series_payload_time_range(payload: dict[str, Any]) -> tuple[int, int] | None:
    times: list[int] = []
    for line in payload.get("lines") or []:
        for point in line.get("data") or []:
            try:
                times.append(int(point.get("time")))
            except (TypeError, ValueError):
                continue
    if not times:
        for series in payload.get("series") or []:
            for point in series.get("data") or []:
                try:
                    times.append(int(point.get("time")))
                except (TypeError, ValueError):
                    continue
    if not times:
        return None
    return min(times), max(times)


def _recompute_event_range(event: IndicatorEvent, payload: dict[str, Any]) -> tuple[int, int] | None:
    detail_range = event.detail.get("range") if isinstance(event.detail, dict) else None
    if isinstance(detail_range, dict):
        try:
            start_s = int(detail_range.get("start"))
            end_s = int(detail_range.get("end"))
        except (TypeError, ValueError):
            start_s = end_s = 0
        if start_s > 0 and end_s >= start_s:
            return start_s, end_s
    return _series_payload_time_range(payload)


async def compute_indicator_range_payload_async(
    *,
    dm,
    meta: dict[str, Any],
    client_id: str,
    start_s: int,
    end_s: int,
    reason: str = "range",
    backfill_coordinator: Any | None = None,
    backfill_wait_seconds: float | None = None,
) -> dict[str, Any]:
    interval_ms = parse_interval_ms(meta["interval"])
    if interval_ms is None or interval_ms <= 0:
        raise ValueError(f"Unsupported interval: {meta['interval']}")
    interval_s = max(interval_ms // 1000, 1)
    target_bars = ((end_s - start_s) // interval_s) + 1
    if meta.get("kind") == "script":
        params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
        warmup_bars = _indicator_warmup_bars("PYNE", params)
        max_pyne_bars = max(int(config.PYNE_MAX_BARS), 1)
        estimated_compute_bars = target_bars + warmup_bars
        if estimated_compute_bars > max_pyne_bars:
            raise ValueError(f"Too many Pyne bars: {estimated_compute_bars} > {config.PYNE_MAX_BARS}")
        bars = await _query_indicator_compute_bars_async(
            dm,
            meta,
            start_s,
            end_s,
            warmup_bars=warmup_bars,
            backfill_coordinator=backfill_coordinator,
            wait_seconds=backfill_wait_seconds,
        )
        return await run_pyne_wait(
            _compute_pyne_range_patch_from_bars,
            client_id,
            meta,
            start_s,
            end_s,
            bars,
            reason,
            target_bars,
        )
    name = str(meta.get("name") or "").upper()
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup_bars = _indicator_warmup_bars(name, params)
    if target_bars > 50_000:
        raise ValueError(f"Too many indicator bars: {target_bars} > 50000")
    bars = await _query_indicator_compute_bars_async(
        dm,
        meta,
        start_s,
        end_s,
        warmup_bars=warmup_bars,
        backfill_coordinator=backfill_coordinator,
        wait_seconds=backfill_wait_seconds,
    )
    return await run_indicator(
        _compute_builtin_range_patch_from_bars,
        client_id,
        meta,
        start_s,
        end_s,
        bars,
        reason,
        target_bars,
    )


def _query_indicator_compute_bars(
    dm,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    *,
    warmup_bars: int,
) -> list[Any]:
    result, start_ms, end_ms = _query_indicator_compute_result(
        dm,
        meta,
        start_s,
        end_s,
        warmup_bars=warmup_bars,
        auto_backfill=True,
    )
    return _closed_indicator_compute_bars(result, start_s, end_s, start_ms, end_ms)


def _query_indicator_compute_result(
    dm,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    *,
    warmup_bars: int,
    auto_backfill: bool,
) -> tuple[Any, int, int]:
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
        auto_backfill=auto_backfill,
    )
    return result, start_ms, end_ms


def _closed_indicator_compute_bars(
    result: Any,
    start_s: int,
    end_s: int,
    start_ms: int,
    end_ms: int,
) -> list[Any]:
    if _missing_overlaps_target(result.missing_ranges, start_ms, end_ms):
        raise RuntimeError("target K-line range is still backfilling")
    raw_bars = list(result.bars or [])
    bars = [
        bar for bar in raw_bars
        if bar.time <= end_s and getattr(bar, "is_closed", True)
    ]
    if not any(start_s <= bar.time <= end_s for bar in bars):
        raw_target_bars = [
            bar for bar in raw_bars
            if start_s <= int(getattr(bar, "time", 0)) <= end_s
        ]
        if raw_target_bars:
            raise IndicatorRangeEmptyError("target K-line range has no closed bars yet")
        raise RuntimeError("target K-line range is not available yet")
    return bars


async def _query_indicator_compute_bars_async(
    dm,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    *,
    warmup_bars: int,
    backfill_coordinator: Any | None,
    wait_seconds: float | None,
) -> list[Any]:
    result, start_ms, end_ms = await run_storage(
        _query_indicator_compute_result,
        dm,
        meta,
        start_s,
        end_s,
        warmup_bars=warmup_bars,
        auto_backfill=True,
    )
    if not _missing_overlaps_target(result.missing_ranges, start_ms, end_ms):
        return _closed_indicator_compute_bars(result, start_s, end_s, start_ms, end_ms)

    metadata = result.metadata if isinstance(getattr(result, "metadata", None), dict) else {}
    request_ids = list(dict.fromkeys(
        str(item).strip()
        for item in metadata.get("backfill_request_ids") or []
        if str(item).strip()
    ))
    if backfill_coordinator is None or not request_ids:
        raise RuntimeError("target K-line range is still backfilling")

    timeout_seconds = (
        config.INDICATOR_RANGE_BACKFILL_WAIT_SECONDS
        if wait_seconds is None
        else float(wait_seconds)
    )
    timeout_seconds = max(0.0, timeout_seconds)
    started = asyncio.get_running_loop().time()
    try:
        if timeout_seconds <= 0:
            raise asyncio.TimeoutError
        await asyncio.wait_for(
            asyncio.gather(*(
                backfill_coordinator.wait_for_request(request_id)
                for request_id in request_ids
            )),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError as exc:
        waited_ms = int((asyncio.get_running_loop().time() - started) * 1000)
        raise IndicatorRangeNotReadyError(
            "target K-line range is still backfilling",
            request_ids=request_ids,
            waited_ms=waited_ms,
        ) from exc

    result, start_ms, end_ms = await run_storage(
        _query_indicator_compute_result,
        dm,
        meta,
        start_s,
        end_s,
        warmup_bars=warmup_bars,
        auto_backfill=False,
    )
    if _missing_overlaps_target(result.missing_ranges, start_ms, end_ms):
        waited_ms = int((asyncio.get_running_loop().time() - started) * 1000)
        raise IndicatorRangeNotReadyError(
            "target K-line range is unavailable after its backfill completed",
            request_ids=request_ids,
            waited_ms=waited_ms,
        )
    return _closed_indicator_compute_bars(result, start_s, end_s, start_ms, end_ms)


def _confirmed_target_range_end(bars: list[Any], start_s: int, end_s: int) -> int:
    target_times = [
        int(bar.time)
        for bar in bars
        if start_s <= int(bar.time) <= end_s
    ]
    if not target_times:
        raise RuntimeError("target K-line range is not available yet")
    return max(target_times)


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
    if target_bars > 50_000:
        raise ValueError(f"Too many indicator bars: {target_bars} > 50000")
    bars = _query_indicator_compute_bars(dm, meta, start_s, end_s, warmup_bars=warmup)

    return _compute_builtin_range_patch_from_bars(
        client_id,
        meta,
        start_s,
        end_s,
        bars,
        reason,
        target_bars,
    )


def _compute_builtin_range_patch_from_bars(
    client_id: str,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    bars: list[Any],
    reason: str,
    target_bars: int,
) -> dict[str, Any]:
    name = str(meta.get("name") or "").upper()
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup = _indicator_warmup_bars(name, params)
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
    range_end_s = _confirmed_target_range_end(bars, start_s, end_s)
    patch = _replace_range_from_snapshot(payload, reason=reason, start_s=start_s, end_s=range_end_s)
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

    history_limit = int(meta["historyLimit"])
    if bar_time:
        history_limit = min(
            max(history_limit, 1),
            max(int(config.PYNE_TICK_RECOMPUTE_MAX_BARS), 1),
        )

    query_result = dm.query_latest(
        meta["symbol"],
        meta["interval"],
        limit=history_limit,
        exchange=meta["exchange"],
        market_type=meta["market_type"],
    )
    seed_bars = confirmed_indicator_seed_bars(query_result.bars) if not bar_time else query_result.bars
    ohlcv = [bar.to_dict() for bar in seed_bars]
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
        script_hash=meta.get("scriptHash"),
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
            "scriptHash": script_hash(script),
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
        # Keep the shared incremental state warm across quick interval switches.
        # The delayed release still decrements the original reference, while a
        # reconnect can acquire the same key immediately without a full reseed.
        delay = max(0.0, float(config.INDICATOR_ENGINE_WARM_TTL_SECONDS))
        if delay <= 0:
            _pyne_incremental_sessions.release(key)
            return
        try:
            idle_generation = _pyne_incremental_sessions.release(key, retain=True)
        except TypeError:
            # Compatibility with an externally overridden older runtime.
            _pyne_incremental_sessions.release(key)
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            drop_if_idle = getattr(_pyne_incremental_sessions, "drop_if_idle", None)
            if callable(drop_if_idle):
                drop_if_idle(key, idle_generation)
            return
        drop_if_idle = getattr(_pyne_incremental_sessions, "drop_if_idle", None)
        if callable(drop_if_idle):
            loop.call_later(delay, drop_if_idle, key, idle_generation)


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
        script_hash=meta.get("scriptHash"),
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
    ohlcv = [bar.to_dict() for bar in confirmed_indicator_seed_bars(query_result.bars)]
    try:
        if isinstance(shared, SharedPyneIncrementalSession):
            interval_ms = parse_interval_ms(meta["interval"])
            incremental_result = _pyne_incremental_sessions.seed_or_snapshot(
                shared,
                ohlcv,
                expected_step_s=(max(interval_ms // 1000, 1) if interval_ms else 0),
            )
        else:
            incremental_result = session.seed(ohlcv)
        result = _pyne_result_from_incremental(incremental_result)
    except Exception as exc:
        result = _pyne_error_result_from_exception(exc)
    payload = _build_pyne_ws_payload_from_result(client_id=client_id, meta=meta, result=result)
    if ohlcv:
        payload["range"] = {
            "start": int(ohlcv[0]["time"]),
            "end": int(ohlcv[-1]["time"]),
        }
    return payload


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
    target_bars: int | None = None,
) -> dict:
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup = _indicator_warmup_bars("PYNE", params)
    bars = _query_indicator_compute_bars(dm, meta, start_s, end_s, warmup_bars=warmup)
    return _compute_pyne_range_patch_from_bars(
        client_id,
        meta,
        start_s,
        end_s,
        bars,
        reason,
        target_bars,
    )


def _compute_pyne_range_patch_from_bars(
    client_id: str,
    meta: dict,
    start_s: int,
    end_s: int,
    bars: list[Any],
    reason: str = "load_range",
    target_bars: int | None = None,
) -> dict:
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup = _indicator_warmup_bars("PYNE", params)
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
        script_hash=meta.get("scriptHash"),
    )
    range_end_s = _confirmed_target_range_end(bars, start_s, end_s)
    patch = _replace_range_from_snapshot(payload, reason=reason, start_s=start_s, end_s=range_end_s)
    patch["warmupBars"] = warmup
    if target_bars is not None:
        patch["targetBars"] = target_bars
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
    target_bars: int | None = None,
) -> dict:
    return await run_pyne_wait(
        _compute_pyne_range_patch,
        client_id,
        dm,
        meta,
        start_s,
        end_s,
        reason,
        target_bars,
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
        recomputed_range = _recompute_event_range(event, {})
        if recomputed_range is None:
            return None
        start_s, end_s = recomputed_range
        return {
            **base,
            "type": "indicator.recomputed",
            "reason": "backfill-recomputed",
            "range": {"start": start_s, "end": end_s},
            **(
                {"dirtyRange": event.detail["dirtyRange"]}
                if isinstance(event.detail, dict) and isinstance(event.detail.get("dirtyRange"), dict)
                else {}
            ),
            **(
                {"dataRevision": event.detail["dataRevision"]}
                if isinstance(event.detail, dict) and isinstance(event.detail.get("dataRevision"), dict)
                else {}
            ),
        }
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
