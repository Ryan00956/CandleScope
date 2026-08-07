"""Generic CCXT exchange plugins backed by unified REST and Pro methods."""

from __future__ import annotations

import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

import ccxt
import ccxt.async_support as ccxt_async
import ccxt.pro as ccxtpro

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.exchanges.models import ExchangeCapabilities, SymbolInfo
from app.exchanges.pagination import ReverseTimePaginationPolicy
from app.exchanges.plugin import BuiltinExchangePlugin
from app.exchanges.rate_limits import RateLimitPolicy

from .catalog import (
    CcxtCatalogEntry,
    assert_supported_ccxt_version,
    build_ccxt_capabilities,
    get_ccxt_catalog,
    market_matches_selection,
    market_selection_parts,
)
from .unified import (
    CcxtUnifiedNormalizer,
    CcxtUnifiedProjector,
    make_unified_payload,
)
from .runtime import close_ccxt_exchange


_GENERIC_STREAM_METHODS = {
    StreamType.KLINE: ("watchOHLCV", "fetchOHLCV"),
    StreamType.TRADE: ("watchTrades", "fetchTrades"),
    StreamType.DEPTH: ("watchOrderBook", "fetchOrderBook"),
    StreamType.TICKER: ("watchTicker", "fetchTicker"),
}


class CcxtUnifiedProtocol:
    """Protocol sentinel: physical I/O is owned by CCXT provider methods."""

    @staticmethod
    def supports_ws(_descriptor: StreamDescriptor) -> bool:
        return False

    @staticmethod
    def rest_base_urls(
        _market_type: str = "spot",
        config: Any | None = None,
    ) -> list[str]:
        del config
        return []

    @staticmethod
    def rest_request(
        _request: TransportRequest,
        config: Any | None = None,
    ) -> None:
        del config
        return None

    @staticmethod
    def ws_base_urls(
        _descriptor: StreamDescriptor,
        config: Any | None = None,
    ) -> list[str]:
        del config
        return []


class CcxtSymbolNormalizer:
    """Preserve CCXT unified symbols, including case-sensitive venue IDs."""

    @staticmethod
    def normalize(symbol: str, market_type: str = "spot") -> str:
        del market_type
        return str(symbol or "").strip()

    @staticmethod
    def display(symbol: str, market_type: str = "spot") -> str:
        del market_type
        return str(symbol or "").strip()


class CcxtHistoricalPaginationPolicy(ReverseTimePaginationPolicy):
    """Forward ``since`` pagination matching CCXT's unified OHLCV contract."""

    def first_request(
        self,
        task: Any,
        *,
        batch_size: int,
        now_ms: int,
    ) -> TransportRequest:
        end_ms = int(task.end_ms) if task.end_ms is not None else now_ms
        start_ms = int(task.start_ms) if task.start_ms is not None else None
        if start_ms is None:
            try:
                width = int(ccxt.Exchange.parse_timeframe(task.interval) * 1000)
            except Exception:
                width = 60_000
            start_ms = max(0, end_ms - max(1, batch_size) * width)
        return TransportRequest(
            descriptor=self._descriptor(task),
            limit=batch_size,
            start_ms=start_ms,
            end_ms=end_ms,
        )

    def next_request(
        self,
        task: Any,
        previous_request: TransportRequest,
        bars: list[Any],
        *,
        batch_size: int,
    ) -> TransportRequest | None:
        if not bars:
            return None
        newest = max(int(bar.open_time) for bar in bars)
        end_ms = previous_request.end_ms
        if end_ms is not None and newest >= end_ms:
            return None
        next_start = newest + 1
        if previous_request.start_ms is not None and next_start <= previous_request.start_ms:
            return None
        return TransportRequest(
            descriptor=previous_request.descriptor,
            limit=batch_size,
            start_ms=next_start,
            end_ms=end_ms,
        )


