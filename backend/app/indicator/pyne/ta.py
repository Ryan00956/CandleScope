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
    upper, mid, lower = ta.bb(close, 20, 2)
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from . import utils

if TYPE_CHECKING:
    from .context import PyneContext


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

    def sma(self, src: np.ndarray, period: int) -> np.ndarray:
        """Simple Moving Average.

        Pine equivalent: ``ta.sma(close, 20)``
        """
        n = len(src)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return result
        # Cumulative sum approach for O(n) performance
        cs = np.nancumsum(src)
        result[period - 1] = cs[period - 1] / period
        if period < n:
            result[period:] = (cs[period:] - cs[:n - period]) / period
        return result

    def ema(self, src: np.ndarray, period: int) -> np.ndarray:
        """Exponential Moving Average.

        Pine equivalent: ``ta.ema(close, 20)``

        Uses SMA as the seed value for the first ``period`` bars,
        matching Pine Script / TradingView behavior.
        """
        n = len(src)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return result

        k = 2.0 / (period + 1)

        # Seed with SMA
        window = src[:period]
        valid = window[~np.isnan(window)]
        if len(valid) == 0:
            return result
        seed = float(np.mean(valid))
        result[period - 1] = seed

        for i in range(period, n):
            val = src[i]
            if np.isnan(val):
                result[i] = result[i - 1]
            else:
                result[i] = val * k + result[i - 1] * (1 - k)

        return result

    def wma(self, src: np.ndarray, period: int) -> np.ndarray:
        """Weighted Moving Average.

        Pine equivalent: ``ta.wma(close, 20)``

        Weights: [1, 2, 3, ..., period]. Most recent bar has highest weight.
        """
        n = len(src)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return result

        weights = np.arange(1, period + 1, dtype=np.float64)
        w_sum = weights.sum()

        for i in range(period - 1, n):
            window = src[i - period + 1: i + 1]
            if not np.any(np.isnan(window)):
                result[i] = np.dot(window, weights) / w_sum

        return result

    def vwma(self, src: np.ndarray, period: int, volume: np.ndarray | None = None) -> np.ndarray:
        """Volume-Weighted Moving Average.

        Pine equivalent: ``ta.vwma(close, 20)``

        If ``volume`` is not provided, uses the global volume from context.
        """
        if volume is None:
            if self._ctx is None:
                raise RuntimeError("ta.vwma() needs volume data — pass it explicitly or use within a Pyne script")
            volume = self._ctx.volume

        n = len(src)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return result

        pv = src * volume
        for i in range(period - 1, n):
            w = pv[i - period + 1: i + 1]
            v = volume[i - period + 1: i + 1]
            v_sum = np.nansum(v)
            if v_sum > 0:
                result[i] = np.nansum(w) / v_sum

        return result

    def rma(self, src: np.ndarray, period: int) -> np.ndarray:
        """Running Moving Average (Wilder's smoothing).

        Pine equivalent: ``ta.rma(close, 14)``

        Also known as Wilder's EMA. Used internally by RSI and ATR.
        ``alpha = 1 / period``
        """
        n = len(src)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return result

        alpha = 1.0 / period

        # Seed with SMA
        window = src[:period]
        valid = window[~np.isnan(window)]
        if len(valid) == 0:
            return result
        seed = float(np.mean(valid))
        result[period - 1] = seed

        for i in range(period, n):
            val = src[i]
            if np.isnan(val):
                result[i] = result[i - 1]
            else:
                result[i] = alpha * val + (1 - alpha) * result[i - 1]

        return result

    # ═══════════════════════════════════════════════════════════
    #  Oscillators
    # ═══════════════════════════════════════════════════════════

    def rsi(self, src: np.ndarray, period: int = 14) -> np.ndarray:
        """Relative Strength Index.

        Pine equivalent: ``ta.rsi(close, 14)``
        """
        delta = utils.change(src, 1)
        gain = np.where(delta > 0, delta, 0.0)
        loss = np.where(delta < 0, -delta, 0.0)
        # First values are NaN from change()
        gain[0] = 0.0
        loss[0] = 0.0

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

        return rsi_val

    def stoch(
        self,
        close: np.ndarray,
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
        k_period: int = 14,
        d_period: int = 3,
        smooth_k: int = 3,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Stochastic Oscillator.

        Pine equivalent: ``ta.stoch(close, high, low, 14)``

        Returns:
            Tuple of (K%, D%) arrays.
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.stoch() needs high/low — pass explicitly or use within Pyne script")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low

        hh = utils.highest(high, k_period)
        ll = utils.lowest(low, k_period)

        with np.errstate(divide="ignore", invalid="ignore"):
            raw_k = np.where(
                (hh - ll) != 0,
                100.0 * (close - ll) / (hh - ll),
                50.0,
            )
        raw_k[:k_period - 1] = np.nan

        k = self.sma(raw_k, smooth_k)
        d = self.sma(k, d_period)

        return k, d

    def cci(
        self,
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
        close: np.ndarray | None = None,
        period: int = 20,
    ) -> np.ndarray:
        """Commodity Channel Index.

        Pine equivalent: ``ta.cci(high, low, close, 20)``
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.cci() needs OHLC data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None:
            close = self._ctx.close

        tp = (high + low + close) / 3.0
        tp_sma = self.sma(tp, period)

        # Mean absolute deviation
        n = len(tp)
        mad = np.full(n, np.nan)
        for i in range(period - 1, n):
            window = tp[i - period + 1: i + 1]
            mad[i] = np.nanmean(np.abs(window - tp_sma[i]))

        with np.errstate(divide="ignore", invalid="ignore"):
            result = np.where(mad != 0, (tp - tp_sma) / (0.015 * mad), 0.0)
        result[:period - 1] = np.nan
        return result

    # ═══════════════════════════════════════════════════════════
    #  Trend Indicators
    # ═══════════════════════════════════════════════════════════

    def macd(
        self,
        src: np.ndarray,
        fast: int = 12,
        slow: int = 26,
        signal: int = 9,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """MACD — Moving Average Convergence Divergence.

        Pine equivalent: ``ta.macd(close, 12, 26, 9)``

        Returns:
            Tuple of (DIF, DEA, histogram) arrays.
            ``histogram = 2 * (DIF - DEA)``
        """
        ema_fast = self.ema(src, fast)
        ema_slow = self.ema(src, slow)
        dif = ema_fast - ema_slow
        dea = self.ema(dif, signal)
        hist = 2.0 * (dif - dea)
        return dif, dea, hist

    def adx(
        self,
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
        close: np.ndarray | None = None,
        period: int = 14,
    ) -> np.ndarray:
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

        up_move = utils.change(high, 1)
        down_move = -utils.change(low, 1)
        up_move[0] = 0
        down_move[0] = 0

        plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
        minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

        atr_val = self.atr(period, high, low, close)
        smooth_plus = self.rma(plus_dm, period)
        smooth_minus = self.rma(minus_dm, period)

        with np.errstate(divide="ignore", invalid="ignore"):
            plus_di = 100.0 * smooth_plus / atr_val
            minus_di = 100.0 * smooth_minus / atr_val
            dx = 100.0 * np.abs(plus_di - minus_di) / (plus_di + minus_di)

        dx = np.nan_to_num(dx, nan=0.0)
        adx_val = self.rma(dx, period)
        return adx_val

    def supertrend(
        self,
        period: int = 10,
        mult: float = 3.0,
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
        close: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Supertrend indicator.

        Pine equivalent: ``ta.supertrend(close, 10, 3)``

        Returns:
            Tuple of (supertrend_line, direction) arrays.
            direction: 1 = uptrend (bullish), -1 = downtrend (bearish).
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.supertrend() needs OHLC data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None:
            close = self._ctx.close

        atr_val = self.atr(period, high, low, close)
        hl2 = (high + low) / 2.0

        n = len(close)
        upper_band = hl2 + mult * atr_val
        lower_band = hl2 - mult * atr_val
        supertrend = np.full(n, np.nan)
        direction = np.ones(n)  # 1 = up, -1 = down

        for i in range(period, n):
            if np.isnan(upper_band[i]) or np.isnan(lower_band[i]):
                continue

            if i == period:
                supertrend[i] = upper_band[i]
                direction[i] = -1 if close[i] < upper_band[i] else 1
                continue

            # Adjust bands
            if lower_band[i] > lower_band[i - 1] or close[i - 1] < lower_band[i - 1]:
                pass
            else:
                lower_band[i] = lower_band[i - 1]

            if upper_band[i] < upper_band[i - 1] or close[i - 1] > upper_band[i - 1]:
                pass
            else:
                upper_band[i] = upper_band[i - 1]

            if direction[i - 1] == 1:  # was uptrend
                if close[i] < lower_band[i]:
                    direction[i] = -1
                    supertrend[i] = upper_band[i]
                else:
                    direction[i] = 1
                    supertrend[i] = lower_band[i]
            else:  # was downtrend
                if close[i] > upper_band[i]:
                    direction[i] = 1
                    supertrend[i] = lower_band[i]
                else:
                    direction[i] = -1
                    supertrend[i] = upper_band[i]

        return supertrend, direction

    # ═══════════════════════════════════════════════════════════
    #  Volatility
    # ═══════════════════════════════════════════════════════════

    def tr(
        self,
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
        close: np.ndarray | None = None,
    ) -> np.ndarray:
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

        prev_close = utils.shift(close, 1)
        tr1 = high - low
        tr2 = np.abs(high - prev_close)
        tr3 = np.abs(low - prev_close)
        return np.maximum(tr1, np.maximum(tr2, tr3))

    def atr(
        self,
        period: int = 14,
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
        close: np.ndarray | None = None,
    ) -> np.ndarray:
        """Average True Range.

        Pine equivalent: ``ta.atr(14)``

        When called without high/low/close, uses the global context data.
        """
        tr_val = self.tr(high, low, close)
        return self.rma(tr_val, period)

    def bb(
        self,
        src: np.ndarray,
        period: int = 20,
        mult: float = 2.0,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Bollinger Bands.

        Pine equivalent: ``ta.bb(close, 20, 2)``

        Returns:
            Tuple of (upper, middle, lower) arrays.
        """
        middle = self.sma(src, period)
        sd = self.stdev(src, period)
        upper = middle + mult * sd
        lower = middle - mult * sd
        return upper, middle, lower

    def stdev(self, src: np.ndarray, period: int) -> np.ndarray:
        """Rolling Standard Deviation (O(n) optimized).

        Pine equivalent: ``ta.stdev(close, 20)``

        Uses the identity ``Var(X) = E[X²] − (E[X])²`` with cumulative
        sums for O(n) computation instead of the naive O(n·period) loop.
        Falls back to a per-window approach only when NaN values are present.
        """
        n = len(src)
        result = np.full(n, np.nan)
        if period <= 0 or period > n:
            return result

        # If NaN values exist, fall back to window-based approach
        if np.any(np.isnan(src)):
            for i in range(period - 1, n):
                window = src[i - period + 1: i + 1]
                if not np.any(np.isnan(window)):
                    result[i] = np.std(window, ddof=0)
            return result

        # ── O(n) vectorized path ──
        # Var(X) = E[X²] − (E[X])²
        cs = np.cumsum(src)
        cs2 = np.cumsum(src * src)

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

        return result

    def keltner(
        self,
        period: int = 20,
        mult: float = 1.5,
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
        close: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
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
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
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
        close: np.ndarray | None = None,
        volume: np.ndarray | None = None,
    ) -> np.ndarray:
        """On-Balance Volume.

        Pine equivalent: ``ta.obv``
        """
        if close is None:
            if self._ctx is None:
                raise RuntimeError("ta.obv() needs close/volume data")
            close = self._ctx.close
        if volume is None:
            volume = self._ctx.volume

        n = len(close)
        result = np.zeros(n)
        for i in range(1, n):
            if close[i] > close[i - 1]:
                result[i] = result[i - 1] + volume[i]
            elif close[i] < close[i - 1]:
                result[i] = result[i - 1] - volume[i]
            else:
                result[i] = result[i - 1]
        return result

    def volume_sma(self, volume: np.ndarray | None = None, period: int = 20) -> np.ndarray:
        """Volume Simple Moving Average."""
        if volume is None:
            if self._ctx is None:
                raise RuntimeError("ta.volume_sma() needs volume data")
            volume = self._ctx.volume
        return self.sma(volume, period)

    def mfi(
        self,
        period: int = 14,
        high: np.ndarray | None = None,
        low: np.ndarray | None = None,
        close: np.ndarray | None = None,
        volume: np.ndarray | None = None,
    ) -> np.ndarray:
        """Money Flow Index.

        Pine equivalent: ``ta.mfi(hlc3, 14)``
        """
        if high is None:
            if self._ctx is None:
                raise RuntimeError("ta.mfi() needs OHLCV data")
            high = self._ctx.high
        if low is None:
            low = self._ctx.low
        if close is None:
            close = self._ctx.close
        if volume is None:
            volume = self._ctx.volume

        tp = (high + low + close) / 3.0
        raw_mf = tp * volume

        pos_mf = np.where(utils.change(tp, 1) > 0, raw_mf, 0.0)
        neg_mf = np.where(utils.change(tp, 1) < 0, raw_mf, 0.0)
        pos_mf[0] = 0
        neg_mf[0] = 0

        pos_sum = utils.sum_(pos_mf, period)
        neg_sum = utils.sum_(neg_mf, period)

        with np.errstate(divide="ignore", invalid="ignore"):
            mfi_val = np.where(neg_sum != 0, 100.0 - 100.0 / (1.0 + pos_sum / neg_sum), 100.0)
        mfi_val[:period] = np.nan
        return mfi_val

    # ═══════════════════════════════════════════════════════════
    #  Proxy methods for utils (so ta.crossover works)
    # ═══════════════════════════════════════════════════════════

    crossover = staticmethod(utils.crossover)
    crossunder = staticmethod(utils.crossunder)
    highest = staticmethod(utils.highest)
    lowest = staticmethod(utils.lowest)
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
