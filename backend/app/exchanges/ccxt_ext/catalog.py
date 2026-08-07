"""Pinned CCXT exchange catalog and capability projection.

The catalog is intentionally built without network access.  It reflects the
exact CCXT package pinned by CandleScope and turns CCXT's ``has``/``features``
metadata into the narrower public-market-data contract that CandleScope can
actually deliver through the generic provider.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import ccxt
import ccxt.pro as ccxtpro

from app.data_engine.market_data.models import (
    DeliveryClass,
    MarketChannel,
    TransportMode,
)
from app.exchanges.models import (
    CRYPTO_24X7_CALENDAR_ID,
    ExchangeCapabilities,
    ExchangeMarket,
    HistoryAvailabilityPolicy,
    HistoryCadence,
    HistoryEmptyPageSemantics,
    MarketChannelCapability,
)

from .binance_usdm import SUPPORTED_CCXT_VERSION


_PUBLIC_METHODS = (
    "fetchOHLCV",
    "fetchTrades",
    "fetchOrderBook",
    "fetchTicker",
    "watchOHLCV",
    "watchTrades",
    "watchOrderBook",
    "watchTicker",
)
_BASE_MARKET_TYPES = ("spot", "swap", "future", "option")
_CONTRACT_MARKET_TYPES = frozenset({"swap", "future"})
_NON_24X7_EXCHANGES = frozenset({"alpaca"})
_UNKNOWN_CALENDAR_ID = "history.calendar.unknown"


@dataclass(frozen=True, slots=True)
class CcxtCatalogEntry:
    """Static, network-free metadata for one pinned CCXT exchange class."""

    exchange_id: str
    name: str
    pro: bool
    market_types: tuple[str, ...]
    timeframes: tuple[str, ...]
    methods: tuple[tuple[str, bool], ...]
    rate_limit_ms: int
    history_limit: int

    def supports(self, method: str) -> bool:
        return dict(self.methods).get(method, False)

    @property
    def has_realtime(self) -> bool:
        return self.pro and any(
            self.supports(method)
            for method in (
                "watchOHLCV",
                "watchTrades",
                "watchOrderBook",
                "watchTicker",
            )
        )


def assert_supported_ccxt_version() -> None:
    if ccxt.__version__ != SUPPORTED_CCXT_VERSION:
        raise RuntimeError(
            f"CandleScope requires ccxt=={SUPPORTED_CCXT_VERSION}, "
            f"found {ccxt.__version__}",
        )


@lru_cache(maxsize=1)
def get_ccxt_catalog() -> tuple[CcxtCatalogEntry, ...]:
    """Return the deterministic catalog for the pinned CCXT package."""

    assert_supported_ccxt_version()
    pro_ids = frozenset(ccxtpro.exchanges)
    entries: list[CcxtCatalogEntry] = []
    for exchange_id in ccxt.exchanges:
        exchange_class = getattr(ccxt, exchange_id)
        exchange = exchange_class()
        pro_exchange = (
            getattr(ccxtpro, exchange_id)()
            if exchange_id in pro_ids
            else None
        )
        methods = tuple(
            (
                name,
                _supported(
                    (
                        pro_exchange.has.get(name)
                        if name.startswith("watch") and pro_exchange is not None
                        else exchange.has.get(name)
                    )
                ),
            )
            for name in _PUBLIC_METHODS
        )
        entries.append(
            CcxtCatalogEntry(
                exchange_id=exchange_id,
                name=str(exchange.name or exchange_id),
                pro=exchange_id in pro_ids,
                market_types=_market_types(exchange),
                timeframes=tuple(
                    str(value)
                    for value in (exchange.timeframes or {}).keys()
                    if str(value).strip()
                ),
                methods=methods,
                rate_limit_ms=max(1, int(exchange.rateLimit or 1000)),
                history_limit=_history_limit(exchange),
            )
        )
    return tuple(entries)


def get_ccxt_catalog_entry(exchange_id: str) -> CcxtCatalogEntry:
    normalized = str(exchange_id or "").strip().lower()
    for entry in get_ccxt_catalog():
        if entry.exchange_id == normalized:
            return entry
    raise KeyError(f"Unknown pinned CCXT exchange: {exchange_id}")


def ccxt_catalog_summary() -> dict[str, Any]:
    catalog = get_ccxt_catalog()
    return {
        "version": SUPPORTED_CCXT_VERSION,
        "rest_exchange_ids": len(catalog),
        "pro_exchange_ids": sum(entry.pro for entry in catalog),
        "watch_ohlcv": sum(entry.supports("watchOHLCV") for entry in catalog),
        "watch_trades": sum(entry.supports("watchTrades") for entry in catalog),
        "watch_order_book": sum(
            entry.supports("watchOrderBook") for entry in catalog
        ),
        "watch_ticker": sum(entry.supports("watchTicker") for entry in catalog),
    }


def build_ccxt_capabilities(entry: CcxtCatalogEntry) -> ExchangeCapabilities:
    """Project CCXT metadata into CandleScope's fail-closed capability schema."""

    markets = [
        ExchangeMarket(
            market_type=market_type,
            product_type=_product_type(market_type),
            label=_market_label(market_type),
            contract_family=_contract_family(market_type),
            calendar_id=(
                _UNKNOWN_CALENDAR_ID
                if entry.exchange_id in _NON_24X7_EXCHANGES
                else CRYPTO_24X7_CALENDAR_ID
            ),
            timezone="UTC",
        )
        for market_type in entry.market_types
    ]
    channels: list[MarketChannelCapability] = []
    market_types = tuple(entry.market_types)

    fetch_ohlcv = entry.supports("fetchOHLCV")
    watch_ohlcv = entry.supports("watchOHLCV") and entry.pro
    if market_types and (fetch_ohlcv or watch_ohlcv):
        realtime_transports: list[TransportMode] = []
        if watch_ohlcv:
            realtime_transports.append(TransportMode.PLUGIN_STREAM)
        if fetch_ohlcv:
            realtime_transports.append(TransportMode.REST_POLL)
        calendar_id = (
            _UNKNOWN_CALENDAR_ID
            if entry.exchange_id in _NON_24X7_EXCHANGES
            else CRYPTO_24X7_CALENDAR_ID
        )
        channels.append(
            MarketChannelCapability(
                channel=MarketChannel.KLINE,
                market_types=market_types,
                realtime=True,
                history=fetch_ohlcv,
                realtime_transports=tuple(realtime_transports),
                history_transports=(TransportMode.REST_HISTORY,) if fetch_ohlcv else (),
                delivery=DeliveryClass.LATEST,
                snapshot=True,
                sequence="timestamp",
                params={"interval": list(entry.timeframes)},
                available_fields=(
                    "interval",
                    "open_time",
                    "close_time",
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                    "is_closed",
                ),
                unavailable_fields=(
                    "quote_volume",
                    "trades",
                    "taker_buy_base",
                    "taker_buy_quote",
                ),
                connection_model="plugin_sidecar" if watch_ohlcv else "polling_only",
                limits={"history.max_limit": entry.history_limit},
                known_limitations=(
                    "Forming-bar closure is inferred from the next CCXT candle boundary",
                ),
                history_policy=(
                    HistoryAvailabilityPolicy(
                        cadence=HistoryCadence.REGULAR,
                        empty_page_semantics=(
                            HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY
                        ),
                        calendar_id=calendar_id,
                        timezone="UTC",
                        max_page_size=entry.history_limit,
                    )
                    if fetch_ohlcv
                    else None
                ),
            )
        )

    fetch_trades = entry.supports("fetchTrades")
    watch_trades = entry.supports("watchTrades") and entry.pro
    if market_types and (fetch_trades or watch_trades):
        trade_transports: list[TransportMode] = []
        if watch_trades:
            trade_transports.append(TransportMode.PLUGIN_STREAM)
        if fetch_trades:
            trade_transports.append(TransportMode.REST_POLL)
        channels.append(
            MarketChannelCapability(
                channel=MarketChannel.TRADE,
                market_types=market_types,
                realtime=True,
                realtime_transports=tuple(trade_transports),
                delivery=DeliveryClass.APPEND,
                sequence="none",
                available_fields=(
                    "trade_id",
                    "price",
                    "quantity",
                    "trade_time_ms",
                    "side",
                    "is_buyer_maker",
                ),
                connection_model="plugin_sidecar" if watch_trades else "polling_only",
                known_limitations=(
                    "Trade identifiers are exchange-owned and are not assumed contiguous",
                ),
            )
        )

    fetch_book = entry.supports("fetchOrderBook")
    watch_book = entry.supports("watchOrderBook") and entry.pro
    if market_types and (fetch_book or watch_book):
        book_transports: list[TransportMode] = []
        if watch_book:
            book_transports.append(TransportMode.PLUGIN_STREAM)
        if fetch_book:
            book_transports.append(TransportMode.REST_SNAPSHOT)
        channels.append(
            MarketChannelCapability(
                channel=MarketChannel.DEPTH,
                market_types=market_types,
                realtime=True,
                realtime_transports=tuple(book_transports),
                delivery=DeliveryClass.SNAPSHOT,
                snapshot=True,
                sequence="none",
                resync="replace_snapshot",
                params={"depth_levels": [5, 10, 20]},
                available_fields=(
                    "depth_levels",
                    "update_interval_ms",
                    "last_update_id",
                    "bids",
                    "asks",
                ),
                connection_model="plugin_sidecar" if watch_book else "polling_only",
                known_limitations=(
                    "CCXT manages the incremental book and CandleScope receives bounded snapshots",
                    "Local snapshot revisions are not exchange sequence numbers",
                ),
            )
        )

    fetch_ticker = entry.supports("fetchTicker")
    watch_ticker = entry.supports("watchTicker") and entry.pro
    if market_types and (fetch_ticker or watch_ticker):
        ticker_transports: list[TransportMode] = []
        if watch_ticker:
            ticker_transports.append(TransportMode.PLUGIN_STREAM)
        if fetch_ticker:
            ticker_transports.append(TransportMode.REST_POLL)
        channels.append(
            MarketChannelCapability(
                channel=MarketChannel.TICKER,
                market_types=market_types,
                realtime=True,
                realtime_transports=tuple(ticker_transports),
                delivery=DeliveryClass.LATEST,
                snapshot=True,
                available_fields=(
                    "last_price",
                    "open_price",
                    "high_price",
                    "low_price",
                    "volume",
                    "quote_volume",
                    "bid_price",
                    "ask_price",
                ),
                connection_model="plugin_sidecar" if watch_ticker else "polling_only",
            )
        )

    return ExchangeCapabilities(
        exchange=entry.exchange_id,
        name=entry.name,
        plugin_api_version="1.0",
        # Schema v2+ requires at least one routable market/channel.  Keep a
        # pinned CCXT ID visible under the compatible v1 envelope when CCXT
        # itself declares no public market family, rather than inventing one.
        capability_schema_version=3 if markets else 1,
        markets=markets,
        channels=channels,
        native_intervals=list(entry.timeframes),
        supports_multi_symbol_ticker=False,
        supports_symbol_search=True,
        ws_connection_model=(
            "plugin_sidecar" if entry.has_realtime else "polling_only"
        ),
        protocol_features=[
            "provider.ccxt_unified",
            f"ccxt.version.{SUPPORTED_CCXT_VERSION}",
            "capability.runtime_market_validation",
            "orderbook.ccxt_managed_snapshot",
        ],
        limits={
            "ccxt.version": SUPPORTED_CCXT_VERSION,
            "ccxt.pro": entry.pro,
            "ccxt.rate_limit_ms": entry.rate_limit_ms,
            "rest.kline.max_limit": entry.history_limit,
        },
        known_limitations=[
            "Capability availability is derived from pinned CCXT metadata and revalidated after load_markets",
            "Strict exchange sequence/checksum order books require a dedicated raw profile",
        ],
    )


