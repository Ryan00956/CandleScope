"""OKX Spot profile for CCXT shadow qualification."""

from __future__ import annotations

from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor

from ..okx import CandleScopeOkxSpot
from .okx_swap import OkxSwapCcxtProfile


class OkxSpotCcxtProfile(OkxSwapCcxtProfile):
    market_type = "spot"

    def create_exchange(
        self,
        config: IngestionConfig,
        *,
        raw_event_sink: Any,
        lifecycle_sink: Any,
    ) -> CandleScopeOkxSpot:
        values: dict[str, Any] = {
            "newUpdates": True,
            "enableRateLimit": True,
            "aiohttp_trust_env": config.proxy_mode == "system",
            "options": {"defaultType": "spot"},
        }
        if config.http_proxy and config.proxy_mode != "none":
            values["httpsProxy"] = config.http_proxy
            values["wssProxy"] = config.http_proxy
        return CandleScopeOkxSpot(
            values,
            raw_event_sink=raw_event_sink,
            lifecycle_sink=lifecycle_sink,
        )

    def resolve_symbol(
        self,
        exchange: CandleScopeOkxSpot,
        descriptor: StreamDescriptor,
    ) -> str:
        native = descriptor.symbol.upper().strip()
        candidates = [
            market
            for market in exchange.markets.values()
            if str(market.get("id") or "").upper() == native
            and bool(market.get("spot"))
        ]
        if len(candidates) != 1:
            raise ValueError(f"unable to resolve one OKX Spot market for {native}")
        return str(candidates[0]["symbol"])
