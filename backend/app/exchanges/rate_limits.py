from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any


def _unit_cost(_: HistoricalRequest) -> int:
    return 1


def effective_rate_limit_capacity(
    raw_capacity: Any,
    safety_factor: Any = 1.0,
) -> int:
    """Return a conservative positive capacity after applying safety factor."""
    try:
        capacity = int(raw_capacity)
    except (TypeError, ValueError):
        capacity = 1
    try:
        factor = float(safety_factor)
    except (TypeError, ValueError):
        factor = 1.0
    factor = min(1.0, max(0.01, factor))
    return max(1, int(capacity * factor))


@dataclass(slots=True)
class HistoricalRequest:
    """Exchange-agnostic description of one historical REST request."""

    exchange: str
    market_type: str
    endpoint: str
    symbol: str
    interval: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    limit: int | None = None
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class RateLimitRule:
    """Endpoint-aware REST/backfill rate-limit rule."""

    name: str
    bucket_key: str
    capacity: int
    refill_interval_seconds: float
    endpoint: str | None = None
    market_types: tuple[str, ...] = ()
    algorithm: str = "token_bucket"
    cost: Callable[[HistoricalRequest], int] = _unit_cost
    max_concurrency: int | None = None
    cooldown_seconds: float = 60.0

    def matches(self, request: HistoricalRequest) -> bool:
        if self.endpoint is not None and self.endpoint != request.endpoint:
            return False
        if self.market_types:
            market_type = str(request.market_type or "spot").strip().lower()
            return market_type in self.market_types
        return True

    def request_cost(self, request: HistoricalRequest) -> int:
        return max(1, int(self.cost(request)))

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "bucket_key": self.bucket_key,
            "endpoint": self.endpoint,
            "market_types": list(self.market_types),
            "algorithm": self.algorithm,
            "capacity": self.capacity,
            "refill_interval_seconds": self.refill_interval_seconds,
            "max_concurrency": self.max_concurrency,
            "cooldown_seconds": self.cooldown_seconds,
        }


@dataclass(slots=True)
class RateLimitDecision:
    """Result of acquiring capacity from one rate-limit bucket."""

    bucket_key: str
    cost: int
    wait_seconds: float
    allowed_at: float
    rule_name: str


@dataclass(slots=True)
class _Bucket:
    key: str
    rule_name: str
    algorithm: str
    refill_interval_seconds: float
    max_concurrency: int | None
    capacity: int
    refill_per_second: float
    tokens: float
    updated_at: float = field(default_factory=time.monotonic)
    cooldown_until: float = 0.0
    last_wait_seconds: float = 0.0
    last_cost: int = 0
    last_status_code: int | None = None
    last_body_code: str | None = None
    last_headers: dict[str, str] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def refill(self, now: float) -> None:
        elapsed = max(0.0, now - self.updated_at)
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_per_second)
        self.updated_at = now

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        return {
            "rule": self.rule_name,
            "algorithm": self.algorithm,
            "capacity": self.capacity,
            "refill_interval_seconds": self.refill_interval_seconds,
            "max_concurrency": self.max_concurrency,
            "tokens": round(self.tokens, 2),
            "cooldown_until": self.cooldown_until,
            "cooldown_remaining_seconds": round(
                max(0.0, self.cooldown_until - now),
                3,
            ),
            "last_wait_seconds": round(self.last_wait_seconds, 3),
            "last_cost": self.last_cost,
            "last_status_code": self.last_status_code,
            "last_body_code": self.last_body_code,
            "last_headers": dict(self.last_headers),
        }


