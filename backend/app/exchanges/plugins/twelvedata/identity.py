from __future__ import annotations

from app.data_engine.series_identity import KlineSeriesIdentity


PROVIDER_ID = "twelvedata"
SUPPORTED_MARKET_TYPES = frozenset({"stock", "etf", "forex", "index", "commodity"})
EQUITY_MARKET_TYPES = frozenset({"stock", "etf"})
CONTINUOUS_MARKET_TYPES = frozenset({"forex", "commodity"})
US_EQUITY_VENUES = frozenset({
    "arcx",
    "bats",
    "baty",
    "edga",
    "edgx",
    "iexg",
    "nasdaq",
    "nyse",
    "otcm",
    "pinx",
    "xase",
    "xcis",
    "xnas",
    "xncm",
    "xngm",
    "xngs",
    "xnms",
    "xnys",
})


def expected_session_variant(market_type: str) -> str:
    return (
        "continuous_24x5"
        if str(market_type).strip().lower() in CONTINUOUS_MARKET_TYPES
        else "regular"
    )


def expected_volume_semantics(market_type: str) -> str:
    return (
        "shares"
        if str(market_type).strip().lower() in EQUITY_MARKET_TYPES
        else "unavailable"
    )


def identity_for_instrument(
    *,
    market_type: str,
    venue: str,
) -> KlineSeriesIdentity:
    canonical_market = str(market_type).strip().lower()
    if canonical_market not in SUPPORTED_MARKET_TYPES:
        raise ValueError(f"unsupported Twelve Data market type: {market_type!r}")
    return KlineSeriesIdentity(
        provider_id=PROVIDER_ID,
        venue=venue,
        asset_class=canonical_market,
        series_variant="ohlcv",
        price_adjustment="raw",
        session_variant=expected_session_variant(canonical_market),
        volume_semantics=expected_volume_semantics(canonical_market),
    )


def identity_is_supported(
    identity: KlineSeriesIdentity,
    *,
    market_type: str,
) -> bool:
    canonical_market = str(market_type).strip().lower()
    if canonical_market not in SUPPORTED_MARKET_TYPES:
        return False
    return (
        identity.provider_id == PROVIDER_ID
        and identity.venue not in {"", "unknown"}
        and identity.asset_class == canonical_market
        and identity.series_variant == "ohlcv"
        and identity.price_adjustment == "raw"
        and identity.session_variant == expected_session_variant(canonical_market)
        and identity.volume_semantics == expected_volume_semantics(canonical_market)
    )


def is_us_equity_venue(venue: object) -> bool:
    return str(venue or "").strip().lower() in US_EQUITY_VENUES


__all__ = [
    "CONTINUOUS_MARKET_TYPES",
    "EQUITY_MARKET_TYPES",
    "PROVIDER_ID",
    "SUPPORTED_MARKET_TYPES",
    "US_EQUITY_VENUES",
    "expected_session_variant",
    "expected_volume_semantics",
    "identity_for_instrument",
    "identity_is_supported",
    "is_us_equity_venue",
]
