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

from dataclasses import dataclass
from typing import Any

import numpy as np


class _Namespace:
    def __init__(self, **entries: str) -> None:
        self.__dict__.update(entries)


# ═══════════════════════════════════════════════════════════════
#  Plot Reference (returned by plot() for use with fill())
# ═══════════════════════════════════════════════════════════════

@dataclass
class PlotRef:
    """Opaque reference to a plotted line, used by ``fill()``."""
    id: str
    title: str
    pane: str = "main"


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
        self.signals: list[dict[str, Any]] = []
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
        if self.signals:
            result["signals"] = self.signals

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

    def _values_from_data(data: np.ndarray | list | Any) -> list:
        if isinstance(data, np.ndarray):
            return data.tolist()
        if isinstance(data, list):
            return data
        return [data] * len(collector.times)

    def _color_for_index(color_data: Any, idx: int, timestamp: int) -> str | None:
        if color_data is None:
            return None
        if isinstance(color_data, np.ndarray):
            if idx < len(color_data):
                return str(color_data[idx])
            return None
        if isinstance(color_data, list):
            if idx >= len(color_data):
                return None
            item = color_data[idx]
            if isinstance(item, dict):
                if item.get("time") == timestamp or "time" not in item:
                    return str(item.get("color")) if item.get("color") else None
                return None
            return str(item) if item else None
        return str(color_data) if color_data else None

    def _is_valid_value(value: Any) -> bool:
        return value is not None and not (isinstance(value, float) and np.isnan(value))

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

        values = _values_from_data(data)

        # Build data points: [{time, value}, ...]
        points = []
        for i, (t, v) in enumerate(zip(collector.times, values)):
            if _is_valid_value(v):
                point: dict[str, Any] = {"time": t, "value": round(float(v), 8)}
                # Per-bar coloring
                if color_array is not None:
                    point_color = _color_for_index(color_array, i, t)
                    if point_color:
                        point["color"] = point_color
                points.append(point)

        # Determine pane
        if pane is None:
            if overlay is not None:
                pane = "main" if overlay else "separate"
            elif collector._indicator_meta.get("overlay", True):
                pane = "main"
            else:
                pane = "separate"

        if str(style).lower() in {"histogram", "columns", "column", "bar"}:
            hist_points = []
            for i, (t, v) in enumerate(zip(collector.times, values)):
                if not _is_valid_value(v):
                    continue
                point = {"time": t, "value": round(float(v), 8)}
                point_color = _color_for_index(color_array if color_array is not None else color, i, t)
                if point_color:
                    point["color"] = point_color
                hist_points.append(point)
            collector.histograms.append({
                "title": title or plot_id,
                "color_up": str(color) if not isinstance(color, np.ndarray) else "#26a69a",
                "color_down": str(color) if not isinstance(color, np.ndarray) else "#ef5350",
                "pane": pane,
                "data": hist_points,
            })
            return PlotRef(id=plot_id, title=title, pane=pane)

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
        return PlotRef(id=plot_id, title=title, pane=pane)

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
        values = _values_from_data(data)

        if pane is None:
            pane = "separate"

        points = []
        for t, v in zip(collector.times, values):
            if _is_valid_value(v):
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
            "pane": plot1.pane if plot1.pane == plot2.pane else "separate",
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
        location: str | None = None,
        size: str = "normal",
        pane: str | None = None,
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
            pane: "main" or "separate".
        """
        if location is not None:
            position = location
        if pane is None:
            pane = "separate" if not collector._indicator_meta.get("overlay", True) else "main"

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
                    "pane": pane,
                })

        if marks:
            collector.markers.append({
                "shape": shape,
                "color": color,
                "text": text,
                "position": position,
                "size": size,
                "pane": pane,
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

    def emit_signal(
        condition: np.ndarray | bool,
        name: str = "",
        side: str = "buy",
        message: str = "",
        strength: float | None = None,
        price: np.ndarray | float | None = None,
        payload: dict[str, Any] | None = None,
        pane: str = "main",
    ) -> None:
        """Emit structured buy/sell/alert signals without placing orders.

        The indicator system only reports these events. Future Strategy or
        Trading modules may consume them, but Pyne indicators do not manage API
        keys or submit orders.
        """
        if isinstance(condition, np.ndarray):
            flags = condition.tolist()
        elif isinstance(condition, list):
            flags = condition
        else:
            flags = [bool(condition)] * len(collector.times)

        prices = _values_from_data(price) if price is not None else [None] * len(collector.times)
        normalized_side = str(side or "alert").lower()
        data = []
        for t, flag, signal_price in zip(collector.times, flags, prices):
            if not flag:
                continue
            point: dict[str, Any] = {
                "time": t,
                "side": normalized_side,
                "name": name or normalized_side,
                "message": message,
            }
            if strength is not None:
                point["strength"] = float(strength)
            if signal_price is not None and _is_valid_value(signal_price):
                point["price"] = round(float(signal_price), 8)
            if payload:
                point["payload"] = payload
            data.append(point)

        if data:
            collector.signals.append({
                "name": name or normalized_side,
                "side": normalized_side,
                "message": message,
                "pane": pane,
                "data": data,
            })

    def alertcondition(
        condition: np.ndarray | bool,
        title: str = "",
        message: str = "",
        side: str = "alert",
    ) -> None:
        """Pine-style alert condition helper."""
        emit_signal(
            condition,
            name=title or side,
            side=side,
            message=message,
            pane="main",
        )

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
        pane: str | None = None,
        line_width: int | None = None,
        line_style: str | int | None = None,
        overlay: bool | None = None,
        type: str = "line",
        color_data: list | np.ndarray | None = None,
        colorData: list | np.ndarray | None = None,
        linewidth: int | None = None,
        style: str | int | None = None,
        **_: Any,
    ) -> None:
        """Legacy ``add_line()`` — maps to ``plot()`` for backward compatibility."""
        resolved_pane = pane
        if resolved_pane is None:
            if overlay is None:
                resolved_pane = "main"
            else:
                resolved_pane = "main" if overlay else "separate"

        resolved_width = linewidth if linewidth is not None else line_width
        if resolved_width is None:
            resolved_width = 2

        resolved_style = style if style is not None else line_style
        if resolved_style is None:
            resolved_style = "solid"

        resolved_color_data = colorData if colorData is not None else color_data
        series_type = (type or "line").lower()

        if series_type in {"histogram", "bar", "columns", "column"}:
            values = _values_from_data(data)
            points = []
            for idx, (t, v) in enumerate(zip(collector.times, values)):
                if not _is_valid_value(v):
                    continue
                point = {"time": t, "value": round(float(v), 8)}
                point_color = _color_for_index(resolved_color_data, idx, t)
                if point_color:
                    point["color"] = point_color
                points.append(point)

            collector.histograms.append({
                "title": title,
                "color_up": color,
                "color_down": color,
                "pane": resolved_pane,
                "data": points,
            })
            return

        plot(
            data,
            title=title,
            color=color,
            linewidth=resolved_width,
            style=resolved_style,
            overlay=overlay,
            pane=resolved_pane,
            color_array=resolved_color_data,
        )

    plot.style_line = "line"
    plot.style_histogram = "histogram"
    plot.style_columns = "histogram"
    hline.style_solid = "solid"
    hline.style_dashed = "dashed"
    hline.style_dotted = "dotted"

    return {
        "indicator": indicator,
        "plot": plot,
        "bar": bar,
        "hline": hline,
        "fill": fill,
        "bgcolor": bgcolor,
        "marker": marker,
        "barcolor": barcolor,
        "emit_signal": emit_signal,
        "alertcondition": alertcondition,
        "label": label_func,
        "add_line": add_line,
        "shape": _Namespace(
            triangleup="triangle_up",
            triangledown="triangle_down",
            circle="circle",
            cross="cross",
            diamond="diamond",
            arrowup="arrow_up",
            arrowdown="arrow_down",
        ),
        "location": _Namespace(
            abovebar="above",
            belowbar="below",
            top="above",
            bottom="below",
        ),
    }
