"""Expression evaluation helpers for requested contexts."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from ..context import PyneContext
from ..series import PyneSeries
from ..series import switch as series_switch
from ..series import when as series_when
from ..series import where as series_where
from ..ta import TaModule
from ..values import is_na_value
from .errors import PyneRequestError

RequestValues = list[Any] | tuple[list[Any], ...]


@dataclass(frozen=True)
class RequestEvalContext:
    """Calculation-only context passed to request expression thunks."""

    symbol: str
    timeframe: str
    context: PyneContext
    ta: TaModule

    @property
    def open(self) -> PyneSeries:
        return self.context.open

    @property
    def high(self) -> PyneSeries:
        return self.context.high

    @property
    def low(self) -> PyneSeries:
        return self.context.low

    @property
    def close(self) -> PyneSeries:
        return self.context.close

    @property
    def volume(self) -> PyneSeries:
        return self.context.volume

    @property
    def time(self) -> PyneSeries:
        return self.context.time

    @property
    def time_close(self) -> PyneSeries:
        return self.context.time_close

    @property
    def bar_index(self) -> PyneSeries:
        return self.context.bar_index

    @property
    def last_bar_index(self) -> PyneSeries:
        return self.context.last_bar_index

    @property
    def barstate(self) -> Any:
        return self.context.barstate

    @property
    def syminfo(self) -> Any:
        return self.context.syminfo

    @property
    def timeframe_info(self) -> Any:
        return self.context.timeframe

    @property
    def session(self) -> Any:
        return self.context.session

    @property
    def hl2(self) -> PyneSeries:
        return self.context.hl2

    @property
    def hlc3(self) -> PyneSeries:
        return self.context.hlc3

    @property
    def ohlc4(self) -> PyneSeries:
        return self.context.ohlc4

    @property
    def hlcc4(self) -> PyneSeries:
        return self.context.hlcc4

    def when(self, condition: Any, true_value: Any, false_value: Any) -> Any:
        return series_when(condition, true_value, false_value)

    def where(self, condition: Any, true_value: Any, false_value: Any) -> Any:
        return series_where(condition, true_value, false_value)

    def switch(self, *cases: Any, default: Any = np.nan) -> Any:
        return series_switch(*cases, default=default)


def _resolve_requested_field(expression: PyneSeries | str) -> tuple[str, int]:
    if isinstance(expression, str):
        name = expression
    elif isinstance(expression, PyneSeries) and expression.name:
        name = expression.name
    else:
        raise PyneRequestError(
            "request.security() currently supports OHLCV field expressions only",
            code="PYNE_UNSUPPORTED_FEATURE",
        )

    field, offset = _split_history_name(name)
    if field not in {
        "open",
        "high",
        "low",
        "close",
        "volume",
        "time",
        "time_close",
        "hl2",
        "hlc3",
        "ohlc4",
        "hlcc4",
    }:
        raise PyneRequestError(
            f"request.security() does not support expression field '{field}'",
            code="PYNE_UNSUPPORTED_FEATURE",
        )
    return field, offset

def _values_from_field_expression(
    expression: PyneSeries | str | tuple[Any, ...] | list[Any],
    requested: list[dict[str, Any]],
    requested_ctx: PyneContext,
) -> tuple[RequestValues, str]:
    if isinstance(expression, tuple | list):
        values = []
        names = []
        for item in expression:
            field, history_offset = _resolve_requested_field(item)
            values.append(_apply_history_offset(
                _field_values(requested, requested_ctx, field),
                history_offset,
            ))
            names.append(field if history_offset <= 0 else f"{field}[{history_offset}]")
        if not values:
            raise PyneRequestError(
                "request.security() multi-return expression cannot be empty",
                code="PYNE_UNSUPPORTED_FEATURE",
            )
        return tuple(values), ",".join(names)

    field, history_offset = _resolve_requested_field(expression)
    values = _apply_history_offset(
        _field_values(requested, requested_ctx, field),
        history_offset,
    )
    expression_name = field if history_offset <= 0 else f"{field}[{history_offset}]"
    return values, expression_name

def _split_history_name(name: str) -> tuple[str, int]:
    if "[" not in name:
        return name, 0
    field, raw_offset = name.split("[", 1)
    if not raw_offset.endswith("]"):
        raise PyneRequestError(
            f"Invalid request.security() history offset in expression '{name}'",
            code="PYNE_UNSUPPORTED_FEATURE",
        )
    try:
        return field, int(raw_offset.rstrip("]"))
    except ValueError:
        raise PyneRequestError(
            f"Invalid request.security() history offset in expression '{name}'",
            code="PYNE_UNSUPPORTED_FEATURE",
        ) from None

def _apply_history_offset(values: list[float], offset: int) -> list[float]:
    if offset <= 0:
        return values
    shifted = [np.nan] * len(values)
    if offset < len(values):
        shifted[offset:] = values[: len(values) - offset]
    return shifted

def _values_from_expression_result(result: Any, requested_ctx: PyneContext) -> RequestValues:
    length = requested_ctx.bar_count
    if isinstance(result, tuple):
        if not result:
            raise PyneRequestError(
                "request.security() expression cannot return an empty tuple",
                code="PYNE_UNSUPPORTED_FEATURE",
            )
        return tuple(_values_from_expression_result(item, requested_ctx) for item in result)

    if isinstance(result, PyneSeries):
        values = result.to_numpy().tolist()
    elif isinstance(result, np.ndarray):
        values = result.tolist()
    elif isinstance(result, list):
        values = result
    elif isinstance(result, dict) or result is None:
        raise PyneRequestError(
            "request.security() expression must return a series, tuple of series, or scalar value",
            code="PYNE_UNSUPPORTED_FEATURE",
        )
    elif isinstance(result, bool | int | float | np.generic):
        values = [result] * length
    else:
        raise PyneRequestError(
            f"request.security() expression returned unsupported type {type(result).__name__}",
            code="PYNE_UNSUPPORTED_FEATURE",
        )

    if len(values) != length:
        raise PyneRequestError(
            "request.security() expression result length must match requested OHLCV length",
            code="PYNE_RUNTIME_ERROR",
        )
    return [np.nan if is_na_value(item) else item for item in values]

def _field_values(
    requested: list[dict[str, Any]],
    requested_ctx: PyneContext,
    field: str,
) -> list[float]:
    context_fields = {
        "open": requested_ctx.open,
        "high": requested_ctx.high,
        "low": requested_ctx.low,
        "close": requested_ctx.close,
        "volume": requested_ctx.volume,
        "time": requested_ctx.time,
        "time_close": requested_ctx.time_close,
        "hl2": requested_ctx.hl2,
        "hlc3": requested_ctx.hlc3,
        "ohlc4": requested_ctx.ohlc4,
        "hlcc4": requested_ctx.hlcc4,
    }
    series = context_fields.get(field)
    if series is not None:
        return series.to_numpy().tolist()
    return [_field_value(bar, field) for bar in requested]

def _field_value(bar: dict[str, Any], field: str) -> float:
    if field == "hl2":
        return (float(bar.get("high", np.nan)) + float(bar.get("low", np.nan))) / 2
    if field == "hlc3":
        return (
            float(bar.get("high", np.nan))
            + float(bar.get("low", np.nan))
            + float(bar.get("close", np.nan))
        ) / 3
    if field == "ohlc4":
        return (
            float(bar.get("open", np.nan))
            + float(bar.get("high", np.nan))
            + float(bar.get("low", np.nan))
            + float(bar.get("close", np.nan))
        ) / 4
    if field == "hlcc4":
        return (
            float(bar.get("high", np.nan))
            + float(bar.get("low", np.nan))
            + float(bar.get("close", np.nan))
            + float(bar.get("close", np.nan))
        ) / 4
    return float(bar.get(field, np.nan))
