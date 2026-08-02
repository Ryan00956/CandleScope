"""Pure, deterministic display-bar construction from revealed base bars.

The builder is intentionally a replay reducer: it owns only immutable input
fixtures and its own bounded state.  It never reads beyond the caller-provided
base-bar prefix and never fabricates missing BAR-source intervals.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from decimal import Decimal
from enum import Enum
from typing import Iterable, Mapping

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
    parse_monthly_count,
)

from ..canonical import canonical_sha256
from ..dataset import ReplayBar
from ..errors import ReplayDomainError, ReplayErrorCode
from ..market_halts import ReplayBarHalt
from ..models import normalize_decimal_string, validate_timestamp_ms
from .schedule import ReplayBarSchedule


BAR_BUILDER_STATE_SCHEMA_VERSION = "replay-bar-builder-state.v1"
BAR_BUILDER_STATE_HASH_SCHEMA_VERSION = "replay-bar-builder-state-hash.v1"
BAR_BUILDER_CLOSED_CHAIN_SCHEMA_VERSION = "replay-bar-builder-closed-chain.v1"
BAR_BUILDER_WARMUP_SCHEMA_VERSION = "replay-bar-builder-warmup.v1"

BAR_GAP_POLICY = "reject"
BAR_SYNTHETIC_POLICY = "reject"
TRADE_SYNTHETIC_POLICY = "previous_close_zero_volume"
AGG_TRADE_SYNTHETIC_SOURCE = "agg_trade_synthetic"

_DAY_MS = 86_400_000
_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


class BarProjectionAction(str, Enum):
    """The only incremental operations needed by a chart series."""

    APPEND = "append"
    TICK = "tick"


@dataclass(frozen=True, slots=True)
class BarBuilderCapability:
    enabled: bool
    reason: str | None
    base_interval: str
    display_interval: str
    base_interval_ms: int | None
    display_interval_ms: int | None
    expected_components: int | None
    calendar_aware: bool
    gap_policy: str = BAR_GAP_POLICY
    synthetic_policy: str = BAR_SYNTHETIC_POLICY

    def to_dict(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "reason": self.reason,
            "base_interval": self.base_interval,
            "display_interval": self.display_interval,
            "base_interval_ms": self.base_interval_ms,
            "display_interval_ms": self.display_interval_ms,
            "expected_components": self.expected_components,
            "calendar_aware": self.calendar_aware,
            "gap_policy": self.gap_policy,
            "synthetic_policy": self.synthetic_policy,
        }


@dataclass(frozen=True, slots=True)
class ReplayDisplayBar:
    """One exact display bucket derived solely from closed base bars."""

    open_time_ms: int
    close_time_ms: int
    open: str
    high: str
    low: str
    close: str
    volume: str
    quote_volume: str | None
    trades: int | None
    taker_buy_base: str | None
    taker_buy_quote: str | None
    first_base_open_ms: int
    last_base_open_ms: int
    component_count: int
    expected_components: int
    is_closed: bool
    synthetic: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "open_time_ms": self.open_time_ms,
            "close_time_ms": self.close_time_ms,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "quote_volume": self.quote_volume,
            "trades": self.trades,
            "taker_buy_base": self.taker_buy_base,
            "taker_buy_quote": self.taker_buy_quote,
            "first_base_open_ms": self.first_base_open_ms,
            "last_base_open_ms": self.last_base_open_ms,
            "component_count": self.component_count,
            "expected_components": self.expected_components,
            "is_closed": self.is_closed,
            "synthetic": self.synthetic,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayDisplayBar":
        expected_keys = {
            "open_time_ms",
            "close_time_ms",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "quote_volume",
            "trades",
            "taker_buy_base",
            "taker_buy_quote",
            "first_base_open_ms",
            "last_base_open_ms",
            "component_count",
            "expected_components",
            "is_closed",
            "synthetic",
        }
        if set(payload) != expected_keys:
            raise ValueError("display bar fields do not match the state schema")
        return cls(
            open_time_ms=_strict_int(payload["open_time_ms"], "open_time_ms"),
            close_time_ms=_strict_int(payload["close_time_ms"], "close_time_ms"),
            open=_strict_string(payload["open"], "open"),
            high=_strict_string(payload["high"], "high"),
            low=_strict_string(payload["low"], "low"),
            close=_strict_string(payload["close"], "close"),
            volume=_strict_string(payload["volume"], "volume"),
            quote_volume=_optional_string(payload["quote_volume"], "quote_volume"),
            trades=_optional_int(payload["trades"], "trades"),
            taker_buy_base=_optional_string(
                payload["taker_buy_base"], "taker_buy_base"
            ),
            taker_buy_quote=_optional_string(
                payload["taker_buy_quote"], "taker_buy_quote"
            ),
            first_base_open_ms=_strict_int(
                payload["first_base_open_ms"], "first_base_open_ms"
            ),
            last_base_open_ms=_strict_int(
                payload["last_base_open_ms"], "last_base_open_ms"
            ),
            component_count=_strict_int(payload["component_count"], "component_count"),
            expected_components=_strict_int(
                payload["expected_components"], "expected_components"
            ),
            is_closed=_strict_bool(payload["is_closed"], "is_closed"),
            synthetic=_strict_bool(payload["synthetic"], "synthetic"),
        )


@dataclass(frozen=True, slots=True)
class BarBuilderUpdate:
    action: BarProjectionAction
    bar: ReplayDisplayBar
    source_sequence: int
    base_open_time_ms: int
    gap_policy: str = BAR_GAP_POLICY
    synthetic_policy: str = BAR_SYNTHETIC_POLICY

    def to_dict(self) -> dict[str, object]:
        return {
            "action": self.action.value,
            "bar": self.bar.to_dict(),
            "source_sequence": self.source_sequence,
            "base_open_time_ms": self.base_open_time_ms,
            "gap_policy": self.gap_policy,
            "synthetic_policy": self.synthetic_policy,
        }


def assess_bar_builder_capability(
    base_interval: str,
    display_interval: str,
) -> BarBuilderCapability:
    """Return an explicit fail-closed exact-tiling decision."""

    base_ms = parse_interval_ms(base_interval)
    display_ms = parse_interval_ms(display_interval)
    if base_ms is None or base_ms <= 0:
        return _disabled_capability(
            base_interval,
            display_interval,
            base_ms,
            display_ms,
            "INVALID_BASE_INTERVAL",
        )
    if display_ms is None or display_ms <= 0:
        return _disabled_capability(
            base_interval,
            display_interval,
            base_ms,
            display_ms,
            "INVALID_DISPLAY_INTERVAL",
        )

    base_months = parse_monthly_count(base_interval)
    display_months = parse_monthly_count(display_interval)
    calendar_aware = base_months is not None or display_months is not None

    if base_interval == display_interval:
        return BarBuilderCapability(
            True,
            None,
            base_interval,
            display_interval,
            base_ms,
            display_ms,
            1,
            calendar_aware,
        )

    if base_months is not None:
        if display_months is None:
            return _disabled_capability(
                base_interval,
                display_interval,
                base_ms,
                display_ms,
                "CALENDAR_BUCKET_NOT_EXACT",
            )
        if display_months < base_months:
            reason = "DISPLAY_SHORTER_THAN_BASE"
        elif display_months % base_months:
            reason = "DISPLAY_NOT_DIVISIBLE_BY_BASE"
        else:
            return BarBuilderCapability(
                True,
                None,
                base_interval,
                display_interval,
                base_ms,
                display_ms,
                display_months // base_months,
                True,
            )
        return _disabled_capability(
            base_interval,
            display_interval,
            base_ms,
            display_ms,
            reason,
        )

    if display_months is not None:
        if _DAY_MS % base_ms:
            return _disabled_capability(
                base_interval,
                display_interval,
                base_ms,
                display_ms,
                "CALENDAR_BUCKET_NOT_EXACT",
            )
        # Every UTC month boundary must also be a base boundary.
        month_anchor_ms = 1_704_067_200_000  # 2024-01-01T00:00:00Z
        if (
            compute_bucket_start_ms(
                month_anchor_ms,
                base_ms,
                interval=base_interval,
            )
            != month_anchor_ms
        ):
            return _disabled_capability(
                base_interval,
                display_interval,
                base_ms,
                display_ms,
                "CALENDAR_BUCKET_NOT_EXACT",
            )
        return BarBuilderCapability(
            True,
            None,
            base_interval,
            display_interval,
            base_ms,
            display_ms,
            None,
            True,
        )

    if display_ms < base_ms:
        return _disabled_capability(
            base_interval,
            display_interval,
            base_ms,
            display_ms,
            "DISPLAY_SHORTER_THAN_BASE",
        )
    if display_ms % base_ms:
        return _disabled_capability(
            base_interval,
            display_interval,
            base_ms,
            display_ms,
            "DISPLAY_NOT_DIVISIBLE_BY_BASE",
        )

    alignment_anchor_ms = 1_704_067_200_000
    target_open_ms = compute_bucket_start_ms(
        alignment_anchor_ms,
        display_ms,
        interval=display_interval,
    )
    if (
        compute_bucket_start_ms(
            target_open_ms,
            base_ms,
            interval=base_interval,
        )
        != target_open_ms
    ):
        return _disabled_capability(
            base_interval,
            display_interval,
            base_ms,
            display_ms,
            "BUCKET_ALIGNMENT_NOT_EXACT",
        )
    return BarBuilderCapability(
        True,
        None,
        base_interval,
        display_interval,
        base_ms,
        display_ms,
        display_ms // base_ms,
        False,
    )


class ReplayBarBuilder:
    """Build closed and forming display bars from one base bar at a time."""

    def __init__(
        self,
        *,
        base_interval: str,
        display_interval: str,
        replay_start_ms: int,
        warmup_bars: Iterable[ReplayBar] = (),
        max_closed_bars: int = 2_048,
        synthetic_policy: str = BAR_SYNTHETIC_POLICY,
        verified_halts: Iterable[ReplayBarHalt] = (),
    ) -> None:
        self._capability = assess_bar_builder_capability(
            base_interval,
            display_interval,
        )
        if not self._capability.enabled:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "base/display interval pair cannot be reconstructed exactly",
                details={"reason": self._capability.reason},
            )
        if synthetic_policy not in {
            BAR_SYNTHETIC_POLICY,
            TRADE_SYNTHETIC_POLICY,
        }:
            raise ValueError("synthetic_policy is unsupported")
        self._verified_halts = tuple(verified_halts)
        self._schedule = ReplayBarSchedule(base_interval, self._verified_halts)
        self._gap_policy = self._schedule.gap_policy
        self._synthetic_policy = synthetic_policy
        self._capability = replace(
            self._capability,
            gap_policy=self._gap_policy,
            synthetic_policy=self._synthetic_policy,
        )
        self._base_interval = base_interval
        self._display_interval = display_interval
        self._base_interval_ms = int(self._capability.base_interval_ms or 0)
        self._display_interval_ms = int(self._capability.display_interval_ms or 0)
        try:
            self._replay_start_ms = validate_timestamp_ms(
                replay_start_ms,
                field_name="replay_start_ms",
            )
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay start timestamp is invalid",
            ) from exc
        if (
            compute_bucket_start_ms(
                self._replay_start_ms,
                self._base_interval_ms,
                interval=self._base_interval,
            )
            != self._replay_start_ms
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay start is not aligned to the base interval",
            )
        if not self._schedule.is_expected_open(self._replay_start_ms):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay start falls inside a verified market halt",
            )
        if isinstance(max_closed_bars, bool) or not isinstance(max_closed_bars, int):
            raise TypeError("max_closed_bars must be an integer")
        if max_closed_bars < 1:
            raise ValueError("max_closed_bars must be positive")
        self._max_closed_bars = max_closed_bars
        self._warmup_bars = tuple(warmup_bars)
        if any(not isinstance(bar, ReplayBar) for bar in self._warmup_bars):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "warmup contains a non-ReplayBar value",
            )
        warmup_fingerprint_payload: dict[str, object] = {
            "schema_version": BAR_BUILDER_WARMUP_SCHEMA_VERSION,
            "base_interval": self._base_interval,
            "replay_start_ms": self._replay_start_ms,
            "bars": [bar.to_dict() for bar in self._warmup_bars],
        }
        if self._verified_halts:
            warmup_fingerprint_payload["bar_schedule_hash"] = self._schedule.fingerprint
        self._warmup_fingerprint = canonical_sha256(warmup_fingerprint_payload)
        self.reset()

    @property
    def capability(self) -> BarBuilderCapability:
        return self._capability

    @property
    def replay_events_applied(self) -> int:
        return self._replay_events_applied

    @property
    def active_bar(self) -> ReplayDisplayBar | None:
        return self._active_bar

    @property
    def closed_bars(self) -> tuple[ReplayDisplayBar, ...]:
        return tuple(self._closed_bars)

    @property
    def closed_count(self) -> int:
        return self._closed_count

    @property
    def state_hash(self) -> str:
        return str(self.snapshot()["state_hash"])

    def apply_bar(self, bar: ReplayBar) -> BarBuilderUpdate:
        update = self._apply_bar(bar, warmup=False)
        if update is None:
            raise RuntimeError("a revealed replay bar must produce a projection update")
        return update

    def apply_source_event(self, event: object) -> Mapping[str, object]:
        if isinstance(event, Mapping) and event.get("is_closed") is False:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "BAR replay source events must already be closed",
            )
        if not isinstance(event, ReplayBar):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR replay source event must be ReplayBar",
            )
        return self.apply_bar(event).to_dict()

    def replace_projection(self) -> dict[str, object]:
        bars = [bar.to_dict() for bar in self._closed_bars]
        if self._active_bar is not None:
            bars.append(self._active_bar.to_dict())
        return {
            "action": "replace",
            "bars": bars,
            "closed_count": self._closed_count,
            "closed_prefix_count": self._closed_prefix_count,
            "replay_events_applied": self._replay_events_applied,
            "gap_policy": self._gap_policy,
            "synthetic_policy": self._synthetic_policy,
        }

    def rebuild_for_display_interval(
        self,
        display_interval: str,
        revealed_replay_bars: Iterable[ReplayBar],
    ) -> "ReplayBarBuilder":
        revealed = tuple(revealed_replay_bars)
        rebuilt = ReplayBarBuilder(
            base_interval=self._base_interval,
            display_interval=display_interval,
            replay_start_ms=self._replay_start_ms,
            warmup_bars=self._warmup_bars,
            max_closed_bars=self._max_closed_bars,
            synthetic_policy=self._synthetic_policy,
            verified_halts=self._verified_halts,
        )
        for bar in revealed:
            rebuilt.apply_bar(bar)
        return rebuilt

    def reset(self) -> None:
        self._active_bar: ReplayDisplayBar | None = None
        self._closed_bars: list[ReplayDisplayBar] = []
        self._closed_count = 0
        self._closed_prefix_count = 0
        self._closed_prefix_hash = self._initial_closed_chain_hash()
        self._closed_chain_hash = self._closed_prefix_hash
        self._last_base_open_ms: int | None = None
        self._replay_events_applied = 0

        for bar in self._warmup_bars:
            self._apply_bar(bar, warmup=True)
        self._validate_warmup_boundary()

    def has_trading_state(self) -> bool:
        return False

    def snapshot(self) -> dict[str, object]:
        payload = self._snapshot_payload()
        payload["state_hash"] = canonical_sha256(
            {
                "schema_version": BAR_BUILDER_STATE_HASH_SCHEMA_VERSION,
                "state": payload,
            }
        )
        return payload

    def restore(self, state: Mapping[str, object]) -> None:
        try:
            candidate = self._decode_state(state)
        except ReplayDomainError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "bar builder checkpoint is malformed",
            ) from exc

        self._active_bar = candidate["active_bar"]
        self._closed_bars = candidate["closed_bars"]
        self._closed_count = candidate["closed_count"]
        self._closed_prefix_count = candidate["closed_prefix_count"]
        self._closed_prefix_hash = candidate["closed_prefix_hash"]
        self._closed_chain_hash = candidate["closed_chain_hash"]
        self._last_base_open_ms = candidate["last_base_open_ms"]
        self._replay_events_applied = candidate["replay_events_applied"]

    def _apply_bar(
        self,
        bar: ReplayBar,
        *,
        warmup: bool,
    ) -> BarBuilderUpdate | None:
        normalized = self._validate_base_bar(bar, warmup=warmup)
        bucket_open_ms = compute_bucket_start_ms(
            bar.open_time_ms,
            self._display_interval_ms,
            interval=self._display_interval,
        )
        bucket_end_ms = compute_bucket_end_ms(
            bucket_open_ms,
            self._display_interval_ms,
            interval=self._display_interval,
        )
        expected_components, expected_first_open_ms, expected_last_open_ms = (
            self._expected_component_bounds(
                bucket_open_ms,
                bucket_end_ms,
            )
        )
        if expected_first_open_ms is None or expected_last_open_ms is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR source event falls inside a fully halted display bucket",
            )

        if self._active_bar is None:
            candidate = ReplayDisplayBar(
                open_time_ms=bucket_open_ms,
                close_time_ms=bucket_end_ms - 1,
                open=normalized["open"],
                high=normalized["high"],
                low=normalized["low"],
                close=normalized["close"],
                volume=normalized["volume"],
                quote_volume=normalized["quote_volume"],
                trades=normalized["trades"],
                taker_buy_base=normalized["taker_buy_base"],
                taker_buy_quote=normalized["taker_buy_quote"],
                first_base_open_ms=bar.open_time_ms,
                last_base_open_ms=bar.open_time_ms,
                component_count=1,
                expected_components=expected_components,
                is_closed=False,
                synthetic=bool(normalized["synthetic"]),
            )
            action = BarProjectionAction.APPEND
        else:
            if self._active_bar.open_time_ms != bucket_open_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "a display bucket ended without all base components",
                )
            candidate = self._accumulate(self._active_bar, bar, normalized)
            action = BarProjectionAction.TICK

        reaches_bucket_end = bar.open_time_ms == expected_last_open_ms
        complete = (
            candidate.first_base_open_ms == expected_first_open_ms
            and candidate.component_count == expected_components
        )
        if candidate.component_count > expected_components:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "display bucket received too many base components",
            )
        if reaches_bucket_end and not complete:
            if not warmup:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "display bucket cannot close from an incomplete prefix",
                )
            self._active_bar = None
            self._last_base_open_ms = bar.open_time_ms
            return None
        if complete != reaches_bucket_end:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "base component count disagrees with display boundary",
            )

        if reaches_bucket_end:
            candidate = ReplayDisplayBar(**{**candidate.to_dict(), "is_closed": True})
            self._active_bar = None
            self._append_closed(candidate)
        else:
            self._active_bar = candidate
        self._last_base_open_ms = bar.open_time_ms

        if warmup:
            return None
        self._replay_events_applied += 1
        return BarBuilderUpdate(
            action=action,
            bar=candidate,
            source_sequence=self._replay_events_applied,
            base_open_time_ms=bar.open_time_ms,
            gap_policy=self._gap_policy,
            synthetic_policy=self._synthetic_policy,
        )

    def _validate_base_bar(
        self,
        bar: ReplayBar,
        *,
        warmup: bool,
    ) -> dict[str, str | int | bool | None]:
        if not isinstance(bar, ReplayBar):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "bar builder input must be ReplayBar",
            )
        try:
            open_time_ms = validate_timestamp_ms(
                bar.open_time_ms,
                field_name="open_time_ms",
            )
            close_time_ms = validate_timestamp_ms(
                bar.close_time_ms,
                field_name="close_time_ms",
            )
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "base bar timestamps are invalid",
            ) from exc

        base_bucket_open_ms = compute_bucket_start_ms(
            open_time_ms,
            self._base_interval_ms,
            interval=self._base_interval,
        )
        if base_bucket_open_ms != open_time_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "base bar open is not interval-aligned",
            )
        expected_close_ms = (
            compute_bucket_end_ms(
                open_time_ms,
                self._base_interval_ms,
                interval=self._base_interval,
            )
            - 1
        )
        if close_time_ms != expected_close_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "base bar must be a fully closed canonical interval",
            )

        if warmup:
            if open_time_ms >= self._replay_start_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "warmup bar cannot reach or cross replay start",
                )
        elif open_time_ms < self._replay_start_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "revealed replay bar precedes replay start",
            )

        expected_open_ms: int | None
        if self._last_base_open_ms is None:
            expected_open_ms = None if warmup else self._replay_start_ms
        else:
            expected_open_ms = self._next_base_open(self._last_base_open_ms)
        if expected_open_ms is not None and open_time_ms != expected_open_ms:
            if open_time_ms < expected_open_ms:
                code = ReplayErrorCode.DATASET_MISMATCH
                message = "base bar is duplicate or out of order"
            else:
                code = ReplayErrorCode.DATA_GAP
                message = "BAR source contains a missing base interval"
            raise ReplayDomainError(
                code,
                message,
                details={
                    "expected_open_ms": expected_open_ms,
                    "actual_open_ms": open_time_ms,
                },
            )

        try:
            normalized_open = _normalized_decimal(bar.open, "open", positive=True)
            normalized_high = _normalized_decimal(bar.high, "high", positive=True)
            normalized_low = _normalized_decimal(bar.low, "low", positive=True)
            normalized_close = _normalized_decimal(
                bar.close,
                "close",
                positive=True,
            )
            normalized_volume = _normalized_decimal(bar.volume, "volume")
            normalized_quote = _normalized_optional_decimal(
                bar.quote_volume,
                "quote_volume",
            )
            normalized_taker_base = _normalized_optional_decimal(
                bar.taker_buy_base,
                "taker_buy_base",
            )
            normalized_taker_quote = _normalized_optional_decimal(
                bar.taker_buy_quote,
                "taker_buy_quote",
            )
            normalized_trades = _validated_optional_counter(bar.trades, "trades")
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "base bar contains malformed numeric fields",
            ) from exc

        open_decimal = Decimal(normalized_open)
        high_decimal = Decimal(normalized_high)
        low_decimal = Decimal(normalized_low)
        close_decimal = Decimal(normalized_close)
        if (
            low_decimal > high_decimal
            or open_decimal < low_decimal
            or open_decimal > high_decimal
            or close_decimal < low_decimal
            or close_decimal > high_decimal
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "base bar OHLC bounds are inconsistent",
            )
        if not isinstance(bar.source, str) or not bar.source:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "base bar source must be a non-empty string",
            )
        synthetic = bar.source == AGG_TRADE_SYNTHETIC_SOURCE
        if synthetic and self._synthetic_policy == BAR_SYNTHETIC_POLICY:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR-source builder cannot consume synthetic base bars",
            )
        if synthetic and (
            normalized_open != normalized_high
            or normalized_open != normalized_low
            or normalized_open != normalized_close
            or normalized_volume != "0"
            or normalized_quote not in {None, "0"}
            or normalized_trades not in {None, 0}
            or normalized_taker_base not in {None, "0"}
            or normalized_taker_quote not in {None, "0"}
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "synthetic base bar must be previous-close and zero-volume",
            )
        return {
            "open": normalized_open,
            "high": normalized_high,
            "low": normalized_low,
            "close": normalized_close,
            "volume": normalized_volume,
            "quote_volume": normalized_quote,
            "trades": normalized_trades,
            "taker_buy_base": normalized_taker_base,
            "taker_buy_quote": normalized_taker_quote,
            "synthetic": synthetic,
        }

    def _accumulate(
        self,
        active: ReplayDisplayBar,
        bar: ReplayBar,
        normalized: Mapping[str, str | int | bool | None],
    ) -> ReplayDisplayBar:
        high = _normalized_max(active.high, _required_string(normalized["high"]))
        low = _normalized_min(active.low, _required_string(normalized["low"]))
        return ReplayDisplayBar(
            open_time_ms=active.open_time_ms,
            close_time_ms=active.close_time_ms,
            open=active.open,
            high=high,
            low=low,
            close=_required_string(normalized["close"]),
            volume=_sum_decimal_strings(
                active.volume,
                _required_string(normalized["volume"]),
                "volume",
            ),
            quote_volume=_sum_optional_decimal_strings(
                active.quote_volume,
                _optional_required_string(normalized["quote_volume"]),
                "quote_volume",
            ),
            trades=_sum_optional_ints(
                active.trades,
                _optional_required_int(normalized["trades"]),
            ),
            taker_buy_base=_sum_optional_decimal_strings(
                active.taker_buy_base,
                _optional_required_string(normalized["taker_buy_base"]),
                "taker_buy_base",
            ),
            taker_buy_quote=_sum_optional_decimal_strings(
                active.taker_buy_quote,
                _optional_required_string(normalized["taker_buy_quote"]),
                "taker_buy_quote",
            ),
            first_base_open_ms=active.first_base_open_ms,
            last_base_open_ms=bar.open_time_ms,
            component_count=active.component_count + 1,
            expected_components=active.expected_components,
            is_closed=False,
            synthetic=active.synthetic and bool(normalized["synthetic"]),
        )

    def _append_closed(self, bar: ReplayDisplayBar) -> None:
        ordinal = self._closed_count + 1
        self._closed_chain_hash = self._next_closed_chain_hash(
            self._closed_chain_hash,
            ordinal,
            bar,
        )
        self._closed_count = ordinal
        self._closed_bars.append(bar)
        if len(self._closed_bars) > self._max_closed_bars:
            evicted = self._closed_bars.pop(0)
            prefix_ordinal = self._closed_prefix_count + 1
            self._closed_prefix_hash = self._next_closed_chain_hash(
                self._closed_prefix_hash,
                prefix_ordinal,
                evicted,
            )
            self._closed_prefix_count = prefix_ordinal

    def _validate_warmup_boundary(self) -> None:
        if self._warmup_bars:
            assert self._last_base_open_ms is not None
            expected_start_ms = self._next_base_open(self._last_base_open_ms)
            if expected_start_ms != self._replay_start_ms:
                code = (
                    ReplayErrorCode.DATASET_INCOMPLETE
                    if expected_start_ms < self._replay_start_ms
                    else ReplayErrorCode.DATASET_MISMATCH
                )
                raise ReplayDomainError(
                    code,
                    "warmup does not end immediately before replay start",
                    details={
                        "expected_replay_start_ms": expected_start_ms,
                        "actual_replay_start_ms": self._replay_start_ms,
                    },
                )

        display_open_ms = compute_bucket_start_ms(
            self._replay_start_ms,
            self._display_interval_ms,
            interval=self._display_interval,
        )
        if display_open_ms == self._replay_start_ms:
            if self._active_bar is not None:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "warmup left an incomplete bar before an exact display boundary",
                )
            return

        scheduled_prefix_count = self._schedule.expected_count(
            display_open_ms,
            self._replay_start_ms,
        )
        if scheduled_prefix_count == 0:
            if self._active_bar is not None:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "warmup revealed a component inside a fully halted prefix",
                )
            return
        required_prefix_count = self._count_base_components(
            display_open_ms,
            self._replay_start_ms,
        )
        if (
            self._active_bar is None
            or self._active_bar.open_time_ms != display_open_ms
            or self._active_bar.first_base_open_ms != display_open_ms
            or self._active_bar.component_count != required_prefix_count
            or self._next_base_open(self._active_bar.last_base_open_ms)
            != self._replay_start_ms
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "warmup lacks the exact prefix of the active display bucket",
            )

    def _expected_components(
        self,
        bucket_open_ms: int,
        bucket_end_ms: int,
    ) -> int:
        return self._count_base_components(bucket_open_ms, bucket_end_ms)

    def _expected_component_bounds(
        self,
        bucket_open_ms: int,
        bucket_end_ms: int,
    ) -> tuple[int, int | None, int | None]:
        return self._schedule.expected_bounds(bucket_open_ms, bucket_end_ms)

    def _count_base_components(self, start_ms: int, end_ms: int) -> int:
        if start_ms >= end_ms:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "display bucket has an invalid time range",
            )
        if not is_monthly_interval(self._base_interval):
            count = self._schedule.expected_count(start_ms, end_ms)
            if count < 1:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "display bucket contains no scheduled base components",
                )
            return count

        count = 0
        cursor_ms = start_ms
        while cursor_ms < end_ms:
            next_ms = self._next_base_open(cursor_ms)
            if next_ms <= cursor_ms or next_ms > end_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_INTERVAL,
                    "calendar display bucket cannot be tiled exactly",
                )
            cursor_ms = next_ms
            count += 1
            if count > 1_200:
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_INTERVAL,
                    "calendar interval ratio exceeds the supported bound",
                )
        if cursor_ms != end_ms:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "calendar display bucket cannot be tiled exactly",
            )
        return count

    def _next_base_open(self, open_time_ms: int) -> int:
        return self._schedule.next_expected_open(open_time_ms)

    def _initial_closed_chain_hash(self) -> str:
        payload: dict[str, object] = {
            "schema_version": BAR_BUILDER_CLOSED_CHAIN_SCHEMA_VERSION,
            "base_interval": self._base_interval,
            "display_interval": self._display_interval,
            "replay_start_ms": self._replay_start_ms,
            "warmup_fingerprint": self._warmup_fingerprint,
        }
        if self._verified_halts:
            payload["bar_schedule_hash"] = self._schedule.fingerprint
        return canonical_sha256(payload)

    @staticmethod
    def _next_closed_chain_hash(
        previous_hash: str,
        ordinal: int,
        bar: ReplayDisplayBar,
    ) -> str:
        return canonical_sha256(
            {
                "schema_version": BAR_BUILDER_CLOSED_CHAIN_SCHEMA_VERSION,
                "previous_hash": previous_hash,
                "ordinal": ordinal,
                "bar": bar.to_dict(),
            }
        )

    def _snapshot_payload(self) -> dict[str, object]:
        return {
            "schema_version": BAR_BUILDER_STATE_SCHEMA_VERSION,
            "base_interval": self._base_interval,
            "display_interval": self._display_interval,
            "base_interval_ms": self._base_interval_ms,
            "display_interval_ms": self._display_interval_ms,
            "replay_start_ms": self._replay_start_ms,
            "max_closed_bars": self._max_closed_bars,
            "warmup_count": len(self._warmup_bars),
            "warmup_fingerprint": self._warmup_fingerprint,
            "gap_policy": self._gap_policy,
            "synthetic_policy": self._synthetic_policy,
            "replay_events_applied": self._replay_events_applied,
            "last_base_open_ms": self._last_base_open_ms,
            "active_bar": (
                None if self._active_bar is None else self._active_bar.to_dict()
            ),
            "closed_bars": [bar.to_dict() for bar in self._closed_bars],
            "closed_count": self._closed_count,
            "closed_prefix_count": self._closed_prefix_count,
            "closed_prefix_hash": self._closed_prefix_hash,
            "closed_chain_hash": self._closed_chain_hash,
        }

    def _decode_state(self, state: Mapping[str, object]) -> dict[str, object]:
        if not isinstance(state, Mapping):
            raise TypeError("bar builder state must be an object")
        expected_keys = {
            "schema_version",
            "base_interval",
            "display_interval",
            "base_interval_ms",
            "display_interval_ms",
            "replay_start_ms",
            "max_closed_bars",
            "warmup_count",
            "warmup_fingerprint",
            "gap_policy",
            "synthetic_policy",
            "replay_events_applied",
            "last_base_open_ms",
            "active_bar",
            "closed_bars",
            "closed_count",
            "closed_prefix_count",
            "closed_prefix_hash",
            "closed_chain_hash",
            "state_hash",
        }
        if set(state) != expected_keys:
            raise ValueError("bar builder state fields do not match the schema")
        if state["schema_version"] != BAR_BUILDER_STATE_SCHEMA_VERSION:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "bar builder checkpoint schema is incompatible",
            )

        state_hash = _strict_string(state["state_hash"], "state_hash")
        if not _DIGEST_PATTERN.fullmatch(state_hash):
            raise ValueError("state_hash must be a canonical SHA-256 digest")
        payload = dict(state)
        del payload["state_hash"]
        expected_state_hash = canonical_sha256(
            {
                "schema_version": BAR_BUILDER_STATE_HASH_SCHEMA_VERSION,
                "state": payload,
            }
        )
        if state_hash != expected_state_hash:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "bar builder checkpoint state hash does not match",
            )

        expected_config: dict[str, object] = {
            "base_interval": self._base_interval,
            "display_interval": self._display_interval,
            "base_interval_ms": self._base_interval_ms,
            "display_interval_ms": self._display_interval_ms,
            "replay_start_ms": self._replay_start_ms,
            "max_closed_bars": self._max_closed_bars,
            "warmup_count": len(self._warmup_bars),
            "warmup_fingerprint": self._warmup_fingerprint,
            "gap_policy": self._gap_policy,
            "synthetic_policy": self._synthetic_policy,
        }
        for field_name, expected_value in expected_config.items():
            if state[field_name] != expected_value:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "bar builder checkpoint belongs to a different configuration",
                    details={"field": field_name},
                )

        replay_events_applied = _strict_int(
            state["replay_events_applied"],
            "replay_events_applied",
        )
        if replay_events_applied < 0:
            raise ValueError("replay_events_applied cannot be negative")
        last_base_open_ms = _optional_int(
            state["last_base_open_ms"],
            "last_base_open_ms",
        )
        expected_last_base_open_ms = self._expected_last_base_open(
            replay_events_applied
        )
        if last_base_open_ms != expected_last_base_open_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "bar builder cursor does not match its source sequence",
            )

        raw_closed_bars = state["closed_bars"]
        if not isinstance(raw_closed_bars, list):
            raise TypeError("closed_bars must be a list")
        closed_bars: list[ReplayDisplayBar] = []
        for raw_bar in raw_closed_bars:
            if not isinstance(raw_bar, Mapping):
                raise TypeError("closed_bars entries must be objects")
            decoded = ReplayDisplayBar.from_dict(raw_bar)
            self._validate_display_bar(decoded, expected_closed=True)
            closed_bars.append(decoded)

        raw_active_bar = state["active_bar"]
        if raw_active_bar is None:
            active_bar = None
        elif isinstance(raw_active_bar, Mapping):
            active_bar = ReplayDisplayBar.from_dict(raw_active_bar)
            self._validate_display_bar(active_bar, expected_closed=False)
        else:
            raise TypeError("active_bar must be an object or null")

        closed_count = _strict_int(state["closed_count"], "closed_count")
        closed_prefix_count = _strict_int(
            state["closed_prefix_count"],
            "closed_prefix_count",
        )
        if closed_count < 0 or closed_prefix_count < 0:
            raise ValueError("closed bar counters cannot be negative")
        if closed_prefix_count + len(closed_bars) != closed_count:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "closed bar counters do not match retained state",
            )
        if len(closed_bars) != min(closed_count, self._max_closed_bars):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint does not retain the required closed-bar tail",
            )
        if len(closed_bars) > self._max_closed_bars:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint exceeds the closed-bar retention bound",
            )

        closed_prefix_hash = _strict_string(
            state["closed_prefix_hash"],
            "closed_prefix_hash",
        )
        closed_chain_hash = _strict_string(
            state["closed_chain_hash"],
            "closed_chain_hash",
        )
        if not _DIGEST_PATTERN.fullmatch(
            closed_prefix_hash
        ) or not _DIGEST_PATTERN.fullmatch(closed_chain_hash):
            raise ValueError("closed chain hashes must be canonical SHA-256 digests")
        if closed_prefix_count == 0 and (
            closed_prefix_hash != self._initial_closed_chain_hash()
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "closed prefix root does not match the builder configuration",
            )
        recomputed_chain_hash = closed_prefix_hash
        for offset, bar in enumerate(closed_bars, start=1):
            recomputed_chain_hash = self._next_closed_chain_hash(
                recomputed_chain_hash,
                closed_prefix_count + offset,
                bar,
            )
        if recomputed_chain_hash != closed_chain_hash:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "closed bar chain hash does not match retained bars",
            )

        for previous, current in zip(closed_bars, closed_bars[1:]):
            if current.open_time_ms != self._next_scheduled_display_open(
                previous.open_time_ms
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "retained closed display bars do not follow the BAR schedule",
                )
        if active_bar is not None:
            if closed_bars and active_bar.open_time_ms != (
                self._next_scheduled_display_open(closed_bars[-1].open_time_ms)
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "active display bar does not follow the closed tail",
                )
            if active_bar.last_base_open_ms != last_base_open_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "active display bar does not end at the source cursor",
                )
        elif replay_events_applied > 0:
            if (
                not closed_bars
                or closed_bars[-1].last_base_open_ms != last_base_open_ms
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "closed display tail does not end at the source cursor",
                )

        return {
            "active_bar": active_bar,
            "closed_bars": closed_bars,
            "closed_count": closed_count,
            "closed_prefix_count": closed_prefix_count,
            "closed_prefix_hash": closed_prefix_hash,
            "closed_chain_hash": closed_chain_hash,
            "last_base_open_ms": last_base_open_ms,
            "replay_events_applied": replay_events_applied,
        }

    def _validate_display_bar(
        self,
        bar: ReplayDisplayBar,
        *,
        expected_closed: bool,
    ) -> None:
        if bar.synthetic and self._synthetic_policy == BAR_SYNTHETIC_POLICY:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR-source builder state cannot contain synthetic bars",
            )
        if bar.is_closed is not expected_closed:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "display bar close state is inconsistent with its container",
            )
        bucket_open_ms = compute_bucket_start_ms(
            bar.open_time_ms,
            self._display_interval_ms,
            interval=self._display_interval,
        )
        bucket_end_ms = compute_bucket_end_ms(
            bucket_open_ms,
            self._display_interval_ms,
            interval=self._display_interval,
        )
        expected_components, expected_first_open_ms, expected_last_open_ms = (
            self._expected_component_bounds(
                bucket_open_ms,
                bucket_end_ms,
            )
        )
        if expected_first_open_ms is None or expected_last_open_ms is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "display bar cannot occupy a fully halted bucket",
            )
        if (
            bar.open_time_ms != bucket_open_ms
            or bar.close_time_ms != bucket_end_ms - 1
            or bar.expected_components != expected_components
            or bar.component_count < 1
            or bar.component_count > expected_components
            or bar.first_base_open_ms != expected_first_open_ms
            or compute_bucket_start_ms(
                bar.last_base_open_ms,
                self._base_interval_ms,
                interval=self._base_interval,
            )
            != bar.last_base_open_ms
            or self._count_base_components(
                bar.first_base_open_ms,
                self._next_base_open(bar.last_base_open_ms),
            )
            != bar.component_count
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "display bar component boundaries are inconsistent",
            )
        complete = (
            bar.component_count == expected_components
            and bar.last_base_open_ms == expected_last_open_ms
        )
        if complete is not expected_closed:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "display bar completion does not match its close state",
            )
        try:
            normalized_open = _normalized_decimal(bar.open, "open", positive=True)
            normalized_high = _normalized_decimal(bar.high, "high", positive=True)
            normalized_low = _normalized_decimal(bar.low, "low", positive=True)
            normalized_close = _normalized_decimal(
                bar.close,
                "close",
                positive=True,
            )
            normalized_volume = _normalized_decimal(bar.volume, "volume")
            normalized_quote = _normalized_optional_decimal(
                bar.quote_volume,
                "quote_volume",
            )
            normalized_taker_base = _normalized_optional_decimal(
                bar.taker_buy_base,
                "taker_buy_base",
            )
            normalized_taker_quote = _normalized_optional_decimal(
                bar.taker_buy_quote,
                "taker_buy_quote",
            )
            normalized_trades = _validated_optional_counter(bar.trades, "trades")
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "display bar contains malformed numeric fields",
            ) from exc
        if (
            normalized_open != bar.open
            or normalized_high != bar.high
            or normalized_low != bar.low
            or normalized_close != bar.close
            or normalized_volume != bar.volume
            or normalized_quote != bar.quote_volume
            or normalized_taker_base != bar.taker_buy_base
            or normalized_taker_quote != bar.taker_buy_quote
            or normalized_trades != bar.trades
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "display bar numeric fields are not canonical",
            )
        open_decimal = Decimal(bar.open)
        high_decimal = Decimal(bar.high)
        low_decimal = Decimal(bar.low)
        close_decimal = Decimal(bar.close)
        if (
            low_decimal > high_decimal
            or open_decimal < low_decimal
            or open_decimal > high_decimal
            or close_decimal < low_decimal
            or close_decimal > high_decimal
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "display bar OHLC bounds are inconsistent",
            )

    def _expected_last_base_open(self, replay_events_applied: int) -> int | None:
        if replay_events_applied == 0:
            if not self._warmup_bars:
                return None
            return self._warmup_bars[-1].open_time_ms
        return self._schedule.nth_expected_open(
            self._replay_start_ms,
            replay_events_applied - 1,
        )

    def _next_display_open(self, open_time_ms: int) -> int:
        return compute_bucket_end_ms(
            open_time_ms,
            self._display_interval_ms,
            interval=self._display_interval,
        )

    def _next_scheduled_display_open(self, open_time_ms: int) -> int:
        next_bucket_open_ms = self._next_display_open(open_time_ms)
        next_expected_base_open_ms = self._schedule.next_expected_at_or_after(
            next_bucket_open_ms
        )
        return compute_bucket_start_ms(
            next_expected_base_open_ms,
            self._display_interval_ms,
            interval=self._display_interval,
        )


def _disabled_capability(
    base_interval: str,
    display_interval: str,
    base_interval_ms: int | None,
    display_interval_ms: int | None,
    reason: str,
) -> BarBuilderCapability:
    return BarBuilderCapability(
        False,
        reason,
        base_interval,
        display_interval,
        base_interval_ms,
        display_interval_ms,
        None,
        is_monthly_interval(base_interval) or is_monthly_interval(display_interval),
    )


def _strict_string(value: object, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    return value


def _optional_string(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return _strict_string(value, field_name)


def _strict_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    return value


def _optional_int(value: object, field_name: str) -> int | None:
    if value is None:
        return None
    return _strict_int(value, field_name)


def _strict_bool(value: object, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"{field_name} must be a boolean")
    return value


def _normalized_decimal(
    value: object,
    field_name: str,
    *,
    positive: bool = False,
) -> str:
    normalized = normalize_decimal_string(value, field_name=field_name)
    decimal_value = Decimal(normalized)
    if positive and decimal_value <= 0:
        raise ValueError(f"{field_name} must be positive")
    if not positive and decimal_value < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return normalized


def _normalized_optional_decimal(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return _normalized_decimal(value, field_name)


def _validated_optional_counter(value: object, field_name: str) -> int | None:
    if value is None:
        return None
    counter = _strict_int(value, field_name)
    if counter < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return counter


def _required_string(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("normalized value must be a string")
    return value


def _optional_required_string(value: object) -> str | None:
    if value is None:
        return None
    return _required_string(value)


def _optional_required_int(value: object) -> int | None:
    if value is None:
        return None
    return _strict_int(value, "normalized counter")


def _decimal_to_string(value: Decimal, field_name: str) -> str:
    return normalize_decimal_string(format(value, "f"), field_name=field_name)


def _normalized_max(left: str, right: str) -> str:
    return left if Decimal(left) >= Decimal(right) else right


def _normalized_min(left: str, right: str) -> str:
    return left if Decimal(left) <= Decimal(right) else right


def _sum_decimal_strings(left: str, right: str, field_name: str) -> str:
    return _decimal_to_string(Decimal(left) + Decimal(right), field_name)


def _sum_optional_decimal_strings(
    left: str | None,
    right: str | None,
    field_name: str,
) -> str | None:
    if left is None or right is None:
        return None
    return _sum_decimal_strings(left, right, field_name)


def _sum_optional_ints(left: int | None, right: int | None) -> int | None:
    if left is None or right is None:
        return None
    return left + right