class CcxtUnifiedAdapter:
    """Lazy symbol-catalog adapter for one pinned CCXT exchange ID."""

    eager_catalog_refresh = False

    def __init__(
        self,
        entry: CcxtCatalogEntry,
        capabilities: ExchangeCapabilities,
    ) -> None:
        self.entry = entry
        self.id = entry.exchange_id
        self.name = entry.name
        self._capabilities = capabilities

    def capabilities(self) -> ExchangeCapabilities:
        return self._capabilities

    async def list_symbols(self, market_type: str = "") -> list[SymbolInfo]:
        config = IngestionConfig()
        selection = str(market_type or "").strip().lower()
        if not self.entry.market_types:
            return []
        if selection and selection not in self.entry.market_types:
            raise ValueError(
                f"{self.id} does not advertise CCXT market type {selection!r}",
            )
        exchange = _create_exchange(
            self.entry,
            config,
            market_type=selection or self.entry.market_types[0],
            websocket=False,
        )
        try:
            await exchange.load_markets()
            selections = (selection,) if selection else self.entry.market_types
            symbols: list[SymbolInfo] = []
            for market in exchange.markets.values():
                if market.get("active") is False:
                    continue
                selected = next(
                    (
                        candidate
                        for candidate in selections
                        if market_matches_selection(market, candidate)
                    ),
                    None,
                )
                if selected is None:
                    continue
                symbol = str(market.get("symbol") or "").strip()
                base = str(market.get("base") or "").strip()
                quote = str(market.get("quote") or "").strip()
                if not symbol or not base or not quote:
                    continue
                symbols.append(
                    SymbolInfo(
                        symbol=symbol,
                        base_asset=base,
                        quote_asset=quote,
                        status="TRADING",
                        exchange=self.id,
                        market_type=selected,
                        product_type=_product_type(selected),
                        contract_type=_contract_type(selected),
                        raw=dict(market),
                        listed_at_ms=_timestamp(market.get("created")),
                        expiry_at_ms=_timestamp(market.get("expiry")),
                        price_tick_size=_price_tick_size(exchange, market),
                    )
                )
            return sorted(symbols, key=lambda item: item.symbol)
        finally:
            await close_ccxt_exchange(exchange)

    @staticmethod
    def get_http_base_urls(
        market_type: str = "spot",
        config: Any | None = None,
    ) -> list[str]:
        del market_type, config
        return []

    @staticmethod
    def get_ws_base_urls(
        market_type: str = "spot",
        config: Any | None = None,
    ) -> list[str]:
        del market_type, config
        return []

    @staticmethod
    def get_rest_path(
        stream_type: StreamType,
        market_type: str = "spot",
    ) -> None:
        del stream_type, market_type
        return None

    @staticmethod
    def build_http_params(req: TransportRequest) -> dict[str, Any]:
        del req
        return {}

    @staticmethod
    def build_ws_stream_name(descriptor: StreamDescriptor) -> str:
        return descriptor.key

    @staticmethod
    def build_ws_subscription(descriptor: StreamDescriptor) -> Any:
        del descriptor
        raise RuntimeError("CCXT unified plugins do not expose direct WS subscriptions")

    @staticmethod
    def get_multi_symbol_ticker_stream_name(
        market_type: str = "spot",
    ) -> None:
        del market_type
        return None

    @staticmethod
    def supports_ws_streaming(market_type: str = "spot") -> bool:
        del market_type
        return False

    @staticmethod
    def extract_http_rows(payload: Any, stream_type: StreamType) -> list[Any]:
        del stream_type
        return list(payload) if isinstance(payload, list) else [payload]


@dataclass(slots=True)
class CcxtUnifiedProfile:
    """Parameterized CCXT Pro profile using unified ``watch_*`` results."""

    entry: CcxtCatalogEntry
    market_type: str

    def __post_init__(self) -> None:
        self.market_type = str(self.market_type or "").strip().lower()
        if not self.entry.pro:
            raise ValueError(f"{self.entry.exchange_id} has no CCXT Pro class")
        if self.market_type not in self.entry.market_types:
            raise ValueError(
                f"{self.entry.exchange_id} does not advertise {self.market_type}",
            )

    @property
    def exchange_id(self) -> str:
        return self.entry.exchange_id

    def supports(self, descriptor: StreamDescriptor) -> bool:
        if (
            descriptor.exchange.strip().lower() != self.exchange_id
            or descriptor.market_type.strip().lower() != self.market_type
        ):
            return False
        methods = _GENERIC_STREAM_METHODS.get(descriptor.stream_type)
        if methods is None or not self.entry.supports(methods[0]):
            return False
        if (
            descriptor.stream_type == StreamType.KLINE
            and self.entry.timeframes
            and descriptor.interval not in self.entry.timeframes
        ):
            return False
        if descriptor.stream_type == StreamType.DEPTH:
            return descriptor.depth_levels in {5, 10, 20}
        return True

    def create_exchange(
        self,
        config: IngestionConfig,
        *,
        raw_event_sink: Any,
        lifecycle_sink: Any,
    ) -> Any:
        del raw_event_sink, lifecycle_sink
        return _create_exchange(
            self.entry,
            config,
            market_type=self.market_type,
            websocket=True,
        )

    def resolve_symbol(self, exchange: Any, descriptor: StreamDescriptor) -> str:
        return resolve_ccxt_symbol(exchange, descriptor)

    async def watch(
        self,
        exchange: Any,
        descriptor: StreamDescriptor,
        ccxt_symbol: str,
    ) -> Any:
        if descriptor.stream_type == StreamType.KLINE:
            return await exchange.watch_ohlcv(ccxt_symbol, descriptor.interval)
        if descriptor.stream_type == StreamType.TRADE:
            return await exchange.watch_trades(ccxt_symbol)
        if descriptor.stream_type == StreamType.DEPTH:
            # Venue depth ladders differ (for example Bybit starts at 50 and
            # Kraken at 10).  Let CCXT choose a valid upstream default, then
            # the projector enforces CandleScope's logical 5/10/20 bound.
            return await exchange.watch_order_book(ccxt_symbol)
        if descriptor.stream_type == StreamType.TICKER:
            return await exchange.watch_ticker(ccxt_symbol)
        raise ValueError(f"Unsupported CCXT unified stream: {descriptor.stream_type.value}")

    @staticmethod
    def matches(event: Any, descriptor: StreamDescriptor) -> bool:
        del event, descriptor
        # Unified profiles project the return value of their own watch call;
        # they never demultiplex raw exchange envelopes.
        return False

    def runtime_key(self, config: IngestionConfig) -> tuple[str, ...]:
        return (
            "ccxt-unified",
            self.exchange_id,
            self.market_type,
            config.proxy_mode,
            config.http_proxy or "",
        )

    def make_projector(
        self,
        descriptor: StreamDescriptor,
    ) -> CcxtUnifiedProjector:
        return CcxtUnifiedProjector(
            exchange_id=self.exchange_id,
            market_type=self.market_type,
            descriptor=descriptor,
        )


