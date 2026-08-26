"""
CandleScope global configuration.
"""

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from dotenv import load_dotenv

_ENVIRONMENT_KEYS_BEFORE_DOTENV = frozenset(os.environ)
load_dotenv()
_DOTENV_ADDED_VALUES = {
    key: os.environ[key]
    for key in os.environ.keys() - _ENVIRONMENT_KEYS_BEFORE_DOTENV
}
_DOTENV_PROXY_VALUES = {
    key: _DOTENV_ADDED_VALUES[key]
    for key in (
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "https_proxy",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    )
    if key in _DOTENV_ADDED_VALUES
}

logger = logging.getLogger("candlescope.config")


_REPLAY_TRUE_VALUES = {"1", "true", "yes", "on"}
_REPLAY_FALSE_VALUES = {"0", "false", "no", "off"}
_MULTI_CHART_TRUE_VALUES = {"1", "true", "yes", "on"}
_MULTI_CHART_FALSE_VALUES = {"0", "false", "no", "off"}
_REPLAY_BUDGETS: dict[str, int] = {
    "REPLAY_MAX_ACTIVE_SESSIONS": 8,
    "REPLAY_COMMAND_QUEUE_SIZE": 256,
    "REPLAY_EVENT_BUFFER_SIZE": 10_000,
    "REPLAY_MAX_EMIT_FPS": 30,
    "REPLAY_MAX_WARMUP_BARS": 5_000,
    "REPLAY_MAX_BAR_DATASET_ROWS": 100_000,
    "REPLAY_MAX_HORIZON_DAYS": 30,
    "REPLAY_TRADE_PAGE_ROWS": 50_000,
    "REPLAY_CHECKPOINT_EVENT_INTERVAL": 10_000,
    "REPLAY_CHECKPOINT_VIRTUAL_MS": 300_000,
    "REPLAY_EVENT_SUBSCRIBER_QUEUE": 256,
    "REPLAY_CONTROLLER_TTL_SECONDS": 10,
    "REPLAY_IDLE_TTL_SECONDS": 3_600,
    "REPLAY_SEGMENT_MAX_ARCHIVE_BYTES": 1_099_511_627_776,
    "REPLAY_HISTORICAL_BOOK_MAX_ARCHIVE_BYTES": 1_099_511_627_776,
    "REPLAY_ACCOUNT_HISTORY_MAX_ARCHIVE_BYTES": 137_438_953_472,
}
_BACKTEST_BUDGETS: dict[str, int] = {
    "BACKTEST_MAX_ACTIVE_RUNS": 4,
    "BACKTEST_MAX_CONCURRENT_STUDIES": 1,
    "BACKTEST_MAX_TRIALS_PER_STUDY": 64,
    "BACKTEST_MAX_BAR_ROWS": 200_000,
    "BACKTEST_MAX_TRADE_EVENTS": 2_000_000,
    "BACKTEST_MAX_WARMUP_BARS": 5_000,
    "BACKTEST_MAX_HORIZON_DAYS": 365,
    "BACKTEST_CHECKPOINT_EVENT_INTERVAL": 10_000,
    "BACKTEST_PROVIDER_STEP_TIMEOUT_MS": 2_000,
    "BACKTEST_MAX_PROVIDER_STATE_BYTES": 8_388_608,
    "BACKTEST_MAX_REPORT_BYTES": 16_777_216,
    "BACKTEST_WORKER_MEMORY_MB": 2_048,
    "BACKTEST_MAX_RUN_SECONDS": 14_400,
}


@dataclass(frozen=True, slots=True)
class ReplaySettings:
    enabled: bool
    db_path: Path
    max_active_sessions: int
    command_queue_size: int
    event_buffer_size: int
    max_emit_fps: int
    max_warmup_bars: int
    max_bar_dataset_rows: int
    max_horizon_days: int
    trade_page_rows: int
    checkpoint_event_interval: int
    checkpoint_virtual_ms: int
    event_subscriber_queue: int
    controller_ttl_seconds: int
    idle_ttl_seconds: int
    replay_segment_download_worker_enabled: bool = False
    replay_segment_auto_gc_enabled: bool = False
    replay_segment_max_archive_bytes: int = 1_099_511_627_776
    replay_fast_forward_optimization_enabled: bool = False
    replay_historical_book_enabled: bool = False
    replay_historical_book_max_archive_bytes: int = 1_099_511_627_776
    replay_account_history_enabled: bool = False
    replay_account_history_max_archive_bytes: int = 137_438_953_472
    replay_history_archive_dir: Path = Path("data/replay-history")
    replay_history_origin_uri: str | None = None
    replay_history_catalog_refresh_seconds: int = 300
    replay_history_download_timeout_seconds: int = 60
    replay_agg_trade_enabled: bool = False
    replay_agg_trade_archive_dir: Path = Path("data/replay-agg-trades")
    replay_agg_trade_origin_uri: str | None = None


def _strict_replay_bool(
    environment: Mapping[str, str], name: str, default: str
) -> bool:
    raw_value = environment.get(name, default)
    normalized = raw_value.strip().lower()
    if normalized in _REPLAY_TRUE_VALUES:
        return True
    if normalized in _REPLAY_FALSE_VALUES:
        return False
    raise ValueError(f"{name} must be one of 0/1, false/true, no/yes, or off/on")


def _bounded_replay_int(environment: Mapping[str, str], name: str) -> int:
    safe_upper_bound = _REPLAY_BUDGETS[name]
    raw_value = environment.get(name, str(safe_upper_bound))
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < 1 or value > safe_upper_bound:
        raise ValueError(
            f"{name} must be between 1 and the frozen safety limit {safe_upper_bound}"
        )
    return value


def _strict_multi_chart_bool(name: str, default: str = "0") -> bool:
    normalized = os.getenv(name, default).strip().lower()
    if normalized in _MULTI_CHART_TRUE_VALUES:
        return True
    if normalized in _MULTI_CHART_FALSE_VALUES:
        return False
    raise ValueError(f"{name} must be one of 0/1, false/true, no/yes, or off/on")


def _bounded_multi_chart_int(name: str, default: int, frozen_max: int) -> int:
    """Read a positive capacity value that may only tighten a frozen limit."""
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < 1 or value > frozen_max:
        raise ValueError(
            f"{name} must be between 1 and the frozen safety limit {frozen_max}"
        )
    return value


