"""
Pyne Plot — Pine-style drawing API.

Provides ``plot()``, ``hline()``, ``fill()``, ``marker()``, ``bgcolor()``,
``barcolor()``, ``label()`` — matching TradingView Pine Script's drawing
functions as closely as possible.

Each function records its output into a shared ``OutputCollector`` which
the runtime reads after script execution to build the response.

Usage::

    p1 = plot(upper, "Upper", color="#ef4444")
    p2 = plot(lower, "Lower", color="#22c55e")
    fill(p1, p2, color="rgba(59,130,246,0.1)")
    hline(70, "OB", color="#ef4444", linestyle="dashed")
    marker(crossover(fast, slow), shape="triangle_up", color="#26a69a", text="Buy")
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


# ═══════════════════════════════════════════════════════════════
#  Plot Reference (returned by plot() for use with fill())
# ═══════════════════════════════════════════════════════════════

@dataclass
class PlotRef:
    """Opaque reference to a plotted line, used by ``fill()``."""
    id: str
    title: str


# ═══════════════════════════════════════════════════════════════
#  Output Collector
# ═══════════════════════════════════════════════════════════════

class OutputCollector:
    """Collects all drawing outputs from a script execution.

    The runtime creates one per execution and passes it to all
    plot/drawing functions. After execution, it's read to build
    the JSON response.
    """

    def __init__(self, times: list[int]) -> None:
        self.times = times
        self.lines: list[dict[str, Any]] = []
        self.histograms: list[dict[str, Any]] = []
        self.hlines: list[dict[str, Any]] = []
        self.fills: list[dict[str, Any]] = []
        self.markers: list[dict[str, Any]] = []
        self.bgcolors: list[dict[str, Any]] = []
        self.labels: list[dict[str, Any]] = []
        self.barcolors: list[dict[str, Any]] = []
        self._indicator_meta: dict[str, Any] = {}
        self._plot_counter: int = 0

    def _next_id(self) -> str:
        self._plot_counter += 1
        return f"plot_{self._plot_counter}"

    def set_indicator_meta(self, title: str = "", overlay: bool = True, **kwargs: Any) -> None:
        """Set indicator metadata (from ``indicator()`` call)."""
        self._indicator_meta = {
            "title": title,
            "overlay": overlay,
            **kwargs,
        }

    @property
    def indicator_meta(self) -> dict[str, Any]:
        return self._indicator_meta

    def to_dict(self) -> dict[str, Any]:
        """Serialize all outputs for JSON response."""
        result: dict[str, Any] = {}

        if self._indicator_meta:
            result["meta"] = self._indicator_meta

        if self.lines:
            result["lines"] = self.lines
        if self.histograms:
            result["histograms"] = self.histograms
        if self.hlines:
            result["hlines"] = self.hlines
        if self.fills:
            result["fills"] = self.fills
        if self.markers:
            result["markers"] = self.markers
        if self.bgcolors:
            result["bgcolors"] = self.bgcolors
        if self.labels:
            result["labels"] = self.labels
        if self.barcolors:
            result["barcolors"] = self.barcolors

        return result


# ═══════════════════════════════════════════════════════════════
#  Drawing Function Factories
# ═══════════════════════════════════════════════════════════════

def create_plot_functions(collector: OutputCollector) -> dict[str, Any]:
    """Create all plot/drawing functions bound to a collector.

    Returns a dict of {name: function} to be injected into script globals.
    """

    def indicator(title: str = "", overlay: bool = True, **kwargs: Any) -> None:
        """Declare indicator metadata.

        Pine equivalent: ``indicator("My Indicator", overlay=true)``
        """
        collector.set_indicator_meta(title=title, overlay=overlay, **kwargs)

    def plot(
        data: np.ndarray | list,
        title: str = "",
        color: str | np.ndarray = "#f59e0b",
        linewidth: int = 2,
        style: str = "solid",
        overlay: bool | None = None,
        pane: str | None = None,
        color_array: np.ndarray | None = None,
    ) -> PlotRef:
        """Plot a line series.

        Pine equivalent: ``plot(ta.sma(close, 20), "SMA", color=color.orange)``

        Args:
            data: Array of values to plot.
            title: Display title.
            color: Line color (hex string, or per-bar array).
            linewidth: Line width in pixels.
            style: "solid", "dashed", "dotted".
            overlay: True = on price chart, False = separate pane.
            pane: Explicit pane assignment ("main" or "separate").
            color_array: Per-bar color array (overrides ``color``).

        Returns:
            PlotRef for use with ``fill()``.
        """
        plot_id = collector._next_id()

        # Convert data to serializable format
        if isinstance(data, np.ndarray):
            values = data.tolist()
        elif isinstance(data, list):
            values = data
        else:
            values = [data] * len(collector.times)

        # Build data points: [{time, value}, ...]
        points = []
        for i, (t, v) in enumerate(zip(collector.times, values)):
            if v is not None and not (isinstance(v, float) and np.isnan(v)):
                point: dict[str, Any] = {"time": t, "value": round(float(v), 8)}
                # Per-bar coloring
                if color_array is not None:
                    point["color"] = str(color_array[i]) if isinstance(color_array, np.ndarray) else str(color_array)
                points.append(point)

        # Determine pane
        if pane is None:
            if overlay is not None:
                pane = "main" if overlay else "separate"
            elif collector._indicator_meta.get("overlay", True):
                pane = "main"
            else:
                pane = "separate"

        line_entry: dict[str, Any] = {
            "id": plot_id,
            "title": title or plot_id,
            "color": str(color) if not isinstance(color, np.ndarray) else str(color[0]) if len(color) > 0 else "#f59e0b",
            "linewidth": linewidth,
            "style": style,
            "pane": pane,
            "data": points,
        }

        if color_array is not None or isinstance(color, np.ndarray):
            line_entry["per_bar_color"] = True

        collector.lines.append(line_entry)
        return PlotRef(id=plot_id, title=title)

    def bar(
        data: np.ndarray | list,
        title: str = "",
        color_up: str = "#26a69a",
        color_down: str = "#ef5350",
        pane: str | None = None,
    ) -> None:
        """Plot a histogram / bar chart.

        Pine equivalent: ``plotshape`` or custom histogram plotting.

        Commonly used for MACD histogram, volume bars, etc.

        Args:
            data: Array of values.
            title: Display title.
            color_up: Color for positive values.
            color_down: Color for negative values.
            pane: "main" or "separate".
        """
        if isinstance(data, np.ndarray):
            values = data.tolist()
        elif isinstance(data, list):
            values = data
        else:
            values = [data] * len(collector.times)

        if pane is None:
            pane = "separate"

        points = []
        for t, v in zip(collector.times, values):
            if v is not None and not (isinstance(v, float) and np.isnan(v)):
                fv = float(v)
                points.append({
                    "time": t,
                    "value": round(fv, 8),
                    "color": color_up if fv >= 0 else color_down,
                })

        collector.histograms.append({
            "title": title,
            "color_up": color_up,
            "color_down": color_down,
            "pane": pane,
            "data": points,
        })

    def hline(
        price: float,
        title: str = "",
        color: str = "#787b86",
        linestyle: str = "dashed",
        linewidth: int = 1,
        pane: str | None = None,
    ) -> None:
        """Plot a horizontal reference line.

        Pine equivalent: ``hline(70, "OB", color=color.red, linestyle=hline.style_dashed)``
        """
        if pane is None:
            pane = "separate" if not collector._indicator_meta.get("overlay", True) else "main"

        collector.hlines.append({
            "price": float(price),
            "title": title,
            "color": color,
            "linestyle": linestyle,
            "linewidth": linewidth,
            "pane": pane,
        })

    def fill(
        plot1: PlotRef,
        plot2: PlotRef,
        color: str = "rgba(59,130,246,0.1)",
        title: str = "",
    ) -> None:
        """Fill the area between two plotted lines.

        Pine equivalent: ``fill(p1, p2, color=color.new(color.blue, 90))``

        Args:
            plot1: First PlotRef (from ``plot()``).
            plot2: Second PlotRef (from ``plot()``).
            color: Fill color (use rgba for transparency).
        """
        collector.fills.append({
            "plot1_id": plot1.id,
            "plot2_id": plot2.id,
            "color": color,
            "title": title,
        })

    def bgcolor(
        condition: np.ndarray | bool,
        color: str = "rgba(59,130,246,0.1)",
        pane: str | None = None,
        title: str = "",
    ) -> None:
        """Conditional background coloring.

        Pine equivalent: ``bgcolor(rsi > 70 ? color.new(color.red, 90) : na)``

        Args:
            condition: Boolean array — True where background should be colored.
            color: Background color.
            pane: "main" or "separate".
        """
        if pane is None:
            pane = "main"

        if isinstance(condition, np.ndarray):
            regions = []
            for i, (t, c) in enumerate(zip(collector.times, condition)):
                if c:
                    regions.append({"time": t})
        elif condition:
            regions = [{"time": t} for t in collector.times]
        else:
            regions = []

        if regions:
            collector.bgcolors.append({
                "color": color,
                "pane": pane,
                "title": title,
                "regions": regions,
            })

    def marker(
        condition: np.ndarray,
        shape: str = "circle",
        color: str = "#f59e0b",
        text: str = "",
        position: str = "above",
        size: str = "normal",
    ) -> None:
        """Plot markers/shapes at specific bars.

        Pine equivalent: ``plotshape(crossover(fast,slow), style=shape.triangleup)``

        Args:
            condition: Boolean array — True where markers should appear.
            shape: "circle", "triangle_up", "triangle_down", "cross",
                   "diamond", "arrow_up", "arrow_down".
            color: Marker color.
            text: Text to display with the marker.
            position: "above" or "below" the bar.
            size: "tiny", "small", "normal", "large".
        """
        marks = []
        for i, (t, c) in enumerate(zip(collector.times, condition)):
            if c:
                marks.append({
                    "time": t,
                    "shape": shape,
                    "color": color,
                    "text": text,
                    "position": position,
                    "size": size,
                })

        if marks:
            collector.markers.append({
                "shape": shape,
                "color": color,
                "text": text,
                "position": position,
                "size": size,
                "data": marks,
            })

    def barcolor(
        color_arr: np.ndarray | str,
    ) -> None:
        """Color individual candlestick bars.

        Pine equivalent: ``barcolor(close > open ? color.green : color.red)``

        Args:
            color_arr: Array of color strings (one per bar), or a single color.
        """
        if isinstance(color_arr, str):
            colors_list = [color_arr] * len(collector.times)
        elif isinstance(color_arr, np.ndarray):
            colors_list = color_arr.tolist()
        else:
            colors_list = list(color_arr)

        bar_colors = []
        for t, c in zip(collector.times, colors_list):
            if c and c != "":
                bar_colors.append({"time": t, "color": str(c)})

        if bar_colors:
            collector.barcolors.append({"data": bar_colors})

    def label_func(
        text: str,
        position: str = "topright",
        color: str = "#ffffff",
        textcolor: str = "#ffffff",
        pane: str | None = None,
        style: str = "label_down",
    ) -> None:
        """Display a text label on the chart.

        Args:
            text: Text to display.
            position: "topright", "topleft", "bottomright", "bottomleft".
            color: Background color.
            textcolor: Text color.
            pane: "main" or "separate".
            style: Label style.
        """
        if pane is None:
            pane = "main"

        collector.labels.append({
            "text": text,
            "position": position,
            "color": color,
            "textcolor": textcolor,
            "pane": pane,
            "style": style,
        })

    # ── Legacy compatibility ─────────────────────────────────

    def add_line(
        data: np.ndarray | list,
        title: str = "",
        color: str = "#f59e0b",
        pane: str = "main",
    ) -> None:
        """Legacy ``add_line()`` — maps to ``plot()`` for backward compatibility."""
        plot(data, title=title, color=color, pane=pane)

    return {
        "indicator": indicator,
        "plot": plot,
        "bar": bar,
        "hline": hline,
        "fill": fill,
        "bgcolor": bgcolor,
        "marker": marker,
        "barcolor": barcolor,
        "label": label_func,
        "add_line": add_line,
    }
