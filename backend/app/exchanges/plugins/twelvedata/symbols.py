from __future__ import annotations

from typing import Any

from app.exchanges.models import SymbolInfo
from app.exchanges.plugin import DefaultSymbolNormalizer

from .identity import identity_for_instrument


_GENERIC_VENUES = frozenset({
    "",
    "COMMODITY",
    "INDEX",
    "PHYSICAL CURRENCY",
    "PHYSICAL_CURRENCY",
})


class TwelveDataSymbolNormalizer(DefaultSymbolNormalizer):
    """Preserve slash/venue-qualified provider symbols while canonicalising case."""

    def normalize(self, symbol: str, market_type: str = "stock") -> str:
        del market_type
        return str(symbol or "").strip().upper()


def market_type_for_instrument(instrument_type: object) -> str | None:
    value = str(instrument_type or "").strip().lower()
    if not value:
        return None
    if value == "etf" or "exchange traded fund" in value:
        return "etf"
    if "currency" in value or value == "forex":
        return "forex"
    if "index" in value:
        return "index"
    if any(token in value for token in ("commodity", "metal", "energy")):
        return "commodity"
    if any(token in value for token in (
        "stock",
        "common",
        "preferred",
        "depositary receipt",
        "reit",
    )):
        return "stock"
    return None


def parse_symbol_search_payload(
    payload: Any,
    *,
    market_type: str = "",
) -> list[SymbolInfo]:
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        return []
    rows = payload.get("data")
    if not isinstance(rows, list):
        return []

    requested_market = str(market_type or "").strip().lower()
    results: list[SymbolInfo] = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        resolved_market = market_type_for_instrument(row.get("instrument_type"))
        if resolved_market is None or (
            requested_market and requested_market != resolved_market
        ):
            continue

        raw_symbol = str(row.get("symbol") or "").strip().upper()
        exchange_name = str(row.get("exchange") or "").strip().upper()
        venue_mic = str(row.get("mic_code") or exchange_name or "UNKNOWN").strip().upper()
        if not raw_symbol:
            continue
        provider_symbol = (
            raw_symbol
            if exchange_name in _GENERIC_VENUES or ":" in raw_symbol
            else f"{raw_symbol}:{exchange_name}"
        )
        identity_key = (provider_symbol, resolved_market)
        if identity_key in seen:
            continue
        seen.add(identity_key)

        if resolved_market in {"forex", "commodity"} and "/" in raw_symbol:
            base_asset, quote_asset = raw_symbol.split("/", 1)
        else:
            base_asset = raw_symbol
            quote_asset = str(row.get("currency") or "LOCAL").strip().upper()
        access = row.get("access") if isinstance(row.get("access"), dict) else {}
        identity = identity_for_instrument(
            market_type=resolved_market,
            venue=venue_mic,
        )
        results.append(SymbolInfo(
            symbol=provider_symbol,
            base_asset=base_asset,
            quote_asset=quote_asset or "LOCAL",
            status="TRADING",
            exchange="twelvedata",
            market_type=resolved_market,
            product_type=resolved_market,
            display_name=str(row.get("instrument_name") or raw_symbol).strip(),
            currency=str(row.get("currency") or quote_asset or "").strip(),
            provider_instrument_id=provider_symbol,
            venue_mic=venue_mic,
            entitlement=str(access.get("plan") or "unknown"),
            redistribution="unknown",
            raw={
                "provider_symbol": raw_symbol,
                "exchange": exchange_name,
                "exchange_timezone": str(row.get("exchange_timezone") or ""),
                "country": str(row.get("country") or ""),
                "instrument_type": str(row.get("instrument_type") or ""),
                "access": dict(access),
            },
            **identity.to_dict(),
        ))
    return results


__all__ = [
    "TwelveDataSymbolNormalizer",
    "market_type_for_instrument",
    "parse_symbol_search_payload",
]
