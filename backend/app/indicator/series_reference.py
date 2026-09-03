"""Stable routed references shared by indicator caches and their revision registry."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote, unquote

from app.data_engine.series_identity import KlineSeriesIdentity, identity_from_mapping


def identity_for_meta(meta: dict[str, Any]) -> KlineSeriesIdentity:
    raw = meta.get("series_identity") or meta.get("seriesIdentity")
    if isinstance(raw, KlineSeriesIdentity):
        return raw
    if isinstance(raw, dict):
        aliases = {
            "providerId": "provider_id",
            "assetClass": "asset_class",
            "seriesVariant": "series_variant",
            "priceAdjustment": "price_adjustment",
            "sessionVariant": "session_variant",
            "volumeSemantics": "volume_semantics",
        }
        raw = {aliases.get(key, key): value for key, value in raw.items()}
    return identity_from_mapping(
        str(meta.get("exchange") or "binance"), raw if isinstance(raw, dict) else None
    )


def meta_from_key(key: Any, interval: str | None = None) -> dict[str, Any]:
    return {
        "exchange": key.exchange,
        "market_type": key.market_type,
        "symbol": key.symbol,
        "interval": interval or key.interval,
        "series_identity": getattr(key, "identity", None),
    }


def identity_kwargs(meta: dict[str, Any]) -> dict[str, KlineSeriesIdentity]:
    identity = identity_for_meta(meta)
    return (
        {}
        if identity.is_legacy_default_for(str(meta.get("exchange") or "binance"))
        else {"series_identity": identity}
    )


def series_reference(meta: dict[str, Any]) -> str:
    exchange = str(meta.get("exchange") or "binance").strip().lower()
    routed = ":".join(
        (
            exchange,
            str(meta.get("market_type") or meta.get("marketType") or "spot")
            .strip()
            .lower(),
            str(meta.get("symbol") or "").strip().upper(),
            str(meta.get("interval") or "").strip(),
        )
    )
    identity = identity_for_meta(meta)
    if identity.is_legacy_default_for(exchange):
        return routed
    return f"series:{quote(json.dumps(identity.to_dict(), sort_keys=True, separators=(',', ':')), safe='')}:{routed}"


def parse_series_reference(value: str) -> dict[str, Any]:
    identity = None
    if value.startswith("series:"):
        _, encoded, value = value.split(":", 2)
        identity = json.loads(unquote(encoded))
    exchange, market_type, tail = value.split(":", 2)
    symbol, interval = tail.rsplit(":", 1)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "interval": interval,
        **({"series_identity": identity} if identity is not None else {}),
    }
