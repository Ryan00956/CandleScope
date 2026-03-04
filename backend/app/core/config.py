"""
CandleScope 全局配置
所有可调参数集中在这里，通过环境变量或 .env 文件覆盖
"""
import os
from dotenv import load_dotenv

load_dotenv()

# ── 服务器 ──────────────────────────────────────────────
HOST = os.getenv("CANDLE_HOST", "0.0.0.0")
PORT = int(os.getenv("CANDLE_PORT", "8000"))

# ── 币安 API ────────────────────────────────────────────
BINANCE_BASE_URLS = [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api.binance.me",        # 中国大陆可用镜像
]

# 默认 base url（可通过环境变量覆盖）
BINANCE_BASE_URL = os.getenv("BINANCE_BASE_URL", "https://api.binance.me")

# 币安 WebSocket 地址
BINANCE_WS_URL = os.getenv("BINANCE_WS_URL", "wss://stream.binance.com:9443/ws")

# ── 数据抓取 ────────────────────────────────────────────
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "10"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "5"))
RATE_LIMIT_SLEEP = int(os.getenv("RATE_LIMIT_SLEEP", "60"))

# ── CORS（跨域，允许前端访问后端） ───────────────────────
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")
