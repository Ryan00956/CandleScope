from __future__ import annotations

from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.exchanges.catalog_http import fetch_catalog_json

from .adapter import TwelveDataConfigurationError, twelve_data_auth_headers


async def fetch_twelve_data_quote(
    config: IngestionConfig,
    *,
    symbol: str,
    market_type: str,
) -> dict[str, Any]:
    payload = await fetch_catalog_json(
        exchange="twelvedata",
        market_type=market_type,
        base_urls=list(
            config.twelve_data_http_base_urls
            or ["https://api.twelvedata.com"]
        ),
        path="/quote",
        params={
            "symbol": str(symbol).strip().upper(),
            "dp": 11,
            "prepost": "false",
        },
        headers=twelve_data_auth_headers(config),
        timeout_seconds=float(config.http_timeout),
        proxy=config.http_proxy,
    )
    if not isinstance(payload, dict):
        raise ValueError("Twelve Data quote response must be an object")
    if payload.get("status") == "error":
        raise TwelveDataConfigurationError(
            str(payload.get("message") or "Twelve Data quote request failed")
        )
    if payload.get("close") in (None, "") and payload.get("price") in (None, ""):
        raise ValueError("Twelve Data quote response omitted the latest price")
    return payload


__all__ = ["fetch_twelve_data_quote"]
