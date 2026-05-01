from __future__ import annotations

from typing import Any

from app.data_engine.ingestion.models import StreamType
from app.exchanges.plugin import BuiltinExchangePlugin
from app.exchanges.rate_limits import RateLimitOverride, RateLimitPolicy

from .adapter import BinanceExchangeAdapter
from .symbols import BinanceSymbolNormalizer


class BinancePlugin(BuiltinExchangePlugin):
    """Built-in Binance exchange plugin."""

    def __init__(self) -> None:
        adapter = BinanceExchangeAdapter()
        super().__init__(
            adapter,
            normalizer_factory=self._normalizer,
            symbol_normalizer=BinanceSymbolNormalizer(),
            rate_limit_policy_factory=self._rate_limit_policy,
            price_stream_type_factory=self._price_stream_type,
        )

    @staticmethod
    def _normalizer(config: Any, descriptor: Any) -> Any:
        from .normalizer import BinanceNormalizer

        return BinanceNormalizer(config, descriptor)

    @staticmethod
    def _rate_limit_policy(config: Any | None = None) -> RateLimitPolicy:
        return RateLimitPolicy(
            default_concurrency=int(getattr(config, "fetch_concurrency", 2)),
            default_delay_seconds=float(getattr(config, "fetch_rate_limit_delay", 0.5)),
            default_retry_429_backoff_seconds=float(
                getattr(config, "fetch_429_backoff_seconds", 60.0)
            ),
            market_overrides={
                "futures": RateLimitOverride(
                    concurrency=int(getattr(config, "fetch_binance_futures_concurrency", 1)),
                    delay_seconds=float(
                        getattr(config, "fetch_binance_futures_rate_limit_delay", 1.0)
                    ),
                ),
            },
        )

    @staticmethod
    def _price_stream_type(market_type: str = "spot") -> StreamType:
        return StreamType.MINI_TICKER


def create_plugin() -> BinancePlugin:
    return BinancePlugin()
