"""
Data Manager — unified cache, query, and event distribution layer.

Quick start::

    from app.data_engine.data_manager import DataManager, DataManagerConfig

    dm = DataManager()
    await dm.start()

    result = dm.query("BTCUSDT", "1m", limit=500)
    handle = dm.subscribe(callback=on_bar, symbol="BTCUSDT", interval="1m")

    await dm.shutdown()

See ``README.md`` / ``README_CN.md`` for full documentation.
"""

from .config import (
    CacheConfig,
    CoordinatorConfig,
    DataManagerConfig,
    EventBusConfig,
    PrewarmTarget,
    QueryConfig,
)
from .models import (
    BarData,
    DataEvent,
    DataEventType,
    EventCallback,
    QueryResult,
    QuerySource,
    SeriesKey,
    StorageBackend,
    StreamInfo,
    StreamStatus,
    SubscriptionHandle,
)
from .cache import BarCache, BarSeries
from .event_bus import DataEventBus, MiddlewareHook
from .query import QueryEngine
from .coordinator import StreamCoordinator, IngestionFactory
from .manager import DataManager

__all__ = [
    # Facade
    "DataManager",
    # Config
    "DataManagerConfig",
    "CacheConfig",
    "QueryConfig",
    "EventBusConfig",
    "CoordinatorConfig",
    "PrewarmTarget",
    # Models
    "BarData",
    "SeriesKey",
    "QueryResult",
    "QuerySource",
    "DataEvent",
    "DataEventType",
    "EventCallback",
    "SubscriptionHandle",
    "StreamInfo",
    "StreamStatus",
    "StorageBackend",
    # Components
    "BarCache",
    "BarSeries",
    "DataEventBus",
    "MiddlewareHook",
    "QueryEngine",
    "StreamCoordinator",
    "IngestionFactory",
]
