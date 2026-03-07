"""
Indicator Module — incremental, event-driven indicator computation engine.

Architecture::

    indicator/
    ├── __init__.py          ← you are here (auto-registration + public API)
    ├── types.py             ← IndicatorKey, IndicatorResult, IndicatorSpec, ...
    ├── base.py              ← Indicator abstract base class
    ├── events.py            ← IndicatorEvent, IndicatorEventType
    ├── registry.py          ← IndicatorRegistry (singleton: ``registry``)
    ├── engine.py            ← IndicatorEngine (create via ``create_engine()``)
    └── indicators/          ← built-in implementations
        ├── ma.py            ← MA  (Simple Moving Average)
        ├── ema.py           ← EMA (Exponential Moving Average)
        ├── macd.py          ← MACD (Moving Average Convergence Divergence)
        ├── rsi.py           ← RSI (Relative Strength Index)
        ├── boll.py          ← BOLL (Bollinger Bands)
        └── atr.py           ← ATR (Average True Range)

Quick start::

    from app.indicator import create_engine, registry

    engine = create_engine()
    result = engine.compute("BTCUSDT", "1m", "MA", {"period": 20}, bars)
    print(result.to_dict())
"""
from .base import Indicator
from .dependency import (
    CyclicDependencyError,
    DependencyEdge,
    DependencyGraph,
    DependencyNode,
    UnresolvedDependencyError,
    build_synthetic_bars,
)
from .engine import IndicatorEngine
from .events import IndicatorEvent, IndicatorEventType
from .registry import IndicatorRegistry, registry
from .types import (
    IndicatorKey,
    IndicatorMeta,
    IndicatorOutput,
    IndicatorParam,
    IndicatorResult,
    IndicatorSpec,
    OutputPoint,
    PaneType,
    SeriesType,
)

# ── Auto-register built-in indicators ────────────────────────
from .indicators.ma import MAIndicator
from .indicators.ema import EMAIndicator
from .indicators.macd import MACDIndicator
from .indicators.rsi import RSIIndicator
from .indicators.boll import BOLLIndicator
from .indicators.atr import ATRIndicator

_BUILTINS = [
    MAIndicator,
    EMAIndicator,
    MACDIndicator,
    RSIIndicator,
    BOLLIndicator,
    ATRIndicator,
]

for _cls in _BUILTINS:
    registry.register(_cls)


def create_engine() -> IndicatorEngine:
    """Create a new IndicatorEngine (uses the global registry)."""
    engine = IndicatorEngine()
    engine.start()
    return engine


__all__ = [
    # Core
    "Indicator",
    "IndicatorEngine",
    "IndicatorRegistry",
    "registry",
    "create_engine",
    # Types
    "IndicatorKey",
    "IndicatorMeta",
    "IndicatorOutput",
    "IndicatorParam",
    "IndicatorResult",
    "IndicatorSpec",
    "OutputPoint",
    "PaneType",
    "SeriesType",
    # Events
    "IndicatorEvent",
    "IndicatorEventType",
    # Built-in indicators
    "MAIndicator",
    "EMAIndicator",
    "MACDIndicator",
    "RSIIndicator",
    "BOLLIndicator",
    "ATRIndicator",
]
