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

# Request tuning  (lower values = faster fallback when Binance is unreachable)
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "5"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "3"))
RATE_LIMIT_SLEEP = int(os.getenv("RATE_LIMIT_SLEEP", "60"))

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
    ``urllib.request.getproxies()`` reads these OS-level settings.
    """
    env_proxy = (
        os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or os.getenv("https_proxy")
        or os.getenv("http_proxy")
    )
    if env_proxy:
        return env_proxy

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
