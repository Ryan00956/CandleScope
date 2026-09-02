from __future__ import annotations

from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamType
from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.exchanges.catalog_http import fetch_catalog_json
from app.exchanges.models import (
    ExchangeCapabilities,
    ExchangeMarket,
    HistoryAvailabilityPolicy,
    HistoryCadence,
    HistoryEmptyPageSemantics,
    MarketChannelCapability,
    SymbolInfo,
)
from app.exchanges.ws_protocol import WsSubscriptionMode, WsSubscriptionSpec

from .identity import SUPPORTED_MARKET_TYPES
from .symbols import parse_symbol_search_payload


ALL_INTERVALS = (
    "1m", "5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h",
    "1d", "1w", "1M",
)
DAILY_INTERVALS = ("1d", "1w", "1M")
INTRADAY_INTERVALS = tuple(
    interval for interval in ALL_INTERVALS if interval not in DAILY_INTERVALS
)
WEEKDAY_CALENDAR_ID = "twelvedata.weekday.24x5.utc"
EXCHANGE_DATE_CALENDAR_ID = "twelvedata.exchange-date.weekdays.utc"


class TwelveDataConfigurationError(RuntimeError):
    """The provider is installed but has no usable server-side credential."""


def twelve_data_api_key(config: Any | None) -> str:
    value = str(getattr(config, "twelve_data_api_key", "") or "").strip()
    if not value:
        raise TwelveDataConfigurationError(
            "Twelve Data API key is not configured; set "
            "INGESTION_TWELVE_DATA_API_KEY on the backend"
        )
    return value


def twelve_data_auth_headers(config: Any | None) -> dict[str, str]:
    return {
        "Authorization": f"apikey {twelve_data_api_key(config)}",
        # Some Windows environments expose an incompatible optional Brotli
        # decoder to aiohttp. Prefer encodings supported by the core runtime
        # instead of letting a valid provider response fail during decoding.
        "Accept-Encoding": "gzip, deflate",
    }


