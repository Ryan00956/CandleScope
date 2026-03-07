# -*- coding: utf-8 -*-
"""
BOLL -- Bollinger Bands indicator.

Validates overlay + multi-output + rolling std pattern.
Three outputs: middle (SMA), upper, lower.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType


class BOLLIndicator(Indicator):
    name = "BOLL"
    version = "1.0"
    input_specs = ["close"]
    output_specs = ["middle", "upper", "lower"]
    warmup_period = 20

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)
        self._period: int = int(self.params.get("period", 20))
        self._mult: float = float(self.params.get("mult", 2.0))
        self._source: str = self.params.get("source", "close")
        self.warmup_period = self._period

        self._window: deque[float] = deque(maxlen=self._period)
        self._rolling_sum: float = 0.0
        self._rolling_sq_sum: float = 0.0

    def _reset_state(self) -> None:
        self._window.clear()
        self._rolling_sum = 0.0
        self._rolling_sq_sum = 0.0

    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            val = self._get_field(bar, self._source)

            if len(self._window) == self._period:
                old = self._window[0]
                self._rolling_sum -= old
                self._rolling_sq_sum -= old * old

            self._window.append(val)
            self._rolling_sum += val
            self._rolling_sq_sum += val * val

            if len(self._window) >= self._period:
                mid, upper, lower = self._compute()
                self._append_output("middle", bar.time, mid)
                self._append_output("upper", bar.time, upper)
                self._append_output("lower", bar.time, lower)
            else:
                self._append_output("middle", bar.time, None)
                self._append_output("upper", bar.time, None)
                self._append_output("lower", bar.time, None)

        self._bar_count = len(bars)
        self._initialized = True

    def _compute(self) -> tuple[float, float, float]:
        n = self._period
        mean = self._rolling_sum / n
        variance = (self._rolling_sq_sum / n) - (mean * mean)
        std = math.sqrt(max(variance, 0.0))
        return mean, mean + self._mult * std, mean - self._mult * std

    def update_partial(self, bar: BarData) -> None:
        if len(self._window) < self._period:
            self._preview.update({"middle": None, "upper": None, "lower": None})
            return

        val = self._get_field(bar, self._source)
        old_first = self._window[0]
        temp_sum = self._rolling_sum - old_first + val
        temp_sq = self._rolling_sq_sum - old_first * old_first + val * val

        n = self._period
        mean = temp_sum / n
        variance = (temp_sq / n) - (mean * mean)
        std = math.sqrt(max(variance, 0.0))

        self._preview["middle"] = mean
        self._preview["upper"] = mean + self._mult * std
        self._preview["lower"] = mean - self._mult * std

    def update_closed(self, bar: BarData) -> None:
        val = self._get_field(bar, self._source)
        self._bar_count += 1

        if len(self._window) == self._period:
            old = self._window[0]
            self._rolling_sum -= old
            self._rolling_sq_sum -= old * old

        self._window.append(val)
        self._rolling_sum += val
        self._rolling_sq_sum += val * val

        if len(self._window) >= self._period:
            mid, upper, lower = self._compute()
            self._append_output("middle", bar.time, mid)
            self._append_output("upper", bar.time, upper)
            self._append_output("lower", bar.time, lower)
        else:
            self._append_output("middle", bar.time, None)
            self._append_output("upper", bar.time, None)
            self._append_output("lower", bar.time, None)

    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name=f"BOLL({self._period},{self._mult})",
            category="Volatility",
            description=f"Bollinger Bands ({self._period}, {self._mult})",
            pane=PaneType.MAIN,
            overlay=True,
            warmup_period=self._period,
        )

    def _get_output_configs(self) -> dict[str, dict]:
        return {
            "middle": {
                "display_name": f"BOLL Mid({self._period})",
                "color": self.params.get("color_middle", "#f59e0b"),
            },
            "upper": {
                "display_name": "BOLL Upper",
                "color": self.params.get("color_upper", "#ef4444"),
                "line_style": 2,
            },
            "lower": {
                "display_name": "BOLL Lower",
                "color": self.params.get("color_lower", "#22c55e"),
                "line_style": 2,
            },
        }

    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        return IndicatorSpec(
            name="BOLL",
            display_name="Bollinger Bands",
            description="Bollinger Bands",
            category="Volatility",
            input_specs=["close"],
            output_specs=["middle", "upper", "lower"],
            param_schema=[
                IndicatorParam(key="period", label="Period", type="int", default=20, min=2, max=200),
                IndicatorParam(key="mult", label="Multiplier", type="float", default=2.0, min=0.5, max=5.0, step=0.5),
                IndicatorParam(key="source", label="Source", type="string", default="close",
                               options=["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]),
                IndicatorParam(key="color_middle", label="Middle Color", type="color", default="#f59e0b"),
                IndicatorParam(key="color_upper", label="Upper Color", type="color", default="#ef4444"),
                IndicatorParam(key="color_lower", label="Lower Color", type="color", default="#22c55e"),
            ],
            default_params={
                "period": 20, "mult": 2.0, "source": "close",
                "color_middle": "#f59e0b", "color_upper": "#ef4444", "color_lower": "#22c55e",
            },
        )
