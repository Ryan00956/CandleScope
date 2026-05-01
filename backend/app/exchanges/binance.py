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
from .models import ExchangeCapabilities, ExchangeMarket, SymbolInfo
from .symbols import normalize_symbol
from .ws_protocol import WsSubscriptionMode, WsSubscriptionSpec

logger = logging.getLogger("candlescope.exchange.binance")


_REST_PATH: dict[str, dict[str, str]] = {
    "spot": {
        "kline": "/api/v3/klines",
        "aggTrade": "/api/v3/aggTrades",
        "trade": "/api/v3/trades",
        "ticker": "/api/v3/ticker/24hr",
        "miniTicker": "/api/v3/ticker/24hr",
        "depth": "/api/v3/depth",
    },
    "futures": {
        "kline": "/fapi/v1/klines",
        "aggTrade": "/fapi/v1/aggTrades",
        "trade": "/fapi/v1/trades",
        "ticker": "/fapi/v1/ticker/24hr",
        "miniTicker": "/fapi/v1/ticker/24hr",
        "depth": "/fapi/v1/depth",
    },
}

_FUTURES_MARKET_STREAMS = {
    "aggTrade",
    "kline",
    "miniTicker",
    "ticker",
}

_FUTURES_PUBLIC_STREAMS = {
    "depth",
    "trade",
}


class BinanceExchangeAdapter:
    """Exchange adapter for Binance spot + USDT-M perpetual."""

    id = "binance"
    name = "Binance"

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
        if config is not None and hasattr(config, "get_http_urls"):
            return list(config.get_http_urls(market_type))
        if market_type == "futures":
            return [BINANCE_FUTURES_BASE_URL] + [
                url for url in BINANCE_FUTURES_BASE_URLS if url != BINANCE_FUTURES_BASE_URL
            ]
        return [BINANCE_BASE_URL] + [
            url for url in BINANCE_BASE_URLS if url != BINANCE_BASE_URL
        ]

    def get_ws_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        if config is not None and hasattr(config, "get_ws_urls"):
            return list(config.get_ws_urls(market_type))
        if market_type == "futures":
            return [
                "wss://fstream.binance.com/ws",
                "wss://fstream.binance.me/ws",
            ]
        return [
            "wss://stream.binance.com:9443/ws",
            "wss://data-stream.binance.vision/ws",
            "wss://stream.binance.me:9443/ws",
        ]

    def get_ws_base_urls_for_descriptor(
        self,
        descriptor,
        market_type: str = "spot",
        config: Any | None = None,
    ) -> list[str]:
        urls = self.get_ws_base_urls(market_type, config=config)
        if market_type != "futures":
            return urls

        stream_type = getattr(descriptor.stream_type, "value", str(descriptor.stream_type))
        if stream_type in _FUTURES_MARKET_STREAMS:
            return self._route_futures_ws_urls(urls, "market")
        if stream_type in _FUTURES_PUBLIC_STREAMS:
            return self._route_futures_ws_urls(urls, "public")
        return urls

    def get_rest_path(self, stream_type, market_type: str = "spot") -> str | None:
        return _REST_PATH.get(market_type, _REST_PATH["spot"]).get(stream_type.value)

    def build_http_params(self, req) -> dict[str, Any]:
        desc = req.descriptor
        params: dict[str, Any] = {
            "symbol": normalize_symbol(
                desc.symbol,
                exchange=self.id,
                market_type=desc.market_type,
            ),
        }

        if desc.stream_type.value == "kline":
            params["interval"] = desc.interval
            params["limit"] = req.limit
            if req.start_ms is not None:
                params["startTime"] = str(max(0, int(req.start_ms)))
            if req.end_ms is not None:
                params["endTime"] = str(max(0, int(req.end_ms)))
        elif desc.stream_type.value in ("aggTrade", "trade"):
            params["limit"] = req.limit
            if req.start_ms is not None:
                params["startTime"] = str(max(0, int(req.start_ms)))
            if req.end_ms is not None:
                params["endTime"] = str(max(0, int(req.end_ms)))
        elif desc.stream_type.value == "depth":
            params["limit"] = min(req.limit, 5000)

        return params

    def build_ws_stream_name(self, descriptor) -> str:
        symbol = normalize_symbol(
            descriptor.symbol,
            exchange=self.id,
            market_type=descriptor.market_type,
        ).lower()
        if descriptor.stream_type.value == "kline":
            return f"{symbol}@kline_{descriptor.interval}"
        if descriptor.stream_type.value == "depth" and descriptor.depth_levels:
            return f"{symbol}@depth{descriptor.depth_levels}"
        return f"{symbol}@{descriptor.stream_type.value}"

    def build_ws_subscription(self, descriptor) -> WsSubscriptionSpec:
        return WsSubscriptionSpec(
            mode=WsSubscriptionMode.PATH,
            stream_name=self.build_ws_stream_name(descriptor),
        )

    def get_multi_symbol_ticker_stream_name(self, market_type: str = "spot") -> str | None:
        return "!miniTicker@arr"

    def supports_ws_streaming(self, market_type: str = "spot") -> bool:
        return True

    @staticmethod
    def _route_futures_ws_urls(urls: list[str], route: str) -> list[str]:
        routed: list[str] = []
        for url in urls:
            base = url.rstrip("/")
            if f"/{route}/ws" in base:
                routed.append(base)
                continue
            if base.endswith("/ws"):
                base = base[:-3]
            elif base.endswith("/stream"):
                base = base[:-7]
            for legacy_route in ("/public", "/market", "/private"):
                if base.endswith(legacy_route):
                    base = base[: -len(legacy_route)]
                    break
            routed.append(f"{base}/{route}/ws")
        return list(dict.fromkeys(routed))

    def extract_http_rows(self, payload: Any, stream_type) -> list[Any]:
        if isinstance(payload, list):
            return payload
        return [payload]

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
