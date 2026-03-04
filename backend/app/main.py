"""
CandleScope backend entrypoint.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.klines import router as klines_router
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


@app.on_event("startup")
async def startup_event() -> None:
    init_klines_storage()


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