def market_selection_parts(market_type: str) -> tuple[str, str | None]:
    normalized = str(market_type or "spot").strip().lower()
    base, separator, subtype = normalized.partition(".")
    if base == "futures":
        base = "swap"
    if base not in _BASE_MARKET_TYPES:
        raise ValueError(f"Unsupported CCXT market type: {market_type}")
    if separator:
        if base not in _CONTRACT_MARKET_TYPES or subtype not in {"linear", "inverse"}:
            raise ValueError(f"Unsupported CCXT market subtype: {market_type}")
        return base, subtype
    return base, None


def market_matches_selection(market: dict[str, Any], market_type: str) -> bool:
    base, subtype = market_selection_parts(market_type)
    if not bool(market.get(base)):
        return False
    if subtype is not None and not bool(market.get(subtype)):
        return False
    return True


def _market_types(exchange: Any) -> tuple[str, ...]:
    features = exchange.features if isinstance(exchange.features, dict) else {}
    selections: list[str] = []
    for base in _BASE_MARKET_TYPES:
        # ``features`` inherits templates for market families an exchange does
        # not actually expose.  CCXT's top-level ``has`` flag is the safe
        # family gate; feature metadata only refines supported subtypes.
        if not _supported(exchange.has.get(base)):
            continue
        value = features.get(base)
        if base in _CONTRACT_MARKET_TYPES and isinstance(value, dict):
            subtypes = [
                subtype
                for subtype in ("linear", "inverse")
                if value.get(subtype) is not None
            ]
            if subtypes:
                selections.extend(f"{base}.{subtype}" for subtype in subtypes)
            elif value:
                selections.append(base)
            continue
        selections.append(base)

    if selections:
        return tuple(dict.fromkeys(selections))
    return ()


