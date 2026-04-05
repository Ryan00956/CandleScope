"""
Data Manager Configuration.

All tunable knobs for the Data Manager in one place.
Users can subclass or override any field for custom setups.

Usage::

    config = DataManagerConfig(
        cache_max_bars_per_series=5000,
        prewarm_on_subscribe=True,
    )
    manager = DataManager(config)
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class PrewarmTarget:
    """One series family to prewarm on startup."""

    symbol: str
    exchange: str = "binance"
    market_type: str = "spot"

    def to_dict(self) -> dict[str, str]:
        return {
            "symbol": self.symbol,
            "exchange": self.exchange,
            "market_type": self.market_type,
        }


@dataclass
class CacheConfig:
    """In-memory K-line cache tuning.

    Attributes:
        max_bars_per_series:
            Maximum number of bars held in memory per (symbol, interval).
            Older bars are evicted in FIFO order.  A larger value uses
            more RAM but reduces storage lookups.

        max_series:
            Maximum number of (symbol, interval) series tracked.
            Least-recently-used series are evicted when exceeded.

        prewarm_bars:
            How many bars to load from storage when a series is first
            accessed (cache miss → storage read).

        ttl_seconds:
            Time-to-live for an idle series (no reads/writes).
            Set to 0 to disable TTL-based eviction.
    """
    max_bars_per_series: int = 5000
    max_series: int = 200
    prewarm_bars: int = 1000
    ttl_seconds: int = 0  # 0 = never expire


@dataclass
class QueryConfig:
    """Query engine tuning.

    Attributes:
        default_limit:
            Default number of bars returned when caller doesn't specify.

        max_limit:
            Hard cap on the number of bars per query.

        sync_backfill_timeout_seconds:
            When a query detects missing data, it can optionally wait
            for a synchronous backfill.  This is the max wait time.
            Set to 0 to always return immediately (async-only backfill).

        auto_backfill:
            Whether to automatically trigger a backfill when a query
            detects gaps.  If False, gaps are simply left empty.
    """
    default_limit: int = 500
    max_limit: int = 10_000
    sync_backfill_timeout_seconds: float = 0
    auto_backfill: bool = True


@dataclass
class EventBusConfig:
    """Event bus tuning.

    Attributes:
        subscriber_queue_size:
            Max queue depth per async-iterator subscriber.
            Events are dropped if the queue is full.

        emit_bar_updated:
            Whether to forward UPDATED bar events to external subscribers.
            Disabling this reduces noise for consumers that only care
            about CLOSED bars.

        emit_bar_created:
            Whether to forward CREATED bar events to external subscribers.
    """
    subscriber_queue_size: int = 1000
    emit_bar_updated: bool = True
    emit_bar_created: bool = True


@dataclass
class CoordinatorConfig:
    """Lifecycle coordinator tuning.

    Attributes:
        auto_start_ingestion:
            If True, ``ensure_stream()`` automatically creates an
            ingestion pipeline + bar_aggregator target for the
            requested (symbol, interval).

        idle_stream_timeout_seconds:
            If a stream has zero subscribers for this long, it is
            automatically stopped.  Set to 0 to keep streams alive
            indefinitely.

        base_interval:
            The base ingestion interval used to drive all aggregation.
            Typically "1m" — a single 1m WS stream can feed 5m, 15m,
            1h, etc. via bar_aggregator.

        prewarm_intervals:
            Intervals to prewarm on startup.  Keys are interval strings,
            values are how many days of data to load.

        prewarm_symbols:
            Symbols to prewarm on startup.

        prewarm_targets:
            Optional structured targets that include exchange/market_type.
            When set, this takes precedence over ``prewarm_symbols``.
    """
    auto_start_ingestion: bool = True
    idle_stream_timeout_seconds: int = 300  # 5 min
    base_interval: str = "1m"
    prewarm_intervals: dict[str, int] = field(default_factory=lambda: {
        "1m": 1,
        "5m": 3,
        "15m": 7,
        "1h": 30,
        "4h": 90,
        "1d": 365,
    })
    prewarm_symbols: list[str] = field(default_factory=lambda: ["BTCUSDT"])
    prewarm_targets: list[PrewarmTarget] = field(default_factory=list)


@dataclass
class DataManagerConfig:
    """Top-level configuration for the Data Manager.

    Groups all sub-configs.  Can be serialized/deserialized for
    persistence and debug output.

    Usage::

        cfg = DataManagerConfig()
        cfg.cache.max_bars_per_series = 10000
        cfg.query.auto_backfill = False
    """
    cache: CacheConfig = field(default_factory=CacheConfig)
    query: QueryConfig = field(default_factory=QueryConfig)
    event_bus: EventBusConfig = field(default_factory=EventBusConfig)
    coordinator: CoordinatorConfig = field(default_factory=CoordinatorConfig)

    def snapshot(self) -> dict:
        """JSON-serializable representation of all settings."""
        return {
            "cache": {
                "max_bars_per_series": self.cache.max_bars_per_series,
                "max_series": self.cache.max_series,
                "prewarm_bars": self.cache.prewarm_bars,
                "ttl_seconds": self.cache.ttl_seconds,
            },
            "query": {
                "default_limit": self.query.default_limit,
                "max_limit": self.query.max_limit,
                "sync_backfill_timeout_seconds": self.query.sync_backfill_timeout_seconds,
                "auto_backfill": self.query.auto_backfill,
            },
            "event_bus": {
                "subscriber_queue_size": self.event_bus.subscriber_queue_size,
                "emit_bar_updated": self.event_bus.emit_bar_updated,
                "emit_bar_created": self.event_bus.emit_bar_created,
            },
            "coordinator": {
                "auto_start_ingestion": self.coordinator.auto_start_ingestion,
                "idle_stream_timeout_seconds": self.coordinator.idle_stream_timeout_seconds,
                "base_interval": self.coordinator.base_interval,
                "prewarm_intervals": self.coordinator.prewarm_intervals,
                "prewarm_symbols": self.coordinator.prewarm_symbols,
                "prewarm_targets": [target.to_dict() for target in self.coordinator.prewarm_targets],
            },
        }
