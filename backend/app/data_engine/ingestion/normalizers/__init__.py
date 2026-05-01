"""Exchange-specific normalizer factory."""
from __future__ import annotations

from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor

from .base import ExchangeNormalizer, truncate_payload
from .binance import BinanceNormalizer
from .okx import OkxNormalizer


def create_normalizer(
    config: IngestionConfig,
    descriptor: StreamDescriptor,
) -> ExchangeNormalizer:
    exchange = (descriptor.exchange or "binance").strip().lower()
    bootstrap_default_adapters()
    return get_exchange_registry().get_plugin(exchange).normalizer(config, descriptor)


__all__ = [
    "BinanceNormalizer",
    "ExchangeNormalizer",
    "OkxNormalizer",
    "create_normalizer",
    "truncate_payload",
]
