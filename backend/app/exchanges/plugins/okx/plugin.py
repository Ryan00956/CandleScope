from __future__ import annotations

from typing import Any

from app.exchanges.plugin import BuiltinExchangePlugin
from app.exchanges.protocol import AdapterBackedProtocol
from app.exchanges.rate_limits import RateLimitPolicy
from app.exchanges.realtime import RealtimePolicy, RealtimeUpdateMode

from .adapter import OkxExchangeAdapter


class OkxPlugin(BuiltinExchangePlugin):
    """Built-in OKX exchange plugin."""

    def __init__(self) -> None:
        adapter = OkxExchangeAdapter()
        super().__init__(
            adapter,
            normalizer_factory=self._normalizer,
            protocol=AdapterBackedProtocol(
                adapter,
                blocked_http_substrings=("aws.okx.com",),
                blocked_ws_substrings=("wsaws.okx.com",),
            ),
            rate_limit_policy_factory=self._rate_limit_policy,
            realtime_policy=RealtimePolicy(update_mode=RealtimeUpdateMode.BASE_INTERVAL_FANOUT),
        )

    @staticmethod
    def _normalizer(config: Any, descriptor: Any) -> Any:
        from .normalizer import OkxNormalizer

        return OkxNormalizer(config, descriptor)

    @staticmethod
    def _rate_limit_policy(config: Any | None = None) -> RateLimitPolicy:
        return RateLimitPolicy(
            default_concurrency=int(getattr(config, "fetch_okx_concurrency", 1)),
            default_delay_seconds=float(getattr(config, "fetch_okx_rate_limit_delay", 0.75)),
            default_retry_429_backoff_seconds=float(
                getattr(config, "fetch_429_backoff_seconds", 60.0)
            ),
        )


def create_plugin() -> OkxPlugin:
    return OkxPlugin()
