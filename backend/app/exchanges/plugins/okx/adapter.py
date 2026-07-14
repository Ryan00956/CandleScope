from __future__ import annotations

import logging
from typing import Any

import aiohttp

from app.core.config import REQUEST_TIMEOUT, get_effective_proxy
from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.exchanges.models import (
    ExchangeCapabilities,
    ExchangeMarket,
    MarketChannelCapability,
    SymbolInfo,
)

from .protocol import OKX_REST_BASE_URLS, OkxExchangeProtocol

logger = logging.getLogger("candlescope.exchange.okx")

_OKX_NATIVE_INTERVALS = [
    "1s",
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "6h",
    "12h",
    "1d",
    "3d",
    "1w",
    "1M",
]
_MARKET_TYPES = ("spot", "futures")
_REALTIME_TRANSPORTS = (TransportMode.WEBSOCKET, TransportMode.REST_POLL)
_TICKER_FIELDS = (
    "last_price",
    "open_price",
    "high_price",
    "low_price",
    "price_change_pct",
    "volume",
    "quote_volume",
)


def _channel_capabilities() -> list[MarketChannelCapability]:
    return [
        MarketChannelCapability(
            channel=MarketChannel.KLINE,
            market_types=_MARKET_TYPES,
            realtime=True,
            history=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            history_transports=(TransportMode.REST_HISTORY,),
            delivery=DeliveryClass.APPEND,
            snapshot=True,
            sequence="timestamp",
            resync="replace_snapshot",
            params={"interval": list(_OKX_NATIVE_INTERVALS)},
            update_intervals_ms=(1000,),
            available_fields=(
                "interval",
                "open_time",
                "close_time",
                "open",
                "high",
                "low",
                "close",
                "volume",
                "quote_volume",
                "is_closed",
            ),
            unavailable_fields=(
                "trades",
                "taker_buy_base",
                "taker_buy_quote",
            ),
            connection_model="shared_multiplex",
            limits={
                "rest.max_limit": 300,
                "websocket.multiplex_scope": "symbol_intervals",
            },
            known_limitations=(
                "Trade count and taker-buy fields are unavailable; normalized zero placeholders are not data",
                "Current shared WebSocket hubs multiplex intervals only; each symbol has its own connection",
            ),
        ),
        MarketChannelCapability(
            channel=MarketChannel.TICKER,
            market_types=("spot",),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            update_intervals_ms=(100,),
            available_fields=_TICKER_FIELDS,
            connection_model="message_per_stream",
            known_limitations=(
                "Ticker streams use individual message-subscription sessions in the current runtime",
            ),
        ),
        MarketChannelCapability(
            channel=MarketChannel.TICKER,
            market_types=("futures",),
            realtime=True,
            realtime_transports=_REALTIME_TRANSPORTS,
            delivery=DeliveryClass.LATEST,
            snapshot=True,
            update_intervals_ms=(100,),
            available_fields=tuple(
                field for field in _TICKER_FIELDS if field != "quote_volume"
            ),
            unavailable_fields=("quote_volume",),
            connection_model="message_per_stream",
            known_limitations=(
                "Ticker streams use individual message-subscription sessions in the current runtime",
                "For derivatives, volCcy24h is base-currency volume; normalized quote_volume is not data",
                "For derivatives, normalized volume is contract count rather than base-asset volume",
            ),
        ),
    ]


