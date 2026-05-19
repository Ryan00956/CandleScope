"""
Pyne Utils — Pine-style utility functions.

Provides commonly used Pine Script helper functions as Python equivalents:
  * ``na`` / ``nz()``         — NaN handling
  * ``shift()``               — Pine's ``close[1]`` equivalent
  * ``crossover()``           — bullish cross detection
  * ``crossunder()``          — bearish cross detection
  * ``highest()`` / ``lowest()`` — rolling extremes
  * ``change()`` / ``roc()``  — price changes
  * ``barssince()``           — bars since condition
  * ``valuewhen()``           — value when condition was true
  * ``pivothigh()`` / ``pivotlow()`` — pivot detection

All functions operate on numpy arrays and return numpy arrays.
"""
from __future__ import annotations

import numpy as np


# ═══════════════════════════════════════════════════════════════
#  NaN Handling
# ═══════════════════════════════════════════════════════════════

# Pine's ``na`` value — alias for NaN
na = np.nan


def nz(src: np.ndarray | float, replacement: float = 0.0) -> np.ndarray | float:
    """Replace NaN values with a replacement value.

    Pine equivalent: ``nz(x, 0)``

    Args:
        src: Input array or scalar.
        replacement: Value to use where src is NaN.

    Returns:
        Array/scalar with NaN replaced.
    """
    if isinstance(src, np.ndarray):
        return np.nan_to_num(src, nan=replacement)
    if src is None or (isinstance(src, float) and np.isnan(src)):
        return replacement
    return src


def na_check(src: np.ndarray) -> np.ndarray:
    """Check which elements are NaN.

    Pine equivalent: ``na(x)``

    Args:
        src: Input array.

    Returns:
        Boolean array — True where value is NaN.
    """
    return np.isnan(src)


# ═══════════════════════════════════════════════════════════════
#  Bar Offset / Shift
# ═══════════════════════════════════════════════════════════════


def shift(src: np.ndarray, periods: int = 1) -> np.ndarray:
    """Shift an array by N periods (like Pine's ``close[1]``).

    Pine equivalent: ``close[n]`` → ``shift(close, n)``

    Args:
        src: Input array.
        periods: Number of bars to look back. Positive = shift right (older values).

    Returns:
        Shifted array with NaN for positions without data.

    Example::

        prev_close = shift(close, 1)  # previous bar's close
        two_bars_ago = shift(close, 2)
    """
    result = np.full_like(src, np.nan, dtype=np.float64)
    if periods >= 0:
        if periods < len(src):
            result[periods:] = src[:len(src) - periods]
    else:
        n = abs(periods)
        if n < len(src):
            result[:len(src) - n] = src[n:]
    return result


# ═══════════════════════════════════════════════════════════════
#  Cross Detection
# ═══════════════════════════════════════════════════════════════


def crossover(a: np.ndarray, b: np.ndarray | float) -> np.ndarray:
    """Detect where ``a`` crosses above ``b`` (bullish cross / golden cross).

    Pine equivalent: ``ta.crossover(a, b)``

    Returns True at bars where ``a[i-1] <= b[i-1]`` and ``a[i] > b[i]``.

    Args:
        a: First series.
        b: Second series (or scalar threshold).

    Returns:
        Boolean array — True at crossover points.
    """
    if isinstance(b, (int, float)):
        b = np.full_like(a, b)
    result = np.zeros(len(a), dtype=bool)
    if len(a) < 2:
        return result
    prev_a = shift(a, 1)
    prev_b = shift(b, 1)
    valid = ~(np.isnan(prev_a) | np.isnan(prev_b) | np.isnan(a) | np.isnan(b))
    result[valid] = (prev_a[valid] <= prev_b[valid]) & (a[valid] > b[valid])
    return result


def crossunder(a: np.ndarray, b: np.ndarray | float) -> np.ndarray:
    """Detect where ``a`` crosses below ``b`` (bearish cross / death cross).

    Pine equivalent: ``ta.crossunder(a, b)``

    Returns True at bars where ``a[i-1] >= b[i-1]`` and ``a[i] < b[i]``.

    Args:
        a: First series.
        b: Second series (or scalar threshold).

    Returns:
        Boolean array — True at crossunder points.
    """
    if isinstance(b, (int, float)):
        b = np.full_like(a, b)
    result = np.zeros(len(a), dtype=bool)
    if len(a) < 2:
        return result
    prev_a = shift(a, 1)
    prev_b = shift(b, 1)
    valid = ~(np.isnan(prev_a) | np.isnan(prev_b) | np.isnan(a) | np.isnan(b))
    result[valid] = (prev_a[valid] >= prev_b[valid]) & (a[valid] < b[valid])
    return result


