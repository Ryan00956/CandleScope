from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class ExchangeMarket:
    """A market family exposed by an exchange adapter."""

    market_type: str
    product_type: str
    label: str
    contract_family: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "market_type": self.market_type,
            "product_type": self.product_type,
            "label": self.label,
            "contract_family": self.contract_family,
        }


@dataclass(slots=True)
class ExchangeCapabilities:
    """Static capabilities advertised by an exchange adapter."""

    exchange: str
    name: str
    plugin_api_version: str = "1.0"
    capability_schema_version: int = 1
    markets: list[ExchangeMarket] = field(default_factory=list)
    native_intervals: list[str] = field(default_factory=list)
    supports_multi_symbol_ticker: bool = False
    supports_symbol_search: bool = True
    ws_connection_model: str = "path_per_stream"
    protocol_features: list[str] = field(default_factory=list)
    limits: dict[str, Any] = field(default_factory=dict)
    known_limitations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "name": self.name,
            "plugin_api_version": self.plugin_api_version,
            "capability_schema_version": self.capability_schema_version,
            "markets": [market.to_dict() for market in self.markets],
            "native_intervals": list(self.native_intervals),
            "supports_multi_symbol_ticker": self.supports_multi_symbol_ticker,
            "supports_symbol_search": self.supports_symbol_search,
            "ws_connection_model": self.ws_connection_model,
            "protocol_features": list(self.protocol_features),
            "limits": dict(self.limits),
            "known_limitations": list(self.known_limitations),
        }


@dataclass(slots=True)
class SymbolInfo:
    """Canonical symbol metadata used by the frontend and registry cache."""

    symbol: str
    base_asset: str
    quote_asset: str
    status: str
    exchange: str
    market_type: str
    product_type: str
    contract_type: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = {
            "symbol": self.symbol,
            "baseAsset": self.base_asset,
            "quoteAsset": self.quote_asset,
            "status": self.status,
            "exchange": self.exchange,
            "marketType": self.market_type,
            "productType": self.product_type,
        }
        if self.contract_type:
            data["contractType"] = self.contract_type
        return data
