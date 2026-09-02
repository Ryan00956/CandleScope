from __future__ import annotations

from typing import Any

from app.data_engine.history import get_history_calendar_registry
from app.data_engine.ingestion.models import StreamType
from app.data_engine.series_identity import KlineSeriesIdentity
from app.exchanges.plugin import BuiltinExchangePlugin
from app.exchanges.rate_limits import RateLimitPolicy, RateLimitRule, effective_rate_limit_capacity

from .adapter import (
    EXCHANGE_DATE_CALENDAR_ID,
    WEEKDAY_CALENDAR_ID,
    TwelveDataExchangeAdapter,
)
from .calendar import TwelveDataUsEquityCalendar, build_provider_date_calendar
from .identity import EQUITY_MARKET_TYPES, identity_is_supported, is_us_equity_venue
from .pagination import TwelveDataHistoricalPaginationPolicy
from .protocol import TwelveDataExchangeProtocol
from .runtime import get_shared_twelve_data_runtime_pool
from .session import TwelveDataProviderSession
from .symbols import TwelveDataSymbolNormalizer


def _register_calendars() -> None:
    registry = get_history_calendar_registry()
    if registry.get(WEEKDAY_CALENDAR_ID) is None:
        registry.register(
            WEEKDAY_CALENDAR_ID,
            build_provider_date_calendar(calendar_id=WEEKDAY_CALENDAR_ID),
        )
    if registry.get(EXCHANGE_DATE_CALENDAR_ID) is None:
        registry.register(
            EXCHANGE_DATE_CALENDAR_ID,
            TwelveDataUsEquityCalendar(calendar_id=EXCHANGE_DATE_CALENDAR_ID),
        )


class TwelveDataPlugin(BuiltinExchangePlugin):
    def __init__(self) -> None:
        _register_calendars()
        adapter = TwelveDataExchangeAdapter()
        super().__init__(
            adapter,
            protocol=TwelveDataExchangeProtocol(),
            normalizer_factory=self._normalizer,
            symbol_normalizer=TwelveDataSymbolNormalizer(),
            rate_limit_policy_factory=self._rate_limit_policy,
            pagination_policy_factory=self._pagination_policy,
        )

    @staticmethod
    def _normalizer(config: Any, descriptor: Any) -> Any:
        from .normalizer import TwelveDataNormalizer

        return TwelveDataNormalizer(config, descriptor)

    @staticmethod
    def _pagination_policy(config: Any | None = None) -> TwelveDataHistoricalPaginationPolicy:
        del config
        return TwelveDataHistoricalPaginationPolicy()

    @staticmethod
    def _rate_limit_policy(config: Any | None = None) -> RateLimitPolicy:
        try:
            concurrency = max(1, int(getattr(config, "fetch_twelve_data_concurrency", 1)))
        except (TypeError, ValueError):
            concurrency = 1
        capacity = effective_rate_limit_capacity(
            getattr(config, "fetch_twelve_data_credits_per_minute", 8),
            getattr(config, "fetch_rate_limit_safety_factor", 0.8),
        )
        try:
            backoff = max(0.0, float(getattr(config, "fetch_429_backoff_seconds", 60.0)))
        except (TypeError, ValueError):
            backoff = 60.0
        shared = {
            "bucket_key": "twelvedata:api-credits:key",
            "capacity": capacity,
            "refill_interval_seconds": 60.0,
            "max_concurrency": concurrency,
            "cooldown_seconds": max(60.0, backoff),
        }
        return RateLimitPolicy(
            default_concurrency=concurrency,
            default_delay_seconds=0.0,
            default_retry_429_backoff_seconds=max(60.0, backoff),
            endpoint_rules=(
                RateLimitRule(
                    name="twelve_data_time_series",
                    endpoint="/time_series",
                    **shared,
                ),
                RateLimitRule(
                    name="twelve_data_symbol_search",
                    endpoint="/symbol_search",
                    **shared,
                ),
                RateLimitRule(
                    name="twelve_data_quote",
                    endpoint="/quote",
                    **shared,
                ),
            ),
        )

    @staticmethod
    def supports_provider_stream(descriptor: Any) -> bool:
        return (
            getattr(descriptor, "stream_type", None) == StreamType.TICKER
            and str(getattr(descriptor, "market_type", "")).strip().lower()
            in {"stock", "etf", "forex", "commodity"}
        )

    @staticmethod
    def provider_stream_enabled(config: Any, descriptor: Any) -> bool:
        del descriptor
        return bool(
            getattr(config, "twelve_data_ws_enabled", True)
            and str(getattr(config, "twelve_data_api_key", "") or "").strip()
        )

    def create_stream_session(self, config: Any, descriptor: Any) -> Any | None:
        if not self.supports_provider_stream(descriptor):
            return None
        if not self.provider_stream_enabled(config, descriptor):
            return None
        return TwelveDataProviderSession(config=config, descriptor=descriptor)

    @staticmethod
    def provider_stream_snapshot() -> dict[str, Any]:
        return get_shared_twelve_data_runtime_pool().snapshot()

    def supports_history_identity(
        self,
        *,
        market_type: str,
        interval: str,
        identity: KlineSeriesIdentity,
    ) -> bool:
        if not identity_is_supported(identity, market_type=market_type):
            return False
        if (
            str(market_type).strip().lower() in EQUITY_MARKET_TYPES
            and interval not in {"1d", "1w", "1M"}
            and not is_us_equity_venue(identity.venue)
        ):
            return False
        channel = self.capabilities().channel_capability("kline", market_type)
        if channel is None or not channel.history:
            return False
        supported = channel.params.get("interval", ())
        return interval in supported


def create_plugin() -> TwelveDataPlugin:
    return TwelveDataPlugin()


__all__ = ["TwelveDataPlugin", "create_plugin"]
