"""Shared request provider contract constants."""
from __future__ import annotations

REQUEST_SECURITY_API = "request.security"
REQUEST_SECURITY_LOWER_TF_API = "request.security_lower_tf"
REQUEST_API_VALUES = (REQUEST_SECURITY_API, REQUEST_SECURITY_LOWER_TF_API)
REQUEST_SECURITY_CAPABILITY_ALIASES = (REQUEST_SECURITY_API, "security", "ohlcv")
REQUEST_SECURITY_LOWER_TF_CAPABILITY_ALIASES = (
    REQUEST_SECURITY_LOWER_TF_API,
    "security_lower_tf",
    "lower_tf",
)
REQUEST_METADATA_SYMBOL_KEYS = ("syminfo", "symbol_info")
REQUEST_METADATA_TIMEFRAME_KEYS = ("timeframe", "timeframe_info")
REQUEST_METADATA_SESSION_KEYS = ("session", "session_info")
REQUEST_METADATA_KEY_ALIASES = {
    "syminfo": REQUEST_METADATA_SYMBOL_KEYS,
    "timeframe": REQUEST_METADATA_TIMEFRAME_KEYS,
    "session": REQUEST_METADATA_SESSION_KEYS,
}
