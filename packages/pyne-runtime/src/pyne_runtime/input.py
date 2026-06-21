"""
Pyne Input — Pine-style ``input.*`` parameter declaration API.

Provides a declarative way to define user-configurable parameters,
mirroring TradingView's ``input.int()``, ``input.float()``, etc.

Each ``input.*`` call does two things:
  1. Returns the current parameter value (from user params or default).
  2. Records the parameter schema so the frontend can generate a UI.

Usage::

    length = input.int(20, "Period", minval=1, maxval=500)
    mult   = input.float(2.0, "Multiplier", step=0.1)
    src    = input.source(close, "Source")
    show   = input.bool(True, "Show MA")
    col    = input.color("#f59e0b", "Color")
"""
from __future__ import annotations

from typing import Any, TYPE_CHECKING

import numpy as np

from .series import PyneSeries

if TYPE_CHECKING:
    from .context import PyneContext


class PyneInputError(Exception):
    """Raised when user-provided ``input.*`` params fail validation."""

    code = "PYNE_INVALID_PARAM"


class InputModule:
    """Pine-style input namespace.

    Collects parameter schemas while returning runtime values.

    The runtime creates a fresh ``InputModule`` for each script execution,
    passing in the user-provided ``params`` dict and the data ``context``.
    """

    def __init__(
        self,
        params: dict[str, Any] | None = None,
        context: PyneContext | None = None,
    ) -> None:
        self._params = params or {}
        self._ctx = context
        self._schema: list[dict[str, Any]] = []
        self._seen_keys: set[str] = set()
        self._schema_entries: dict[str, dict[str, Any]] = {}

    @property
    def schema(self) -> list[dict[str, Any]]:
        """Collected parameter schemas (for frontend UI generation)."""
        return self._schema

    def _resolve(self, key: str, default: Any, schema_entry: dict) -> Any:
        """Core resolution logic shared by all input.* methods."""
        schema_entry.setdefault("id", key)
        # Avoid duplicate schema entries if param() called multiple times
        if key not in self._seen_keys:
            self._seen_keys.add(key)
            self._schema_entries[key] = schema_entry
            self._schema.append(schema_entry)

        # Return user-provided value if available
        if key in self._params:
            return self._params[key]
        return default

    def _set_current(self, key: str, value: Any) -> None:
        entry = self._schema_entries.get(key)
        if entry is not None:
            entry["current"] = value

    def _next_key(self, title: str, prefix: str) -> str:
        base = title or f"{prefix}_{len(self._schema)}"
        if base not in self._seen_keys:
            return base
        suffix = 2
        while f"{base}_{suffix}" in self._seen_keys:
            suffix += 1
        return f"{base}_{suffix}"

    def _invalid(self, key: str, message: str) -> PyneInputError:
        return PyneInputError(f"Invalid input parameter '{key}': {message}")

    def _coerce_int(self, key: str, value: Any) -> int:
        if isinstance(value, bool):
            raise self._invalid(key, "expected an integer, got bool")
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            if value.is_integer():
                return int(value)
            raise self._invalid(key, f"expected an integer, got {value!r}")
        if isinstance(value, str):
            text = value.strip()
            try:
                number = float(text)
            except ValueError:
                raise self._invalid(key, f"expected an integer, got {value!r}") from None
            if number.is_integer():
                return int(number)
        raise self._invalid(key, f"expected an integer, got {type(value).__name__}")

    def _coerce_float(self, key: str, value: Any) -> float:
        if isinstance(value, bool):
            raise self._invalid(key, "expected a number, got bool")
        if isinstance(value, int | float):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.strip())
            except ValueError:
                pass
        raise self._invalid(key, f"expected a number, got {type(value).__name__}")

    def _coerce_bool(self, key: str, value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, int) and value in {0, 1}:
            return bool(value)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "1"}:
                return True
            if lowered in {"false", "0"}:
                return False
        raise self._invalid(key, f"expected a boolean, got {type(value).__name__}")

    def _coerce_str(self, key: str, value: Any) -> str:
        if isinstance(value, str):
            return value
        raise self._invalid(key, f"expected a string, got {type(value).__name__}")

    def _coerce_time(self, key: str, value: Any) -> int:
        result = self._coerce_int(key, value)
        if result < 0:
            raise self._invalid(key, "expected a non-negative Unix timestamp")
        return result

    def _validate_options(self, key: str, value: str, options: list[str] | None) -> None:
        if options is not None and value not in options:
            choices = ", ".join(repr(option) for option in options)
            raise self._invalid(key, f"expected one of {choices}, got {value!r}")

    def _validate_bounds(
        self,
        key: str,
        value: int | float,
        *,
        minval: int | float | None = None,
        maxval: int | float | None = None,
    ) -> None:
        if minval is not None and value < minval:
            raise self._invalid(key, f"must be >= {minval}, got {value!r}")
        if maxval is not None and value > maxval:
            raise self._invalid(key, f"must be <= {maxval}, got {value!r}")

    # ─── Typed input methods ────────────────────────────────

    def int(
        self,
        defval: int = 0,
        title: str = "",
        minval: int | None = None,
        maxval: int | None = None,
        step: int = 1,
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> int:
        """Integer parameter.

        Pine equivalent: ``input.int(20, "Period", minval=1, maxval=500)``
        """
        key = self._next_key(title, "int")
        schema = {
            "key": key,
            "type": "int",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
            "step": step,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm
        if minval is not None:
            schema["min"] = minval
            schema["minval"] = minval
        if maxval is not None:
            schema["max"] = maxval
            schema["maxval"] = maxval

        val = self._resolve(key, defval, schema)
        val = self._coerce_int(key, val)
        self._validate_bounds(key, val, minval=minval, maxval=maxval)
        self._set_current(key, val)
        return val

    def float(
        self,
        defval: float = 0.0,
        title: str = "",
        minval: float | None = None,
        maxval: float | None = None,
        step: float = 0.1,
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> float:
        """Float parameter.

        Pine equivalent: ``input.float(2.0, "Multiplier", step=0.1)``
        """
        key = self._next_key(title, "float")
        schema = {
            "key": key,
            "type": "float",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm
        if minval is not None:
            schema["min"] = minval
            schema["minval"] = minval
        if maxval is not None:
            schema["max"] = maxval
            schema["maxval"] = maxval
        schema["step"] = step

        val = self._resolve(key, defval, schema)
        val = self._coerce_float(key, val)
        self._validate_bounds(key, val, minval=minval, maxval=maxval)
        self._set_current(key, val)
        return val

    def bool(
        self,
        defval: bool = True,
        title: str = "",
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> bool:
        """Boolean parameter.

        Pine equivalent: ``input.bool(true, "Show MA")``
        """
        key = self._next_key(title, "bool")
        schema = {
            "key": key,
            "type": "bool",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm
        val = self._resolve(key, defval, schema)
        result = self._coerce_bool(key, val)
        self._set_current(key, result)
        return result

    def string(
        self,
        defval: str = "",
        title: str = "",
        options: list[str] | None = None,
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> str:
        """String parameter (optionally with dropdown options).

        Pine equivalent: ``input.string("SMA", "Type", options=["SMA","EMA","WMA"])``
        """
        key = self._next_key(title, "string")
        schema: dict[str, Any] = {
            "key": key,
            "type": "string",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm
        if options is not None:
            schema["options"] = options

        val = self._resolve(key, defval, schema)
        result = self._coerce_str(key, val)
        self._validate_options(key, result, options)
        self._set_current(key, result)
        return result

    def color(
        self,
        defval: str = "#f59e0b",
        title: str = "",
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> str:
        """Color parameter.

        Pine equivalent: ``input.color(color.orange, "Color")``
        """
        key = self._next_key(title, "color")
        schema = {
            "key": key,
            "type": "color",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm
        val = self._resolve(key, defval, schema)
        result = self._coerce_str(key, val)
        self._set_current(key, result)
        return result

    def source(
        self,
        defval: PyneSeries | np.ndarray | str | None = None,
        title: str = "Source",
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> PyneSeries:
        """Source parameter — select price field (close, open, hl2, etc.).

        Pine equivalent: ``input.source(close, "Source")``

        Args:
            defval: Default source. Can be a numpy array (like ``close``)
                    or a string name (like ``"close"``).
            title: Display title.

        Returns:
            The selected source as a numpy array.
        """
        if self._ctx is None:
            raise RuntimeError("input.source() requires a Pyne runtime context")

        # Determine default source name
        if defval is None or isinstance(defval, (np.ndarray, PyneSeries)):
            default_name = (
                self._identify_source(defval)
                if isinstance(defval, (np.ndarray, PyneSeries))
                else "close"
            )
        else:
            default_name = str(defval)

        options = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"]

        key = self._next_key(title, "source")
        schema = {
            "key": key,
            "type": "source",
            "default": default_name,
            "title": title,
            "options": options,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm

        selected = self._resolve(key, default_name, schema)

        # If user passed a string name, resolve it
        if isinstance(selected, str):
            self._validate_options(key, selected, options)
            self._set_current(key, selected)
            return self._ctx.resolve_source(selected)
        # If it's already a source object (from default), use it
        if isinstance(selected, (np.ndarray, PyneSeries)):
            self._set_current(key, default_name)
            return selected
        # Fallback
        self._set_current(key, "close")
        return self._ctx.close

    def timeframe(
        self,
        defval: str = "",
        title: str = "",
        options: list[str] | None = None,
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> str:
        """Timeframe parameter.

        Pine equivalent: ``input.timeframe("60", "Higher Timeframe")``.
        """
        key = self._next_key(title, "timeframe")
        schema: dict[str, Any] = {
            "key": key,
            "type": "timeframe",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm
        if options is not None:
            schema["options"] = options

        val = self._resolve(key, defval, schema)
        result = self._coerce_str(key, val)
        self._validate_options(key, result, options)
        self._set_current(key, result)
        return result

    def symbol(
        self,
        defval: str = "",
        title: str = "",
        options: list[str] | None = None,
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> str:
        """Symbol parameter.

        Pine equivalent: ``input.symbol("NASDAQ:AAPL", "Symbol")``.
        """
        key = self._next_key(title, "symbol")
        schema: dict[str, Any] = {
            "key": key,
            "type": "symbol",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm
        if options is not None:
            schema["options"] = options

        val = self._resolve(key, defval, schema)
        result = self._coerce_str(key, val)
        self._validate_options(key, result, options)
        self._set_current(key, result)
        return result

    def session(
        self,
        defval: str = "0000-2359",
        title: str = "",
        options: list[str] | None = None,
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> str:
        """Session parameter.

        Pine equivalent: ``input.session("0930-1600", "Session")``.
        """
        key = self._next_key(title, "session")
        schema: dict[str, Any] = {
            "key": key,
            "type": "session",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm
        if options is not None:
            schema["options"] = options

        val = self._resolve(key, defval, schema)
        result = self._coerce_str(key, val)
        self._validate_options(key, result, options)
        self._set_current(key, result)
        return result

    def time(
        self,
        defval: int | float = 0,
        title: str = "",
        tooltip: str = "",
        group: str = "",
        inline: str = "",
        confirm: bool = False,
    ) -> int:
        """Timestamp parameter in Unix seconds.

        Pine equivalent: ``input.time(timestamp, "Start Time")``.
        """
        key = self._next_key(title, "time")
        schema: dict[str, Any] = {
            "key": key,
            "type": "time",
            "default": int(defval),
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if inline:
            schema["inline"] = inline
        if confirm:
            schema["confirm"] = confirm

        val = self._resolve(key, int(defval), schema)
        result = self._coerce_time(key, val)
        self._set_current(key, result)
        return result

    def _identify_source(self, arr: PyneSeries | np.ndarray) -> str:
        """Try to identify which source a numpy array corresponds to."""
        if self._ctx is None:
            return "close"
        names = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"]
        if isinstance(arr, PyneSeries) and arr.name in names:
            return arr.name
        for name in names:
            ctx_arr = self._ctx.resolve_source(name)
            if arr is ctx_arr:
                return name
            if isinstance(arr, np.ndarray) and np.asarray(ctx_arr) is arr:
                return name
        return "close"
