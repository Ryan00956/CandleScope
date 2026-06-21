"""
Pyne Technical Analysis — Pine-style ``ta.*`` function library.

All functions accept and return numpy arrays. They can be freely
composed and nested::

    ta.ema(ta.rsi(close, 14), 10)   # smooth RSI with EMA
    ta.bb(ta.ema(close, 20), 20, 2) # Bollinger Bands on EMA

The module is injected as ``ta`` in the script namespace. Functions
that need OHLCV data (like ``atr``, ``tr``, ``obv``) receive a
reference to the runtime context so they can implicitly access
global high/low/close/volume when called without explicit arguments.

Usage::

    # In user scripts — ta is already available
    plot(ta.sma(close, 20), title="SMA 20")
    dif, dea, hist = ta.macd(close)
    mid, upper, lower = ta.bb(close, 20, 2)
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from . import utils
from .series import PyneSeries, to_numpy, wrap_like

if TYPE_CHECKING:
    from .context import PyneContext


def _fixnan(values: np.ndarray) -> np.ndarray:
    result = np.array(values, dtype=np.float64, copy=True)
    last = np.nan
    for idx, value in enumerate(result):
        if np.isnan(value):
            if not np.isnan(last):
                result[idx] = last
            continue
        last = value
    return result


class TaModule:
    """Pine-style technical analysis namespace.

    Instantiated with a reference to the current ``PyneContext`` so
    functions like ``atr(14)`` can implicitly use global OHLCV data.
    """

    def __init__(self, ctx: PyneContext | None = None) -> None:
        self._ctx = ctx

    def bind(self, ctx: PyneContext) -> None:
        """Bind to a context (called by runtime before script exec)."""
        self._ctx = ctx

    # ═══════════════════════════════════════════════════════════
    #  Moving Averages
    # ═══════════════════════════════════════════════════════════

    def sma(self, src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
        """Simple Moving Average.

        Pine equivalent: ``ta.sma(close, 20)``
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)
        clean = np.where(np.isnan(source), 0.0, source)
        sums = np.cumsum(clean)
        counts = np.cumsum(~np.isnan(source))
        window_sums = sums[period - 1:].copy()
        window_counts = counts[period - 1:].copy()
        if period < n:
            window_sums[1:] -= sums[: n - period]
            window_counts[1:] -= counts[: n - period]
        valid = window_counts == period
        result[period - 1:][valid] = window_sums[valid] / period
        return wrap_like(result, src)

    def ema(self, src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
        """Exponential Moving Average.

        Pine equivalent: ``ta.ema(close, 20)``

        Uses SMA as the seed value for the first ``period`` bars,
        matching Pine Script / TradingView behavior.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        k = 2.0 / (period + 1)

        # Seed with SMA
        window = source[:period]
        valid = window[~np.isnan(window)]
        if len(valid) == 0:
            return wrap_like(result, src)
        seed = float(np.mean(valid))
        result[period - 1] = seed

        for i in range(period, n):
            val = source[i]
            if np.isnan(val):
                result[i] = result[i - 1]
            else:
                result[i] = val * k + result[i - 1] * (1 - k)

        return wrap_like(result, src)

    def wma(self, src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
        """Weighted Moving Average.

        Pine equivalent: ``ta.wma(close, 20)``

        Weights: [1, 2, 3, ..., period]. Most recent bar has highest weight.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        weights = np.arange(1, period + 1, dtype=np.float64)
        w_sum = weights.sum()

        for i in range(period - 1, n):
            window = source[i - period + 1: i + 1]
            if not np.any(np.isnan(window)):
                result[i] = np.dot(window, weights) / w_sum

        return wrap_like(result, src)

    def hma(self, src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
        """Hull Moving Average.

        Pine equivalent: ``ta.hma(close, 20)``.
        """
        if period <= 0:
            return wrap_like(np.full(len(to_numpy(src)), np.nan), src)
        half = max(int(period / 2), 1)
        root = max(int(np.sqrt(period)), 1)
        fast = self.wma(src, half)
        slow = self.wma(src, period)
        return self.wma(2 * fast - slow, root)

    def swma(self, src: PyneSeries | np.ndarray) -> PyneSeries | np.ndarray:
        """Symmetrically weighted moving average.

        Pine equivalent: ``ta.swma(close)``. Uses weights ``[1, 2, 2, 1] / 6``.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        weights = np.array([1.0, 2.0, 2.0, 1.0], dtype=np.float64)
        for idx in range(3, n):
            window = source[idx - 3: idx + 1]
            if not np.any(np.isnan(window)):
                result[idx] = float(np.dot(window, weights) / 6.0)
        return wrap_like(result, src)

    def alma(
        self,
        src: PyneSeries | np.ndarray,
        period: int,
        offset: float = 0.85,
        sigma: float = 6.0,
    ) -> PyneSeries | np.ndarray:
        """Arnaud Legoux Moving Average.

        Pine equivalent: ``ta.alma(close, 20, 0.85, 6)``.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n or sigma == 0:
            return wrap_like(result, src)

        m = offset * (period - 1)
        s = period / sigma
        positions = np.arange(period, dtype=np.float64)
        weights = np.exp(-((positions - m) ** 2) / (2 * s * s))
        weights = weights / np.sum(weights)

        for idx in range(period - 1, n):
            window = source[idx - period + 1: idx + 1]
            if not np.any(np.isnan(window)):
                result[idx] = float(np.dot(window, weights))

        return wrap_like(result, src)

    def vwma(
        self,
        src: PyneSeries | np.ndarray,
        period: int,
        volume: PyneSeries | np.ndarray | None = None,
    ) -> PyneSeries | np.ndarray:
        """Volume-Weighted Moving Average.

        Pine equivalent: ``ta.vwma(close, 20)``

        If ``volume`` is not provided, uses the global volume from context.
        """
        if volume is None:
            if self._ctx is None:
                raise RuntimeError("ta.vwma() needs volume data — pass it explicitly or use within a Pyne script")
            volume = self._ctx.volume

        source = to_numpy(src, dtype=np.float64)
        volume_arr = to_numpy(volume, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        pv = source * volume_arr
        for i in range(period - 1, n):
            w = pv[i - period + 1: i + 1]
            v = volume_arr[i - period + 1: i + 1]
            v_sum = np.nansum(v)
            if v_sum > 0:
                result[i] = np.nansum(w) / v_sum

        return wrap_like(result, src)

    def rma(self, src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
        """Running Moving Average (Wilder's smoothing).

        Pine equivalent: ``ta.rma(close, 14)``

        Also known as Wilder's EMA. Used internally by RSI and ATR.
        ``alpha = 1 / period``
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        alpha = 1.0 / period

        count = 0
        seed_sum = 0.0
        rma_value = np.nan
        for i in range(n):
            val = source[i]
            if np.isnan(val):
                if not np.isnan(rma_value):
                    result[i] = rma_value
                continue
            if count < period:
                count += 1
                seed_sum += val
                if count == period:
                    rma_value = seed_sum / period
                    result[i] = rma_value
                continue
            rma_value = alpha * val + (1 - alpha) * rma_value
            result[i] = rma_value

        return wrap_like(result, src)

    # ═══════════════════════════════════════════════════════════
    #  Oscillators
    # ═══════════════════════════════════════════════════════════

    def rsi(self, src: PyneSeries | np.ndarray, period: int = 14) -> PyneSeries | np.ndarray:
        """Relative Strength Index.

        Pine equivalent: ``ta.rsi(close, 14)``
        """
        source = to_numpy(src, dtype=np.float64)
        delta = to_numpy(utils.change(source, 1), dtype=np.float64)
        gain = np.where(np.isnan(delta), np.nan, np.where(delta > 0, delta, 0.0))
        loss = np.where(np.isnan(delta), np.nan, np.where(delta < 0, -delta, 0.0))

        avg_gain = self.rma(gain, period)
        avg_loss = self.rma(loss, period)

        with np.errstate(divide="ignore", invalid="ignore"):
            rs = np.where(avg_loss != 0, avg_gain / avg_loss, np.inf)
            rsi_val = 100.0 - 100.0 / (1.0 + rs)

        # Where avg_loss is 0 (all gains), RSI = 100
        rsi_val = np.where(avg_loss == 0, 100.0, rsi_val)
        # Where avg_gain is 0 (all losses), RSI = 0
        rsi_val = np.where(avg_gain == 0, 0.0, rsi_val)
        # Preserve NaN in warmup period
        rsi_val[:period] = np.nan

        return wrap_like(rsi_val, src)

    def cmo(self, src: PyneSeries | np.ndarray, period: int = 14) -> PyneSeries | np.ndarray:
        """Chande Momentum Oscillator.

        Pine equivalent: ``ta.cmo(close, 14)``.
        """
        source = to_numpy(src, dtype=np.float64)
        delta = to_numpy(utils.change(source, 1), dtype=np.float64)
        up = np.where(delta > 0, delta, 0.0)
        down = np.where(delta < 0, -delta, 0.0)
        up[0] = 0.0
        down[0] = 0.0
        up_sum = to_numpy(utils.sum_(up, period), dtype=np.float64)
        down_sum = to_numpy(utils.sum_(down, period), dtype=np.float64)
        with np.errstate(divide="ignore", invalid="ignore"):
            result = np.where(
                (up_sum + down_sum) != 0,
                100.0 * (up_sum - down_sum) / (up_sum + down_sum),
                0.0,
            )
        result[:period] = np.nan
        return wrap_like(result, src)

    def wpr(
        self,
        period: int = 14,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
    ) -> PyneSeries | np.ndarray:
        """Williams Percent Range.

        Pine-style helper for Williams %R over the current OHLC context.
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.wpr() needs OHLC data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None:
            close = self._ctx.close

        high_arr = to_numpy(high, dtype=np.float64)
        low_arr = to_numpy(low, dtype=np.float64)
        close_arr = to_numpy(close, dtype=np.float64)
        highest = to_numpy(utils.highest(high_arr, period), dtype=np.float64)
        lowest = to_numpy(utils.lowest(low_arr, period), dtype=np.float64)
        with np.errstate(divide="ignore", invalid="ignore"):
            result = np.where(
                (highest - lowest) != 0,
                -100.0 * (highest - close_arr) / (highest - lowest),
                0.0,
            )
        return wrap_like(result, high, low, close)

    def tsi(
        self,
        src: PyneSeries | np.ndarray,
        short: int = 13,
        long: int = 25,
    ) -> PyneSeries | np.ndarray:
        """True Strength Index.

        Pine equivalent: ``ta.tsi(source, short_length, long_length)``.
        """
        source = to_numpy(src, dtype=np.float64)
        momentum = to_numpy(utils.change(source, 1), dtype=np.float64)
        abs_momentum = np.abs(momentum)
        smooth_mom = _ema_skip_leading_na(_ema_skip_leading_na(momentum, long), short)
        smooth_abs = _ema_skip_leading_na(_ema_skip_leading_na(abs_momentum, long), short)
        with np.errstate(divide="ignore", invalid="ignore"):
            result = np.where(smooth_abs != 0, smooth_mom / smooth_abs, np.nan)
        return wrap_like(result, src)

    def stoch(
        self,
        source: PyneSeries | np.ndarray,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        period: int = 14,
        *,
        k_period: int | None = None,
    ) -> PyneSeries | np.ndarray:
        """Stochastic oscillator.

        Pine equivalent: ``ta.stoch(source, high, low, length)``.
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.stoch() needs high/low — pass explicitly or use within Pyne script")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low

        length = k_period if k_period is not None else period
        source_arr = to_numpy(source, dtype=np.float64)
        high_arr = to_numpy(high, dtype=np.float64)
        low_arr = to_numpy(low, dtype=np.float64)
        hh = to_numpy(utils.highest(high_arr, length), dtype=np.float64)
        ll = to_numpy(utils.lowest(low_arr, length), dtype=np.float64)

        with np.errstate(divide="ignore", invalid="ignore"):
            result = np.where(
                (hh - ll) != 0,
                100.0 * (source_arr - ll) / (hh - ll),
                50.0,
            )

        return wrap_like(result, source, high, low)

    def cci(
        self,
        source: PyneSeries | np.ndarray | None = None,
        period: int = 20,
        *,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
    ) -> PyneSeries | np.ndarray:
        """Commodity Channel Index.

        Pine equivalent: ``ta.cci(source, length)``.
        """
        if source is None:
            if high is None:
                if self._ctx is None:
                    raise RuntimeError("ta.cci() needs a source series")
                high = self._ctx.high
            if low is None:
                low = self._ctx.low
            if close is None:
                close = self._ctx.close
            source = (
                to_numpy(high, dtype=np.float64)
                + to_numpy(low, dtype=np.float64)
                + to_numpy(close, dtype=np.float64)
            ) / 3.0

        source_arr = to_numpy(source, dtype=np.float64)
        source_sma = self.sma(source_arr, period)

        # Mean absolute deviation
        n = len(source_arr)
        mad = np.full(n, np.nan)
        for i in range(period - 1, n):
            window = source_arr[i - period + 1: i + 1]
            mad[i] = np.nanmean(np.abs(window - source_sma[i]))

        with np.errstate(divide="ignore", invalid="ignore"):
            result = np.where(mad != 0, (source_arr - source_sma) / (0.015 * mad), 0.0)
        result[:period - 1] = np.nan
        return wrap_like(result, source)

    # ═══════════════════════════════════════════════════════════
    #  Trend Indicators
    # ═══════════════════════════════════════════════════════════

    def macd(
        self,
        src: PyneSeries | np.ndarray,
        fast: int = 12,
        slow: int = 26,
        signal: int = 9,
    ) -> tuple[PyneSeries | np.ndarray, PyneSeries | np.ndarray, PyneSeries | np.ndarray]:
        """MACD — Moving Average Convergence Divergence.

        Pine equivalent: ``ta.macd(close, 12, 26, 9)``

        Returns:
            Tuple of (MACD line, signal line, histogram) arrays.
            ``histogram = macd_line - signal_line``.
        """
        ema_fast = self.ema(src, fast)
        ema_slow = self.ema(src, slow)
        dif = ema_fast - ema_slow
        dea = wrap_like(_ema_skip_leading_na(to_numpy(dif, dtype=np.float64), signal), src)
        hist = dif - dea
        return dif, dea, hist

    def mom(self, src: PyneSeries | np.ndarray, period: int = 1) -> PyneSeries | np.ndarray:
        """Momentum over ``period`` bars.

        Pine equivalent: ``ta.mom(close, 10)``.
        """
        source = to_numpy(src, dtype=np.float64)
        previous = to_numpy(utils.shift(source, period), dtype=np.float64)
        return wrap_like(source - previous, src)

    def linreg(
        self,
        src: PyneSeries | np.ndarray,
        period: int,
        offset: int = 0,
    ) -> PyneSeries | np.ndarray:
        """Linear regression curve.

        Pine equivalent: ``ta.linreg(source, length, offset)``.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        x = np.arange(period, dtype=np.float64)
        x_mean = float(np.mean(x))
        denom = float(np.sum((x - x_mean) ** 2))
        target_x = float(period - 1 - offset)

        for idx in range(period - 1, n):
            window = source[idx - period + 1: idx + 1]
            if np.any(np.isnan(window)):
                continue
            y_mean = float(np.mean(window))
            slope = float(np.sum((x - x_mean) * (window - y_mean)) / denom) if denom else 0.0
            intercept = y_mean - slope * x_mean
            result[idx] = intercept + slope * target_x

        return wrap_like(result, src)

    def correlation(
        self,
        source_a: PyneSeries | np.ndarray,
        source_b: PyneSeries | np.ndarray,
        period: int,
    ) -> PyneSeries | np.ndarray:
        """Rolling Pearson correlation.

        Pine equivalent: ``ta.correlation(source1, source2, length)``.
        """
        a = to_numpy(source_a, dtype=np.float64)
        b = to_numpy(source_b, dtype=np.float64)
        n = min(len(a), len(b))
        result = np.full(n, np.nan)
        if period <= 1 or period > n:
            return wrap_like(result, source_a, source_b)

        for idx in range(period - 1, n):
            aw = a[idx - period + 1: idx + 1]
            bw = b[idx - period + 1: idx + 1]
            if np.any(np.isnan(aw)) or np.any(np.isnan(bw)):
                continue
            a_std = float(np.std(aw))
            b_std = float(np.std(bw))
            if a_std == 0.0 or b_std == 0.0:
                continue
            result[idx] = float(np.corrcoef(aw, bw)[0, 1])

        return wrap_like(result, source_a, source_b)

    def adx(
        self,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
        period: int = 14,
    ) -> PyneSeries | np.ndarray:
        """Average Directional Index.

        Pine equivalent: ``ta.adx(high, low, close, 14)``

        Returns:
            ADX array.
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.adx() needs OHLC data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None:
            close = self._ctx.close

        _, _, adx_val = self._dmi_components(high, low, close, period, period)
        return wrap_like(adx_val, high, low, close)

    def dmi(
        self,
        period: int = 14,
        adx_period: int = 14,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
    ) -> tuple[PyneSeries | np.ndarray, PyneSeries | np.ndarray, PyneSeries | np.ndarray]:
        """Directional Movement Index.

        Pine equivalent: ``ta.dmi(diLength, adxSmoothing)``.
        Returns ``(+DI, -DI, ADX)``.
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.dmi() needs OHLC data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None:
            close = self._ctx.close

        plus_di, minus_di, adx_val = self._dmi_components(
            high,
            low,
            close,
            period,
            adx_period,
        )

        return (
            wrap_like(plus_di, high, low, close),
            wrap_like(minus_di, high, low, close),
            wrap_like(adx_val, high, low, close),
        )

    def _dmi_components(
        self,
        high: PyneSeries | np.ndarray,
        low: PyneSeries | np.ndarray,
        close: PyneSeries | np.ndarray,
        period: int,
        adx_period: int,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        high_arr = to_numpy(high, dtype=np.float64)
        low_arr = to_numpy(low, dtype=np.float64)
        close_arr = to_numpy(close, dtype=np.float64)
        up_move = to_numpy(utils.change(high_arr, 1), dtype=np.float64)
        down_move = -to_numpy(utils.change(low_arr, 1), dtype=np.float64)

        plus_dm = np.where(
            np.isnan(up_move),
            np.nan,
            np.where((up_move > down_move) & (up_move > 0), up_move, 0.0),
        )
        minus_dm = np.where(
            np.isnan(down_move),
            np.nan,
            np.where((down_move > up_move) & (down_move > 0), down_move, 0.0),
        )
        trur = to_numpy(self.atr(period, high_arr, low_arr, close_arr), dtype=np.float64)
        plus_smoothed = to_numpy(self.rma(plus_dm, period), dtype=np.float64)
        minus_smoothed = to_numpy(self.rma(minus_dm, period), dtype=np.float64)

        with np.errstate(divide="ignore", invalid="ignore"):
            plus_di = _fixnan(100.0 * plus_smoothed / trur)
            minus_di = _fixnan(100.0 * minus_smoothed / trur)
            total = plus_di + minus_di
            denominator = np.where(total == 0.0, 1.0, total)
            dx_ratio = np.abs(plus_di - minus_di) / denominator
            adx_val = 100.0 * to_numpy(self.rma(dx_ratio, adx_period), dtype=np.float64)
        return plus_di, minus_di, adx_val

    def sar(
        self,
        start: float = 0.02,
        increment: float = 0.02,
        maximum: float = 0.2,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
    ) -> PyneSeries | np.ndarray:
        """Parabolic SAR.

        Pine equivalent: ``ta.sar(start, increment, max)``.
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.sar() needs high/low data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None and self._ctx is not None:
            close = self._ctx.close

        high_arr = to_numpy(high, dtype=np.float64)
        low_arr = to_numpy(low, dtype=np.float64)
        close_arr = (
            to_numpy(close, dtype=np.float64)
            if close is not None
            else (high_arr + low_arr) / 2.0
        )
        n = len(high_arr)
        result = np.full(n, np.nan)
        if n < 2:
            return wrap_like(result, high, low)

        sar_value = np.nan
        max_min = np.nan
        acceleration = np.nan
        is_below = False

        for idx in range(n):
            is_first_trend_bar = False
            if np.isnan(high_arr[idx]) or np.isnan(low_arr[idx]) or np.isnan(close_arr[idx]):
                sar_value = np.nan
                max_min = np.nan
                acceleration = np.nan
                continue

            if np.isnan(sar_value) and idx > 0 and not np.isnan(close_arr[idx - 1]):
                if close_arr[idx] > close_arr[idx - 1]:
                    is_below = True
                    max_min = high_arr[idx]
                    sar_value = low_arr[idx - 1]
                else:
                    is_below = False
                    max_min = low_arr[idx]
                    sar_value = high_arr[idx - 1]
                is_first_trend_bar = True
                acceleration = float(start)
            elif not np.isnan(sar_value):
                sar_value = sar_value + acceleration * (max_min - sar_value)
                if is_below:
                    if sar_value > low_arr[idx]:
                        is_first_trend_bar = True
                        is_below = False
                        sar_value = max(high_arr[idx], max_min)
                        max_min = low_arr[idx]
                        acceleration = float(start)
                else:
                    if sar_value < high_arr[idx]:
                        is_first_trend_bar = True
                        is_below = True
                        sar_value = min(low_arr[idx], max_min)
                        max_min = high_arr[idx]
                        acceleration = float(start)

                if not is_first_trend_bar:
                    if is_below:
                        if high_arr[idx] > max_min:
                            max_min = high_arr[idx]
                            acceleration = min(acceleration + increment, maximum)
                    elif low_arr[idx] < max_min:
                        max_min = low_arr[idx]
                        acceleration = min(acceleration + increment, maximum)

                if is_below:
                    sar_value = min(sar_value, low_arr[idx - 1])
                    if idx > 1 and not np.isnan(low_arr[idx - 2]):
                        sar_value = min(sar_value, low_arr[idx - 2])
                else:
                    sar_value = max(sar_value, high_arr[idx - 1])
                    if idx > 1 and not np.isnan(high_arr[idx - 2]):
                        sar_value = max(sar_value, high_arr[idx - 2])

            result[idx] = sar_value

        return wrap_like(result, high, low, close)

    def supertrend(
        self,
        factor: float = 3.0,
        atr_period: int = 10,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
        *,
        period: int | None = None,
        mult: float | None = None,
    ) -> tuple[PyneSeries | np.ndarray, PyneSeries | np.ndarray]:
        """Supertrend indicator.

        Pine equivalent: ``ta.supertrend(factor, atrPeriod)``.

        Returns:
            Tuple of (supertrend_line, direction) arrays.
            direction follows Pine's convention: 1 = downtrend, -1 = uptrend.
        """
        if period is not None:
            atr_period = period
        if mult is not None:
            factor = mult

        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.supertrend() needs OHLC data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None:
            close = self._ctx.close

        high_arr = to_numpy(high, dtype=np.float64)
        low_arr = to_numpy(low, dtype=np.float64)
        close_arr = to_numpy(close, dtype=np.float64)
        atr_val = to_numpy(self.atr(atr_period, high_arr, low_arr, close_arr), dtype=np.float64)
        hl2 = (high_arr + low_arr) / 2.0

        n = len(close_arr)
        upper_band = hl2 + factor * atr_val
        lower_band = hl2 - factor * atr_val
        supertrend = np.full(n, np.nan)
        direction = np.full(n, np.nan)

        if n:
            supertrend[0] = 0.0

        for i in range(n):
            prev_lower_band = 0.0 if i == 0 or np.isnan(lower_band[i - 1]) else lower_band[i - 1]
            prev_upper_band = 0.0 if i == 0 or np.isnan(upper_band[i - 1]) else upper_band[i - 1]
            prev_close = np.nan if i == 0 else close_arr[i - 1]

            if not np.isnan(lower_band[i]):
                if not (lower_band[i] > prev_lower_band or prev_close < prev_lower_band):
                    lower_band[i] = prev_lower_band

            if not np.isnan(upper_band[i]):
                if not (upper_band[i] < prev_upper_band or prev_close > prev_upper_band):
                    upper_band[i] = prev_upper_band

            if i == 0 or np.isnan(atr_val[i - 1]):
                direction[i] = 1.0
            else:
                prev_supertrend = supertrend[i - 1]
                if not np.isnan(prev_supertrend) and prev_supertrend == prev_upper_band:
                    direction[i] = -1.0 if close_arr[i] > upper_band[i] else 1.0
                else:
                    direction[i] = 1.0 if close_arr[i] < lower_band[i] else -1.0

            if not np.isnan(upper_band[i]) and not np.isnan(lower_band[i]):
                supertrend[i] = lower_band[i] if direction[i] == -1.0 else upper_band[i]

        return wrap_like(supertrend, high, low, close), wrap_like(direction, high, low, close)

    # ═══════════════════════════════════════════════════════════
    #  Volatility
    # ═══════════════════════════════════════════════════════════

    def tr(
        self,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
    ) -> PyneSeries | np.ndarray:
        """True Range.

        Pine equivalent: ``ta.tr``
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.tr() needs OHLC data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None:
            close = self._ctx.close

        high_arr = to_numpy(high, dtype=np.float64)
        low_arr = to_numpy(low, dtype=np.float64)
        close_arr = to_numpy(close, dtype=np.float64)
        prev_close = to_numpy(utils.shift(close_arr, 1), dtype=np.float64)
        tr1 = high_arr - low_arr
        tr2 = np.abs(high_arr - prev_close)
        tr3 = np.abs(low_arr - prev_close)
        result = np.where(np.isnan(prev_close), tr1, np.maximum(tr1, np.maximum(tr2, tr3)))
        return wrap_like(result, high, low, close)

    def atr(
        self,
        period: int = 14,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
    ) -> PyneSeries | np.ndarray:
        """Average True Range.

        Pine equivalent: ``ta.atr(14)``

        When called without high/low/close, uses the global context data.
        """
        tr_val = self.tr(high, low, close)
        return self.rma(tr_val, period)

    def bb(
        self,
        src: PyneSeries | np.ndarray,
        period: int = 20,
        mult: float = 2.0,
    ) -> tuple[PyneSeries | np.ndarray, PyneSeries | np.ndarray, PyneSeries | np.ndarray]:
        """Bollinger Bands.

        Pine equivalent: ``ta.bb(close, 20, 2)``

        Returns:
            Tuple of (middle, upper, lower) arrays.
        """
        middle = self.sma(src, period)
        sd = self.stdev(src, period)
        upper = middle + mult * sd
        lower = middle - mult * sd
        return middle, upper, lower

    def stdev(self, src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
        """Rolling Standard Deviation (O(n) optimized).

        Pine equivalent: ``ta.stdev(close, 20)``

        Uses the identity ``Var(X) = E[X²] − (E[X])²`` with cumulative
        sums for O(n) computation instead of the naive O(n·period) loop.
        Falls back to a per-window approach only when NaN values are present.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        # If NaN values exist, fall back to window-based approach
        if np.any(np.isnan(source)):
            for i in range(period - 1, n):
                window = source[i - period + 1: i + 1]
                if not np.any(np.isnan(window)):
                    result[i] = np.std(window, ddof=0)
            return wrap_like(result, src)

        # ── O(n) vectorized path ──
        # Var(X) = E[X²] − (E[X])²
        cs = np.cumsum(source)
        cs2 = np.cumsum(source * source)

        # First complete window [0 .. period-1]
        s = cs[period - 1]
        s2 = cs2[period - 1]
        mean = s / period
        result[period - 1] = np.sqrt(max(0.0, s2 / period - mean * mean))

        # Subsequent windows via sliding cumsum difference
        if period < n:
            s_arr = cs[period:] - cs[:n - period]
            s2_arr = cs2[period:] - cs2[:n - period]
            means = s_arr / period
            variance = s2_arr / period - means * means
            # Clamp tiny negatives from floating-point rounding
            np.maximum(variance, 0.0, out=variance)
            np.sqrt(variance, out=variance)
            result[period:] = variance

        return wrap_like(result, src)

    def variance(
        self,
        src: PyneSeries | np.ndarray,
        period: int,
        biased: bool = True,
    ) -> PyneSeries | np.ndarray:
        """Rolling variance.

        Pine equivalent: ``ta.variance(close, 20, true)``.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        ddof = 0 if biased else 1
        if period - ddof <= 0:
            return wrap_like(result, src)

        for idx in range(period - 1, n):
            window = source[idx - period + 1: idx + 1]
            if not np.any(np.isnan(window)):
                result[idx] = np.var(window, ddof=ddof)

        return wrap_like(result, src)

    def dev(self, src: PyneSeries | np.ndarray, period: int) -> PyneSeries | np.ndarray:
        """Mean absolute deviation from SMA.

        Pine equivalent: ``ta.dev(close, 20)``.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        for idx in range(period - 1, n):
            window = source[idx - period + 1: idx + 1]
            if not np.any(np.isnan(window)):
                mean = float(np.mean(window))
                result[idx] = float(np.mean(np.abs(window - mean)))

        return wrap_like(result, src)

    def percentile_nearest_rank(
        self,
        src: PyneSeries | np.ndarray,
        period: int,
        percentage: float,
    ) -> PyneSeries | np.ndarray:
        """Rolling percentile using nearest-rank selection.

        Pine equivalent: ``ta.percentile_nearest_rank(source, length, percentage)``.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        pct = float(np.clip(percentage, 0.0, 100.0))
        rank = max(int(np.ceil(pct / 100.0 * period)), 1) - 1

        for idx in range(period - 1, n):
            window = source[idx - period + 1: idx + 1]
            if not np.any(np.isnan(window)):
                result[idx] = float(np.sort(window)[rank])

        return wrap_like(result, src)

    def percentile_linear_interpolation(
        self,
        src: PyneSeries | np.ndarray,
        period: int,
        percentage: float,
    ) -> PyneSeries | np.ndarray:
        """Rolling percentile using linear interpolation.

        Pine equivalent: ``ta.percentile_linear_interpolation(source, length, percentage)``.
        """
        source = to_numpy(src, dtype=np.float64)
        n = len(source)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return wrap_like(result, src)

        pct = float(np.clip(percentage, 0.0, 100.0))
        for idx in range(period - 1, n):
            window = source[idx - period + 1: idx + 1]
            if not np.any(np.isnan(window)):
                result[idx] = float(np.percentile(window, pct, method="hazen"))

        return wrap_like(result, src)

    def keltner(
        self,
        period: int = 20,
        mult: float = 1.5,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
    ) -> tuple[PyneSeries | np.ndarray, PyneSeries | np.ndarray, PyneSeries | np.ndarray]:
        """Keltner Channel.

        Returns:
            Tuple of (upper, middle, lower) arrays.
        """
        if close is None:
            if self._ctx is None:
                raise RuntimeError("ta.keltner() needs OHLC data")
            close = self._ctx.close

        middle = self.ema(close, period)
        atr_val = self.atr(period, high, low, close)
        upper = middle + mult * atr_val
        lower = middle - mult * atr_val
        return upper, middle, lower

    def donchian(
        self,
        period: int = 20,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
    ) -> tuple[PyneSeries | np.ndarray, PyneSeries | np.ndarray, PyneSeries | np.ndarray]:
        """Donchian Channel.

        Returns:
            Tuple of (upper, middle, lower) arrays.
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.donchian() needs high/low data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low

        upper = utils.highest(high, period)
        lower = utils.lowest(low, period)
        middle = (upper + lower) / 2.0
        return upper, middle, lower

    # ═══════════════════════════════════════════════════════════
    #  Volume
    # ═══════════════════════════════════════════════════════════

    def obv(
        self,
        close: PyneSeries | np.ndarray | None = None,
        volume: PyneSeries | np.ndarray | None = None,
    ) -> PyneSeries | np.ndarray:
        """On-Balance Volume.

        Pine equivalent: ``ta.obv``
        """
        if close is None:
            if self._ctx is None:
                raise RuntimeError("ta.obv() needs close/volume data")
            close = self._ctx.close
        if volume is None:
            volume = self._ctx.volume

        close_arr = to_numpy(close, dtype=np.float64)
        volume_arr = to_numpy(volume, dtype=np.float64)
        n = len(close_arr)
        result = np.zeros(n)
        for i in range(1, n):
            if close_arr[i] > close_arr[i - 1]:
                result[i] = result[i - 1] + volume_arr[i]
            elif close_arr[i] < close_arr[i - 1]:
                result[i] = result[i - 1] - volume_arr[i]
            else:
                result[i] = result[i - 1]
        return wrap_like(result, close, volume)

    def volume_sma(
        self,
        volume: PyneSeries | np.ndarray | None = None,
        period: int = 20,
    ) -> PyneSeries | np.ndarray:
        """Volume Simple Moving Average."""
        if volume is None:
            if self._ctx is None:
                raise RuntimeError("ta.volume_sma() needs volume data")
            volume = self._ctx.volume
        return self.sma(volume, period)

    def mfi(
        self,
        source: PyneSeries | np.ndarray | int | None = None,
        period: int = 14,
        *,
        volume: PyneSeries | np.ndarray | None = None,
        high: PyneSeries | np.ndarray | None = None,
        low: PyneSeries | np.ndarray | None = None,
        close: PyneSeries | np.ndarray | None = None,
    ) -> PyneSeries | np.ndarray:
        """Money Flow Index.

        Pine equivalent: ``ta.mfi(source, length)``.
        """
        if isinstance(source, int):
            period = source
            source = None
        if source is None:
            if high is None:
                if self._ctx is None:
                    raise RuntimeError("ta.mfi() needs a source series and volume data")
                high = self._ctx.high
            if low is None:
                low = self._ctx.low
            if close is None:
                close = self._ctx.close
            source = (
                to_numpy(high, dtype=np.float64)
                + to_numpy(low, dtype=np.float64)
                + to_numpy(close, dtype=np.float64)
            ) / 3.0
        if volume is None:
            if self._ctx is None:
                raise RuntimeError("ta.mfi() needs volume data")
            volume = self._ctx.volume

        source_arr = to_numpy(source, dtype=np.float64)
        volume_arr = to_numpy(volume, dtype=np.float64)
        raw_mf = source_arr * volume_arr

        pos_mf = np.where(utils.change(source_arr, 1) > 0, raw_mf, 0.0)
        neg_mf = np.where(utils.change(source_arr, 1) < 0, raw_mf, 0.0)
        pos_mf[0] = 0
        neg_mf[0] = 0

        pos_sum = utils.sum_(pos_mf, period)
        neg_sum = utils.sum_(neg_mf, period)

        with np.errstate(divide="ignore", invalid="ignore"):
            mfi_val = np.where(
                (~np.isnan(neg_sum)) & (neg_sum != 0),
                100.0 - 100.0 / (1.0 + pos_sum / neg_sum),
                100.0,
            )
        return wrap_like(mfi_val, source, volume)

    # ═══════════════════════════════════════════════════════════
    #  Proxy methods for utils (so ta.crossover works)
    # ═══════════════════════════════════════════════════════════

    crossover = staticmethod(utils.crossover)
    cross = staticmethod(utils.cross)
    crossunder = staticmethod(utils.crossunder)
    highest = staticmethod(utils.highest)
    lowest = staticmethod(utils.lowest)
    highestbars = staticmethod(utils.highestbars)
    lowestbars = staticmethod(utils.lowestbars)
    change = staticmethod(utils.change)
    roc = staticmethod(utils.roc)
    barssince = staticmethod(utils.barssince)
    valuewhen = staticmethod(utils.valuewhen)
    pivothigh = staticmethod(utils.pivothigh)
    pivotlow = staticmethod(utils.pivotlow)
    cum = staticmethod(utils.cum)
    rising = staticmethod(utils.rising)
    falling = staticmethod(utils.falling)
    shift = staticmethod(utils.shift)
    nz = staticmethod(utils.nz)


def _ema_skip_leading_na(src: np.ndarray, period: int) -> np.ndarray:
    """EMA helper that starts after the first complete non-NaN window."""
    source = np.asarray(src, dtype=np.float64)
    n = len(source)
    result = np.full(n, np.nan)
    if period <= 0 or period > n:
        return result

    k = 2.0 / (period + 1)
    for start in range(0, n - period + 1):
        window = source[start: start + period]
        if not np.any(np.isnan(window)):
            seed_index = start + period - 1
            result[seed_index] = float(np.mean(window))
            for idx in range(seed_index + 1, n):
                value = source[idx]
                if np.isnan(value):
                    result[idx] = result[idx - 1]
                else:
                    result[idx] = value * k + result[idx - 1] * (1 - k)
            break

    return result
