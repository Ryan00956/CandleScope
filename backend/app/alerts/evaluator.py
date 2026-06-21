"""Pure alert expression evaluator."""
from __future__ import annotations

from typing import Any


class AlertEvaluator:
    """Evaluate structured alert expressions against current/previous values."""

    def evaluate(self, expression: dict[str, Any], context: dict[str, Any]) -> bool:
        if not isinstance(expression, dict) or not expression:
            return False

        op = str(expression.get("op") or "").upper()
        children = expression.get("children")
        if op == "AND":
            return all(self.evaluate(child, context) for child in self._children(children))
        if op == "OR":
            return any(self.evaluate(child, context) for child in self._children(children))
        if op == "NOT":
            child_items = self._children(children)
            return not self.evaluate(child_items[0], context) if child_items else True

        return self._evaluate_leaf(expression, context)

    def evaluate_with_trace(self, expression: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        """Evaluate an expression and return a UI-friendly decision tree."""
        trace = self._trace(expression, context, path="root")
        return {
            "result": bool(trace.get("result")),
            "trace": trace,
        }

    def _trace(self, expression: dict[str, Any], context: dict[str, Any], *, path: str) -> dict[str, Any]:
        if not isinstance(expression, dict) or not expression:
            return {
                "path": path,
                "kind": "empty",
                "result": False,
                "status": "invalid",
                "summary": "空表达式",
                "children": [],
            }

        op = str(expression.get("op") or "").upper()
        children = self._children(expression.get("children"))
        if op in {"AND", "OR"}:
            child_traces = [
                self._trace(child, context, path=f"{path}.{index + 1}")
                for index, child in enumerate(children)
            ]
            child_results = [bool(item.get("result")) for item in child_traces]
            result = all(child_results) if op == "AND" else any(child_results)
            return {
                "path": path,
                "kind": "group",
                "op": op,
                "result": result,
                "status": "matched" if result else "not_matched",
                "summary": f"{op} 组：{len(child_traces)} 个子条件",
                "children": child_traces,
            }
        if op == "NOT":
            child_trace = self._trace(children[0], context, path=f"{path}.1") if children else {
                "path": f"{path}.1",
                "kind": "empty",
                "result": True,
                "status": "empty_not",
                "summary": "空 NOT 组",
                "children": [],
            }
            result = not bool(child_trace.get("result"))
            return {
                "path": path,
                "kind": "group",
                "op": "NOT",
                "result": result,
                "status": "matched" if result else "not_matched",
                "summary": "NOT 组",
                "children": [child_trace],
            }

        return self._trace_leaf(expression, context, path=path)

    def _evaluate_leaf(self, expression: dict[str, Any], context: dict[str, Any]) -> bool:
        comparator = str(expression.get("comparator") or expression.get("operator") or "").strip()
        left_key = str(expression.get("left") or "").strip()
        right_spec = expression.get("right")
        current = context.get("values") if isinstance(context.get("values"), dict) else {}
        previous = context.get("previous") if isinstance(context.get("previous"), dict) else {}

        left = self._number(current.get(left_key))
        normalized = self._normalize_comparator(comparator)
        if normalized in {"between", "outsideRange"}:
            range_values = self._resolve_range(right_spec)
            if left is None or range_values is None:
                return False
            lower, upper = range_values
            in_range = lower <= left <= upper
            return in_range if normalized == "between" else not in_range

        if normalized in {"percentChangeAbove", "percentChangeBelow"}:
            prev_left = self._number(previous.get(left_key))
            threshold = self._number(self._resolve_right(right_spec, current))
            change = self._percent_change(prev_left, left)
            if change is None or threshold is None:
                return False
            return change > threshold if normalized == "percentChangeAbove" else change < threshold

        right = self._number(self._resolve_right(right_spec, current))
        if left is None or right is None:
            return False

        if normalized == ">":
            return left > right
        if normalized == ">=":
            return left >= right
        if normalized == "<":
            return left < right
        if normalized == "<=":
            return left <= right
        if normalized in {"=", "=="}:
            return left == right
        if normalized == "!=":
            return left != right

        prev_left = self._number(previous.get(left_key))
        prev_right = self._number(self._resolve_right(right_spec, previous))
        if prev_left is None or prev_right is None:
            return False
        if normalized == "crossesAbove":
            return prev_left <= prev_right and left > right
        if normalized == "crossesBelow":
            return prev_left >= prev_right and left < right
        return False

    def _trace_leaf(self, expression: dict[str, Any], context: dict[str, Any], *, path: str) -> dict[str, Any]:
        comparator = str(expression.get("comparator") or expression.get("operator") or "").strip()
        left_key = str(expression.get("left") or "").strip()
        right_spec = expression.get("right")
        current = context.get("values") if isinstance(context.get("values"), dict) else {}
        previous = context.get("previous") if isinstance(context.get("previous"), dict) else {}
        normalized = self._normalize_comparator(comparator)

        left_raw = current.get(left_key)
        left = self._number(left_raw)
        right_raw = self._resolve_right(right_spec, current)
        right = self._number(right_raw)
        details: dict[str, Any] = {
            "leftKey": left_key,
            "comparator": normalized,
            "left": left_raw,
            "right": right_raw,
        }

        if normalized in {"between", "outsideRange"}:
            range_values = self._resolve_range(right_spec)
            if left is None or range_values is None:
                return {
                    "path": path,
                    "kind": "condition",
                    "result": False,
                    "status": "missing_value",
                    "summary": self._leaf_summary(left_key, normalized, right_spec),
                    "details": details,
                    "children": [],
                }
            lower, upper = range_values
            details["rangeMin"] = lower
            details["rangeMax"] = upper
            in_range = lower <= left <= upper
            result = in_range if normalized == "between" else not in_range
            return {
                "path": path,
                "kind": "condition",
                "result": result,
                "status": "matched" if result else "not_matched",
                "summary": self._leaf_summary(left_key, normalized, right_spec),
                "details": details,
                "children": [],
            }

        if normalized in {"percentChangeAbove", "percentChangeBelow"}:
            prev_left_raw = previous.get(left_key)
            prev_left = self._number(prev_left_raw)
            threshold = right
            change = self._percent_change(prev_left, left)
            details["previousLeft"] = prev_left_raw
            details["percentChange"] = change
            if change is None or threshold is None:
                return {
                    "path": path,
                    "kind": "condition",
                    "result": False,
                    "status": "missing_previous" if prev_left is None else "missing_value",
                    "summary": self._leaf_summary(left_key, normalized, right_spec),
                    "details": details,
                    "children": [],
                }
            result = change > threshold if normalized == "percentChangeAbove" else change < threshold
            return {
                "path": path,
                "kind": "condition",
                "result": result,
                "status": "matched" if result else "not_matched",
                "summary": self._leaf_summary(left_key, normalized, right_spec),
                "details": details,
                "children": [],
            }

        if left is None or right is None:
            return {
                "path": path,
                "kind": "condition",
                "result": False,
                "status": "missing_value",
                "summary": self._leaf_summary(left_key, normalized, right_spec),
                "details": details,
                "children": [],
            }

        result: bool | None = None
        if normalized == ">":
            result = left > right
        elif normalized == ">=":
            result = left >= right
        elif normalized == "<":
            result = left < right
        elif normalized == "<=":
            result = left <= right
        elif normalized in {"=", "=="}:
            result = left == right
        elif normalized == "!=":
            result = left != right

        if result is not None:
            return {
                "path": path,
                "kind": "condition",
                "result": result,
                "status": "matched" if result else "not_matched",
                "summary": self._leaf_summary(left_key, normalized, right_spec),
                "details": details,
                "children": [],
            }

        prev_left_raw = previous.get(left_key)
        prev_right_raw = self._resolve_right(right_spec, previous)
        prev_left = self._number(prev_left_raw)
        prev_right = self._number(prev_right_raw)
        details["previousLeft"] = prev_left_raw
        details["previousRight"] = prev_right_raw
        if prev_left is None or prev_right is None:
            return {
                "path": path,
                "kind": "condition",
                "result": False,
                "status": "missing_previous",
                "summary": self._leaf_summary(left_key, normalized, right_spec),
                "details": details,
                "children": [],
            }
        if normalized == "crossesAbove":
            result = prev_left <= prev_right and left > right
        elif normalized == "crossesBelow":
            result = prev_left >= prev_right and left < right
        else:
            return {
                "path": path,
                "kind": "condition",
                "result": False,
                "status": "unsupported_comparator",
                "summary": self._leaf_summary(left_key, normalized, right_spec),
                "details": details,
                "children": [],
            }
        return {
            "path": path,
            "kind": "condition",
            "result": result,
            "status": "matched" if result else "not_matched",
            "summary": self._leaf_summary(left_key, normalized, right_spec),
            "details": details,
            "children": [],
        }

    @staticmethod
    def _children(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]

    @staticmethod
    def _resolve_right(spec: Any, values: dict[str, Any]) -> Any:
        if isinstance(spec, dict):
            spec_type = spec.get("type")
            if spec_type in {"field", "indicator", "priceField"}:
                return values.get(str(spec.get("value") or spec.get("field") or ""))
            return spec.get("value")
        return spec

    @classmethod
    def _resolve_range(cls, spec: Any) -> tuple[float, float] | None:
        if not isinstance(spec, dict):
            return None
        raw_min = spec.get("min")
        raw_max = spec.get("max")
        if raw_min is None or raw_max is None:
            value = spec.get("value")
            if isinstance(value, list) and len(value) >= 2:
                raw_min, raw_max = value[0], value[1]
        lower = cls._number(raw_min)
        upper = cls._number(raw_max)
        if lower is None or upper is None:
            return None
        return (lower, upper) if lower <= upper else (upper, lower)

    @staticmethod
    def _percent_change(previous: float | None, current: float | None) -> float | None:
        if previous is None or current is None or previous == 0:
            return None
        return ((current - previous) / abs(previous)) * 100

    @staticmethod
    def _number(value: Any) -> float | None:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return None
        if num != num:
            return None
        return num

    @staticmethod
    def _normalize_comparator(value: str) -> str:
        mapping = {
            "greaterThan": ">",
            "lessThan": "<",
            "greaterOrEqual": ">=",
            "lessOrEqual": "<=",
            "equals": "==",
            "notEquals": "!=",
            "crosses_above": "crossesAbove",
            "crosses_below": "crossesBelow",
            "crossAbove": "crossesAbove",
            "crossBelow": "crossesBelow",
            "inRange": "between",
            "betweenInclusive": "between",
            "outside": "outsideRange",
            "outside_range": "outsideRange",
            "percent_change_above": "percentChangeAbove",
            "percent_change_below": "percentChangeBelow",
            "changePercentAbove": "percentChangeAbove",
            "changePercentBelow": "percentChangeBelow",
        }
        return mapping.get(value, value)

    @staticmethod
    def _leaf_summary(left_key: str, comparator: str, right_spec: Any) -> str:
        if isinstance(right_spec, dict):
            if right_spec.get("type") == "range":
                right = f"{right_spec.get('min', '?')}..{right_spec.get('max', '?')}"
            elif right_spec.get("type") == "percent":
                right = f"{right_spec.get('value', '?')}%"
            else:
                right = right_spec.get("value") or right_spec.get("field") or "?"
        else:
            right = right_spec
        return f"{left_key} {comparator} {right}"
