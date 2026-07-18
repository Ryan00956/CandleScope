from __future__ import annotations

import logging
from typing import Any

import aiohttp

from app.core.config import (
    BINANCE_BASE_URL,
    BINANCE_BASE_URLS,
    BINANCE_FUTURES_BASE_URL,
    BINANCE_FUTURES_BASE_URLS,
    REQUEST_TIMEOUT,
    get_effective_proxy,
)
from app.core.market import VALID_INTERVALS
from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.data_engine.market_data.kline_metrics import KLINE_DERIVED_FIELDS
from app.exchanges.models import (
    CRYPTO_24X7_CALENDAR_ID,
    ExchangeCapabilities,
    ExchangeMarket,
    HistoryAvailabilityPolicy,
    HistoryCadence,
    HistoryEmptyPageSemantics,
    MarketChannelCapability,
    SymbolInfo,
)

from .protocol import BinanceExchangeProtocol

logger = logging.getLogger("candlescope.exchange.binance")

_REALTIME_TRANSPORTS = (TransportMode.WEBSOCKET, TransportMode.REST_POLL)
_KLINE_FIELDS = (
    "interval",
    "open_time",
    "close_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
    "is_closed",
)
_AGG_TRADE_FIELDS = (
    "agg_trade_id",
    "price",
    "quantity",
    "first_trade_id",
    "last_trade_id",
    "trade_time_ms",
    "is_buyer_maker",
)
_TICKER_FIELDS = (
    "price_change",
    "price_change_pct",
    "weighted_avg_price",
    "prev_close_price",
    "last_price",
    "last_qty",
    "bid_price",
    "bid_qty",
    "ask_price",
    "ask_qty",
    "open_price",
    "high_price",
    "low_price",
    "volume",
    "quote_volume",
    "open_time",
    "close_time",
    "trades",
)
_FUTURES_TICKER_UNAVAILABLE_FIELDS = (
    "prev_close_price",
    "bid_price",
    "bid_qty",
    "ask_price",
    "ask_qty",
)
_FUTURES_DEPTH_FIELDS = (
    "last_update_id",
    "first_update_id",
    "final_update_id",
    "previous_final_update_id",
    "event_time_ms",
    "transaction_time_ms",
    "depth_levels",
    "update_interval_ms",
    "bids",
    "asks",
)
_FULL_DEPTH_FIELDS = (
    "kind",
    "last_update_id",
    "first_update_id",
    "final_update_id",
    "previous_final_update_id",
    "event_time_ms",
    "transaction_time_ms",
    "update_interval_ms",
    "snapshot_limit",
    "bids",
    "asks",
)
_LIQUIDATION_FIELDS = (
    "order_side",
    "position_side",
    "order_type",
    "time_in_force",
    "original_quantity",
    "order_price",
    "average_price",
    "order_status",
    "last_filled_quantity",
    "filled_quantity",
    "trade_time_ms",
    "pair_symbol",
    "symbol_type",
)
_OPEN_INTEREST_PERIODS = ("5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d")


def _history_policy(cadence: HistoryCadence) -> HistoryAvailabilityPolicy:
    return HistoryAvailabilityPolicy(
        cadence=cadence,
        empty_page_semantics=HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY,
        calendar_id=CRYPTO_24X7_CALENDAR_ID,
        timezone="UTC",
    )


def _timestamp_ms(value: Any) -> int | None:
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _price_tick_size(item: dict[str, Any]) -> str:
    filters = item.get("filters")
    if not isinstance(filters, list):
        return ""
    for raw_filter in filters:
        if not isinstance(raw_filter, dict) or raw_filter.get("filterType") != "PRICE_FILTER":
            continue
        return str(raw_filter.get("tickSize", "")).strip()
    return ""