def _paths_refer_to_same_file(left: Path, right: Path) -> bool:
    left_resolved = left.expanduser().resolve()
    right_resolved = right.expanduser().resolve()
    if left_resolved == right_resolved:
        return True
    if left_resolved.exists() and right_resolved.exists():
        return os.path.samefile(left_resolved, right_resolved)
    return False


def load_replay_settings(
    environment: Mapping[str, str],
    *,
    data_dir: Path,
    klines_db_path: Path,
) -> ReplaySettings:
    """Load strict, fail-closed replay limits from an environment mapping."""

    if "REPLAY_PRODUCT_V2_ENABLED" in environment:
        raise ValueError(
            "REPLAY_PRODUCT_V2_ENABLED was removed; REPLAY_ENABLED is the only replay product gate"
        )

    replay_db_path = Path(
        environment.get("REPLAY_DB_PATH", str(data_dir / "replay.db"))
    )
    if _paths_refer_to_same_file(replay_db_path, klines_db_path):
        raise ValueError("REPLAY_DB_PATH must not identify KLINES_DB_PATH")
    if "REPLAY_BAR_SOURCE" in environment:
        raise ValueError(
            "REPLAY_BAR_SOURCE was removed; BAR replay always uses the immutable archive"
        )
    replay_history_archive_dir = Path(
        environment.get(
            "REPLAY_HISTORY_ARCHIVE_DIR",
            str(data_dir / "replay-history"),
        )
    )
    if _paths_refer_to_same_file(replay_history_archive_dir, replay_db_path):
        raise ValueError("REPLAY_HISTORY_ARCHIVE_DIR must not identify REPLAY_DB_PATH")
    if _paths_refer_to_same_file(replay_history_archive_dir, klines_db_path):
        raise ValueError("REPLAY_HISTORY_ARCHIVE_DIR must not identify KLINES_DB_PATH")
    replay_history_origin_uri = (
        environment.get("REPLAY_HISTORY_ORIGIN_URI", "").strip() or None
    )
    try:
        replay_history_catalog_refresh_seconds = int(
            environment.get("REPLAY_HISTORY_CATALOG_REFRESH_SECONDS", "300")
        )
        replay_history_download_timeout_seconds = int(
            environment.get("REPLAY_HISTORY_DOWNLOAD_TIMEOUT_SECONDS", "60")
        )
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "replay-history refresh and download timeouts must be integers"
        ) from exc
    if not 0 <= replay_history_catalog_refresh_seconds <= 86_400:
        raise ValueError(
            "REPLAY_HISTORY_CATALOG_REFRESH_SECONDS must be between 0 and 86400"
        )
    if not 1 <= replay_history_download_timeout_seconds <= 3_600:
        raise ValueError(
            "REPLAY_HISTORY_DOWNLOAD_TIMEOUT_SECONDS must be between 1 and 3600"
        )
    replay_agg_trade_archive_dir = Path(
        environment.get(
            "REPLAY_AGG_TRADE_ARCHIVE_DIR",
            str(data_dir / "replay-agg-trades"),
        )
    )
    replay_agg_trade_origin_uri = (
        environment.get("REPLAY_AGG_TRADE_ORIGIN_URI", "").strip() or None
    )
    live_agg_trade_archive_dir = Path(
        environment.get(
            "RAW_AGG_TRADE_ARCHIVE_DIR",
            str(data_dir / "raw-agg-live-spool"),
        )
    )
    if _paths_refer_to_same_file(
        replay_agg_trade_archive_dir,
        replay_db_path,
    ):
        raise ValueError(
            "REPLAY_AGG_TRADE_ARCHIVE_DIR must not identify REPLAY_DB_PATH"
        )
    if _paths_refer_to_same_file(
        replay_agg_trade_archive_dir,
        klines_db_path,
    ):
        raise ValueError(
            "REPLAY_AGG_TRADE_ARCHIVE_DIR must not identify KLINES_DB_PATH"
        )
    if _paths_refer_to_same_file(
        replay_agg_trade_archive_dir,
        replay_history_archive_dir,
    ):
        raise ValueError(
            "REPLAY_AGG_TRADE_ARCHIVE_DIR must not identify REPLAY_HISTORY_ARCHIVE_DIR"
        )
    if _paths_refer_to_same_file(
        replay_agg_trade_archive_dir,
        live_agg_trade_archive_dir,
    ):
        raise ValueError(
            "REPLAY_AGG_TRADE_ARCHIVE_DIR must not identify RAW_AGG_TRADE_ARCHIVE_DIR"
        )
    values = {name: _bounded_replay_int(environment, name) for name in _REPLAY_BUDGETS}
    return ReplaySettings(
        enabled=_strict_replay_bool(environment, "REPLAY_ENABLED", "1"),
        db_path=replay_db_path,
        max_active_sessions=values["REPLAY_MAX_ACTIVE_SESSIONS"],
        command_queue_size=values["REPLAY_COMMAND_QUEUE_SIZE"],
        event_buffer_size=values["REPLAY_EVENT_BUFFER_SIZE"],
        max_emit_fps=values["REPLAY_MAX_EMIT_FPS"],
        max_warmup_bars=values["REPLAY_MAX_WARMUP_BARS"],
        max_bar_dataset_rows=values["REPLAY_MAX_BAR_DATASET_ROWS"],
        max_horizon_days=values["REPLAY_MAX_HORIZON_DAYS"],
        trade_page_rows=values["REPLAY_TRADE_PAGE_ROWS"],
        checkpoint_event_interval=values["REPLAY_CHECKPOINT_EVENT_INTERVAL"],
        checkpoint_virtual_ms=values["REPLAY_CHECKPOINT_VIRTUAL_MS"],
        event_subscriber_queue=values["REPLAY_EVENT_SUBSCRIBER_QUEUE"],
        controller_ttl_seconds=values["REPLAY_CONTROLLER_TTL_SECONDS"],
        idle_ttl_seconds=values["REPLAY_IDLE_TTL_SECONDS"],
        replay_segment_download_worker_enabled=_strict_replay_bool(
            environment, "REPLAY_SEGMENT_DOWNLOAD_WORKER_ENABLED", "0"
        ),
        replay_segment_auto_gc_enabled=_strict_replay_bool(
            environment, "REPLAY_SEGMENT_AUTO_GC_ENABLED", "0"
        ),
        replay_segment_max_archive_bytes=values["REPLAY_SEGMENT_MAX_ARCHIVE_BYTES"],
        replay_fast_forward_optimization_enabled=_strict_replay_bool(
            environment, "REPLAY_FAST_FORWARD_OPTIMIZATION_ENABLED", "0"
        ),
        replay_historical_book_enabled=_strict_replay_bool(
            environment, "REPLAY_HISTORICAL_BOOK_ENABLED", "1"
        ),
        replay_historical_book_max_archive_bytes=values[
            "REPLAY_HISTORICAL_BOOK_MAX_ARCHIVE_BYTES"
        ],
        replay_account_history_enabled=_strict_replay_bool(
            environment, "REPLAY_ACCOUNT_HISTORY_ENABLED", "1"
        ),
        replay_account_history_max_archive_bytes=values[
            "REPLAY_ACCOUNT_HISTORY_MAX_ARCHIVE_BYTES"
        ],
        replay_history_archive_dir=replay_history_archive_dir,
        replay_history_origin_uri=replay_history_origin_uri,
        replay_history_catalog_refresh_seconds=(replay_history_catalog_refresh_seconds),
        replay_history_download_timeout_seconds=(
            replay_history_download_timeout_seconds
        ),
        replay_agg_trade_enabled=_strict_replay_bool(
            environment, "REPLAY_AGG_TRADE_ENABLED", "0"
        ),
        replay_agg_trade_archive_dir=replay_agg_trade_archive_dir,
        replay_agg_trade_origin_uri=replay_agg_trade_origin_uri,
    )


