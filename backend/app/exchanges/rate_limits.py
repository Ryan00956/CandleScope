from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class RateLimitOverride:
    """Per-market REST/backfill rate-limit settings."""

    concurrency: int | None = None
    delay_seconds: float | None = None
    retry_429_backoff_seconds: float | None = None


@dataclass(slots=True)
class RateLimitPolicy:
    """Exchange-level REST/backfill rate-limit policy.

    The first implementation is intentionally small: it gives backfill and
    future transport code one exchange-owned place to ask for concurrency and
    pacing without hard-coding exchange names in those modules.
    """

    default_concurrency: int = 2
    default_delay_seconds: float = 0.5
    default_retry_429_backoff_seconds: float = 60.0
    market_overrides: dict[str, RateLimitOverride] = field(default_factory=dict)

    def concurrency_for(self, market_type: str = "spot") -> int:
        override = self._override(market_type)
        value = override.concurrency if override else None
        return max(1, int(value if value is not None else self.default_concurrency))

    def delay_for(self, market_type: str = "spot") -> float:
        override = self._override(market_type)
        value = override.delay_seconds if override else None
        return max(0.0, float(value if value is not None else self.default_delay_seconds))

    def retry_429_backoff_for(self, market_type: str = "spot") -> float:
        override = self._override(market_type)
        value = override.retry_429_backoff_seconds if override else None
        return max(
            0.0,
            float(
                value
                if value is not None
                else self.default_retry_429_backoff_seconds
            ),
        )

    def _override(self, market_type: str) -> RateLimitOverride | None:
        return self.market_overrides.get(str(market_type or "spot").strip().lower())
