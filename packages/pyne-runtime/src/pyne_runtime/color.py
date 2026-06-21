"""
Pyne Color — Pine-style color constants and helper functions.

Provides ``color.*`` constants that mirror TradingView's Pine Script
color namespace, plus helper functions for dynamic coloring.

Usage::

    plot(ta.sma(close, 20), color=color.blue)
    col = color.when(close > open, color.green, color.red)
    transparent_blue = color.new(color.blue, 80)  # 80% transparent
"""
from __future__ import annotations

import re
from typing import Any

import numpy as np

from .series import PyneSeries, to_numpy, wrap_like
from .values import is_na_sentinel, is_na_value


class Color:
    """Pine-style color namespace.

    Access named colors as ``color.red``, ``color.blue``, etc.
    All colors are CSS hex strings.
    """

    # ── Standard Pine Script colors ──────────────────────────
    aqua = "#00bcd4"
    black = "#000000"
    blue = "#2196f3"
    fuchsia = "#e91e63"
    gray = "#787b86"
    grey = "#787b86"
    green = "#26a69a"
    lime = "#00e676"
    maroon = "#880e4f"
    navy = "#1a237e"
    olive = "#827717"
    orange = "#f59e0b"
    purple = "#9c27b0"
    red = "#ef5350"
    silver = "#b2b5be"
    teal = "#009688"
    white = "#ffffff"
    yellow = "#ffeb3b"

    # ── Extended colors (common in trading) ──────────────────
    up = "#26a69a"          # bullish candle green
    down = "#ef5350"        # bearish candle red
    bull = "#26a69a"
    bear = "#ef5350"

    @staticmethod
    def rgb(
        red: int | float | PyneSeries | np.ndarray,
        green: int | float | PyneSeries | np.ndarray,
        blue: int | float | PyneSeries | np.ndarray,
        transparency: int | float | PyneSeries | np.ndarray = 0,
    ) -> str | PyneSeries | np.ndarray:
        """Create a color from RGB channels and Pine-style transparency."""
        template = _first_series(red, green, blue, transparency)
        if template is not None:
            red_values, green_values, blue_values, transp_values = np.broadcast_arrays(
                _to_array(red),
                _to_array(green),
                _to_array(blue),
                _to_array(transparency),
            )
            result = np.array([
                _format_color(r, g, b, t)
                for r, g, b, t in zip(red_values, green_values, blue_values, transp_values)
            ])
            return wrap_like(result, template)
        return _format_color(red, green, blue, transparency)

    @staticmethod
    def new(
        base_color: str | PyneSeries | np.ndarray,
        transparency: int | float | PyneSeries | np.ndarray = 0,
    ) -> str | PyneSeries | np.ndarray:
        """Create a color with transparency.

        Pine equivalent: ``color.new(color.red, 80)``

        Args:
            base_color: Hex color string (e.g. "#ef5350")
            transparency: 0 (opaque) to 100 (fully transparent).
                          Pine uses this convention.

        Returns:
            RGBA color string, e.g. ``"rgba(239,83,80,0.2)"``
        """
        template = _first_series(base_color, transparency)
        if template is not None:
            color_values, transp_values = np.broadcast_arrays(_to_array(base_color), _to_array(transparency))
            result = np.array([
                _format_color(*_rgb_channels(color_value), transp)
                for color_value, transp in zip(color_values, transp_values)
            ])
            return wrap_like(result, template)
        return _format_color(*_rgb_channels(base_color), transparency)

    @staticmethod
    def r(color_value: Any) -> int | PyneSeries | np.ndarray | None:
        """Return the red channel from a color string."""
        return _channel(color_value, 0)

    @staticmethod
    def g(color_value: Any) -> int | PyneSeries | np.ndarray | None:
        """Return the green channel from a color string."""
        return _channel(color_value, 1)

    @staticmethod
    def b(color_value: Any) -> int | PyneSeries | np.ndarray | None:
        """Return the blue channel from a color string."""
        return _channel(color_value, 2)

    @staticmethod
    def t(color_value: Any) -> int | PyneSeries | np.ndarray | None:
        """Return Pine-style transparency from a color string."""
        template = _first_series(color_value)
        if template is not None:
            result = np.array([
                np.nan if is_na_value(item) else float(_transparency(item))
                for item in _to_array(color_value)
            ])
            return wrap_like(result, template)
        if is_na_value(color_value):
            return None
        return _transparency(color_value)

    @staticmethod
    def when(
        condition: PyneSeries | np.ndarray | bool,
        true_color: str,
        false_color: str,
    ) -> PyneSeries | np.ndarray | str:
        """Conditional color selection.

        Pine equivalent: ``condition ? color.green : color.red``

        Args:
            condition: Boolean array or scalar.
            true_color: Color when condition is True.
            false_color: Color when condition is False.

        Returns:
            If condition is a numpy array, returns an array of color strings.
            If condition is a scalar bool, returns a single color string.
        """
        if isinstance(condition, PyneSeries):
            result = np.where(
                to_numpy(condition, dtype=bool),
                "" if is_na_sentinel(true_color) else true_color,
                "" if is_na_sentinel(false_color) else false_color,
            )
            return wrap_like(result, condition)
        if isinstance(condition, np.ndarray):
            return np.where(
                condition,
                "" if is_na_sentinel(true_color) else true_color,
                "" if is_na_sentinel(false_color) else false_color,
            )
        return true_color if condition else false_color

    @staticmethod
    def from_gradient(
        value: PyneSeries | np.ndarray | int | float,
        low: float,
        high: float,
        low_color: str = "#22c55e",
        high_color: str = "#ef4444",
    ) -> PyneSeries | np.ndarray | str:
        """Map values to a color gradient.

        Useful for heatmap-style coloring, e.g. RSI coloring by value.

        Args:
            value: Array of numeric values.
            low: Value that maps to low_color.
            high: Value that maps to high_color.
            low_color: Color for the low end.
            high_color: Color for the high end.

        Returns:
            Array of hex color strings.
        """
        lr, lg, lb = _rgb_channels(low_color)
        hr, hg, hb = _rgb_channels(high_color)

        # Normalize values to [0, 1]
        scalar = not isinstance(value, PyneSeries | np.ndarray)
        values = np.array([value], dtype=np.float64) if scalar else to_numpy(value, dtype=np.float64)
        t = np.clip((values - low) / (high - low + 1e-10), 0, 1)

        # Interpolate RGB
        r = (lr + t * (hr - lr)).astype(int)
        g = (lg + t * (hg - lg)).astype(int)
        b = (lb + t * (hb - lb)).astype(int)

        # Build hex strings
        result = np.array([
            f"#{rv:02x}{gv:02x}{bv:02x}"
            for rv, gv, bv in zip(r, g, b)
        ])
        if scalar:
            return str(result[0])
        return wrap_like(result, value)


