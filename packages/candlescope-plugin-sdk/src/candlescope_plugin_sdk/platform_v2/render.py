"""Strict Render IR validation for Host-owned chart layers."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .constants import DEFAULT_MAX_CONTAINER_ITEMS
from .errors import contract_error
from .json_codec import canonical_dumps, normalize_json


RENDER_IR_V1 = "candlescope.render/1"
RENDER_IR_V2 = "candlescope.render/2"
_ITEM_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")
_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$")
_POSITIONS = frozenset({"aboveBar", "belowBar", "inBar"})
_SHAPES = frozenset({"circle", "square", "arrowUp", "arrowDown"})
_LINE_STYLES = frozenset({"solid", "dashed", "dotted"})
_LABEL_POSITIONS = frozenset({"above", "below", "center"})


@dataclass(frozen=True, slots=True)
class RenderBudget:
    max_items: int = 500
    max_bytes: int = 128 * 1024
    max_text_chars: int = 128
    max_points: int = 20_000

    def __post_init__(self) -> None:
        for name, value, maximum in (
            ("max_items", self.max_items, 5_000),
            ("max_points", self.max_points, 100_000),
            ("max_bytes", self.max_bytes, 1024 * 1024),
            ("max_text_chars", self.max_text_chars, 1_024),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
                raise ValueError(f"{name} is outside the supported range")


def _exact_object(
    value: Any,
    path: str,
    *,
    required: frozenset[str],
    optional: frozenset[str] = frozenset(),
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise contract_error(f"{path} must be an object", path=path)
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required - optional)
    if missing or unknown:
        raise contract_error(
            f"{path} has an invalid shape; missing={missing}, unknown={unknown}",
            path=path,
        )
    return value


def _item_id(value: Any, path: str, ids: set[str]) -> str:
    if not isinstance(value, str) or not _ITEM_ID.fullmatch(value):
        raise contract_error(f"{path}.id is invalid", path=f"{path}.id")
    if value in ids:
        raise contract_error(f"{path}.id is duplicated", path=f"{path}.id")
    ids.add(value)
    return value


def _time(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise contract_error(f"{path} must be a non-negative integer", path=path)
    return value


def _number(value: Any, path: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise contract_error(f"{path} must be a finite number", path=path)
    return value


def _color(value: Any, path: str) -> str:
    if not isinstance(value, str) or not _COLOR.fullmatch(value):
        raise contract_error(f"{path} must be a hex color", path=path)
    return value


def _text(value: Any, path: str, budget: RenderBudget) -> str:
    if not isinstance(value, str) or len(value) > budget.max_text_chars:
        raise contract_error(f"{path} exceeds the text budget", path=path)
    return value


def _line_style(value: Any, path: str) -> str:
    if value not in _LINE_STYLES:
        raise contract_error(f"{path} is unsupported", path=path)
    assert isinstance(value, str)
    return value


def _line_width(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 8:
        raise contract_error(f"{path} must be an integer from 1 to 8", path=path)
    return value


def _marker(
    raw: Any,
    path: str,
    *,
    budget: RenderBudget,
    ids: set[str],
) -> dict[str, Any]:
    item = _exact_object(
        raw,
        path,
        required=frozenset({"id", "type", "time", "position", "shape", "color", "text"}),
        optional=frozenset({"price"}),
    )
    _item_id(item["id"], path, ids)
    if item["type"] != "marker":
        raise contract_error(f"{path}.type must be marker", path=f"{path}.type")
    _time(item["time"], f"{path}.time")
    if item["position"] not in _POSITIONS:
        raise contract_error(f"{path}.position is unsupported", path=f"{path}.position")
    if item["shape"] not in _SHAPES:
        raise contract_error(f"{path}.shape is unsupported", path=f"{path}.shape")
    _color(item["color"], f"{path}.color")
    _text(item["text"], f"{path}.text", budget)
    if "price" in item:
        _number(item["price"], f"{path}.price")
    normalized = normalize_json(item, path=path)
    assert isinstance(normalized, dict)
    return normalized


def _polyline(
    raw: Any,
    path: str,
    *,
    budget: RenderBudget,
    ids: set[str],
) -> tuple[dict[str, Any], int]:
    item = _exact_object(
        raw,
        path,
        required=frozenset({"id", "type", "points", "color", "width", "style"}),
    )
    _item_id(item["id"], path, ids)
    raw_points = item["points"]
    max_item_points = min(budget.max_points, DEFAULT_MAX_CONTAINER_ITEMS)
    if (
        isinstance(raw_points, (str, bytes))
        or not isinstance(raw_points, Sequence)
        or not 2 <= len(raw_points) <= max_item_points
    ):
        raise contract_error(
            f"{path}.points must contain 2 to {max_item_points} points",
            path=f"{path}.points",
        )
    points: list[dict[str, Any]] = []
    previous_time: int | None = None
    for point_index, raw_point in enumerate(raw_points):
        point_path = f"{path}.points[{point_index}]"
        point = _exact_object(
            raw_point,
            point_path,
            required=frozenset({"time", "price"}),
        )
        point_time = _time(point["time"], f"{point_path}.time")
        if previous_time is not None and point_time <= previous_time:
            raise contract_error(
                f"{path}.points times must be strictly increasing",
                path=f"{point_path}.time",
            )
        previous_time = point_time
        points.append(
            {
                "time": point_time,
                "price": _number(point["price"], f"{point_path}.price"),
            }
        )
    _color(item["color"], f"{path}.color")
    _line_width(item["width"], f"{path}.width")
    _line_style(item["style"], f"{path}.style")
    normalized = normalize_json({**item, "points": points}, path=path)
    assert isinstance(normalized, dict)
    return normalized, len(points)


def _price_line(
    raw: Any,
    path: str,
    *,
    budget: RenderBudget,
    ids: set[str],
) -> dict[str, Any]:
    item = _exact_object(
        raw,
        path,
        required=frozenset({"id", "type", "price", "color", "width", "style"}),
        optional=frozenset({"text"}),
    )
    _item_id(item["id"], path, ids)
    _number(item["price"], f"{path}.price")
    _color(item["color"], f"{path}.color")
    _line_width(item["width"], f"{path}.width")
    _line_style(item["style"], f"{path}.style")
    if "text" in item:
        _text(item["text"], f"{path}.text", budget)
    normalized = normalize_json(item, path=path)
    assert isinstance(normalized, dict)
    return normalized


def _band(
    raw: Any,
    path: str,
    *,
    ids: set[str],
) -> dict[str, Any]:
    item = _exact_object(
        raw,
        path,
        required=frozenset(
            {
                "id",
                "type",
                "startTime",
                "endTime",
                "lowerPrice",
                "upperPrice",
                "fillColor",
            }
        ),
        optional=frozenset({"borderColor"}),
    )
    _item_id(item["id"], path, ids)
    start = _time(item["startTime"], f"{path}.startTime")
    end = _time(item["endTime"], f"{path}.endTime")
    if end <= start:
        raise contract_error(
            f"{path}.endTime must be after startTime",
            path=f"{path}.endTime",
        )
    lower = _number(item["lowerPrice"], f"{path}.lowerPrice")
    upper = _number(item["upperPrice"], f"{path}.upperPrice")
    if upper < lower:
        raise contract_error(
            f"{path}.upperPrice must not be below lowerPrice",
            path=f"{path}.upperPrice",
        )
    _color(item["fillColor"], f"{path}.fillColor")
    if "borderColor" in item:
        _color(item["borderColor"], f"{path}.borderColor")
    normalized = normalize_json(item, path=path)
    assert isinstance(normalized, dict)
    return normalized


def _label(
    raw: Any,
    path: str,
    *,
    budget: RenderBudget,
    ids: set[str],
) -> dict[str, Any]:
    item = _exact_object(
        raw,
        path,
        required=frozenset({"id", "type", "time", "price", "text", "color", "position"}),
        optional=frozenset({"backgroundColor"}),
    )
    _item_id(item["id"], path, ids)
    _time(item["time"], f"{path}.time")
    _number(item["price"], f"{path}.price")
    _text(item["text"], f"{path}.text", budget)
    _color(item["color"], f"{path}.color")
    if item["position"] not in _LABEL_POSITIONS:
        raise contract_error(f"{path}.position is unsupported", path=f"{path}.position")
    if "backgroundColor" in item:
        _color(item["backgroundColor"], f"{path}.backgroundColor")
    normalized = normalize_json(item, path=path)
    assert isinstance(normalized, dict)
    return normalized


def validate_render_ir(value: Any, *, budget: RenderBudget = RenderBudget()) -> dict[str, Any]:
    """Return normalized bounded Render IR or fail closed."""

    data = _exact_object(
        value,
        "render",
        required=frozenset({"schemaVersion", "items"}),
    )
    schema_version = data["schemaVersion"]
    if schema_version not in {RENDER_IR_V1, RENDER_IR_V2}:
        raise contract_error("render.schemaVersion is unsupported", path="render.schemaVersion")
    raw_items = data["items"]
    if isinstance(raw_items, (str, bytes)) or not isinstance(raw_items, Sequence):
        raise contract_error("render.items must be an array", path="render.items")
    if len(raw_items) > budget.max_items:
        raise contract_error("render.items exceeds the item budget", path="render.items")
    items: list[dict[str, Any]] = []
    ids: set[str] = set()
    point_count = 0
    for index, raw in enumerate(raw_items):
        path = f"render.items[{index}]"
        if not isinstance(raw, Mapping):
            raise contract_error(f"{path} must be an object", path=path)
        item_type = raw.get("type")
        if schema_version == RENDER_IR_V1:
            if item_type != "marker":
                raise contract_error(
                    f"{path}.type only supports marker in Render IR v1",
                    path=f"{path}.type",
                )
            items.append(_marker(raw, path, budget=budget, ids=ids))
            continue
        if item_type == "marker":
            items.append(_marker(raw, path, budget=budget, ids=ids))
        elif item_type == "polyline":
            normalized, points = _polyline(raw, path, budget=budget, ids=ids)
            point_count += points
            if point_count > budget.max_points:
                raise contract_error(
                    "render exceeds the point budget",
                    path=f"{path}.points",
                )
            items.append(normalized)
        elif item_type == "price-line":
            items.append(_price_line(raw, path, budget=budget, ids=ids))
        elif item_type == "band":
            items.append(_band(raw, path, ids=ids))
        elif item_type == "label":
            items.append(_label(raw, path, budget=budget, ids=ids))
        else:
            raise contract_error(
                f"{path}.type is unsupported in Render IR v2",
                path=f"{path}.type",
            )
    result = {"schemaVersion": schema_version, "items": items}
    if len(canonical_dumps(result).encode("utf-8")) > budget.max_bytes:
        raise contract_error("render exceeds the byte budget", path="render")
    return result


__all__ = [
    "RENDER_IR_V1",
    "RENDER_IR_V2",
    "RenderBudget",
    "validate_render_ir",
]
