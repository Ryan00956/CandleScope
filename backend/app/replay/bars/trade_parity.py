"""Frozen release parity gate for aggregate-trade-derived Klines."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Mapping, Sequence

from ..dataset import ReplayBar
from ..errors import ReplayDomainError, ReplayErrorCode
from .builder import ReplayDisplayBar


TRADE_BAR_PARITY_SCHEMA_VERSION = "agg-trade-bar-parity.v1"
TRADE_BAR_ABSOLUTE_TOLERANCE = Decimal("1e-8")
TRADE_BAR_RELATIVE_TOLERANCE = Decimal("1e-12")

_DECIMAL_FIELDS = (
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "taker_buy_base",
    "taker_buy_quote",
)


@dataclass(frozen=True, slots=True)
class TradeBarParityMismatch:
    open_time_ms: int
    field: str
    expected: object
    actual: object
    allowed_error: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "open_time_ms": self.open_time_ms,
            "field": self.field,
            "expected": self.expected,
            "actual": self.actual,
            "allowed_error": self.allowed_error,
        }


@dataclass(frozen=True, slots=True)
class TradeBarParityReport:
    checked_bars: int
    mismatches: tuple[TradeBarParityMismatch, ...]
    absolute_tolerance: str = "0.00000001"
    relative_tolerance: str = "0.000000000001"
    schema_version: str = TRADE_BAR_PARITY_SCHEMA_VERSION

    @property
    def exact_enough(self) -> bool:
        return not self.mismatches

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "checked_bars": self.checked_bars,
            "exact_enough": self.exact_enough,
            "absolute_tolerance": self.absolute_tolerance,
            "relative_tolerance": self.relative_tolerance,
            "integer_policy": "exact",
            "mismatches": [value.to_dict() for value in self.mismatches],
        }


def audit_trade_bar_parity(
    actual: Sequence[ReplayDisplayBar | ReplayBar | Mapping[str, object]],
    reference: Sequence[ReplayDisplayBar | ReplayBar | Mapping[str, object]],
    *,
    max_mismatches: int = 100,
) -> TradeBarParityReport:
    """Compare one ordered closed-bar range using the frozen Phase 8 tolerance."""

    if isinstance(max_mismatches, bool) or not isinstance(max_mismatches, int):
        raise TypeError("max_mismatches must be an integer")
    if max_mismatches < 1:
        raise ValueError("max_mismatches must be positive")
    actual_rows = tuple(_payload(value) for value in actual)
    reference_rows = tuple(_payload(value) for value in reference)
    mismatches: list[TradeBarParityMismatch] = []
    checked = min(len(actual_rows), len(reference_rows))

    if len(actual_rows) != len(reference_rows):
        mismatches.append(
            TradeBarParityMismatch(
                open_time_ms=0,
                field="row_count",
                expected=len(reference_rows),
                actual=len(actual_rows),
                allowed_error=None,
            )
        )

    for actual_row, expected_row in zip(actual_rows, reference_rows):
        expected_open = _timestamp(expected_row, "open_time_ms")
        actual_open = _timestamp(actual_row, "open_time_ms")
        for field in ("open_time_ms", "close_time_ms", "trades"):
            expected_value = (
                _timestamp(expected_row, field)
                if field != "trades"
                else expected_row.get(field)
            )
            actual_value = (
                _timestamp(actual_row, field)
                if field != "trades"
                else actual_row.get(field)
            )
            if actual_value != expected_value:
                mismatches.append(
                    TradeBarParityMismatch(
                        open_time_ms=expected_open,
                        field=field,
                        expected=expected_value,
                        actual=actual_value,
                        allowed_error=None,
                    )
                )
        if actual_open != expected_open:
            continue
        for field in _DECIMAL_FIELDS:
            expected_value = expected_row.get(field)
            actual_value = actual_row.get(field)
            if expected_value is None or actual_value is None:
                if expected_value != actual_value:
                    mismatches.append(
                        TradeBarParityMismatch(
                            open_time_ms=expected_open,
                            field=field,
                            expected=expected_value,
                            actual=actual_value,
                            allowed_error=None,
                        )
                    )
                continue
            expected_decimal = Decimal(str(expected_value))
            actual_decimal = Decimal(str(actual_value))
            allowed = max(
                TRADE_BAR_ABSOLUTE_TOLERANCE,
                abs(expected_decimal) * TRADE_BAR_RELATIVE_TOLERANCE,
            )
            if abs(actual_decimal - expected_decimal) > allowed:
                mismatches.append(
                    TradeBarParityMismatch(
                        open_time_ms=expected_open,
                        field=field,
                        expected=str(expected_value),
                        actual=str(actual_value),
                        allowed_error=format(allowed, "f"),
                    )
                )
        if len(mismatches) >= max_mismatches:
            break

    return TradeBarParityReport(
        checked_bars=checked,
        mismatches=tuple(mismatches[:max_mismatches]),
    )


def assert_trade_bar_parity(
    actual: Sequence[ReplayDisplayBar | ReplayBar | Mapping[str, object]],
    reference: Sequence[ReplayDisplayBar | ReplayBar | Mapping[str, object]],
) -> TradeBarParityReport:
    report = audit_trade_bar_parity(actual, reference)
    if not report.exact_enough:
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_MISMATCH,
            "aggregate-trade Kline parity exceeds the frozen release tolerance",
            details=report.to_dict(),
        )
    return report


def _payload(
    value: ReplayDisplayBar | ReplayBar | Mapping[str, object],
) -> Mapping[str, object]:
    if isinstance(value, (ReplayDisplayBar, ReplayBar)):
        return value.to_dict()
    if not isinstance(value, Mapping):
        raise TypeError("parity rows must be replay bars or mappings")
    return value


def _timestamp(payload: Mapping[str, object], field: str) -> int:
    aliases = {
        "open_time_ms": "open_time",
        "close_time_ms": "close_time",
    }
    value = payload.get(field, payload.get(aliases.get(field, "")))
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"parity {field} must be an integer")
    return value


__all__ = [
    "TRADE_BAR_ABSOLUTE_TOLERANCE",
    "TRADE_BAR_PARITY_SCHEMA_VERSION",
    "TRADE_BAR_RELATIVE_TOLERANCE",
    "TradeBarParityMismatch",
    "TradeBarParityReport",
    "assert_trade_bar_parity",
    "audit_trade_bar_parity",
]
