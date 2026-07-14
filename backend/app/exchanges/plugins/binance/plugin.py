from __future__ import annotations

from typing import Any

from app.data_engine.ingestion.models import StreamType
from app.exchanges.plugin import BuiltinExchangePlugin
from app.exchanges.rate_limits import (
    HistoricalRequest,
    RateLimitOverride,
    RateLimitPolicy,
    RateLimitRule,
    effective_rate_limit_capacity,
)

from .adapter import BinanceExchangeAdapter
from .protocol import BinanceExchangeProtocol
from .symbols import BinanceSymbolNormalizer


class BinancePlugin(BuiltinExchangePlugin):
    """Built-in Binance exchange plugin."""

    def __init__(self) -> None:
        adapter = BinanceExchangeAdapter()
        super().__init__(
            adapter,
            protocol=BinanceExchangeProtocol(),
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
        spot_concurrency = _configured_concurrency(
            getattr(config, "fetch_binance_spot_concurrency", None),
            getattr(config, "fetch_concurrency", 2),
        )
        spot_delay = _non_negative_float(
            getattr(config, "fetch_rate_limit_delay", 0.5),
            0.5,
        )
        futures_concurrency = _configured_concurrency(
            getattr(config, "fetch_binance_futures_concurrency", 1),
            1,
        )
        futures_delay = _non_negative_float(
            getattr(config, "fetch_binance_futures_rate_limit_delay", 1.0),
            1.0,
        )
        backoff = _non_negative_float(
            getattr(config, "fetch_429_backoff_seconds", 60.0),
            60.0,
        )
        safety_factor = getattr(config, "fetch_rate_limit_safety_factor", 0.8)
        spot_capacity = effective_rate_limit_capacity(
            getattr(config, "fetch_binance_spot_weight_per_minute", 1200),
            safety_factor,
        )
        futures_capacity = effective_rate_limit_capacity(
            getattr(config, "fetch_binance_futures_weight_per_minute", 2400),
            safety_factor,
        )
        funding_history_capacity = effective_rate_limit_capacity(500, safety_factor)
        open_interest_history_capacity = effective_rate_limit_capacity(1000, safety_factor)
        return RateLimitPolicy(
            default_concurrency=spot_concurrency,
            default_delay_seconds=spot_delay,
            default_retry_429_backoff_seconds=backoff,
            market_overrides={
                "futures": RateLimitOverride(
                    concurrency=futures_concurrency,
                    delay_seconds=futures_delay,
                ),
            },
            endpoint_rules=(
                RateLimitRule(
                    name="binance_spot_klines",
                    bucket_key="binance:spot:request_weight:ip",
                    endpoint="/api/v3/klines",
                    market_types=("spot",),
                    algorithm="header_weight",
                    capacity=spot_capacity,
                    refill_interval_seconds=60.0,
                    cost=lambda request: 2,
                    max_concurrency=spot_concurrency,
                    cooldown_seconds=backoff,
                ),
                RateLimitRule(
                    name="binance_futures_klines",
                    bucket_key="binance:futures:request_weight:ip",
                    endpoint="/fapi/v1/klines",
                    market_types=("futures",),
                    algorithm="header_weight",
                    capacity=futures_capacity,
                    refill_interval_seconds=60.0,
                    cost=_futures_kline_cost,
                    max_concurrency=futures_concurrency,
                    cooldown_seconds=backoff,
                ),
                RateLimitRule(
                    name="binance_futures_premium_index",
                    bucket_key="binance:futures:request_weight:ip",
                    endpoint="/fapi/v1/premiumIndex",
                    market_types=("futures",),
                    algorithm="header_weight",
                    capacity=futures_capacity,
                    refill_interval_seconds=60.0,
                    max_concurrency=futures_concurrency,
                    cooldown_seconds=backoff,
                ),
                RateLimitRule(
                    name="binance_futures_open_interest",
                    bucket_key="binance:futures:request_weight:ip",
                    endpoint="/fapi/v1/openInterest",
                    market_types=("futures",),
                    algorithm="header_weight",
                    capacity=futures_capacity,
                    refill_interval_seconds=60.0,
                    max_concurrency=futures_concurrency,
                    cooldown_seconds=backoff,
                ),
                RateLimitRule(
                    name="binance_futures_funding_history",
                    bucket_key="binance:futures:funding_history:ip",
                    endpoint="/fapi/v1/fundingRate",
                    market_types=("futures",),
                    capacity=funding_history_capacity,
                    refill_interval_seconds=300.0,
                    max_concurrency=futures_concurrency,
                    cooldown_seconds=backoff,
                ),
                RateLimitRule(
                    name="binance_futures_open_interest_history",
                    bucket_key="binance:futures:open_interest_history:ip",
                    endpoint="/futures/data/openInterestHist",
                    market_types=("futures",),
                    capacity=open_interest_history_capacity,
                    refill_interval_seconds=300.0,
                    max_concurrency=futures_concurrency,
                    cooldown_seconds=backoff,
                ),
            ),
        )

    @staticmethod
    def _price_stream_type(market_type: str = "spot") -> StreamType:
        return StreamType.MINI_TICKER


def create_plugin() -> BinancePlugin:
    return BinancePlugin()


def _futures_kline_cost(request: HistoricalRequest) -> int:
    limit = int(request.limit or 500)
    if limit < 100:
        return 1
    if limit < 500:
        return 2
    if limit <= 1000:
        return 5
    return 10


def _configured_concurrency(value: Any, fallback: Any) -> int:
    raw = fallback if value is None else value
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 1


def _non_negative_float(value: Any, fallback: float) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return fallback
