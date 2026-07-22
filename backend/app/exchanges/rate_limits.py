from __future__ import annotations

import asyncio
import time
import weakref
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


@dataclass(frozen=True, slots=True)
class RateLimitAdmission:
    """Immediate exchange-budget admission result.

    ``allowed=False`` is a scheduling decision, not a request failure.  Callers
    that already own scarce worker/concurrency slots must release them and
    retry no earlier than ``retry_at_monotonic``.
    """

    allowed: bool
    bucket_key: str
    cost: int
    reason: str | None
    retry_after_seconds: float
    retry_at_monotonic: float | None
    retry_at_ms: int | None
    rule_name: str
    status_code: int | None = None
    body_code: str | None = None
    circuit_key: str | None = None


class RateLimitDeferred(RuntimeError):
    """Typed control signal for work that must return to a delayed queue."""

    def __init__(self, admission: RateLimitAdmission) -> None:
        if admission.allowed:
            raise ValueError("cannot defer an allowed rate-limit admission")
        self.admission = admission
        self.bucket_key = admission.bucket_key
        self.rule_name = admission.rule_name
        self.reason = admission.reason or "budget"
        self.retry_after_seconds = max(0.001, admission.retry_after_seconds)
        self.retry_at_monotonic = admission.retry_at_monotonic
        self.retry_at_ms = admission.retry_at_ms
        self.status_code = admission.status_code
        self.body_code = admission.body_code
        self.circuit_key = admission.circuit_key
        super().__init__(
            "exchange rate-limit admission deferred "
            f"for {self.bucket_key} ({self.reason}); "
            f"retry in {self.retry_after_seconds:.3f}s"
        )


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
    deferred_requests: int = 0
    last_deferred_at_ms: int | None = None
    cold_start_probe_pending: bool = False
    recovery_probe_pending: bool = False
    recovery_generation: int = 0
    last_recovery_probe_at_ms: int | None = None
    probe_kind: str | None = None
    probe_lease_until: float = 0.0
    probe_started_at_ms: int | None = None
    probe_owner_task: asyncio.Task[Any] | None = field(default=None, repr=False)
    last_probe_release_at_ms: int | None = None
    last_probe_release_reason: str | None = None
    circuit_generation: int = 0
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
            "deferred_requests": self.deferred_requests,
            "last_deferred_at_ms": self.last_deferred_at_ms,
            "cold_start_probe_pending": self.cold_start_probe_pending,
            "recovery_probe_pending": self.recovery_probe_pending,
            "recovery_generation": self.recovery_generation,
            "last_recovery_probe_at_ms": self.last_recovery_probe_at_ms,
            "probe_in_flight": now < self.probe_lease_until,
            "probe_kind": self.probe_kind,
            "probe_lease_remaining_seconds": round(
                max(0.0, self.probe_lease_until - now),
                3,
            ),
            "probe_started_at_ms": self.probe_started_at_ms,
            "last_probe_release_at_ms": self.last_probe_release_at_ms,
            "last_probe_release_reason": self.last_probe_release_reason,
            "circuit_generation": self.circuit_generation,
        }


@dataclass(slots=True)
class _Circuit:
    key: str
    cooldown_until: float = 0.0
    last_status_code: int | None = None
    last_body_code: str | None = None
    last_headers: dict[str, str] = field(default_factory=dict)
    opened_at_ms: int | None = None
    generation: int = 0
    recovery_pending: bool = False

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        return {
            "key": self.key,
            "open": now < self.cooldown_until,
            "cooldown_remaining_seconds": round(
                max(0.0, self.cooldown_until - now),
                3,
            ),
            "last_status_code": self.last_status_code,
            "last_body_code": self.last_body_code,
            "last_headers": dict(self.last_headers),
            "opened_at_ms": self.opened_at_ms,
            "generation": self.generation,
            "recovery_pending": self.recovery_pending,
        }


