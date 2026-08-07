"""Fail-closed validation for persisted alert rules."""
from __future__ import annotations

import math
from typing import Any


ALERT_EXPRESSION_MAX_DEPTH = 32
ALERT_EXPRESSION_MAX_NODES = 256
VALID_COMPARATORS = {
    "crossesAbove",
    "crossesBelow",
    ">",
    "<",
    ">=",
    "<=",
    "==",
    "!=",
    "between",
    "outsideRange",
    "percentChangeAbove",
    "percentChangeBelow",
}
VALID_VALUE_FIELDS = {
    "open",
    "high",
    "low",
    "close",
    "last",
    "volume",
    "rsi",
    "macdHist",
    "ma20",
}
VALID_AFTER_TRIGGER = {"auto_disable", "keep", "pause"}


def normalize_after_trigger(value: Any) -> str:
    normalized = str(value or "auto_disable").strip().lower().replace("-", "_")
    if normalized not in VALID_AFTER_TRIGGER:
        raise ValueError(
            "Alert afterTrigger must be one of: "
            + ", ".join(sorted(VALID_AFTER_TRIGGER))
        )
    return normalized


def validate_alert_expression(expression: Any) -> None:
    """Validate the recursive expression contract shared with the frontend."""
    count = 0

    def visit(node: Any, *, path: str, depth: int) -> None:
        nonlocal count
        if depth > ALERT_EXPRESSION_MAX_DEPTH:
            raise ValueError(
                f"Alert expression exceeds {ALERT_EXPRESSION_MAX_DEPTH} levels at {path}"
            )
        count += 1
        if count > ALERT_EXPRESSION_MAX_NODES:
            raise ValueError(
                f"Alert expression exceeds {ALERT_EXPRESSION_MAX_NODES} nodes"
            )
        if not isinstance(node, dict) or not node:
            raise ValueError(f"Alert expression node must be a non-empty object at {path}")

        raw_op = node.get("op")
        if raw_op in {"AND", "OR"}:
            children = node.get("children")
            if not isinstance(children, list) or not children:
                raise ValueError(f"Alert {raw_op} group requires children at {path}")
            for index, child in enumerate(children):
                visit(child, path=f"{path}.children[{index}]", depth=depth + 1)
            return
        if raw_op == "NOT":
            children = node.get("children")
            if not isinstance(children, list) or len(children) != 1:
                raise ValueError(f"Alert NOT group requires exactly one child at {path}")
            visit(children[0], path=f"{path}.children[0]", depth=depth + 1)
            return
        if raw_op is not None:
            raise ValueError(f"Unsupported alert operator at {path}: {raw_op}")

        left = str(node.get("left") or "").strip()
        if left not in VALID_VALUE_FIELDS:
            raise ValueError(f"Unsupported alert value field at {path}.left: {left or '<empty>'}")
        comparator = str(node.get("comparator") or node.get("operator") or "").strip()
        if comparator not in VALID_COMPARATORS:
            raise ValueError(
                f"Unsupported alert comparator at {path}.comparator: {comparator or '<empty>'}"
            )
        right = node.get("right")
        if not isinstance(right, dict):
            raise ValueError(f"Alert right-hand value must be an object at {path}.right")

        right_type = str(right.get("type") or "").strip()
        if comparator in {"between", "outsideRange"}:
            if right_type != "range":
                raise ValueError(f"Alert range comparator requires a range at {path}.right")
            minimum = _finite_number(right.get("min"), f"{path}.right.min")
            maximum = _finite_number(right.get("max"), f"{path}.right.max")
            if minimum > maximum:
                raise ValueError(f"Alert range minimum exceeds maximum at {path}.right")
            return
        if comparator in {"percentChangeAbove", "percentChangeBelow"}:
            if right_type != "percent":
                raise ValueError(f"Alert percent comparator requires a percent at {path}.right")
            _finite_number(right.get("value"), f"{path}.right.value")
            return
        if right_type == "number":
            _finite_number(right.get("value"), f"{path}.right.value")
            return
        if right_type in {"field", "indicator"}:
            field = str(right.get("value") or right.get("field") or "").strip()
            if field not in VALID_VALUE_FIELDS:
                raise ValueError(
                    f"Unsupported alert reference field at {path}.right.value: {field or '<empty>'}"
                )
            return
        raise ValueError(f"Unsupported alert right-hand type at {path}.right: {right_type or '<empty>'}")

    visit(expression, path="expression", depth=0)


def referenced_alert_fields(expression: Any) -> set[str]:
    """Return value fields used by a previously validated expression."""
    fields: set[str] = set()

    def visit(node: Any) -> None:
        if not isinstance(node, dict):
            return
        if node.get("op") in {"AND", "OR", "NOT"}:
            for child in node.get("children") or []:
                visit(child)
            return
        left = str(node.get("left") or "").strip()
        if left in VALID_VALUE_FIELDS:
            fields.add(left)
        right = node.get("right")
        if isinstance(right, dict) and right.get("type") in {"field", "indicator"}:
            field = str(right.get("value") or right.get("field") or "").strip()
            if field in VALID_VALUE_FIELDS:
                fields.add(field)

    visit(expression)
    return fields


def _finite_number(value: Any, path: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Alert value must be finite at {path}") from exc
    if not math.isfinite(parsed):
        raise ValueError(f"Alert value must be finite at {path}")
    return parsed