@dataclass(frozen=True, slots=True)
class BacktestSettings:
    enabled: bool
    bar_enabled: bool
    chart_context_enabled: bool
    trade_explanation_enabled: bool
    trade_tape_enabled: bool
    book_assisted_enabled: bool
    study_enabled: bool
    external_provider_enabled: bool
    online_learning_enabled: bool
    multi_market_enabled: bool
    replay_review_bridge_enabled: bool
    python_scale_v1_enabled: bool
    db_path: Path
    max_active_runs: int
    max_concurrent_studies: int
    max_trials_per_study: int
    max_bar_rows: int
    max_trade_events: int
    max_warmup_bars: int
    max_horizon_days: int
    checkpoint_event_interval: int
    provider_step_timeout_ms: int
    max_provider_state_bytes: int
    max_report_bytes: int
    worker_memory_mb: int
    max_run_seconds: int

    @property
    def bar_effective(self) -> bool:
        return self.enabled and self.bar_enabled

    @property
    def chart_context_effective(self) -> bool:
        return self.enabled and self.chart_context_enabled

    @property
    def trade_explanation_effective(self) -> bool:
        return self.enabled and self.trade_explanation_enabled

    @property
    def trade_tape_effective(self) -> bool:
        return self.enabled and self.trade_tape_enabled

    @property
    def book_assisted_effective(self) -> bool:
        return self.enabled and self.book_assisted_enabled


def _bounded_backtest_int(
    environment: Mapping[str, str],
    name: str,
    *,
    hard_ceiling: int | None = None,
) -> int:
    default = _BACKTEST_BUDGETS[name]
    safe_upper_bound = default if hard_ceiling is None else int(hard_ceiling)
    raw_value = environment.get(name, str(default))
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < 1 or value > safe_upper_bound:
        raise ValueError(
            f"{name} must be between 1 and the frozen safety limit {safe_upper_bound}"
        )
    return value


def load_backtest_settings(
    environment: Mapping[str, str],
    *,
    data_dir: Path,
    klines_db_path: Path,
    replay_db_path: Path,
) -> BacktestSettings:
    """Load backtest flags and fail-closed ceilings.

    The validated chart-first BAR workflow defaults on. Higher-fidelity,
    external-provider, online-learning, and trusted-Python gates remain off.
    """

    backtest_db_path = Path(
        environment.get("BACKTEST_DB_PATH", str(data_dir / "backtest.db"))
    )
    if _paths_refer_to_same_file(backtest_db_path, klines_db_path):
        raise ValueError("BACKTEST_DB_PATH must not identify KLINES_DB_PATH")
    if _paths_refer_to_same_file(backtest_db_path, replay_db_path):
        raise ValueError("BACKTEST_DB_PATH must not identify REPLAY_DB_PATH")
    from app.backtest.strategy.python_scale import bar_row_hard_ceiling

    values = {}
    for name in _BACKTEST_BUDGETS:
        hard = (
            bar_row_hard_ceiling(environment)
            if name == "BACKTEST_MAX_BAR_ROWS"
            else None
        )
        values[name] = _bounded_backtest_int(environment, name, hard_ceiling=hard)
    return BacktestSettings(
        enabled=_strict_replay_bool(environment, "BACKTEST_ENABLED", "1"),
        bar_enabled=_strict_replay_bool(environment, "BACKTEST_BAR_ENABLED", "1"),
        chart_context_enabled=_strict_replay_bool(
            environment, "BACKTEST_CHART_CONTEXT_ENABLED", "1"
        ),
        trade_explanation_enabled=_strict_replay_bool(
            environment, "BACKTEST_TRADE_EXPLANATION_ENABLED", "0"
        ),
        trade_tape_enabled=_strict_replay_bool(
            environment, "BACKTEST_TRADE_TAPE_ENABLED", "0"
        ),
        book_assisted_enabled=_strict_replay_bool(
            environment, "BACKTEST_BOOK_ASSISTED_ENABLED", "0"
        ),
        study_enabled=_strict_replay_bool(environment, "BACKTEST_STUDY_ENABLED", "1"),
        external_provider_enabled=_strict_replay_bool(
            environment, "BACKTEST_EXTERNAL_PROVIDER_ENABLED", "0"
        ),
        online_learning_enabled=_strict_replay_bool(
            environment, "BACKTEST_ONLINE_LEARNING_ENABLED", "0"
        ),
        multi_market_enabled=_strict_replay_bool(
            environment, "BACKTEST_MULTI_MARKET_ENABLED", "0"
        ),
        replay_review_bridge_enabled=_strict_replay_bool(
            environment, "BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED", "1"
        ),
        python_scale_v1_enabled=_strict_replay_bool(
            environment, "BACKTEST_PYTHON_SCALE_V1_ENABLED", "0"
        ),
        db_path=backtest_db_path,
        max_active_runs=values["BACKTEST_MAX_ACTIVE_RUNS"],
        max_concurrent_studies=values["BACKTEST_MAX_CONCURRENT_STUDIES"],
        max_trials_per_study=values["BACKTEST_MAX_TRIALS_PER_STUDY"],
        max_bar_rows=values["BACKTEST_MAX_BAR_ROWS"],
        max_trade_events=values["BACKTEST_MAX_TRADE_EVENTS"],
        max_warmup_bars=values["BACKTEST_MAX_WARMUP_BARS"],
        max_horizon_days=values["BACKTEST_MAX_HORIZON_DAYS"],
        checkpoint_event_interval=values["BACKTEST_CHECKPOINT_EVENT_INTERVAL"],
        provider_step_timeout_ms=values["BACKTEST_PROVIDER_STEP_TIMEOUT_MS"],
        max_provider_state_bytes=values["BACKTEST_MAX_PROVIDER_STATE_BYTES"],
        max_report_bytes=values["BACKTEST_MAX_REPORT_BYTES"],
        worker_memory_mb=values["BACKTEST_WORKER_MEMORY_MB"],
        max_run_seconds=values["BACKTEST_MAX_RUN_SECONDS"],
    )


