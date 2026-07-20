"""
Bar Aggregator — builds OHLCV candles from market data streams.

Layered architecture:
  L1: EventRouter       — normalizes and dispatches incoming data
  L2: TimeBucketEngine  — computes time bucket membership
  L3: BarStateEngine    — maintains OHLCV accumulation state
  L4: Finalizer         — determines when to close a bar
  L5: Publisher          — broadcasts bar lifecycle events

Quick start::

    from app.data_engine.bar_aggregator import BarAggregator, BarAggregatorConfig

    agg = BarAggregator()
    agg.add_target("BTCUSDT", "1m")
    agg.publisher.on_bar_closed(my_callback)
    await agg.start()
"""

from .aggregator import BarAggregator, IntervalPipeline
from .config import BarAggregatorConfig
from .models import (
    AlignmentMode,
    BarEvent,
    BarEventFilter,
    BarEventType,
    BarFinality,
    BarInput,
    BarInputAdapter,
    BarInputSource,
    BarMergeStrategy,
    BarSourceMode,
    BarState,
    BarStateChange,
    BarStatus,
    BucketCalculator,
    FinalizeTrigger,
    FinalizerStrategy,
    MergeMode,
    STANDARD_INTERVALS,
    is_standard_interval,
    parse_interval_ms,
)
from .router import EventRouter
from .time_bucket import TimeBucketEngine, MonthlyBucketCalculator
from .bar_state import BarStateEngine, StandardOHLCVMerge
from .finalizer import (
    Finalizer,
    SourceCloseFinalizer,
    CompositeCloseFinalizer,
    EventDrivenFinalizer,
    TimeBasedFinalizer,
    BatchFinalizer,
)
from .publisher import BarAggregatorPublisher

__all__ = [
    # Top-level
    "BarAggregator",
    "BarAggregatorConfig",
    "IntervalPipeline",
    # L1
    "EventRouter",
    # L2
    "TimeBucketEngine",
    "MonthlyBucketCalculator",
    # L3
    "BarStateEngine",
    "StandardOHLCVMerge",
    # L4
    "Finalizer",
    "SourceCloseFinalizer",
    "CompositeCloseFinalizer",
    "EventDrivenFinalizer",
    "TimeBasedFinalizer",
    "BatchFinalizer",
    # L5
    "BarAggregatorPublisher",
    # Models & Enums
    "AlignmentMode",
    "BarEvent",
    "BarEventFilter",
    "BarEventType",
    "BarFinality",
    "BarInput",
    "BarInputAdapter",
    "BarInputSource",
    "BarMergeStrategy",
    "BarSourceMode",
    "BarState",
    "BarStateChange",
    "BarStatus",
    "BucketCalculator",
    "FinalizeTrigger",
    "FinalizerStrategy",
    "MergeMode",
    # Helpers
    "STANDARD_INTERVALS",
    "is_standard_interval",
    "parse_interval_ms",
]
