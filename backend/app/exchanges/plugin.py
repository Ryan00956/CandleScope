from __future__ import annotations

from typing import Any, Callable, Protocol

from .base import ExchangeAdapter
from .archive import HistoricalArchiveProvider
from .models import ExchangeCapabilities
from .pagination import HistoricalPaginationPolicy, ReverseTimePaginationPolicy
from .protocol import AdapterBackedProtocol, ExchangeProtocol
from .rate_limits import RateLimitPolicy
from .realtime import RealtimePolicy


class SymbolNormalizer(Protocol):
    """Exchange-specific symbol normalization behavior."""

    def normalize(self, symbol: str, market_type: str = "spot") -> str:
        ...

    def display(self, symbol: str, market_type: str = "spot") -> str:
        ...


class ExchangePlugin(Protocol):
    """Top-level exchange integration object.

    New exchange behavior should be exposed through the plugin's protocol and
    policies. The adapter entry point remains for legacy compatibility.
    """

    id: str
    name: str

    def adapter(self) -> ExchangeAdapter:
        ...

    def capabilities(self) -> ExchangeCapabilities:
        ...

    def protocol(self) -> ExchangeProtocol:
        ...

    def normalizer(self, config: Any, descriptor: Any) -> Any:
        ...

    def symbol_normalizer(self) -> SymbolNormalizer:
        ...

    def rate_limit_policy(self, config: Any | None = None) -> RateLimitPolicy:
        ...

    def pagination_policy(self, config: Any | None = None) -> HistoricalPaginationPolicy:
        ...

    def realtime_policy(self) -> RealtimePolicy:
        ...

    def price_stream_type(self, market_type: str = "spot") -> Any:
        ...

    def history_archive_provider(
        self,
        config: Any | None = None,
    ) -> HistoricalArchiveProvider | None:
        ...


class DefaultSymbolNormalizer:
    """Default symbol normalizer for exchanges whose canonical symbols are user-facing."""

    def normalize(self, symbol: str, market_type: str = "spot") -> str:
        return str(symbol or "").upper().strip()

    def display(self, symbol: str, market_type: str = "spot") -> str:
        return self.normalize(symbol, market_type)


class BuiltinExchangePlugin:
    """Compatibility plugin for current in-tree exchange adapters."""

    id: str
    name: str

    def __init__(
        self,
        adapter: ExchangeAdapter,
        *,
        normalizer_factory: Callable[[Any, Any], Any] | None = None,
        protocol: ExchangeProtocol | None = None,
        symbol_normalizer: SymbolNormalizer | None = None,
        rate_limit_policy_factory: Callable[[Any | None], RateLimitPolicy] | None = None,
        pagination_policy_factory: Callable[[Any | None], HistoricalPaginationPolicy] | None = None,
        realtime_policy: RealtimePolicy | None = None,
        price_stream_type_factory: Callable[[str], Any] | None = None,
        history_archive_provider_factory: Callable[
            [Any | None], HistoricalArchiveProvider | None
        ] | None = None,
    ) -> None:
        self._adapter = adapter
        self.id = adapter.id
        self.name = adapter.name
        self._protocol = protocol or AdapterBackedProtocol(adapter)
        self._normalizer_factory = normalizer_factory
        self._symbol_normalizer = symbol_normalizer or DefaultSymbolNormalizer()
        self._rate_limit_policy_factory = rate_limit_policy_factory
        self._pagination_policy_factory = pagination_policy_factory
        self._realtime_policy = realtime_policy or RealtimePolicy()
        self._price_stream_type_factory = price_stream_type_factory
        self._history_archive_provider_factory = history_archive_provider_factory

    def adapter(self) -> ExchangeAdapter:
        return self._adapter

    def capabilities(self) -> ExchangeCapabilities:
        return self._adapter.capabilities()

    def protocol(self) -> ExchangeProtocol:
        return self._protocol

    def normalizer(self, config: Any, descriptor: Any) -> Any:
        if self._normalizer_factory is None:
            raise KeyError(f"No normalizer registered for exchange: {self.id}")
        return self._normalizer_factory(config, descriptor)

    def symbol_normalizer(self) -> SymbolNormalizer:
        return self._symbol_normalizer

    def rate_limit_policy(self, config: Any | None = None) -> RateLimitPolicy:
        if self._rate_limit_policy_factory is None:
            return RateLimitPolicy()
        return self._rate_limit_policy_factory(config)

    def pagination_policy(self, config: Any | None = None) -> HistoricalPaginationPolicy:
        if self._pagination_policy_factory is None:
            return ReverseTimePaginationPolicy()
        return self._pagination_policy_factory(config)

    def realtime_policy(self) -> RealtimePolicy:
        return self._realtime_policy

    def price_stream_type(self, market_type: str = "spot") -> Any:
        if self._price_stream_type_factory is not None:
            return self._price_stream_type_factory(market_type)
        from app.data_engine.ingestion.models import StreamType

        return StreamType.TICKER

    def history_archive_provider(
        self,
        config: Any | None = None,
    ) -> HistoricalArchiveProvider | None:
        if self._history_archive_provider_factory is None:
            return None
        return self._history_archive_provider_factory(config)
