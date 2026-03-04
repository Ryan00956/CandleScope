"""
CandleScope global configuration.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

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
