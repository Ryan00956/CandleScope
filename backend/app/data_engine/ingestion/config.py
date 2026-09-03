"""
Ingestion Configuration — all tunable parameters for the Market Data Ingress pipeline.

Every parameter has a sensible default but can be overridden via:
  1. Constructor kwargs
  2. Environment variables (prefixed with INGESTION_)
  3. Runtime update via `update()` method

This is the single source of truth for the ingestion subsystem.
"""
from __future__ import annotations

from app.core.config import getenv as app_getenv

from dataclasses import dataclass, field


def _env_int(key: str, default: int) -> int:
    """Read an integer from environment variable, falling back to *default*."""
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


def _env_bool(key: str, default: bool) -> bool:
    raw = app_getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_str(key: str, default: str) -> str:
    return app_getenv(key, default)


def _env_str_list(key: str, default: list[str]) -> list[str]:
    raw = app_getenv(key)
    if raw is None:
        return list(default)
    return [s.strip() for s in raw.split(",") if s.strip()]


def _get_os_proxy() -> str | None:
    """Read proxy from OS-level settings (Windows registry, macOS scutil, etc.).

    On Windows, tools like v2rayN / Clash set the system proxy in the
    registry (Internet Settings → ProxyServer) rather than environment
    variables.

    Note: ``urllib.request.getproxies()`` short-circuits when
    ``getproxies_environment()`` returns *any* entry (e.g. ``no_proxy``),
    skipping ``getproxies_registry()`` entirely.  We call the registry
    reader directly on Windows to avoid this.
    """
    import sys
    if sys.platform == "win32":
        from urllib.request import getproxies_registry
        proxies = getproxies_registry()
    else:
        from urllib.request import getproxies
        proxies = getproxies()
    return proxies.get("https") or proxies.get("http") or None


def _load_persisted_proxy_mode() -> str:
    """Load proxy_mode from persisted settings (disk), fall back to env."""
    try:
        from app.core.config import load_proxy_settings
        settings = load_proxy_settings()
        return settings.get("mode", _env_str("INGESTION_PROXY_MODE", "system"))
    except Exception:
        return _env_str("INGESTION_PROXY_MODE", "system")


def _load_persisted_http_proxy() -> str | None:
    """Load http_proxy from persisted settings (disk), fall back to env/OS."""
    try:
        from app.core.config import load_proxy_settings
        settings = load_proxy_settings()
        mode = settings.get("mode", "system")
        custom_proxy = settings.get("custom_proxy")
        if mode == "none":
            return None
        if mode == "custom" and custom_proxy:
            return custom_proxy
        if mode == "system":
            return (
                app_getenv("HTTPS_PROXY")
                or app_getenv("HTTP_PROXY")
                or app_getenv("ALL_PROXY")
                or app_getenv("all_proxy")
                or _get_os_proxy()
                or None
            )
    except Exception:
        pass
    # Fall back to environment / OS proxy
    return (
        _env_str("INGESTION_HTTP_PROXY", "")
        or app_getenv("HTTPS_PROXY")
        or app_getenv("HTTP_PROXY")
        or app_getenv("ALL_PROXY")
        or app_getenv("all_proxy")
        or _get_os_proxy()
        or None
    )