class RateLimitManager:
    """Executes endpoint-aware exchange REST/backfill rate-limit rules."""

    def __init__(self) -> None:
        self._buckets: dict[str, _Bucket] = {}

    async def acquire(
        self,
        rule: RateLimitRule,
        request: HistoricalRequest,
    ) -> RateLimitDecision:
        bucket = self._bucket_for(rule)
        cost = min(rule.request_cost(request), bucket.capacity)
        wait_seconds = 0.0
        total_wait_seconds = 0.0

        while True:
            async with bucket.lock:
                now = time.monotonic()
                bucket.refill(now)
                if now < bucket.cooldown_until:
                    wait_seconds = max(0.0, bucket.cooldown_until - now)
                elif bucket.tokens >= cost:
                    bucket.tokens -= cost
                    bucket.last_cost = cost
                    bucket.last_wait_seconds = total_wait_seconds
                    return RateLimitDecision(
                        bucket_key=rule.bucket_key,
                        cost=cost,
                        wait_seconds=total_wait_seconds,
                        allowed_at=now,
                        rule_name=rule.name,
                    )
                elif bucket.refill_per_second > 0:
                    wait_seconds = max(
                        0.001,
                        (cost - bucket.tokens) / bucket.refill_per_second,
                    )
                else:
                    wait_seconds = 1.0

            total_wait_seconds += wait_seconds
            await asyncio.sleep(wait_seconds)

    def record_cooldown(self, rule: RateLimitRule, seconds: float) -> bool:
        if seconds <= 0:
            return False
        bucket = self._bucket_for(rule)
        cooldown_until = time.monotonic() + seconds
        if cooldown_until <= bucket.cooldown_until:
            return False
        bucket.cooldown_until = cooldown_until
        return True

    def record_response(
        self,
        rule: RateLimitRule,
        *,
        status_code: int | None = None,
        headers: Mapping[str, str] | None = None,
        body_code: str | None = None,
        retry_after: float | None = None,
        fallback_cooldown_seconds: float | None = None,
    ) -> bool:
        bucket = self._bucket_for(rule)
        normalized_headers = _normalize_headers(headers)
        bucket.last_status_code = status_code
        bucket.last_body_code = body_code
        bucket.last_headers = _rate_limit_headers(normalized_headers)

        used_weight = _binance_used_weight(normalized_headers)
        if used_weight is not None:
            bucket.tokens = min(bucket.tokens, max(0.0, bucket.capacity - used_weight))

        parsed_retry_after = retry_after
        if parsed_retry_after is None:
            parsed_retry_after = _parse_retry_after(
                normalized_headers.get("retry-after"),
            )
        cooldown_seconds = _cooldown_seconds(
            status_code=status_code,
            body_code=body_code,
            retry_after=parsed_retry_after,
            fallback=fallback_cooldown_seconds,
        )
        if cooldown_seconds <= 0:
            return False
        return self.record_cooldown(rule, cooldown_seconds)

    def snapshot(self) -> dict[str, Any]:
        return {
            key: bucket.snapshot()
            for key, bucket in sorted(self._buckets.items())
        }

    def _bucket_for(self, rule: RateLimitRule) -> _Bucket:
        bucket = self._buckets.get(rule.bucket_key)
        if bucket is not None:
            return bucket

        capacity = max(1, int(rule.capacity))
        interval = max(0.001, float(rule.refill_interval_seconds))
        bucket = _Bucket(
            key=rule.bucket_key,
            rule_name=rule.name,
            algorithm=rule.algorithm,
            refill_interval_seconds=interval,
            max_concurrency=rule.max_concurrency,
            capacity=capacity,
            refill_per_second=capacity / interval,
            tokens=float(capacity),
        )
        self._buckets[rule.bucket_key] = bucket
        return bucket


def _normalize_headers(headers: Mapping[str, str] | None) -> dict[str, str]:
    if not headers:
        return {}
    return {str(key).lower(): str(value) for key, value in headers.items()}


def _rate_limit_headers(headers: Mapping[str, str]) -> dict[str, str]:
    interesting: dict[str, str] = {}
    for key, value in headers.items():
        if (
            key.startswith("x-mbx-used-weight")
            or key == "retry-after"
            or key.startswith("x-ratelimit")
        ):
            interesting[key] = value
    return interesting


def _binance_used_weight(headers: Mapping[str, str]) -> float | None:
    candidates = [
        value
        for key, value in headers.items()
        if key.startswith("x-mbx-used-weight")
    ]
    if not candidates:
        return None
    try:
        return max(float(value) for value in candidates)
    except (TypeError, ValueError):
        return None


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        retry_after = float(value)
    except (TypeError, ValueError):
        return None
    if retry_after < 0:
        return None
    return retry_after


def _cooldown_seconds(
    *,
    status_code: int | None,
    body_code: str | None,
    retry_after: float | None,
    fallback: float | None,
) -> float:
    if status_code in {418, 429} or body_code == "50011":
        return max(
            0.0,
            float(retry_after or 0.0),
            float(fallback or 0.0),
        )
    return 0.0


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
    endpoint_rules: tuple[RateLimitRule, ...] = ()

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

    def rule_for(self, request: HistoricalRequest) -> RateLimitRule:
        for rule in self.endpoint_rules:
            if rule.matches(request):
                return rule

        market_type = str(request.market_type or "spot").strip().lower()
        delay = self.delay_for(market_type)
        capacity = 1
        interval = max(delay, 0.001)
        return RateLimitRule(
            name=f"{request.exchange}_{market_type}_legacy",
            bucket_key=f"{request.exchange}:{market_type}:legacy",
            capacity=capacity,
            refill_interval_seconds=interval,
            endpoint=request.endpoint,
            market_types=(market_type,),
            max_concurrency=self.concurrency_for(market_type),
            cooldown_seconds=self.retry_429_backoff_for(market_type),
        )

    def _override(self, market_type: str) -> RateLimitOverride | None:
        return self.market_overrides.get(str(market_type or "spot").strip().lower())
