"""Shared helpers for API WebSocket stream modules."""
from __future__ import annotations

import asyncio

from fastapi import WebSocket

from app.core import config
from app.core.market import VALID_INTERVALS, parse_custom_interval
from app.core.runtime_metrics import ws_runtime_metrics
from app.exchanges import bootstrap_default_adapters, get_exchange_registry


def ws_send_timeout() -> float:
    return max(0.1, float(config.WS_SEND_TIMEOUT_SECONDS))


async def send_json_with_timeout(websocket: WebSocket, data: dict) -> None:
    try:
        await asyncio.wait_for(websocket.send_json(data), timeout=ws_send_timeout())
    except asyncio.TimeoutError:
        ws_runtime_metrics.record_send_timeout("json")
        raise
    except Exception:
        ws_runtime_metrics.record_send_error("json")
        raise


async def send_text_with_timeout(websocket: WebSocket, data: str) -> None:
    try:
        await asyncio.wait_for(websocket.send_text(data), timeout=ws_send_timeout())
    except asyncio.TimeoutError:
        ws_runtime_metrics.record_send_timeout("text")
        raise
    except Exception:
        ws_runtime_metrics.record_send_error("text")
        raise


def validate_ws_interval(interval: str) -> bool:
    """Check if interval is valid for stream endpoints."""
    if interval in VALID_INTERVALS:
        return True
    parsed = parse_custom_interval(interval)
    return parsed is not None and parsed > 0


def normalize_market_type(market_type: str) -> str:
    return (market_type or "spot").strip().lower()


def normalize_exchange(exchange: str) -> str:
    normalized = (exchange or "binance").strip().lower()
    bootstrap_default_adapters()
    if not get_exchange_registry().has(normalized):
        raise ValueError(f"Unsupported exchange: {normalized}.")
    return normalized