# Runtime profile. LOCAL_OFFLINE is a process-wide data boundary, not a
# page-level toggle. Backtest research uses a later LOCAL_RESEARCH profile.
RUNTIME_MODE = os.getenv("CANDLESCOPE_RUNTIME_MODE", "LIVE").strip().upper()
if RUNTIME_MODE not in {"LIVE", "LOCAL_OFFLINE"}:
    raise ValueError("CANDLESCOPE_RUNTIME_MODE must be either LIVE or LOCAL_OFFLINE")

# Server
HOST = (
    "127.0.0.1"
    if RUNTIME_MODE == "LOCAL_OFFLINE"
    else os.getenv("CANDLE_HOST", "0.0.0.0")
)
PORT = int(os.getenv("CANDLE_PORT", "8000"))

# Paths
BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("CANDLE_DATA_DIR", BASE_DIR / "data"))
KLINES_DB_PATH = Path(os.getenv("KLINES_DB_PATH", DATA_DIR / "candlescope.db"))
LOCAL_DATA_DIR = Path(os.getenv("CANDLESCOPE_LOCAL_DATA_DIR", DATA_DIR / "local-data"))


def _parse_strict_flag(name: str, default: str = "0") -> bool:
    raw = os.getenv(name, default).strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off", ""}:
        return False
    raise ValueError(f"{name} must be 0 or 1")


RESEARCH_DATA_LIBRARY_ENABLED = _parse_strict_flag(
    "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED",
    "1",
)
LOCAL_DATA_MAX_UPLOAD_BYTES = int(
    os.getenv("CANDLESCOPE_LOCAL_DATA_MAX_UPLOAD_BYTES", str(512 * 1024**2))
)
if LOCAL_DATA_MAX_UPLOAD_BYTES < 1:
    raise ValueError("CANDLESCOPE_LOCAL_DATA_MAX_UPLOAD_BYTES must be positive")
HISTORY_ARCHIVE_ENABLED = os.getenv("HISTORY_ARCHIVE_ENABLED", "1").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
HISTORY_ARCHIVE_CACHE_DIR = Path(
    os.getenv("HISTORY_ARCHIVE_CACHE_DIR", DATA_DIR / "history_archives")
)
HISTORY_ARCHIVE_CACHE_MAX_BYTES = int(
    os.getenv("HISTORY_ARCHIVE_CACHE_MAX_BYTES", str(10 * 1024**3))
)
OKX_HISTORY_ARCHIVE_ENABLED = os.getenv(
    "OKX_HISTORY_ARCHIVE_ENABLED", "0"
).strip().lower() in {"1", "true", "yes", "on"}

# Replay is a default-on product and owns a database separate from K-lines.
# These limits are frozen Phase 0 safety ceilings; environment overrides may
# tighten them, but cannot silently widen them without a reviewed code change.
REPLAY_SETTINGS = load_replay_settings(
    os.environ,
    data_dir=DATA_DIR,
    klines_db_path=KLINES_DB_PATH,
)
REPLAY_ENABLED = REPLAY_SETTINGS.enabled
REPLAY_SEGMENT_DOWNLOAD_WORKER_ENABLED = (
    REPLAY_SETTINGS.replay_segment_download_worker_enabled
)
REPLAY_SEGMENT_AUTO_GC_ENABLED = REPLAY_SETTINGS.replay_segment_auto_gc_enabled
REPLAY_SEGMENT_MAX_ARCHIVE_BYTES = REPLAY_SETTINGS.replay_segment_max_archive_bytes
REPLAY_FAST_FORWARD_OPTIMIZATION_ENABLED = (
    REPLAY_SETTINGS.replay_fast_forward_optimization_enabled
)
REPLAY_HISTORICAL_BOOK_ENABLED = REPLAY_SETTINGS.replay_historical_book_enabled
REPLAY_HISTORICAL_BOOK_MAX_ARCHIVE_BYTES = (
    REPLAY_SETTINGS.replay_historical_book_max_archive_bytes
)
REPLAY_ACCOUNT_HISTORY_ENABLED = REPLAY_SETTINGS.replay_account_history_enabled
REPLAY_ACCOUNT_HISTORY_MAX_ARCHIVE_BYTES = (
    REPLAY_SETTINGS.replay_account_history_max_archive_bytes
)
REPLAY_HISTORY_ARCHIVE_DIR = REPLAY_SETTINGS.replay_history_archive_dir
REPLAY_AGG_TRADE_ENABLED = REPLAY_SETTINGS.replay_agg_trade_enabled
REPLAY_AGG_TRADE_ARCHIVE_DIR = REPLAY_SETTINGS.replay_agg_trade_archive_dir
REPLAY_DB_PATH = REPLAY_SETTINGS.db_path
REPLAY_MAX_ACTIVE_SESSIONS = REPLAY_SETTINGS.max_active_sessions
REPLAY_COMMAND_QUEUE_SIZE = REPLAY_SETTINGS.command_queue_size
REPLAY_EVENT_BUFFER_SIZE = REPLAY_SETTINGS.event_buffer_size
REPLAY_MAX_EMIT_FPS = REPLAY_SETTINGS.max_emit_fps
REPLAY_MAX_WARMUP_BARS = REPLAY_SETTINGS.max_warmup_bars
REPLAY_MAX_BAR_DATASET_ROWS = REPLAY_SETTINGS.max_bar_dataset_rows
REPLAY_MAX_HORIZON_DAYS = REPLAY_SETTINGS.max_horizon_days
REPLAY_TRADE_PAGE_ROWS = REPLAY_SETTINGS.trade_page_rows
REPLAY_CHECKPOINT_EVENT_INTERVAL = REPLAY_SETTINGS.checkpoint_event_interval
REPLAY_CHECKPOINT_VIRTUAL_MS = REPLAY_SETTINGS.checkpoint_virtual_ms
REPLAY_EVENT_SUBSCRIBER_QUEUE = REPLAY_SETTINGS.event_subscriber_queue
REPLAY_CONTROLLER_TTL_SECONDS = REPLAY_SETTINGS.controller_ttl_seconds
REPLAY_IDLE_TTL_SECONDS = REPLAY_SETTINGS.idle_ttl_seconds