class CcxtUnifiedPlugin(BuiltinExchangePlugin):
    """One registry plugin generated from a pinned CCXT exchange class."""

    def __init__(self, entry: CcxtCatalogEntry) -> None:
        self.entry = entry
        capabilities = build_ccxt_capabilities(entry)
        adapter = CcxtUnifiedAdapter(entry, capabilities)
        delay = max(0.001, entry.rate_limit_ms / 1000.0)
        super().__init__(
            adapter,
            protocol=CcxtUnifiedProtocol(),
            normalizer_factory=lambda _config, descriptor: CcxtUnifiedNormalizer(
                descriptor,
            ),
            symbol_normalizer=CcxtSymbolNormalizer(),
            rate_limit_policy_factory=lambda _config: RateLimitPolicy(
                default_concurrency=1,
                default_delay_seconds=delay,
                default_retry_429_backoff_seconds=max(5.0, delay * 10),
            ),
            pagination_policy_factory=lambda _config: CcxtHistoricalPaginationPolicy(),
            price_stream_type_factory=lambda _market_type: StreamType.TICKER,
        )
        self._rest_book_revision = 0

    def supports_provider_stream(self, descriptor: StreamDescriptor) -> bool:
        if not self.entry.pro:
            return False
        try:
            profile = CcxtUnifiedProfile(self.entry, descriptor.market_type)
        except ValueError:
            return False
        return profile.supports(descriptor)

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
        try:
            profile = CcxtUnifiedProfile(self.entry, descriptor.market_type)
        except ValueError:
            return None
        if not profile.supports(descriptor):
            return None
        from .session import CcxtProviderSession

        return CcxtProviderSession(
            config=config,
            descriptor=descriptor,
            profile=profile,
        )

    async def fetch_history(self, req: TransportRequest) -> list[RawMessage]:
        return await self.fetch_history_with_config(req, IngestionConfig())

    async def fetch_history_with_config(
        self,
        req: TransportRequest,
        config: IngestionConfig,
    ) -> list[RawMessage]:
        descriptor = req.descriptor
        methods = _GENERIC_STREAM_METHODS.get(descriptor.stream_type)
        if methods is None or not self.entry.supports(methods[1]):
            raise ValueError(
                f"{self.id} does not support CCXT REST {descriptor.stream_type.value}",
            )
        if descriptor.market_type not in self.entry.market_types:
            raise ValueError(
                f"{self.id} does not advertise {descriptor.market_type}",
            )
        exchange = _create_exchange(
            self.entry,
            config,
            market_type=descriptor.market_type,
            websocket=False,
        )
        try:
            await exchange.load_markets()
            symbol = resolve_ccxt_symbol(exchange, descriptor)
            rows: list[dict[str, Any]] = []
            if descriptor.stream_type == StreamType.KLINE:
                limit = min(max(1, int(req.limit or 1)), self.entry.history_limit)
                values = await exchange.fetch_ohlcv(
                    symbol,
                    timeframe=descriptor.interval,
                    since=req.start_ms,
                    limit=limit,
                )
                interval_ms = int(ccxt.Exchange.parse_timeframe(descriptor.interval) * 1000)
                now_ms = int(time.time() * 1000)
                rows = [
                    make_unified_payload(
                        "kline",
                        list(row[:6]),
                        is_closed=int(row[0]) + interval_ms <= now_ms,
                    )
                    for row in values
                    if isinstance(row, (list, tuple))
                    and len(row) >= 6
                    and (req.end_ms is None or int(row[0]) <= req.end_ms)
                ]
            elif descriptor.stream_type == StreamType.TRADE:
                values = await exchange.fetch_trades(
                    symbol,
                    since=req.start_ms,
                    limit=max(1, int(req.limit or 1)),
                )
                rows = [
                    make_unified_payload("trade", dict(value))
                    for value in values
                    if isinstance(value, dict)
                    and (
                        req.end_ms is None
                        or _timestamp(value.get("timestamp")) is None
                        or int(value["timestamp"]) <= req.end_ms
                    )
                ]
            elif descriptor.stream_type == StreamType.DEPTH:
                value = await exchange.fetch_order_book(
                    symbol,
                )
                self._rest_book_revision += 1
                rows = [
                    make_unified_payload(
                        "order_book",
                        dict(value),
                        local_revision=self._rest_book_revision,
                    )
                ]
            elif descriptor.stream_type == StreamType.TICKER:
                value = await exchange.fetch_ticker(symbol)
                rows = [make_unified_payload("ticker", dict(value))]
            received = int(time.time() * 1000)
            return [
                RawMessage(
                    payload=row,
                    source=DataSource.HTTP,
                    stream_type=descriptor.stream_type,
                    received_at_ms=received,
                    endpoint=f"ccxt+rest://{self.id}",
                    http_status=200,
                    request_limit=req.limit,
                )
                for row in rows
            ]
        finally:
            await close_ccxt_exchange(exchange)


