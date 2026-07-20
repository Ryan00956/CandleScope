"""HTTP snapshot/history surface for the advanced market-data main chain."""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query, Request

from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.interval_policy import parse_interval_spec


router = APIRouter(prefix="/market", tags=["market"])

_DEFAULT_CHANNELS = (
    MarketChannel.MARK_PRICE,
    MarketChannel.INDEX_PRICE,
    MarketChannel.FUNDING_RATE,
    MarketChannel.OPEN_INTEREST,
    MarketChannel.BASIS,
)


@router.get("/snapshot")
async def market_snapshot(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    channel: list[str] | None = Query(default=None),
    refresh_missing: bool = Query(default=True),
) -> dict:
    dm = _data_manager(request)
    try:
        keys = _stream_keys(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            channels=_parse_channels(channel),
        )
        records = await dm.market_snapshot(keys, refresh_missing=refresh_missing)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise _upstream_http_error("market snapshot", exc) from exc

    by_key = {record.event.key: record for record in records}
    return {
        "type": "market.snapshot",
        "as_of_ms": int(time.time() * 1000),
        "data": [by_key[key].to_dict() for key in keys if key in by_key],
        "missing": [key.to_dict() for key in keys if key not in by_key],
    }


@router.get("/history")
async def market_history(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    channel: str = Query(...),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    period: str | None = Query(default=None),
    view: str | None = Query(default=None),
    start_ms: int | None = Query(default=None, ge=0),
    end_ms: int | None = Query(default=None, ge=0),
    limit: int = Query(default=500, ge=1, le=1000),
) -> dict:
    dm = _data_manager(request)
    try:
        if start_ms is not None and end_ms is not None and start_ms > end_ms:
            raise ValueError("start_ms must be less than or equal to end_ms")
        parsed_channel = MarketChannel(channel.strip().lower())
        normalized_view = None if view is None else view.strip().lower()
        if normalized_view not in {None, "sparse", "hybrid"}:
            raise ValueError("funding history view must be 'sparse' or 'hybrid'")
        if normalized_view == "hybrid":
            if parsed_channel != MarketChannel.FUNDING_RATE:
                raise ValueError("hybrid history is available only for funding_rate")
            if period is None:
                raise ValueError("hybrid funding history requires a chart period")
            period_spec = parse_interval_spec(period)
            if period_spec is None:
                raise ValueError("hybrid funding history requires a valid chart period")
            period = period_spec.canonical
        key = MarketStreamKey.build(exchange, market_type, symbol, parsed_channel)
        history_kwargs = {
            "period": period,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "limit": limit,
        }
        if normalized_view is not None:
            history_kwargs["view"] = normalized_view
        page_reader = getattr(dm, "market_history_page", None)
        if callable(page_reader):
            page = await page_reader(key, **history_kwargs)
            events = page.events
            fallback = bool(page.fallback)
            page_complete_override = getattr(page, "complete", None)
            retryable = bool(getattr(page, "retryable", False))
            terminal_reason = getattr(page, "terminal_reason", None)
            earliest_available_ms = getattr(page, "earliest_available_ms", None)
            availability_revision = getattr(page, "availability_revision", None)
            excluded_ranges = list(getattr(page, "excluded_ranges", ()) or ())
        else:
            events = await dm.market_history(key, **history_kwargs)
            fallback = False
            page_complete_override = None
            retryable = False
            terminal_reason = None
            earliest_available_ms = None
            availability_revision = None
            excluded_ranges = []
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise _upstream_http_error("market history", exc) from exc

    response_key = key.to_dict()
    response_params: dict[str, str] = {}
    if period is not None:
        response_params["period"] = period
    if normalized_view is not None:
        response_params["view"] = normalized_view
    if response_params:
        response_key["params"] = response_params

    page_complete = (
        bool(page_complete_override)
        if page_complete_override is not None
        else not fallback and len(events) < limit
    )
    exhausted = bool(page_complete and terminal_reason and not retryable)
    return {
        "type": "market.history",
        "key": response_key,
        "count": len(events),
        "data": [event.to_dict() for event in events],
        "fallback": fallback,
        "has_more": fallback or not page_complete,
        "history_state": "exhausted" if exhausted else ("pending" if retryable else "ready"),
        "complete": page_complete,
        "retryable": retryable,
        "terminal_reason": terminal_reason if exhausted else None,
        "earliest_available_ms": earliest_available_ms,
        "next_before_ms": None if exhausted else None,
        "availability_revision": availability_revision,
        "excluded_ranges": excluded_ranges,
        "coverage": {
            "earliest_ms": min((event.event_time_ms for event in events), default=None),
            "latest_ms": max((event.event_time_ms for event in events), default=None),
            "complete": page_complete,
            "terminal_reason": terminal_reason if exhausted else None,
            "retryable": retryable,
            "earliest_available_ms": earliest_available_ms,
            "availability_revision": availability_revision,
        },
    }


def _data_manager(request: Request):
    dm = getattr(request.app.state, "data_manager", None)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager not initialized")
    if not getattr(dm, "market_data_ready", False):
        raise HTTPException(status_code=503, detail="Advanced market data is not initialized")
    return dm


def _parse_channels(values: list[str] | None) -> list[MarketChannel]:
    if not values:
        return list(_DEFAULT_CHANNELS)
    raw = [part for value in values for part in value.split(",")]
    channels: list[MarketChannel] = []
    for value in raw:
        normalized = value.strip().lower()
        if not normalized:
            continue
        try:
            channel = MarketChannel(normalized)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"Unsupported channel: {value}") from exc
        if channel not in channels:
            channels.append(channel)
    if not channels:
        raise HTTPException(status_code=422, detail="At least one channel is required")
    return channels


def _stream_keys(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    channels: list[MarketChannel],
) -> list[MarketStreamKey]:
    return [
        MarketStreamKey.build(exchange, market_type, symbol, channel)
        for channel in channels
    ]


def _upstream_http_error(operation: str, exc: Exception) -> HTTPException:
    status_code = getattr(exc, "status_code", None)
    if status_code in {418, 429}:
        retry_after = getattr(exc, "retry_after", None)
        headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
        return HTTPException(
            status_code=429,
            detail=f"{operation} is temporarily rate limited upstream",
            headers=headers,
        )
    return HTTPException(status_code=502, detail=f"{operation} is temporarily unavailable")