# Backtest is a default-on research product and owns a database separate from
# K-lines and replay. Environment overrides may still disable capabilities or
# tighten the frozen resource ceilings for rollback and constrained hosts.
BACKTEST_SETTINGS = load_backtest_settings(
    os.environ,
    data_dir=DATA_DIR,
    klines_db_path=KLINES_DB_PATH,
    replay_db_path=REPLAY_DB_PATH,
)
BACKTEST_ENABLED = BACKTEST_SETTINGS.enabled
BACKTEST_DB_PATH = BACKTEST_SETTINGS.db_path

# TradeFlow is storage-backend neutral at the service boundary.  SQLite is the
# first rollup implementation; raw aggregate-trade Parquet is opt-in because it
# is intended for deterministic research/replay rather than normal chart use.
TRADE_FLOW_ROLLUP_BACKEND = (
    os.getenv("TRADE_FLOW_ROLLUP_BACKEND", "sqlite").strip().lower()
)
TRADE_FLOW_DB_PATH = Path(os.getenv("TRADE_FLOW_DB_PATH", KLINES_DB_PATH))
TRADE_FLOW_RAW_RING_SIZE = int(os.getenv("TRADE_FLOW_RAW_RING_SIZE", "20000"))
TRADE_FLOW_MAX_STREAMS = int(os.getenv("TRADE_FLOW_MAX_STREAMS", "64"))
TRADE_FLOW_EVENT_QUEUE_SIZE = int(os.getenv("TRADE_FLOW_EVENT_QUEUE_SIZE", "20000"))
TRADE_FLOW_BATCH_INTERVAL_SECONDS = float(
    os.getenv("TRADE_FLOW_BATCH_INTERVAL_SECONDS", "0.05")
)
TRADE_FLOW_MAX_BATCH_SIZE = int(os.getenv("TRADE_FLOW_MAX_BATCH_SIZE", "1000"))
TRADE_FLOW_GAP_REPAIR_MAX_TRADES = int(
    os.getenv("TRADE_FLOW_GAP_REPAIR_MAX_TRADES", "20000")
)
RAW_AGG_TRADE_ARCHIVE_ENABLED = os.getenv(
    "RAW_AGG_TRADE_ARCHIVE_ENABLED", "0"
).strip().lower() in {"1", "true", "yes", "on"}
RAW_AGG_TRADE_ARCHIVE_BACKEND = (
    os.getenv("RAW_AGG_TRADE_ARCHIVE_BACKEND", "parquet").strip().lower()
)
RAW_AGG_TRADE_ARCHIVE_DIR = Path(
    os.getenv("RAW_AGG_TRADE_ARCHIVE_DIR", DATA_DIR / "raw-agg-live-spool")
)
# Optional comma-separated ``exchange:market_type:symbol`` identities.  When
# empty, archival follows ordinary TradeFlow leases; configured identities are
# held by a runtime lease so replay capture does not depend on an open browser.
RAW_AGG_TRADE_ARCHIVE_STREAMS = tuple(
    item.strip()
    for item in os.getenv("RAW_AGG_TRADE_ARCHIVE_STREAMS", "").split(",")
    if item.strip()
)
RAW_AGG_TRADE_ARCHIVE_FLUSH_SECONDS = float(
    os.getenv("RAW_AGG_TRADE_ARCHIVE_FLUSH_SECONDS", "1.0")
)
RAW_AGG_TRADE_ARCHIVE_MAX_PENDING_BATCHES = int(
    os.getenv("RAW_AGG_TRADE_ARCHIVE_MAX_PENDING_BATCHES", "16")
)
RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH = int(
    os.getenv("RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH", "10000")
)
RAW_AGG_TRADE_ARCHIVE_TARGET_FILE_ROWS = int(
    os.getenv(
        "RAW_AGG_TRADE_ARCHIVE_TARGET_FILE_ROWS",
        str(RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH),
    )
)
RAW_AGG_TRADE_ARCHIVE_MAX_BUFFER_SECONDS = float(
    os.getenv("RAW_AGG_TRADE_ARCHIVE_MAX_BUFFER_SECONDS", "300")
)
RAW_AGG_TRADE_ARCHIVE_COMPACT_EVERY_BATCHES = int(
    os.getenv("RAW_AGG_TRADE_ARCHIVE_COMPACT_EVERY_BATCHES", "64")
)

