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

from .series import PyneSeries, to_numpy, wrap_like
from .values import is_na, is_na_value, na as _na, to_missing_scalar


# ═══════════════════════════════════════════════════════════════
#  NaN Handling
# ═══════════════════════════════════════════════════════════════

# Pine's ``na`` value — alias for NaN
na = _na


def nz(src: PyneSeries | np.ndarray | float, replacement: float = 0.0) -> PyneSeries | np.ndarray | float:
    """Replace NaN values with a replacement value.

    Pine equivalent: ``nz(x, 0)``

    Args:
        src: Input array or scalar.
        replacement: Value to use where src is NaN.

    Returns:
        Array/scalar with NaN replaced.
    """
    replacement = to_missing_scalar(replacement)
    if isinstance(src, PyneSeries):
        values = src.to_numpy()
        mask = to_numpy(is_na(src), dtype=bool)
        return src.with_values(np.where(mask, replacement, values))
    if isinstance(src, np.ndarray):
        mask = is_na(src)
        return np.where(mask, replacement, src)
    if is_na_value(src):
        return replacement
    return src


def fixnan(src: PyneSeries | np.ndarray | list | tuple | float) -> PyneSeries | np.ndarray | float:
    """Carry the latest non-missing value forward through later missing values."""
    if isinstance(src, PyneSeries):
        values = _fixnan_array(to_numpy(src, dtype=np.float64))
        return src.with_values(values)
    if isinstance(src, np.ndarray):
        return _fixnan_array(np.asarray(src, dtype=np.float64))
    if isinstance(src, list | tuple):
        return _fixnan_array(np.asarray(src, dtype=np.float64))
    if is_na_value(src):
        return np.nan
    return src


def na_check(src: PyneSeries | np.ndarray) -> PyneSeries | np.ndarray:
    """Check which elements are NaN.

    Pine equivalent: ``na(x)``

    Args:
        src: Input array.

    Returns:
        Boolean array — True where value is NaN.
    """
    result = is_na(src)
    return result if isinstance(result, PyneSeries) else wrap_like(result, src)


# ═══════════════════════════════════════════════════════════════
#  Bar Offset / Shift
# ═══════════════════════════════════════════════════════════════


def _fixnan_array(values: np.ndarray) -> np.ndarray:
    result = np.array(values, dtype=np.float64, copy=True)
    last = np.nan
    for idx, value in enumerate(result):
        if np.isnan(value):
            if not np.isnan(last):
                result[idx] = last
            continue
        last = value
    return result


def shift(src: PyneSeries | np.ndarray, periods: int = 1) -> PyneSeries | np.ndarray:
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
    periods = int(periods)
    if periods < 0:
        raise IndexError("shift() does not support forward history references")
    source = to_numpy(src, dtype=np.float64)
    result = np.full_like(source, np.nan, dtype=np.float64)
    if periods < len(source):
        result[periods:] = source[:len(source) - periods]
    return wrap_like(result, src)


# ═══════════════════════════════════════════════════════════════
#  Cross Detection
# ═══════════════════════════════════════════════════════════════


def crossover(a: PyneSeries | np.ndarray, b: PyneSeries | np.ndarray | float) -> PyneSeries | np.ndarray:
    """Detect where ``a`` crosses above ``b`` (bullish cross / golden cross).

    Pine equivalent: ``ta.crossover(a, b)``

    Returns True at bars where ``a[i-1] <= b[i-1]`` and ``a[i] > b[i]``.

    Args:
        a: First series.
        b: Second series (or scalar threshold).

    Returns:
        Boolean array — True at crossover points.
    """
    a_arr = to_numpy(a, dtype=np.float64)
    b_arr = np.full_like(a_arr, b, dtype=np.float64) if isinstance(b, (int, float)) else to_numpy(b, dtype=np.float64)
    result = np.zeros(len(a_arr), dtype=bool)
    if len(a_arr) < 2:
        return wrap_like(result, a, b)
    prev_a = to_numpy(shift(a_arr, 1), dtype=np.float64)
    prev_b = to_numpy(shift(b_arr, 1), dtype=np.float64)
    valid = ~(np.isnan(prev_a) | np.isnan(prev_b) | np.isnan(a_arr) | np.isnan(b_arr))
    result[valid] = (prev_a[valid] <= prev_b[valid]) & (a_arr[valid] > b_arr[valid])
    return wrap_like(result, a, b)


