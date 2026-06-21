"""Step-by-step technical analysis helpers for incremental sessions."""
from __future__ import annotations

import math
from collections import deque
from typing import Any

from .limits import IncrementalLimits, _LimitTracker


class _StepSMA:
    def __init__(self, period: int) -> None:
        self.period = max(int(period), 1)
        self.window: deque[float] = deque()
        self.sum = 0.0

    def update(self, value: Any) -> float | None:
        if value is None:
            return None
        number = float(value)
        self.window.append(number)
        self.sum += number
        if len(self.window) > self.period:
            self.sum -= self.window.popleft()
        if len(self.window) < self.period:
            return None
        return self.sum / self.period


class _StepEMA:
    def __init__(self, period: int) -> None:
        self.period = max(int(period), 1)
        self.alpha = 2.0 / (self.period + 1)
        self.count = 0
        self.seed_sum = 0.0
        self.ema: float | None = None

    def update(self, value: Any) -> float | None:
        if value is None:
            return self.ema
        number = float(value)
        if self.ema is None:
            self.count += 1
            self.seed_sum += number
            if self.count < self.period:
                return None
            self.ema = self.seed_sum / self.period
            return self.ema
        self.ema = self.alpha * number + (1 - self.alpha) * self.ema
        return self.ema


class _StepBOLL:
    def __init__(self, period: int, multiplier: float = 2.0) -> None:
        self.period = max(int(period), 1)
        self.multiplier = float(multiplier)
        self.window: deque[float] = deque()
        self.sum = 0.0
        self.sumsq = 0.0

    def update(self, value: Any) -> tuple[float | None, float | None, float | None]:
        if value is None:
            return None, None, None
        number = float(value)
        self.window.append(number)
        self.sum += number
        self.sumsq += number * number
        if len(self.window) > self.period:
            removed = self.window.popleft()
            self.sum -= removed
            self.sumsq -= removed * removed
        if len(self.window) < self.period:
            return None, None, None
        mid = self.sum / self.period
        variance = max(self.sumsq / self.period - mid * mid, 0.0)
        std = math.sqrt(variance)
        return mid + self.multiplier * std, mid, mid - self.multiplier * std


class _StepMACD:
    def __init__(self, fast: int = 12, slow: int = 26, signal: int = 9) -> None:
        self.fast = _StepEMA(max(int(fast), 1))
        self.slow = _StepEMA(max(int(slow), 1))
        self.signal = _StepEMA(max(int(signal), 1))

    def update(self, value: Any) -> tuple[float | None, float | None, float | None]:
        fast_value = self.fast.update(value)
        slow_value = self.slow.update(value)
        if fast_value is None or slow_value is None:
            return None, None, None
        dif = fast_value - slow_value
        dea = self.signal.update(dif)
        hist = dif - dea if dea is not None else None
        return dif, dea, hist


class _StepRSI:
    def __init__(self, period: int = 14) -> None:
        self.period = max(int(period), 1)
        self.prev: float | None = None
        self.count = 0
        self.gain_sum = 0.0
        self.loss_sum = 0.0
        self.avg_gain: float | None = None
        self.avg_loss: float | None = None

    def update(self, value: Any) -> float | None:
        if value is None:
            return None
        current = float(value)
        if self.prev is None:
            self.prev = current
            return None
        delta = current - self.prev
        self.prev = current
        gain = max(delta, 0.0)
        loss = max(-delta, 0.0)
        if self.avg_gain is None or self.avg_loss is None:
            self.count += 1
            self.gain_sum += gain
            self.loss_sum += loss
            if self.count < self.period:
                return None
            self.avg_gain = self.gain_sum / self.period
            self.avg_loss = self.loss_sum / self.period
        else:
            self.avg_gain = (self.avg_gain * (self.period - 1) + gain) / self.period
            self.avg_loss = (self.avg_loss * (self.period - 1) + loss) / self.period
        return _rsi_from_avgs(self.avg_gain, self.avg_loss)