# Public liquidation snapshots are lossy at the exchange boundary, but the
# observations we do receive are append-only and worth retaining as one-minute
# directional rollups.  Keep this backend selection independent so a future
# DuckDB implementation does not leak into the service or API contracts.
LIQUIDATION_ROLLUP_BACKEND = (
    os.getenv("LIQUIDATION_ROLLUP_BACKEND", "sqlite").strip().lower()
)
LIQUIDATION_DB_PATH = Path(os.getenv("LIQUIDATION_DB_PATH", KLINES_DB_PATH))
LIQUIDATION_RAW_RING_SIZE = int(os.getenv("LIQUIDATION_RAW_RING_SIZE", "5000"))
LIQUIDATION_MAX_STREAMS = int(os.getenv("LIQUIDATION_MAX_STREAMS", "64"))
LIQUIDATION_EVENT_QUEUE_SIZE = int(os.getenv("LIQUIDATION_EVENT_QUEUE_SIZE", "8192"))
LIQUIDATION_BATCH_INTERVAL_SECONDS = float(
    os.getenv("LIQUIDATION_BATCH_INTERVAL_SECONDS", "0.1")
)
LIQUIDATION_MAX_BATCH_SIZE = int(os.getenv("LIQUIDATION_MAX_BATCH_SIZE", "500"))
LIQUIDATION_FINALIZE_INTERVAL_SECONDS = float(
    os.getenv("LIQUIDATION_FINALIZE_INTERVAL_SECONDS", "1.0")
)
# Optional comma-separated ``exchange:market_type:symbol`` identities.  These
# runtime-held leases make local history capture independent of an open browser.
LIQUIDATION_CAPTURE_STREAMS = tuple(
    item.strip()
    for item in os.getenv("LIQUIDATION_CAPTURE_STREAMS", "").split(",")
    if item.strip()
)

# Partial Top-N order books are replaceable process-local snapshots.  They do
# not share append-only persistence settings because raw depth is deliberately
# not archived in P3A.
ORDER_BOOK_MAX_STREAMS = int(os.getenv("ORDER_BOOK_MAX_STREAMS", "64"))
ORDER_BOOK_EVENT_QUEUE_SIZE = int(os.getenv("ORDER_BOOK_EVENT_QUEUE_SIZE", "256"))
ORDER_BOOK_DEFAULT_MAX_PENDING = int(os.getenv("ORDER_BOOK_DEFAULT_MAX_PENDING", "32"))
ORDER_BOOK_MAX_SNAPSHOT_AGE_MS = int(
    os.getenv("ORDER_BOOK_MAX_SNAPSHOT_AGE_MS", "5000")
)
ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS = float(
    # The ingestion transport owns an inner two-second WebSocket close bound.
    # Keep the service-level budget above it so a graceful close at that bound
    # is not misclassified as an order-book lifecycle failure.
    os.getenv("ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS", "5.0")
)

# Full Order Books are rebuilt from a REST seed plus every ordered diff-depth
# event.  They deliberately have separate, tighter stream limits and explicit
# per-stream queue/book bounds.  The local book retains the best known levels
# inside this explicit window; exhausting the REST seed's trusted depth still
# invalidates the book and triggers resynchronization.
FULL_ORDER_BOOK_MAX_STREAMS = int(os.getenv("FULL_ORDER_BOOK_MAX_STREAMS", "16"))
FULL_ORDER_BOOK_UPSTREAM_QUEUE_SIZE = int(
    os.getenv("FULL_ORDER_BOOK_UPSTREAM_QUEUE_SIZE", "4096")
)
FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE = int(
    os.getenv("FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE", "5000")
)
FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA = int(
    os.getenv("FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA", "10000")
)
FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES = int(
    os.getenv("FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES", "200000")
)
FULL_ORDER_BOOK_DEFAULT_MAX_PENDING = int(
    os.getenv("FULL_ORDER_BOOK_DEFAULT_MAX_PENDING", "16")
)
FULL_ORDER_BOOK_SNAPSHOT_TIMEOUT_SECONDS = float(
    os.getenv("FULL_ORDER_BOOK_SNAPSHOT_TIMEOUT_SECONDS", "5.0")
)
FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS = float(
    os.getenv("FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS", "0.1")
)
FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS = float(
    os.getenv("FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS", "5.0")
)
FULL_ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS = float(
    os.getenv("FULL_ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS", "5.0")
)

# Binance HTTP APIs
BINANCE_BASE_URLS = [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api.binance.me",
]
BINANCE_BASE_URL = os.getenv("BINANCE_BASE_URL", "https://api.binance.me")

# Binance WebSocket
BINANCE_WS_URL = os.getenv("BINANCE_WS_URL", "wss://stream.binance.com:9443/ws")
BINANCE_WS_URLS = [
    BINANCE_WS_URL,
    "wss://data-stream.binance.vision/ws",
    "wss://stream.binance.me:9443/ws",
]

# Binance Futures (USDT-M Perpetual) HTTP APIs
BINANCE_FUTURES_BASE_URL = os.getenv(
    "BINANCE_FUTURES_BASE_URL", "https://fapi.binance.com"
)
BINANCE_FUTURES_BASE_URLS = [
    "https://fapi.binance.com",
    "https://fapi.binance.me",
]

# Binance Futures WebSocket
BINANCE_FUTURES_WS_URL = os.getenv(
    "BINANCE_FUTURES_WS_URL", "wss://fstream.binance.com/ws"
)
BINANCE_FUTURES_WS_URLS = [
    BINANCE_FUTURES_WS_URL,
    "wss://fstream.binance.me/ws",
]

# Request tuning  (lower values = faster fallback when Binance is unreachable)
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "5"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "3"))
RATE_LIMIT_SLEEP = int(os.getenv("RATE_LIMIT_SLEEP", "60"))
SYMBOL_CATALOG_TTL_SECONDS = max(
    0.0,
    float(os.getenv("SYMBOL_CATALOG_TTL_SECONDS", "300")),
)
SYMBOL_CATALOG_FAILURE_RETRY_SECONDS = max(
    0.0,
    float(os.getenv("SYMBOL_CATALOG_FAILURE_RETRY_SECONDS", "30")),
)
SYMBOL_CATALOG_RETRY_JITTER_SECONDS = max(
    0.0,
    float(os.getenv("SYMBOL_CATALOG_RETRY_JITTER_SECONDS", "1")),
)
SYMBOL_CATALOG_EMPTY_WAIT_SECONDS = max(
    0.0,
    float(os.getenv("SYMBOL_CATALOG_EMPTY_WAIT_SECONDS", "1")),
)
SYMBOL_CATALOG_FOREGROUND_DWELL_SECONDS = max(
    0.0,
    float(os.getenv("SYMBOL_CATALOG_FOREGROUND_DWELL_SECONDS", "1")),
)
SYMBOL_CATALOG_FOREGROUND_RECHECK_SECONDS = max(
    0.05,
    float(os.getenv("SYMBOL_CATALOG_FOREGROUND_RECHECK_SECONDS", "0.25")),
)
SYMBOL_CATALOG_MIN_RETAIN_RATIO = min(
    1.0,
    max(0.0, float(os.getenv("SYMBOL_CATALOG_MIN_RETAIN_RATIO", "0.5"))),
)
SYMBOL_CATALOG_SNAPSHOT_PATH = Path(
    os.getenv(
        "SYMBOL_CATALOG_SNAPSHOT_PATH",
        DATA_DIR / "symbol_catalog.v1.json",
    )
)

