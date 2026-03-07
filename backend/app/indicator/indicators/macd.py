# -*- coding: utf-8 -*-
"""
MACD -- Moving Average Convergence Divergence indicator.

Validates multi-output indicator pattern.
Three outputs: DIF, DEA (signal), HIST (histogram).
"""
from __future__ import annotations

from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import (
    IndicatorMeta, IndicatorParam, IndicatorSpec,
    PaneType, SeriesType,
)


class MACDIndicator(Indicator):
    name = "MACD"
    version = "1.0"
    input_specs = ["close"]
    output_specs = ["dif", "dea", "hist"]
    warmup_period = 26

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)
        self._fast: int = int(self.params.get("fast", 12))
        self._slow: int = int(self.params.get("slow", 26))
        self._signal: int = int(self.params.get("signal", 9))
        self._source: str = self.params.get("source", "close")
        self.warmup_period = self._slow + self._signal - 1

        self._fast_alpha = 2.0 / (self._fast + 1)
        self._slow_alpha = 2.0 / (self._slow + 1)
        self._signal_alpha = 2.0 / (self._signal + 1)

        self._fast_ema: float | None = None
        self._slow_ema: float | None = None
        self._signal_ema: float | None = None

        self._count: int = 0
        self._fast_sum: float = 0.0
        self._slow_sum: float = 0.0
        self._signal_count: int = 0
        self._signal_sum: float = 0.0

    def _reset_state(self) -> None:
        self._fast_ema = None
        self._slow_ema = None
        self._signal_ema = None
        self._count = 0
        self._fast_sum = 0.0
        self._slow_sum = 0.0
        self._signal_count = 0
        self._signal_sum = 0.0

    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            self._process_bar(bar, append=True)

        self._bar_count = len(bars)
        self._initialized = True

    def _process_bar(self, bar: BarData, append: bool = True) -> tuple[float | None, float | None, float | None]:
        """Process one bar -- returns (dif, dea, hist)."""
        val = self._get_field(bar, self._source)
        self._count += 1

        # Fast EMA
        if self._count < self._fast:
            self._fast_sum += val
            fast_ema = None
        elif self._count == self._fast:
            self._fast_sum += val
            self._fast_ema = self._fast_sum / self._fast
            fast_ema = self._fast_ema
        else:
            self._fast_ema = self._fast_alpha * val + (1 - self._fast_alpha) * self._fast_ema
            fast_ema = self._fast_ema

        # Slow EMA
        if self._count < self._slow:
            self._slow_sum += val
            slow_ema = None
        elif self._count == self._slow:
            self._slow_sum += val
            self._slow_ema = self._slow_sum / self._slow
            slow_ema = self._slow_ema
        else:
            self._slow_ema = self._slow_alpha * val + (1 - self._slow_alpha) * self._slow_ema
            slow_ema = self._slow_ema

        # DIF
        dif = None
        dea = None
        hist = None

        if fast_ema is not None and slow_ema is not None:
            dif = fast_ema - slow_ema

            # Signal EMA (of DIF)
            self._signal_count += 1
            if self._signal_count < self._signal:
                self._signal_sum += dif
            elif self._signal_count == self._signal:
                self._signal_sum += dif
                self._signal_ema = self._signal_sum / self._signal
                dea = self._signal_ema
                hist = 2 * (dif - dea)
            else:
                self._signal_ema = self._signal_alpha * dif + (1 - self._signal_alpha) * self._signal_ema
                dea = self._signal_ema
                hist = 2 * (dif - dea)

        if append:
            self._append_output("dif", bar.time, dif)
            self._append_output("dea", bar.time, dea)
            self._append_output("hist", bar.time, hist)

        return dif, dea, hist

    def update_partial(self, bar: BarData) -> None:
        if self._fast_ema is None or self._slow_ema is None:
            self._preview.update({"dif": None, "dea": None, "hist": None})
            return

        val = self._get_field(bar, self._source)
        fast = self._fast_alpha * val + (1 - self._fast_alpha) * self._fast_ema
        slow = self._slow_alpha * val + (1 - self._slow_alpha) * self._slow_ema
        dif = fast - slow

        if self._signal_ema is not None:
            dea = self._signal_alpha * dif + (1 - self._signal_alpha) * self._signal_ema
            hist = 2 * (dif - dea)
        else:
            dea = None
            hist = None

        self._preview.update({"dif": dif, "dea": dea, "hist": hist})

    def update_closed(self, bar: BarData) -> None:
        self._process_bar(bar, append=True)
        self._bar_count += 1

    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name=f"MACD({self._fast},{self._slow},{self._signal})",
            category="Trend",
            description=f"MACD ({self._fast},{self._slow},{self._signal})",
            pane=PaneType.SEPARATE,
            overlay=False,
            warmup_period=self.warmup_period,
        )

    def _get_output_configs(self) -> dict[str, dict]:
        return {
            "dif": {
                "display_name": "DIF",
                "color": "#3b82f6",
                "pane": PaneType.SEPARATE,
            },
            "dea": {
                "display_name": "DEA",
                "color": "#f59e0b",
                "pane": PaneType.SEPARATE,
            },
            "hist": {
                "display_name": "MACD Hist",
                "color": "#22c55e",
                "series_type": SeriesType.HISTOGRAM,
                "pane": PaneType.SEPARATE,
            },
        }

    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        return IndicatorSpec(
            name="MACD",
            display_name="MACD",
            description="Moving Average Convergence Divergence",
            category="Trend",
            input_specs=["close"],
            output_specs=["dif", "dea", "hist"],
            param_schema=[
                IndicatorParam(key="fast", label="Fast Period", type="int", default=12, min=1, max=100),
                IndicatorParam(key="slow", label="Slow Period", type="int", default=26, min=1, max=200),
                IndicatorParam(key="signal", label="Signal Period", type="int", default=9, min=1, max=50),
                IndicatorParam(key="source", label="Source", type="string", default="close",
                               options=["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]),
            ],
            default_params={"fast": 12, "slow": 26, "signal": 9, "source": "close"},
        )