def _history_limit(exchange: Any) -> int:
    limits: list[int] = []
    features = exchange.features if isinstance(exchange.features, dict) else {}
    for market_type in _market_types(exchange):
        base, subtype = market_selection_parts(market_type)
        value = features.get(base)
        if subtype is not None and isinstance(value, dict):
            value = value.get(subtype)
        if not isinstance(value, dict):
            continue
        fetch = value.get("fetchOHLCV")
        if not isinstance(fetch, dict):
            continue
        limit = fetch.get("limit")
        if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0:
            limits.append(limit)
    return max(1, min(limits or [500]))


def _supported(value: Any) -> bool:
    return value is True or value == "emulated"


def _product_type(market_type: str) -> str:
    base, _subtype = market_selection_parts(market_type)
    return {
        "spot": "spot",
        "swap": "perpetual",
        "future": "delivery_future",
        "option": "option",
    }[base]


def _contract_family(market_type: str) -> str | None:
    base, subtype = market_selection_parts(market_type)
    if base not in _CONTRACT_MARKET_TYPES:
        return None
    return subtype or "exchange_default"


def _market_label(market_type: str) -> str:
    base, subtype = market_selection_parts(market_type)
    label = {
        "spot": "Spot",
        "swap": "Perpetual Swap",
        "future": "Delivery Future",
        "option": "Option",
    }[base]
    return f"{label} ({subtype.title()})" if subtype else label