# Pyne runtime safety. This is a local-first application, so advanced users can
# opt into broader Python capability, but the default stays conservative.
PYNE_SECURITY_MODE = os.getenv("PYNE_SECURITY_MODE", "safe").strip().lower()
if PYNE_SECURITY_MODE not in {"safe", "research", "unsafe"}:
    PYNE_SECURITY_MODE = "safe"
PYNE_EXEC_TIMEOUT_SECONDS = float(os.getenv("PYNE_EXEC_TIMEOUT_SECONDS", "5"))
PYNE_EXECUTOR_MODE = os.getenv("PYNE_EXECUTOR_MODE", "process").strip().lower()
if PYNE_EXECUTOR_MODE not in {"inline", "process"}:
    PYNE_EXECUTOR_MODE = "process"
PYNE_PROCESS_GRACE_SECONDS = float(os.getenv("PYNE_PROCESS_GRACE_SECONDS", "0.5"))
PYNE_MAX_BARS = int(os.getenv("PYNE_MAX_BARS", "50000"))
PYNE_TICK_RECOMPUTE_MAX_BARS = int(os.getenv("PYNE_TICK_RECOMPUTE_MAX_BARS", "5000"))
PYNE_MAX_OUTPUT_SERIES = int(os.getenv("PYNE_MAX_OUTPUT_SERIES", "20"))
PYNE_MAX_OUTPUT_POINTS = int(os.getenv("PYNE_MAX_OUTPUT_POINTS", "1000000"))
PYNE_CACHE_MAX_ITEMS = int(os.getenv("PYNE_CACHE_MAX_ITEMS", "32"))
PYNE_ALLOWED_IMPORTS = [
    item.strip()
    for item in os.getenv(
        "PYNE_ALLOWED_IMPORTS", "numpy,pandas,scipy,sklearn,torch"
    ).split(",")
    if item.strip()
]

# Indicator HTTP compute tuning. The API endpoint should only orchestrate work;
# heavy builtin/Pyne computation is offloaded so it cannot block the event loop.
INDICATOR_HTTP_TIMEOUT_SECONDS = float(os.getenv("INDICATOR_HTTP_TIMEOUT_SECONDS", "8"))
INDICATOR_THREAD_WORKERS = int(os.getenv("INDICATOR_THREAD_WORKERS", "2"))
PYNE_HTTP_THREAD_WORKERS = int(os.getenv("PYNE_HTTP_THREAD_WORKERS", "2"))
STORAGE_THREAD_WORKERS = int(os.getenv("STORAGE_THREAD_WORKERS", "4"))
# Backfill chunks perform SQLite projection and reconciliation in the same
# process as the async API. Keep the coordinator serialized by default so a
# 16-series repair burst cannot occupy every storage worker and starve control
# plane/WebSocket scheduling. Endpoint fetchers retain their own rate limits.
BACKFILL_COORDINATOR_MAX_CONCURRENCY = max(
    1,
    int(os.getenv("BACKFILL_COORDINATOR_MAX_CONCURRENCY", "1")),
)

# Indicator history reuse.  These caches only hold data derived from K-lines;
# they are deliberately bounded and can be disabled without changing API
# behaviour.
INDICATOR_RANGE_CACHE_ENABLED = os.getenv(
    "INDICATOR_RANGE_CACHE_ENABLED", "1"
).strip().lower() not in {"0", "false", "no", "off"}
INDICATOR_RANGE_CACHE_MAX_ENTRIES = int(
    os.getenv("INDICATOR_RANGE_CACHE_MAX_ENTRIES", "128")
)
INDICATOR_RANGE_CACHE_TTL_SECONDS = float(
    os.getenv("INDICATOR_RANGE_CACHE_TTL_SECONDS", "180")
)
INDICATOR_BARS_CACHE_MAX_ENTRIES = int(
    os.getenv("INDICATOR_BARS_CACHE_MAX_ENTRIES", "8")
)
INDICATOR_BARS_CACHE_TTL_SECONDS = float(
    os.getenv("INDICATOR_BARS_CACHE_TTL_SECONDS", "30")
)
INDICATOR_RANGE_BACKFILL_WAIT_SECONDS = float(
    os.getenv("INDICATOR_RANGE_BACKFILL_WAIT_SECONDS", "3")
)

# Keep unsubscribed builtin engines warm briefly so a quick interval switch can
# resume from the cached state instead of replaying the full seed history.
INDICATOR_ENGINE_WARM_TTL_SECONDS = float(
    os.getenv("INDICATOR_ENGINE_WARM_TTL_SECONDS", "120")
)
INDICATOR_ENGINE_WARM_MAX_INSTANCES = int(
    os.getenv("INDICATOR_ENGINE_WARM_MAX_INSTANCES", "64")
)

# Indicator WebSocket stability tuning.
INDICATOR_WS_MAX_SUBSCRIPTIONS = int(os.getenv("INDICATOR_WS_MAX_SUBSCRIPTIONS", "50"))
INDICATOR_WS_QUEUE_SIZE = int(os.getenv("INDICATOR_WS_QUEUE_SIZE", "1000"))
INDICATOR_WS_HEARTBEAT_SECONDS = float(
    os.getenv("INDICATOR_WS_HEARTBEAT_SECONDS", "15")
)
INDICATOR_WS_RESUME_MAX_BARS = int(os.getenv("INDICATOR_WS_RESUME_MAX_BARS", "32"))
INDICATOR_WS_SEED_CACHE_SECONDS = float(
    os.getenv("INDICATOR_WS_SEED_CACHE_SECONDS", "1")
)
WS_SEND_TIMEOUT_SECONDS = float(os.getenv("WS_SEND_TIMEOUT_SECONDS", "2"))
EVENT_LOOP_LAG_INTERVAL_SECONDS = float(
    os.getenv("EVENT_LOOP_LAG_INTERVAL_SECONDS", "0.01")
)