class RateLimitManager:
    """Executes endpoint-aware exchange REST/backfill rate-limit rules."""

    def __init__(
        self,
        *,
        conservative_cold_start: bool = False,
        probe_lease_seconds: float = 30.0,
    ) -> None:
        self._buckets: dict[str, _Bucket] = {}
        self._circuits: dict[str, _Circuit] = {}
        self._conservative_cold_start = bool(conservative_cold_start)
        # Normal response accounting releases this lease immediately.  The
        # bound is only a fail-safe for a cancelled caller that never records
        # its physical response; production HTTP timeouts are shorter.
        self._probe_lease_seconds = max(
            0.01,
            min(float(probe_lease_seconds), 300.0),
        )

    async def inspect(
        self,
        rule: RateLimitRule,
        request: HistoricalRequest,
    ) -> RateLimitAdmission:
        """Return current admission state without consuming quota."""

        return await self._admit(rule, request, consume=False)

    async def acquire_nowait(
        self,
        rule: RateLimitRule,
        request: HistoricalRequest,
    ) -> RateLimitDecision:
        """Reserve quota immediately or raise :class:`RateLimitDeferred`."""

        admission = await self._admit(rule, request, consume=True)
        if not admission.allowed:
            bucket = self._bucket_for(rule)
            bucket.deferred_requests += 1
            bucket.last_deferred_at_ms = int(time.time() * 1000)
            raise RateLimitDeferred(admission)
        now = time.monotonic()
        return RateLimitDecision(
            bucket_key=admission.bucket_key,
            cost=admission.cost,
            wait_seconds=0.0,
            allowed_at=now,
            rule_name=admission.rule_name,
        )

    async def acquire(
        self,
        rule: RateLimitRule,
        request: HistoricalRequest,
    ) -> RateLimitDecision:
        total_wait_seconds = 0.0

        while True:
            admission = await self._admit(rule, request, consume=True)
            if admission.allowed:
                bucket = self._bucket_for(rule)
                bucket.last_wait_seconds = total_wait_seconds
                return RateLimitDecision(
                    bucket_key=admission.bucket_key,
                    cost=admission.cost,
                    wait_seconds=total_wait_seconds,
                    allowed_at=time.monotonic(),
                    rule_name=admission.rule_name,
                )
            wait_seconds = max(0.001, admission.retry_after_seconds)
            total_wait_seconds += wait_seconds
            await asyncio.sleep(wait_seconds)

    async def deferred_error(
        self,
        rule: RateLimitRule,
        request: HistoricalRequest,
    ) -> RateLimitDeferred:
        """Build a typed defer signal from the manager's current state."""

        admission = await self.inspect(rule, request)
        if admission.allowed:
            now = time.monotonic()
            retry_after = max(0.001, float(rule.cooldown_seconds or 0.0))
            admission = RateLimitAdmission(
                allowed=False,
                bucket_key=rule.bucket_key,
                cost=max(1, rule.request_cost(request)),
                reason="exchange_response",
                retry_after_seconds=retry_after,
                retry_at_monotonic=now + retry_after,
                retry_at_ms=int(time.time() * 1000 + retry_after * 1000),
                rule_name=rule.name,
            )
        return RateLimitDeferred(admission)

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
        response_complete: bool = True,
        response_unknown: bool = False,
    ) -> bool:
        bucket = self._bucket_for(rule)
        now = time.monotonic()
        if response_unknown:
            # This is the completion half of a headers-only observation. Keep
            # the previously recorded status/headers (including used-weight),
            # but release an owned probe conservatively from zero because the
            # body/connection outcome was not authoritative.
            self._release_probe_for_response(
                bucket,
                now=now,
                response_is_rate_limited=False,
                response_is_unknown=True,
            )
            return False
        response_is_rate_limited = (
            status_code in {418, 429}
            or body_code in {"-1003", "50011"}
        )
        if response_complete or response_is_rate_limited:
            self._release_probe_for_response(
                bucket,
                now=now,
                response_is_rate_limited=response_is_rate_limited,
                response_is_unknown=status_code is None and body_code is None,
            )
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
        bucket_extended = self.record_cooldown(rule, cooldown_seconds)
        if bucket_extended and status_code != 418:
            # A bucket-scoped warning (HTTP 429 or an exchange-equivalent
            # body code) must not recover with every token accumulated during
            # Retry-After.  Admit exactly one request-cost as a probe after the
            # cooldown, then let the ordinary token bucket ramp the remainder.
            # HTTP 418 retains the stricter exchange-wide circuit recovery
            # below, which deliberately starts every bucket from zero.
            bucket.recovery_probe_pending = True
            bucket.recovery_generation += 1
        circuit_extended = False
        if status_code == 418:
            circuit_extended = self._record_global_circuit(
                rule,
                seconds=cooldown_seconds,
                status_code=status_code,
                body_code=body_code,
                headers=normalized_headers,
            )
        return bucket_extended or circuit_extended

    def snapshot(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, bucket in sorted(self._buckets.items()):
            payload = bucket.snapshot()
            circuit = self._circuits.get(self._circuit_key_for_bucket(key))
            if circuit is not None:
                payload["global_circuit"] = circuit.snapshot()
            result[key] = payload
        return result

    def circuit_snapshot(self) -> dict[str, Any]:
        return {
            key: circuit.snapshot()
            for key, circuit in sorted(self._circuits.items())
        }

    async def _admit(
        self,
        rule: RateLimitRule,
        request: HistoricalRequest,
        *,
        consume: bool,
    ) -> RateLimitAdmission:
        bucket = self._bucket_for(rule)
        cost = min(rule.request_cost(request), bucket.capacity)
        async with bucket.lock:
            now = time.monotonic()
            now_ms = int(time.time() * 1000)
            bucket.refill(now)
            circuit_key = self._circuit_key_for_bucket(rule.bucket_key)
            circuit = self._circuits.get(circuit_key)
            if circuit is not None and now < circuit.cooldown_until:
                wait_seconds = max(0.001, circuit.cooldown_until - now)
                return self._deferred_admission(
                    rule,
                    bucket,
                    cost=cost,
                    reason="circuit_open",
                    wait_seconds=wait_seconds,
                    now=now,
                    now_ms=now_ms,
                    circuit=circuit,
                )
            if circuit is not None and circuit.recovery_pending:
                # A long IP ban refills every token bucket while no traffic is
                # flowing.  Reset the exchange pools once at recovery so the
                # first post-ban tick cannot unleash a full-capacity burst.
                circuit.recovery_pending = False
                for key, candidate in self._buckets.items():
                    if self._circuit_key_for_bucket(key) == circuit_key:
                        candidate.tokens = 0.0
                        candidate.updated_at = now
                        candidate.circuit_generation = circuit.generation
                bucket.refill(now)
            if now < bucket.cooldown_until:
                wait_seconds = max(0.001, bucket.cooldown_until - now)
                return self._deferred_admission(
                    rule,
                    bucket,
                    cost=cost,
                    reason="cooldown",
                    wait_seconds=wait_seconds,
                    now=now,
                    now_ms=now_ms,
                    circuit=circuit,
                )
            self._expire_probe_lease(bucket, now=now)
            if now < bucket.probe_lease_until:
                # A consuming cold-start/429 probe owns the matching bucket
                # until its physical response is accounted.  Recheck quickly
                # so waiters resume soon after ``record_response`` releases
                # the lease instead of sleeping for its full fail-safe bound.
                wait_seconds = min(
                    max(0.001, bucket.probe_lease_until - now),
                    0.05,
                )
                return self._deferred_admission(
                    rule,
                    bucket,
                    cost=cost,
                    reason="probe_in_flight",
                    wait_seconds=wait_seconds,
                    now=now,
                    now_ms=now_ms,
                    circuit=circuit,
                )
            if bucket.cold_start_probe_pending or bucket.recovery_probe_pending:
                # ``inspect`` may observe that the recovery probe is ready,
                # but only a consuming admission owns it.  Re-capping on each
                # inspection prevents observers from refilling the bucket and
                # turning one safe probe into either a process-restart burst
                # or a post-cooldown burst.
                bucket.tokens = min(bucket.tokens, float(cost))
                bucket.updated_at = now
            if bucket.tokens < cost:
                wait_seconds = (
                    max(0.001, (cost - bucket.tokens) / bucket.refill_per_second)
                    if bucket.refill_per_second > 0
                    else 1.0
                )
                return self._deferred_admission(
                    rule,
                    bucket,
                    cost=cost,
                    reason="budget",
                    wait_seconds=wait_seconds,
                    now=now,
                    now_ms=now_ms,
                    circuit=circuit,
                )
            if consume:
                bucket.tokens -= cost
                bucket.last_cost = cost
                bucket.last_wait_seconds = 0.0
                if bucket.cold_start_probe_pending or bucket.recovery_probe_pending:
                    is_recovery_probe = bucket.recovery_probe_pending
                    bucket.cold_start_probe_pending = False
                    bucket.recovery_probe_pending = False
                    bucket.probe_kind = (
                        "recovery" if is_recovery_probe else "cold_start"
                    )
                    bucket.probe_lease_until = now + self._probe_lease_seconds
                    bucket.probe_started_at_ms = now_ms
                    bucket.probe_owner_task = self._current_task()
                if bucket.probe_kind == "recovery":
                    bucket.last_recovery_probe_at_ms = now_ms
            return RateLimitAdmission(
                allowed=True,
                bucket_key=rule.bucket_key,
                cost=cost,
                reason=None,
                retry_after_seconds=0.0,
                retry_at_monotonic=None,
                retry_at_ms=None,
                rule_name=rule.name,
                status_code=bucket.last_status_code,
                body_code=bucket.last_body_code,
                circuit_key=(circuit.key if circuit is not None else None),
            )

    @staticmethod
    def _current_task() -> asyncio.Task[Any] | None:
        try:
            return asyncio.current_task()
        except RuntimeError:
            return None

    @staticmethod
    def _clear_probe_lease(
        bucket: _Bucket,
        *,
        now: float,
        reason: str,
        safe_ramp: bool,
    ) -> None:
        if bucket.probe_lease_until <= 0:
            return
        if safe_ramp:
            # With no authoritative exchange response, assume no remaining
            # budget.  This releases the exclusive lease without turning an
            # ambiguous network failure into a burst.
            bucket.tokens = 0.0
            bucket.updated_at = now
        bucket.probe_kind = None
        bucket.probe_lease_until = 0.0
        bucket.probe_owner_task = None
        bucket.last_probe_release_at_ms = int(time.time() * 1000)
        bucket.last_probe_release_reason = reason

    def _expire_probe_lease(self, bucket: _Bucket, *, now: float) -> None:
        if bucket.probe_lease_until <= 0 or now < bucket.probe_lease_until:
            return
        self._clear_probe_lease(
            bucket,
            now=now,
            reason="lease_expired",
            safe_ramp=True,
        )

    def _release_probe_for_response(
        self,
        bucket: _Bucket,
        *,
        now: float,
        response_is_rate_limited: bool,
        response_is_unknown: bool,
    ) -> None:
        self._expire_probe_lease(bucket, now=now)
        if bucket.probe_lease_until <= 0:
            return
        owner = bucket.probe_owner_task
        current = self._current_task()
        if not response_is_rate_limited and owner is not None and current is not owner:
            # A response from a request admitted before the 429 must not
            # release the new recovery probe's lease.  A fresh rate-limit
            # warning is authoritative for the whole matching bucket and may
            # supersede the lease regardless of which request observed it.
            return
        self._clear_probe_lease(
            bucket,
            now=now,
            reason=("unknown_response" if response_is_unknown else "response"),
            safe_ramp=response_is_unknown,
        )

    @staticmethod
    def _deferred_admission(
        rule: RateLimitRule,
        bucket: _Bucket,
        *,
        cost: int,
        reason: str,
        wait_seconds: float,
        now: float,
        now_ms: int,
        circuit: _Circuit | None,
    ) -> RateLimitAdmission:
        return RateLimitAdmission(
            allowed=False,
            bucket_key=rule.bucket_key,
            cost=cost,
            reason=reason,
            retry_after_seconds=wait_seconds,
            retry_at_monotonic=now + wait_seconds,
            retry_at_ms=now_ms + max(1, int(wait_seconds * 1000)),
            rule_name=rule.name,
            status_code=(
                circuit.last_status_code
                if circuit is not None and reason == "circuit_open"
                else bucket.last_status_code
            ),
            body_code=(
                circuit.last_body_code
                if circuit is not None and reason == "circuit_open"
                else bucket.last_body_code
            ),
            circuit_key=(circuit.key if circuit is not None else None),
        )

    def _record_global_circuit(
        self,
        rule: RateLimitRule,
        *,
        seconds: float,
        status_code: int | None,
        body_code: str | None,
        headers: Mapping[str, str],
    ) -> bool:
        key = self._circuit_key_for_bucket(rule.bucket_key)
        circuit = self._circuits.setdefault(key, _Circuit(key=key))
        circuit.last_status_code = status_code
        circuit.last_body_code = body_code
        circuit.last_headers = _rate_limit_headers(headers)
        cooldown_until = time.monotonic() + max(0.0, seconds)
        if cooldown_until <= circuit.cooldown_until:
            return False
        circuit.cooldown_until = cooldown_until
        circuit.opened_at_ms = int(time.time() * 1000)
        circuit.generation += 1
        circuit.recovery_pending = True
        return True

    @staticmethod
    def _circuit_key_for_bucket(bucket_key: str) -> str:
        exchange = str(bucket_key or "unknown").split(":", 1)[0]
        return f"{exchange}:ip"

    def _bucket_for(self, rule: RateLimitRule) -> _Bucket:
        bucket = self._buckets.get(rule.bucket_key)
        if bucket is not None:
            return bucket

        capacity = max(1, int(rule.capacity))
        interval = max(0.001, float(rule.refill_interval_seconds))
        now = time.monotonic()
        refill_per_second = capacity / interval
        circuit = self._circuits.get(self._circuit_key_for_bucket(rule.bucket_key))
        initial_tokens = float(capacity)
        circuit_generation = 0
        if circuit is not None and circuit.generation > 0:
            # A bucket first touched after an IP-wide ban must not bypass the
            # recovery ramp by materializing at full capacity. Give it only
            # the quota that could conservatively have refilled since the
            # circuit deadline; while the circuit is open this is exactly 0.
            recovered_for = max(0.0, now - circuit.cooldown_until)
            initial_tokens = min(
                float(capacity),
                recovered_for * refill_per_second,
            )
            circuit_generation = circuit.generation
        bucket = _Bucket(
            key=rule.bucket_key,
            rule_name=rule.name,
            algorithm=rule.algorithm,
            refill_interval_seconds=interval,
            max_concurrency=rule.max_concurrency,
            capacity=capacity,
            refill_per_second=refill_per_second,
            tokens=initial_tokens,
            updated_at=now,
            cold_start_probe_pending=self._conservative_cold_start,
            circuit_generation=circuit_generation,
        )
        self._buckets[rule.bucket_key] = bucket
        return bucket


_LOOP_RATE_LIMIT_MANAGERS: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop,
    RateLimitManager,
] = weakref.WeakKeyDictionary()
_LOOP_RATE_LIMIT_SEMAPHORES: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop,
    dict[tuple[str, int], asyncio.Semaphore],
] = weakref.WeakKeyDictionary()