class _StepATR:
    def __init__(self, period: int = 14) -> None:
        self.period = max(int(period), 1)
        self.prev_close: float | None = None
        self.count = 0
        self.tr_sum = 0.0
        self.atr: float | None = None

    def update(self, bar_or_high: Any, low: Any = None, close: Any = None) -> float | None:
        if low is None and close is None:
            high = float(getattr(bar_or_high, "high"))
            low = float(getattr(bar_or_high, "low"))
            close = float(getattr(bar_or_high, "close"))
        else:
            high = float(bar_or_high)
            low = float(low)
            close = float(close)

        if self.prev_close is None:
            tr = high - low
        else:
            tr = max(high - low, abs(high - self.prev_close), abs(low - self.prev_close))
        self.prev_close = close

        if self.atr is None:
            self.count += 1
            self.tr_sum += tr
            if self.count < self.period:
                return None
            self.atr = self.tr_sum / self.period
        else:
            self.atr = (self.atr * (self.period - 1) + tr) / self.period
        return self.atr


class _StepMonotonic:
    def __init__(self, period: int, *, highest: bool) -> None:
        self.period = max(int(period), 1)
        self.highest = highest
        self.index = -1
        self.window: deque[tuple[int, float]] = deque()

    def update(self, value: Any) -> float | None:
        if value is None:
            return None
        self.index += 1
        number = float(value)
        expiry = self.index - self.period
        while self.window and self.window[0][0] <= expiry:
            self.window.popleft()
        if self.highest:
            while self.window and self.window[-1][1] <= number:
                self.window.pop()
        else:
            while self.window and self.window[-1][1] >= number:
                self.window.pop()
        self.window.append((self.index, number))
        if self.index + 1 < self.period:
            return None
        return self.window[0][1]


class IncrementalTaNamespace:
    """Stateful TA helper namespace available as ``ctx.ta``."""

    def __init__(self, limits: _LimitTracker | None = None) -> None:
        self._helpers: dict[str, Any] = {}
        self._limits = limits or _LimitTracker(IncrementalLimits(enabled=False))

    def sma(self, name: str, period: int | None = None) -> _StepSMA:
        key = f"sma:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.sma('{name}') has not been initialized")
            self._limits.reserve_window(period, label=key)
            self._helpers[key] = _StepSMA(period)
        return self._helpers[key]

    def ema(self, name: str, period: int | None = None) -> _StepEMA:
        key = f"ema:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.ema('{name}') has not been initialized")
            self._helpers[key] = _StepEMA(period)
        return self._helpers[key]

    def boll(self, name: str, period: int | None = None, multiplier: float = 2.0) -> _StepBOLL:
        key = f"boll:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.boll('{name}') has not been initialized")
            self._limits.reserve_window(period, label=key)
            self._helpers[key] = _StepBOLL(period, multiplier)
        return self._helpers[key]

    def macd(
        self,
        name: str,
        fast: int | None = None,
        slow: int = 26,
        signal: int = 9,
    ) -> _StepMACD:
        key = f"macd:{name}"
        if key not in self._helpers:
            if fast is None:
                raise ValueError(f"ctx.ta.macd('{name}') has not been initialized")
            self._helpers[key] = _StepMACD(fast, slow, signal)
        return self._helpers[key]

    def rsi(self, name: str, period: int | None = None) -> _StepRSI:
        key = f"rsi:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.rsi('{name}') has not been initialized")
            self._helpers[key] = _StepRSI(period)
        return self._helpers[key]

    def atr(self, name: str, period: int | None = None) -> _StepATR:
        key = f"atr:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.atr('{name}') has not been initialized")
            self._helpers[key] = _StepATR(period)
        return self._helpers[key]

    def highest(self, name: str, period: int | None = None) -> _StepMonotonic:
        key = f"highest:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.highest('{name}') has not been initialized")
            self._limits.reserve_window(period, label=key)
            self._helpers[key] = _StepMonotonic(period, highest=True)
        return self._helpers[key]

    def lowest(self, name: str, period: int | None = None) -> _StepMonotonic:
        key = f"lowest:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.lowest('{name}') has not been initialized")
            self._limits.reserve_window(period, label=key)
            self._helpers[key] = _StepMonotonic(period, highest=False)
        return self._helpers[key]

def _rsi_from_avgs(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 0.0
    if avg_gain == 0:
        return 0.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)
