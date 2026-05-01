from __future__ import annotations

import logging
from typing import Any

import aiohttp

from app.core.config import REQUEST_TIMEOUT, get_effective_proxy
from .models import ExchangeCapabilities, ExchangeMarket, SymbolInfo
from .ws_protocol import WsSubscriptionMode, WsSubscriptionSpec

logger = logging.getLogger("candlescope.exchange.okx")

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


class OkxExchangeAdapter:
    """Exchange adapter for OKX spot + perpetual markets.

    Prefer native WS first, then degrade to HTTP polling when the runtime
    environment cannot keep the socket stable.
    """

    id = "okx"
    name = "OKX"

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
                    label="Swap Perpetual",
                ),
            ],
            native_intervals=list(_OKX_INTERVALS.keys()),
            supports_multi_symbol_ticker=False,
            supports_symbol_search=True,
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
        return list(OKX_REST_BASE_URLS)

    def get_ws_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        return [
            "wss://ws.okx.com:8443/ws/v5/business",
        ]

    def get_rest_path(self, stream_type, market_type: str = "spot") -> str | None:
        return _REST_PATH.get(market_type, _REST_PATH["spot"]).get(stream_type.value)

    def build_http_params(self, req) -> dict[str, Any]:
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
        # OKX naming is counter-intuitive:
        #   "after"  → return records with ts STRICTLY EARLIER (older) than this value
        #   "before" → return records with ts STRICTLY NEWER  (more recent) than this value
        # Both are EXCLUSIVE boundaries, but req.end_ms / req.start_ms are
        # meant to be INCLUSIVE.  Add ±1 ms to include bars at the exact
        # boundary timestamps.
        if req.end_ms is not None:
            params["after"] = str(max(0, int(req.end_ms) + 1))
        if req.start_ms is not None:
            params["before"] = str(max(0, int(req.start_ms) - 1))
        return params

    def build_ws_stream_name(self, descriptor) -> str:
        if descriptor.stream_type.value in ("ticker", "miniTicker"):
            return "tickers"
        interval = descriptor.interval or "1m"
        mapped = _OKX_INTERVALS.get(interval)
        if mapped is None:
            raise ValueError(f"Unsupported OKX interval: {interval}")
        return f"candle{mapped}"

    def build_ws_subscription(self, descriptor) -> WsSubscriptionSpec:
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
        """Return WS URLs for the public ticker channel (per-symbol)."""
        return ["wss://ws.okx.com:8443/ws/v5/public"]

    def build_ticker_subscribe(self, symbols: list[str]) -> dict:
        """Build a subscribe message for the OKX tickers channel."""
        args = [{"channel": "tickers", "instId": s.upper()} for s in symbols]
        return {"op": "subscribe", "args": args}

    def build_ticker_unsubscribe(self, symbols: list[str]) -> dict:
        """Build an unsubscribe message for the OKX tickers channel."""
        args = [{"channel": "tickers", "instId": s.upper()} for s in symbols]
        return {"op": "unsubscribe", "args": args}

    def supports_ws_streaming(self, market_type: str = "spot") -> bool:
        return True

    def extract_http_rows(self, payload: Any, stream_type) -> list[Any]:
        if not isinstance(payload, dict):
            return []
        if str(payload.get("code", "0")) not in ("0", ""):
            msg = payload.get("msg") or "unknown OKX error"
            raise RuntimeError(f"OKX REST error: {msg}")
        data = payload.get("data")
        if not isinstance(data, list):
            return []
        if getattr(stream_type, "value", "") == "kline":
            return list(reversed(data))
        return data

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
