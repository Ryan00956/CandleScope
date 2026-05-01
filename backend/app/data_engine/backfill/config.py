"""
Backfill Configuration — all tunable parameters for the Backfill Engine.

Every parameter has a sensible default but can be overridden via:
  1. Constructor kwargs
  2. Environment variables (prefixed with BACKFILL_)
  3. Runtime update via ``update()`` method

Mirrors the pattern established by ``ingestion.config.IngestionConfig``.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


# ─── Environment helpers (same pattern as ingestion) ─────────

def _env_int(key: str, default: int) -> int:
    raw = os.getenv(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    raw = os.getenv(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_str(key: str, default: str) -> str:
    return os.getenv(key, default)


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.lower() in ("true", "1", "yes")


def _env_str_list(key: str, default: list[str]) -> list[str]:
    raw = os.getenv(key)
    if raw is None:
        return list(default)
    return [s.strip() for s in raw.split(",") if s.strip()]


@dataclass
class BackfillConfig:
    """Central configuration for the Backfill Engine.

    Grouped by sub-component so it's easy to find what you're looking for.
    """

    # ── Gap Detector ─────────────────────────────────────────
    # Default intervals to scan for gaps when none specified
    gap_scan_intervals: list[str] = field(default_factory=lambda: _env_str_list(
        "BACKFILL_GAP_SCAN_INTERVALS",
        ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"],
    ))
    # Maximum time range (ms) to scan in a single gap-detection pass
    gap_max_scan_range_ms: int = field(
        default_factory=lambda: _env_int("BACKFILL_GAP_MAX_SCAN_RANGE_MS", 30 * 24 * 3600 * 1000),
    )
    # Tolerate this many missing bars before reporting a gap
    # (avoids noise at boundaries, e.g. exchange maintenance windows)
    gap_tolerance_bars: int = field(
        default_factory=lambda: _env_int("BACKFILL_GAP_TOLERANCE_BARS", 0),
    )
    # Whether to scan for interior holes (not just tail gaps)
    gap_scan_interior: bool = field(
        default_factory=lambda: _env_bool("BACKFILL_GAP_SCAN_INTERIOR", True),
    )
    # Maximum number of interior holes to report per interval
    gap_max_interior_holes: int = field(
        default_factory=lambda: _env_int("BACKFILL_GAP_MAX_INTERIOR_HOLES", 100),
    )

    # ── Backfill Planner ─────────────────────────────────────
    # Standard (exchange-native) intervals, sorted ascending by duration.
    # The planner uses these as building blocks for custom interval decomposition.
    standard_intervals: list[str] = field(default_factory=lambda: _env_str_list(
        "BACKFILL_STANDARD_INTERVALS",
        ["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"],
    ))
    # Decomposition strategy for custom intervals:
    #   "greedy_descending" — use largest fitting standard intervals first (fast)
    #   "min_requests"      — minimize total REST requests
    #   "single_base"       — use only one base interval (simple, more requests)
    decomposition_strategy: str = field(
        default_factory=lambda: _env_str("BACKFILL_DECOMPOSITION_STRATEGY", "greedy_descending"),
    )
    # Alignment mode for custom intervals:
    #   "epoch"    — align to alignment_epoch_ms (default: Unix epoch 0)
    #   "midnight" — align to UTC midnight boundaries
    #   "market"   — align to exchange market open (if applicable)
    #   "none"     — no alignment, start from gap_start
    custom_alignment_mode: str = field(
        default_factory=lambda: _env_str("BACKFILL_CUSTOM_ALIGNMENT_MODE", "epoch"),
    )
    # Custom alignment epoch (ms).  Only used when alignment_mode == "epoch".
    alignment_epoch_ms: int = field(
        default_factory=lambda: _env_int("BACKFILL_ALIGNMENT_EPOCH_MS", 0),
    )
    # Maximum number of decomposition components allowed (safety limit)
    max_decomposition_components: int = field(
        default_factory=lambda: _env_int("BACKFILL_MAX_DECOMPOSITION_COMPONENTS", 10),
    )

    # ── Historical Fetcher ───────────────────────────────────
    # Maximum concurrent REST requests. Keep the default modest because a
    # single page can carry non-trivial exchange request weight.
    fetch_concurrency: int = field(
        default_factory=lambda: _env_int("BACKFILL_FETCH_CONCURRENCY", 2),
    )
    # Binance Futures applies strict IP-level request limits. Serialize
    # futures backfills by default so a multi-interval repair cannot fan out
    # into a burst of REST calls.
    fetch_binance_futures_concurrency: int = field(
        default_factory=lambda: _env_int("BACKFILL_FETCH_BINANCE_FUTURES_CONCURRENCY", 1),
    )
    # Exchange-specific concurrency override for OKX.
    # OKX public market endpoints are easy to hit with 429s during
    # multi-interval backfills, so we serialize requests by default.
    fetch_okx_concurrency: int = field(
        default_factory=lambda: _env_int("BACKFILL_FETCH_OKX_CONCURRENCY", 1),
    )
    # Bars per REST page (exchange limit is usually 1000)
    fetch_batch_size: int = field(
        default_factory=lambda: _env_int("BACKFILL_FETCH_BATCH_SIZE", 1000),
    )
    # Delay between consecutive requests (seconds) to respect rate limits.
    fetch_rate_limit_delay: float = field(
        default_factory=lambda: _env_float("BACKFILL_FETCH_RATE_LIMIT_DELAY", 0.5),
    )
    # Binance Futures-specific minimum spacing between backfill requests.
    fetch_binance_futures_rate_limit_delay: float = field(
        default_factory=lambda: _env_float("BACKFILL_FETCH_BINANCE_FUTURES_RATE_LIMIT_DELAY", 1.0),
    )
    # OKX-specific minimum spacing between backfill requests.
    fetch_okx_rate_limit_delay: float = field(
        default_factory=lambda: _env_float("BACKFILL_FETCH_OKX_RATE_LIMIT_DELAY", 0.75),
    )
    # Maximum retries for a single fetch task before giving up
    fetch_max_retries: int = field(
        default_factory=lambda: _env_int("BACKFILL_FETCH_MAX_RETRIES", 3),
    )
    # Additional backoff when the exchange returns HTTP 429. This is an
    # exchange/market-wide cooldown, not just a per-task retry sleep.
    fetch_429_backoff_seconds: float = field(
        default_factory=lambda: _env_float("BACKFILL_FETCH_429_BACKOFF_SECONDS", 60.0),
    )
    # Per-request timeout (seconds), inherits from ingestion if 0
    fetch_timeout: int = field(
        default_factory=lambda: _env_int("BACKFILL_FETCH_TIMEOUT", 0),
    )
    # Maximum total bars to fetch in a single backfill run (safety limit)
    fetch_max_total_bars: int = field(
        default_factory=lambda: _env_int("BACKFILL_FETCH_MAX_TOTAL_BARS", 100_000),
    )

    # ── Reconciler ───────────────────────────────────────────
    # Deduplication strategy when writing to storage:
    #   "skip"          — skip rows that already exist in DB
    #   "overwrite"     — always overwrite existing rows
    #   "backfill_wins" — replace existing rows with fetched repair data
    #   "newer_wins"    — legacy alias for "backfill_wins"
    reconcile_dedup_strategy: str = field(
        default_factory=lambda: _env_str("BACKFILL_RECONCILE_DEDUP_STRATEGY", "overwrite"),
    )
    # Batch size for DB writes (rows per transaction)
    reconcile_write_batch_size: int = field(
        default_factory=lambda: _env_int("BACKFILL_RECONCILE_WRITE_BATCH_SIZE", 500),
    )
    # Whether to generate aggregated candles for custom intervals
    reconcile_generate_custom: bool = field(
        default_factory=lambda: _env_bool("BACKFILL_RECONCILE_GENERATE_CUSTOM", True),
    )
    # Whether to push recent data into cache after reconciliation
    reconcile_enable_cache_push: bool = field(
        default_factory=lambda: _env_bool("BACKFILL_RECONCILE_ENABLE_CACHE_PUSH", True),
    )
    # Time window (ms) — only bars newer than now - window are pushed to cache
    reconcile_cache_window_ms: int = field(
        default_factory=lambda: _env_int(
            "BACKFILL_RECONCILE_CACHE_WINDOW_MS", 24 * 3600 * 1000,
        ),
    )

    # ── Repair Publisher ─────────────────────────────────────
    # Publishing mode: "callback", "log", "both"
    publish_mode: str = field(
        default_factory=lambda: _env_str("BACKFILL_PUBLISH_MODE", "both"),
    )
    # Include a data preview in the repair report
    publish_include_data_preview: bool = field(
        default_factory=lambda: _env_bool("BACKFILL_PUBLISH_INCLUDE_PREVIEW", False),
    )
    # Max rows in the preview section
    publish_max_preview_rows: int = field(
        default_factory=lambda: _env_int("BACKFILL_PUBLISH_MAX_PREVIEW_ROWS", 10),
    )

    # ── General ──────────────────────────────────────────────
    # Exchange identifier (must match ingestion config)
    exchange: str = field(
        default_factory=lambda: _env_str("BACKFILL_EXCHANGE", "binance"),
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
