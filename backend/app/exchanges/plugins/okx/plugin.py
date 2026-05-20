from __future__ import annotations

from typing import Any

from app.exchanges.plugin import BuiltinExchangePlugin
from app.exchanges.pagination import OkxHistoricalPaginationPolicy
from app.exchanges.rate_limits import (
    RateLimitPolicy,
    RateLimitRule,
    effective_rate_limit_capacity,
)
from app.exchanges.realtime import RealtimePolicy, RealtimeUpdateMode

from .adapter import OkxExchangeAdapter
from .protocol import OkxExchangeProtocol


class OkxPlugin(BuiltinExchangePlugin):
    """Built-in OKX exchange plugin."""

    def __init__(self) -> None:
        adapter = OkxExchangeAdapter()
        super().__init__(
            adapter,
            normalizer_factory=self._normalizer,
            protocol=OkxExchangeProtocol(),
            rate_limit_policy_factory=self._rate_limit_policy,
            pagination_policy_factory=self._pagination_policy,
            realtime_policy=RealtimePolicy(update_mode=RealtimeUpdateMode.BASE_INTERVAL_FANOUT),
        )

    @staticmethod
    def _normalizer(config: Any, descriptor: Any) -> Any:
        from .normalizer import OkxNormalizer

        return OkxNormalizer(config, descriptor)

    @staticmethod
    def _rate_limit_policy(config: Any | None = None) -> RateLimitPolicy:
        concurrency = _configured_concurrency(
            getattr(config, "fetch_okx_concurrency", 1),
            1,
        )
        delay = _non_negative_float(
            getattr(config, "fetch_okx_rate_limit_delay", 0.75),
            0.75,
        )
        backoff = _non_negative_float(
            getattr(config, "fetch_429_backoff_seconds", 60.0),
            60.0,
        )
        safety_factor = getattr(config, "fetch_rate_limit_safety_factor", 0.8)
        history_capacity = effective_rate_limit_capacity(
            getattr(config, "fetch_okx_history_candles_requests_per_2s", 20),
            safety_factor,
        )
        candles_capacity = effective_rate_limit_capacity(
            getattr(config, "fetch_okx_candles_requests_per_2s", 40),
            safety_factor,
        )
        return RateLimitPolicy(
            default_concurrency=concurrency,
            default_delay_seconds=delay,
            default_retry_429_backoff_seconds=backoff,
            endpoint_rules=(
                RateLimitRule(
                    name="okx_history_candles",
                    bucket_key="okx:history-candles:ip",
                    endpoint="/api/v5/market/history-candles",
                    capacity=history_capacity,
                    refill_interval_seconds=2.0,
                    cost=lambda request: 1,
                    max_concurrency=concurrency,
                    cooldown_seconds=max(backoff, 2.0),
                ),
                RateLimitRule(
                    name="okx_market_candles",
                    bucket_key="okx:market-candles:ip",
                    endpoint="/api/v5/market/candles",
                    capacity=candles_capacity,
                    refill_interval_seconds=2.0,
                    cost=lambda request: 1,
                    max_concurrency=concurrency,
                    cooldown_seconds=max(backoff, 2.0),
                ),
            ),
        )

    @staticmethod
    def _pagination_policy(config: Any | None = None) -> OkxHistoricalPaginationPolicy:
        return OkxHistoricalPaginationPolicy()


def create_plugin() -> OkxPlugin:
    return OkxPlugin()


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
