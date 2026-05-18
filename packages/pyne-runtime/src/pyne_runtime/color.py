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

import numpy as np


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
    def new(base_color: str, transparency: int = 0) -> str:
        """Create a color with transparency.

        Pine equivalent: ``color.new(color.red, 80)``

        Args:
            base_color: Hex color string (e.g. "#ef5350")
            transparency: 0 (opaque) to 100 (fully transparent).
                          Pine uses this convention.

        Returns:
            RGBA color string, e.g. ``"rgba(239,83,80,0.2)"``
        """
        hex_color = base_color.lstrip("#")
        if len(hex_color) == 3:
            hex_color = "".join(c * 2 for c in hex_color)

        r = int(hex_color[0:2], 16)
        g = int(hex_color[2:4], 16)
        b = int(hex_color[4:6], 16)
        alpha = round(1.0 - transparency / 100.0, 2)
        return f"rgba({r},{g},{b},{alpha})"

    @staticmethod
    def when(
        condition: np.ndarray | bool,
        true_color: str,
        false_color: str,
    ) -> np.ndarray | str:
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
        if isinstance(condition, np.ndarray):
            return np.where(condition, true_color, false_color)
        return true_color if condition else false_color

    @staticmethod
    def from_gradient(
        value: np.ndarray,
        low: float,
        high: float,
        low_color: str = "#22c55e",
        high_color: str = "#ef4444",
    ) -> np.ndarray:
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
        low_hex = low_color.lstrip("#")
        high_hex = high_color.lstrip("#")
        lr, lg, lb = int(low_hex[0:2], 16), int(low_hex[2:4], 16), int(low_hex[4:6], 16)
        hr, hg, hb = int(high_hex[0:2], 16), int(high_hex[2:4], 16), int(high_hex[4:6], 16)

        # Normalize values to [0, 1]
        t = np.clip((value - low) / (high - low + 1e-10), 0, 1)

        # Interpolate RGB
        r = (lr + t * (hr - lr)).astype(int)
        g = (lg + t * (hg - lg)).astype(int)
        b = (lb + t * (hb - lb)).astype(int)

        # Build hex strings
        result = np.array([
            f"#{rv:02x}{gv:02x}{bv:02x}"
            for rv, gv, bv in zip(r, g, b)
        ])
        return result


# Module-level singleton — injected as ``color`` in script namespace
color = Color()
