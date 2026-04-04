# -*- coding: utf-8 -*-
"""
VOL -- Volume indicator.

Displays volume as a histogram with up/down bar coloring.
Optionally shows a volume moving average line.
"""
from __future__ import annotations

from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import (
    IndicatorMeta,
    IndicatorParam,
    IndicatorSpec,
    PaneType,
    SeriesType,
)


class VOLIndicator(Indicator):
    name = "VOL"
    version = "1.0"
    input_specs = ["volume", "close"]
    output_specs = ["vol"]
    warmup_period = 0

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)
        self._up_color: str = self.params.get("up_color", "#22c55e")
        self._down_color: str = self.params.get("down_color", "#ef4444")

        # Track per-bar colors for histogram coloring
        self._color_data: list[dict] = []

    def _reset_state(self) -> None:
        self._color_data = []

    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            vol = bar.volume
            # Determine color: bullish (close >= open) or bearish
            color = self._up_color if bar.close >= bar.open else self._down_color

            self._append_output("vol", bar.time, vol)
            self._color_data.append({"time": bar.time, "color": color})

        self._bar_count = len(bars)
        self._initialized = True

    def update_partial(self, bar: BarData) -> None:
        self._preview["vol"] = bar.volume

    def update_closed(self, bar: BarData) -> None:
        vol = bar.volume
        color = self._up_color if bar.close >= bar.open else self._down_color

        self._append_output("vol", bar.time, vol)
        self._color_data.append({"time": bar.time, "color": color})
        self._bar_count += 1

    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name="VOL",
            category="成交量",
            description="成交量柱状图",
            pane=PaneType.VOLUME,
            overlay=False,
            precision=2,
            warmup_period=0,
        )

    def _get_output_configs(self) -> dict[str, dict]:
        return {
            "vol": {
                "display_name": "VOL",
                "color": self._up_color,
                "series_type": SeriesType.HISTOGRAM,
                "pane": PaneType.VOLUME,
                "color_data": self._color_data,
            }
        }

    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        return IndicatorSpec(
            name="VOL",
            display_name="成交量",
            description="成交量柱状图，颜色跟随K线设置",
            category="成交量",
            input_specs=["volume", "close"],
            output_specs=["vol"],
            param_schema=[
                IndicatorParam(key="up_color", label="上涨颜色", type="color", default="#22c55e"),
                IndicatorParam(key="down_color", label="下跌颜色", type="color", default="#ef4444"),
            ],
            default_params={"up_color": "#22c55e", "down_color": "#ef4444"},
        )
