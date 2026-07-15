"""
CandleScope global configuration.
"""
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("candlescope.config")

# Server
HOST = os.getenv("CANDLE_HOST", "0.0.0.0")
PORT = int(os.getenv("CANDLE_PORT", "8000"))

# Paths
BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("CANDLE_DATA_DIR", BASE_DIR / "data"))
KLINES_DB_PATH = Path(os.getenv("KLINES_DB_PATH", DATA_DIR / "candlescope.db"))

# TradeFlow is storage-backend neutral at the service boundary.  SQLite is the
# first rollup implementation; raw aggregate-trade Parquet is opt-in because it
# is intended for deterministic research/replay rather than normal chart use.
TRADE_FLOW_ROLLUP_BACKEND = os.getenv(
    "TRADE_FLOW_ROLLUP_BACKEND", "sqlite"
).strip().lower()
TRADE_FLOW_DB_PATH = Path(os.getenv("TRADE_FLOW_DB_PATH", KLINES_DB_PATH))
TRADE_FLOW_RAW_RING_SIZE = int(os.getenv("TRADE_FLOW_RAW_RING_SIZE", "20000"))
TRADE_FLOW_MAX_STREAMS = int(os.getenv("TRADE_FLOW_MAX_STREAMS", "64"))
TRADE_FLOW_EVENT_QUEUE_SIZE = int(
    os.getenv("TRADE_FLOW_EVENT_QUEUE_SIZE", "20000")
)
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
RAW_AGG_TRADE_ARCHIVE_BACKEND = os.getenv(
    "RAW_AGG_TRADE_ARCHIVE_BACKEND", "parquet"
).strip().lower()
RAW_AGG_TRADE_ARCHIVE_DIR = Path(
    os.getenv("RAW_AGG_TRADE_ARCHIVE_DIR", DATA_DIR / "raw_agg_trades")
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

# Public liquidation snapshots are lossy at the exchange boundary, but the
# observations we do receive are append-only and worth retaining as one-minute
# directional rollups.  Keep this backend selection independent so a future
# DuckDB implementation does not leak into the service or API contracts.
LIQUIDATION_ROLLUP_BACKEND = os.getenv(
    "LIQUIDATION_ROLLUP_BACKEND", "sqlite"
).strip().lower()
LIQUIDATION_DB_PATH = Path(os.getenv("LIQUIDATION_DB_PATH", KLINES_DB_PATH))
LIQUIDATION_RAW_RING_SIZE = int(os.getenv("LIQUIDATION_RAW_RING_SIZE", "5000"))
LIQUIDATION_MAX_STREAMS = int(os.getenv("LIQUIDATION_MAX_STREAMS", "64"))
LIQUIDATION_EVENT_QUEUE_SIZE = int(
    os.getenv("LIQUIDATION_EVENT_QUEUE_SIZE", "8192")
)
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
ORDER_BOOK_EVENT_QUEUE_SIZE = int(
    os.getenv("ORDER_BOOK_EVENT_QUEUE_SIZE", "256")
)
ORDER_BOOK_DEFAULT_MAX_PENDING = int(
    os.getenv("ORDER_BOOK_DEFAULT_MAX_PENDING", "32")
)
ORDER_BOOK_MAX_SNAPSHOT_AGE_MS = int(
    os.getenv("ORDER_BOOK_MAX_SNAPSHOT_AGE_MS", "5000")
)
ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS = float(
    os.getenv("ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS", "2.0")
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
BINANCE_FUTURES_BASE_URL = os.getenv("BINANCE_FUTURES_BASE_URL", "https://fapi.binance.com")
BINANCE_FUTURES_BASE_URLS = [
    "https://fapi.binance.com",
    "https://fapi.binance.me",
]

# Binance Futures WebSocket
BINANCE_FUTURES_WS_URL = os.getenv("BINANCE_FUTURES_WS_URL", "wss://fstream.binance.com/ws")
BINANCE_FUTURES_WS_URLS = [
    BINANCE_FUTURES_WS_URL,
    "wss://fstream.binance.me/ws",
]

# Request tuning  (lower values = faster fallback when Binance is unreachable)
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "5"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "3"))
RATE_LIMIT_SLEEP = int(os.getenv("RATE_LIMIT_SLEEP", "60"))

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
    for item in os.getenv("PYNE_ALLOWED_IMPORTS", "numpy,pandas,scipy,sklearn,torch").split(",")
    if item.strip()
]