def crossunder(a: PyneSeries | np.ndarray, b: PyneSeries | np.ndarray | float) -> PyneSeries | np.ndarray:
    """Detect where ``a`` crosses below ``b`` (bearish cross / death cross).

    Pine equivalent: ``ta.crossunder(a, b)``

    Returns True at bars where ``a[i-1] >= b[i-1]`` and ``a[i] < b[i]``.

    Args:
        a: First series.
        b: Second series (or scalar threshold).

    Returns:
        Boolean array — True at crossunder points.
    """
    a_arr = to_numpy(a, dtype=np.float64)
    b_arr = np.full_like(a_arr, b, dtype=np.float64) if isinstance(b, (int, float)) else to_numpy(b, dtype=np.float64)
    result = np.zeros(len(a_arr), dtype=bool)
    if len(a_arr) < 2:
        return wrap_like(result, a, b)
    prev_a = to_numpy(shift(a_arr, 1), dtype=np.float64)
    prev_b = to_numpy(shift(b_arr, 1), dtype=np.float64)
    valid = ~(np.isnan(prev_a) | np.isnan(prev_b) | np.isnan(a_arr) | np.isnan(b_arr))
    result[valid] = (prev_a[valid] >= prev_b[valid]) & (a_arr[valid] < b_arr[valid])
    return wrap_like(result, a, b)


def cross(a: PyneSeries | np.ndarray, b: PyneSeries | np.ndarray | float) -> PyneSeries | np.ndarray:
    """Detect any cross between ``a`` and ``b``.

    Pine equivalent: ``ta.cross(a, b)``.
    """
    return crossover(a, b) | crossunder(a, b)


# ═══════════════════════════════════════════════════════════════
#  Rolling Extremes
# ═══════════════════════════════════════════════════════════════


