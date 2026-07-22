"""Strict Render IR v1 validation for Host-owned chart layers."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .errors import contract_error
from .json_codec import canonical_dumps, normalize_json


RENDER_IR_V1 = "candlescope.render/1"
_ITEM_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")
_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$")
_POSITIONS = frozenset({"aboveBar", "belowBar", "inBar"})
_SHAPES = frozenset({"circle", "square", "arrowUp", "arrowDown"})


@dataclass(frozen=True, slots=True)
class RenderBudget:
    max_items: int = 500
    max_bytes: int = 128 * 1024
    max_text_chars: int = 128

    def __post_init__(self) -> None:
        for name, value, maximum in (
            ("max_items", self.max_items, 5_000),
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


def validate_render_ir(value: Any, *, budget: RenderBudget = RenderBudget()) -> dict[str, Any]:
    """Return normalized marker-only Render IR or fail closed."""

    data = _exact_object(
        value,
        "render",
        required=frozenset({"schemaVersion", "items"}),
    )
    if data["schemaVersion"] != RENDER_IR_V1:
        raise contract_error("render.schemaVersion is unsupported", path="render.schemaVersion")
    raw_items = data["items"]
    if isinstance(raw_items, (str, bytes)) or not isinstance(raw_items, Sequence):
        raise contract_error("render.items must be an array", path="render.items")
    if len(raw_items) > budget.max_items:
        raise contract_error("render.items exceeds the item budget", path="render.items")
    items: list[dict[str, Any]] = []
    ids: set[str] = set()
    for index, raw in enumerate(raw_items):
        path = f"render.items[{index}]"
        item = _exact_object(
            raw,
            path,
            required=frozenset({"id", "type", "time", "position", "shape", "color", "text"}),
            optional=frozenset({"price"}),
        )
        item_id = item["id"]
        if not isinstance(item_id, str) or not _ITEM_ID.fullmatch(item_id):
            raise contract_error(f"{path}.id is invalid", path=f"{path}.id")
        if item_id in ids:
            raise contract_error(f"{path}.id is duplicated", path=f"{path}.id")
        ids.add(item_id)
        if item["type"] != "marker":
            raise contract_error(
                f"{path}.type only supports marker in Render IR v1", path=f"{path}.type"
            )
        if isinstance(item["time"], bool) or not isinstance(item["time"], int) or item["time"] < 0:
            raise contract_error(f"{path}.time must be a non-negative integer", path=f"{path}.time")
        if item["position"] not in _POSITIONS:
            raise contract_error(f"{path}.position is unsupported", path=f"{path}.position")
        if item["shape"] not in _SHAPES:
            raise contract_error(f"{path}.shape is unsupported", path=f"{path}.shape")
        if not isinstance(item["color"], str) or not _COLOR.fullmatch(item["color"]):
            raise contract_error(f"{path}.color must be a hex color", path=f"{path}.color")
        if not isinstance(item["text"], str) or len(item["text"]) > budget.max_text_chars:
            raise contract_error(f"{path}.text exceeds the text budget", path=f"{path}.text")
        if "price" in item and (
            isinstance(item["price"], bool) or not isinstance(item["price"], (int, float))
        ):
            raise contract_error(f"{path}.price must be numeric", path=f"{path}.price")
        normalized = normalize_json(item, path=path)
        assert isinstance(normalized, dict)
        items.append(normalized)
    result = {"schemaVersion": RENDER_IR_V1, "items": items}
    if len(canonical_dumps(result).encode("utf-8")) > budget.max_bytes:
        raise contract_error("render exceeds the byte budget", path="render")
    return result


__all__ = ["RENDER_IR_V1", "RenderBudget", "validate_render_ir"]
