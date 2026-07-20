"""
Kline API routes — powered by DataManager facade.

All endpoints delegate to the unified ``DataManager`` for data retrieval,
which provides:
  * Three-level query resolution: Cache → Storage → Backfill
  * Automatic stream management (auto-start ingestion on demand)
  * Consistent BarAggregator-based custom interval handling
  * Event-driven cache warming

The DataManager instance is stored on ``app.state.data_manager`` and
initialized during application startup (see ``app/main.py``).
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.core.executors import run_storage
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.symbols import normalize_symbol
from app.core.market import (
    VALID_INTERVALS,
    parse_custom_interval,
)
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolver,
    IntervalRouteKind,
)
from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    last_closed_bar_open_ms,
    parse_interval_ms,
)
from app.data_engine.history import (
    TradingCalendar,
    containing_expected_open_ms,
    expected_bucket_end_ms,
    latest_closed_expected_open_ms,
)
from app.data_engine.storage import DEFAULT_EXCHANGE, DEFAULT_MARKET_TYPE

router = APIRouter(prefix="/klines", tags=["klines"])
logger = logging.getLogger("api.klines")

RELATED_WARMUP_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")
MAX_RANGE_RESPONSE_BARS = 5_000
RELATED_WARMUP_TARGET_BARS = 1_000


# ═══════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════


def _get_data_manager(request: Request) -> Any:
    """Retrieve the DataManager from app state."""
    return getattr(request.app.state, "data_manager", None)


def _get_data_engine_runtime(request: Request) -> Any:
    return getattr(request.app.state, "data_engine_runtime", None)


def _get_backfill_coordinator(request: Request) -> Any:
    runtime = _get_data_engine_runtime(request)
    if runtime is not None:
        get_coordinator = getattr(runtime, "get_backfill_coordinator", None)
        if callable(get_coordinator):
            return get_coordinator()
    return getattr(request.app.state, "backfill_coordinator", None)


def _require_data_manager(request: Request) -> Any:
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    return dm


def _validate_interval(interval: str) -> None:
    """Accept both native exchange intervals and valid custom intervals."""
    if interval in VALID_INTERVALS:
        return
    parsed = parse_custom_interval(interval)
    if parsed is None or parsed <= 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported interval: {interval}. "
                f"Supported native: {VALID_INTERVALS}. "
                f"Custom format: <number><s|m|h|d|w|M>, e.g. 7m, 45m, 3h"
            ),
        )


def _validate_market_type(market_type: str) -> str:
    return (market_type or DEFAULT_MARKET_TYPE).strip().lower()


def _validate_exchange(exchange: str) -> str:
    normalized = (exchange or DEFAULT_EXCHANGE).strip().lower()
    bootstrap_default_adapters()
    if not get_exchange_registry().has(normalized):
        raise HTTPException(status_code=400, detail=f"Unsupported exchange: {exchange}")
    return normalized


def _resolve_interval(
    interval: str,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    purpose: IntervalPurpose = IntervalPurpose.HISTORY,
) -> dict:
    """Return exchange-aware resolution info for the requested interval."""
    route = IntervalResolver().resolve(
        exchange=exchange,
        market_type=market_type,
        interval=interval,
        purpose=purpose,
    )
    base_interval = (
        route.native_interval
        if route.kind is IntervalRouteKind.NATIVE
        else route.base_interval
    )
    base_ms = parse_interval_ms(base_interval or "") or route.spec.nominal_ms
    factor = max(1, route.spec.nominal_ms // base_ms)
    return {
        "is_custom": route.kind is IntervalRouteKind.DERIVED,
        "custom_seconds": route.spec.nominal_ms // 1000,
        "base_interval": base_interval,
        "factor": factor,
        "canonical_interval": route.canonical_interval,
        "native_interval": route.native_interval,
        "kind": route.kind.value,
        "purpose": route.purpose.value,
    }


def _bars_to_dicts(bars: list) -> list[dict]:
    """Convert bars to the enhanced Kline API contract."""
    return [
        b.to_kline_dict()
        if hasattr(b, "to_kline_dict")
        else b.to_dict()
        if hasattr(b, "to_dict")
        else b
        for b in bars
    ]


def _query_http_exception(exc: Exception, prefix: str) -> HTTPException:
    if isinstance(exc, IntervalResolutionError):
        return HTTPException(status_code=400, detail=exc.to_dict())
    return HTTPException(status_code=500, detail=f"{prefix}: {exc}")


def _call_data_manager_method(method: Any, *args: Any, **kwargs: Any) -> Any:
    """Call a DataManager method while tolerating older test doubles."""
    try:
        signature = inspect.signature(method)
        supports_kwargs = any(
            param.kind is inspect.Parameter.VAR_KEYWORD
            for param in signature.parameters.values()
        )
        if not supports_kwargs:
            kwargs = {
                key: value
                for key, value in kwargs.items()
                if key in signature.parameters
            }
    except (TypeError, ValueError):
        pass
    return method(*args, **kwargs)


def _backfill_request_ids(result: Any) -> list[str]:
    metadata = getattr(result, "metadata", None) or {}
    raw_ids = metadata.get("backfill_request_ids") or []
    if isinstance(raw_ids, str):
        raw_ids = [raw_ids]
    ids: list[str] = []
    seen: set[str] = set()
    for raw_id in raw_ids:
        request_id = str(raw_id or "").strip()
        if request_id and request_id not in seen:
            ids.append(request_id)
            seen.add(request_id)
    return ids


def _backfill_wait_tasks(
    request: Request,
    result: Any,
) -> set[asyncio.Task[bool]]:
    request_ids = _backfill_request_ids(result)
    if not request_ids:
        return set()

    coordinator = _get_backfill_coordinator(request)
    wait_for_request = getattr(coordinator, "wait_for_request", None)
    if not callable(wait_for_request):
        return set()

    async def _wait_one(request_id: str) -> bool:
        try:
            await wait_for_request(request_id)
            return True
        except Exception:
            logger.debug(
                "Waiting for backfill request %s failed",
                request_id,
                exc_info=True,
            )
            return False

    return {
        asyncio.create_task(_wait_one(request_id))
        for request_id in request_ids
    }


async def _poll_backfill_storage(
    request: Request,
    result: Any,
    *,
    timeout_seconds: float,
    requery: Callable[[bool], Awaitable[Any]],
    wait_through_partial_rows: bool = False,
    ready: Callable[[Any], bool] | None = None,
) -> Any:
    """Wait on exact repairs and re-query only on completion or timeout.

    Empty cold starts can return as soon as any rows appear.  A partial range
    with a known tail/interior repair must instead keep waiting for the exact
    repair future (within the same bounded budget), otherwise the API returns
    the known incomplete history immediately.  When exact request ids are not
    available, retain the legacy bounded polling fallback.
    """
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    wait_tasks = _backfill_wait_tasks(request, result)
    try:
        while True:
            remaining = deadline - time.monotonic()
            if wait_tasks:
                done: set[asyncio.Task[bool]] = set()
                if remaining > 0:
                    done, pending = await asyncio.wait(
                        wait_tasks,
                        timeout=remaining,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    wait_tasks = set(pending)
                for task in done:
                    # A terminal coordinator state is only a signal to inspect
                    # storage. It cannot prove that the committed rows satisfy
                    # coverage or trusted-finality publication requirements.
                    await task
            elif remaining > 0:
                await asyncio.sleep(min(0.2, remaining))

            # While exact requests are pending, inspect storage only when one
            # finishes or the budget expires. If all requests terminate but
            # publication is still not ready, bounded polling remains active:
            # a coordinator completion may precede a visible durable commit.
            result = await requery(False)
            result_ready = (
                bool(ready(result))
                if ready is not None
                else bool(result.bars and not wait_through_partial_rows)
            )
            if time.monotonic() >= deadline or result_ready:
                return result
    finally:
        for wait_task in wait_tasks:
            wait_task.cancel()
        if wait_tasks:
            await asyncio.gather(*wait_tasks, return_exceptions=True)


def _last_closed_open_ms(
    interval: str,
    now_ms: int | None = None,
    calendar: TradingCalendar | None = None,
) -> int:
    """Return the latest closed bar open_time for an interval."""
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    if calendar is not None:
        return latest_closed_expected_open_ms(calendar, now, interval) or 0
    return last_closed_bar_open_ms(now, interval) or 0


def _should_wait_for_backfill(result: Any) -> bool:
    """Return whether a response has a scheduled repair worth bounded waiting."""
    if not bool(getattr(result, "backfill_triggered", False)):
        return False
    if not getattr(result, "bars", None):
        return True
    return bool(
        getattr(result, "has_tail_gap", False)
        or getattr(result, "missing_ranges", None)
    )


def _first_expected_open_ms(start_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    bucket = compute_bucket_start_ms(start_ms, interval_ms, interval=interval)
    if bucket < start_ms:
        bucket = compute_bucket_end_ms(bucket, interval_ms, interval=interval)
    return bucket


def _next_expected_open_ms(open_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    return compute_bucket_end_ms(open_ms, interval_ms, interval=interval)


def _previous_expected_open_ms(open_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    return compute_bucket_start_ms(open_ms - 1, interval_ms, interval=interval)


def _interval_ms_for_request(interval: str) -> int:
    interval_ms = parse_interval_ms(interval)
    if interval_ms is not None and interval_ms > 0:
        return interval_ms
    custom_seconds = parse_custom_interval(interval) or 60
    return int(custom_seconds * 1000)


def _resolve_history_calendar(
    dm: Any,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
) -> tuple[TradingCalendar | None, bool]:
    resolver = getattr(dm, "history_policy", None)
    if resolver is None:
        return None, True
    try:
        key = resolver.series_key(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            channel="kline",
            variant=interval,
        )
        context = resolver.resolve(key)
        return context.calendar, context.calendar is not None
    except Exception as exc:
        logger.warning(
            "Unable to resolve history calendar for %s:%s:%s@%s: %s",
            exchange,
            market_type,
            symbol,
            interval,
            exc,
        )
        return None, False


def _history_contract_payload(
    result: Any,
    *,
    verified_contiguous: bool | None = None,
    missing_ranges: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Serialize the additive terminal/pending history contract."""
    metadata = dict(getattr(result, "metadata", None) or {})
    raw_all_rows_final = metadata.get("all_rows_final")
    all_rows_final = bool(raw_all_rows_final) if raw_all_rows_final is not None else False
    payload = {
        "history_state": getattr(result, "history_state", "ready"),
        "complete": bool(getattr(result, "complete", False)),
        "retryable": bool(getattr(result, "retryable", False)),
        "terminal_reason": getattr(result, "terminal_reason", None),
        "earliest_available_ms": getattr(result, "earliest_available_ms", None),
        "next_before_ms": getattr(result, "next_before_ms", None),
        "availability_revision": getattr(result, "availability_revision", None),
        "excluded_ranges": list(getattr(result, "excluded_ranges", ()) or ()),
        "retry_at_ms": metadata.get("backfill_retry_at_ms"),
        "all_rows_final": all_rows_final,
    }
    observed_missing = (
        list(getattr(result, "missing_ranges", ()) or ())
        if missing_ranges is None
        else missing_ranges
    )
    # API-level exact verification is authoritative for the returned range and
    # can find a gap that a count-based result alone cannot express.  A known
    # terminal edge may stop pagination farther left, but it cannot mark a
    # repairable hole inside the returned fetchable window as complete.
    if (
        verified_contiguous is False
        or bool(observed_missing)
        or not all_rows_final
    ):
        payload.update({
            "history_state": "pending",
            "complete": False,
            "retryable": True,
        })
    elif (
        verified_contiguous is True
        and all_rows_final
        and payload["history_state"] == "ready"
        and not observed_missing
    ):
        payload.update({"complete": True, "retryable": False})
    return payload


