"""Primary Binance/OKX plugins whose physical market-data I/O is CCXT-owned.

The old venue modules remain as payload/capability compatibility contracts for
now; this module deliberately does not expose their HTTP or WebSocket
protocols to the ingestion transport.
"""

from __future__ import annotations

import asyncio
import copy
import time
from dataclasses import dataclass
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.market_data.models import MarketChannel, TransportMode
from app.exchanges.models import ExchangeCapabilities, SymbolInfo
from app.exchanges.plugin import BuiltinExchangePlugin, DefaultSymbolNormalizer
from app.exchanges.realtime import RealtimePolicy, RealtimeUpdateMode

from .catalog import build_ccxt_capabilities, get_ccxt_catalog_entry
from .generic import (
    CcxtUnifiedAdapter,
    CcxtUnifiedPlugin,
    CcxtUnifiedProfile,
    CcxtUnifiedProtocol,
    _create_exchange,
    resolve_ccxt_symbol,
)
from .unified import CCXT_UNIFIED_MARKER, CcxtUnifiedNormalizer, make_unified_payload
from .runtime import close_ccxt_exchange


class OkxCombinedSummaryProfile:
    """Merge independent OKX mark/index/funding CCXT subscriptions safely."""

    exchange_id = "okx"
    market_type = "futures"

    def __init__(self, entry: Any) -> None:
        self._delegate = CcxtUnifiedProfile(entry, self.market_type)
        self._exchange: Any | None = None
        self._watch_lock = asyncio.Lock()
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._latest: dict[str, Any] = {}

    def supports(self, descriptor: StreamDescriptor) -> bool:
        return (
            descriptor.exchange.strip().lower() == self.exchange_id
            and descriptor.market_type.strip().lower() == self.market_type
            and descriptor.stream_type
            in {
                StreamType.MARK_PRICE,
                StreamType.INDEX_PRICE,
            }
        )

    def create_exchange(self, *args: Any, **kwargs: Any) -> Any:
        return self._delegate.create_exchange(*args, **kwargs)

    def resolve_symbol(self, exchange: Any, descriptor: StreamDescriptor) -> str:
        return self._delegate.resolve_symbol(exchange, descriptor)

    async def watch(
        self,
        exchange: Any,
        descriptor: StreamDescriptor,
        ccxt_symbol: str,
    ) -> dict[str, Any]:
        async with self._watch_lock:
            return await self._watch_locked(exchange, descriptor, ccxt_symbol)

    async def _watch_locked(
        self,
        exchange: Any,
        descriptor: StreamDescriptor,
        ccxt_symbol: str,
    ) -> dict[str, Any]:
        del descriptor
        if self._exchange is not exchange:
            await self.close()
            self._exchange = exchange
        index_symbol = _okx_index_symbol(exchange, ccxt_symbol)
        factories = {
            "mark": lambda: exchange.watch_mark_price(ccxt_symbol),
            "index": lambda: exchange.watch_ticker(
                index_symbol,
                params={"channel": "index-tickers"},
            ),
            "funding": lambda: exchange.watch_funding_rate(ccxt_symbol),
        }
        for key, factory in factories.items():
            if key not in self._tasks:
                self._tasks[key] = asyncio.create_task(factory())
        done, _pending = await asyncio.wait(
            tuple(self._tasks.values()),
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            key = next(
                (name for name, value in self._tasks.items() if value is task),
                None,
            )
            if key is None:
                raise asyncio.CancelledError
            self._tasks.pop(key, None)
            value = task.result()
            if isinstance(value, dict):
                self._latest[key] = dict(value)
        result: dict[str, Any] = {}
        mark = self._latest.get("mark")
        index = self._latest.get("index")
        funding = self._latest.get("funding")
        if isinstance(mark, dict):
            result["markPrice"] = mark.get("markPrice")
            result["timestamp"] = mark.get("timestamp")
        if isinstance(index, dict):
            result["indexPrice"] = index.get("indexPrice") or index.get("last")
            result["timestamp"] = max(
                int(result.get("timestamp") or 0),
                int(index.get("timestamp") or 0),
            )
        if isinstance(funding, dict):
            result["fundingRate"] = funding.get("fundingRate")
            result["nextFundingTimestamp"] = funding.get("nextFundingTimestamp")
            result["fundingTimestamp"] = funding.get("fundingTimestamp")
        result["info"] = {
            key: value.get("info")
            for key, value in self._latest.items()
            if isinstance(value, dict)
        }
        return result

    @staticmethod
    def matches(event: Any, descriptor: StreamDescriptor) -> bool:
        del event, descriptor
        return False

    def runtime_key(self, config: IngestionConfig) -> tuple[str, ...]:
        return self._delegate.runtime_key(config)

    def make_projector(self, descriptor: StreamDescriptor) -> Any:
        return self._delegate.make_projector(descriptor)

    async def close(self) -> None:
        tasks = tuple(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._latest.clear()
        self._exchange = None


class CcxtPrimaryAdapter(CcxtUnifiedAdapter):
    """CCXT catalog adapter that preserves CandleScope's native symbol IDs."""

    eager_catalog_refresh = True

    async def list_symbols(self, market_type: str = "") -> list[SymbolInfo]:
        symbols = await super().list_symbols(market_type)
        for symbol in symbols:
            native_id = str(symbol.raw.get("id") or "").strip()
            if native_id:
                symbol.symbol = native_id
            if symbol.market_type == "swap.linear" and market_type == "futures":
                symbol.market_type = "futures"
        return symbols


@dataclass(slots=True)
class _VenueContractBundle:
    capabilities_value: ExchangeCapabilities
    normalizer_factory: Any
    symbol_normalizer_value: Any
    rate_limit_factory: Any
    pagination_factory: Any
    realtime_policy_value: RealtimePolicy
    price_stream_type_value: StreamType

    def capabilities(self) -> ExchangeCapabilities:
        return self.capabilities_value

    def normalizer(self, config: Any, descriptor: Any) -> Any:
        return self.normalizer_factory(config, descriptor)

    def symbol_normalizer(self) -> Any:
        return self.symbol_normalizer_value

    def rate_limit_policy(self, config: Any = None) -> Any:
        return self.rate_limit_factory(config)

    def pagination_policy(self, config: Any = None) -> Any:
        return self.pagination_factory(config)

    def realtime_policy(self) -> RealtimePolicy:
        return self.realtime_policy_value

    def price_stream_type(self, market_type: str = "spot") -> StreamType:
        del market_type
        return self.price_stream_type_value


class CcxtPrimaryNormalizer:
    def __init__(
        self,
        descriptor: StreamDescriptor,
        native_normalizer: Any,
    ) -> None:
        self._unified = CcxtUnifiedNormalizer(descriptor)
        self._native = native_normalizer

    def parse(self, message: RawMessage) -> Any:
        payload = message.payload
        if isinstance(payload, dict) and payload.get("schema") == CCXT_UNIFIED_MARKER:
            return self._unified.parse(message)
        return self._native.parse(message)


class CcxtPrimaryPlugin(CcxtUnifiedPlugin):
    """CCXT provider plugin with venue-specific strict payload profiles."""

    venue: str

    def __init__(self, venue: str) -> None:
        self.venue = venue
        entry = get_ccxt_catalog_entry(venue)
        legacy = _legacy_contract_plugin(venue)
        capabilities = _merge_primary_capabilities(
            legacy.capabilities(),
            build_ccxt_capabilities(entry),
        )
        adapter = CcxtPrimaryAdapter(entry, capabilities)
        self.entry = entry
        BuiltinExchangePlugin.__init__(
            self,
            adapter,
            protocol=CcxtUnifiedProtocol(),
            normalizer_factory=lambda config, descriptor: CcxtPrimaryNormalizer(
                descriptor,
                legacy.normalizer(config, descriptor),
            ),
            symbol_normalizer=legacy.symbol_normalizer(),
            rate_limit_policy_factory=lambda config: legacy.rate_limit_policy(config),
            pagination_policy_factory=lambda config: legacy.pagination_policy(config),
            realtime_policy=legacy.realtime_policy(),
            price_stream_type_factory=lambda market_type: legacy.price_stream_type(
                market_type,
            ),
        )
        self._rest_book_revision = 0

    def _strict_profile(self, descriptor: StreamDescriptor) -> Any | None:
        if self.venue == "binance":
            from .profiles import BinanceSpotCcxtProfile, BinanceUsdmCcxtProfile

            candidates = (BinanceSpotCcxtProfile(), BinanceUsdmCcxtProfile())
        else:
            from .profiles import OkxSpotCcxtProfile, OkxSwapCcxtProfile

            candidates = (OkxSpotCcxtProfile(), OkxSwapCcxtProfile())
        return next(
            (profile for profile in candidates if profile.supports(descriptor)),
            None,
        )

    def _profile(self, descriptor: StreamDescriptor) -> Any | None:
        strict = self._strict_profile(descriptor)
        if strict is not None:
            return strict
        if (
            self.venue == "okx"
            and descriptor.market_type.strip().lower() == "futures"
            and descriptor.stream_type
            in {
                StreamType.MARK_PRICE,
                StreamType.INDEX_PRICE,
            }
        ):
            return OkxCombinedSummaryProfile(self.entry)
        try:
            generic = CcxtUnifiedProfile(self.entry, descriptor.market_type)
        except ValueError:
            return None
        return generic if generic.supports(descriptor) else None

    def supports_provider_stream(self, descriptor: StreamDescriptor) -> bool:
        return self._profile(descriptor) is not None

    @staticmethod
    def provider_stream_enabled(
        config: IngestionConfig,
        descriptor: StreamDescriptor,
    ) -> bool:
        del descriptor
        return bool(getattr(config, "ccxt_unified_stream_enabled", True))

    def create_stream_session(
        self,
        config: IngestionConfig,
        descriptor: StreamDescriptor,
    ) -> Any | None:
        if not self.provider_stream_enabled(config, descriptor):
            return None
        profile = self._profile(descriptor)
        if profile is None:
            return None
        from .session import CcxtProviderSession

        return CcxtProviderSession(
            config=config,
            descriptor=descriptor,
            profile=profile,
        )

    def provider_rate_limit_endpoint(self, req: TransportRequest) -> str | None:
        """Return quota metadata without exposing a native transport route."""

        descriptor = req.descriptor
        if self.venue == "okx":
            if descriptor.stream_type == StreamType.KLINE:
                return "/api/v5/market/history-candles"
            return None
        futures = descriptor.market_type.strip().lower() == "futures"
        if descriptor.stream_type == StreamType.KLINE:
            return "/fapi/v1/klines" if futures else "/api/v3/klines"
        if descriptor.stream_type == StreamType.AGG_TRADE:
            return "/fapi/v1/aggTrades" if futures else "/api/v3/aggTrades"
        if descriptor.stream_type == StreamType.FULL_DEPTH:
            return "/fapi/v1/depth" if futures else "/api/v3/depth"
        if not futures:
            return None
        return {
            StreamType.MARK_PRICE: "/fapi/v1/premiumIndex",
            StreamType.INDEX_PRICE: "/fapi/v1/premiumIndex",
            StreamType.PREMIUM_INDEX: "/fapi/v1/premiumIndexKlines",
            StreamType.FUNDING_RATE: "/fapi/v1/fundingRate",
            StreamType.OPEN_INTEREST: (
                "/futures/data/openInterestHist"
                if req.history or req.start_ms is not None or req.end_ms is not None
                else "/fapi/v1/openInterest"
            ),
        }.get(descriptor.stream_type)

    async def fetch_history_with_config(
        self,
        req: TransportRequest,
        config: IngestionConfig,
    ) -> list[RawMessage]:
        if self.venue == "binance" and req.descriptor.stream_type in {
            StreamType.KLINE,
            StreamType.AGG_TRADE,
            StreamType.FULL_DEPTH,
            StreamType.PREMIUM_INDEX,
            StreamType.FUNDING_RATE,
            StreamType.OPEN_INTEREST,
        }:
            return await self._fetch_binance_raw(req, config)
        if self.venue == "binance" and req.descriptor.stream_type in {
            StreamType.MARK_PRICE,
            StreamType.INDEX_PRICE,
        }:
            return await self._fetch_binance_summary(req, config)
        if self.venue == "okx" and req.descriptor.stream_type == StreamType.KLINE:
            return await self._fetch_okx_kline_raw(req, config)
        if self.venue == "okx" and req.descriptor.stream_type in {
            StreamType.MARK_PRICE,
            StreamType.INDEX_PRICE,
        }:
            return await self._fetch_okx_summary(req, config)
        return await super().fetch_history_with_config(req, config)

    async def _fetch_binance_raw(
        self,
        req: TransportRequest,
        config: IngestionConfig,
    ) -> list[RawMessage]:
        descriptor = req.descriptor
        selection = (
            "swap.linear"
            if descriptor.market_type == "futures"
            else descriptor.market_type
        )
        exchange = _create_exchange(
            self.entry,
            config,
            market_type=selection,
            websocket=False,
        )
        try:
            await exchange.load_markets()
            symbol = resolve_ccxt_symbol(
                exchange,
                descriptor,
                market_type=selection,
            )
            market_id = str(exchange.market(symbol)["id"])
            params: dict[str, Any] = {
                "symbol": market_id,
                "limit": max(1, int(req.limit or 1)),
            }
            futures = descriptor.market_type == "futures"
            if descriptor.stream_type == StreamType.KLINE:
                params["interval"] = descriptor.interval
                if req.start_ms is not None:
                    params["startTime"] = int(req.start_ms)
                if req.end_ms is not None:
                    params["endTime"] = int(req.end_ms)
                params["limit"] = min(params["limit"], 1500 if futures else 1000)
                method = (
                    exchange.fapipublic_get_klines
                    if futures
                    else exchange.public_get_klines
                )
                values = await method(params)
            elif descriptor.stream_type == StreamType.PREMIUM_INDEX:
                params["interval"] = descriptor.interval or "1m"
                params["limit"] = min(params["limit"], 1500)
                if req.start_ms is not None:
                    params["startTime"] = int(req.start_ms)
                if req.end_ms is not None:
                    params["endTime"] = int(req.end_ms)
                values = await exchange.fapipublic_get_premiumindexklines(params)
            elif descriptor.stream_type == StreamType.AGG_TRADE:
                params["limit"] = min(params["limit"], 1000)
                if req.from_id is not None:
                    params["fromId"] = int(req.from_id)
                else:
                    if req.start_ms is not None:
                        params["startTime"] = int(req.start_ms)
                    if req.end_ms is not None:
                        params["endTime"] = int(req.end_ms)
                method = (
                    exchange.fapipublic_get_aggtrades
                    if futures
                    else exchange.public_get_aggtrades
                )
                values = await method(params)
            elif descriptor.stream_type == StreamType.FUNDING_RATE:
                params["limit"] = min(params["limit"], 1000)
                if req.start_ms is not None:
                    params["startTime"] = int(req.start_ms)
                if req.end_ms is not None:
                    params["endTime"] = int(req.end_ms)
                values = await exchange.fapipublic_get_fundingrate(params)
            elif descriptor.stream_type == StreamType.OPEN_INTEREST:
                if req.history or req.start_ms is not None or req.end_ms is not None:
                    params["period"] = descriptor.interval or "5m"
                    params["limit"] = min(params["limit"], 500)
                    if req.start_ms is not None:
                        params["startTime"] = int(req.start_ms)
                    if req.end_ms is not None:
                        params["endTime"] = int(req.end_ms)
                    values = await exchange.fapidata_get_openinteresthist(params)
                else:
                    params.pop("limit", None)
                    values = [await exchange.fapipublic_get_openinterest(params)]
            else:
                params["limit"] = min(max(params["limit"], 100), 1000)
                method = (
                    exchange.fapipublic_get_depth
                    if futures
                    else exchange.public_get_depth
                )
                values = [await method(params)]
            return _raw_messages(
                descriptor,
                values,
                "ccxt+rest://binance",
                request_limit=params.get("limit"),
            )
        finally:
            await close_ccxt_exchange(exchange)

    async def _fetch_binance_summary(
        self,
        req: TransportRequest,
        config: IngestionConfig,
    ) -> list[RawMessage]:
        descriptor = req.descriptor
        exchange = _create_exchange(
            self.entry,
            config,
            market_type="swap.linear",
            websocket=False,
        )
        try:
            await exchange.load_markets()
            symbol = resolve_ccxt_symbol(
                exchange,
                descriptor,
                market_type="swap.linear",
            )
            mark, funding = await asyncio.gather(
                exchange.fetch_mark_price(symbol),
                exchange.fetch_funding_rate(symbol),
            )
            mark = mark if isinstance(mark, dict) else {}
            funding = funding if isinstance(funding, dict) else {}
            value = {
                "markPrice": mark.get("markPrice"),
                "indexPrice": mark.get("indexPrice"),
                "fundingRate": funding.get("fundingRate"),
                "nextFundingTimestamp": funding.get("nextFundingTimestamp"),
                "timestamp": max(
                    int(mark.get("timestamp") or 0),
                    int(funding.get("timestamp") or 0),
                ),
                "info": {
                    "mark": mark.get("info"),
                    "funding": funding.get("info"),
                },
            }
            return _raw_messages(
                descriptor,
                [make_unified_payload("derivatives_summary", value)],
                "ccxt+rest://binance",
            )
        finally:
            await close_ccxt_exchange(exchange)

    async def _fetch_okx_kline_raw(
        self,
        req: TransportRequest,
        config: IngestionConfig,
    ) -> list[RawMessage]:
        descriptor = req.descriptor
        selection = (
            "swap.linear"
            if descriptor.market_type == "futures"
            else descriptor.market_type
        )
        exchange = _create_exchange(
            self.entry,
            config,
            market_type=selection,
            websocket=False,
        )
        try:
            await exchange.load_markets()
            symbol = resolve_ccxt_symbol(
                exchange,
                descriptor,
                market_type=selection,
            )
            params: dict[str, Any] = {
                "instId": str(exchange.market(symbol)["id"]),
                "bar": _okx_interval(descriptor.interval or "1m"),
                "limit": min(max(1, int(req.limit or 1)), 300),
            }
            if req.end_ms is not None:
                params["after"] = str(max(0, int(req.end_ms) + 1))
            if req.start_ms is not None:
                params["before"] = str(max(0, int(req.start_ms) - 1))
            response = await exchange.public_get_market_history_candles(params)
            if not isinstance(response, dict) or str(response.get("code", "0")) not in {
                "",
                "0",
            }:
                raise RuntimeError(f"OKX CCXT REST error: {response!r}")
            values = response.get("data") if isinstance(response, dict) else None
            rows = list(reversed(values)) if isinstance(values, list) else []
            return _raw_messages(descriptor, rows, "ccxt+rest://okx")
        finally:
            await close_ccxt_exchange(exchange)

    async def _fetch_okx_summary(
        self,
        req: TransportRequest,
        config: IngestionConfig,
    ) -> list[RawMessage]:
        descriptor = req.descriptor
        exchange = _create_exchange(
            self.entry,
            config,
            market_type="swap.linear",
            websocket=False,
        )
        try:
            await exchange.load_markets()
            symbol = resolve_ccxt_symbol(
                exchange,
                descriptor,
                market_type="swap.linear",
            )
            index_symbol = _okx_index_symbol(exchange, symbol)
            index_id = str(exchange.market(index_symbol)["id"])
            mark, funding, index_response = await asyncio.gather(
                exchange.fetch_mark_price(symbol),
                exchange.fetch_funding_rate(symbol),
                exchange.public_get_market_index_tickers({"instId": index_id}),
            )
            index_rows = (
                index_response.get("data") if isinstance(index_response, dict) else None
            )
            index_row = (
                index_rows[0]
                if isinstance(index_rows, list)
                and index_rows
                and isinstance(index_rows[0], dict)
                else {}
            )
            value = {
                "markPrice": mark.get("markPrice") if isinstance(mark, dict) else None,
                "indexPrice": index_row.get("idxPx"),
                "fundingRate": (
                    funding.get("fundingRate") if isinstance(funding, dict) else None
                ),
                "nextFundingTimestamp": (
                    funding.get("nextFundingTimestamp")
                    if isinstance(funding, dict)
                    else None
                ),
                "timestamp": max(
                    int(mark.get("timestamp") or 0) if isinstance(mark, dict) else 0,
                    int(index_row.get("ts") or 0),
                ),
                "info": {
                    "mark": mark.get("info") if isinstance(mark, dict) else None,
                    "funding": funding.get("info")
                    if isinstance(funding, dict)
                    else None,
                    "index": index_row,
                },
            }
            return _raw_messages(
                descriptor,
                [make_unified_payload("derivatives_summary", value)],
                "ccxt+rest://okx",
            )
        finally:
            await close_ccxt_exchange(exchange)


def create_binance_ccxt_plugin() -> CcxtPrimaryPlugin:
    return CcxtPrimaryPlugin("binance")


def create_okx_ccxt_plugin() -> CcxtPrimaryPlugin:
    return CcxtPrimaryPlugin("okx")


def _legacy_contract_plugin(venue: str) -> _VenueContractBundle:
    if venue == "binance":
        from app.exchanges.plugins.binance.adapter import BinanceExchangeAdapter
        from app.exchanges.plugins.binance.normalizer import BinanceNormalizer
        from app.exchanges.plugins.binance.plugin import BinancePlugin
        from app.exchanges.plugins.binance.symbols import BinanceSymbolNormalizer

        adapter = object.__new__(BinanceExchangeAdapter)
        return _VenueContractBundle(
            capabilities_value=BinanceExchangeAdapter.capabilities(adapter),
            normalizer_factory=BinanceNormalizer,
            symbol_normalizer_value=BinanceSymbolNormalizer(),
            rate_limit_factory=BinancePlugin._rate_limit_policy,
            pagination_factory=BinancePlugin._pagination_policy,
            realtime_policy_value=RealtimePolicy(),
            price_stream_type_value=StreamType.MINI_TICKER,
        )
    from app.exchanges.plugins.okx.adapter import OkxExchangeAdapter
    from app.exchanges.plugins.okx.normalizer import OkxNormalizer
    from app.exchanges.plugins.okx.plugin import OkxPlugin

    adapter = object.__new__(OkxExchangeAdapter)
    return _VenueContractBundle(
        capabilities_value=OkxExchangeAdapter.capabilities(adapter),
        normalizer_factory=OkxNormalizer,
        symbol_normalizer_value=DefaultSymbolNormalizer(),
        rate_limit_factory=OkxPlugin._rate_limit_policy,
        pagination_factory=OkxPlugin._pagination_policy,
        realtime_policy_value=RealtimePolicy(
            update_mode=RealtimeUpdateMode.BASE_INTERVAL_FANOUT,
        ),
        price_stream_type_value=StreamType.TICKER,
    )


def _merge_primary_capabilities(
    legacy: ExchangeCapabilities,
    generic: ExchangeCapabilities,
) -> ExchangeCapabilities:
    merged = copy.deepcopy(legacy)
    if merged.exchange == "binance":
        # These channels now consume CCXT unified values.  Their former native
        # capability documents claimed exchange sequence IDs or venue-only
        # fields that CCXT intentionally does not promise.
        replaced_channels = {
            MarketChannel.TRADE,
            MarketChannel.TICKER,
            MarketChannel.DEPTH,
        }
        merged.channels = [
            channel
            for channel in merged.channels
            if channel.channel not in replaced_channels
        ]
    occupied = {
        (channel.channel, market_type)
        for channel in merged.channels
        for market_type in channel.market_types
    }
    for channel in copy.deepcopy(generic.channels):
        # Binance/OKX keep their stable public ``spot``/``futures`` product
        # identities.  CCXT's richer family names remain available on generic
        # exchange plugins, while the primary venues map linear swaps back to
        # the long-lived CandleScope futures contract.
        market_types: list[str] = []
        if "spot" in channel.market_types:
            market_types.append("spot")
        if "swap.linear" in channel.market_types:
            market_types.append("futures")
        channel.market_types = tuple(
            market_type
            for market_type in market_types
            if (channel.channel, market_type) not in occupied
        )
        if not channel.market_types:
            continue
        merged.channels.append(channel)
        occupied.update(
            (channel.channel, market_type) for market_type in channel.market_types
        )
    for channel in merged.channels:
        if TransportMode.WEBSOCKET in channel.realtime_transports:
            channel.realtime_transports = tuple(
                TransportMode.PLUGIN_STREAM
                if transport == TransportMode.WEBSOCKET
                else transport
                for transport in channel.realtime_transports
            )
        if channel.connection_model not in {None, "polling_only"}:
            channel.connection_model = "plugin_sidecar"
    merged.protocol_features = list(
        dict.fromkeys(
            [
                *merged.protocol_features,
                *generic.protocol_features,
                "provider.ccxt_primary",
                "native_transport.retired",
            ]
        )
    )
    merged.ws_connection_model = "plugin_sidecar"
    merged.known_limitations = list(
        dict.fromkeys(
            [
                *merged.known_limitations,
                "All physical public market-data I/O is owned by pinned CCXT",
                "Strict aggregate-trade and full-depth semantics use CCXT raw event hooks",
            ]
        )
    )
    return merged


def _raw_messages(
    descriptor: StreamDescriptor,
    values: Any,
    endpoint: str,
    *,
    request_limit: int | None = None,
) -> list[RawMessage]:
    rows = values if isinstance(values, list) else [values]
    received = int(time.time() * 1000)
    return [
        RawMessage(
            payload=value,
            source=DataSource.HTTP,
            stream_type=descriptor.stream_type,
            received_at_ms=received,
            endpoint=endpoint,
            http_status=200,
            request_limit=request_limit,
        )
        for value in rows
    ]


def _okx_interval(interval: str) -> str:
    return {
        "1h": "1H",
        "2h": "2H",
        "4h": "4H",
        "6h": "6Hutc",
        "12h": "12Hutc",
        "1d": "1Dutc",
        "3d": "3Dutc",
        "1w": "1Wutc",
        "1M": "1Mutc",
    }.get(interval, interval)


def _okx_index_symbol(exchange: Any, contract_symbol: str) -> str:
    market = exchange.market(contract_symbol)
    base = str(market.get("base") or "")
    quote = str(market.get("quote") or "")
    candidates = [
        item
        for item in exchange.markets.values()
        if bool(item.get("spot"))
        and str(item.get("base") or "") == base
        and str(item.get("quote") or "") == quote
    ]
    if len(candidates) != 1:
        raise ValueError(
            f"unable to resolve one OKX index symbol for {contract_symbol}",
        )
    return str(candidates[0]["symbol"])