# Multi-chart K-line transport and process capacity.  These values are hard
# safety ceilings: environment configuration may tighten them, never expand
# them.  The additive batch endpoint stays disabled until a release gate turns
# it on explicitly; the legacy /stream/klines_multi endpoint remains intact.
KLINE_BATCH_STREAM_ENABLED = _strict_multi_chart_bool(
    "KLINE_BATCH_STREAM_ENABLED",
    "0",
)
KLINE_BATCH_MAX_SERIES_PER_CLIENT = _bounded_multi_chart_int(
    "KLINE_BATCH_MAX_SERIES_PER_CLIENT",
    64,
    64,
)
KLINE_BATCH_MAX_INTERVALS_PER_SERIES = _bounded_multi_chart_int(
    "KLINE_BATCH_MAX_INTERVALS_PER_SERIES",
    16,
    16,
)
KLINE_BATCH_MAX_TOTAL_SUBSCRIPTIONS = _bounded_multi_chart_int(
    "KLINE_BATCH_MAX_TOTAL_SUBSCRIPTIONS",
    128,
    128,
)
KLINE_BATCH_OUTBOX_SIZE = _bounded_multi_chart_int(
    "KLINE_BATCH_OUTBOX_SIZE",
    1024,
    2048,
)
KLINE_APP_MAX_ACTIVE_SERIES = _bounded_multi_chart_int(
    "KLINE_APP_MAX_ACTIVE_SERIES",
    128,
    128,
)
INDICATOR_APP_MAX_ACTIVE_TARGETS = _bounded_multi_chart_int(
    "INDICATOR_APP_MAX_ACTIVE_TARGETS",
    256,
    256,
)
KLINE_UPSTREAM_MAX_DESCRIPTORS_PER_SHARD = _bounded_multi_chart_int(
    "KLINE_UPSTREAM_MAX_DESCRIPTORS_PER_SHARD",
    32,
    64,
)

# CORS
CORS_ORIGINS = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://localhost:3000",
).split(",")


# ═══════════════════════════════════════════════════════════════
#  Proxy settings persistence
# ═══════════════════════════════════════════════════════════════

PROXY_SETTINGS_PATH = DATA_DIR / "proxy_settings.json"
_VALID_PROXY_MODES = {"system", "custom", "none"}


def normalize_proxy_settings(
    mode: str | None, custom_proxy: str | None
) -> tuple[str, str | None]:
    """Normalize proxy settings into a stable persisted/runtime shape."""
    normalized_mode = (mode or "system").strip().lower()
    if normalized_mode not in _VALID_PROXY_MODES:
        normalized_mode = "system"

    normalized_custom_proxy = (custom_proxy or "").strip() or None
    if normalized_mode != "custom":
        normalized_custom_proxy = None

    return normalized_mode, normalized_custom_proxy


def load_proxy_settings() -> dict:
    """Load persisted proxy settings from disk.

    Returns ``{"mode": "system", "custom_proxy": None}`` if no
    settings file exists or the file is corrupt.
    """
    if PROXY_SETTINGS_PATH.exists():
        try:
            with open(PROXY_SETTINGS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and "mode" in data:
                mode, custom_proxy = normalize_proxy_settings(
                    data.get("mode"),
                    data.get("custom_proxy"),
                )
                return {"mode": mode, "custom_proxy": custom_proxy}
        except Exception:
            logger.debug("Failed to load proxy settings from %s", PROXY_SETTINGS_PATH)
    return {"mode": "system", "custom_proxy": None}


def save_proxy_settings(mode: str, custom_proxy: str | None) -> None:
    """Persist proxy settings to disk so they survive restarts."""
    mode, custom_proxy = normalize_proxy_settings(mode, custom_proxy)
    PROXY_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(PROXY_SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump({"mode": mode, "custom_proxy": custom_proxy}, f)
    logger.info("Proxy settings saved: mode=%s", mode)


def _get_system_proxy() -> str | None:
    """Read proxy from environment variables, fallback to OS-level settings.

    On Windows, v2rayN / Clash etc. set the proxy in the registry
    (Internet Settings -> ProxyServer) rather than env vars.

    Note: ``urllib.request.getproxies()`` calls ``getproxies_environment()``
    first, and if that returns *any* entry (e.g. ``no_proxy``), it skips
    ``getproxies_registry()`` entirely.  We call ``getproxies_registry()``
    directly on Windows to avoid this short-circuit.
    """
    env_proxy = (
        os.getenv("HTTPS_PROXY")
        or _DOTENV_PROXY_VALUES.get("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or _DOTENV_PROXY_VALUES.get("HTTP_PROXY")
        or os.getenv("https_proxy")
        or _DOTENV_PROXY_VALUES.get("https_proxy")
        or os.getenv("http_proxy")
        or _DOTENV_PROXY_VALUES.get("http_proxy")
        or os.getenv("ALL_PROXY")
        or _DOTENV_PROXY_VALUES.get("ALL_PROXY")
        or os.getenv("all_proxy")
        or _DOTENV_PROXY_VALUES.get("all_proxy")
    )
    if env_proxy:
        return env_proxy

    import sys

    if sys.platform == "win32":
        from urllib.request import getproxies_registry

        proxies = getproxies_registry()
    else:
        from urllib.request import getproxies

        proxies = getproxies()
    return proxies.get("https") or proxies.get("http") or None


def get_effective_proxy() -> str | None:
    """Resolve the effective proxy URL from persisted settings + system.

    Used by modules that need proxy before IngestionConfig is created
    (e.g. ``load_exchange_info`` at startup).
    """
    settings = load_proxy_settings()
    mode, custom_proxy = normalize_proxy_settings(
        settings.get("mode"),
        settings.get("custom_proxy"),
    )

    if mode == "none":
        return None
    if mode == "custom":
        return custom_proxy if custom_proxy else None
    # mode == "system"
    return _get_system_proxy()


# python-dotenv is used here as a configuration source, not as a process-wide
# mutation. Remove only keys this module added; explicit caller variables and
# any concurrent changes are preserved. This keeps isolated release verifiers
# and child-process tests from inheriting unrelated product defaults.
for _name, _loaded_value in _DOTENV_ADDED_VALUES.items():
    if os.environ.get(_name) == _loaded_value:
        os.environ.pop(_name, None)
del _DOTENV_ADDED_VALUES, _ENVIRONMENT_KEYS_BEFORE_DOTENV
