"""Exchange-aware native/derived interval resolution.

Timeline semantics belong to :mod:`app.data_engine.interval_policy`.  This
module adds the orthogonal question of whether one exchange/market/purpose can
request that semantic interval natively, or which supported native interval
can reconstruct it exactly.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from app.data_engine.interval_policy import (
    IntervalSpec,
    interval_tiles,
    intervals_equivalent,
    parse_interval_spec,
)
from app.data_engine.market_data.models import MarketChannel
from app.exchanges import bootstrap_default_adapters, get_exchange_registry


class IntervalPurpose(str, Enum):
    HISTORY = "history"
    REALTIME = "realtime"


class IntervalRouteKind(str, Enum):
    NATIVE = "native"
    DERIVED = "derived"


class IntervalResolutionErrorCode(str, Enum):
    INVALID_INTERVAL = "invalid_interval"
    UNKNOWN_EXCHANGE = "unknown_exchange"
    KLINE_CHANNEL_UNAVAILABLE = "kline_channel_unavailable"
    PURPOSE_UNSUPPORTED = "purpose_unsupported"
    NO_NATIVE_INTERVALS = "no_native_intervals"
    NO_EXACT_BASE = "no_exact_base"


class IntervalResolutionError(ValueError):
    """Typed, fail-closed interval resolution failure."""

    def __init__(
        self,
        code: IntervalResolutionErrorCode,
        message: str,
        *,
        exchange: str,
        market_type: str,
        interval: str,
        purpose: IntervalPurpose,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.exchange = exchange
        self.market_type = market_type
        self.interval = interval
        self.purpose = purpose

    def to_dict(self) -> dict[str, str]:
        return {
            "code": self.code.value,
            "message": str(self),
            "exchange": self.exchange,
            "market_type": self.market_type,
            "interval": self.interval,
            "purpose": self.purpose.value,
        }


@dataclass(frozen=True, slots=True)
class IntervalRoute:
    exchange: str
    market_type: str
    requested_interval: str
    canonical_interval: str
    purpose: IntervalPurpose
    kind: IntervalRouteKind
    spec: IntervalSpec
    native_interval: str | None = None
    base_interval: str | None = None

    @property
    def source_interval(self) -> str:
        source = (
            self.native_interval
            if self.kind is IntervalRouteKind.NATIVE
            else self.base_interval
        )
        if source is None:  # guarded by IntervalResolver construction
            raise RuntimeError("resolved interval route has no source interval")
        return source

    @property
    def is_native(self) -> bool:
        return self.kind is IntervalRouteKind.NATIVE


class CapabilityRegistry(Protocol):
    def get_capabilities(self, exchange: str) -> Any: ...


class IntervalResolver:
    """Resolve a semantic interval against one exchange capability document."""

    def __init__(self, registry: CapabilityRegistry | None = None) -> None:
        self._registry = registry

    def resolve(
        self,
        *,
        exchange: str,
        market_type: str,
        interval: str,
        purpose: IntervalPurpose | str,
    ) -> IntervalRoute:
        normalized_exchange = str(exchange or "").strip().lower()
        normalized_market = str(market_type or "").strip().lower()
        requested_interval = str(interval or "").strip()
        normalized_purpose = (
            purpose
            if isinstance(purpose, IntervalPurpose)
            else IntervalPurpose(str(purpose).strip().lower())
        )
        spec = parse_interval_spec(requested_interval)
        if spec is None:
            raise self._error(
                IntervalResolutionErrorCode.INVALID_INTERVAL,
                f"Invalid interval: {requested_interval!r}",
                exchange=normalized_exchange,
                market_type=normalized_market,
                interval=requested_interval,
                purpose=normalized_purpose,
            )

        capabilities = self._get_capabilities(
            normalized_exchange,
            market_type=normalized_market,
            interval=requested_interval,
            purpose=normalized_purpose,
        )
        native_intervals = self._native_intervals(
            capabilities,
            exchange=normalized_exchange,
            market_type=normalized_market,
            interval=requested_interval,
            purpose=normalized_purpose,
        )

        for native_interval in native_intervals:
            if intervals_equivalent(requested_interval, native_interval):
                return IntervalRoute(
                    exchange=normalized_exchange,
                    market_type=normalized_market,
                    requested_interval=requested_interval,
                    canonical_interval=spec.canonical,
                    purpose=normalized_purpose,
                    kind=IntervalRouteKind.NATIVE,
                    spec=spec,
                    native_interval=native_interval,
                )

        best_base: tuple[str, IntervalSpec] | None = None
        for native_interval in native_intervals:
            native_spec = parse_interval_spec(native_interval)
            if (
                native_spec is None
                or native_spec.nominal_ms >= spec.nominal_ms
                or not interval_tiles(native_spec, spec)
            ):
                continue
            if best_base is None or native_spec.nominal_ms > best_base[1].nominal_ms:
                best_base = (native_interval, native_spec)

        if best_base is None:
            raise self._error(
                IntervalResolutionErrorCode.NO_EXACT_BASE,
                (
                    f"No supported native K-line interval can exactly reconstruct "
                    f"{requested_interval!r} for {normalized_exchange}/{normalized_market} "
                    f"{normalized_purpose.value}"
                ),
                exchange=normalized_exchange,
                market_type=normalized_market,
                interval=requested_interval,
                purpose=normalized_purpose,
            )

        return IntervalRoute(
            exchange=normalized_exchange,
            market_type=normalized_market,
            requested_interval=requested_interval,
            canonical_interval=spec.canonical,
            purpose=normalized_purpose,
            kind=IntervalRouteKind.DERIVED,
            spec=spec,
            base_interval=best_base[0],
        )

    def _get_capabilities(
        self,
        exchange: str,
        *,
        market_type: str,
        interval: str,
        purpose: IntervalPurpose,
    ) -> Any:
        registry = self._registry
        if registry is None:
            bootstrap_default_adapters()
            registry = get_exchange_registry()
        try:
            return registry.get_capabilities(exchange)
        except KeyError as exc:
            raise self._error(
                IntervalResolutionErrorCode.UNKNOWN_EXCHANGE,
                f"Unknown exchange: {exchange!r}",
                exchange=exchange,
                market_type=market_type,
                interval=interval,
                purpose=purpose,
            ) from exc

    def _native_intervals(
        self,
        capabilities: Any,
        *,
        exchange: str,
        market_type: str,
        interval: str,
        purpose: IntervalPurpose,
    ) -> tuple[str, ...]:
        schema_version = int(getattr(capabilities, "capability_schema_version", 1))
        capability_market = {
            "swap": "futures",
            "perpetual": "futures",
        }.get(market_type, market_type)
        channel_resolver = getattr(capabilities, "channel_capability", None)
        channel = (
            channel_resolver(MarketChannel.KLINE, capability_market)
            if callable(channel_resolver)
            else None
        )
        if schema_version >= 2:
            if channel is None:
                raise self._error(
                    IntervalResolutionErrorCode.KLINE_CHANNEL_UNAVAILABLE,
                    f"K-line channel is unavailable for market {market_type!r}",
                    exchange=exchange,
                    market_type=market_type,
                    interval=interval,
                    purpose=purpose,
                )
            supported = (
                bool(channel.history)
                if purpose is IntervalPurpose.HISTORY
                else bool(channel.realtime)
            )
            if not supported:
                raise self._error(
                    IntervalResolutionErrorCode.PURPOSE_UNSUPPORTED,
                    f"K-line {purpose.value} is unavailable for market {market_type!r}",
                    exchange=exchange,
                    market_type=market_type,
                    interval=interval,
                    purpose=purpose,
                )

        interval_resolver = getattr(capabilities, "kline_intervals", None)
        if callable(interval_resolver):
            values = interval_resolver(
                capability_market,
                history=purpose is IntervalPurpose.HISTORY,
            )
        elif schema_version <= 1:
            values = getattr(capabilities, "native_intervals", ()) or ()
        else:
            values = ()
        intervals = _unique_interval_strings(values)
        if not intervals:
            raise self._error(
                IntervalResolutionErrorCode.NO_NATIVE_INTERVALS,
                f"No native K-line intervals declared for market {market_type!r}",
                exchange=exchange,
                market_type=market_type,
                interval=interval,
                purpose=purpose,
            )
        return intervals

    @staticmethod
    def _error(
        code: IntervalResolutionErrorCode,
        message: str,
        *,
        exchange: str,
        market_type: str,
        interval: str,
        purpose: IntervalPurpose,
    ) -> IntervalResolutionError:
        return IntervalResolutionError(
            code,
            message,
            exchange=exchange,
            market_type=market_type,
            interval=interval,
            purpose=purpose,
        )


def _unique_interval_strings(values: Any) -> tuple[str, ...]:
    if isinstance(values, str):
        values = (values,)
    try:
        iterator = iter(values)
    except TypeError:
        return ()
    result: list[str] = []
    seen: set[str] = set()
    for raw in iterator:
        value = str(raw or "").strip()
        if not value or value in seen or parse_interval_spec(value) is None:
            continue
        seen.add(value)
        result.append(value)
    return tuple(result)


__all__ = [
    "IntervalPurpose",
    "IntervalResolutionError",
    "IntervalResolutionErrorCode",
    "IntervalResolver",
    "IntervalRoute",
    "IntervalRouteKind",
]