# Module-level singleton — injected as ``color`` in script namespace
color = Color()


_RGBA_RE = re.compile(
    r"rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)"
    r"(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)",
    re.IGNORECASE,
)


def _first_series(*values: Any) -> PyneSeries | np.ndarray | None:
    for value in values:
        if isinstance(value, PyneSeries | np.ndarray):
            return value
    return None


def _to_array(value: Any) -> np.ndarray:
    if isinstance(value, PyneSeries):
        return value.to_numpy()
    if isinstance(value, np.ndarray):
        return value
    return np.asarray(value)


def _format_color(red: Any, green: Any, blue: Any, transparency: Any = 0) -> str:
    r = _clamp_channel(red)
    g = _clamp_channel(green)
    b = _clamp_channel(blue)
    t = _clamp_transparency(transparency)
    if t <= 0:
        return f"#{r:02x}{g:02x}{b:02x}"
    alpha = round(1.0 - t / 100.0, 2)
    return f"rgba({r},{g},{b},{alpha})"


def _rgb_channels(color_value: Any) -> tuple[int, int, int]:
    if is_na_value(color_value):
        return (0, 0, 0)
    text = str(color_value).strip()
    if text.startswith("#"):
        hex_color = text.lstrip("#")
        if len(hex_color) == 3:
            hex_color = "".join(item * 2 for item in hex_color)
        if len(hex_color) >= 6:
            return (
                int(hex_color[0:2], 16),
                int(hex_color[2:4], 16),
                int(hex_color[4:6], 16),
            )
    match = _RGBA_RE.fullmatch(text)
    if match is not None:
        return (
            _clamp_channel(match.group(1)),
            _clamp_channel(match.group(2)),
            _clamp_channel(match.group(3)),
        )
    raise ValueError(f"Unsupported color format: {text}")


def _transparency(color_value: str) -> int:
    text = str(color_value).strip()
    if text.startswith("#"):
        return 0
    match = _RGBA_RE.fullmatch(text)
    if match is None or match.group(4) is None:
        return 0
    alpha = max(min(float(match.group(4)), 1.0), 0.0)
    return int(round((1.0 - alpha) * 100))


def _channel(color_value: Any, index: int) -> int | PyneSeries | np.ndarray | None:
    template = _first_series(color_value)
    if template is not None:
        result = np.array([
            np.nan if is_na_value(item) else float(_rgb_channels(item)[index])
            for item in _to_array(color_value)
        ])
        return wrap_like(result, template)
    if is_na_value(color_value):
        return None
    return _rgb_channels(color_value)[index]


def _clamp_channel(value: Any) -> int:
    return max(min(int(round(float(value))), 255), 0)


def _clamp_transparency(value: Any) -> int:
    return max(min(int(round(float(value))), 100), 0)
