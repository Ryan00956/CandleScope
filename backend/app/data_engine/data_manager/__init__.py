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
    MissingRange,
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
from .daily_open import DailyOpenService
from .query import QueryEngine
from .coordinator import StreamCoordinator, IngestionFactory
from .ingestion_price_source import IngestionPriceSource
from .maintenance import MaintenanceBusyError, MaintenanceService, MaintenanceUnavailableError
from .price_cache import PriceSnapshot, PriceSnapshotCache
from .subscriptions import SubscriptionService, SubscriptionTier
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
    "MissingRange",
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
    "DailyOpenService",
    "QueryEngine",
    "StreamCoordinator",
    "IngestionFactory",
    "IngestionPriceSource",
    "MaintenanceService",
    "MaintenanceBusyError",
    "MaintenanceUnavailableError",
    "PriceSnapshot",
    "PriceSnapshotCache",
    "SubscriptionService",
    "SubscriptionTier",
]
