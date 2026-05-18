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


class PyneMath:
    """Pine-style math namespace. Injected as ``math`` in scripts."""

    @staticmethod
    def abs(x):
        return np.abs(x)

    @staticmethod
    def log(x):
        return np.log(x)

    @staticmethod
    def log10(x):
        return np.log10(x)

    @staticmethod
    def sqrt(x):
        return np.sqrt(x)

    @staticmethod
    def exp(x):
        return np.exp(x)

    @staticmethod
    def pow(base, exp):
        return np.power(base, exp)

    @staticmethod
    def ceil(x):
        return np.ceil(x)

    @staticmethod
    def floor(x):
        return np.floor(x)

    @staticmethod
    def round(x, digits=0):
        return np.round(x, digits)

    @staticmethod
    def max(a, b):
        return np.maximum(a, b)

    @staticmethod
    def min(a, b):
        return np.minimum(a, b)

    @staticmethod
    def sign(x):
        return np.sign(x)

    @staticmethod
    def avg(*args):
        return sum(args) / len(args)

    @staticmethod
    def sin(x):
        return np.sin(x)

    @staticmethod
    def cos(x):
        return np.cos(x)

    @staticmethod
    def tan(x):
        return np.tan(x)

    @staticmethod
    def asin(x):
        return np.arcsin(x)

    @staticmethod
    def acos(x):
        return np.arccos(x)

    @staticmethod
    def atan(x):
        return np.arctan(x)

    @staticmethod
    def todegrees(x):
        return np.degrees(x)

    @staticmethod
    def toradians(x):
        return np.radians(x)

    # Constants
    pi = np.pi
    e = np.e
    phi = (1 + np.sqrt(5)) / 2  # golden ratio


pyne_math = PyneMath()
