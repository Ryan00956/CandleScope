# -*- coding: utf-8 -*-
"""
RSI -- Relative Strength Index indicator.

Validates stateful recursive oscillator pattern.
Uses Wilder's smoothing (equivalent to EMA with alpha = 1/period).
"""
from __future__ import annotations

from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType


class RSIIndicator(Indicator):
    name = "RSI"
    version = "1.0"
    input_specs = ["close"]
    output_specs = ["rsi"]
    warmup_period = 14

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)
        self._period: int = int(self.params.get("period", 14))
        self._source: str = self.params.get("source", "close")
        self.warmup_period = self._period + 1

        self._avg_gain: float = 0.0
        self._avg_loss: float = 0.0
        self._prev_val: float | None = None
        self._count: int = 0
        self._init_gains: list[float] = []
        self._init_losses: list[float] = []

    def _reset_state(self) -> None:
        self._avg_gain = 0.0
        self._avg_loss = 0.0
        self._prev_val = None
        self._count = 0
        self._init_gains = []
        self._init_losses = []

    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            val = self._get_field(bar, self._source)
            self._count += 1

            if self._prev_val is None:
                self._prev_val = val
                self._append_output("rsi", bar.time, None)
                continue

            change = val - self._prev_val
            gain = max(change, 0.0)
            loss = max(-change, 0.0)
            self._prev_val = val

            if self._count <= self._period + 1:
                self._init_gains.append(gain)
                self._init_losses.append(loss)

                if self._count == self._period + 1:
                    self._avg_gain = sum(self._init_gains) / self._period
                    self._avg_loss = sum(self._init_losses) / self._period
                    rsi = self._compute_rsi()
                    self._append_output("rsi", bar.time, rsi)
                else:
                    self._append_output("rsi", bar.time, None)
            else:
                self._avg_gain = (self._avg_gain * (self._period - 1) + gain) / self._period
                self._avg_loss = (self._avg_loss * (self._period - 1) + loss) / self._period
                rsi = self._compute_rsi()
                self._append_output("rsi", bar.time, rsi)

        self._bar_count = len(bars)
        self._initialized = True

    def _compute_rsi(self) -> float:
        if self._avg_loss == 0:
            return 100.0
        rs = self._avg_gain / self._avg_loss
        return 100.0 - (100.0 / (1.0 + rs))

    def update_partial(self, bar: BarData) -> None:
        if self._prev_val is None or self._count <= self._period:
            self._preview["rsi"] = None
            return

        val = self._get_field(bar, self._source)
        change = val - self._prev_val
        gain = max(change, 0.0)
        loss = max(-change, 0.0)

        avg_gain = (self._avg_gain * (self._period - 1) + gain) / self._period
        avg_loss = (self._avg_loss * (self._period - 1) + loss) / self._period

        if avg_loss == 0:
            self._preview["rsi"] = 100.0
        else:
            rs = avg_gain / avg_loss
            self._preview["rsi"] = 100.0 - (100.0 / (1.0 + rs))

    def update_closed(self, bar: BarData) -> None:
        val = self._get_field(bar, self._source)
        self._count += 1
        self._bar_count += 1

        if self._prev_val is None:
            self._prev_val = val
            self._append_output("rsi", bar.time, None)
            return

        change = val - self._prev_val
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        self._prev_val = val

        if self._count <= self._period + 1:
            self._init_gains.append(gain)
            self._init_losses.append(loss)

            if self._count == self._period + 1:
                self._avg_gain = sum(self._init_gains) / self._period
                self._avg_loss = sum(self._init_losses) / self._period
                rsi = self._compute_rsi()
                self._append_output("rsi", bar.time, rsi)
            else:
                self._append_output("rsi", bar.time, None)
        else:
            self._avg_gain = (self._avg_gain * (self._period - 1) + gain) / self._period
            self._avg_loss = (self._avg_loss * (self._period - 1) + loss) / self._period
            rsi = self._compute_rsi()
            self._append_output("rsi", bar.time, rsi)

    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name=f"RSI({self._period})",
            category="Oscillator",
            description=f"Relative Strength Index ({self._period})",
            pane=PaneType.SEPARATE,
            overlay=False,
            precision=2,
            warmup_period=self.warmup_period,
        )

    def _get_output_configs(self) -> dict[str, dict]:
        return {
            "rsi": {
                "display_name": f"RSI({self._period})",
                "color": self.params.get("color", "#a855f7"),
                "pane": PaneType.SEPARATE,
            }
        }

    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        return IndicatorSpec(
            name="RSI",
            display_name="Relative Strength Index",
            description="Relative Strength Index",
            category="Oscillator",
            input_specs=["close"],
            output_specs=["rsi"],
            param_schema=[
                IndicatorParam(key="period", label="Period", type="int", default=14, min=2, max=100),
                IndicatorParam(key="source", label="Source", type="string", default="close",
                               options=["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]),
                IndicatorParam(key="color", label="Color", type="color", default="#a855f7"),
            ],
            default_params={"period": 14, "source": "close", "color": "#a855f7"},
        )
