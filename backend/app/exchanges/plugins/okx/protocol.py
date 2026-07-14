from __future__ import annotations

from typing import Any

from app.exchanges.protocol import RestRequestSpec, WsConnectionSpec
from app.exchanges.ws_protocol import WsSubscriptionMode, WsSubscriptionSpec


OKX_REST_BASE_URLS = [
    "https://www.okx.com",
]

_OKX_INTERVALS = {
    "1s": "1s",
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1H",
    "2h": "2H",
    "4h": "4H",
    "6h": "6Hutc",
    "12h": "12Hutc",
    "1d": "1Dutc",
    "3d": "3Dutc",
    "1w": "1Wutc",
    "1M": "1Mutc",
}

_REST_PATH: dict[str, dict[str, str]] = {
    "spot": {
        "kline": "/api/v5/market/history-candles",
        "ticker": "/api/v5/market/ticker",
        "miniTicker": "/api/v5/market/ticker",
    },
    "futures": {
        "kline": "/api/v5/market/history-candles",
        "ticker": "/api/v5/market/ticker",
        "miniTicker": "/api/v5/market/ticker",
    },
}


class OkxExchangeProtocol:
    """OKX REST/WS protocol rules owned by the OKX plugin."""

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
        stream_type = getattr(getattr(descriptor, "stream_type", None), "value", "")
        return WsConnectionSpec(
            base_urls=self.ws_base_urls(descriptor, config=config),
            subscription=self.build_ws_subscription(descriptor),
            connection_model=(
                "shared_multiplex" if stream_type == "kline" else "message_per_stream"
            ),
        )

    def rest_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        return self.sanitize_http_urls(list(OKX_REST_BASE_URLS))

    def ws_base_urls(self, descriptor: Any, config: Any | None = None) -> list[str]:
        market_type = getattr(descriptor, "market_type", "spot")
        stream_type = getattr(getattr(descriptor, "stream_type", ""), "value", "")
        if stream_type in ("ticker", "miniTicker"):
            return self.get_ticker_ws_urls(market_type)
        return self.sanitize_ws_urls(["wss://ws.okx.com:8443/ws/v5/business"])

    def rest_path(self, stream_type: Any, market_type: str = "spot") -> str | None:
        return _REST_PATH.get(market_type, _REST_PATH["spot"]).get(stream_type.value)

    def build_http_params(self, req: Any) -> dict[str, Any]:
        desc = req.descriptor
        params: dict[str, Any] = {"instId": desc.symbol.upper()}
        if desc.stream_type.value != "kline":
            return params

        interval = desc.interval or "1m"
        mapped = _OKX_INTERVALS.get(interval)
        if mapped is None:
            raise ValueError(f"Unsupported OKX interval: {interval}")

        params["bar"] = mapped
        params["limit"] = min(max(int(req.limit or 1), 1), 300)
        if req.end_ms is not None:
            params["after"] = str(max(0, int(req.end_ms) + 1))
        if req.start_ms is not None:
            params["before"] = str(max(0, int(req.start_ms) - 1))
        return params

    def build_ws_stream_name(self, descriptor: Any) -> str:
        if descriptor.stream_type.value in ("ticker", "miniTicker"):
            return "tickers"
        interval = descriptor.interval or "1m"
        mapped = _OKX_INTERVALS.get(interval)
        if mapped is None:
            raise ValueError(f"Unsupported OKX interval: {interval}")
        return f"candle{mapped}"

    def build_ws_subscription(self, descriptor: Any) -> WsSubscriptionSpec:
        channel = self.build_ws_stream_name(descriptor)
        arg = {
            "channel": channel,
            "instId": descriptor.symbol.upper(),
        }
        return WsSubscriptionSpec(
            mode=WsSubscriptionMode.MESSAGE,
            subscribe_payload={"op": "subscribe", "args": [arg]},
            unsubscribe_payload={"op": "unsubscribe", "args": [arg]},
            requires_subscribe_ack=True,
        )

    def get_multi_symbol_ticker_stream_name(self, market_type: str = "spot") -> str | None:
        return None

    def get_ticker_ws_urls(self, market_type: str = "spot") -> list[str]:
        return self.sanitize_ws_urls(["wss://ws.okx.com:8443/ws/v5/public"])

    def build_ticker_subscribe(self, symbols: list[str]) -> dict:
        args = [{"channel": "tickers", "instId": s.upper()} for s in symbols]
        return {"op": "subscribe", "args": args}

    def build_ticker_unsubscribe(self, symbols: list[str]) -> dict:
        args = [{"channel": "tickers", "instId": s.upper()} for s in symbols]
        return {"op": "unsubscribe", "args": args}

    def extract_http_rows(self, payload: Any, stream_type: Any) -> list[Any]:
        actual_stream_type = getattr(stream_type, "stream_type", stream_type)
        if not isinstance(payload, dict):
            return []
        if str(payload.get("code", "0")) not in ("0", ""):
            msg = payload.get("msg") or "unknown OKX error"
            raise RuntimeError(f"OKX REST error: {msg}")
        data = payload.get("data")
        if not isinstance(data, list):
            return []
        if getattr(actual_stream_type, "value", "") == "kline":
            return list(reversed(data))
        return data

    def build_combined_subscribe(self, descriptors: list[Any]) -> dict[str, Any]:
        args: list[dict[str, Any]] = []
        seen: set[tuple[tuple[str, str], ...]] = set()
        for descriptor in descriptors:
            payload = self.build_ws_subscription(descriptor).subscribe_payload or {}
            payload_args = payload.get("args") if isinstance(payload.get("args"), list) else []
            for arg in payload_args:
                if not isinstance(arg, dict):
                    continue
                key = tuple(sorted((str(k), str(v)) for k, v in arg.items()))
                if not key or key in seen:
                    continue
                seen.add(key)
                args.append(dict(arg))
        if not args:
            return {}
        return {"op": "subscribe", "args": args}

    def payload_matches_descriptor(self, payload: Any, descriptor: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        arg = payload.get("arg") if isinstance(payload.get("arg"), dict) else {}
        for expected in self._subscription_args(descriptor):
            if not isinstance(expected, dict):
                continue
            if self._arg_matches(arg, expected):
                return True
        return False

    def sanitize_http_urls(self, urls: list[str]) -> list[str]:
        return self._sanitize_urls(urls, ("aws.okx.com",))

    def sanitize_ws_urls(self, urls: list[str]) -> list[str]:
        return self._sanitize_urls(urls, ("wsaws.okx.com",))

    def _subscription_args(self, descriptor: Any) -> list[Any]:
        payload = self.build_ws_subscription(descriptor).subscribe_payload or {}
        payload_args = payload.get("args") if isinstance(payload.get("args"), list) else []
        return list(payload_args)

    @staticmethod
    def _arg_matches(actual: dict[str, Any], expected: dict[str, Any]) -> bool:
        for field in ("channel", "instId", "symbol", "topic"):
            if field not in expected:
                continue
            expected_value = str(expected.get(field, "")).upper()
            actual_value = str(actual.get(field, "")).upper()
            if not expected_value or expected_value != actual_value:
                return False
        return True

    @staticmethod
    def _sanitize_urls(urls: list[str], blocked_substrings: tuple[str, ...]) -> list[str]:
        cleaned = [
            url for url in urls
            if url and not any(blocked in url for blocked in blocked_substrings)
        ]
        return list(dict.fromkeys(cleaned))
