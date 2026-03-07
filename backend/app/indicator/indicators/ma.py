# -*- coding: utf-8 -*-
"""
MA -- Simple Moving Average indicator.

Validates the window-based indicator pattern.
Supports O(1) incremental update via rolling sum.
"""
from __future__ import annotations

from collections import deque
from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType


class MAIndicator(Indicator):
    name = "MA"
    version = "1.0"
    input_specs = ["close"]
    output_specs = ["ma"]
    warmup_period = 1  # dynamic, set from params

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)
        self._period: int = int(self.params.get("period", 20))
        self._source: str = self.params.get("source", "close")
        self.warmup_period = self._period
        # Rolling state
        self._window: deque[float] = deque(maxlen=self._period)
        self._rolling_sum: float = 0.0

    def _reset_state(self) -> None:
        self._window.clear()
        self._rolling_sum = 0.0

    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            val = self._get_field(bar, self._source)
            if len(self._window) == self._period:
                self._rolling_sum -= self._window[0]
            self._window.append(val)
            self._rolling_sum += val

            if len(self._window) >= self._period:
                ma_val = self._rolling_sum / self._period
                self._append_output("ma", bar.time, ma_val)
            else:
                self._append_output("ma", bar.time, None)

        self._bar_count = len(bars)
        self._initialized = True

    def update_partial(self, bar: BarData) -> None:
        if len(self._window) < self._period:
            self._preview["ma"] = None
            return
        val = self._get_field(bar, self._source)
        preview_sum = self._rolling_sum - self._window[0] + val
        self._preview["ma"] = preview_sum / self._period

    def update_closed(self, bar: BarData) -> None:
        val = self._get_field(bar, self._source)
        if len(self._window) == self._period:
            self._rolling_sum -= self._window[0]
        self._window.append(val)
        self._rolling_sum += val
        self._bar_count += 1

        if len(self._window) >= self._period:
            ma_val = self._rolling_sum / self._period
            self._append_output("ma", bar.time, ma_val)
        else:
            self._append_output("ma", bar.time, None)

    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name=f"MA({self._period})",
            category="Trend",
            description=f"Simple Moving Average ({self._period})",
            pane=PaneType.MAIN,
            overlay=True,
            warmup_period=self._period,
        )

    def _get_output_configs(self) -> dict[str, dict]:
        return {
            "ma": {
                "display_name": f"MA({self._period})",
                "color": self.params.get("color", "#f59e0b"),
            }
        }

    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        return IndicatorSpec(
            name="MA",
            display_name="Simple Moving Average",
            description="Simple Moving Average",
            category="Trend",
            input_specs=["close"],
            output_specs=["ma"],
            param_schema=[
                IndicatorParam(key="period", label="Period", type="int", default=20, min=1, max=500),
                IndicatorParam(key="source", label="Source", type="string", default="close",
                               options=["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]),
                IndicatorParam(key="color", label="Color", type="color", default="#f59e0b"),
            ],
            default_params={"period": 20, "source": "close", "color": "#f59e0b"},
        )
