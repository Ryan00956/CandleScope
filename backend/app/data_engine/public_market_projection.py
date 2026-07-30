"""Shared public market-data serialization used by HTTP and plugin consumers."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any


def serialize_public_value(value: Any) -> dict[str, Any]:
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return dict(to_dict())
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, dict):
        return dict(value)
    raise TypeError(f"unsupported public market value: {type(value).__name__}")


def public_bar_rows(bars: list[Any]) -> list[dict[str, Any]]:
    return [
        item.to_kline_dict()
        if hasattr(item, "to_kline_dict")
        else item.to_dict()
        if hasattr(item, "to_dict")
        else item
        for item in bars
    ]


def project_trade_recent_payload(key: Any, records: list[Any]) -> dict[str, Any]:
    data = [serialize_public_value(item) for item in records]
    ids = [int(item["agg_trade_id"]) for item in data]
    missing = [
        {"start_agg_trade_id": left + 1, "end_agg_trade_id": right - 1}
        for left, right in zip(ids, ids[1:])
        if right > left + 1
    ]
    continuity = bool(data) and all(
        right == left + 1 for left, right in zip(ids, ids[1:])
    )
    return {
        "type": "trade_flow.recent",
        "protocol": "tradeflow.v1",
        "key": key.to_dict(),
        "count": len(data),
        "data": data,
        "cursor": {
            "earliest_agg_trade_id": min(ids, default=None),
            "latest_agg_trade_id": max(ids, default=None),
        },
        "continuity": continuity,
        "resync_required": not continuity,
        "missing_agg_trade_id_ranges": missing,
        "bounded": True,
    }


def project_trade_history_payload(
    key: Any, records: list[Any], *, limit: int
) -> dict[str, Any]:
    data = [serialize_public_value(item) for item in records]
    times = [
        int(item.get("bucket_start_ms", item.get("bucket_open_ms"))) for item in data
    ]
    return {
        "type": "trade_flow.history",
        "protocol": "tradeflow.v1",
        "key": {**key.to_dict(), "params": {"period": "1m"}},
        "count": len(data),
        "data": data,
        "has_more": len(data) >= limit,
        "coverage": {
            "earliest_ms": min(times, default=None),
            "latest_ms": max(times, default=None),
            "all_rows_complete": bool(data)
            and all(bool(item.get("is_complete", False)) for item in data),
        },
    }


__all__ = [
    "project_trade_history_payload",
    "project_trade_recent_payload",
    "public_bar_rows",
    "serialize_public_value",
]
