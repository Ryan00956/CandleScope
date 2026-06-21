"""Pine-like string helper namespace."""
from __future__ import annotations

import builtins
import re
from typing import Any

import numpy as np

from .collections import PyneArray
from .series import PyneSeries
from .values import is_na_value


class StringNamespace:
    """Pine-like ``str.*`` namespace.

    The namespace is callable so scripts can still use ``str(value)`` after
    Pyne injects the Pine-like ``str`` global.
    """

    def __call__(self, value: Any = "") -> str:
        return builtins.str(value)

    def tostring(self, value: Any, format: str | None = None) -> str:
        scalar = _latest_scalar(value)
        if is_na_value(scalar):
            return "na"
        if isinstance(scalar, bool | np.bool_):
            return "true" if bool(scalar) else "false"
        if isinstance(scalar, int | np.integer):
            return builtins.str(int(scalar))
        if isinstance(scalar, float | np.floating):
            return _format_number(float(scalar), format)
        return builtins.str(scalar)

    def tonumber(self, value: Any) -> float | None:
        text = self.tostring(value).strip()
        if text.lower() in {"", "na", "nan"}:
            return None
        try:
            return float(text)
        except ValueError:
            return None

    def length(self, value: Any) -> int:
        return len(self.tostring(value))

    def substring(self, value: Any, begin_pos: int, end_pos: int | None = None) -> str:
        text = self.tostring(value)
        start = max(int(begin_pos), 0)
        end = None if end_pos is None else max(int(end_pos), 0)
        return text[start:end]

    def pos(self, value: Any, substring: Any) -> int:
        return self.tostring(value).find(self.tostring(substring))

    def contains(self, value: Any, substring: Any) -> bool:
        return self.pos(value, substring) >= 0

    def match(self, value: Any, regex: Any) -> str | None:
        matched = re.search(self.tostring(regex), self.tostring(value))
        return None if matched is None else matched.group(0)

    def startswith(self, value: Any, prefix: Any) -> bool:
        return self.tostring(value).startswith(self.tostring(prefix))

    def endswith(self, value: Any, suffix: Any) -> bool:
        return self.tostring(value).endswith(self.tostring(suffix))

    def replace(
        self,
        value: Any,
        target: Any,
        replacement: Any,
        occurrence: int | None = None,
    ) -> str:
        text = self.tostring(value)
        old = self.tostring(target)
        new = self.tostring(replacement)
        if occurrence is None:
            return text.replace(old, new, 1)
        return _replace_occurrence(text, old, new, int(occurrence))

    def replace_all(self, value: Any, target: Any, replacement: Any) -> str:
        return self.tostring(value).replace(self.tostring(target), self.tostring(replacement))

    def split(self, value: Any, separator: Any) -> PyneArray:
        return PyneArray(self.tostring(value).split(self.tostring(separator)))

    def trim(self, value: Any) -> str:
        return self.tostring(value).strip()

    def upper(self, value: Any) -> str:
        return self.tostring(value).upper()

    def lower(self, value: Any) -> str:
        return self.tostring(value).lower()

    def repeat(self, value: Any, count: int) -> str:
        return self.tostring(value) * max(int(count), 0)

    def format(self, template: Any, *args: Any) -> str:
        text = self.tostring(template)
        values = tuple(self.tostring(item) for item in args)
        try:
            return text.format(*values)
        except (IndexError, KeyError, ValueError):
            result = text
            for idx, item in enumerate(values):
                result = result.replace("{" + builtins.str(idx) + "}", item)
            return result


string_namespace = StringNamespace()


def _latest_scalar(value: Any) -> Any:
    if isinstance(value, PyneSeries):
        value = value.to_numpy()
    if isinstance(value, np.ndarray):
        values = value.tolist()
    elif isinstance(value, PyneArray):
        values = value.to_list()
    elif isinstance(value, list | tuple):
        values = list(value)
    else:
        return value

    for item in reversed(values):
        if not is_na_value(item):
            return item
    return None


def _format_number(value: float, format: str | None) -> str:
    if format is None or format == "":
        return builtins.str(int(value)) if value.is_integer() else builtins.str(value)
    fmt = builtins.str(format)
    if fmt in {"price", "volume", "inherit"}:
        return builtins.str(int(value)) if value.is_integer() else builtins.str(value)
    if fmt == "percent":
        return f"{value * 100:g}%"
    if "." in fmt:
        decimals = len(fmt.rsplit(".", 1)[1].rstrip("%"))
        text = f"{value:.{decimals}f}"
        if "#" in fmt:
            text = text.rstrip("0").rstrip(".")
        return text
    return builtins.str(int(value)) if value.is_integer() else builtins.str(value)


def _replace_occurrence(text: str, old: str, new: str, occurrence: int) -> str:
    if old == "":
        return text
    start = 0
    found_at = -1
    for _ in range(max(occurrence, 0) + 1):
        found_at = text.find(old, start)
        if found_at < 0:
            return text
        start = found_at + len(old)
    return text[:found_at] + new + text[found_at + len(old):]
