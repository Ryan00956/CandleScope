"""Binance USD-M profile for the shared CCXT transport runtime."""

from __future__ import annotations

from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType

from ..binance_usdm import CandleScopeBinanceUSDM
from ..models import CcxtRawMarketEvent

_SUPPORTED_STREAMS = frozenset(
    {StreamType.KLINE, StreamType.AGG_TRADE, StreamType.FULL_DEPTH}
)


class BinanceUsdmCcxtProfile:
    exchange_id = "binance"
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
    ) -> CandleScopeBinanceUSDM:
        values: dict[str, Any] = {
            "newUpdates": True,
            "enableRateLimit": True,
            "aiohttp_trust_env": config.proxy_mode == "system",
        }
        if config.http_proxy and config.proxy_mode != "none":
            values["httpsProxy"] = config.http_proxy
            values["wssProxy"] = config.http_proxy
        from app.exchanges.plugins.binance.plugin import BinancePlugin

        return CandleScopeBinanceUSDM(
            values,
            raw_event_sink=raw_event_sink,
            lifecycle_sink=lifecycle_sink,
            rate_limit_policy=BinancePlugin().rate_limit_policy(config),
        )

    def resolve_symbol(
        self,
        exchange: CandleScopeBinanceUSDM,
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
            raise ValueError(
                f"unable to resolve one linear USD-M CCXT symbol for {native}"
            )
        return str(candidates[0]["symbol"])

    async def watch(
        self,
        exchange: CandleScopeBinanceUSDM,
        descriptor: StreamDescriptor,
        ccxt_symbol: str,
    ) -> Any:
        if descriptor.stream_type == StreamType.KLINE:
            return await exchange.watch_ohlcv(ccxt_symbol, descriptor.interval)
        if descriptor.stream_type == StreamType.AGG_TRADE:
            return await exchange.watch_trades(
                ccxt_symbol,
                params={"name": "aggTrade"},
            )
        if descriptor.stream_type == StreamType.FULL_DEPTH:
            return await exchange.watch_order_book(
                ccxt_symbol,
                limit=100,
                params={"rate": descriptor.update_interval_ms or 250},
            )
        raise ValueError(f"unsupported CCXT stream: {descriptor.stream_type.value}")

    def matches(
        self,
        event: CcxtRawMarketEvent,
        descriptor: StreamDescriptor,
    ) -> bool:
        if event.symbol is None or event.symbol.upper() != descriptor.symbol.upper():
            return False
        expected = {
            StreamType.KLINE: "kline",
            StreamType.AGG_TRADE: "aggTrade",
            StreamType.FULL_DEPTH: "depth",
        }.get(descriptor.stream_type)
        if event.channel != expected:
            return False
        if descriptor.stream_type == StreamType.KLINE:
            kline = event.payload.get("k")
            return isinstance(kline, dict) and str(kline.get("i") or "") == str(
                descriptor.interval or ""
            )
        return True

    def runtime_key(self, config: IngestionConfig) -> tuple[str, ...]:
        return (
            self.exchange_id,
            self.market_type,
            config.proxy_mode,
            config.http_proxy or "",
        )