@dataclass
class IngestionConfig:
    """Central configuration for the entire ingestion pipeline.

    Grouped by layer so it's easy to find what you're looking for.
    """

    # ── L1: Transport ──────────────────────────────────────────
    # HTTP endpoints (ordered by preference)
    http_base_urls: list[str] = field(default_factory=lambda: _env_str_list(
        "INGESTION_HTTP_BASE_URLS",
        [
            "https://api.binance.com",
            "https://api1.binance.com",
            "https://api2.binance.com",
            "https://api3.binance.com",
            "https://api.binance.me",
        ],
    ))
    # WebSocket endpoints (ordered by preference)
    ws_base_urls: list[str] = field(default_factory=lambda: _env_str_list(
        "INGESTION_WS_BASE_URLS",
        [
            "wss://stream.binance.com:9443/ws",
            "wss://data-stream.binance.vision/ws",
            "wss://stream.binance.me:9443/ws",
        ],
    ))
    # HTTP endpoints — Futures (USDT-M Perpetual)
    http_base_urls_futures: list[str] = field(default_factory=lambda: _env_str_list(
        "INGESTION_HTTP_BASE_URLS_FUTURES",
        [
            "https://fapi.binance.com",
            "https://fapi.binance.me",
        ],
    ))
    # WebSocket endpoints — Futures
    ws_base_urls_futures: list[str] = field(default_factory=lambda: _env_str_list(
        "INGESTION_WS_BASE_URLS_FUTURES",
        [
            "wss://fstream.binance.com/ws",
            "wss://fstream.binance.me/ws",
        ],
    ))
    # HTTP request timeout (seconds)
    http_timeout: int = field(default_factory=lambda: _env_int("INGESTION_HTTP_TIMEOUT", 8))
    # Twelve Data credentials remain server-side. REST uses Authorization;
    # the provider's WebSocket protocol requires the key in its connection
    # query string, which is built only inside the redacting sidecar runtime.
    twelve_data_api_key: str = field(
        default_factory=lambda: _env_str("INGESTION_TWELVE_DATA_API_KEY", ""),
        repr=False,
    )
    twelve_data_http_base_urls: list[str] = field(default_factory=lambda: _env_str_list(
        "INGESTION_TWELVE_DATA_HTTP_BASE_URLS",
        ["https://api.twelvedata.com"],
    ))
    twelve_data_ws_enabled: bool = field(
        default_factory=lambda: _env_bool("INGESTION_TWELVE_DATA_WS_ENABLED", True),
    )
    twelve_data_ws_base_url: str = field(
        default_factory=lambda: _env_str(
            "INGESTION_TWELVE_DATA_WS_BASE_URL",
            "wss://ws.twelvedata.com/v1/quotes/price",
        ),
    )
    twelve_data_ws_max_symbols: int = field(
        default_factory=lambda: _env_int("INGESTION_TWELVE_DATA_WS_MAX_SYMBOLS", 8),
    )
    twelve_data_ws_queue_size: int = field(
        default_factory=lambda: _env_int("INGESTION_TWELVE_DATA_WS_QUEUE_SIZE", 512),
    )
    twelve_data_ws_heartbeat_interval: float = field(
        default_factory=lambda: _env_float(
            "INGESTION_TWELVE_DATA_WS_HEARTBEAT_INTERVAL",
            10.0,
        ),
    )
    fetch_twelve_data_concurrency: int = field(
        default_factory=lambda: _env_int("INGESTION_TWELVE_DATA_CONCURRENCY", 1),
    )
    fetch_twelve_data_credits_per_minute: int = field(
        default_factory=lambda: _env_int("INGESTION_TWELVE_DATA_CREDITS_PER_MINUTE", 8),
    )
    # Premium Index history is split into independent fixed 1m ranges. Keep a
    # dedicated, bounded gate so those pages can overlap without widening all
    # futures REST traffic.
    fetch_binance_futures_premium_index_concurrency: int = field(
        default_factory=lambda: _env_int(
            "INGESTION_BINANCE_FUTURES_PREMIUM_INDEX_CONCURRENCY",
            4,
        ),
    )
    # HTTP proxy (None = no proxy)
    http_proxy: str | None = field(default_factory=_load_persisted_http_proxy)
    # Proxy mode: "none" | "system" | "custom"
    #   none   — direct connection, no proxy
    #   system — read from environment variables (HTTP_PROXY / HTTPS_PROXY)
    #   custom — use the value in http_proxy
    proxy_mode: str = field(default_factory=_load_persisted_proxy_mode)

    # ── L2: Session ────────────────────────────────────────────
    # WebSocket open timeout (seconds)
    ws_open_timeout: int = field(default_factory=lambda: _env_int("INGESTION_WS_OPEN_TIMEOUT", 10))
    # WebSocket subscribe/unsubscribe control-message timeout (seconds)
    ws_control_timeout: float = field(
        default_factory=lambda: _env_float("INGESTION_WS_CONTROL_TIMEOUT", 2.0),
    )
    # WebSocket ping interval (seconds) — keep-alive
    ws_ping_interval: int = field(default_factory=lambda: _env_int("INGESTION_WS_PING_INTERVAL", 20))
    # WebSocket ping timeout (seconds)
    ws_ping_timeout: int = field(default_factory=lambda: _env_int("INGESTION_WS_PING_TIMEOUT", 20))
    # Initial reconnect delay (seconds), doubled each attempt up to max
    ws_reconnect_delay_initial: float = field(
        default_factory=lambda: _env_float("INGESTION_WS_RECONNECT_DELAY_INIT", 1.0),
    )
    ws_reconnect_delay_max: float = field(
        default_factory=lambda: _env_float("INGESTION_WS_RECONNECT_DELAY_MAX", 60.0),
    )
    # After this many *consecutive* failures, Session reports "unhealthy" to L3
    ws_consecutive_failure_threshold: int = field(
        default_factory=lambda: _env_int("INGESTION_WS_FAIL_THRESHOLD", 5),
    )
    # Max time (seconds) without receiving any message before declaring stale
    ws_stale_timeout: float = field(
        default_factory=lambda: _env_float("INGESTION_WS_STALE_TIMEOUT", 30.0),
    )
    # Deprecated qualification switch retained for old dual-feed tools.  The
    # production registry no longer consults it; Binance/OKX are CCXT-owned.
    ccxt_stream_enabled: bool = field(
        default_factory=lambda: _env_bool("INGESTION_CCXT_STREAM_ENABLED", False),
    )
    # Generic CCXT Pro adapters consume CCXT's unified watch_* results.  This
    # is the default path for exchanges without a stricter raw profile.
    ccxt_unified_stream_enabled: bool = field(
        default_factory=lambda: _env_bool(
            "INGESTION_CCXT_UNIFIED_STREAM_ENABLED",
            True,
        ),
    )
    # Raw hooks run synchronously in CCXT's websocket reader.  Overflow is a
    # hard health failure rather than a silent data drop.
    ccxt_raw_queue_size: int = field(
        default_factory=lambda: _env_int("INGESTION_CCXT_RAW_QUEUE_SIZE", 4096),
    )
    ccxt_recovery_timeout_seconds: float = field(
        default_factory=lambda: _env_float(
            "INGESTION_CCXT_RECOVERY_TIMEOUT_SECONDS",
            10.0,
        ),
    )
    # Per-attempt REST deadline.  Transient failures keep the gap pending and
    # retry within the separate total deadline below.
    ccxt_recovery_retry_initial_seconds: float = field(
        default_factory=lambda: _env_float(
            "INGESTION_CCXT_RECOVERY_RETRY_INITIAL_SECONDS",
            1.0,
        ),
    )
    ccxt_recovery_retry_max_seconds: float = field(
        default_factory=lambda: _env_float(
            "INGESTION_CCXT_RECOVERY_RETRY_MAX_SECONDS",
            30.0,
        ),
    )
    ccxt_recovery_retry_deadline_seconds: float = field(
        default_factory=lambda: _env_float(
            "INGESTION_CCXT_RECOVERY_RETRY_DEADLINE_SECONDS",
            900.0,
        ),
    )
    # Live events stay fail-closed behind the unresolved boundary.  This cap
    # prevents an extended exchange outage from growing memory without bound.
    ccxt_recovery_buffer_max_events: int = field(
        default_factory=lambda: _env_int(
            "INGESTION_CCXT_RECOVERY_BUFFER_MAX_EVENTS",
            50_000,
        ),
    )
    ccxt_recovery_max_events: int = field(
        default_factory=lambda: _env_int(
            "INGESTION_CCXT_RECOVERY_MAX_EVENTS",
            10_000,
        ),
    )

    # ── L3: Feed Control ───────────────────────────────────────
    # HTTP poll interval when in fallback mode (seconds)
    http_poll_interval: float = field(
        default_factory=lambda: _env_float("INGESTION_HTTP_POLL_INTERVAL", 2.0),
    )
    # How often to probe WS health while in HTTP fallback (seconds)
    ws_probe_interval: float = field(
        default_factory=lambda: _env_float("INGESTION_WS_PROBE_INTERVAL", 60.0),
    )
    # Number of successful WS probes required before switching back to WS
    ws_probe_success_threshold: int = field(
        default_factory=lambda: _env_int("INGESTION_WS_PROBE_SUCCESS_THRESHOLD", 1),
    )

    # ── L4: Normalize ──────────────────────────────────────────
    # (no user-configurable parameters currently — format mapping is fixed)

    # ── L5: Continuity ─────────────────────────────────────────
    # Max buffered bars for re-ordering / dedup
    continuity_buffer_size: int = field(
        default_factory=lambda: _env_int("INGESTION_CONTINUITY_BUFFER_SIZE", 100),
    )
    # Gap markers are emitted to DeliveryLayer and repaired by BackfillCoordinator.

    # ── L6: Delivery ──────────────────────────────────────────
    # Max queued items in the delivery async queue per subscriber
    delivery_queue_size: int = field(
        default_factory=lambda: _env_int("INGESTION_DELIVERY_QUEUE_SIZE", 500),
    )

    # ── General ────────────────────────────────────────────────
    # Exchange identifier (for future multi-exchange support)
    exchange: str = field(default_factory=lambda: _env_str("INGESTION_EXCHANGE", "binance"))

    def update(self, **kwargs) -> None:
        """Update config fields at runtime.  Only known fields are accepted."""
        for key, value in kwargs.items():
            if not hasattr(self, key):
                raise ValueError(f"Unknown config key: {key}")
            setattr(self, key, value)

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of current configuration."""
        from dataclasses import asdict
        snapshot = asdict(self)
        if snapshot.get("twelve_data_api_key"):
            snapshot["twelve_data_api_key"] = "***"
        return snapshot

    def get_http_urls(self, market_type: str = "spot") -> list[str]:
        """Return HTTP base URLs for the given market type."""
        if market_type == "futures":
            return self.http_base_urls_futures
        return self.http_base_urls

    def get_ws_urls(self, market_type: str = "spot") -> list[str]:
        """Return WebSocket base URLs for the given market type."""
        if market_type == "futures":
            return self.ws_base_urls_futures
        return self.ws_base_urls
