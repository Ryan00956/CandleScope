"""
Pyne Math — array-aware math functions mirroring Pine's ``math.*`` namespace.

All functions accept both scalars and numpy arrays, returning the same type.

Usage::

    x = math.abs(change(close))
    y = math.log(close)
    z = math.max(high, shift(high, 1))
"""
from __future__ import annotations

import numpy as np

from . import utils
from .series import wrap_like


class PyneMath:
    """Pine-style math namespace. Injected as ``math`` in scripts."""

    def __init__(self, *, mintick: float = 1.0) -> None:
        self.mintick = float(mintick) if float(mintick) > 0 else 1.0

    def abs(self, x):
        return wrap_like(np.abs(x), x)

    def log(self, x):
        return wrap_like(np.log(x), x)

    def log10(self, x):
        return wrap_like(np.log10(x), x)

    def sqrt(self, x):
        return wrap_like(np.sqrt(x), x)

    def exp(self, x):
        return wrap_like(np.exp(x), x)

    def pow(self, base, exp):
        return wrap_like(np.power(base, exp), base, exp)

    def ceil(self, x):
        return wrap_like(np.ceil(x), x)

    def floor(self, x):
        return wrap_like(np.floor(x), x)

    def round(self, x, precision=0, *, digits=None):
        if digits is not None:
            precision = digits
        return wrap_like(np.round(x, int(precision)), x)

    def trunc(self, x):
        return wrap_like(np.trunc(x), x)

    def fixnan(self, x):
        return utils.fixnan(x)

    def max(self, *args):
        if not args:
            raise TypeError("math.max() requires at least one argument")
        result = args[0]
        for item in args[1:]:
            result = np.maximum(result, item)
        return wrap_like(result, *args)

    def min(self, *args):
        if not args:
            raise TypeError("math.min() requires at least one argument")
        result = args[0]
        for item in args[1:]:
            result = np.minimum(result, item)
        return wrap_like(result, *args)

    def sign(self, x):
        return wrap_like(np.sign(x), x)

    def avg(self, *args):
        if not args:
            raise TypeError("math.avg() requires at least one argument")
        return wrap_like(sum(args) / len(args), *args)

    def sum(self, src, period: int):
        return utils.sum_(src, int(period))

    def round_to_mintick(self, x):
        values = np.asarray(x, dtype=np.float64)
        rounded = np.floor(values / self.mintick + 0.5) * self.mintick
        rounded = np.round(rounded, 10)
        if np.asarray(x).ndim == 0:
            return float(rounded)
        return wrap_like(rounded, x)

    def random(self, min: float = 0.0, max: float = 1.0, seed: int | None = None):
        rng = np.random.default_rng(None if seed is None else int(seed))
        low = np.asarray(min, dtype=np.float64)
        high = np.asarray(max, dtype=np.float64)
        shape = np.broadcast(low, high).shape
        value = rng.uniform(low, high, size=shape or None)
        if np.asarray(min).ndim == 0 and np.asarray(max).ndim == 0:
            return float(value)
        return wrap_like(value, min, max)

    def sin(self, x):
        return wrap_like(np.sin(x), x)

    def cos(self, x):
        return wrap_like(np.cos(x), x)

    def tan(self, x):
        return wrap_like(np.tan(x), x)

    def asin(self, x):
        return wrap_like(np.arcsin(x), x)

    def acos(self, x):
        return wrap_like(np.arccos(x), x)

    def atan(self, x):
        return wrap_like(np.arctan(x), x)

    def todegrees(self, x):
        return wrap_like(np.degrees(x), x)

    def toradians(self, x):
        return wrap_like(np.radians(x), x)

    # Constants
    pi = np.pi
    e = np.e
    phi = (1 + np.sqrt(5)) / 2  # golden ratio


pyne_math = PyneMath()