def _all_rows_final(result: Any) -> bool:
    """Return the QueryEngine finality verdict without inferring from OHLCV."""
    metadata = dict(getattr(result, "metadata", None) or {})
    value = metadata.get("all_rows_final")
    return bool(value) if value is not None else False


def _history_page_finality_ready(result: Any) -> bool:
    """Require proven final rows and no remaining repair work."""
    return bool(
        _all_rows_final(result)
        and not getattr(result, "missing_ranges", None)
        and not getattr(result, "has_tail_gap", False)
        and getattr(result, "history_state", "pending") != "pending"
        and not getattr(result, "retryable", False)
    )


def _cap_range_request(
    *,
    start_ms: int,
    end_ms: int,
    interval: str,
    max_bars: int = MAX_RANGE_RESPONSE_BARS,
    calendar: TradingCalendar | None = None,
) -> dict[str, Any]:
    interval_ms = _interval_ms_for_request(interval)
    if interval_ms <= 0 or end_ms < start_ms:
        return {
            "query_start_ms": start_ms,
            "query_end_ms": end_ms,
            "needed_limit": 0,
            "truncated": False,
            "next_end_ms": None,
            "interval_ms": interval_ms,
        }

    if calendar is not None:
        # Canonicalise an arbitrary inclusive edge to its containing expected
        # bucket.  Strict stepping with ``end_ms + 1`` leaks that +1 offset on
        # always-open calendars for non-standard widths such as 47m.
        last_open = containing_expected_open_ms(calendar, int(end_ms), interval)
        if last_open is None or last_open < start_ms:
            requested_bars = 0
            query_start_ms = start_ms
            next_older_open = None
        else:
            requested_bars = 1
            query_start_ms = last_open
            while requested_bars < max_bars:
                previous = calendar.previous_expected_open(query_start_ms, interval)
                if previous is None or previous < start_ms:
                    break
                query_start_ms = previous
                requested_bars += 1
            next_older_open = calendar.previous_expected_open(query_start_ms, interval)
        truncated = bool(
            requested_bars >= max_bars
            and next_older_open is not None
            and next_older_open >= start_ms
        )
        if truncated:
            return {
                "query_start_ms": query_start_ms,
                "query_end_ms": end_ms,
                "needed_limit": max_bars,
                "truncated": True,
                "next_end_ms": next_older_open,
                "interval_ms": interval_ms,
            }
    elif is_monthly_interval(interval):
        last_open = compute_bucket_start_ms(
            end_ms,
            interval_ms,
            interval=interval,
        )
        if last_open < start_ms:
            requested_bars = 0
            query_start_ms = start_ms
            next_older_open = None
        else:
            requested_bars = 1
            query_start_ms = last_open
            while requested_bars < max_bars:
                previous = _previous_expected_open_ms(query_start_ms, interval)
                if previous < start_ms:
                    break
                query_start_ms = previous
                requested_bars += 1
            next_older_open = _previous_expected_open_ms(query_start_ms, interval)
        truncated = bool(
            requested_bars >= max_bars
            and next_older_open is not None
            and next_older_open >= start_ms
        )
        if truncated:
            return {
                "query_start_ms": query_start_ms,
                "query_end_ms": end_ms,
                "needed_limit": max_bars,
                "truncated": True,
                "next_end_ms": next_older_open,
                "interval_ms": interval_ms,
            }
    else:
        requested_bars = int((end_ms - start_ms) / interval_ms) + 1
    if requested_bars <= max_bars:
        return {
            "query_start_ms": start_ms,
            "query_end_ms": end_ms,
            "needed_limit": min(max_bars, max(0, requested_bars - 1) + 100),
            "truncated": False,
            "next_end_ms": None,
            "interval_ms": interval_ms,
        }

    query_start_ms = max(start_ms, end_ms - ((max_bars - 1) * interval_ms))
    next_end_ms = query_start_ms - interval_ms if query_start_ms > start_ms else None
    return {
        "query_start_ms": query_start_ms,
        "query_end_ms": end_ms,
        "needed_limit": max_bars,
        "truncated": True,
        "next_end_ms": next_end_ms,
        "interval_ms": interval_ms,
    }


