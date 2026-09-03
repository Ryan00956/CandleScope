"""
Bar Aggregator Configuration — all tunable parameters for the Bar Aggregator.

Every parameter has a sensible default but can be overridden via:
  1. Constructor kwargs
  2. Environment variables (prefixed with BAR_AGG_)
  3. Runtime update via ``update()`` method

Mirrors the pattern established by ``ingestion.config.IngestionConfig``
and ``backfill.config.BackfillConfig``.
"""
from __future__ import annotations

from app.core.config import getenv as app_getenv

from dataclasses import dataclass, field


# ─── Environment helpers ─────────────────────────────────────

def _env_int(key: str, default: int) -> int:
    raw = app_getenv(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    raw = app_getenv(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_str(key: str, default: str) -> str:
    return app_getenv(key, default)


def _env_bool(key: str, default: bool) -> bool:
    raw = app_getenv(key)
    if raw is None:
        return default
    return raw.lower() in ("true", "1", "yes")


def _env_str_list(key: str, default: list[str]) -> list[str]:
    raw = app_getenv(key)
    if raw is None:
        return list(default)
    return [s.strip() for s in raw.split(",") if s.strip()]


@dataclass
class BarAggregatorConfig:
    """Central configuration for the Bar Aggregator pipeline.

    Grouped by sub-component (L1–L5) for easy discovery.
    """

    # ── L1: Event Router ─────────────────────────────────────

    # Bar source mode: "kline" (default), "trade", or "auto"
    # - "kline": build bars from exchange kline events
    # - "trade": build bars from aggTrade / trade events
    # - "auto":  prefer kline, fallback to trade if unavailable
    bar_source_mode: str = field(
        default_factory=lambda: _env_str("BAR_AGG_SOURCE_MODE", "kline"),
    )

    # Stream types accepted by the router (for filtering MarketEvents)
    # When bar_source_mode="kline", only KLINE events are routed.
    # When "trade", AGG_TRADE and TRADE are routed.
    # When "auto", all three are accepted.
    # Users can override this list to add custom stream types.
    accepted_stream_types: list[str] = field(
        default_factory=lambda: _env_str_list(
            "BAR_AGG_ACCEPTED_STREAMS", ["kline"],
        ),
    )

    # ── L2: Time Bucket Engine ───────────────────────────────

    # Default alignment mode for custom intervals.
    # "epoch" | "midnight" | "market" | "custom" | "none"
    default_alignment_mode: str = field(
        default_factory=lambda: _env_str("BAR_AGG_ALIGNMENT_MODE", "epoch"),
    )

    # Custom alignment epoch (ms).  Used when alignment_mode == "custom".
    alignment_epoch_ms: int = field(
        default_factory=lambda: _env_int("BAR_AGG_ALIGNMENT_EPOCH_MS", 0),
    )

    # ── L3: Bar State Engine ─────────────────────────────────

    # Maximum number of active (FORMING) bars per (symbol, interval) pair.
    # Older forming bars are force-closed when this limit is reached.
    max_active_bars: int = field(
        default_factory=lambda: _env_int("BAR_AGG_MAX_ACTIVE_BARS", 3),
    )

    # Maximum number of recently closed bars to keep in memory per
    # (symbol, interval) pair.  Useful for look-back / indicator calc.
    max_closed_bars_in_memory: int = field(
        default_factory=lambda: _env_int("BAR_AGG_MAX_CLOSED_BARS", 500),
    )

    # ── L4: Finalizer ────────────────────────────────────────

    # Legacy compatibility knob. Standard cumulative snapshots now always
    # require the exchange's is_closed (x=true) signal before authoritative
    # close; setting this false cannot weaken that persistence boundary.
    use_source_close_signal: bool = field(
        default_factory=lambda: _env_bool("BAR_AGG_USE_SOURCE_CLOSE", True),
    )

    # Time-based finalizer: how many ms AFTER bucket_end_ms to wait
    # before force-closing a bar (safety timeout).
    # This catches cases where the WS close signal is lost.
    finalize_timeout_ms: int = field(
        default_factory=lambda: _env_int("BAR_AGG_FINALIZE_TIMEOUT_MS", 5_000),
    )

    # Whether to use event-driven finalization: when a new bucket's first
    # event arrives, close the previous bucket.
    use_event_driven_close: bool = field(
        default_factory=lambda: _env_bool("BAR_AGG_USE_EVENT_DRIVEN_CLOSE", True),
    )

    # For custom intervals: enable composite close detection.
    # A custom bar (e.g. 91m) is closed when its LAST component source bar
    # reports is_closed=True.
    use_composite_close: bool = field(
        default_factory=lambda: _env_bool("BAR_AGG_USE_COMPOSITE_CLOSE", True),
    )

    # ── L5: Publisher ────────────────────────────────────────

    # Throttle interval (ms) for UPDATED events.
    # 0 = no throttle, every update is emitted.
    # 250 = at most one UPDATED event per 250ms per bar.
    update_throttle_ms: int = field(
        default_factory=lambda: _env_int("BAR_AGG_UPDATE_THROTTLE_MS", 250),
    )

    # Maximum subscriber queue size (for async-iterator consumers)
    publisher_queue_size: int = field(
        default_factory=lambda: _env_int("BAR_AGG_PUBLISHER_QUEUE_SIZE", 1000),
    )

    # Whether to emit CREATED events (some consumers don't need them)
    emit_created_events: bool = field(
        default_factory=lambda: _env_bool("BAR_AGG_EMIT_CREATED", True),
    )

    # Whether to emit UPDATED events (disable to reduce noise)
    emit_updated_events: bool = field(
        default_factory=lambda: _env_bool("BAR_AGG_EMIT_UPDATED", True),
    )

    # Whether to emit EXPIRED events
    emit_expired_events: bool = field(
        default_factory=lambda: _env_bool("BAR_AGG_EMIT_EXPIRED", False),
    )

    # ── General ──────────────────────────────────────────────

    # Exchange identifier (for multi-exchange support in the future)
    exchange: str = field(
        default_factory=lambda: _env_str("BAR_AGG_EXCHANGE", "binance"),
    )

    # ── Methods ──────────────────────────────────────────────

    def update(self, **kwargs) -> None:
        """Update config fields at runtime.  Only known fields are accepted."""
        for key, value in kwargs.items():
            if not hasattr(self, key):
                raise ValueError(f"Unknown config key: {key}")
            setattr(self, key, value)

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of current configuration."""
        from dataclasses import asdict
        return asdict(self)
