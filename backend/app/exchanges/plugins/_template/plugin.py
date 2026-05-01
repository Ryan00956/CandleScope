from __future__ import annotations

from typing import Any

from app.exchanges.plugin import BuiltinExchangePlugin
from app.exchanges.rate_limits import RateLimitPolicy

from .adapter import TemplateExchangeAdapter
from .symbols import TemplateSymbolNormalizer


class TemplatePlugin(BuiltinExchangePlugin):
    """Copy this class for a new exchange and replace Template/template names."""

    def __init__(self) -> None:
        adapter = TemplateExchangeAdapter()
        super().__init__(
            adapter,
            normalizer_factory=self._normalizer,
            symbol_normalizer=TemplateSymbolNormalizer(),
            rate_limit_policy_factory=self._rate_limit_policy,
        )

    @staticmethod
    def _normalizer(config: Any, descriptor: Any) -> Any:
        from .normalizer import TemplateNormalizer

        return TemplateNormalizer(config, descriptor)

    @staticmethod
    def _rate_limit_policy(config: Any | None = None) -> RateLimitPolicy:
        return RateLimitPolicy(
            default_concurrency=int(getattr(config, "fetch_concurrency", 2)),
            default_delay_seconds=float(getattr(config, "fetch_rate_limit_delay", 0.5)),
            default_retry_429_backoff_seconds=float(
                getattr(config, "fetch_429_backoff_seconds", 60.0)
            ),
        )


def create_plugin() -> TemplatePlugin:
    return TemplatePlugin()
