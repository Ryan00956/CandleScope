"""Declarative contracts for CCXT-backed exchange transports."""

from __future__ import annotations

from typing import Any, Protocol

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor

from .models import CcxtRawMarketEvent


class CcxtExchangeProfile(Protocol):
    """The small exchange-specific seam left above the shared CCXT runtime.

    A profile selects supported channels, resolves unified CCXT symbols, and
    starts the relevant ``watch_*`` call.  Raw payload interpretation stays in
    the existing CandleScope normalizer.
    """

    exchange_id: str
    market_type: str

    def supports(self, descriptor: StreamDescriptor) -> bool: ...

    def create_exchange(
        self,
        config: IngestionConfig,
        *,
        raw_event_sink: Any,
        lifecycle_sink: Any,
    ) -> Any: ...

    def resolve_symbol(self, exchange: Any, descriptor: StreamDescriptor) -> str: ...

    async def watch(
        self,
        exchange: Any,
        descriptor: StreamDescriptor,
        ccxt_symbol: str,
    ) -> Any: ...

    def matches(
        self,
        event: CcxtRawMarketEvent,
        descriptor: StreamDescriptor,
    ) -> bool: ...

    def runtime_key(self, config: IngestionConfig) -> tuple[str, ...]: ...
