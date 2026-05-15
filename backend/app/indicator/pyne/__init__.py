"""
Pyne — Pine-style Python library for CandleScope indicators.

Pyne brings the simplicity of TradingView's Pine Script to Python.
Users write indicators using familiar Pine-style APIs (ta.*, input.*,
plot, hline, fill, etc.) while retaining full Python power.

Usage (inside CandleScope script editor)::

    # Everything is pre-injected — no imports needed
    length = input.int(20, "Period", minval=1)
    src    = input.source(close, "Source")

    plot(ta.sma(src, length), title="SMA", color=color.orange)
    plot(ta.ema(src, length), title="EMA", color=color.blue)

Architecture::

    pyne/
    ├── __init__.py      ← you are here
    ├── runtime.py       ← script execution engine
    ├── context.py       ← OHLCV data context
    ├── ta.py            ← ta.* technical analysis functions
    ├── input.py         ← input.* parameter declaration
    ├── plot.py          ← plot(), hline(), fill(), marker() drawing API
    ├── color.py         ← color.* constants and helpers
    ├── math_ext.py      ← array-aware math extensions
    └── utils.py         ← na, nz, shift, crossover, etc.
"""

from .cache import pyne_cache
from .executor import execute_pyne_script, execute_pyne_script_in_process
from .runtime import PyneRuntime, PyneResult

__all__ = [
    "PyneRuntime",
    "PyneResult",
    "execute_pyne_script",
    "execute_pyne_script_in_process",
    "pyne_cache",
]
