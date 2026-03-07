"""
Built-in Indicator Implementations.

All indicators in this package are automatically registered with the
global ``IndicatorRegistry`` when the indicator module is imported.
"""
from .ma import MAIndicator
from .ema import EMAIndicator
from .macd import MACDIndicator
from .rsi import RSIIndicator
from .boll import BOLLIndicator
from .atr import ATRIndicator

__all__ = [
    "MAIndicator",
    "EMAIndicator",
    "MACDIndicator",
    "RSIIndicator",
    "BOLLIndicator",
    "ATRIndicator",
]
