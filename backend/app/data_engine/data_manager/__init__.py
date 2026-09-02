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
from .maintenance import MaintenanceBusyError, MaintenanceUnavailableError
from .facades import (
    BarDataFacade,
    FullOrderBookFacade,
    LiquidationDataFacade,
    MarketStateFacade,
    OrderBookFacades,
    PartialOrderBookFacade,
    TradeDataFacade,
)
from app.data_engine.series_identity import KlineSeriesIdentity
from .storage_intents import StorageIntentRegistry
from .subscriptions import SubscriptionTier
from .manager import DataManager, StreamCapacityError

__all__ = [
    # Facade
    "DataManager",
    "StreamCapacityError",
    "BarDataFacade",
    "MarketStateFacade",
    "TradeDataFacade",
    "LiquidationDataFacade",
    "PartialOrderBookFacade",
    "FullOrderBookFacade",
    "OrderBookFacades",
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
    "KlineSeriesIdentity",
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
    # Exceptions / enums
    "MaintenanceBusyError",
    "MaintenanceUnavailableError",
    "StorageIntentRegistry",
    "SubscriptionTier",
]
