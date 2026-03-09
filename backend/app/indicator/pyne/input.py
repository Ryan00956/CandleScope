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

if TYPE_CHECKING:
    from .context import PyneContext


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

    @property
    def schema(self) -> list[dict[str, Any]]:
        """Collected parameter schemas (for frontend UI generation)."""
        return self._schema

    def _resolve(self, key: str, default: Any, schema_entry: dict) -> Any:
        """Core resolution logic shared by all input.* methods."""
        # Avoid duplicate schema entries if param() called multiple times
        if key not in self._seen_keys:
            self._seen_keys.add(key)
            self._schema.append(schema_entry)

        # Return user-provided value if available
        if key in self._params:
            return self._params[key]
        return default

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
    ) -> int:
        """Integer parameter.

        Pine equivalent: ``input.int(20, "Period", minval=1, maxval=500)``
        """
        key = title or f"int_{len(self._schema)}"
        schema = {
            "key": key,
            "type": "int",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if minval is not None:
            schema["min"] = minval
        if maxval is not None:
            schema["max"] = maxval
        if step != 1:
            schema["step"] = step

        val = self._resolve(key, defval, schema)
        # Clamp to bounds
        val = int(val)
        if minval is not None:
            val = max(val, minval)
        if maxval is not None:
            val = min(val, maxval)
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
    ) -> float:
        """Float parameter.

        Pine equivalent: ``input.float(2.0, "Multiplier", step=0.1)``
        """
        key = title or f"float_{len(self._schema)}"
        schema = {
            "key": key,
            "type": "float",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if minval is not None:
            schema["min"] = minval
        if maxval is not None:
            schema["max"] = maxval
        schema["step"] = step

        val = self._resolve(key, defval, schema)
        val = float(val)
        if minval is not None:
            val = max(val, minval)
        if maxval is not None:
            val = min(val, maxval)
        return val

    def bool(
        self,
        defval: bool = True,
        title: str = "",
        tooltip: str = "",
        group: str = "",
    ) -> bool:
        """Boolean parameter.

        Pine equivalent: ``input.bool(true, "Show MA")``
        """
        key = title or f"bool_{len(self._schema)}"
        schema = {
            "key": key,
            "type": "bool",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        val = self._resolve(key, defval, schema)
        return bool(val)

    def string(
        self,
        defval: str = "",
        title: str = "",
        options: list[str] | None = None,
        tooltip: str = "",
        group: str = "",
    ) -> str:
        """String parameter (optionally with dropdown options).

        Pine equivalent: ``input.string("SMA", "Type", options=["SMA","EMA","WMA"])``
        """
        key = title or f"string_{len(self._schema)}"
        schema: dict[str, Any] = {
            "key": key,
            "type": "string",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        if options is not None:
            schema["options"] = options

        val = self._resolve(key, defval, schema)
        if options and val not in options:
            val = defval
        return str(val)

    def color(
        self,
        defval: str = "#f59e0b",
        title: str = "",
        tooltip: str = "",
        group: str = "",
    ) -> str:
        """Color parameter.

        Pine equivalent: ``input.color(color.orange, "Color")``
        """
        key = title or f"color_{len(self._schema)}"
        schema = {
            "key": key,
            "type": "color",
            "default": defval,
            "title": title,
            "tooltip": tooltip,
            "group": group,
        }
        val = self._resolve(key, defval, schema)
        return str(val)

    def source(
        self,
        defval: np.ndarray | str | None = None,
        title: str = "Source",
        tooltip: str = "",
        group: str = "",
    ) -> np.ndarray:
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
        if defval is None or isinstance(defval, np.ndarray):
            default_name = self._identify_source(defval) if isinstance(defval, np.ndarray) else "close"
        else:
            default_name = str(defval)

        options = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"]

        key = title or "Source"
        schema = {
            "key": key,
            "type": "source",
            "default": default_name,
            "title": title,
            "options": options,
            "tooltip": tooltip,
            "group": group,
        }

        selected = self._resolve(key, default_name, schema)

        # If user passed a string name, resolve it
        if isinstance(selected, str):
            return self._ctx.resolve_source(selected)
        # If it's already a numpy array (from default), use it
        if isinstance(selected, np.ndarray):
            return selected
        # Fallback
        return self._ctx.close

    def _identify_source(self, arr: np.ndarray) -> str:
        """Try to identify which source a numpy array corresponds to."""
        if self._ctx is None:
            return "close"
        for name in ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"]:
            ctx_arr = self._ctx.resolve_source(name)
            if arr is ctx_arr:
                return name
        return "close"