def highest(src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
    """Rolling highest value over the last ``period`` bars.

    Pine equivalent: ``ta.highest(high, 20)``

    Args:
        src: Input array.
        period: Lookback window size.

    Returns:
        Array of rolling maximums over the available history up to ``period`` bars.
    """
    source = to_numpy(src, dtype=np.float64)
    n = len(source)
    result = np.full(n, np.nan)
    if period <= 0:
        return wrap_like(result, src)
    for i in range(n):
        start = max(0, i - period + 1)
        window = source[start: i + 1]
        valid = ~np.isnan(window)
        if np.any(valid):
            result[i] = np.nanmax(window)
    return wrap_like(result, src)


def lowest(src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
    """Rolling lowest value over the last ``period`` bars.

    Pine equivalent: ``ta.lowest(low, 20)``

    Args:
        src: Input array.
        period: Lookback window size.

    Returns:
        Array of rolling minimums over the available history up to ``period`` bars.
    """
    source = to_numpy(src, dtype=np.float64)
    n = len(source)
    result = np.full(n, np.nan)
    if period <= 0:
        return wrap_like(result, src)
    for i in range(n):
        start = max(0, i - period + 1)
        window = source[start: i + 1]
        valid = ~np.isnan(window)
        if np.any(valid):
            result[i] = np.nanmin(window)
    return wrap_like(result, src)


def highestbars(src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
    """Bars back to the highest value in the last ``period`` bars.

    Pine equivalent: ``ta.highestbars(source, length)``.
    Returns ``0`` when the current bar is the highest value, or a negative
    offset when the most recent highest value is in the past. If the highest
    value appears more than once in the window, the most recent occurrence wins.
    """
    return _extreme_bars(src, period, highest=True)


def lowestbars(src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
    """Bars back to the lowest value in the last ``period`` bars.

    Pine equivalent: ``ta.lowestbars(source, length)``.
    Returns ``0`` when the current bar is the lowest value, or a negative
    offset when the most recent lowest value is in the past. If the lowest value
    appears more than once in the window, the most recent occurrence wins.
    """
    return _extreme_bars(src, period, highest=False)


def _extreme_bars(src: PyneSeries | np.ndarray, period: int, *, highest: bool) -> PyneSeries | np.ndarray:
    source = to_numpy(src, dtype=np.float64)
    n = len(source)
    result = np.full(n, np.nan)
    if period <= 0:
        return wrap_like(result, src)

    for idx in range(n):
        start = max(0, idx - period + 1)
        window = source[start: idx + 1]
        valid = ~np.isnan(window)
        if not np.any(valid):
            continue
        target = np.nanmax(window) if highest else np.nanmin(window)
        matches = np.where((window == target) & valid)[0]
        if len(matches):
            result[idx] = float(matches[-1] - (len(window) - 1))
    return wrap_like(result, src)


# ═══════════════════════════════════════════════════════════════
#  Price Change Functions
# ═══════════════════════════════════════════════════════════════


def change(src: PyneSeries | np.ndarray, period: int = 1) -> PyneSeries | np.ndarray:
    """Difference between current and previous value.

    Pine equivalent: ``ta.change(close)`` or ``ta.change(close, 5)``

    Args:
        src: Input array.
        period: Lookback period (default 1).

    Returns:
        Array of differences. NaN for the first ``period`` bars.
    """
    source = to_numpy(src, dtype=np.float64)
    result = np.full_like(source, np.nan, dtype=np.float64)
    if period < len(source):
        result[period:] = source[period:] - source[:len(source) - period]
    return wrap_like(result, src)


def roc(src: PyneSeries | np.ndarray, period: int = 1) -> PyneSeries | np.ndarray:
    """Rate of Change — percentage change over ``period`` bars.

    Pine equivalent: ``ta.roc(close, 10)``

    ``roc = (src - src[period]) / src[period] * 100``

    Args:
        src: Input array.
        period: Lookback period.

    Returns:
        Array of percentage changes. NaN where undefined.
    """
    source = to_numpy(src, dtype=np.float64)
    result = np.full_like(source, np.nan, dtype=np.float64)
    if period < len(source):
        prev = source[:len(source) - period]
        curr = source[period:]
        with np.errstate(divide="ignore", invalid="ignore"):
            result[period:] = np.where(prev != 0, (curr - prev) / prev * 100, np.nan)
    return wrap_like(result, src)


# ═══════════════════════════════════════════════════════════════
#  Condition-Based Lookback
# ═══════════════════════════════════════════════════════════════


def barssince(condition: PyneSeries | np.ndarray) -> PyneSeries | np.ndarray:
    """Number of bars since condition was last True.

    Pine equivalent: ``ta.barssince(crossover(fast, slow))``

    Args:
        condition: Boolean array.

    Returns:
        Integer array — bars since last True. NaN if never True before.
    """
    flags = to_numpy(condition).astype(bool)
    n = len(flags)
    result = np.full(n, np.nan)
    last_true = -1
    for i in range(n):
        if flags[i]:
            last_true = i
        if last_true >= 0:
            result[i] = float(i - last_true)
    return wrap_like(result, condition)


def valuewhen(
    condition: PyneSeries | np.ndarray,
    src: PyneSeries | np.ndarray,
    occurrence: int = 0,
) -> PyneSeries | np.ndarray:
    """Value of ``src`` when ``condition`` was True.

    Pine equivalent: ``ta.valuewhen(crossover(fast, slow), close, 0)``

    Args:
        condition: Boolean array.
        src: Value array to sample from.
        occurrence: Which occurrence to return (0 = most recent, 1 = second most recent, etc.)

    Returns:
        Array where each element is the value of src at the nth most recent True.
    """
    flags = to_numpy(condition).astype(bool)
    source = to_numpy(src, dtype=np.float64)
    n = len(flags)
    result = np.full(n, np.nan)
    true_indices: list[int] = []

    for i in range(n):
        if flags[i]:
            true_indices.append(i)
        if len(true_indices) > occurrence:
            idx = true_indices[-(occurrence + 1)]
            result[i] = source[idx]
    return wrap_like(result, src, condition)


# ═══════════════════════════════════════════════════════════════
#  Pivot Detection
# ═══════════════════════════════════════════════════════════════


def pivothigh(src: PyneSeries | np.ndarray, left: int, right: int) -> PyneSeries | np.ndarray:
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
    source = to_numpy(src, dtype=np.float64)
    n = len(source)
    result = np.full(n, np.nan)

    for i in range(left, n - right):
        window = source[i - left: i + right + 1]
        if not np.any(np.isnan(window)):
            if source[i] == np.max(window) and np.sum(window == source[i]) == 1:
                result[i] = source[i]

    return wrap_like(result, src)


def pivotlow(src: PyneSeries | np.ndarray, left: int, right: int) -> PyneSeries | np.ndarray:
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
    source = to_numpy(src, dtype=np.float64)
    n = len(source)
    result = np.full(n, np.nan)

    for i in range(left, n - right):
        window = source[i - left: i + right + 1]
        if not np.any(np.isnan(window)):
            if source[i] == np.min(window) and np.sum(window == source[i]) == 1:
                result[i] = source[i]

    return wrap_like(result, src)


# ═══════════════════════════════════════════════════════════════
#  Summation
# ═══════════════════════════════════════════════════════════════


def cum(src: PyneSeries | np.ndarray) -> PyneSeries | np.ndarray:
    """Cumulative sum.

    Pine equivalent: ``ta.cum(close)``

    Args:
        src: Input array.

    Returns:
        Cumulative sum array (NaN-aware).
    """
    return wrap_like(np.nancumsum(to_numpy(src, dtype=np.float64)), src)


def sum_(src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
    """Rolling sum over the last ``period`` bars.

    Pine equivalent: ``math.sum(src, period)``

    Args:
        src: Input array.
        period: Window size.

    Returns:
        Rolling sum array. NaN for the first ``period-1`` bars.
    """
    source = to_numpy(src, dtype=np.float64)
    n = len(source)
    result = np.full(n, np.nan)
    rolling = 0.0
    nan_count = 0

    for i in range(n):
        val = source[i]
        if np.isnan(val):
            nan_count += 1
        else:
            rolling += val

        if i >= period:
            old = source[i - period]
            if np.isnan(old):
                nan_count -= 1
            else:
                rolling -= old

        if i >= period - 1 and nan_count == 0:
            result[i] = rolling

    return wrap_like(result, src)


# ═══════════════════════════════════════════════════════════════
#  Comparison Helpers
# ═══════════════════════════════════════════════════════════════


def rising(src: PyneSeries | np.ndarray, period: int = 1) -> PyneSeries | np.ndarray:
    """True when src has been rising for ``period`` consecutive bars.

    Pine equivalent: ``ta.rising(close, 5)``
    """
    source = to_numpy(src, dtype=np.float64)
    result = np.zeros(len(source), dtype=bool)
    for i in range(period, len(source)):
        is_rising = True
        for j in range(period):
            if np.isnan(source[i - j]) or np.isnan(source[i - j - 1]):
                is_rising = False
                break
            if source[i - j] <= source[i - j - 1]:
                is_rising = False
                break
        result[i] = is_rising
    return wrap_like(result, src)


def falling(src: PyneSeries | np.ndarray, period: int = 1) -> PyneSeries | np.ndarray:
    """True when src has been falling for ``period`` consecutive bars.

    Pine equivalent: ``ta.falling(close, 5)``
    """
    source = to_numpy(src, dtype=np.float64)
    result = np.zeros(len(source), dtype=bool)
    for i in range(period, len(source)):
        is_falling = True
        for j in range(period):
            if np.isnan(source[i - j]) or np.isnan(source[i - j - 1]):
                is_falling = False
                break
            if source[i - j] >= source[i - j - 1]:
                is_falling = False
                break
        result[i] = is_falling
    return wrap_like(result, src)
