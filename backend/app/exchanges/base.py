from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

from .models import ExchangeCapabilities, SymbolInfo
from .ws_protocol import WsSubscriptionSpec

if TYPE_CHECKING:
    from app.data_engine.ingestion.models import StreamDescriptor, StreamType, TransportRequest


class ExchangeAdapter(Protocol):
    """Legacy facade implemented by each exchange integration.

    Runtime code should prefer ``ExchangePlugin`` plus its protocol and
    policies. This interface remains to keep older callers and imports stable.
    """

    id: str
    name: str

    def capabilities(self) -> ExchangeCapabilities:
        """Return static capabilities supported by this adapter."""
        ...

    async def list_symbols(self, market_type: str = "") -> list[SymbolInfo]:
        """Return canonical symbol metadata for one or all market types."""
        ...

    def get_http_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        """Return candidate REST base URLs for this exchange/market."""
        ...

    def get_ws_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        """Return candidate WebSocket base URLs for this exchange/market."""
        ...

    def get_rest_path(self, stream_type: "StreamType", market_type: str = "spot") -> str | None:
        """Return REST path for a normalized stream type."""
        ...

    def build_http_params(self, req: "TransportRequest") -> dict[str, Any]:
        """Build exchange-specific REST query params."""
        ...

    def build_ws_stream_name(self, descriptor: "StreamDescriptor") -> str:
        """Build exchange-specific WS stream name."""
        ...

    def build_ws_subscription(self, descriptor: "StreamDescriptor") -> WsSubscriptionSpec:
        """Build exchange-specific WS subscription instructions."""
        ...

    def get_multi_symbol_ticker_stream_name(self, market_type: str = "spot") -> str | None:
        """Return the WS stream name for the exchange's all-symbol ticker feed."""
        ...

    def supports_ws_streaming(self, market_type: str = "spot") -> bool:
        """Return True if the current ingestion stack can open live WS streams for this market."""
        ...

    def extract_http_rows(self, payload: Any, stream_type: "StreamType") -> list[Any]:
        """Unwrap an exchange-specific REST payload into row objects for normalization."""
        ...
