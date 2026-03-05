"""
CandleScope backend entrypoint.
"""
import asyncio

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.klines import router as klines_router
from app.api.v1.stream import router as stream_router
from app.core.config import CORS_ORIGINS
from app.data_engine.storage import init_klines_storage

app = FastAPI(
    title="CandleScope API",
    description="Backend API for CandleScope",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(klines_router, prefix="/api/v1")
app.include_router(stream_router, prefix="/api/v1")

# Intervals and days to prewarm on startup (most commonly used)
_PREWARM_INTERVALS = {
    "1m": 1,
    "5m": 3,
    "15m": 7,
    "1h": 30,
    "4h": 90,
    "1d": 365,
}
_PREWARM_SYMBOL = "BTCUSDT"


def _prewarm_cache() -> None:
    """Prewarm the kline cache for common intervals.

    Runs in a background thread so it doesn't block startup.
    """
    from app.data_engine.services.kline_cache_service import get_cached_history

    for interval, days in _PREWARM_INTERVALS.items():
        try:
            result = get_cached_history(
                symbol=_PREWARM_SYMBOL, interval=interval, days=days,
            )
            count = len(result.get("data", []))
            print(f"[prewarm] {_PREWARM_SYMBOL} {interval} ({days}d): {count} bars cached")
        except Exception as exc:  # noqa: BLE001
            print(f"[prewarm] {_PREWARM_SYMBOL} {interval} failed: {exc}")


@app.on_event("startup")
async def startup_event() -> None:
    init_klines_storage()
    # Fire-and-forget background prewarming so the server starts immediately
    asyncio.get_event_loop().run_in_executor(None, _prewarm_cache)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "name": "CandleScope API",
        "version": "0.2.0",
        "status": "running",
    }


@app.get("/health", tags=["system"])
async def health_check() -> dict:
    return {"status": "ok"}