# ═══════════════════════════════════════════════════════════════
#  Rolling Extremes
# ═══════════════════════════════════════════════════════════════


def highest(src: np.ndarray, period: int) -> np.ndarray:
    """Rolling highest value over the last ``period`` bars.

    Pine equivalent: ``ta.highest(high, 20)``

    Args:
        src: Input array.
        period: Lookback window size.

    Returns:
        Array of rolling maximums. NaN for the first ``period-1`` bars.
    """
    n = len(src)
    result = np.full(n, np.nan)
    for i in range(period - 1, n):
        window = src[i - period + 1: i + 1]
        result[i] = np.nanmax(window)
    return result


def lowest(src: np.ndarray, period: int) -> np.ndarray:
    """Rolling lowest value over the last ``period`` bars.

    Pine equivalent: ``ta.lowest(low, 20)``

    Args:
        src: Input array.
        period: Lookback window size.

    Returns:
        Array of rolling minimums. NaN for the first ``period-1`` bars.
    """
    n = len(src)
    result = np.full(n, np.nan)
    for i in range(period - 1, n):
        window = src[i - period + 1: i + 1]
        result[i] = np.nanmin(window)
    return result


# ═══════════════════════════════════════════════════════════════
#  Price Change Functions
# ═══════════════════════════════════════════════════════════════


def change(src: np.ndarray, period: int = 1) -> np.ndarray:
    """Difference between current and previous value.

    Pine equivalent: ``ta.change(close)`` or ``ta.change(close, 5)``

    Args:
        src: Input array.
        period: Lookback period (default 1).

    Returns:
        Array of differences. NaN for the first ``period`` bars.
    """
    result = np.full_like(src, np.nan, dtype=np.float64)
    if period < len(src):
        result[period:] = src[period:] - src[:len(src) - period]
    return result


def roc(src: np.ndarray, period: int = 1) -> np.ndarray:
    """Rate of Change — percentage change over ``period`` bars.

    Pine equivalent: ``ta.roc(close, 10)``

    ``roc = (src - src[period]) / src[period] * 100``

    Args:
        src: Input array.
        period: Lookback period.

    Returns:
        Array of percentage changes. NaN where undefined.
    """
    result = np.full_like(src, np.nan, dtype=np.float64)
    if period < len(src):
        prev = src[:len(src) - period]
        curr = src[period:]
        with np.errstate(divide="ignore", invalid="ignore"):
            result[period:] = np.where(prev != 0, (curr - prev) / prev * 100, np.nan)
    return result


# ═══════════════════════════════════════════════════════════════
#  Condition-Based Lookback
# ═══════════════════════════════════════════════════════════════


def barssince(condition: np.ndarray) -> np.ndarray:
    """Number of bars since condition was last True.

    Pine equivalent: ``ta.barssince(crossover(fast, slow))``

    Args:
        condition: Boolean array.

    Returns:
        Integer array — bars since last True. NaN if never True before.
    """
    n = len(condition)
    result = np.full(n, np.nan)
    last_true = -1
    for i in range(n):
        if condition[i]:
            last_true = i
        if last_true >= 0:
            result[i] = float(i - last_true)
    return result


def valuewhen(condition: np.ndarray, src: np.ndarray, occurrence: int = 0) -> np.ndarray:
    """Value of ``src`` when ``condition`` was True.

    Pine equivalent: ``ta.valuewhen(crossover(fast, slow), close, 0)``

    Args:
        condition: Boolean array.
        src: Value array to sample from.
        occurrence: Which occurrence to return (0 = most recent, 1 = second most recent, etc.)

    Returns:
        Array where each element is the value of src at the nth most recent True.
    """
    n = len(condition)
    result = np.full(n, np.nan)
    true_indices: list[int] = []

    for i in range(n):
        if condition[i]:
            true_indices.append(i)
        if len(true_indices) > occurrence:
            idx = true_indices[-(occurrence + 1)]
            result[i] = src[idx]
    return result


