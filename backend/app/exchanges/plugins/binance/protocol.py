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
        "markPrice": "/fapi/v1/premiumIndex",
        "indexPrice": "/fapi/v1/premiumIndex",
        "fundingRate": "/fapi/v1/premiumIndex",
        "openInterest": "/fapi/v1/openInterest",
    },
}

_FUTURES_HISTORY_PATH = {
    "fundingRate": "/fapi/v1/fundingRate",
    "openInterest": "/futures/data/openInterestHist",
}

_MARK_PRICE_PROJECTIONS = {"markPrice", "indexPrice", "fundingRate"}
_OPEN_INTEREST_PERIODS = {"5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"}
_PARTIAL_DEPTH_LEVELS = {5, 10, 20}
_PARTIAL_DEPTH_UPDATE_INTERVALS_MS = {
    # Spot's 1000ms cadence is selected by omitting the speed suffix.
    "spot": {100, 1000},
    "futures": {100, 250, 500},
}
_PARTIAL_DEPTH_DEFAULT_INTERVAL_MS = {
    "spot": 1000,
    "futures": 250,
}

_FUTURES_MARKET_STREAMS = {
    "aggTrade",
    "forceOrder",
    "kline",
    "miniTicker",
    "ticker",
    *_MARK_PRICE_PROJECTIONS,
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
        path = self.rest_path(
            desc.stream_type,
            desc.market_type,
            history=bool(getattr(req, "history", False)),
        )
        if path is None:
            return None
        return RestRequestSpec(
            base_urls=self.rest_base_urls(desc.market_type, config=config),
            path=path,
            params=self.build_http_params(req),
        )

    def ws_connection(self, descriptor: Any, config: Any | None = None) -> WsConnectionSpec:
        stream_type = getattr(getattr(descriptor, "stream_type", None), "value", "")
        return WsConnectionSpec(
            base_urls=self.ws_base_urls(descriptor, config=config),
            subscription=self.build_ws_subscription(descriptor),
            connection_model=(
                "shared_multiplex"
                if stream_type in _MARK_PRICE_PROJECTIONS
                else "path_per_stream"
            ),
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

    def rest_path(
        self,
        stream_type: Any,
        market_type: str = "spot",
        *,
        history: bool = False,
    ) -> str | None:
        if history and market_type == "futures":
            if stream_type.value in {"markPrice", "indexPrice"}:
                return None
            override = _FUTURES_HISTORY_PATH.get(stream_type.value)
            if override is not None:
                return override
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
            params["limit"] = min(max(int(req.limit or 1), 1), 1000)
            if req.start_ms is not None:
                params["startTime"] = str(max(0, int(req.start_ms)))
            if req.end_ms is not None:
                params["endTime"] = str(max(0, int(req.end_ms)))
        elif desc.stream_type.value == "aggTrade":
            params["limit"] = min(max(int(req.limit or 1), 1), 1000)
            from_id = getattr(req, "from_id", None)
            if from_id is not None:
                if req.start_ms is not None or req.end_ms is not None:
                    raise ValueError(
                        "aggregate-trade requests cannot combine from_id with a time range",
                    )
                params["fromId"] = str(max(0, int(from_id)))
            if req.start_ms is not None:
                params["startTime"] = str(max(0, int(req.start_ms)))
            if req.end_ms is not None:
                params["endTime"] = str(max(0, int(req.end_ms)))
        elif desc.stream_type.value == "trade":
            params["limit"] = min(max(int(req.limit or 1), 1), 1000)
        elif desc.stream_type.value == "depth":
            max_limit = 1000 if desc.market_type == "futures" else 5000
            params["limit"] = min(max(int(req.limit or 1), 1), max_limit)
        elif desc.stream_type.value in _MARK_PRICE_PROJECTIONS | {"openInterest"}:
            history = bool(getattr(req, "history", False))
            if history:
                if desc.stream_type.value == "fundingRate":
                    params["limit"] = min(max(int(req.limit or 1), 1), 1000)
                elif desc.stream_type.value == "openInterest":
                    if not desc.interval:
                        raise ValueError("open-interest history requires a period")
                    if desc.interval not in _OPEN_INTEREST_PERIODS:
                        raise ValueError(f"unsupported open-interest period: {desc.interval}")
                    params["period"] = desc.interval
                    params["limit"] = min(max(int(req.limit or 1), 1), 500)
                if req.start_ms is not None:
                    params["startTime"] = str(max(0, int(req.start_ms)))
                if req.end_ms is not None:
                    params["endTime"] = str(max(0, int(req.end_ms)))

        return params

    def build_ws_stream_name(self, descriptor: Any) -> str:
        symbol = self._symbols.normalize(
            descriptor.symbol,
            market_type=descriptor.market_type,
        ).lower()
        if descriptor.stream_type.value == "kline":
            return f"{symbol}@kline_{descriptor.interval}"
        if descriptor.stream_type.value == "depth":
            levels, update_interval_ms = self._partial_depth_stream_params(descriptor)
            stream_name = f"{symbol}@depth{levels}"
            default_interval_ms = _PARTIAL_DEPTH_DEFAULT_INTERVAL_MS[
                descriptor.market_type.strip().lower()
            ]
            if (
                update_interval_ms is not None
                and update_interval_ms != default_interval_ms
            ):
                stream_name = f"{stream_name}@{update_interval_ms}ms"
            return stream_name
        if descriptor.stream_type.value in _MARK_PRICE_PROJECTIONS:
            return f"{symbol}@markPrice@1s"
        return f"{symbol}@{descriptor.stream_type.value}"

    def build_ws_subscription(self, descriptor: Any) -> WsSubscriptionSpec:
        stream_name = self.build_ws_stream_name(descriptor)
        if descriptor.stream_type.value in _MARK_PRICE_PROJECTIONS:
            return WsSubscriptionSpec(
                mode=WsSubscriptionMode.MESSAGE,
                stream_name=stream_name,
                subscribe_payload={"method": "SUBSCRIBE", "params": [stream_name], "id": 1},
                unsubscribe_payload={"method": "UNSUBSCRIBE", "params": [stream_name], "id": 2},
            )
        return WsSubscriptionSpec(
            mode=WsSubscriptionMode.PATH,
            stream_name=stream_name,
        )

    def build_combined_subscribe(self, descriptors: list[Any]) -> dict[str, Any]:
        streams = list(dict.fromkeys(self.build_ws_stream_name(item) for item in descriptors))
        if not streams:
            return {}
        return {"method": "SUBSCRIBE", "params": streams, "id": 1}

    def payload_matches_descriptor(self, payload: Any, descriptor: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        stream_type = descriptor.stream_type.value
        if stream_type in _MARK_PRICE_PROJECTIONS:
            if payload.get("e") != "markPriceUpdate":
                return False
            if "st" in payload and payload.get("st") != 1:
                return False
            payload_symbol = str(payload.get("s", "")).upper()
            expected_symbol = self._symbols.normalize(
                descriptor.symbol,
                market_type=descriptor.market_type,
            ).upper()
            return payload_symbol == expected_symbol
        if stream_type == "forceOrder":
            if str(getattr(descriptor, "market_type", "spot")).strip().lower() != "futures":
                return False
            if payload.get("e") != "forceOrder":
                return False
            if "st" in payload and (
                type(payload.get("st")) is not int or payload.get("st") != 1
            ):
                return False
            order = payload.get("o")
            if not isinstance(order, dict):
                return False
            payload_symbol = str(order.get("s", "")).upper()
            expected_symbol = self._symbols.normalize(
                descriptor.symbol,
                market_type=descriptor.market_type,
            ).upper()
            return payload_symbol == expected_symbol
        if stream_type == "depth" and str(
            getattr(descriptor, "market_type", "spot"),
        ).strip().lower() == "futures":
            if payload.get("e") != "depthUpdate":
                return False
            if "st" in payload and (
                type(payload.get("st")) is not int or payload.get("st") != 1
            ):
                return False
            payload_symbol = str(payload.get("s", "")).upper()
            expected_symbol = self._symbols.normalize(
                descriptor.symbol,
                market_type=descriptor.market_type,
            ).upper()
            return payload_symbol == expected_symbol
        return True

    def supports_ws(self, descriptor: Any) -> bool:
        """Return channel-level WS availability for the current plugin."""

        stream_type = getattr(getattr(descriptor, "stream_type", None), "value", "")
        if stream_type == "depth":
            try:
                self._partial_depth_stream_params(descriptor)
            except ValueError:
                return False
        if str(getattr(descriptor, "market_type", "spot")).strip().lower() != "futures":
            return stream_type not in {
                "forceOrder",
                "markPrice",
                "indexPrice",
                "fundingRate",
                "openInterest",
            }
        return stream_type != "openInterest"

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
    def _partial_depth_stream_params(descriptor: Any) -> tuple[int, int | None]:
        levels = getattr(descriptor, "depth_levels", None)
        if type(levels) is not int or levels not in _PARTIAL_DEPTH_LEVELS:
            raise ValueError("Binance partial depth requires levels in {5, 10, 20}")

        market_type = str(getattr(descriptor, "market_type", "spot")).strip().lower()
        allowed_intervals = _PARTIAL_DEPTH_UPDATE_INTERVALS_MS.get(market_type)
        if allowed_intervals is None:
            raise ValueError(f"unsupported Binance depth market_type: {market_type}")

        update_interval_ms = getattr(descriptor, "update_interval_ms", None)
        if update_interval_ms is None:
            return levels, None
        if type(update_interval_ms) is not int or update_interval_ms not in allowed_intervals:
            supported = ", ".join(str(value) for value in sorted(allowed_intervals))
            raise ValueError(
                f"Binance {market_type} partial depth update_interval_ms must be one of "
                f"{{{supported}}}",
            )
        return levels, update_interval_ms

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
