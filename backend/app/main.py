"""
CandleScope 后端入口
FastAPI 应用 + CORS + 路由注册
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import CORS_ORIGINS
from app.api.v1.klines import router as klines_router

# ── 创建 FastAPI 应用 ─────────────────────────────────────
app = FastAPI(
    title="CandleScope API",
    description="开源看盘软件 CandleScope 的后端 API",
    version="0.1.0",
)

# ── CORS 中间件（允许前端跨域访问） ──────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 注册路由 ──────────────────────────────────────────────
app.include_router(klines_router, prefix="/api/v1")


# ── 健康检查 ──────────────────────────────────────────────
@app.get("/", tags=["系统"])
async def root():
    return {
        "name": "CandleScope API",
        "version": "0.1.0",
        "status": "running ✅",
    }


@app.get("/health", tags=["系统"])
async def health_check():
    return {"status": "ok"}