def get_shared_rate_limit_manager() -> RateLimitManager:
    """Return quota state shared by components in the current runtime loop."""

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return RateLimitManager()
    manager = _LOOP_RATE_LIMIT_MANAGERS.get(loop)
    if manager is None:
        # A new process/event loop has no knowledge of an exchange-side ban or
        # the current accounting window.  Let the first contender spend only
        # its own request cost, then ramp normally from zero instead of
        # materializing every shared bucket at full capacity.
        manager = RateLimitManager(conservative_cold_start=True)
        _LOOP_RATE_LIMIT_MANAGERS[loop] = manager
    return manager


def get_shared_rate_limit_semaphore(
    rule: RateLimitRule,
    *,
    fallback: int = 1,
) -> asyncio.Semaphore:
    """Return the runtime-loop concurrency gate for one quota bucket."""

    limit = max(1, int(rule.max_concurrency or fallback))
    key = (rule.bucket_key, limit)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.Semaphore(limit)
    semaphores = _LOOP_RATE_LIMIT_SEMAPHORES.setdefault(loop, {})
    semaphore = semaphores.get(key)
    if semaphore is None:
        semaphore = asyncio.Semaphore(limit)
        semaphores[key] = semaphore
    return semaphore


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
    if status_code in {418, 429} or body_code in {"-1003", "50011"}:
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
