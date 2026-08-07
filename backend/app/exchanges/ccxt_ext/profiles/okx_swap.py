"""OKX linear swap profile for CCXT shadow qualification."""

from __future__ import annotations

from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType

from ..models import CcxtRawMarketEvent
from ..okx import CandleScopeOkx

_SUPPORTED_STREAMS = frozenset({StreamType.KLINE, StreamType.TICKER})


class OkxSwapCcxtProfile:
    exchange_id = "okx"
    # CandleScope's existing plugin names perpetual swaps "futures".
    market_type = "futures"

    def supports(self, descriptor: StreamDescriptor) -> bool:
        return (
            descriptor.exchange.strip().lower() == self.exchange_id
            and descriptor.market_type.strip().lower() == self.market_type
            and descriptor.stream_type in _SUPPORTED_STREAMS
        )

    def create_exchange(
        self,
        config: IngestionConfig,
        *,
        raw_event_sink: Any,
        lifecycle_sink: Any,
    ) -> CandleScopeOkx:
        values: dict[str, Any] = {
            "newUpdates": True,
            "enableRateLimit": True,
            "aiohttp_trust_env": config.proxy_mode == "system",
            "options": {"defaultType": "swap"},
        }
        if config.http_proxy and config.proxy_mode != "none":
            values["httpsProxy"] = config.http_proxy
            values["wssProxy"] = config.http_proxy
        return CandleScopeOkx(
            values,
            raw_event_sink=raw_event_sink,
            lifecycle_sink=lifecycle_sink,
        )

    def resolve_symbol(
        self,
        exchange: CandleScopeOkx,
        descriptor: StreamDescriptor,
    ) -> str:
        native = descriptor.symbol.upper().strip()
        candidates = [
            market
            for market in exchange.markets.values()
            if str(market.get("id") or "").upper() == native
            and bool(market.get("swap"))
            and bool(market.get("linear"))
        ]
        if len(candidates) != 1:
            raise ValueError(f"unable to resolve one OKX linear swap for {native}")
        return str(candidates[0]["symbol"])

    async def watch(
        self,
        exchange: CandleScopeOkx,
        descriptor: StreamDescriptor,
        ccxt_symbol: str,
    ) -> Any:
        if descriptor.stream_type == StreamType.KLINE:
            return await exchange.watch_ohlcv(ccxt_symbol, descriptor.interval)
        if descriptor.stream_type == StreamType.TICKER:
            return await exchange.watch_ticker(ccxt_symbol)
        raise ValueError(f"unsupported CCXT stream: {descriptor.stream_type.value}")

    def matches(
        self,
        event: CcxtRawMarketEvent,
        descriptor: StreamDescriptor,
    ) -> bool:
        if event.symbol is None or event.symbol.upper() != descriptor.symbol.upper():
            return False
        if descriptor.stream_type == StreamType.TICKER:
            return event.channel == "tickers"
        if descriptor.stream_type != StreamType.KLINE:
            return False
        expected_channel = "candle" + _okx_interval(descriptor.interval or "")
        return event.channel == expected_channel

    def runtime_key(self, config: IngestionConfig) -> tuple[str, ...]:
        return (
            self.exchange_id,
            self.market_type,
            config.proxy_mode,
            config.http_proxy or "",
        )


def _okx_interval(interval: str) -> str:
    mapped = {
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
    if not mapped:
        raise ValueError("OKX K-line interval must not be empty")
    return mapped
