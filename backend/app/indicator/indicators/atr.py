# -*- coding: utf-8 -*-
"""
ATR -- Average True Range indicator.

Validates multi-input (high/low/close) indicator pattern.
Uses Wilder's smoothing for the average.
"""
from __future__ import annotations

from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType


class ATRIndicator(Indicator):
    name = "ATR"
    version = "1.0"
    input_specs = ["high", "low", "close"]
    output_specs = ["atr"]
    warmup_period = 14

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)
        self._period: int = int(self.params.get("period", 14))
        self.warmup_period = self._period + 1

        self._atr: float | None = None
        self._prev_close: float | None = None
        self._count: int = 0
        self._tr_sum: float = 0.0

    def _reset_state(self) -> None:
        self._atr = None
        self._prev_close = None
        self._count = 0
        self._tr_sum = 0.0

    @staticmethod
    def _true_range(high: float, low: float, prev_close: float | None) -> float:
        """Compute True Range."""
        hl = high - low
        if prev_close is None:
            return hl
        hc = abs(high - prev_close)
        lc = abs(low - prev_close)
        return max(hl, hc, lc)

    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            tr = self._true_range(bar.high, bar.low, self._prev_close)
            self._prev_close = bar.close
            self._count += 1

            if self._count <= self._period:
                self._tr_sum += tr
                if self._count == self._period:
                    self._atr = self._tr_sum / self._period
                    self._append_output("atr", bar.time, self._atr)
                else:
                    self._append_output("atr", bar.time, None)
            else:
                self._atr = (self._atr * (self._period - 1) + tr) / self._period
                self._append_output("atr", bar.time, self._atr)

        self._bar_count = len(bars)
        self._initialized = True

    def update_partial(self, bar: BarData) -> None:
        if self._atr is None or self._prev_close is None:
            self._preview["atr"] = None
            return

        tr = self._true_range(bar.high, bar.low, self._prev_close)
        self._preview["atr"] = (self._atr * (self._period - 1) + tr) / self._period

    def update_closed(self, bar: BarData) -> None:
        tr = self._true_range(bar.high, bar.low, self._prev_close)
        self._prev_close = bar.close
        self._count += 1
        self._bar_count += 1

        if self._atr is None:
            self._tr_sum += tr
            if self._count == self._period:
                self._atr = self._tr_sum / self._period
                self._append_output("atr", bar.time, self._atr)
            else:
                self._append_output("atr", bar.time, None)
        else:
            self._atr = (self._atr * (self._period - 1) + tr) / self._period
            self._append_output("atr", bar.time, self._atr)

    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name=f"ATR({self._period})",
            category="Volatility",
            description=f"Average True Range ({self._period})",
            pane=PaneType.SEPARATE,
            overlay=False,
            warmup_period=self.warmup_period,
        )

    def _get_output_configs(self) -> dict[str, dict]:
        return {
            "atr": {
                "display_name": f"ATR({self._period})",
                "color": self.params.get("color", "#06b6d4"),
                "pane": PaneType.SEPARATE,
            }
        }

    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        return IndicatorSpec(
            name="ATR",
            display_name="Average True Range",
            description="Average True Range",
            category="Volatility",
            input_specs=["high", "low", "close"],
            output_specs=["atr"],
            param_schema=[
                IndicatorParam(key="period", label="Period", type="int", default=14, min=1, max=100),
                IndicatorParam(key="color", label="Color", type="color", default="#06b6d4"),
            ],
            default_params={"period": 14, "color": "#06b6d4"},
        )
