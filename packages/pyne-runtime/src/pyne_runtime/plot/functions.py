"""Pine-style plot and drawing function factories."""
from __future__ import annotations

from typing import Any

import numpy as np

from ..series import PyneSeries
from ..state import PyneVar
from ..values import is_na_value
from .collector import OutputCollector
from .objects import _CallableNamespace, _Namespace
from .refs import ObjectRef, PlotRef


def create_plot_functions(collector: OutputCollector) -> dict[str, Any]:
    """Create all plot/drawing functions bound to a collector.

    Returns a dict of {name: function} to be injected into script globals.
    """

    def indicator(title: str = "", overlay: bool = True, **kwargs: Any) -> None:
        """Declare indicator metadata.

        Pine equivalent: ``indicator("My Indicator", overlay=true)``
        """
        collector.set_indicator_meta(title=title, overlay=overlay, **kwargs)

    def _values_from_data(data: PyneSeries | np.ndarray | list | Any) -> list:
        if isinstance(data, PyneVar):
            data = data.get()
        if isinstance(data, PyneSeries):
            return data.to_numpy().tolist()
        if isinstance(data, np.ndarray):
            return data.tolist()
        if isinstance(data, list):
            return data
        if hasattr(data, "to_numpy"):
            return np.asarray(data.to_numpy()).tolist()
        return [data] * len(collector.times)

    def _color_for_index(color_data: Any, idx: int, timestamp: int) -> str | None:
        if color_data is None:
            return None
        if isinstance(color_data, PyneSeries):
            color_data = color_data.to_numpy()
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
            if is_na_value(item):
                return None
            return str(item) if item else None
        if is_na_value(color_data):
            return None
        return str(color_data) if color_data else None

    def _is_valid_value(value: Any) -> bool:
        return not is_na_value(value)

    def _condition_is_true(value: Any) -> bool:
        return False if is_na_value(value) else bool(value)

    def _scalar_from_value(value: Any) -> Any:
        if isinstance(value, PyneVar):
            value = value.get()
        if isinstance(value, PyneSeries):
            values = value.to_numpy().tolist()
        elif isinstance(value, np.ndarray):
            values = value.tolist()
        elif isinstance(value, list):
            values = value
        else:
            return _serialize_scalar(value)

        for item in reversed(values):
            if not is_na_value(item):
                return _serialize_scalar(item)
        return None

    def _serialize_scalar(value: Any) -> Any:
        if is_na_value(value):
            return None
        if isinstance(value, np.generic):
            value = value.item()
        if isinstance(value, bool | str | int):
            return value
        if isinstance(value, float):
            return round(value, 8)
        return value

    def _line_entry(ref: ObjectRef) -> dict[str, Any] | None:
        if not isinstance(ref, ObjectRef) or ref.kind != "line":
            return None
        return collector._object_lines.get(ref.id)

    def _label_entry(ref: ObjectRef) -> dict[str, Any] | None:
        if not isinstance(ref, ObjectRef) or ref.kind != "label":
            return None
        return collector._object_labels.get(ref.id)

    def _box_entry(ref: ObjectRef) -> dict[str, Any] | None:
        if not isinstance(ref, ObjectRef) or ref.kind != "box":
            return None
        return collector._object_boxes.get(ref.id)

    def _table_entry(ref: ObjectRef) -> dict[str, Any] | None:
        if not isinstance(ref, ObjectRef) or ref.kind != "table":
            return None
        return collector._object_tables.get(ref.id)

    def plot(
        data: PyneSeries | np.ndarray | list,
        title: str = "",
        color: str | PyneSeries | np.ndarray = "#f59e0b",
        linewidth: int = 2,
        style: str = "solid",
        overlay: bool | None = None,
        pane: str | None = None,
        color_array: PyneSeries | np.ndarray | None = None,
        display: str | None = None,
        format: str | None = None,
        precision: int | None = None,
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
            display: Pine-like display enum string.
            format: Pine-like numeric format enum string.
            precision: Optional display precision.

        Returns:
            PlotRef for use with ``fill()``.
        """
        plot_id = collector._next_id()

        values = _values_from_data(data)

        # Build data points: [{time, value}, ...]
        points = []
        per_bar_color_source = color_array if color_array is not None else color
        has_per_bar_color = color_array is not None or isinstance(color, (np.ndarray, PyneSeries, list))
        for i, (t, v) in enumerate(zip(collector.times, values)):
            if _is_valid_value(v):
                point: dict[str, Any] = {"time": t, "value": round(float(v), 8)}
                # Per-bar coloring
                if has_per_bar_color:
                    point_color = _color_for_index(per_bar_color_source, i, t)
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
                point_color = _color_for_index(
                    color_array if color_array is not None else color,
                    i,
                    t,
                )
                if point_color:
                    point["color"] = point_color
                hist_points.append(point)
            collector.histograms.append({
                "title": title or plot_id,
                "color_up": (
                    str(color)
                    if not isinstance(color, (np.ndarray, PyneSeries))
                    else "#26a69a"
                ),
                "color_down": (
                    str(color)
                    if not isinstance(color, (np.ndarray, PyneSeries))
                    else "#ef5350"
                ),
                "pane": pane,
                "data": hist_points,
                **_display_options(display=display, format=format, precision=precision),
            })
            return PlotRef(id=plot_id, title=title, pane=pane)

        line_color_values = color.to_numpy() if isinstance(color, PyneSeries) else color
        line_entry: dict[str, Any] = {
            "id": plot_id,
            "title": title or plot_id,
            "color": (
                str(line_color_values)
                if not isinstance(line_color_values, np.ndarray)
                else str(line_color_values[0]) if len(line_color_values) > 0 else "#f59e0b"
            ),
            "linewidth": linewidth,
            "style": style,
            "pane": pane,
            "data": points,
            **_display_options(display=display, format=format, precision=precision),
        }

        if has_per_bar_color:
            line_entry["per_bar_color"] = True

        collector.lines.append(line_entry)
        return PlotRef(id=plot_id, title=title, pane=pane)

    def bar(
        data: PyneSeries | np.ndarray | list,
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
        condition: PyneSeries | np.ndarray | bool,
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

        if isinstance(condition, PyneSeries):
            condition = condition.to_numpy()

        if isinstance(condition, np.ndarray):
            regions = []
            for i, (t, c) in enumerate(zip(collector.times, condition)):
                if _condition_is_true(c):
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
        condition: PyneSeries | np.ndarray | list | bool,
        shape: str = "circle",
        color: str | PyneSeries | np.ndarray | list = "#f59e0b",
        text: str = "",
        char: str | None = None,
        textcolor: str | None = None,
        position: str = "above",
        location: str | None = None,
        size: str = "normal",
        pane: str | None = None,
        title: str = "",
        offset: int = 0,
        show_last: int | None = None,
        display: str | None = None,
        force_overlay: bool = False,
    ) -> None:
        """Plot markers/shapes at specific bars.

        Pine equivalent: ``plotshape(crossover(fast,slow), style=shape.triangleup)``

        Args:
            condition: Boolean array — True where markers should appear.
            shape: "circle", "triangle_up", "triangle_down", "cross",
                   "diamond", "arrow_up", "arrow_down".
            color: Marker color.
            text: Text to display with the marker.
            char: Optional character marker payload for ``plotchar()``.
            textcolor: Optional marker text color.
            position: "above" or "below" the bar.
            size: "tiny", "small", "normal", "large".
            pane: "main" or "separate".
        """
        if location is not None:
            position = location
        if force_overlay:
            pane = "main"
        if pane is None:
            pane = "separate" if not collector._indicator_meta.get("overlay", True) else "main"

        condition_values = _values_from_data(condition)
        offset_value = int(offset)
        first_visible_index = 0
        if show_last is not None:
            first_visible_index = max(len(collector.times) - max(int(show_last), 0), 0)
        entry_color = (
            str(color)
            if not isinstance(color, (PyneSeries, np.ndarray, list))
            else "#f59e0b"
        )

        marks = []
        for i, (t, c) in enumerate(zip(collector.times, condition_values)):
            if i < first_visible_index:
                continue
            if _condition_is_true(c):
                target_index = i + offset_value
                if target_index < 0 or target_index >= len(collector.times):
                    continue
                target_time = collector.times[target_index]
                point_color = _color_for_index(color, i, t) or entry_color
                mark: dict[str, Any] = {
                    "time": target_time,
                    "shape": shape,
                    "color": point_color,
                    "text": text,
                    "position": position,
                    "size": size,
                    "pane": pane,
                }
                if char is not None:
                    mark["char"] = str(char)
                if textcolor is not None:
                    mark["textcolor"] = textcolor
                if position == "absolute" and not isinstance(c, (bool, np.bool_)):
                    try:
                        mark["value"] = round(float(c), 8)
                    except (TypeError, ValueError):
                        pass
                marks.append(mark)

        if marks:
            marker_entry: dict[str, Any] = {
                "shape": shape,
                "color": entry_color,
                "text": text,
                "position": position,
                "size": size,
                "pane": pane,
                "data": marks,
                **_display_options(display=display, format=None, precision=None),
            }
            if title:
                marker_entry["title"] = title
            if char is not None:
                marker_entry["char"] = str(char)
            if textcolor is not None:
                marker_entry["textcolor"] = textcolor
            if offset_value:
                marker_entry["offset"] = offset_value
            if isinstance(color, (PyneSeries, np.ndarray, list)):
                marker_entry["per_bar_color"] = True
            collector.markers.append(marker_entry)

    def plotshape(
        series: PyneSeries | np.ndarray | list | bool,
        title: str = "",
        style: str = "circle",
        location: str = "above",
        color: str | PyneSeries | np.ndarray | list = "#f59e0b",
        offset: int = 0,
        text: str = "",
        textcolor: str | None = None,
        editable: bool = True,
        size: str = "normal",
        show_last: int | None = None,
        display: str | None = None,
        force_overlay: bool = False,
        **_: Any,
    ) -> None:
        """Pine-like ``plotshape()`` wrapper over Pyne marker output."""
        _ = editable
        marker(
            series,
            shape=style,
            color=color,
            text=text,
            textcolor=textcolor,
            location=location,
            size=size,
            title=title,
            offset=offset,
            show_last=show_last,
            display=display,
            force_overlay=force_overlay,
        )

    def plotchar(
        series: PyneSeries | np.ndarray | list | bool,
        title: str = "",
        char: str = "",
        location: str = "above",
        color: str | PyneSeries | np.ndarray | list = "#f59e0b",
        offset: int = 0,
        text: str = "",
        textcolor: str | None = None,
        editable: bool = True,
        size: str = "normal",
        show_last: int | None = None,
        display: str | None = None,
        force_overlay: bool = False,
        **_: Any,
    ) -> None:
        """Pine-like ``plotchar()`` wrapper over Pyne marker output."""
        _ = editable
        glyph = str(char or text or "")
        marker(
            series,
            shape="char",
            color=color,
            text=str(text or glyph),
            char=glyph,
            textcolor=textcolor,
            location=location,
            size=size,
            title=title,
            offset=offset,
            show_last=show_last,
            display=display,
            force_overlay=force_overlay,
        )

    def plotarrow(
        series: PyneSeries | np.ndarray | list | int | float,
        title: str = "",
        colorup: str | PyneSeries | np.ndarray | list = "#26a69a",
        colordown: str | PyneSeries | np.ndarray | list = "#ef5350",
        offset: int = 0,
        minheight: int = 5,
        maxheight: int = 30,
        editable: bool = True,
        show_last: int | None = None,
        display: str | None = None,
        force_overlay: bool = False,
        **_: Any,
    ) -> None:
        """Pine-like ``plotarrow()`` wrapper over Pyne marker output."""
        _ = editable
        pane = "main" if force_overlay else (
            "separate" if not collector._indicator_meta.get("overlay", True) else "main"
        )
        values = _values_from_data(series)
        offset_value = int(offset)
        first_visible_index = 0
        if show_last is not None:
            first_visible_index = max(len(collector.times) - max(int(show_last), 0), 0)

        visible_numbers: list[float] = []
        for idx, item in enumerate(values):
            if idx < first_visible_index or is_na_value(item):
                continue
            try:
                number = float(item)
            except (TypeError, ValueError):
                continue
            if number != 0:
                visible_numbers.append(abs(number))

        max_abs = max(visible_numbers) if visible_numbers else 0.0
        min_height = int(minheight)
        max_height = int(maxheight)
        if max_height < min_height:
            min_height, max_height = max_height, min_height

        marks: list[dict[str, Any]] = []
        for idx, (t, item) in enumerate(zip(collector.times, values)):
            if idx < first_visible_index or is_na_value(item):
                continue
            try:
                number = float(item)
            except (TypeError, ValueError):
                continue
            if number == 0:
                continue

            target_index = idx + offset_value
            if target_index < 0 or target_index >= len(collector.times):
                continue

            is_up = number > 0
            color_data = colorup if is_up else colordown
            fallback_color = (
                str(color_data)
                if not isinstance(color_data, (PyneSeries, np.ndarray, list))
                else "#26a69a" if is_up else "#ef5350"
            )
            if max_abs > 0 and max_height > min_height:
                height = min_height + int(
                    round((max_height - min_height) * (abs(number) / max_abs))
                )
            else:
                height = min_height

            marks.append({
                "time": collector.times[target_index],
                "shape": "arrow_up" if is_up else "arrow_down",
                "color": _color_for_index(color_data, idx, t) or fallback_color,
                "text": "",
                "position": "below" if is_up else "above",
                "size": "normal",
                "pane": pane,
                "direction": "up" if is_up else "down",
                "value": round(number, 8),
                "height": height,
            })

        if marks:
            arrow_entry: dict[str, Any] = {
                "shape": "arrow",
                "color_up": (
                    str(colorup)
                    if not isinstance(colorup, (PyneSeries, np.ndarray, list))
                    else "#26a69a"
                ),
                "color_down": (
                    str(colordown)
                    if not isinstance(colordown, (PyneSeries, np.ndarray, list))
                    else "#ef5350"
                ),
                "text": "",
                "position": "auto",
                "size": "normal",
                "pane": pane,
                "minheight": min_height,
                "maxheight": max_height,
                "data": marks,
                **_display_options(display=display, format=None, precision=None),
            }
            if title:
                arrow_entry["title"] = title
            if offset_value:
                arrow_entry["offset"] = offset_value
            if isinstance(colorup, (PyneSeries, np.ndarray, list)) or isinstance(
                colordown, (PyneSeries, np.ndarray, list)
            ):
                arrow_entry["per_bar_color"] = True
            collector.markers.append(arrow_entry)

    def barcolor(
        color_arr: PyneSeries | np.ndarray | str,
    ) -> None:
        """Color individual candlestick bars.

        Pine equivalent: ``barcolor(close > open ? color.green : color.red)``

        Args:
            color_arr: Array of color strings (one per bar), or a single color.
        """
        if isinstance(color_arr, str):
            colors_list = [color_arr] * len(collector.times)
        elif isinstance(color_arr, PyneSeries):
            colors_list = color_arr.to_numpy().tolist()
        elif isinstance(color_arr, np.ndarray):
            colors_list = color_arr.tolist()
        else:
            colors_list = list(color_arr)

        bar_colors = []
        for t, c in zip(collector.times, colors_list):
            if not is_na_value(c) and c != "":
                bar_colors.append({"time": t, "color": str(c)})

        if bar_colors:
            collector.barcolors.append({"data": bar_colors})

    def emit_signal(
        condition: PyneSeries | np.ndarray | bool,
        name: str = "",
        side: str = "buy",
        message: str = "",
        strength: float | None = None,
        price: PyneSeries | np.ndarray | float | None = None,
        payload: dict[str, Any] | None = None,
        pane: str = "main",
    ) -> None:
        """Emit structured buy/sell/alert signals without placing orders.

        The indicator system only reports these events. Future Strategy or
        Trading modules may consume them, but Pyne indicators do not manage API
        keys or submit orders.
        """
        if isinstance(condition, PyneSeries):
            flags = condition.to_numpy().tolist()
        elif isinstance(condition, np.ndarray):
            flags = condition.tolist()
        elif isinstance(condition, list):
            flags = condition
        else:
            flags = [bool(condition)] * len(collector.times)

        prices = _values_from_data(price) if price is not None else [None] * len(collector.times)
        normalized_side = str(side or "alert").lower()
        data = []
        for t, flag, signal_price in zip(collector.times, flags, prices):
            if not _condition_is_true(flag):
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
        condition: PyneSeries | np.ndarray | bool,
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

    def line_new(
        x1: Any,
        y1: Any,
        x2: Any,
        y2: Any,
        color: str = "#2196f3",
        width: int = 1,
        style: str = "solid",
        extend: str = "none",
        xloc: str = "bar_index",
        pane: str | None = None,
    ) -> ObjectRef:
        if pane is None:
            pane = "main"
        object_id = collector._next_object_id("line")
        collector._object_lines[object_id] = {
            "id": object_id,
            "x1": _scalar_from_value(x1),
            "y1": _scalar_from_value(y1),
            "x2": _scalar_from_value(x2),
            "y2": _scalar_from_value(y2),
            "color": color,
            "width": int(width),
            "style": style,
            "extend": extend,
            "xloc": xloc,
            "pane": pane,
        }
        return ObjectRef(id=object_id, kind="line")

    def line_set_xy1(ref: ObjectRef, x: Any, y: Any) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["x1"] = _scalar_from_value(x)
            entry["y1"] = _scalar_from_value(y)

    def line_set_xy2(ref: ObjectRef, x: Any, y: Any) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["x2"] = _scalar_from_value(x)
            entry["y2"] = _scalar_from_value(y)

    def line_set_x1(ref: ObjectRef, x: Any) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["x1"] = _scalar_from_value(x)

    def line_set_y1(ref: ObjectRef, y: Any) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["y1"] = _scalar_from_value(y)

    def line_set_x2(ref: ObjectRef, x: Any) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["x2"] = _scalar_from_value(x)

    def line_set_y2(ref: ObjectRef, y: Any) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["y2"] = _scalar_from_value(y)

    def line_set_color(ref: ObjectRef, color: str) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["color"] = color

    def line_set_width(ref: ObjectRef, width: int) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["width"] = int(width)

    def line_set_style(ref: ObjectRef, style: str) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["style"] = style

    def line_set_extend(ref: ObjectRef, extend: str) -> None:
        entry = _line_entry(ref)
        if entry is not None:
            entry["extend"] = extend

    def line_delete(ref: ObjectRef) -> None:
        if isinstance(ref, ObjectRef) and ref.kind == "line":
            collector._object_lines.pop(ref.id, None)

    def label_new(
        x: Any,
        y: Any,
        text: str = "",
        color: str = "#ffffff",
        textcolor: str = "#000000",
        style: str = "label_down",
        size: str = "normal",
        xloc: str = "bar_index",
        yloc: str = "price",
        pane: str | None = None,
    ) -> ObjectRef:
        if pane is None:
            pane = "main"
        object_id = collector._next_object_id("label")
        collector._object_labels[object_id] = {
            "id": object_id,
            "x": _scalar_from_value(x),
            "y": _scalar_from_value(y),
            "text": str(text),
            "color": color,
            "textcolor": textcolor,
            "style": style,
            "size": size,
            "xloc": xloc,
            "yloc": yloc,
            "pane": pane,
        }
        return ObjectRef(id=object_id, kind="label")

    def label_set_xy(ref: ObjectRef, x: Any, y: Any) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["x"] = _scalar_from_value(x)
            entry["y"] = _scalar_from_value(y)

    def label_set_x(ref: ObjectRef, x: Any) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["x"] = _scalar_from_value(x)

    def label_set_y(ref: ObjectRef, y: Any) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["y"] = _scalar_from_value(y)

    def label_set_text(ref: ObjectRef, text: str) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["text"] = str(text)

    def label_set_color(ref: ObjectRef, color: str) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["color"] = color

    def label_set_textcolor(ref: ObjectRef, textcolor: str) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["textcolor"] = textcolor

    def label_set_style(ref: ObjectRef, style: str) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["style"] = style

    def label_set_size(ref: ObjectRef, size: str) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["size"] = size

    def label_set_xloc(ref: ObjectRef, xloc: str) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["xloc"] = xloc

    def label_set_yloc(ref: ObjectRef, yloc: str) -> None:
        entry = _label_entry(ref)
        if entry is not None:
            entry["yloc"] = yloc

    def label_delete(ref: ObjectRef) -> None:
        if isinstance(ref, ObjectRef) and ref.kind == "label":
            collector._object_labels.pop(ref.id, None)

    def box_new(
        left: Any,
        top: Any,
        right: Any,
        bottom: Any,
        bgcolor: str = "rgba(0,0,0,0)",
        border_color: str = "#787b86",
        border_width: int = 1,
        border_style: str = "solid",
        xloc: str = "bar_index",
        pane: str | None = None,
    ) -> ObjectRef:
        if pane is None:
            pane = "main"
        object_id = collector._next_object_id("box")
        collector._object_boxes[object_id] = {
            "id": object_id,
            "left": _scalar_from_value(left),
            "top": _scalar_from_value(top),
            "right": _scalar_from_value(right),
            "bottom": _scalar_from_value(bottom),
            "bgcolor": bgcolor,
            "border_color": border_color,
            "border_width": int(border_width),
            "border_style": border_style,
            "xloc": xloc,
            "pane": pane,
        }
        return ObjectRef(id=object_id, kind="box")

    def box_set_left(ref: ObjectRef, left: Any) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["left"] = _scalar_from_value(left)

    def box_set_top(ref: ObjectRef, top: Any) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["top"] = _scalar_from_value(top)

    def box_set_right(ref: ObjectRef, right: Any) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["right"] = _scalar_from_value(right)

    def box_set_bottom(ref: ObjectRef, bottom: Any) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["bottom"] = _scalar_from_value(bottom)

    def box_set_lefttop(ref: ObjectRef, left: Any, top: Any) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["left"] = _scalar_from_value(left)
            entry["top"] = _scalar_from_value(top)

    def box_set_rightbottom(ref: ObjectRef, right: Any, bottom: Any) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["right"] = _scalar_from_value(right)
            entry["bottom"] = _scalar_from_value(bottom)

    def box_set_bgcolor(ref: ObjectRef, bgcolor: str) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["bgcolor"] = bgcolor

    def box_set_border_color(ref: ObjectRef, border_color: str) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["border_color"] = border_color

    def box_set_border_width(ref: ObjectRef, border_width: int) -> None:
        entry = _box_entry(ref)
        if entry is not None:
            entry["border_width"] = int(border_width)

    def box_delete(ref: ObjectRef) -> None:
        if isinstance(ref, ObjectRef) and ref.kind == "box":
            collector._object_boxes.pop(ref.id, None)

    def table_new(
        position: str = "top_right",
        columns: int = 1,
        rows: int = 1,
        bgcolor: str | None = None,
        frame_color: str = "#787b86",
        frame_width: int = 1,
        border_color: str = "#787b86",
        border_width: int = 1,
        pane: str | None = None,
    ) -> ObjectRef:
        if pane is None:
            pane = "main"
        object_id = collector._next_object_id("table")
        collector._object_tables[object_id] = {
            "id": object_id,
            "position": position,
            "columns": int(columns),
            "rows": int(rows),
            "bgcolor": bgcolor,
            "frame_color": frame_color,
            "frame_width": int(frame_width),
            "border_color": border_color,
            "border_width": int(border_width),
            "pane": pane,
            "cells": [],
        }
        return ObjectRef(id=object_id, kind="table")

    def table_cell(
        ref: ObjectRef,
        column: int,
        row: int,
        text: Any = "",
        text_color: str = "#000000",
        bgcolor: str | None = None,
        width: int | None = None,
        height: int | None = None,
        text_halign: str = "center",
        text_valign: str = "middle",
    ) -> None:
        entry = _table_entry(ref)
        if entry is None:
            return
        cell = {
            "column": int(column),
            "row": int(row),
            "text": str(_scalar_from_value(text)),
            "text_color": text_color,
            "bgcolor": bgcolor,
            "width": width,
            "height": height,
            "text_halign": text_halign,
            "text_valign": text_valign,
        }
        _upsert_table_cell(entry, cell)

    def table_clear(ref: ObjectRef) -> None:
        entry = _table_entry(ref)
        if entry is not None:
            entry["cells"] = []

    def table_set_position(ref: ObjectRef, position: str) -> None:
        entry = _table_entry(ref)
        if entry is not None:
            entry["position"] = position

    def table_set_bgcolor(ref: ObjectRef, bgcolor: str) -> None:
        entry = _table_entry(ref)
        if entry is not None:
            entry["bgcolor"] = bgcolor

    def table_set_frame_color(ref: ObjectRef, frame_color: str) -> None:
        entry = _table_entry(ref)
        if entry is not None:
            entry["frame_color"] = frame_color

    def table_set_border_color(ref: ObjectRef, border_color: str) -> None:
        entry = _table_entry(ref)
        if entry is not None:
            entry["border_color"] = border_color

    def table_delete(ref: ObjectRef) -> None:
        if isinstance(ref, ObjectRef) and ref.kind == "table":
            collector._object_tables.pop(ref.id, None)

    def _upsert_table_cell(entry: dict[str, Any], cell: dict[str, Any]) -> None:
        cells = entry.setdefault("cells", [])
        for idx, existing in enumerate(cells):
            if existing.get("column") == cell["column"] and existing.get("row") == cell["row"]:
                cells[idx] = cell
                return
        cells.append(cell)
        cells.sort(key=lambda item: (item.get("row", 0), item.get("column", 0)))

    # ── Legacy compatibility ─────────────────────────────────

    def add_line(
        data: PyneSeries | np.ndarray | list,
        title: str = "",
        color: str = "#f59e0b",
        pane: str | None = None,
        line_width: int | None = None,
        line_style: str | int | None = None,
        overlay: bool | None = None,
        type: str = "line",
        color_data: list | PyneSeries | np.ndarray | None = None,
        colorData: list | PyneSeries | np.ndarray | None = None,
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

    line_namespace = _Namespace(
        new=line_new,
        set_xy1=line_set_xy1,
        set_xy2=line_set_xy2,
        set_x1=line_set_x1,
        set_y1=line_set_y1,
        set_x2=line_set_x2,
        set_y2=line_set_y2,
        set_color=line_set_color,
        set_width=line_set_width,
        set_style=line_set_style,
        set_extend=line_set_extend,
        delete=line_delete,
        style_solid="solid",
        style_dashed="dashed",
        style_dotted="dotted",
        extend_none="none",
        extend_left="left",
        extend_right="right",
        extend_both="both",
    )
    label_namespace = _CallableNamespace(
        label_func,
        new=label_new,
        set_xy=label_set_xy,
        set_x=label_set_x,
        set_y=label_set_y,
        set_text=label_set_text,
        set_color=label_set_color,
        set_textcolor=label_set_textcolor,
        set_style=label_set_style,
        set_size=label_set_size,
        set_xloc=label_set_xloc,
        set_yloc=label_set_yloc,
        delete=label_delete,
        style_label_up="label_up",
        style_label_down="label_down",
        style_label_left="label_left",
        style_label_right="label_right",
        style_label_center="label_center",
    )
    box_namespace = _Namespace(
        new=box_new,
        set_left=box_set_left,
        set_top=box_set_top,
        set_right=box_set_right,
        set_bottom=box_set_bottom,
        set_lefttop=box_set_lefttop,
        set_rightbottom=box_set_rightbottom,
        set_bgcolor=box_set_bgcolor,
        set_border_color=box_set_border_color,
        set_border_width=box_set_border_width,
        delete=box_delete,
        border_style_solid="solid",
        border_style_dashed="dashed",
        border_style_dotted="dotted",
    )
    table_namespace = _Namespace(
        new=table_new,
        cell=table_cell,
        clear=table_clear,
        set_position=table_set_position,
        set_bgcolor=table_set_bgcolor,
        set_frame_color=table_set_frame_color,
        set_border_color=table_set_border_color,
        delete=table_delete,
    )
    position_namespace = _Namespace(
        top_left="top_left",
        top_center="top_center",
        top_right="top_right",
        middle_left="middle_left",
        middle_center="middle_center",
        middle_right="middle_right",
        bottom_left="bottom_left",
        bottom_center="bottom_center",
        bottom_right="bottom_right",
    )
    shape_namespace = _Namespace(
        xcross="xcross",
        cross="cross",
        circle="circle",
        triangleup="triangle_up",
        triangledown="triangle_down",
        flag="flag",
        arrowup="arrow_up",
        arrowdown="arrow_down",
        labelup="label_up",
        labeldown="label_down",
        square="square",
        diamond="diamond",
    )
    location_namespace = _Namespace(
        abovebar="above",
        belowbar="below",
        top="above",
        bottom="below",
        absolute="absolute",
    )
    size_namespace = _Namespace(
        tiny="tiny",
        small="small",
        normal="normal",
        large="large",
        huge="huge",
    )
    display_namespace = _Namespace(
        none="none",
        all="all",
        pane="pane",
        data_window="data_window",
        status_line="status_line",
    )
    format_namespace = _Namespace(
        inherit="inherit",
        price="price",
        volume="volume",
        percent="percent",
    )
    scale_namespace = _Namespace(
        left="left",
        right="right",
        none="none",
    )
    xloc_namespace = _Namespace(
        bar_index="bar_index",
        bar_time="bar_time",
    )
    yloc_namespace = _Namespace(
        price="price",
        abovebar="abovebar",
        belowbar="belowbar",
    )
    text_namespace = _Namespace(
        align_left="left",
        align_center="center",
        align_right="right",
        align_top="top",
        align_middle="middle",
        align_bottom="bottom",
    )

    return {
        "indicator": indicator,
        "plot": plot,
        "bar": bar,
        "hline": hline,
        "fill": fill,
        "bgcolor": bgcolor,
        "marker": marker,
        "plotshape": plotshape,
        "plotchar": plotchar,
        "plotarrow": plotarrow,
        "barcolor": barcolor,
        "emit_signal": emit_signal,
        "alertcondition": alertcondition,
        "line": line_namespace,
        "label": label_namespace,
        "box": box_namespace,
        "table": table_namespace,
        "add_line": add_line,
        "shape": shape_namespace,
        "location": location_namespace,
        "position": position_namespace,
        "size": size_namespace,
        "display": display_namespace,
        "format": format_namespace,
        "scale": scale_namespace,
        "xloc": xloc_namespace,
        "yloc": yloc_namespace,
        "text": text_namespace,
    }

def _display_options(
    *,
    display: str | None,
    format: str | None,
    precision: int | None,
) -> dict[str, Any]:
    options: dict[str, Any] = {}
    if display is not None:
        options["display"] = str(display)
    if format is not None:
        options["format"] = str(format)
    if precision is not None:
        options["precision"] = int(precision)
    return options
