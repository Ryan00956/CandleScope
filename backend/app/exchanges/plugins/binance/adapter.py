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
from app.exchanges.models import ExchangeCapabilities, ExchangeMarket, SymbolInfo

from .protocol import BinanceExchangeProtocol

logger = logging.getLogger("candlescope.exchange.binance")


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
            markets=[
                ExchangeMarket(
                    market_type="spot",
                    product_type="spot",
                    label="Spot",
                ),
                ExchangeMarket(
                    market_type="futures",
                    product_type="perpetual",
                    label="USDT-M Perpetual",
                    contract_family="usdt-m",
                ),
            ],
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
            symbols.append(
                SymbolInfo(
                    symbol=item["symbol"],
                    base_asset=item["baseAsset"],
                    quote_asset=item["quoteAsset"],
                    status=item["status"],
                    exchange=self.id,
                    market_type="futures",
                    product_type="perpetual",
                    contract_type=item.get("contractType", ""),
                    raw=item,
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
