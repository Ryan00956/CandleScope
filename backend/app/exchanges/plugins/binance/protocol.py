from __future__ import annotations

from typing import Any

from app.core.config import (
    BINANCE_BASE_URL,
    BINANCE_BASE_URLS,
    BINANCE_FUTURES_BASE_URL,
    BINANCE_FUTURES_BASE_URLS,
)
from app.exchanges.protocol import RestRequestSpec, WsConnectionSpec
from app.exchanges.ws_protocol import WsSubscriptionMode, WsSubscriptionSpec

from .symbols import BinanceSymbolNormalizer


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


class BinanceExchangeProtocol:
    """Binance REST/WS protocol rules owned by the Binance plugin."""

    def __init__(self) -> None:
        self._symbols = BinanceSymbolNormalizer()

    def rest_request(self, req: Any, config: Any | None = None) -> RestRequestSpec | None:
        desc = req.descriptor
        path = self.rest_path(desc.stream_type, desc.market_type)
        if path is None:
            return None
        return RestRequestSpec(
            base_urls=self.rest_base_urls(desc.market_type, config=config),
            path=path,
            params=self.build_http_params(req),
        )

    def ws_connection(self, descriptor: Any, config: Any | None = None) -> WsConnectionSpec:
        return WsConnectionSpec(
            base_urls=self.ws_base_urls(descriptor, config=config),
            subscription=self.build_ws_subscription(descriptor),
            connection_model="path_per_stream",
        )

    def rest_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        if config is not None and hasattr(config, "get_http_urls"):
            return list(config.get_http_urls(market_type))
        if market_type == "futures":
            return [BINANCE_FUTURES_BASE_URL] + [
                url for url in BINANCE_FUTURES_BASE_URLS if url != BINANCE_FUTURES_BASE_URL
            ]
        return [BINANCE_BASE_URL] + [
            url for url in BINANCE_BASE_URLS if url != BINANCE_BASE_URL
        ]

    def ws_base_urls(self, descriptor: Any, config: Any | None = None) -> list[str]:
        market_type = getattr(descriptor, "market_type", "spot")
        urls = self._base_ws_urls(market_type, config=config)
        if market_type != "futures":
            return urls

        stream_type = getattr(getattr(descriptor, "stream_type", ""), "value", "")
        if stream_type in _FUTURES_MARKET_STREAMS:
            return self._route_futures_ws_urls(urls, "market")
        if stream_type in _FUTURES_PUBLIC_STREAMS:
            return self._route_futures_ws_urls(urls, "public")
        return urls

    def rest_path(self, stream_type: Any, market_type: str = "spot") -> str | None:
        return _REST_PATH.get(market_type, _REST_PATH["spot"]).get(stream_type.value)

    def build_http_params(self, req: Any) -> dict[str, Any]:
        desc = req.descriptor
        params: dict[str, Any] = {
            "symbol": self._symbols.normalize(
                desc.symbol,
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

    def build_ws_stream_name(self, descriptor: Any) -> str:
        symbol = self._symbols.normalize(
            descriptor.symbol,
            market_type=descriptor.market_type,
        ).lower()
        if descriptor.stream_type.value == "kline":
            return f"{symbol}@kline_{descriptor.interval}"
        if descriptor.stream_type.value == "depth" and descriptor.depth_levels:
            return f"{symbol}@depth{descriptor.depth_levels}"
        return f"{symbol}@{descriptor.stream_type.value}"

    def build_ws_subscription(self, descriptor: Any) -> WsSubscriptionSpec:
        return WsSubscriptionSpec(
            mode=WsSubscriptionMode.PATH,
            stream_name=self.build_ws_stream_name(descriptor),
        )

    def build_combined_subscribe(self, descriptors: list[Any]) -> dict[str, Any]:
        return {}

    def payload_matches_descriptor(self, payload: Any, descriptor: Any) -> bool:
        return True

    def extract_http_rows(self, payload: Any, stream_type: Any) -> list[Any]:
        if isinstance(payload, list):
            return payload
        return [payload]

    def get_multi_symbol_ticker_stream_name(self, market_type: str = "spot") -> str | None:
        return "!miniTicker@arr"

    def _base_ws_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
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