# ═══════════════════════════════════════════════════════════════
#  Pivot Detection
# ═══════════════════════════════════════════════════════════════


def pivothigh(src: np.ndarray, left: int, right: int) -> np.ndarray:
    """Detect pivot highs.

    Pine equivalent: ``ta.pivothigh(high, 5, 5)``

    A pivot high at bar ``i`` means ``src[i]`` is the highest value
    in the window ``[i-left, i+right]``.

    Args:
        src: Input array (typically ``high``).
        left: Number of bars to the left.
        right: Number of bars to the right.

    Returns:
        Array with pivot high values at pivot bars, NaN elsewhere.
        Note: Results are delayed by ``right`` bars.
    """
    n = len(src)
    result = np.full(n, np.nan)

    for i in range(left, n - right):
        window = src[i - left: i + right + 1]
        if not np.any(np.isnan(window)):
            if src[i] == np.max(window) and np.sum(window == src[i]) == 1:
                result[i] = src[i]

    return result


def pivotlow(src: np.ndarray, left: int, right: int) -> np.ndarray:
    """Detect pivot lows.

    Pine equivalent: ``ta.pivotlow(low, 5, 5)``

    A pivot low at bar ``i`` means ``src[i]`` is the lowest value
    in the window ``[i-left, i+right]``.

    Args:
        src: Input array (typically ``low``).
        left: Number of bars to the left.
        right: Number of bars to the right.

    Returns:
        Array with pivot low values at pivot bars, NaN elsewhere.
    """
    n = len(src)
    result = np.full(n, np.nan)

    for i in range(left, n - right):
        window = src[i - left: i + right + 1]
        if not np.any(np.isnan(window)):
            if src[i] == np.min(window) and np.sum(window == src[i]) == 1:
                result[i] = src[i]

    return result


# ═══════════════════════════════════════════════════════════════
#  Summation
# ═══════════════════════════════════════════════════════════════


def cum(src: np.ndarray) -> np.ndarray:
    """Cumulative sum.

    Pine equivalent: ``ta.cum(close)``

    Args:
        src: Input array.

    Returns:
        Cumulative sum array (NaN-aware).
    """
    return np.nancumsum(src)


def sum_(src: np.ndarray, period: int) -> np.ndarray:
    """Rolling sum over the last ``period`` bars.

    Pine equivalent: ``math.sum(src, period)``

    Args:
        src: Input array.
        period: Window size.

    Returns:
        Rolling sum array. NaN for the first ``period-1`` bars.
    """
    n = len(src)
    result = np.full(n, np.nan)
    rolling = 0.0
    nan_count = 0

    for i in range(n):
        val = src[i]
        if np.isnan(val):
            nan_count += 1
        else:
            rolling += val

        if i >= period:
            old = src[i - period]
            if np.isnan(old):
                nan_count -= 1
            else:
                rolling -= old

        if i >= period - 1 and nan_count == 0:
            result[i] = rolling

    return result


# ═══════════════════════════════════════════════════════════════
#  Comparison Helpers
# ═══════════════════════════════════════════════════════════════


def rising(src: np.ndarray, period: int = 1) -> np.ndarray:
    """True when src has been rising for ``period`` consecutive bars.

    Pine equivalent: ``ta.rising(close, 5)``
    """
    result = np.zeros(len(src), dtype=bool)
    for i in range(period, len(src)):
        is_rising = True
        for j in range(period):
            if np.isnan(src[i - j]) or np.isnan(src[i - j - 1]):
                is_rising = False
                break
            if src[i - j] <= src[i - j - 1]:
                is_rising = False
                break
        result[i] = is_rising
    return result


def falling(src: np.ndarray, period: int = 1) -> np.ndarray:
    """True when src has been falling for ``period`` consecutive bars.

    Pine equivalent: ``ta.falling(close, 5)``
    """
    result = np.zeros(len(src), dtype=bool)
    for i in range(period, len(src)):
        is_falling = True
        for j in range(period):
            if np.isnan(src[i - j]) or np.isnan(src[i - j - 1]):
                is_falling = False
                break
            if src[i - j] >= src[i - j - 1]:
                is_falling = False
                break
        result[i] = is_falling
    return result