def _channel_capabilities() -> list[MarketChannelCapability]:
    return [
        MarketChannelCapability(
            channel=MarketChannel.KLINE,
            market_types=("spot",),
            realtime=True,
            history=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            history_transports=(TransportMode.REST_HISTORY,),
            delivery=DeliveryClass.APPEND,
            snapshot=True,
            sequence="timestamp",
            resync="replace_snapshot",
            params={"interval": list(VALID_INTERVALS)},
            update_intervals_ms=(1000, 2000),
            available_fields=_KLINE_FIELDS,
            derived_fields=KLINE_DERIVED_FIELDS,
            connection_model="path_per_stream",
            limits={"rest.max_limit": 1000},
            history_policy=_history_policy(HistoryCadence.REGULAR),
        ),
        MarketChannelCapability(
            channel=MarketChannel.KLINE,
            market_types=("futures",),
            realtime=True,
            history=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            history_transports=(TransportMode.REST_HISTORY,),
            delivery=DeliveryClass.APPEND,
            snapshot=True,
            sequence="timestamp",
            resync="replace_snapshot",
            params={"interval": [item for item in VALID_INTERVALS if item != "1s"]},
            update_intervals_ms=(250,),
            available_fields=_KLINE_FIELDS,
            derived_fields=KLINE_DERIVED_FIELDS,
            connection_model="path_per_stream",
            limits={"rest.max_limit": 1000},
            known_limitations=("The USD-M kline endpoint does not support 1s bars",),
            history_policy=_history_policy(HistoryCadence.REGULAR),
        ),
        MarketChannelCapability(
            channel=MarketChannel.AGG_TRADE,
            market_types=("spot",),
            realtime=True,
            history=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            history_transports=(TransportMode.REST_HISTORY,),
            delivery=DeliveryClass.APPEND,
            sequence="monotonic_id",
            resync="snapshot_replay",
            available_fields=_AGG_TRADE_FIELDS,
            connection_model="path_per_stream",
            limits={"rest.max_limit": 1000},
            history_policy=_history_policy(HistoryCadence.EVENT_DRIVEN),
        ),
        MarketChannelCapability(
            channel=MarketChannel.AGG_TRADE,
            market_types=("futures",),
            realtime=True,
            history=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            history_transports=(TransportMode.REST_HISTORY,),
            delivery=DeliveryClass.APPEND,
            sequence="monotonic_id",
            resync="snapshot_replay",
            update_intervals_ms=(100,),
            available_fields=_AGG_TRADE_FIELDS,
            connection_model="path_per_stream",
            limits={
                "rest.max_limit": 1000,
                "history.max_age_ms": 86_400_000,
                "history.max_window_ms": 3_600_000,
            },
            known_limitations=(
                "USD-M aggregate-trade history is limited to the last 24 hours",
                "Each USD-M aggregate-trade time range must be shorter than one hour",
            ),
            history_policy=_history_policy(HistoryCadence.EVENT_DRIVEN),
        ),
        MarketChannelCapability(
            channel=MarketChannel.TRADE,
            market_types=("spot", "futures"),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.APPEND,
            sequence="monotonic_id",
            available_fields=(
                "trade_id",
                "price",
                "quantity",
                "trade_time_ms",
                "is_buyer_maker",
                "buyer_order_id",
                "seller_order_id",
            ),
            connection_model="path_per_stream",
            known_limitations=(
                "REST exposes only recent trades and is not a historical range source",
                "Buyer and seller order IDs are WebSocket-only; REST normalizer zero placeholders are not data",
            ),
        ),
        MarketChannelCapability(
            channel=MarketChannel.TICKER,
            market_types=("spot",),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            update_intervals_ms=(1000,),
            available_fields=_TICKER_FIELDS,
            connection_model="path_per_stream",
        ),
        MarketChannelCapability(
            channel=MarketChannel.TICKER,
            market_types=("futures",),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            update_intervals_ms=(1000,),
            available_fields=tuple(
                field
                for field in _TICKER_FIELDS
                if field not in _FUTURES_TICKER_UNAVAILABLE_FIELDS
            ),
            unavailable_fields=_FUTURES_TICKER_UNAVAILABLE_FIELDS,
            connection_model="path_per_stream",
            known_limitations=(
                "USD-M 24h ticker omits prev-close and best bid/ask fields; "
                "normalizer zero placeholders are not data",
            ),
        ),
        MarketChannelCapability(
            channel=MarketChannel.MINI_TICKER,
            market_types=("spot", "futures"),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            update_intervals_ms=(1000,),
            available_fields=(
                "close_price",
                "open_price",
                "high_price",
                "low_price",
                "volume",
                "quote_volume",
            ),
            connection_model="path_per_stream",
        ),
        MarketChannelCapability(
            channel=MarketChannel.DEPTH,
            market_types=("spot",),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.SNAPSHOT,
            snapshot=True,
            sequence="monotonic_id",
            resync="replace_snapshot",
            params={"depth_levels": [5, 10, 20]},
            update_intervals_ms=(1000,),
            available_fields=("last_update_id", "bids", "asks"),
            connection_model="path_per_stream",
            limits={"rest.max_limit": 5000},
            known_limitations=(
                "Current depth events are replaceable snapshots, not ordered full-book deltas",
            ),
        ),
        MarketChannelCapability(
            channel=MarketChannel.DEPTH,
            market_types=("futures",),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.SNAPSHOT,
            snapshot=True,
            sequence="monotonic_id",
            resync="replace_snapshot",
            params={"depth_levels": [5, 10, 20]},
            update_intervals_ms=(100, 250, 500),
            available_fields=_FUTURES_DEPTH_FIELDS,
            connection_model="path_per_stream",
            limits={"rest.max_limit": 1000},
            known_limitations=(
                "Current depth events are replaceable snapshots, not ordered full-book deltas",
            ),
        ),
        MarketChannelCapability(
            channel=MarketChannel.FULL_DEPTH,
            market_types=("futures",),
            realtime=True,
            realtime_transports=(
                TransportMode.WEBSOCKET,
                TransportMode.REST_SNAPSHOT,
            ),
            delivery=DeliveryClass.ORDERED_DELTA,
            snapshot=True,
            delta=True,
            sequence="previous_link",
            resync="replace_snapshot",
            params={"snapshot_limit": [5, 10, 20, 50, 100, 500, 1000]},
            update_intervals_ms=(100, 250, 500),
            available_fields=_FULL_DEPTH_FIELDS,
            connection_model="path_per_stream",
            limits={
                "rest.default_limit": 500,
                "rest.max_limit": 1000,
            },
            known_limitations=(
                "A local full book is valid only after REST snapshot alignment with buffered WebSocket deltas",
                "Any broken previous-update link requires a fresh snapshot and buffered-delta replay",
                "Retail Price Improvement orders are excluded from both snapshot and delta feeds",
                "USD-M exposes no historical full-order-book replay endpoint",
            ),
        ),
        MarketChannelCapability(
            channel=MarketChannel.MARK_PRICE,
            market_types=("futures",),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            update_intervals_ms=(1000, 3000),
            available_fields=("mark_price",),
            derived_fields=("basis", "basis_rate", "basis_bps"),
            connection_model="shared_multiplex",
            limits={"websocket.multiplex_scope": "symbols"},
            known_limitations=("Mark-price OHLC history uses a different kline contract",),
        ),
        MarketChannelCapability(
            channel=MarketChannel.INDEX_PRICE,
            market_types=("futures",),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            update_intervals_ms=(1000, 3000),
            available_fields=("index_price",),
            connection_model="shared_multiplex",
            limits={"websocket.multiplex_scope": "symbols"},
            known_limitations=(
                "Realtime index price shares the mark-price upstream stream",
                "Index-price OHLC history uses a different kline contract",
            ),
        ),
        MarketChannelCapability(
            channel=MarketChannel.FUNDING_RATE,
            market_types=("futures",),
            realtime=True,
            history=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            history_transports=(TransportMode.REST_HISTORY,),
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            update_intervals_ms=(1000, 3000),
            available_fields=("funding_rate",),
            connection_model="shared_multiplex",
            limits={
                "history.max_limit": 1000,
                "history.shared_requests_per_5m": 500,
            },
            known_limitations=("Realtime funding data shares the mark-price upstream stream",),
            history_policy=_history_policy(HistoryCadence.SCHEDULED),
        ),
        MarketChannelCapability(
            channel=MarketChannel.OPEN_INTEREST,
            market_types=("futures",),
            realtime=True,
            history=True,
            realtime_transports=(TransportMode.REST_POLL,),
            history_transports=(TransportMode.REST_HISTORY,),
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            params={"period": list(_OPEN_INTEREST_PERIODS)},
            update_intervals_ms=(5000,),
            available_fields=("open_interest",),
            connection_model="polling_only",
            limits={
                "history.max_limit": 500,
                "history.max_age_ms": 2_592_000_000,
                "history.requests_per_5m": 1000,
                "realtime.request_weight": 1,
                "service.max_active_streams": 64,
            },
            known_limitations=("Binance USD-M exposes open interest through REST, not a public WS stream",),
            history_policy=_history_policy(HistoryCadence.REGULAR),
        ),
        MarketChannelCapability(
            channel=MarketChannel.LIQUIDATION,
            market_types=("futures",),
            realtime=True,
            realtime_transports=(TransportMode.WEBSOCKET,),
            delivery=DeliveryClass.APPEND,
            sequence="none",
            update_intervals_ms=(1000,),
            available_fields=_LIQUIDATION_FIELDS,
            connection_model="path_per_stream",
            known_limitations=(
                "Binance publishes only the latest liquidation order per symbol within each 1000ms window",
                "The public liquidation stream has no sequence or public order ID, so exact continuity and deduplication are unavailable",
                "Binance exposes no public market-level liquidation history, so disconnect gaps cannot be backfilled",
            ),
        ),
    ]