def _verify_range_continuity(
    *,
    data: list[dict],
    symbol: str,
    interval: str,
    exchange: str,
    market_type: str,
    start_ms: int,
    end_ms: int,
    calendar: TradingCalendar | None = None,
    calendar_known: bool = True,
    excluded_ranges: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Verify exact closed-bar continuity for a range returned to the chart."""
    if not calendar_known:
        return {
            "verified_contiguous": False,
            "missing_ranges": [],
            "expected_bars": 0,
            "actual_bars": len(data),
            "calendar_unknown": True,
        }

    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0 or start_ms > end_ms:
        return {
            "verified_contiguous": True,
            "missing_ranges": [],
            "expected_bars": 0,
            "actual_bars": len(data),
        }

    actual = {int(item["time"]) * 1000 for item in data if item.get("time") is not None}
    closed_actual = {
        int(item["time"]) * 1000
        for item in data
        if item.get("time") is not None and item.get("is_closed") is not False
    }
    exclusions: list[tuple[int, int]] = []
    for item in excluded_ranges or []:
        try:
            excluded_start = int(item["start_ms"])
            excluded_end = int(item["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if excluded_start <= excluded_end:
            exclusions.append((excluded_start, excluded_end))

    def _is_excluded(open_ms: int, bucket_end_ms: int) -> bool:
        # A custom candle is unverifiable when any suppressed durable base
        # component overlaps its bucket.  Point-only checks at the custom open
        # would miss (for example) a suppressed 15m component at +30m.
        return any(start <= bucket_end_ms and end >= open_ms for start, end in exclusions)

    current = (
        calendar.first_expected_open(start_ms, end_ms, interval)
        if calendar is not None
        else _first_expected_open_ms(start_ms, interval)
    )
    missing: list[dict[str, Any]] = []
    range_start: int | None = None
    range_end: int | None = None
    range_count = 0
    expected_count = 0

    def _flush_missing_range() -> None:
        nonlocal range_start, range_end, range_count
        if range_start is not None and range_end is not None:
            missing.append({
                "symbol": symbol.upper(),
                "interval": interval,
                "exchange": exchange,
                "market_type": market_type,
                "start_ms": range_start,
                "end_ms": range_end,
                "missing_bars": range_count,
                "reason": "range_verification",
                "status": "detected",
            })
        range_start = None
        range_end = None
        range_count = 0

    while current is not None and current <= end_ms:
        next_open = (
            calendar.next_expected_open(current, interval)
            if calendar is not None
            else _next_expected_open_ms(current, interval)
        )
        bucket_end = (
            expected_bucket_end_ms(calendar, current, interval) - 1
            if calendar is not None
            else (
                next_open - 1
                if next_open is not None and next_open > current
                else current
            )
        )
        if _is_excluded(current, bucket_end):
            # A terminal/cooldown bucket is a continuity boundary.  Keeping an
            # active run across it would submit one covering repair range that
            # includes the suppressed bucket and bypasses exact ledger lookup.
            _flush_missing_range()
            current = next_open
            continue
        expected_count += 1
        if current not in closed_actual:
            if range_start is None:
                range_start = current
                range_count = 0
            range_end = current
            range_count += 1
        elif range_start is not None:
            _flush_missing_range()
        current = next_open

    _flush_missing_range()

    return {
        "verified_contiguous": not missing,
        "missing_ranges": missing,
        "expected_bars": expected_count,
        "actual_bars": len(actual),
        "unclosed_bars": len(actual - closed_actual),
        "calendar_unknown": False,
    }


def _merge_missing_ranges(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[tuple[int, int], dict[str, Any]] = {}
    for group in groups:
        for item in group:
            try:
                key = (int(item["start_ms"]), int(item["end_ms"]))
            except (KeyError, TypeError, ValueError):
                continue
            existing = merged.get(key)
            if existing is None:
                merged[key] = dict(item)
                continue
            if existing.get("missing_bars") is None and item.get("missing_bars") is not None:
                existing["missing_bars"] = item["missing_bars"]
            if existing.get("reason") == "range_verification" and item.get("reason"):
                existing["reason"] = item["reason"]
    return sorted(merged.values(), key=lambda item: (item["start_ms"], item["end_ms"]))


def _verification_only_missing_ranges(
    verification_missing: list[dict[str, Any]],
    reported_missing: list[dict[str, Any]],
    *,
    interval: str,
    calendar: TradingCalendar | None,
) -> list[dict[str, Any]]:
    """Return verifier gaps not already covered by QueryEngine reports.

    QueryEngine-owned ranges have already gone through DataManager's normal
    submission path.  Work at expected-open granularity so a partially
    overlapping report submits only the uncovered portion, including for
    session-aware calendars and calendar-width intervals.
    """
    reported_bounds: list[tuple[int, int]] = []
    for item in reported_missing:
        try:
            start_ms = int(item["start_ms"])
            end_ms = int(item["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if start_ms <= end_ms:
            reported_bounds.append((start_ms, end_ms))

    uncovered: list[dict[str, Any]] = []
    for item in verification_missing:
        try:
            item_start = int(item["start_ms"])
            item_end = int(item["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if item_start > item_end:
            continue

        range_start: int | None = None
        range_end: int | None = None
        range_count = 0
        current: int | None = item_start
        while current is not None and current <= item_end:
            next_open = (
                calendar.next_expected_open(current, interval)
                if calendar is not None
                else _next_expected_open_ms(current, interval)
            )
            bucket_end = (
                expected_bucket_end_ms(calendar, current, interval) - 1
                if calendar is not None
                else (
                    next_open - 1
                    if next_open is not None and next_open > current
                    else current
                )
            )
            # Custom interval queries report the actionable missing component
            # in its durable base interval.  Any overlap inside this target
            # bucket is already submitted by DataManager and must not schedule
            # a second, unsupported custom-interval provider request.
            covered = any(
                start <= bucket_end and end >= current
                for start, end in reported_bounds
            )
            if covered:
                if range_start is not None and range_end is not None:
                    missing = dict(item)
                    missing.update({
                        "start_ms": range_start,
                        "end_ms": range_end,
                        "missing_bars": range_count,
                    })
                    uncovered.append(missing)
                    range_start = None
                    range_end = None
                    range_count = 0
            else:
                if range_start is None:
                    range_start = current
                range_end = current
                range_count += 1

            if next_open is None or next_open <= current:
                break
            current = next_open

        if range_start is not None and range_end is not None:
            missing = dict(item)
            missing.update({
                "start_ms": range_start,
                "end_ms": range_end,
                "missing_bars": range_count,
            })
            uncovered.append(missing)
    return uncovered


def _attach_backfill_request_ids(result: Any, request_ids: list[str]) -> None:
    if not request_ids:
        return
    metadata = dict(getattr(result, "metadata", None) or {})
    known = _backfill_request_ids(result)
    metadata["backfill_request_ids"] = list(dict.fromkeys([*known, *request_ids]))
    result.metadata = metadata


def _submit_verification_repairs(
    dm: Any,
    missing_ranges: list[dict[str, Any]],
    *,
    reason: str,
    requester: str,
) -> tuple[int, list[str], list[dict[str, Any]]]:
    """Submit exact API-only gaps through the normal DataManager facade."""
    request_backfill = getattr(dm, "request_backfill", None)
    suppression_lookup = getattr(dm, "get_backfill_suppression", None)
    if not callable(request_backfill) and not callable(suppression_lookup):
        return 0, [], []

    submitted = 0
    request_ids: list[str] = []
    suppressions: list[dict[str, Any]] = []
    for missing in missing_ranges:
        if callable(suppression_lookup):
            try:
                suppression = _call_data_manager_method(
                    suppression_lookup,
                    str(missing["symbol"]),
                    str(missing["interval"]),
                    int(missing["start_ms"]),
                    int(missing["end_ms"]),
                    str(missing["exchange"]),
                    str(missing["market_type"]),
                )
            except Exception:
                suppression = None
                logger.warning("Verification-only suppression lookup failed", exc_info=True)
            if isinstance(suppression, dict):
                suppressions.append({
                    **suppression,
                    "requested_start_ms": int(missing["start_ms"]),
                    "requested_end_ms": int(missing["end_ms"]),
                })
                continue
        if not callable(request_backfill):
            continue
        try:
            outcome = _call_data_manager_method(
                request_backfill,
                str(missing["symbol"]),
                str(missing["interval"]),
                int(missing["start_ms"]),
                int(missing["end_ms"]),
                str(missing["exchange"]),
                str(missing["market_type"]),
                reason=reason,
                requester=requester,
                metadata={
                    "query_reason": "range_verification",
                    "verification_only": True,
                    "requested_range": {
                        "start_ms": int(missing["start_ms"]),
                        "end_ms": int(missing["end_ms"]),
                    },
                    "missing_bars": missing.get("missing_bars"),
                },
            )
        except Exception:
            logger.warning(
                "Failed to submit verification-only K-line repair for %s:%s:%s@%s %s-%s",
                missing.get("exchange"),
                missing.get("market_type"),
                missing.get("symbol"),
                missing.get("interval"),
                missing.get("start_ms"),
                missing.get("end_ms"),
                exc_info=True,
            )
            continue
        # Current DataManager returns bool; coordinator-aware/test facades may
        # return an exact request id.  A legacy command returning None is still
        # considered accepted if it completed without raising.
        if outcome is False:
            continue
        submitted += 1
        if isinstance(outcome, str) and outcome.strip():
            request_ids.append(outcome.strip())
    return submitted, request_ids, suppressions


def _attach_verification_suppressions(
    result: Any,
    suppressions: list[dict[str, Any]],
) -> None:
    if not suppressions:
        return
    metadata = dict(getattr(result, "metadata", None) or {})
    existing_suppressions = list(metadata.get("backfill_suppressions") or [])
    metadata["backfill_suppressions"] = [*existing_suppressions, *suppressions]
    retry_deadlines = [
        int(item["retry_at_ms"])
        for item in suppressions
        if item.get("retry_at_ms") is not None
    ]
    if retry_deadlines:
        current = metadata.get("backfill_retry_at_ms")
        metadata["backfill_retry_at_ms"] = min(
            [*retry_deadlines, *([] if current is None else [int(current)])],
        )
    result.metadata = metadata

    exclusions = list(getattr(result, "excluded_ranges", ()) or ())
    known = {
        (item.get("start_ms"), item.get("end_ms"), item.get("reason"))
        for item in exclusions
        if isinstance(item, dict)
    }
    for item in suppressions:
        exclusion = {
            "start_ms": int(item["requested_start_ms"]),
            "end_ms": int(item["requested_end_ms"]),
            "disposition": "terminal",
            "reason": f"gap_ledger_{item.get('ledger_status') or 'suppressed'}",
            "ledger_status": item.get("ledger_status"),
            "retry_at_ms": item.get("retry_at_ms"),
        }
        identity = (
            exclusion["start_ms"],
            exclusion["end_ms"],
            exclusion["reason"],
        )
        if identity not in known:
            exclusions.append(exclusion)
            known.add(identity)
    result.excluded_ranges = exclusions


def _related_warmup_intervals(current_interval: str, *, limit: int = 3) -> list[str]:
    if current_interval not in RELATED_WARMUP_INTERVALS:
        return []

    current_index = RELATED_WARMUP_INTERVALS.index(current_interval)
    candidates: list[tuple[int, int, str]] = []
    for index, interval in enumerate(RELATED_WARMUP_INTERVALS):
        if interval == current_interval:
            continue
        distance = abs(index - current_index)
        direction_bias = 0 if index < current_index else 1
        candidates.append((distance, direction_bias, interval))
    return [interval for _, _, interval in sorted(candidates)[:limit]]


def _schedule_related_interval_warmup(
    dm: Any,
    *,
    symbol: str,
    current_interval: str,
    start_ms: int,
    end_ms: int,
    exchange: str,
    market_type: str,
) -> None:
    request_backfill = getattr(dm, "request_backfill", None)
    if request_backfill is None:
        return

    for interval in _related_warmup_intervals(current_interval):
        try:
            interval_ms = _interval_ms_for_request(interval)
            # ``end_ms`` is closed for the chart's current interval, but it
            # can still fall inside a forming candle of a wider related
            # interval.  Recompute the live edge for each target interval so
            # a 15m request at 16:45 does not try to repair the still-forming
            # 16:00 1h candle before 17:00.
            warmup_calendar, _ = _resolve_history_calendar(
                dm,
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                interval=interval,
            )
            warmup_end_ms = min(
                end_ms,
                _last_closed_open_ms(interval, calendar=warmup_calendar),
            )
            warmup_start_ms = max(
                start_ms,
                warmup_end_ms - (RELATED_WARMUP_TARGET_BARS * interval_ms),
            )
            # A narrow visible range can begin after the wider interval's
            # last closed open.  Fetch that one closed bar instead of emitting
            # an inverted range or falling forward into the forming candle.
            warmup_start_ms = min(warmup_start_ms, warmup_end_ms)
            _call_data_manager_method(
                request_backfill,
                symbol,
                interval,
                warmup_start_ms,
                warmup_end_ms,
                exchange,
                market_type,
                reason="related_interval_warmup",
                requester="klines_history_related",
                metadata={
                    "focus_scope": "related",
                    "current_interval": current_interval,
                    "requested_interval": interval,
                    "visible_range": {
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                    },
                    "warmup_range": {
                        "start_ms": warmup_start_ms,
                        "end_ms": warmup_end_ms,
                        "target_bars": RELATED_WARMUP_TARGET_BARS,
                    },
                },
            )
        except Exception as exc:
            logger.warning(
                "Failed to schedule related warmup for %s@%s: %s",
                symbol,
                interval,
                exc,
            )


# ═══════════════════════════════════════════════════════════════
#  Endpoints — DataManager-powered
# ═══════════════════════════════════════════════════════════════


@router.get("/")
async def get_klines(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(500, ge=1, le=1000, description="Number of rows"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get the latest K-line bars for a symbol/interval pair.

    Uses DataManager.query_latest() which resolves through
    Cache → Storage → Backfill automatically.
    """
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)
    consumer_id = f"rest:klines:{exchange}:{market_type}:{symbol}:{interval}:{id(request)}"
    stream_ensured = False
    try:
        await dm.ensure_stream(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            focus_scope="rest",
            consumer_id=consumer_id,
        )
        stream_ensured = True
        result = await run_storage(
            dm.query_latest, symbol, interval, limit,
            exchange,
            market_type=market_type,
        )
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager query failed") from exc
    finally:
        release_stream = getattr(dm, "release_stream", None)
        if stream_ensured and callable(release_stream):
            try:
                await release_stream(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    focus_scope="rest",
                    consumer_id=consumer_id,
                )
            except Exception:
                pass

    data = _bars_to_dicts(result.bars)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


