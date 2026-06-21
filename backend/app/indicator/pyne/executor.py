"""Pyne execution entrypoints backed by the standalone ``pyne_runtime`` package."""
from __future__ import annotations

from typing import Any

from .external_runtime import (
    execute_pyne_script as _execute_pyne_script,
    execute_pyne_script_in_process as _execute_pyne_script_in_process,
)


def execute_pyne_script(
    *,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    security_mode: str | None = None,
    executor_mode: str | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    """Execute a Pyne script with the standalone runtime."""
    return _execute_pyne_script(
        script=script,
        ohlcv=ohlcv,
        params=params or {},
        security_mode=security_mode,
        executor_mode=executor_mode,
        timeout_seconds=timeout_seconds,
    )


def execute_pyne_script_in_process(
    *,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    security_mode: str | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    """Execute Pyne in a child process using the standalone runtime."""
    return _execute_pyne_script_in_process(
        script=script,
        ohlcv=ohlcv,
        params=params or {},
        security_mode=security_mode,
        timeout_seconds=timeout_seconds,
    )