class BinanceExchangeAdapter:
    """Legacy facade for Binance exchange integration.

    New runtime code should use ``BinancePlugin.protocol()`` and other plugin
    policies. This adapter remains for compatibility with older imports and
    symbol metadata callers.
    """

    id = "binance"
    name = "Binance"

    def __init__(self) -> None:
        self._protocol = BinanceExchangeProtocol()

    def capabilities(self) -> ExchangeCapabilities:
        return ExchangeCapabilities(
            exchange=self.id,
            name=self.name,
            capability_schema_version=3,
            markets=[
                ExchangeMarket(
                    market_type="spot",
                    product_type="spot",
                    label="Spot",
                    calendar_id=CRYPTO_24X7_CALENDAR_ID,
                    timezone="UTC",
                ),
                ExchangeMarket(
                    market_type="futures",
                    product_type="perpetual",
                    label="USDT-M Perpetual",
                    contract_family="usdt-m",
                    calendar_id=CRYPTO_24X7_CALENDAR_ID,
                    timezone="UTC",
                ),
            ],
            channels=_channel_capabilities(),
            native_intervals=list(VALID_INTERVALS),
            supports_multi_symbol_ticker=True,
            supports_symbol_search=True,
            protocol_features=[
                "rest.kline",
                "rest.trades",
                "rest.depth",
                "ws.path_streams",
                "ws.futures_route_split",
                "pagination.reverse_time",
            ],
            limits={
                "rest.kline.max_limit": 1000,
                "rest.depth.max_limit": 5000,
            },
        )

    async def list_symbols(self, market_type: str = "") -> list[SymbolInfo]:
        normalized = (market_type or "").strip().lower()
        if not normalized:
            spot = await self._load_spot_symbols()
            futures = await self._load_futures_symbols()
            return spot + futures
        if normalized == "spot":
            return await self._load_spot_symbols()
        if normalized == "futures":
            return await self._load_futures_symbols()
        return []

    def get_http_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        return self._protocol.rest_base_urls(market_type, config=config)

    def get_ws_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        from app.data_engine.ingestion.models import StreamDescriptor, StreamType

        descriptor = StreamDescriptor(
            symbol="BTCUSDT",
            stream_type=StreamType.KLINE,
            interval="1m",
            exchange=self.id,
            market_type=market_type,
        )
        return self._protocol.ws_base_urls(descriptor, config=config)

    def get_ws_base_urls_for_descriptor(
        self,
        descriptor,
        market_type: str = "spot",
        config: Any | None = None,
    ) -> list[str]:
        return self._protocol.ws_base_urls(descriptor, config=config)

    def get_rest_path(self, stream_type, market_type: str = "spot") -> str | None:
        return self._protocol.rest_path(stream_type, market_type)

    def build_http_params(self, req) -> dict[str, Any]:
        return self._protocol.build_http_params(req)

    def build_ws_stream_name(self, descriptor) -> str:
        return self._protocol.build_ws_stream_name(descriptor)

    def build_ws_subscription(self, descriptor):
        return self._protocol.build_ws_subscription(descriptor)

    def get_multi_symbol_ticker_stream_name(self, market_type: str = "spot") -> str | None:
        return self._protocol.get_multi_symbol_ticker_stream_name(market_type)

    def supports_ws_streaming(self, market_type: str = "spot") -> bool:
        return True

    def extract_http_rows(self, payload: Any, stream_type) -> list[Any]:
        return self._protocol.extract_http_rows(payload, stream_type)

    async def _load_spot_symbols(self) -> list[SymbolInfo]:
        urls_to_try = [BINANCE_BASE_URL] + [
            url for url in BINANCE_BASE_URLS if url != BINANCE_BASE_URL
        ]
        data = await self._fetch_exchange_info(urls_to_try, "/api/v3/exchangeInfo")

        symbols: list[SymbolInfo] = []
        for item in data.get("symbols", []):
            if item.get("status") != "TRADING":
                continue
            symbols.append(
                SymbolInfo(
                    symbol=item["symbol"],
                    base_asset=item["baseAsset"],
                    quote_asset=item["quoteAsset"],
                    status=item["status"],
                    exchange=self.id,
                    market_type="spot",
                    product_type="spot",
                    raw=item,
                    listed_at_ms=_timestamp_ms(item.get("onboardDate")),
                    price_tick_size=_price_tick_size(item),
                ),
            )
        return symbols

    async def _load_futures_symbols(self) -> list[SymbolInfo]:
        urls_to_try = [BINANCE_FUTURES_BASE_URL] + [
            url for url in BINANCE_FUTURES_BASE_URLS if url != BINANCE_FUTURES_BASE_URL
        ]
        data = await self._fetch_exchange_info(urls_to_try, "/fapi/v1/exchangeInfo")

        symbols: list[SymbolInfo] = []
        for item in data.get("symbols", []):
            if item.get("status") != "TRADING":
                continue
            if item.get("contractType") != "PERPETUAL":
                continue
            contract_type = str(item.get("contractType", ""))
            symbols.append(
                SymbolInfo(
                    symbol=item["symbol"],
                    base_asset=item["baseAsset"],
                    quote_asset=item["quoteAsset"],
                    status=item["status"],
                    exchange=self.id,
                    market_type="futures",
                    product_type="perpetual",
                    contract_type=contract_type,
                    raw=item,
                    listed_at_ms=_timestamp_ms(item.get("onboardDate")),
                    # Binance publishes a far-future deliveryDate placeholder
                    # for perpetuals. It is not a delisting/expiry boundary.
                    expiry_at_ms=(
                        None
                        if contract_type == "PERPETUAL"
                        else _timestamp_ms(item.get("deliveryDate"))
                    ),
                    price_tick_size=_price_tick_size(item),
                ),
            )
        return symbols

    async def _fetch_exchange_info(
        self,
        base_urls: list[str],
        path: str,
    ) -> dict[str, Any]:
        proxy = get_effective_proxy()
        last_err: Exception | None = None

        for base in base_urls:
            url = f"{base}{path}"
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        url,
                        timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
                        proxy=proxy,
                    ) as resp:
                        if resp.status != 200:
                            logger.warning("exchangeInfo %s returned HTTP %s", base, resp.status)
                            continue
                        return await resp.json()
            except Exception as exc:
                last_err = exc
                logger.warning("exchangeInfo fetch failed from %s: %s", base, exc)

        raise RuntimeError(
            f"Failed to load exchange info for {self.id} from all endpoints: {last_err}"
        )