@router.get("/latest")
async def get_latest_klines(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(2, ge=1, le=1000, description="Number of latest rows"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get the very latest K-line bars (typically 1-2 for live updates)."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    consumer_id = f"rest:klines_latest:{exchange}:{market_type}:{symbol}:{interval}:{id(request)}"
    stream_ensured = False
    try:
        await dm.ensure_stream(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            focus_scope="rest",
            consumer_id=consumer_id,
        )
        stream_ensured = True
        result = await run_storage(
            _call_data_manager_method,
            dm.query_latest, symbol, interval, limit,
            exchange,
            market_type=market_type,
            auto_backfill=False,
            backfill_reason="latest_refresh",
            backfill_requester="klines_latest",
        )
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager latest query failed") from exc
    finally:
        release_stream = getattr(dm, "release_stream", None)
        if stream_ensured and callable(release_stream):
            try:
                await release_stream(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    focus_scope="rest",
                    consumer_id=consumer_id,
                )
            except Exception:
                pass

    data = _bars_to_dicts(result.bars)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "backfill_triggered": result.backfill_triggered,
        **_history_contract_payload(result),
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


@router.get("/history")
async def get_klines_history(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    days: float = Query(7, ge=0.001, description="Historical days (supports fractional, e.g. 0.04); capped at 3650 unless count_back is provided"),
    count_back: int | None = Query(None, ge=1, le=MAX_RANGE_RESPONSE_BARS, description="Newest bar count to return; overrides days window when provided"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    max_wait_ms: int = Query(
        3500,
        ge=0,
        le=8000,
        description=(
            "Cold-start budget (ms) to briefly wait for an initial backfill to "
            "deliver bars before returning. Only applies when cache/storage are "
            "empty and a backfill was triggered; warm queries return immediately."
        ),
    ),
):
    """Get historical K-line bars for a time range."""
    if count_back is None and days > 3650:
        raise HTTPException(
            status_code=422,
            detail="days must be less than or equal to 3650 when count_back is omitted",
        )
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    calendar, calendar_known = _resolve_history_calendar(
        dm,
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
    )
    try:
        end_ms = min(
            int(time.time() * 1000),
            _last_closed_open_ms(interval, calendar=calendar),
        )
        interval_secs = parse_custom_interval(interval) or 60
        if count_back is not None:
            start_ms = end_ms
            if calendar is not None:
                for _ in range(count_back - 1):
                    if start_ms <= 0:
                        break
                    previous = calendar.previous_expected_open(start_ms, interval)
                    if previous is None:
                        break
                    start_ms = max(0, previous)
            elif is_monthly_interval(interval):
                for _ in range(count_back - 1):
                    if start_ms <= 0:
                        break
                    start_ms = max(
                        0,
                        _previous_expected_open_ms(start_ms, interval),
                    )
            else:
                start_ms = max(
                    0,
                    end_ms - int((count_back - 1) * interval_secs * 1000),
                )
            needed_limit = min(MAX_RANGE_RESPONSE_BARS, count_back)
        else:
            start_ms = end_ms - int(days * 24 * 60 * 60 * 1000)
            cap = _cap_range_request(
                start_ms=start_ms,
                end_ms=end_ms,
                interval=interval,
                calendar=calendar,
            )
            start_ms = cap["query_start_ms"]
            needed_limit = cap["needed_limit"]

        async def _run_history_query(auto_backfill=None):
            return await run_storage(
                _call_data_manager_method,
                dm.query,
                symbol, interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=needed_limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                backfill_reason="initial_history",
                backfill_requester="klines_history",
            )

        def _verify_history_result(candidate: Any) -> tuple[list[dict], dict[str, Any]]:
            candidate_data = _bars_to_dicts(candidate.bars)
            candidate_verification = _verify_range_continuity(
                data=candidate_data,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                start_ms=start_ms,
                end_ms=end_ms,
                calendar=calendar,
                calendar_known=calendar_known,
                excluded_ranges=getattr(candidate, "excluded_ranges", None),
            )
            return candidate_data, candidate_verification

        result = await _run_history_query()
        backfill_triggered = bool(result.backfill_triggered)
        data, verification = _verify_history_result(result)
        reported_missing = [item.to_dict() for item in result.missing_ranges]
        verification_only = _verification_only_missing_ranges(
            verification["missing_ranges"],
            reported_missing,
            interval=interval,
            calendar=calendar,
        )
        submitted, request_ids, suppressions = _submit_verification_repairs(
            dm,
            verification_only,
            reason="initial_history",
            requester="klines_history",
        )
        if submitted:
            result.backfill_triggered = True
            _attach_backfill_request_ids(result, request_ids)
            backfill_triggered = True
        if suppressions:
            _attach_verification_suppressions(result, suppressions)
            data, verification = _verify_history_result(result)

        # Cold-start path: the first query of an uncached series returns no bars
        # and only schedules an *async* backfill. Without a brief wait the chart
        # paints blank and depends entirely on the client retry loop / WS event
        # to recover, which is what makes K-lines "sometimes" fail to load.
        # Poll the (fast, ~sub-second) backfill within a bounded budget so the
        # very first response already carries data. Poll re-queries pass
        # auto_backfill=False so we wait for the already-scheduled backfill
        # instead of spamming duplicate backfill requests.
        if max_wait_ms > 0 and (
            _should_wait_for_backfill(result)
            or bool(submitted and verification_only)
        ):
            result = await _poll_backfill_storage(
                request,
                result,
                timeout_seconds=max_wait_ms / 1000,
                requery=_run_history_query,
                wait_through_partial_rows=bool(result.bars or verification_only),
                ready=lambda candidate: (
                    (
                        _verify_history_result(candidate)[1]["verified_contiguous"]
                        and _all_rows_final(candidate)
                    )
                    or (
                        not candidate.bars
                        and _all_rows_final(candidate)
                        and candidate.history_state == "exhausted"
                        and candidate.complete
                        and not candidate.retryable
                    )
                ),
            )
            data, verification = _verify_history_result(result)
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager history query failed") from exc

    _schedule_related_interval_warmup(
        dm,
        symbol=symbol,
        current_interval=interval,
        start_ms=start_ms,
        end_ms=end_ms,
        exchange=exchange,
        market_type=market_type,
    )

    missing_ranges = _merge_missing_ranges(
        [r.to_dict() for r in result.missing_ranges],
        verification["missing_ranges"],
    )
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "days": days,
        "count_back": count_back,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "has_tail_gap": result.has_tail_gap,
        "backfill_triggered": backfill_triggered,
        "verified_contiguous": verification["verified_contiguous"],
        "missing_ranges": missing_ranges,
        **_history_contract_payload(
            result,
            verified_contiguous=verification["verified_contiguous"],
            missing_ranges=missing_ranges,
        ),
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


@router.get("/range")
async def get_klines_range(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1m", description="Kline interval"),
    start_ms: int = Query(..., ge=0, description="Inclusive range start in milliseconds"),
    end_ms: int = Query(..., ge=0, description="Inclusive range end in milliseconds"),
    repair: str = Query("async", description="Repair mode: none, async, or wait"),
    wait_ms: int = Query(0, ge=0, le=5000, description="Max wait time for repair=wait"),
    strict: bool = Query(True, description="Whether caller requires continuity metadata"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get K-lines for an exact time range with continuity verification."""
    _validate_interval(interval)
    if end_ms < start_ms:
        raise HTTPException(status_code=400, detail="end_ms must be >= start_ms")
    repair_mode = (repair or "async").strip().lower()
    if repair_mode not in {"none", "async", "wait"}:
        raise HTTPException(status_code=400, detail="repair must be one of: none, async, wait")

    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)
    calendar, calendar_known = _resolve_history_calendar(
        dm,
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
    )

    now_ms = int(time.time() * 1000)
    effective_end_ms = min(
        end_ms,
        _last_closed_open_ms(interval, now_ms, calendar=calendar),
    )
    if effective_end_ms < start_ms:
        return {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol.upper(),
            "interval": interval,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "effective_end_ms": effective_end_ms,
            "query_start_ms": start_ms,
            "query_end_ms": effective_end_ms,
            "truncated": False,
            "next_end_ms": None,
            "count": 0,
            "source": "empty",
            "fetched": 0,
            "has_tail_gap": False,
            "backfill_triggered": False,
            "verified_contiguous": True,
            "renderable": True,
            "missing_ranges": [],
            "history_state": "ready",
            "complete": True,
            "retryable": False,
            "terminal_reason": None,
            "earliest_available_ms": None,
            "next_before_ms": None,
            "availability_revision": None,
            "excluded_ranges": [],
            "cache": {"strict": strict, "repair": repair_mode},
            "data": [],
            "base_interval": None,
        }

    range_cap = _cap_range_request(
        start_ms=start_ms,
        end_ms=effective_end_ms,
        interval=interval,
        calendar=calendar,
    )
    query_start_ms = range_cap["query_start_ms"]
    query_end_ms = range_cap["query_end_ms"]
    needed_limit = range_cap["needed_limit"]

    try:
        async def _run_range_query(auto_backfill: bool):
            return await run_storage(
                _call_data_manager_method,
                dm.query,
                symbol,
                interval,
                start_ms=query_start_ms,
                end_ms=query_end_ms,
                limit=needed_limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                backfill_reason="visible_range_gap",
                backfill_requester="klines_range",
            )

        def _verify_range_result(candidate: Any) -> tuple[list[dict], dict[str, Any]]:
            candidate_data = _bars_to_dicts(candidate.bars)
            candidate_verification = _verify_range_continuity(
                data=candidate_data,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                start_ms=query_start_ms,
                end_ms=query_end_ms,
                calendar=calendar,
                calendar_known=calendar_known,
                excluded_ranges=getattr(candidate, "excluded_ranges", None),
            )
            return candidate_data, candidate_verification

        result = await _run_range_query(repair_mode != "none")
        backfill_triggered = bool(result.backfill_triggered)
        data, verification = _verify_range_result(result)
        reported_missing = [item.to_dict() for item in result.missing_ranges]
        verification_only = _verification_only_missing_ranges(
            verification["missing_ranges"],
            reported_missing,
            interval=interval,
            calendar=calendar,
        )
        if repair_mode != "none":
            submitted, request_ids, suppressions = _submit_verification_repairs(
                dm,
                verification_only,
                reason="visible_range_gap",
                requester="klines_range",
            )
            if submitted:
                result.backfill_triggered = True
                _attach_backfill_request_ids(result, request_ids)
                backfill_triggered = True
            if suppressions:
                _attach_verification_suppressions(result, suppressions)
                data, verification = _verify_range_result(result)

        if (
            repair_mode == "wait"
            and wait_ms > 0
            and (
                not verification["verified_contiguous"]
                or not _all_rows_final(result)
            )
            and result.backfill_triggered
        ):
            result = await _poll_backfill_storage(
                request,
                result,
                timeout_seconds=wait_ms / 1000,
                requery=_run_range_query,
                wait_through_partial_rows=True,
                ready=lambda candidate: (
                    _verify_range_result(candidate)[1]["verified_contiguous"]
                    and _all_rows_final(candidate)
                ),
            )
            data, verification = _verify_range_result(result)
            backfill_triggered = backfill_triggered or bool(result.backfill_triggered)
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager range query failed") from exc

    missing_ranges = _merge_missing_ranges(
        [r.to_dict() for r in result.missing_ranges],
        verification["missing_ranges"],
    )
    verified = verification["verified_contiguous"]
    all_rows_final = _all_rows_final(result)
    renderable = (verified and all_rows_final) or not strict
    rendered_data = data if renderable else []
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "effective_end_ms": effective_end_ms,
        "query_start_ms": query_start_ms,
        "query_end_ms": query_end_ms,
        "truncated": range_cap["truncated"],
        "next_end_ms": range_cap["next_end_ms"],
        "count": len(rendered_data),
        "source": result.source.value,
        "fetched": result.total,
        "has_tail_gap": result.has_tail_gap,
        "backfill_triggered": backfill_triggered,
        "verified_contiguous": verified,
        "all_rows_final": all_rows_final,
        "renderable": renderable,
        "missing_ranges": missing_ranges,
        "expected_bars": verification["expected_bars"],
        "actual_bars": verification["actual_bars"],
        **_history_contract_payload(
            result,
            verified_contiguous=verified,
            missing_ranges=missing_ranges,
        ),
        "cache": result.metadata,
        "data": rendered_data,
        "base_interval": None,
    }


@router.get("/history/before")
async def get_klines_before(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    before: int = Query(..., description="Load data before this unix timestamp (seconds)"),
    bars: int = Query(500, ge=1, le=1000, description="How many bars to load"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
    max_wait_ms: int = Query(
        4500,
        ge=0,
        le=8000,
        description=(
            "Cold-start budget (ms) to briefly wait for a load-more backfill to "
            "deliver bars before returning. Only applies when the older region is "
            "uncached and a backfill was triggered. This keeps candles in sync "
            "with the server-computed indicator stream during drag-left, which "
            "otherwise paints indicators for bars the chart has not yet received."
        ),
    ),
):
    """Paginated historical data — load bars before a timestamp."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    try:
        before_ms = before * 1000

        async def _run_before_query(auto_backfill=None):
            return await run_storage(
                _call_data_manager_method,
                dm.query_before,
                symbol, interval, before_ms, bars,
                exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                backfill_reason="visible_load_more",
                backfill_requester="klines_history_before",
            )

        result = await _run_before_query()
        backfill_triggered = bool(result.backfill_triggered)
        has_more = bool(result.has_more)

        # Cold drag-left: an uncached older region returns no bars and only
        # schedules an async backfill. Poll the (fast) backfill within a bounded
        # budget so the first response carries candles, instead of leaving a
        # multi-second window where server-streamed indicators are drawn but the
        # candle series is still empty. Poll re-queries pass auto_backfill=False
        # to avoid spamming duplicate backfill requests.
        if max_wait_ms > 0 and _should_wait_for_backfill(result):
            result = await _poll_backfill_storage(
                request,
                result,
                timeout_seconds=max_wait_ms / 1000,
                requery=_run_before_query,
                wait_through_partial_rows=bool(result.bars),
                ready=_history_page_finality_ready,
            )
            # If the wait timed out before the backfill delivered bars, keep
            # has_more=True (data is still on the way) so the client retries
            # instead of concluding there is no more history. Re-queries made
            # with auto_backfill=False would otherwise report has_more=False.
            terminal = (
                getattr(result, "history_state", None) == "exhausted"
                or (
                    bool(getattr(result, "complete", False))
                    and not bool(getattr(result, "retryable", False))
                )
            )
            has_more = bool(result.has_more) if result.bars else not terminal
    except Exception as exc:
        raise _query_http_exception(exc, "DataManager before query failed") from exc

    data = _bars_to_dicts(result.bars)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "before": before,
        "bars": bars,
        "count": len(data),
        "has_more": has_more,
        "source": result.source.value,
        "fetched": result.total,
        "backfill_triggered": backfill_triggered,
        "missing_ranges": [r.to_dict() for r in result.missing_ranges],
        **_history_contract_payload(result),
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


@router.get("/resolve")
async def resolve_interval_info(
    interval: str = Query(..., description="Interval to resolve, e.g. '7m' or '45m'"),
    exchange: str = Query(DEFAULT_EXCHANGE),
    market_type: str = Query(DEFAULT_MARKET_TYPE),
    purpose: IntervalPurpose = Query(IntervalPurpose.HISTORY),
):
    """Return resolution metadata for a given interval string."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    try:
        res = _resolve_interval(
            interval,
            exchange=exchange,
            market_type=market_type,
            purpose=purpose,
        )
    except IntervalResolutionError as exc:
        raise HTTPException(status_code=400, detail=exc.to_dict()) from exc
    plan = (
        {
            "use_multi_res": False,
            "base_interval": res["base_interval"],
            "factor": res["factor"],
        }
        if res["is_custom"]
        else None
    )
    return {
        "interval": interval,
        "canonical_interval": res["canonical_interval"],
        "kind": res["kind"],
        "native_interval": res["native_interval"],
        "purpose": res["purpose"],
        "is_custom": res["is_custom"],
        "custom_seconds": res["custom_seconds"],
        "base_interval": res["base_interval"],
        "factor": res["factor"],
        "fetch_plan": plan,
    }


@router.get("/storage/meta")
async def get_storage_meta(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get storage metadata (bounds, count) for a series."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    try:
        meta = await run_storage(
            dm.get_bounds, symbol, interval,
            exchange,
            market_type=market_type,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DataManager bounds query failed: {exc}") from exc

    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "meta": meta,
    }


@router.get("/continuity")
async def get_klines_continuity(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1m", description="Kline interval"),
    start_ms: int | None = Query(None, ge=0, description="Inclusive scan start in milliseconds"),
    end_ms: int | None = Query(None, ge=0, description="Inclusive scan end in milliseconds"),
    limit: int = Query(50_000, ge=1, le=200_000, description="Maximum stored bars to scan"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Detect storage continuity gaps without triggering repair."""
    _validate_interval(interval)
    if start_ms is not None and end_ms is not None and end_ms < start_ms:
        raise HTTPException(status_code=400, detail="end_ms must be >= start_ms")
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    try:
        report = await run_storage(
            dm.scan_storage_gaps,
            symbol,
            interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
            limit=limit,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Continuity scan failed: {exc}") from exc

    return {
        **report,
        "verified_contiguous": report.get("gap_count", 0) == 0,
    }


@router.delete("/storage")
async def delete_storage_data(
    request: Request,
    symbol: str = Query(..., description="Trading symbol"),
    interval: str = Query(..., description="Kline interval"),
    start: int | None = Query(None, description="start unix timestamp (seconds)"),
    end: int | None = Query(None, description="end unix timestamp (seconds)"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Delete stored K-line data for a symbol/interval range."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)
    try:
        deleted = await dm.delete_storage_data(
            symbol=symbol,
            interval=interval,
            start_ms=start * 1000 if start is not None else None,
            end_ms=end * 1000 if end is not None else None,
            exchange=exchange,
            market_type=market_type,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Storage delete failed: {exc}") from exc

    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "deleted": deleted,
    }


def _calculate_sma_values(rows: list[dict], period: int) -> list[dict]:
    values: list[dict] = []
    closes: list[float] = []
    for row in rows:
        closes.append(float(row["close"]))
        if len(closes) < period:
            continue
        window = closes[-period:]
        values.append({
            "time": int(row["time"]),
            "value": round(sum(window) / period, 8),
        })
    return values


@router.get("/indicators/sma")
async def get_sma(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    period: int = Query(20, ge=2, le=500),
    start: int | None = Query(None, description="start unix timestamp (seconds)"),
    end: int | None = Query(None, description="end unix timestamp (seconds)"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Calculate SMA indicator values from DataManager query results."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)

    try:
        if start is not None or end is not None:
            result = await run_storage(
                dm.query,
                symbol,
                interval,
                start_ms=start * 1000 if start is not None else None,
                end_ms=end * 1000 if end is not None else None,
                limit=5000,
                exchange=exchange,
                market_type=market_type,
            )
        else:
            result = await run_storage(
                dm.query_latest,
                symbol,
                interval,
                max(period * 5, 500),
                exchange,
                market_type=market_type,
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SMA query failed: {exc}") from exc

    data = _calculate_sma_values(_bars_to_dicts(result.bars), period)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "period": period,
        "count": len(data),
        "data": data,
    }
