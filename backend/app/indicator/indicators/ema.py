# -*- coding: utf-8 -*-
"""
EMA -- Exponential Moving Average indicator.

Validates the recursive-state indicator pattern.
O(1) incremental update: EMA_t = alpha * price + (1-alpha) * EMA_{t-1}
"""
from __future__ import annotations

from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType


class EMAIndicator(Indicator):
    name = "EMA"
    version = "1.0"
    input_specs = ["close"]
    output_specs = ["ema"]
    warmup_period = 1

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)
        self._period: int = int(self.params.get("period", 20))
        self._source: str = self.params.get("source", "close")
        self.warmup_period = self._period
        self._alpha: float = 2.0 / (self._period + 1)
        self._ema: float | None = None
        self._count: int = 0
        self._sum: float = 0.0

    def _reset_state(self) -> None:
        self._ema = None
        self._count = 0
        self._sum = 0.0

    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            val = self._get_field(bar, self._source)
            self._count += 1

            if self._count < self._period:
                self._sum += val
                self._append_output("ema", bar.time, None)
            elif self._count == self._period:
                self._sum += val
                self._ema = self._sum / self._period
                self._append_output("ema", bar.time, self._ema)
            else:
                self._ema = self._alpha * val + (1 - self._alpha) * self._ema
                self._append_output("ema", bar.time, self._ema)

        self._bar_count = len(bars)
        self._initialized = True

    def update_partial(self, bar: BarData) -> None:
        if self._ema is None:
            self._preview["ema"] = None
            return
        val = self._get_field(bar, self._source)
        self._preview["ema"] = self._alpha * val + (1 - self._alpha) * self._ema

    def update_closed(self, bar: BarData) -> None:
        val = self._get_field(bar, self._source)
        self._count += 1
        self._bar_count += 1

        if self._ema is None:
            self._sum += val
            if self._count >= self._period:
                self._ema = self._sum / self._period
                self._append_output("ema", bar.time, self._ema)
            else:
                self._append_output("ema", bar.time, None)
        else:
            self._ema = self._alpha * val + (1 - self._alpha) * self._ema
            self._append_output("ema", bar.time, self._ema)

    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name=f"EMA({self._period})",
            category="Trend",
            description=f"Exponential Moving Average ({self._period})",
            pane=PaneType.MAIN,
            overlay=True,
            warmup_period=self._period,
        )

    def _get_output_configs(self) -> dict[str, dict]:
        return {
            "ema": {
                "display_name": f"EMA({self._period})",
                "color": self.params.get("color", "#3b82f6"),
            }
        }

    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        return IndicatorSpec(
            name="EMA",
            display_name="Exponential Moving Average",
            description="Exponential Moving Average",
            category="Trend",
            input_specs=["close"],
            output_specs=["ema"],
            param_schema=[
                IndicatorParam(key="period", label="Period", type="int", default=20, min=1, max=500),
                IndicatorParam(key="source", label="Source", type="string", default="close",
                               options=["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]),
                IndicatorParam(key="color", label="Color", type="color", default="#3b82f6"),
            ],
            default_params={"period": 20, "source": "close", "color": "#3b82f6"},
        )
