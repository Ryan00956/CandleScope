"""Indicator WebSocket payload and range computation helpers."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from app.core import config
from app.core.executors import run_indicator, run_pyne_wait, run_storage
from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    parse_interval_ms,
)
from app.indicator import create_engine
from app.indicator.errors import error_detail
from app.indicator.events import IndicatorEvent, IndicatorEventType
from app.indicator.runtime_service import (
    IndicatorRuntimeFailure,
    IndicatorRuntimeRequest,
    IndicatorRuntimeService,
    IndicatorRuntimeUnavailableError,
    build_unbound_indicator_runtime_service,
    removed_in_process_runtime,
)
from app.indicator.serialization import (
    build_error_payload,
    build_indicator_snapshot_payload,
    build_script_runtime_snapshot_payload,
    serialize_plugin_runtime_result,
)

_unbound_indicator_runtime_service = build_unbound_indicator_runtime_service()

# Keep the established builtin range ceiling, but apply it to the complete
# compute dataset (target plus warmup) rather than only the visible target.
# This prevents an otherwise tiny request with an extreme period from reading
# and retaining an unbounded K-line prefix.
_BUILTIN_INDICATOR_MAX_COMPUTE_BARS = 50_000


class IndicatorRangeEmptyError(RuntimeError):
    """Target range has no closed bars yet, usually because it is forming-only."""

    def __init__(
        self,
        message: str,
        *,
        terminal_reason: str | None = None,
        earliest_available_ms: int | None = None,
        availability_revision: str | None = None,
        retryable: bool = True,
        excluded_ranges: list[dict[str, Any]] | None = None,
        history_state: str | None = None,
    ) -> None:
        super().__init__(message)
        self.terminal_reason = terminal_reason
        self.earliest_available_ms = earliest_available_ms
        self.availability_revision = availability_revision
        self.retryable = bool(retryable)
        self.excluded_ranges = list(excluded_ranges or [])
        self.history_state = history_state


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


def store_indicator_seed_cache(
    cache: dict[tuple[str, str, str, str, int], dict[str, Any]],
    key: tuple[str, str, str, str, int],
    entry: dict[str, Any],
) -> None:
    """Store one WS seed query in a TTL-pruned bounded LRU dictionary."""
    ttl_seconds = max(
        0.0,
        float(config.INDICATOR_WS_SEED_CACHE_SECONDS),
    )
    if ttl_seconds <= 0:
        cache.clear()
        return
    now = time.monotonic()
    for cached_key, cached_entry in list(cache.items()):
        if now - float(cached_entry.get("at", 0)) > ttl_seconds:
            cache.pop(cached_key, None)
    cache.pop(key, None)
    cache[key] = entry
    max_entries = max(1, int(config.INDICATOR_WS_MAX_SUBSCRIPTIONS))
    while len(cache) > max_entries:
        cache.pop(next(iter(cache)), None)


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


def _validated_builtin_warmup_bars(
    name: str,
    params: dict[str, Any],
    target_bars: int,
) -> int:
    """Return warmup after enforcing the builtin total-compute ceiling."""
    warmup_bars = _indicator_warmup_bars(name, params)
    _validate_builtin_compute_bars(target_bars, warmup_bars)
    return warmup_bars


def _validate_builtin_compute_bars(target_bars: int, warmup_bars: int) -> None:
    """Reject builtin target plus warmup datasets above the existing limit."""
    estimated_compute_bars = max(0, int(target_bars)) + warmup_bars
    if estimated_compute_bars > _BUILTIN_INDICATOR_MAX_COMPUTE_BARS:
        raise ValueError(
            "Too many indicator bars: "
            f"{estimated_compute_bars} > {_BUILTIN_INDICATOR_MAX_COMPUTE_BARS}"
        )


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


def _missing_overlaps_target(
    missing_ranges: list[Any], start_ms: int, end_ms: int
) -> bool:
    for missing in missing_ranges or []:
        m_start = getattr(missing, "start_ms", None)
        m_end = getattr(missing, "end_ms", None)
        if m_start is None or m_end is None:
            continue
        if int(m_start) <= end_ms and int(m_end) >= start_ms:
            return True
    return False


def _filter_points_to_range(
    points: list[dict[str, Any]], start_s: int, end_s: int
) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    for point in points or []:
        try:
            ts = int(point.get("time"))
        except (TypeError, ValueError):
            continue
        if start_s <= ts <= end_s:
            filtered.append(point)
    return filtered


def _filter_payload_to_range(
    payload: dict[str, Any], start_s: int, end_s: int
) -> dict[str, Any]:
    """Trim a snapshot-like indicator payload down to a range patch."""
    next_payload = dict(payload)

    if isinstance(next_payload.get("lines"), list):
        next_payload["lines"] = [
            {
                **line,
                "data": _filter_points_to_range(line.get("data") or [], start_s, end_s),
                **(
                    {
                        "colorData": _filter_points_to_range(
                            line.get("colorData") or [], start_s, end_s
                        )
                    }
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
                style["colorData"] = _filter_points_to_range(
                    style.get("colorData") or [], start_s, end_s
                )
            series.append(
                {
                    **item,
                    "data": _filter_points_to_range(
                        item.get("data") or [], start_s, end_s
                    ),
                    "style": style,
                }
            )
        next_payload["series"] = series

    # Builtin snapshots also carry the legacy ``result.outputs`` envelope.
    # Leaving it unsliced would make a tiny cache hit serialize the complete
    # WS seed history even though ``lines``/``series`` were correctly trimmed.
    nested_result = next_payload.get("result")
    if isinstance(nested_result, dict) and isinstance(
        nested_result.get("outputs"), dict
    ):
        filtered_result = dict(nested_result)
        filtered_outputs: dict[str, Any] = {}
        for name, output in nested_result["outputs"].items():
            if not isinstance(output, dict):
                filtered_outputs[name] = output
                continue
            filtered_outputs[name] = {
                **output,
                "data": _filter_points_to_range(
                    output.get("data") or [], start_s, end_s
                ),
                **(
                    {
                        "colorData": _filter_points_to_range(
                            output.get("colorData") or [],
                            start_s,
                            end_s,
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
                {
                    **group,
                    "data": _filter_points_to_range(
                        group.get("data") or [], start_s, end_s
                    ),
                }
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
    patch.update(
        {
            "type": "indicator.patch",
            "reason": reason,
            "range": {"start": start_s, "end": end_s},
        }
    )
    return patch


def _replace_range_from_snapshot(
    payload: dict[str, Any],
    *,
    reason: str,
    start_s: int,
    end_s: int,
) -> dict[str, Any]:
    replacement = _filter_payload_to_range(payload, start_s, end_s)
    replacement.update(
        {
            "type": "indicator.replace_range",
            "reason": reason,
            "range": {"start": start_s, "end": end_s},
        }
    )
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


def _recompute_event_range(
    event: IndicatorEvent, payload: dict[str, Any]
) -> tuple[int, int] | None:
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
    runtime_service: IndicatorRuntimeService | None = None,
) -> dict[str, Any]:
    interval_ms = parse_interval_ms(meta["interval"])
    if interval_ms is None or interval_ms <= 0:
        raise ValueError(f"Unsupported interval: {meta['interval']}")
    interval_s = max(interval_ms // 1000, 1)
    target_bars = ((end_s - start_s) // interval_s) + 1
    if meta.get("kind") == "script":
        params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
        language = str(meta.get("language") or "pyne")
        warmup_bars = _indicator_warmup_bars(language.upper(), params)
        max_pyne_bars = max(int(config.PYNE_MAX_BARS), 1)
        estimated_compute_bars = target_bars + warmup_bars
        if estimated_compute_bars > max_pyne_bars:
            label = "Pyne" if language == "pyne" else f"{language} runtime"
            raise ValueError(
                f"Too many {label} bars: {estimated_compute_bars} > {config.PYNE_MAX_BARS}"
            )
        bars = await _query_indicator_compute_bars_async(
            dm,
            meta,
            start_s,
            end_s,
            warmup_bars=warmup_bars,
            backfill_coordinator=backfill_coordinator,
            wait_seconds=backfill_wait_seconds,
        )
        service = runtime_service or _unbound_indicator_runtime_service

        request = _script_runtime_request(
            meta,
            bars,
            transport="http.range",
        )
        return await service.execute(
            request,
            legacy=removed_in_process_runtime,
            adapt_sidecar=lambda result: _compute_plugin_range_patch_from_bars(
                client_id,
                meta,
                start_s,
                end_s,
                bars,
                result,
                reason=reason,
                target_bars=target_bars,
            ),
            adapt_failure=_raise_plugin_runtime_failure,
        )
    name = str(meta.get("name") or "").upper()
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup_bars = _validated_builtin_warmup_bars(name, params, target_bars)
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
        # Indicator history is read-only. The chart history request owns any
        # repair of the requested target range.
        auto_backfill=False,
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
    calendar = None
    history_policy = getattr(dm, "history_policy", None)
    if history_policy is not None:
        try:
            series = history_policy.series_key(
                exchange=meta["exchange"],
                market_type=meta["market_type"],
                symbol=meta["symbol"],
                channel="kline",
                variant=meta["interval"],
            )
            calendar = history_policy.resolve(series).calendar
        except Exception:
            calendar = None
    if calendar is not None:
        start_bucket = compute_bucket_start_ms(
            start_ms,
            interval_ms,
            interval=meta["interval"],
        )
        anchor = calendar.previous_expected_open(
            compute_bucket_end_ms(
                start_bucket,
                interval_ms,
                interval=meta["interval"],
            ),
            meta["interval"],
        )
        if anchor is not None:
            compute_start_ms = anchor
            for _ in range(warmup_bars):
                previous = calendar.previous_expected_open(
                    compute_start_ms,
                    meta["interval"],
                )
                if previous is None:
                    break
                compute_start_ms = previous
        needed = calendar.count_expected(
            compute_start_ms,
            end_ms,
            meta["interval"],
        )
    else:
        needed = int((end_ms - compute_start_ms) // interval_ms) + 1
    query_kwargs: dict[str, Any] = {
        "start_ms": compute_start_ms,
        "end_ms": end_ms,
        "limit": needed + 5,
        "exchange": meta["exchange"],
        "market_type": meta["market_type"],
        "auto_backfill": auto_backfill,
    }
    result = dm.query(
        meta["symbol"],
        meta["interval"],
        **query_kwargs,
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
        raise IndicatorRangeNotReadyError("target K-line range is still backfilling")
    raw_bars = list(result.bars or [])
    bars = [
        bar for bar in raw_bars if bar.time <= end_s and getattr(bar, "is_closed", True)
    ]
    if not any(start_s <= bar.time <= end_s for bar in bars):
        raw_target_bars = [
            bar for bar in raw_bars if start_s <= int(getattr(bar, "time", 0)) <= end_s
        ]
        if raw_target_bars:
            raise IndicatorRangeEmptyError("target K-line range has no closed bars yet")
        terminal_reason = getattr(result, "terminal_reason", None)
        if (
            getattr(result, "history_state", None) == "exhausted"
            or terminal_reason
            or (
                bool(getattr(result, "complete", False))
                and not bool(getattr(result, "retryable", False))
            )
        ):
            raise IndicatorRangeEmptyError(
                "target K-line range is outside available history",
                terminal_reason=terminal_reason,
                earliest_available_ms=getattr(result, "earliest_available_ms", None),
                availability_revision=getattr(result, "availability_revision", None),
                retryable=False,
                excluded_ranges=getattr(result, "excluded_ranges", None),
                history_state=getattr(result, "history_state", None) or "ready",
            )
        raise IndicatorRangeNotReadyError("target K-line range is not available yet")
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
        # Indicator history is a read-only consumer. K-line history/range/
        # before requests exclusively own repair of the requested target.
        auto_backfill=False,
    )
    if not _missing_overlaps_target(result.missing_ranges, start_ms, end_ms):
        return _closed_indicator_compute_bars(result, start_s, end_s, start_ms, end_ms)

    metadata = (
        result.metadata if isinstance(getattr(result, "metadata", None), dict) else {}
    )
    request_ids = list(
        dict.fromkeys(
            str(item).strip()
            for item in metadata.get("backfill_request_ids") or []
            if str(item).strip()
        )
    )
    if backfill_coordinator is None or not request_ids:
        raise IndicatorRangeNotReadyError(
            "target K-line range is still backfilling",
            request_ids=request_ids,
            waited_ms=0,
        )

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
            asyncio.gather(
                *(
                    backfill_coordinator.wait_for_request(request_id)
                    for request_id in request_ids
                )
            ),
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


def _confirmed_target_range(
    bars: list[Any], start_s: int, end_s: int
) -> tuple[int, int]:
    target_times = [int(bar.time) for bar in bars if start_s <= int(bar.time) <= end_s]
    if not target_times:
        raise IndicatorRangeNotReadyError("target K-line range is not available yet")
    return min(target_times), max(target_times)


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
    warmup = _validated_builtin_warmup_bars(name, params, target_bars)
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
        indicator_id=meta.get("indicatorId")
        or f"{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{name}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=name,
        params=params,
        result=result,
    )
    range_start_s, range_end_s = _confirmed_target_range(bars, start_s, end_s)
    patch = _replace_range_from_snapshot(
        payload,
        reason=reason,
        start_s=range_start_s,
        end_s=range_end_s,
    )
    patch["warmupBars"] = warmup
    patch["targetBars"] = target_bars
    return patch


def _query_pyne_snapshot_bars(
    dm: Any,
    meta: dict[str, Any],
    *,
    bar_time: int = 0,
    seed_bars: list[Any] | None = None,
) -> list[Any]:
    history_limit = int(meta["historyLimit"])
    if bar_time:
        history_limit = min(
            max(history_limit, 1),
            max(int(config.PYNE_TICK_RECOMPUTE_MAX_BARS), 1),
        )

    if seed_bars is None:
        query_result = dm.query_latest(
            meta["symbol"],
            meta["interval"],
            limit=(history_limit + 1 if not bar_time else history_limit),
            exchange=meta["exchange"],
            market_type=meta["market_type"],
            auto_backfill=False,
        )
        resolved_bars = (
            confirmed_indicator_seed_bars(query_result.bars)[-history_limit:]
            if not bar_time
            else list(query_result.bars)
        )
    else:
        resolved_bars = (
            confirmed_indicator_seed_bars(seed_bars)[-history_limit:]
            if not bar_time
            else list(seed_bars)[-history_limit:]
        )
    return list(resolved_bars)


def _release_pyne_incremental_meta(meta: dict[str, Any]) -> None:
    """Drop stale metadata created before incremental execution moved out of process."""
    for key in ("pyneSessionKey", "pyneSharedSession", "pyneSession", "scriptMode"):
        meta.pop(key, None)


def _script_runtime_request(
    meta: dict[str, Any],
    bars: list[Any],
    *,
    transport: str,
) -> IndicatorRuntimeRequest:
    return IndicatorRuntimeRequest(
        language=str(meta.get("language") or "pyne"),
        source=str(meta.get("script") or ""),
        exchange=str(meta["exchange"]),
        market_type=str(meta["market_type"]),
        symbol=str(meta["symbol"]),
        interval=str(meta["interval"]),
        bars=tuple(bars),
        params=(dict(meta["params"]) if isinstance(meta.get("params"), dict) else {}),
        options={
            **(
                {"securityMode": meta.get("securityMode")}
                if meta.get("securityMode") is not None
                else {}
            ),
        },
        transport=transport,
    )


def _plugin_runtime_failure_payload(
    failure: IndicatorRuntimeFailure,
) -> dict[str, Any]:
    return build_error_payload(
        failure.public_code,
        f"Script runtime {failure.runtime_id!r} is unavailable.",
        hint="请检查插件激活和健康状态；sidecar 模式不会静默回退到 legacy。",
    )


def _build_plugin_snapshot_from_payload(
    client_id: str,
    meta: dict[str, Any],
    payload: dict[str, Any],
    *,
    bar_time: int = 0,
) -> dict[str, Any]:
    return build_script_runtime_snapshot_payload(
        client_id=client_id,
        indicator_id=(
            meta.get("indicatorId")
            or f"runtime:{meta['exchange']}:{meta['market_type']}:"
            f"{meta['symbol']}:{meta['interval']}:{client_id}"
        ),
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=meta["name"],
        params=(meta.get("params") if isinstance(meta.get("params"), dict) else {}),
        payload=payload,
        bar_time=bar_time,
        script_hash=meta.get("scriptHash"),
    )


def _compute_plugin_range_patch_from_bars(
    client_id: str,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    bars: list[Any],
    result: Any,
    *,
    reason: str = "load_range",
    target_bars: int | None = None,
) -> dict[str, Any]:
    payload = _build_plugin_snapshot_from_payload(
        client_id,
        meta,
        serialize_plugin_runtime_result(result),
    )
    range_start_s, range_end_s = _confirmed_target_range(bars, start_s, end_s)
    patch = _replace_range_from_snapshot(
        payload,
        reason=reason,
        start_s=range_start_s,
        end_s=range_end_s,
    )
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    language = str(meta.get("language") or "pyne")
    patch["warmupBars"] = _indicator_warmup_bars(language.upper(), params)
    if target_bars is not None:
        patch["targetBars"] = target_bars
    return patch


def _raise_plugin_runtime_failure(
    failure: IndicatorRuntimeFailure,
) -> dict[str, Any]:
    raise IndicatorRuntimeUnavailableError(failure)


def _plugin_snapshot_or_patch_from_result(
    client_id: str,
    meta: dict[str, Any],
    bars: list[Any],
    result: Any,
    *,
    bar_time: int = 0,
    reason: str = "bar_update",
) -> dict[str, Any]:
    payload = _build_plugin_snapshot_from_payload(
        client_id,
        meta,
        serialize_plugin_runtime_result(result),
        bar_time=bar_time,
    )
    return _finish_plugin_snapshot_or_patch(
        payload,
        bars,
        bar_time=bar_time,
        reason=reason,
    )


def _plugin_snapshot_or_patch_from_failure(
    client_id: str,
    meta: dict[str, Any],
    bars: list[Any],
    failure: IndicatorRuntimeFailure,
    *,
    bar_time: int = 0,
    reason: str = "bar_update",
) -> dict[str, Any]:
    payload = _build_plugin_snapshot_from_payload(
        client_id,
        meta,
        _plugin_runtime_failure_payload(failure),
        bar_time=bar_time,
    )
    return _finish_plugin_snapshot_or_patch(
        payload,
        bars,
        bar_time=bar_time,
        reason=reason,
    )


def _finish_plugin_snapshot_or_patch(
    payload: dict[str, Any],
    bars: list[Any],
    *,
    bar_time: int,
    reason: str,
) -> dict[str, Any]:
    if bar_time:
        return _patch_from_snapshot(
            payload,
            reason=reason,
            start_s=int(bar_time),
            end_s=int(bar_time),
        )
    times = [
        int(bar.get("time") if isinstance(bar, dict) else bar.time) for bar in bars
    ]
    if times:
        payload["range"] = {"start": min(times), "end": max(times)}
    return payload


async def _compute_pyne_snapshot_message_async(
    client_id: str,
    dm,
    meta: dict,
    bar_time: int = 0,
    runtime_service: IndicatorRuntimeService | None = None,
    seed_bars: list[Any] | None = None,
) -> dict:
    """Compute a script-runtime snapshot without blocking the event loop."""
    service = runtime_service or _unbound_indicator_runtime_service
    bars = await run_pyne_wait(
        _query_pyne_snapshot_bars,
        dm,
        meta,
        bar_time=bar_time,
        seed_bars=seed_bars,
    )

    return await service.execute(
        _script_runtime_request(
            meta,
            bars,
            transport="websocket.snapshot",
        ),
        legacy=removed_in_process_runtime,
        adapt_sidecar=lambda result: _plugin_snapshot_or_patch_from_result(
            client_id,
            meta,
            bars,
            result,
            bar_time=bar_time,
            reason="bar_update",
        ),
        adapt_failure=lambda failure: _plugin_snapshot_or_patch_from_failure(
            client_id,
            meta,
            bars,
            failure,
            bar_time=bar_time,
            reason="bar_update",
        ),
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
        return {
            **base,
            "type": "indicator.preview",
            "values": event.values,
            **(
                {"bar": event.detail["bar"]}
                if isinstance(event.detail, dict)
                and isinstance(event.detail.get("bar"), dict)
                else {}
            ),
        }
    if event.event_type == IndicatorEventType.INDICATOR_UPDATED:
        return {
            **base,
            "type": "indicator.update",
            "values": event.values,
            **(
                {"bar": event.detail["bar"]}
                if isinstance(event.detail, dict)
                and isinstance(event.detail.get("bar"), dict)
                else {}
            ),
        }
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
                if isinstance(event.detail, dict)
                and isinstance(event.detail.get("dirtyRange"), dict)
                else {}
            ),
            **(
                {"dataRevision": event.detail["dataRevision"]}
                if isinstance(event.detail, dict)
                and isinstance(event.detail.get("dataRevision"), dict)
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