class TwelveDataExchangeAdapter:
    id = "twelvedata"
    name = "Twelve Data"
    eager_catalog_refresh = False

    def capabilities(self) -> ExchangeCapabilities:
        markets = [
            ExchangeMarket(
                market_type=market_type,
                product_type=market_type,
                label=market_type.replace("_", " ").title(),
                calendar_id=(
                    WEEKDAY_CALENDAR_ID
                    if market_type in {"forex", "commodity"}
                    else EXCHANGE_DATE_CALENDAR_ID
                ),
                timezone="UTC",
            )
            for market_type in sorted(SUPPORTED_MARKET_TYPES)
        ]
        base_fields = (
            "interval", "open_time", "close_time", "open", "high", "low",
            "close", "is_closed",
        )
        ticker_fields = (
            "last_price",
            "open_price",
            "high_price",
            "low_price",
            "price_change_pct",
        )
        return ExchangeCapabilities(
            exchange=self.id,
            name=self.name,
            capability_schema_version=3,
            markets=markets,
            channels=[
                MarketChannelCapability(
                    channel=MarketChannel.KLINE,
                    market_types=("stock", "etf"),
                    realtime=False,
                    history=True,
                    history_transports=(TransportMode.REST_HISTORY,),
                    delivery=DeliveryClass.APPEND,
                    snapshot=True,
                    sequence="timestamp",
                    resync="replace_snapshot",
                    params={"interval": list(ALL_INTERVALS)},
                    available_fields=(*base_fields, "volume"),
                    limits={"rest.max_limit": 5000},
                    known_limitations=(
                        "Intraday history is regular-session only and requires a US venue identity",
                    ),
                    history_policy=HistoryAvailabilityPolicy(
                        cadence=HistoryCadence.SCHEDULED,
                        empty_page_semantics=(
                            HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY
                        ),
                        calendar_id=EXCHANGE_DATE_CALENDAR_ID,
                        timezone="UTC",
                        max_page_size=5000,
                    ),
                ),
                MarketChannelCapability(
                    channel=MarketChannel.KLINE,
                    market_types=("index",),
                    realtime=False,
                    history=True,
                    history_transports=(TransportMode.REST_HISTORY,),
                    delivery=DeliveryClass.APPEND,
                    snapshot=True,
                    sequence="timestamp",
                    resync="replace_snapshot",
                    params={"interval": list(DAILY_INTERVALS)},
                    available_fields=base_fields,
                    unavailable_fields=("volume",),
                    limits={"rest.max_limit": 5000},
                    history_policy=HistoryAvailabilityPolicy(
                        cadence=HistoryCadence.SCHEDULED,
                        empty_page_semantics=(
                            HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY
                        ),
                        calendar_id=EXCHANGE_DATE_CALENDAR_ID,
                        timezone="UTC",
                        max_page_size=5000,
                    ),
                ),
                MarketChannelCapability(
                    channel=MarketChannel.KLINE,
                    market_types=("forex", "commodity"),
                    realtime=False,
                    history=True,
                    history_transports=(TransportMode.REST_HISTORY,),
                    delivery=DeliveryClass.APPEND,
                    snapshot=True,
                    sequence="timestamp",
                    resync="replace_snapshot",
                    params={"interval": list(ALL_INTERVALS)},
                    available_fields=base_fields,
                    unavailable_fields=("volume",),
                    limits={"rest.max_limit": 5000},
                    history_policy=HistoryAvailabilityPolicy(
                        cadence=HistoryCadence.SCHEDULED,
                        empty_page_semantics=(
                            HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY
                        ),
                        calendar_id=WEEKDAY_CALENDAR_ID,
                        timezone="UTC",
                        max_page_size=5000,
                    ),
                ),
                MarketChannelCapability(
                    channel=MarketChannel.TICKER,
                    market_types=("stock", "etf"),
                    realtime=True,
                    realtime_transports=(
                        TransportMode.PLUGIN_STREAM,
                        TransportMode.REST_POLL,
                    ),
                    delivery=DeliveryClass.LATEST,
                    snapshot=True,
                    sequence="timestamp",
                    resync="replace_snapshot",
                    update_intervals_ms=(1000,),
                    available_fields=(*ticker_fields, "volume"),
                    unavailable_fields=("quote_volume",),
                    connection_model="plugin_sidecar",
                    limits={
                        "websocket.max_symbols": 8,
                        "rest.request_weight": 1,
                    },
                    known_limitations=(
                        "WebSocket publishes last price and optional day volume, not OHLC bars",
                        "Basic-plan WebSocket access is limited to provider-entitled trial symbols",
                    ),
                ),
                MarketChannelCapability(
                    channel=MarketChannel.TICKER,
                    market_types=("forex", "commodity"),
                    realtime=True,
                    realtime_transports=(
                        TransportMode.PLUGIN_STREAM,
                        TransportMode.REST_POLL,
                    ),
                    delivery=DeliveryClass.LATEST,
                    snapshot=True,
                    sequence="timestamp",
                    resync="replace_snapshot",
                    update_intervals_ms=(1000,),
                    available_fields=ticker_fields,
                    unavailable_fields=("volume", "quote_volume"),
                    connection_model="plugin_sidecar",
                    limits={
                        "websocket.max_symbols": 8,
                        "rest.request_weight": 1,
                    },
                    known_limitations=(
                        "WebSocket publishes price ticks; volume is not guaranteed",
                        "Commodity access remains provider-entitlement dependent",
                    ),
                ),
            ],
            native_intervals=list(ALL_INTERVALS),
            supports_multi_symbol_ticker=False,
            supports_symbol_search=True,
            ws_connection_model="plugin_sidecar",
            protocol_features=[
                "rest.kline.history_only",
                "rest.symbol_search.query_only",
                "auth.authorization_header",
                "pagination.reverse_time",
                "price_adjustment.raw",
                "rest.quote.snapshot",
                "ws.price.shared_subscription",
                "ws.max_symbols.8",
            ],
            limits={
                "rest.kline.max_limit": 5000,
                "symbol_search.max_limit": 120,
                "websocket.max_symbols": 8,
                "websocket.max_connections": 1,
            },
            known_limitations=[
                "K-line realtime is unavailable; Twelve Data WebSocket exposes price ticks only",
                "Daily and coarser exchange-session bars use provider exchange dates",
                "Forex, index, and commodity volume is explicitly unavailable",
                "Provider entitlements are enforced by Twelve Data at request time",
            ],
        )

    async def list_symbols(self, market_type: str = "") -> list[SymbolInfo]:
        del market_type
        raise TwelveDataConfigurationError(
            "Twelve Data uses query-based symbol search; call search_symbols()"
        )

    async def search_symbols(
        self,
        query: str,
        market_type: str = "",
        *,
        limit: int = 120,
        config: IngestionConfig | None = None,
    ) -> list[SymbolInfo]:
        value = str(query or "").strip()
        if not value:
            return []
        cfg = config or IngestionConfig()
        payload = await fetch_catalog_json(
            exchange=self.id,
            market_type=market_type or "stock",
            base_urls=self.get_http_base_urls(market_type or "stock", config=cfg),
            path="/symbol_search",
            params={
                "symbol": value,
                "outputsize": min(120, max(1, int(limit))),
                "show_plan": "true",
            },
            headers=twelve_data_auth_headers(cfg),
            timeout_seconds=float(getattr(cfg, "http_timeout", 8)),
            proxy=getattr(cfg, "http_proxy", None),
        )
        return parse_symbol_search_payload(payload, market_type=market_type)

    def get_http_base_urls(
        self,
        market_type: str = "stock",
        config: Any | None = None,
    ) -> list[str]:
        del market_type
        configured = getattr(config, "twelve_data_http_base_urls", None)
        return list(configured or ["https://api.twelvedata.com"])

    def get_ws_base_urls(self, market_type: str = "stock", config: Any | None = None) -> list[str]:
        del market_type, config
        return []

    def get_rest_path(self, stream_type: Any, market_type: str = "stock") -> str | None:
        del market_type
        if stream_type == StreamType.KLINE:
            return "/time_series"
        if stream_type == StreamType.TICKER:
            return "/quote"
        return None

    def build_http_params(self, req: Any) -> dict[str, Any]:
        del req
        raise NotImplementedError("TwelveDataExchangeProtocol owns REST parameters")

    def build_ws_subscription(self, descriptor: Any) -> WsSubscriptionSpec:
        del descriptor
        return WsSubscriptionSpec(mode=WsSubscriptionMode.PATH)

    def supports_ws_streaming(self, market_type: str = "stock") -> bool:
        del market_type
        return False

    def get_multi_symbol_ticker_stream_name(self, market_type: str = "stock") -> None:
        del market_type
        return None

    def extract_http_rows(self, payload: Any, stream_type: Any) -> list[Any]:
        del stream_type
        if isinstance(payload, dict) and isinstance(payload.get("values"), list):
            return list(payload["values"])
        return []


__all__ = [
    "ALL_INTERVALS",
    "DAILY_INTERVALS",
    "EXCHANGE_DATE_CALENDAR_ID",
    "INTRADAY_INTERVALS",
    "TwelveDataConfigurationError",
    "TwelveDataExchangeAdapter",
    "WEEKDAY_CALENDAR_ID",
    "twelve_data_api_key",
    "twelve_data_auth_headers",
]
