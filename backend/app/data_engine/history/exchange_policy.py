"""Resolve exchange capabilities and symbol lifecycle into history policy.

This module is intentionally the only bridge from the generic history package
to exchange plugins.  Query, repair and API layers consume the same resolved
context instead of reimplementing retention/listing rules independently.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Callable

from app.data_engine.history.calendar import TradingCalendar
from app.data_engine.history.models import (
    BoundaryReason,
    HistoryAvailability,
    HistoryPlan,
    HistoryRequest,
    HistorySeriesKey,
    TimeBound,
)
from app.data_engine.history.service import HistoryAvailabilityService
from app.data_engine.market_data.models import MarketChannel
from app.exchanges import (
    HistoryAvailabilityPolicy,
    HistoryEmptyPageSemantics,
    bootstrap_default_adapters,
    get_exchange_registry,
)


SymbolMetadataLookup = Callable[[str, str, str], dict[str, Any] | None]


@dataclass(frozen=True, slots=True)
class ResolvedHistoryContext:
    """All static and learned inputs for one historical series."""

    availability: HistoryAvailability
    calendar: TradingCalendar | None
    policy: HistoryAvailabilityPolicy | None
    empty_page_semantics: HistoryEmptyPageSemantics

    @property
    def revision(self) -> str:
        return self.availability.revision


class ExchangeHistoryPolicyResolver:
    """Build a history context from the admitted exchange capability schema."""

    def __init__(
        self,
        service: HistoryAvailabilityService,
        *,
        symbol_lookup: SymbolMetadataLookup | None = None,
    ) -> None:
        self.service = service
        self._symbol_lookup = symbol_lookup

    @staticmethod
    def series_key(
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        channel: MarketChannel | str = MarketChannel.KLINE,
        variant: str = "",
        params: dict[str, Any] | None = None,
    ) -> HistorySeriesKey:
        channel_value = getattr(channel, "value", channel)
        return HistorySeriesKey.from_params(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            channel=str(channel_value),
            variant=variant,
            params=params,
        )

    def resolve(self, key: HistorySeriesKey) -> ResolvedHistoryContext:
        bootstrap_default_adapters()
        registry = get_exchange_registry()
        capabilities = registry.get_capabilities(key.exchange)
        channel = capabilities.channel_capability(key.channel, key.market_type)
        policy = channel.history_policy if channel is not None and channel.history else None
        market = next(
            (
                item
                for item in capabilities.markets
                if str(item.market_type).strip().lower() == key.market_type
            ),
            None,
        )

        metadata = self._lookup_symbol(key)
        calendar_id = (
            getattr(policy, "calendar_id", None)
            or getattr(market, "calendar_id", None)
        )
        revision = self._revision(
            capabilities=capabilities,
            policy=policy,
            market=market,
            metadata=metadata,
        )

        listed_at = self._timestamp(metadata, "continuousTradingAtMs")
        if listed_at is None:
            listed_at = self._timestamp(metadata, "listedAtMs")
        ended_at_candidates = tuple(
            value
            for value in (
                self._timestamp(metadata, "delistedAtMs"),
                self._timestamp(metadata, "expiryAtMs"),
            )
            if value is not None
        )
        ended_at = min(ended_at_candidates) if ended_at_candidates else None

        base = HistoryAvailability(
            data_start=(
                TimeBound(listed_at, BoundaryReason.LISTING, revision=revision)
                if listed_at is not None
                else None
            ),
            data_end=(
                TimeBound(ended_at, BoundaryReason.DELISTING, revision=revision)
                if ended_at is not None
                else None
            ),
            upstream_start=(
                TimeBound(
                    policy.available_from_ms,
                    BoundaryReason.UPSTREAM_START,
                    revision=revision,
                )
                if policy is not None and policy.available_from_ms is not None
                else None
            ),
            upstream_end=(
                TimeBound(
                    policy.available_to_ms,
                    BoundaryReason.UPSTREAM_END,
                    revision=revision,
                )
                if policy is not None and policy.available_to_ms is not None
                else None
            ),
            rolling_retention_ms=(policy.max_age_ms if policy is not None else None),
            calendar_id=calendar_id,
            revision=revision,
        )
        availability = self.service.resolve_availability(key, base)
        calendar = self.service.calendars.get(calendar_id)
        semantics = (
            policy.empty_page_semantics
            if policy is not None
            else HistoryEmptyPageSemantics.UNKNOWN
        )
        return ResolvedHistoryContext(
            availability=availability,
            calendar=calendar,
            policy=policy,
            empty_page_semantics=semantics,
        )

    def plan(
        self,
        request: HistoryRequest,
        *,
        now_ms: int | None = None,
    ) -> tuple[HistoryPlan, ResolvedHistoryContext]:
        context = self.resolve(request.series)
        plan = self.service.plan(
            request,
            context.availability,
            now_ms=now_ms,
            calendar_id=context.availability.calendar_id,
        )
        return plan, context

    def calendar_for(self, key: HistorySeriesKey) -> TradingCalendar | None:
        return self.resolve(key).calendar

    def _lookup_symbol(self, key: HistorySeriesKey) -> dict[str, Any] | None:
        lookup = self._symbol_lookup
        if lookup is None:
            # Kept lazy to avoid making the lower-level history package import
            # FastAPI route modules during normal module discovery.
            from app.api.v1.symbols import get_cached_symbol_metadata

            lookup = get_cached_symbol_metadata
        return lookup(key.exchange, key.market_type, key.symbol)

    @staticmethod
    def _timestamp(metadata: dict[str, Any] | None, key: str) -> int | None:
        if metadata is None:
            return None
        value = metadata.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return None
        return value

    @staticmethod
    def _revision(
        *,
        capabilities: Any,
        policy: HistoryAvailabilityPolicy | None,
        market: Any,
        metadata: dict[str, Any] | None,
    ) -> str:
        lifecycle_keys = (
            "listedAtMs",
            "continuousTradingAtMs",
            "delistedAtMs",
            "expiryAtMs",
        )
        payload = {
            "schema": getattr(capabilities, "capability_schema_version", 1),
            "plugin_api": getattr(capabilities, "plugin_api_version", "1.0"),
            "policy": policy.to_dict() if policy is not None else None,
            "market": {
                "calendar_id": getattr(market, "calendar_id", None),
                "timezone": getattr(market, "timezone", None),
            },
            "lifecycle": {
                key: metadata.get(key)
                for key in lifecycle_keys
                if metadata is not None and metadata.get(key) is not None
            },
        }
        encoded = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            default=str,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:24]
