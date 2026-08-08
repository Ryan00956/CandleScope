"""Translate native Pyne output v2 into CandleScope's bounded chart Render IR v2."""
from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from candlescope_plugin_sdk.platform_v2 import RENDER_IR_V2, validate_render_ir


_RGBA = re.compile(
    r"^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})"
    r"(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class AdaptedRender:
    render: dict[str, Any]
    diagnostics: tuple[str, ...]
    source_counts: dict[str, int]


def adapt_pyne_output(
    output: Mapping[str, Any],
    *,
    bar_times: Sequence[int],
) -> AdaptedRender:
    """Return validated chart-layer/2 items and explicit non-chart diagnostics."""

    if not isinstance(output, Mapping):
        raise TypeError("Pyne output must be an object")
    times = tuple(int(item) for item in bar_times)
    items: list[dict[str, Any]] = []
    diagnostics: list[str] = []
    counts: dict[str, int] = {}

    def count(name: str, value: Any) -> None:
        counts[name] = len(value) if _array(value) else 0

    raw_lines = output.get("lines", [])
    count("lines", raw_lines)
    for index, line in enumerate(raw_lines if _array(raw_lines) else []):
        if not isinstance(line, Mapping):
            diagnostics.append(f"lines[{index}] was not an object")
            continue
        points = _series_points(line.get("data"))
        if len(points) < 2:
            diagnostics.append(f"lines[{index}] had fewer than two chart points")
            continue
        items.append(
            _polyline_item(
                f"pyne-series-{index + 1}",
                points,
                color=_hex_color(line.get("color"), "#F59E0B"),
                width=_width(line.get("linewidth", 2)),
                style=_style(line.get("style")),
            )
        )

    raw_hlines = output.get("hlines", [])
    count("hlines", raw_hlines)
    for index, line in enumerate(raw_hlines if _array(raw_hlines) else []):
        if not isinstance(line, Mapping) or not _finite(line.get("price")):
            diagnostics.append(f"hlines[{index}] was invalid")
            continue
        item = {
            "id": f"pyne-hline-{index + 1}",
            "type": "price-line",
            "price": float(line["price"]),
            "color": _hex_color(line.get("color"), "#787B86"),
            "width": _width(line.get("linewidth", 1)),
            "style": _style(line.get("linestyle")),
        }
        title = line.get("title")
        if isinstance(title, str) and title:
            item["text"] = title[:128]
        items.append(item)

    raw_markers = output.get("markers", [])
    count("markers", raw_markers)
    marker_number = 0
    for group_index, group in enumerate(raw_markers if _array(raw_markers) else []):
        if not isinstance(group, Mapping) or not _array(group.get("data")):
            diagnostics.append(f"markers[{group_index}] was invalid")
            continue
        for point in group["data"]:
            if not isinstance(point, Mapping) or not _valid_time(point.get("time")):
                continue
            marker_number += 1
            position = "belowBar" if str(point.get("position", "above")).lower() in {
                "below",
                "belowbar",
            } else "aboveBar"
            shape = _marker_shape(point.get("shape"), position)
            item = {
                "id": f"pyne-marker-{marker_number}",
                "type": "marker",
                "time": int(point["time"]),
                "position": position,
                "shape": shape,
                "color": _hex_color(point.get("color"), "#F59E0B"),
                "text": str(point.get("text") or point.get("char") or "")[:128],
            }
            if _finite(point.get("value")):
                item["price"] = float(point["value"])
            items.append(item)

    objects = output.get("objects", {})
    if not isinstance(objects, Mapping):
        objects = {}
        diagnostics.append("objects was not an object")

    object_lines = objects.get("lines", [])
    count("objects.lines", object_lines)
    for index, line in enumerate(object_lines if _array(object_lines) else []):
        if not isinstance(line, Mapping):
            continue
        xloc = str(line.get("xloc", "bar_index"))
        first_time = _coordinate_time(line.get("x1"), xloc, times)
        second_time = _coordinate_time(line.get("x2"), xloc, times)
        if first_time is None or second_time is None or not all(
            _finite(line.get(key)) for key in ("y1", "y2")
        ):
            diagnostics.append(f"objects.lines[{index}] could not map to time coordinates")
            continue
        points = _ordered_points(
            [
                {"time": first_time, "price": float(line["y1"])},
                {"time": second_time, "price": float(line["y2"])},
            ]
        )
        if len(points) < 2:
            diagnostics.append(f"objects.lines[{index}] collapsed to one time")
            continue
        items.append(
            _polyline_item(
                f"pyne-object-line-{index + 1}",
                points,
                color=_hex_color(line.get("color"), "#2196F3"),
                width=_width(line.get("width", 1)),
                style=_style(line.get("style")),
            )
        )

    object_polylines = objects.get("polylines", [])
    count("objects.polylines", object_polylines)
    for index, polyline in enumerate(object_polylines if _array(object_polylines) else []):
        if not isinstance(polyline, Mapping) or not _array(polyline.get("points")):
            continue
        xloc = str(polyline.get("xloc", "bar_index"))
        points: list[dict[str, Any]] = []
        for point in polyline["points"]:
            if not isinstance(point, Mapping) or not _finite(point.get("y")):
                continue
            mapped_time = _coordinate_time(point.get("x"), xloc, times)
            if mapped_time is not None:
                points.append({"time": mapped_time, "price": float(point["y"])})
        points = _ordered_points(points)
        if len(points) < 2:
            diagnostics.append(f"objects.polylines[{index}] had fewer than two time points")
            continue
        items.append(
            _polyline_item(
                f"pyne-polyline-{index + 1}",
                points,
                color=_hex_color(polyline.get("line_color"), "#2196F3"),
                width=_width(polyline.get("line_width", 1)),
                style=_style(polyline.get("line_style")),
            )
        )

    object_boxes = objects.get("boxes", [])
    count("objects.boxes", object_boxes)
    for index, box in enumerate(object_boxes if _array(object_boxes) else []):
        if not isinstance(box, Mapping):
            continue
        xloc = str(box.get("xloc", "bar_index"))
        start = _coordinate_time(box.get("left"), xloc, times)
        end = _coordinate_time(box.get("right"), xloc, times)
        if start is None or end is None or start == end or not all(
            _finite(box.get(key)) for key in ("top", "bottom")
        ):
            diagnostics.append(f"objects.boxes[{index}] could not map to a chart band")
            continue
        lower, upper = sorted((float(box["bottom"]), float(box["top"])))
        item = {
            "id": f"pyne-box-{index + 1}",
            "type": "band",
            "startTime": min(start, end),
            "endTime": max(start, end),
            "lowerPrice": lower,
            "upperPrice": upper,
            "fillColor": _hex_color(box.get("bgcolor"), "#2196F322"),
            "borderColor": _hex_color(box.get("border_color"), "#2196F3"),
        }
        items.append(item)

    object_labels = objects.get("labels", [])
    count("objects.labels", object_labels)
    for index, label in enumerate(object_labels if _array(object_labels) else []):
        if not isinstance(label, Mapping) or not _finite(label.get("y")):
            continue
        mapped_time = _coordinate_time(
            label.get("x"), str(label.get("xloc", "bar_index")), times
        )
        if mapped_time is None:
            continue
        style = str(label.get("style", "")).lower()
        position = "below" if "up" in style else "above" if "down" in style else "center"
        items.append(
            {
                "id": f"pyne-label-{index + 1}",
                "type": "label",
                "time": mapped_time,
                "price": float(label["y"]),
                "text": str(label.get("text") or "")[:128],
                "color": _hex_color(label.get("textcolor"), "#FFFFFF"),
                "backgroundColor": _hex_color(label.get("color"), "#1D4ED8CC"),
                "position": position,
            }
        )

    for group_name in ("candles", "histograms", "fills", "bgcolors", "barcolors"):
        group = output.get(group_name, [])
        count(group_name, group)
        if _array(group) and len(group) > 0:
            diagnostics.append(
                f"{group_name} is preserved in native Pyne output but has no chart-layer/2 item"
            )
    for object_name in ("linefills", "tables"):
        group = objects.get(object_name, [])
        count(f"objects.{object_name}", group)
        if _array(group) and len(group) > 0:
            diagnostics.append(
                f"objects.{object_name} is preserved but cannot be losslessly projected"
            )

    render = validate_render_ir({"schemaVersion": RENDER_IR_V2, "items": items})
    return AdaptedRender(render=render, diagnostics=tuple(diagnostics), source_counts=counts)


def _array(value: Any) -> bool:
    return isinstance(value, Sequence) and not isinstance(value, (str, bytes))


def _series_points(value: Any) -> list[dict[str, Any]]:
    if not _array(value):
        return []
    points = [
        {"time": int(point["time"]), "price": float(point["value"])}
        for point in value
        if isinstance(point, Mapping)
        and _valid_time(point.get("time"))
        and _finite(point.get("value"))
    ]
    return _ordered_points(points)


def _ordered_points(points: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    by_time = {int(point["time"]): dict(point) for point in points}
    return [by_time[key] for key in sorted(by_time)]


def _polyline_item(
    identifier: str,
    points: list[dict[str, Any]],
    *,
    color: str,
    width: int,
    style: str,
) -> dict[str, Any]:
    return {
        "id": identifier,
        "type": "polyline",
        "points": points,
        "color": color,
        "width": width,
        "style": style,
    }


def _coordinate_time(value: Any, xloc: str, bar_times: tuple[int, ...]) -> int | None:
    if not _finite(value):
        return None
    if xloc == "bar_time":
        return int(value)
    index = int(value)
    if index < 0 or index >= len(bar_times):
        return None
    return bar_times[index]


def _valid_time(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _width(value: Any) -> int:
    if not _finite(value):
        return 1
    return min(max(int(value), 1), 8)


def _style(value: Any) -> str:
    normalized = str(value or "solid").lower()
    return normalized if normalized in {"solid", "dashed", "dotted"} else "solid"


def _marker_shape(value: Any, position: str) -> str:
    normalized = str(value or "circle").lower().replace("_", "")
    if normalized in {"square", "circle"}:
        return normalized
    if normalized in {"arrowup", "triangleup", "labelup"}:
        return "arrowUp"
    if normalized in {"arrowdown", "triangledown", "labeldown"}:
        return "arrowDown"
    return "arrowUp" if position == "belowBar" else "arrowDown"


def _hex_color(value: Any, fallback: str) -> str:
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r"#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?", text):
            return text.upper()
        match = _RGBA.fullmatch(text)
        if match is not None:
            red, green, blue = (min(int(match.group(index)), 255) for index in (1, 2, 3))
            alpha = 1.0 if match.group(4) is None else float(match.group(4))
            return f"#{red:02X}{green:02X}{blue:02X}{round(alpha * 255):02X}"
    return fallback
