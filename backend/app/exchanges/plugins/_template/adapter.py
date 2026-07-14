from __future__ import annotations

from typing import Any

from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.exchanges.models import (
    ExchangeCapabilities,
    ExchangeMarket,
    MarketChannelCapability,
    SymbolInfo,
)
from app.exchanges.ws_protocol import WsSubscriptionMode, WsSubscriptionSpec


class TemplateExchangeAdapter:
    """Legacy facade skeleton for a new exchange plugin.

    Prefer putting REST/WS behavior in protocol.py. Keep this class small so
    old imports and optional symbol metadata callers continue to work.
    """

    id = "template"
    name = "Template"

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
            ],
            channels=[
                MarketChannelCapability(
                    channel=MarketChannel.KLINE,
                    market_types=("spot",),
                    realtime=True,
                    history=True,
                    realtime_transports=(
                        TransportMode.WEBSOCKET,
                        TransportMode.REST_POLL,
                    ),
                    history_transports=(TransportMode.REST_HISTORY,),
                    delivery=DeliveryClass.APPEND,
                    snapshot=True,
                    sequence="timestamp",
                    resync="replace_snapshot",
                    params={"interval": ["1m", "5m", "15m", "1h", "1d"]},
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
                        "is_closed",
                    ),
                    connection_model="message_per_stream",
                    limits={"rest.max_limit": 1000},
                ),
            ],
            native_intervals=["1m", "5m", "15m", "1h", "1d"],
            supports_multi_symbol_ticker=False,
            supports_symbol_search=True,
            ws_connection_model="message_per_stream",
            protocol_features=[
                "rest.kline",
                "ws.message_subscribe",
                "pagination.custom",
            ],
            limits={
                "rest.kline.max_limit": 1000,
            },
            known_limitations=[
                "Replace template limitations with exchange-specific notes",
            ],
        )

    async def list_symbols(self, market_type: str = "") -> list[SymbolInfo]:
        raise NotImplementedError("Fetch and map exchange instruments to SymbolInfo")

    def get_http_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        return ["https://api.example.com"]

    def get_ws_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        return ["wss://ws.example.com"]

    def get_rest_path(self, stream_type, market_type: str = "spot") -> str | None:
        if stream_type.value == "kline":
            return "/market/candles"
        if stream_type.value in ("ticker", "miniTicker"):
            return "/market/ticker"
        return None

    def build_http_params(self, req) -> dict[str, Any]:
        desc = req.descriptor
        params: dict[str, Any] = {
            "symbol": desc.symbol,
        }
        if desc.stream_type.value == "kline":
            params.update({
                "interval": desc.interval,
                "limit": req.limit,
            })
            if req.start_ms is not None:
                params["start"] = int(req.start_ms)
            if req.end_ms is not None:
                params["end"] = int(req.end_ms)
        return params

    def build_ws_stream_name(self, descriptor) -> str:
        if descriptor.stream_type.value == "kline":
            return f"{descriptor.symbol}@kline_{descriptor.interval}"
        return f"{descriptor.symbol}@{descriptor.stream_type.value}"

    def build_ws_subscription(self, descriptor) -> WsSubscriptionSpec:
        payload = {
            "op": "subscribe",
            "args": [{
                "channel": self.build_ws_stream_name(descriptor),
                "symbol": descriptor.symbol,
            }],
        }
        return WsSubscriptionSpec(
            mode=WsSubscriptionMode.MESSAGE,
            subscribe_payload=payload,
            unsubscribe_payload={
                "op": "unsubscribe",
                "args": payload["args"],
            },
            requires_subscribe_ack=True,
        )

    def get_multi_symbol_ticker_stream_name(self, market_type: str = "spot") -> str | None:
        return None

    def supports_ws_streaming(self, market_type: str = "spot") -> bool:
        return True

    def extract_http_rows(self, payload: Any, stream_type) -> list[Any]:
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            return payload["data"]
        if isinstance(payload, list):
            return payload
        return [payload]