def register_ccxt_plugins(registry: Any) -> int:
    """Register every pinned CCXT ID not owned by a stricter plugin."""

    registered = 0
    for entry in get_ccxt_catalog():
        if registry.has(entry.exchange_id):
            continue
        registry.register(
            CcxtUnifiedPlugin(entry),
            source=f"builtin:ccxt:{entry.exchange_id}",
        )
        registered += 1
    return registered


def resolve_ccxt_symbol(exchange: Any, descriptor: StreamDescriptor) -> str:
    requested = str(descriptor.symbol or "").strip()
    candidates = [
        market
        for market in exchange.markets.values()
        if market_matches_selection(market, descriptor.market_type)
        and (
            str(market.get("symbol") or "") == requested
            or str(market.get("symbol") or "").upper() == requested.upper()
            or str(market.get("id") or "").upper() == requested.upper()
        )
    ]
    by_symbol = {
        str(market.get("symbol")): market
        for market in candidates
        if str(market.get("symbol") or "").strip()
    }
    if len(by_symbol) != 1:
        raise ValueError(
            f"unable to resolve one {descriptor.market_type} CCXT symbol for "
            f"{descriptor.exchange}:{requested}",
        )
    return next(iter(by_symbol))


def _create_exchange(
    entry: CcxtCatalogEntry,
    config: IngestionConfig,
    *,
    market_type: str,
    websocket: bool,
) -> Any:
    assert_supported_ccxt_version()
    module = ccxtpro if websocket else ccxt_async
    if websocket and not entry.pro:
        raise ValueError(f"{entry.exchange_id} has no CCXT Pro implementation")
    exchange_class = getattr(module, entry.exchange_id)
    base_type, subtype = market_selection_parts(market_type)
    options: dict[str, Any] = {"defaultType": base_type}
    if subtype is not None:
        options["defaultSubType"] = subtype
    values: dict[str, Any] = {
        "enableRateLimit": True,
        "newUpdates": True,
        "aiohttp_trust_env": config.proxy_mode == "system",
        "options": options,
    }
    if config.http_proxy and config.proxy_mode != "none":
        values["httpsProxy"] = config.http_proxy
        values["wssProxy"] = config.http_proxy
    return exchange_class(values)


def _product_type(market_type: str) -> str:
    base, _subtype = market_selection_parts(market_type)
    return {
        "spot": "spot",
        "swap": "perpetual",
        "future": "delivery_future",
        "option": "option",
    }[base]


def _contract_type(market_type: str) -> str:
    base, subtype = market_selection_parts(market_type)
    if base not in {"swap", "future"}:
        return ""
    return (subtype or "exchange_default").upper()


def _timestamp(value: Any) -> int | None:
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _price_tick_size(exchange: Any, market: dict[str, Any]) -> str:
    precision = (market.get("precision") or {}).get("price")
    if isinstance(precision, bool) or precision is None:
        return ""
    try:
        if exchange.precisionMode == ccxt.TICK_SIZE:
            tick = Decimal(str(precision))
        else:
            tick = Decimal(1).scaleb(-int(precision))
    except (InvalidOperation, TypeError, ValueError, OverflowError):
        return ""
    if not tick.is_finite() or tick <= 0:
        return ""
    return format(tick, "f")
