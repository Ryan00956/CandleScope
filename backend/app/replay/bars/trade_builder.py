"""Deterministic aggregate-trade to Kline reducer with bounded state."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, localcontext
from typing import Iterable, Mapping

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
)

from ..canonical import canonical_sha256
from ..dataset import ReplayBar
from ..errors import ReplayDomainError, ReplayErrorCode
from ..models import normalize_decimal_string, validate_timestamp_ms
from ..sources.trade_reader import ReplayTrade
from .builder import (
    AGG_TRADE_SYNTHETIC_SOURCE,
    BAR_GAP_POLICY,
    TRADE_SYNTHETIC_POLICY,
    BarProjectionAction,
    ReplayBarBuilder,
    ReplayDisplayBar,
)


TRADE_BAR_BUILDER_STATE_SCHEMA_VERSION = "replay-trade-bar-builder-state.v1"
TRADE_BAR_BUILDER_STATE_HASH_SCHEMA_VERSION = (
    "replay-trade-bar-builder-state-hash.v1"
)
AGG_TRADE_BASE_SOURCE = "agg_trade"


@dataclass(frozen=True, slots=True)
class _FormingBaseBar:
    open_time_ms: int
    close_time_ms: int
    open: str
    high: str
    low: str
    close: str
    volume: str
    quote_volume: str
    trades: int
    taker_buy_base: str
    taker_buy_quote: str

    @classmethod
    def from_trade(
        cls,
        trade: ReplayTrade,
        *,
        open_time_ms: int,
        close_time_ms: int,
    ) -> "_FormingBaseBar":
        taker_base = "0" if trade.is_buyer_maker else trade.quantity
        taker_quote = "0" if trade.is_buyer_maker else trade.quote_quantity
        return cls(
            open_time_ms=open_time_ms,
            close_time_ms=close_time_ms,
            open=trade.price,
            high=trade.price,
            low=trade.price,
            close=trade.price,
            volume=trade.quantity,
            quote_volume=trade.quote_quantity,
            trades=trade.raw_trade_count,
            taker_buy_base=taker_base,
            taker_buy_quote=taker_quote,
        )

    def accumulate(self, trade: ReplayTrade) -> "_FormingBaseBar":
        price = Decimal(trade.price)
        return _FormingBaseBar(
            open_time_ms=self.open_time_ms,
            close_time_ms=self.close_time_ms,
            open=self.open,
            high=_decimal_string(max(Decimal(self.high), price), "high"),
            low=_decimal_string(min(Decimal(self.low), price), "low"),
            close=trade.price,
            volume=_sum(self.volume, trade.quantity, "volume"),
            quote_volume=_sum(
                self.quote_volume,
                trade.quote_quantity,
                "quote_volume",
            ),
            trades=self.trades + trade.raw_trade_count,
            taker_buy_base=(
                self.taker_buy_base
                if trade.is_buyer_maker
                else _sum(
                    self.taker_buy_base,
                    trade.quantity,
                    "taker_buy_base",
                )
            ),
            taker_buy_quote=(
                self.taker_buy_quote
                if trade.is_buyer_maker
                else _sum(
                    self.taker_buy_quote,
                    trade.quote_quantity,
                    "taker_buy_quote",
                )
            ),
        )

    def to_replay_bar(self) -> ReplayBar:
        return ReplayBar(
            open_time_ms=self.open_time_ms,
            close_time_ms=self.close_time_ms,
            open=self.open,
            high=self.high,
            low=self.low,
            close=self.close,
            volume=self.volume,
            quote_volume=self.quote_volume,
            trades=self.trades,
            taker_buy_base=self.taker_buy_base,
            taker_buy_quote=self.taker_buy_quote,
            source=AGG_TRADE_BASE_SOURCE,
        )

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
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "_FormingBaseBar":
        expected = {
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
        }
        if set(payload) != expected:
            raise ValueError("forming base bar fields are incompatible")
        bar = cls(
            open_time_ms=_strict_int(payload["open_time_ms"], "open_time_ms"),
            close_time_ms=_strict_int(payload["close_time_ms"], "close_time_ms"),
            open=_decimal(payload["open"], "open", positive=True),
            high=_decimal(payload["high"], "high", positive=True),
            low=_decimal(payload["low"], "low", positive=True),
            close=_decimal(payload["close"], "close", positive=True),
            volume=_decimal(payload["volume"], "volume"),
            quote_volume=_decimal(payload["quote_volume"], "quote_volume"),
            trades=_strict_int(payload["trades"], "trades"),
            taker_buy_base=_decimal(
                payload["taker_buy_base"],
                "taker_buy_base",
            ),
            taker_buy_quote=_decimal(
                payload["taker_buy_quote"],
                "taker_buy_quote",
            ),
        )
        if (
            bar.trades < 1
            or Decimal(bar.low) > Decimal(bar.high)
            or not Decimal(bar.low) <= Decimal(bar.open) <= Decimal(bar.high)
            or not Decimal(bar.low) <= Decimal(bar.close) <= Decimal(bar.high)
        ):
            raise ValueError("forming base bar values are inconsistent")
        return bar


class TradeReplayBarBuilder:
    """Aggregate every revealed trade while retaining only one forming base bar."""

    def __init__(
        self,
        *,
        base_interval: str,
        display_interval: str,
        replay_start_ms: int,
        replay_end_time_ms: int,
        warmup_bars: Iterable[ReplayBar] = (),
        max_closed_bars: int = 2_048,
    ) -> None:
        base_ms = parse_interval_ms(base_interval)
        if (
            base_ms is None
            or base_ms <= 0
            or is_monthly_interval(base_interval)
        ):
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "aggregate-trade base interval must have a fixed duration",
            )
        self._base_interval = base_interval
        self._display_interval = display_interval
        self._base_interval_ms = base_ms
        self._replay_start_ms = validate_timestamp_ms(
            replay_start_ms,
            field_name="replay_start_ms",
        )
        self._replay_end_time_ms = validate_timestamp_ms(
            replay_end_time_ms,
            field_name="replay_end_time_ms",
        )
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
                "aggregate-trade replay start is not base-interval aligned",
            )
        final_base_open = compute_bucket_start_ms(
            self._replay_end_time_ms,
            self._base_interval_ms,
            interval=self._base_interval,
        )
        if (
            compute_bucket_end_ms(
                final_base_open,
                self._base_interval_ms,
                interval=self._base_interval,
            )
            - 1
            != self._replay_end_time_ms
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade replay end must close a base interval",
            )
        if self._replay_end_time_ms < self._replay_start_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade replay range is inverted",
            )
        self._warmup_bars = tuple(warmup_bars)
        self._max_closed_bars = max_closed_bars
        self._bar_builder = ReplayBarBuilder(
            base_interval=base_interval,
            display_interval=display_interval,
            replay_start_ms=self._replay_start_ms,
            warmup_bars=self._warmup_bars,
            max_closed_bars=max_closed_bars,
            synthetic_policy=TRADE_SYNTHETIC_POLICY,
        )
        self.reset()

    @property
    def bar_builder(self) -> ReplayBarBuilder:
        return self._bar_builder

    @property
    def replay_events_applied(self) -> int:
        return self._replay_events_applied

    @property
    def closed_bars(self) -> tuple[ReplayDisplayBar, ...]:
        return self._bar_builder.closed_bars

    @property
    def active_bar(self) -> ReplayDisplayBar | None:
        if self._forming is None:
            return self._bar_builder.active_bar
        return self._preview_display_bar()

    @property
    def state_hash(self) -> str:
        return str(self.snapshot()["state_hash"])

    def apply_trade(self, trade: ReplayTrade) -> Mapping[str, object]:
        if self._finalized:
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_ENDED,
                "aggregate-trade bar builder has been finalized",
            )
        self._validate_trade(trade)
        base_open_ms = self._base_open(trade.trade_time_ms)
        updates: list[dict[str, object]] = []
        next_sequence = self._replay_events_applied + 1

        if self._forming is None:
            self._append_empty_until(
                base_open_ms,
                updates,
                source_sequence=next_sequence,
            )
            self._forming = _FormingBaseBar.from_trade(
                trade,
                open_time_ms=base_open_ms,
                close_time_ms=self._base_end(base_open_ms) - 1,
            )
        elif base_open_ms == self._forming.open_time_ms:
            self._forming = self._forming.accumulate(trade)
        elif base_open_ms > self._forming.open_time_ms:
            self._append_finalized(
                self._forming.to_replay_bar(),
                updates,
                source_sequence=next_sequence,
            )
            self._forming = None
            self._append_empty_until(
                base_open_ms,
                updates,
                source_sequence=next_sequence,
            )
            self._forming = _FormingBaseBar.from_trade(
                trade,
                open_time_ms=base_open_ms,
                close_time_ms=self._base_end(base_open_ms) - 1,
            )
        else:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade bar bucket moved backward",
            )

        self._replay_events_applied = next_sequence
        self._last_trade_time_ms = trade.trade_time_ms
        self._last_agg_trade_id = trade.agg_trade_id
        updates.append(
            self._projection_update(
                self._preview_display_bar(),
                source_sequence=next_sequence,
                base_open_time_ms=base_open_ms,
            )
        )
        return _pack_updates(updates)

    def apply_source_event(self, event: object) -> Mapping[str, object]:
        if not isinstance(event, ReplayTrade):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade builder source event must be ReplayTrade",
            )
        return self.apply_trade(event)

    def finalize_bars(self, *, virtual_time_ms: int) -> Mapping[str, object]:
        terminal = validate_timestamp_ms(
            virtual_time_ms,
            field_name="virtual_time_ms",
        )
        if terminal != self._replay_end_time_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade terminal time differs from the frozen range",
            )
        if self._finalized:
            return {}
        updates: list[dict[str, object]] = []
        if self._forming is not None:
            self._append_finalized(
                self._forming.to_replay_bar(),
                updates,
                source_sequence=self._replay_events_applied,
            )
            self._forming = None
        final_open_ms = self._base_open(self._replay_end_time_ms)
        self._append_empty_until(
            self._base_end(final_open_ms),
            updates,
            source_sequence=self._replay_events_applied,
        )
        self._finalized = True
        return {} if not updates else _pack_updates(updates)

    def finalize_session(
        self,
        *,
        open_order_disposition: str,
        position_disposition: str,
        virtual_time_ms: int,
    ) -> Mapping[str, object]:
        del open_order_disposition, position_disposition
        return self.finalize_bars(virtual_time_ms=virtual_time_ms)

    def replace_projection(self) -> dict[str, object]:
        projection = self._bar_builder.replace_projection()
        bars = list(projection["bars"])  # type: ignore[arg-type]
        if self._forming is not None:
            preview = self._preview_display_bar().to_dict()
            if bars and bars[-1]["open_time_ms"] == preview["open_time_ms"]:
                bars[-1] = preview
            else:
                bars.append(preview)
        return {
            **projection,
            "bars": bars,
            "replay_events_applied": self._replay_events_applied,
            "synthetic_policy": TRADE_SYNTHETIC_POLICY,
            "source_kind": "AGG_TRADE",
        }

    def reset(self) -> None:
        self._bar_builder.reset()
        self._forming: _FormingBaseBar | None = None
        self._next_base_open_ms = self._replay_start_ms
        self._replay_events_applied = 0
        self._last_trade_time_ms: int | None = None
        self._last_agg_trade_id: int | None = None
        self._identity: tuple[str, str, str] | None = None
        self._previous_close = (
            None if not self._warmup_bars else self._warmup_bars[-1].close
        )
        initial_bars = self._bar_builder.replace_projection()["bars"]
        self._last_projected_open_ms = (
            None
            if not initial_bars
            else int(initial_bars[-1]["open_time_ms"])  # type: ignore[index]
        )
        self._finalized = False

    def has_trading_state(self) -> bool:
        return False

    def snapshot(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": TRADE_BAR_BUILDER_STATE_SCHEMA_VERSION,
            "base_interval": self._base_interval,
            "display_interval": self._display_interval,
            "replay_start_ms": self._replay_start_ms,
            "replay_end_time_ms": self._replay_end_time_ms,
            "max_closed_bars": self._max_closed_bars,
            "synthetic_policy": TRADE_SYNTHETIC_POLICY,
            "bar_builder": self._bar_builder.snapshot(),
            "public_projection": self.replace_projection(),
            "forming": None if self._forming is None else self._forming.to_dict(),
            "next_base_open_ms": self._next_base_open_ms,
            "replay_events_applied": self._replay_events_applied,
            "last_trade_time_ms": self._last_trade_time_ms,
            "last_agg_trade_id": self._last_agg_trade_id,
            "identity": None if self._identity is None else list(self._identity),
            "previous_close": self._previous_close,
            "last_projected_open_ms": self._last_projected_open_ms,
            "finalized": self._finalized,
        }
        payload["state_hash"] = canonical_sha256(
            {
                "schema_version": TRADE_BAR_BUILDER_STATE_HASH_SCHEMA_VERSION,
                "state": payload,
            }
        )
        return payload

    def restore(self, state: Mapping[str, object]) -> None:
        if not isinstance(state, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade builder checkpoint must be an object",
            )
        payload = dict(state)
        state_hash = payload.pop("state_hash", None)
        if state_hash != canonical_sha256(
            {
                "schema_version": TRADE_BAR_BUILDER_STATE_HASH_SCHEMA_VERSION,
                "state": payload,
            }
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade builder checkpoint hash does not match",
            )
        expected_keys = {
            "schema_version",
            "base_interval",
            "display_interval",
            "replay_start_ms",
            "replay_end_time_ms",
            "max_closed_bars",
            "synthetic_policy",
            "bar_builder",
            "public_projection",
            "forming",
            "next_base_open_ms",
            "replay_events_applied",
            "last_trade_time_ms",
            "last_agg_trade_id",
            "identity",
            "previous_close",
            "last_projected_open_ms",
            "finalized",
        }
        if set(payload) != expected_keys:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade builder checkpoint fields are incompatible",
            )
        expected_config = {
            "schema_version": TRADE_BAR_BUILDER_STATE_SCHEMA_VERSION,
            "base_interval": self._base_interval,
            "display_interval": self._display_interval,
            "replay_start_ms": self._replay_start_ms,
            "replay_end_time_ms": self._replay_end_time_ms,
            "max_closed_bars": self._max_closed_bars,
            "synthetic_policy": TRADE_SYNTHETIC_POLICY,
        }
        if any(payload[key] != value for key, value in expected_config.items()):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade builder checkpoint configuration differs",
            )
        raw_builder = payload["bar_builder"]
        if not isinstance(raw_builder, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade nested bar checkpoint is malformed",
            )
        raw_public_projection = payload["public_projection"]
        if not isinstance(raw_public_projection, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade public projection is malformed",
            )
        raw_forming = payload["forming"]
        try:
            forming = (
                None
                if raw_forming is None
                else _FormingBaseBar.from_dict(raw_forming)  # type: ignore[arg-type]
            )
            next_base_open_ms = _strict_int(
                payload["next_base_open_ms"],
                "next_base_open_ms",
            )
            replay_events = _strict_int(
                payload["replay_events_applied"],
                "replay_events_applied",
            )
            last_time = _optional_int(
                payload["last_trade_time_ms"],
                "last_trade_time_ms",
            )
            last_id = _optional_int(
                payload["last_agg_trade_id"],
                "last_agg_trade_id",
            )
            if (last_time is None) != (last_id is None):
                raise ValueError("aggregate-trade checkpoint cursor is partial")
            raw_identity = payload["identity"]
            if raw_identity is None:
                identity = None
            elif (
                isinstance(raw_identity, list)
                and len(raw_identity) == 3
                and all(isinstance(value, str) for value in raw_identity)
            ):
                identity = tuple(raw_identity)
            else:
                raise ValueError("aggregate-trade checkpoint identity is malformed")
            previous_close = (
                None
                if payload["previous_close"] is None
                else _decimal(payload["previous_close"], "previous_close", positive=True)
            )
            last_projected = _optional_int(
                payload["last_projected_open_ms"],
                "last_projected_open_ms",
            )
            finalized = payload["finalized"]
            if not isinstance(finalized, bool) or replay_events < 0:
                raise ValueError("aggregate-trade checkpoint counters are invalid")
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade builder checkpoint is malformed",
            ) from exc

        old_builder = self._bar_builder.snapshot()
        old_fields = (
            self._forming,
            self._next_base_open_ms,
            self._replay_events_applied,
            self._last_trade_time_ms,
            self._last_agg_trade_id,
            self._identity,
            self._previous_close,
            self._last_projected_open_ms,
            self._finalized,
        )
        try:
            self._bar_builder.restore(raw_builder)
            self._forming = forming
            self._next_base_open_ms = next_base_open_ms
            self._replay_events_applied = replay_events
            self._last_trade_time_ms = last_time
            self._last_agg_trade_id = last_id
            self._identity = identity  # type: ignore[assignment]
            self._previous_close = previous_close
            self._last_projected_open_ms = last_projected
            self._finalized = finalized
            if self.replace_projection() != dict(raw_public_projection):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade public projection differs from checkpoint state",
                )
        except BaseException:
            self._bar_builder.restore(old_builder)
            (
                self._forming,
                self._next_base_open_ms,
                self._replay_events_applied,
                self._last_trade_time_ms,
                self._last_agg_trade_id,
                self._identity,
                self._previous_close,
                self._last_projected_open_ms,
                self._finalized,
            ) = old_fields
            raise

    def _validate_trade(self, trade: ReplayTrade) -> None:
        if not isinstance(trade, ReplayTrade):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade bar input must be ReplayTrade",
            )
        if not (
            self._replay_start_ms
            <= trade.trade_time_ms
            <= self._replay_end_time_ms
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate trade escaped the replay bar range",
            )
        identity = (trade.exchange, trade.market_type, trade.symbol)
        if self._identity is None:
            self._identity = identity
        elif identity != self._identity:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade identity changed while building bars",
            )
        if self._last_agg_trade_id is not None:
            if trade.agg_trade_id != self._last_agg_trade_id + 1:
                raise ReplayDomainError(
                    ReplayErrorCode.DATA_GAP,
                    "aggregate-trade bar input contains an ID gap or duplicate",
                )
            assert self._last_trade_time_ms is not None
            if trade.trade_time_ms < self._last_trade_time_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade bar input time moved backward",
                )

    def _append_empty_until(
        self,
        target_open_ms: int,
        updates: list[dict[str, object]],
        *,
        source_sequence: int,
    ) -> None:
        while self._next_base_open_ms < target_open_ms:
            if self._previous_close is None:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "an empty leading trade interval lacks a previous close",
                )
            open_ms = self._next_base_open_ms
            synthetic = ReplayBar(
                open_time_ms=open_ms,
                close_time_ms=self._base_end(open_ms) - 1,
                open=self._previous_close,
                high=self._previous_close,
                low=self._previous_close,
                close=self._previous_close,
                volume="0",
                quote_volume="0",
                trades=0,
                taker_buy_base="0",
                taker_buy_quote="0",
                source=AGG_TRADE_SYNTHETIC_SOURCE,
            )
            self._append_finalized(
                synthetic,
                updates,
                source_sequence=source_sequence,
            )
        if self._next_base_open_ms != target_open_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade base interval cursor overshot the target",
            )

    def _append_finalized(
        self,
        bar: ReplayBar,
        updates: list[dict[str, object]],
        *,
        source_sequence: int,
    ) -> None:
        if bar.open_time_ms != self._next_base_open_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate-trade finalized bar is not contiguous",
            )
        update = self._bar_builder.apply_bar(bar)
        updates.append(
            self._projection_update(
                update.bar,
                source_sequence=source_sequence,
                base_open_time_ms=bar.open_time_ms,
            )
        )
        self._previous_close = bar.close
        self._next_base_open_ms = self._base_end(bar.open_time_ms)

    def _preview_display_bar(self) -> ReplayDisplayBar:
        forming = self._forming
        if forming is None:
            raise RuntimeError("aggregate-trade builder has no forming base bar")
        display_ms = parse_interval_ms(self._display_interval)
        if display_ms is None or display_ms <= 0:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "display interval is invalid",
            )
        bucket_open_ms = compute_bucket_start_ms(
            forming.open_time_ms,
            display_ms,
            interval=self._display_interval,
        )
        bucket_end_ms = compute_bucket_end_ms(
            bucket_open_ms,
            display_ms,
            interval=self._display_interval,
        )
        expected_components = (bucket_end_ms - bucket_open_ms) // self._base_interval_ms
        active = self._bar_builder.active_bar
        if active is None:
            return ReplayDisplayBar(
                open_time_ms=bucket_open_ms,
                close_time_ms=bucket_end_ms - 1,
                open=forming.open,
                high=forming.high,
                low=forming.low,
                close=forming.close,
                volume=forming.volume,
                quote_volume=forming.quote_volume,
                trades=forming.trades,
                taker_buy_base=forming.taker_buy_base,
                taker_buy_quote=forming.taker_buy_quote,
                first_base_open_ms=forming.open_time_ms,
                last_base_open_ms=forming.open_time_ms,
                component_count=1,
                expected_components=expected_components,
                is_closed=False,
                synthetic=False,
            )
        if active.open_time_ms != bucket_open_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "forming trade bar does not follow the active display bucket",
            )
        return ReplayDisplayBar(
            open_time_ms=active.open_time_ms,
            close_time_ms=active.close_time_ms,
            open=active.open,
            high=_decimal_string(
                max(Decimal(active.high), Decimal(forming.high)),
                "high",
            ),
            low=_decimal_string(
                min(Decimal(active.low), Decimal(forming.low)),
                "low",
            ),
            close=forming.close,
            volume=_sum(active.volume, forming.volume, "volume"),
            quote_volume=_sum(
                active.quote_volume or "0",
                forming.quote_volume,
                "quote_volume",
            ),
            trades=(active.trades or 0) + forming.trades,
            taker_buy_base=_sum(
                active.taker_buy_base or "0",
                forming.taker_buy_base,
                "taker_buy_base",
            ),
            taker_buy_quote=_sum(
                active.taker_buy_quote or "0",
                forming.taker_buy_quote,
                "taker_buy_quote",
            ),
            first_base_open_ms=active.first_base_open_ms,
            last_base_open_ms=forming.open_time_ms,
            component_count=active.component_count + 1,
            expected_components=active.expected_components,
            is_closed=False,
            synthetic=False,
        )

    def _projection_update(
        self,
        bar: ReplayDisplayBar,
        *,
        source_sequence: int,
        base_open_time_ms: int,
    ) -> dict[str, object]:
        action = (
            BarProjectionAction.TICK
            if self._last_projected_open_ms == bar.open_time_ms
            else BarProjectionAction.APPEND
        )
        self._last_projected_open_ms = bar.open_time_ms
        return {
            "action": action.value,
            "bar": bar.to_dict(),
            "source_sequence": source_sequence,
            "base_open_time_ms": base_open_time_ms,
            "gap_policy": BAR_GAP_POLICY,
            "synthetic_policy": TRADE_SYNTHETIC_POLICY,
        }

    def _base_open(self, timestamp_ms: int) -> int:
        return compute_bucket_start_ms(
            timestamp_ms,
            self._base_interval_ms,
            interval=self._base_interval,
        )

    def _base_end(self, open_time_ms: int) -> int:
        return compute_bucket_end_ms(
            open_time_ms,
            self._base_interval_ms,
            interval=self._base_interval,
        )


def _pack_updates(updates: list[dict[str, object]]) -> dict[str, object]:
    if not updates:
        return {}
    if len(updates) == 1:
        return updates[0]
    return {"action": "batch", "updates": updates}


def _sum(left: str, right: str, field_name: str) -> str:
    with localcontext() as context:
        context.prec = 60
        value = Decimal(left) + Decimal(right)
    return _decimal_string(value, field_name)


def _decimal_string(value: Decimal, field_name: str) -> str:
    return normalize_decimal_string(format(value, "f"), field_name=field_name)


def _decimal(
    value: object,
    field_name: str,
    *,
    positive: bool = False,
) -> str:
    normalized = normalize_decimal_string(value, field_name=field_name)
    parsed = Decimal(normalized)
    if (positive and parsed <= 0) or (not positive and parsed < 0):
        raise ValueError(f"{field_name} is outside its numeric domain")
    return normalized


def _strict_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    return value


def _optional_int(value: object, field_name: str) -> int | None:
    if value is None:
        return None
    return _strict_int(value, field_name)


__all__ = [
    "AGG_TRADE_BASE_SOURCE",
    "TRADE_BAR_BUILDER_STATE_SCHEMA_VERSION",
    "TradeReplayBarBuilder",
]