# Indicator HTTP compute tuning. The API endpoint should only orchestrate work;
# heavy builtin/Pyne computation is offloaded so it cannot block the event loop.
INDICATOR_HTTP_TIMEOUT_SECONDS = float(os.getenv("INDICATOR_HTTP_TIMEOUT_SECONDS", "8"))
INDICATOR_THREAD_WORKERS = int(os.getenv("INDICATOR_THREAD_WORKERS", "2"))
PYNE_HTTP_THREAD_WORKERS = int(os.getenv("PYNE_HTTP_THREAD_WORKERS", "2"))
STORAGE_THREAD_WORKERS = int(os.getenv("STORAGE_THREAD_WORKERS", "4"))

# Indicator history reuse.  These caches only hold data derived from K-lines;
# they are deliberately bounded and can be disabled without changing API
# behaviour.
INDICATOR_RANGE_CACHE_ENABLED = os.getenv(
    "INDICATOR_RANGE_CACHE_ENABLED", "1"
).strip().lower() not in {"0", "false", "no", "off"}
INDICATOR_RANGE_CACHE_MAX_ENTRIES = int(os.getenv("INDICATOR_RANGE_CACHE_MAX_ENTRIES", "128"))
INDICATOR_RANGE_CACHE_TTL_SECONDS = float(os.getenv("INDICATOR_RANGE_CACHE_TTL_SECONDS", "180"))
INDICATOR_RANGE_BACKFILL_WAIT_SECONDS = float(os.getenv("INDICATOR_RANGE_BACKFILL_WAIT_SECONDS", "3"))

# Keep unsubscribed builtin engines warm briefly so a quick interval switch can
# resume from the cached state instead of replaying the full seed history.
INDICATOR_ENGINE_WARM_TTL_SECONDS = float(os.getenv("INDICATOR_ENGINE_WARM_TTL_SECONDS", "120"))
INDICATOR_ENGINE_WARM_MAX_INSTANCES = int(os.getenv("INDICATOR_ENGINE_WARM_MAX_INSTANCES", "64"))

# Indicator WebSocket stability tuning.
INDICATOR_WS_MAX_SUBSCRIPTIONS = int(os.getenv("INDICATOR_WS_MAX_SUBSCRIPTIONS", "50"))
INDICATOR_WS_QUEUE_SIZE = int(os.getenv("INDICATOR_WS_QUEUE_SIZE", "1000"))
INDICATOR_WS_HEARTBEAT_SECONDS = float(os.getenv("INDICATOR_WS_HEARTBEAT_SECONDS", "15"))
INDICATOR_WS_RESUME_MAX_BARS = int(os.getenv("INDICATOR_WS_RESUME_MAX_BARS", "32"))
INDICATOR_WS_SEED_CACHE_SECONDS = float(os.getenv("INDICATOR_WS_SEED_CACHE_SECONDS", "1"))
WS_SEND_TIMEOUT_SECONDS = float(os.getenv("WS_SEND_TIMEOUT_SECONDS", "2"))
EVENT_LOOP_LAG_INTERVAL_SECONDS = float(os.getenv("EVENT_LOOP_LAG_INTERVAL_SECONDS", "1"))

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


def normalize_proxy_settings(mode: str | None, custom_proxy: str | None) -> tuple[str, str | None]:
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
        or os.getenv("HTTP_PROXY")
        or os.getenv("https_proxy")
        or os.getenv("http_proxy")
        or os.getenv("ALL_PROXY")
        or os.getenv("all_proxy")
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
