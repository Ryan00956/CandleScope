"""
Ingestion Configuration — all tunable parameters for the Market Data Ingress pipeline.

Every parameter has a sensible default but can be overridden via:
  1. Constructor kwargs
  2. Environment variables (prefixed with INGESTION_)
  3. Runtime update via `update()` method

This is the single source of truth for the ingestion subsystem.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_int(key: str, default: int) -> int:
    """Read an integer from environment variable, falling back to *default*."""
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


def _env_str_list(key: str, default: list[str]) -> list[str]:
    raw = os.getenv(key)
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
            return (os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")
                    or os.getenv("ALL_PROXY") or os.getenv("all_proxy")
                    or _get_os_proxy() or None)
    except Exception:
        pass
    # Fall back to environment / OS proxy
    return (_env_str("INGESTION_HTTP_PROXY", "")
            or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")
            or os.getenv("ALL_PROXY") or os.getenv("all_proxy")
            or _get_os_proxy() or None)


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
        return asdict(self)

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