class OkxExchangeAdapter:
    """Legacy facade for OKX exchange integration.

    New runtime code should use ``OkxPlugin.protocol()`` and other plugin
    policies. This adapter remains for compatibility with older imports and
    symbol metadata callers.
    """

    id = "okx"
    name = "OKX"

    def __init__(self) -> None:
        self._protocol = OkxExchangeProtocol()

    def capabilities(self) -> ExchangeCapabilities:
        return ExchangeCapabilities(
            exchange=self.id,
            name=self.name,
            capability_schema_version=2,
            markets=[
                ExchangeMarket(
                    market_type="spot",
                    product_type="spot",
                    label="Spot",
                ),
                ExchangeMarket(
                    market_type="futures",
                    product_type="perpetual",
                    label="Swap Perpetual",
                ),
            ],
            channels=_channel_capabilities(),
            native_intervals=list(_OKX_NATIVE_INTERVALS),
            supports_multi_symbol_ticker=False,
            supports_symbol_search=True,
            ws_connection_model="shared_multiplex",
            protocol_features=[
                "rest.kline",
                "rest.ticker",
                "ws.message_subscribe",
                "ws.shared_multiplex",
                "pagination.okx_history",
            ],
            limits={
                "rest.kline.max_limit": 300,
            },
            known_limitations=[
                "aggTrade, trade, and depth are not exposed by the current OKX plugin",
            ],
        )

    async def list_symbols(self, market_type: str = "") -> list[SymbolInfo]:
        normalized = (market_type or "").strip().lower()
        if not normalized:
            spot = await self._load_symbols("SPOT", "spot", "spot")
            swaps = await self._load_symbols("SWAP", "futures", "perpetual")
            return spot + swaps
        if normalized == "spot":
            return await self._load_symbols("SPOT", "spot", "spot")
        if normalized == "futures":
            return await self._load_symbols("SWAP", "futures", "perpetual")
        return []

    def get_http_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        return self._protocol.rest_base_urls(market_type, config=config)

    def get_ws_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        from app.data_engine.ingestion.models import StreamDescriptor, StreamType

        descriptor = StreamDescriptor(
            symbol="BTC-USDT",
            stream_type=StreamType.KLINE,
            interval="1m",
            exchange=self.id,
            market_type=market_type,
        )
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

    def get_ticker_ws_urls(self, market_type: str = "spot") -> list[str]:
        return self._protocol.get_ticker_ws_urls(market_type)

    def build_ticker_subscribe(self, symbols: list[str]) -> dict:
        return self._protocol.build_ticker_subscribe(symbols)

    def build_ticker_unsubscribe(self, symbols: list[str]) -> dict:
        return self._protocol.build_ticker_unsubscribe(symbols)

    def supports_ws_streaming(self, market_type: str = "spot") -> bool:
        return True

    def extract_http_rows(self, payload: Any, stream_type) -> list[Any]:
        return self._protocol.extract_http_rows(payload, stream_type)

    async def _load_symbols(
        self,
        inst_type: str,
        market_type: str,
        product_type: str,
    ) -> list[SymbolInfo]:
        data = await self._fetch_public_data(
            "/api/v5/public/instruments",
            {"instType": inst_type},
        )
        symbols: list[SymbolInfo] = []
        for item in data:
            if item.get("state") != "live":
                continue
            inst_id = str(item.get("instId", "")).upper()
            if not inst_id:
                continue
            base_asset = str(item.get("baseCcy") or inst_id.split("-")[0]).upper()
            quote_asset = str(
                item.get("quoteCcy")
                or item.get("settleCcy")
                or (inst_id.split("-")[1] if "-" in inst_id else "")
            ).upper()
            symbols.append(
                SymbolInfo(
                    symbol=inst_id,
                    base_asset=base_asset,
                    quote_asset=quote_asset,
                    status=str(item.get("state", "live")),
                    exchange=self.id,
                    market_type=market_type,
                    product_type=product_type,
                    contract_type=str(item.get("ctType", "")),
                    raw=item,
                ),
            )
        return symbols

    async def _fetch_public_data(
        self,
        path: str,
        params: dict[str, Any],
    ) -> list[dict[str, Any]]:
        proxy = get_effective_proxy()
        last_err: Exception | None = None
        for base in OKX_REST_BASE_URLS:
            url = f"{base}{path}"
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        url,
                        params=params,
                        timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
                        proxy=proxy,
                    ) as resp:
                        if resp.status != 200:
                            logger.warning("OKX public data %s returned HTTP %s", base, resp.status)
                            continue
                        payload = await resp.json()
                        if str(payload.get("code", "0")) not in ("0", ""):
                            logger.warning("OKX public data error from %s: %s", base, payload.get("msg"))
                            continue
                        data = payload.get("data")
                        if isinstance(data, list):
                            return data
            except Exception as exc:
                last_err = exc
                logger.warning("OKX public data fetch failed from %s: %s", base, exc)

        raise RuntimeError(
            f"Failed to load OKX public data from all endpoints: {last_err}"
        )
