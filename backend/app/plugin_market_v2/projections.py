"""Canonical public projections shared by Phase 6 broker responses."""

from __future__ import annotations

from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    MARKET_BARS_PAGE_V1,
    MARKET_ORDER_BOOK_V1,
    MARKET_SYMBOLS_PAGE_V1,
    MARKET_TRADES_PAGE_V1,
    BarsReadRequest,
    MarketContext,
)
from app.data_engine.public_market_projection import (
    project_trade_history_payload,
    project_trade_recent_payload,
    public_bar_rows,
    serialize_public_value,
)


def project_bars_page(request: BarsReadRequest, result: Any) -> dict[str, Any]:
    rows = public_bar_rows(list(getattr(result, "bars", ()) or ()))
    metadata = dict(getattr(result, "metadata", None) or {})
    missing = [
        serialize_public_value(item)
        for item in list(getattr(result, "missing_ranges", ()) or ())
    ]
    all_rows_final = metadata.get("all_rows_final") is True
    raw_verified = metadata.get("verified_contiguous")
    if isinstance(raw_verified, bool):
        verified: bool | None = raw_verified
    elif missing or bool(getattr(result, "has_tail_gap", False)):
        verified = False
    else:
        # Absence of evidence is deliberately not promoted to continuity.
        verified = None
    bars = list(getattr(result, "bars", ()) or ())
    sources = sorted({str(getattr(item, "source", "") or "unknown") for item in bars})
    qualities = sorted(
        {str(getattr(item, "quality", "") or "unknown") for item in bars}
    )
    returned_times = [int(item["time"]) * 1000 for item in rows]
    source = getattr(result, "source", "empty")
    source_value = getattr(source, "value", source)
    return {
        "schemaVersion": MARKET_BARS_PAGE_V1,
        "context": request.context.to_wire(),
        "series": request.series.to_wire(),
        "data": rows,
        "coverage": {
            "requestedStartMs": request.start_ms,
            "requestedEndMs": request.end_ms,
            "requestedLimit": request.limit,
            "returnedStartMs": min(returned_times, default=None),
            "returnedEndMs": max(returned_times, default=None),
            "returnedCount": len(rows),
            "verifiedContiguous": verified,
            "allRowsFinal": all_rows_final,
            "missingRanges": missing,
            "excludedRanges": list(getattr(result, "excluded_ranges", ()) or ()),
        },
        "sourceQuality": {
            "source": str(source_value),
            "barSources": sources,
            "qualities": qualities,
            "trustedFinal": bool(all_rows_final and verified is True),
            "cacheHit": bool(getattr(result, "cache_hit", False)),
            "backfillTriggered": bool(getattr(result, "backfill_triggered", False)),
            "hasTailGap": bool(getattr(result, "has_tail_gap", False)),
        },
        "pagination": {
            "hasMore": bool(getattr(result, "has_more", False)),
            "historyState": str(getattr(result, "history_state", "ready")),
            "complete": bool(getattr(result, "complete", False)),
            "retryable": bool(getattr(result, "retryable", False)),
            "terminalReason": getattr(result, "terminal_reason", None),
            "earliestAvailableMs": getattr(result, "earliest_available_ms", None),
            "nextBeforeMs": getattr(result, "next_before_ms", None),
            "availabilityRevision": getattr(result, "availability_revision", None),
        },
    }


def project_symbols_page(
    *,
    context: MarketContext,
    quote_asset: str,
    search: str | None,
    after: str | None,
    limit: int,
    cached_at: float,
    symbols: list[dict[str, Any]],
) -> dict[str, Any]:
    filtered = [
        dict(item)
        for item in symbols
        if str(item.get("quoteAsset", "")).upper() == quote_asset
    ]
    if search:
        needle = search.upper()
        filtered = [
            item
            for item in filtered
            if needle in str(item.get("symbol", "")).upper()
            or needle in str(item.get("baseAsset", "")).upper()
        ]
    filtered.sort(key=lambda item: str(item.get("symbol", "")))
    if after:
        filtered = [item for item in filtered if str(item.get("symbol", "")) > after]
    page = filtered[:limit]
    has_more = len(filtered) > len(page)
    return {
        "schemaVersion": MARKET_SYMBOLS_PAGE_V1,
        "context": context.to_wire(),
        "quoteAsset": quote_asset,
        "count": len(page),
        "hasMore": has_more,
        "nextAfter": str(page[-1]["symbol"]) if has_more and page else None,
        "cachedAt": cached_at,
        "symbols": page,
    }


def wrap_trades(context: MarketContext, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": MARKET_TRADES_PAGE_V1,
        "context": context.to_wire(),
        "payload": payload,
    }


def wrap_order_book(context: MarketContext, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": MARKET_ORDER_BOOK_V1,
        "context": context.to_wire(),
        "payload": payload,
    }


__all__ = [
    "project_bars_page",
    "project_symbols_page",
    "project_trade_history_payload",
    "project_trade_recent_payload",
    "public_bar_rows",
    "serialize_public_value",
    "wrap_order_book",
    "wrap_trades",
]
