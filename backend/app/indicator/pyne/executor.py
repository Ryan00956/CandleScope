"""Pyne execution strategies.

The process executor gives the host application a hard timeout boundary for
untrusted or buggy scripts. Inline execution remains available for local users
who prefer performance or long-lived ML/library state over isolation.
"""
from __future__ import annotations

import multiprocessing as mp
import queue
from typing import Any

from app.core import config

from .runtime import PyneResult, PyneRuntime
from .security import PyneSecurityPolicy


def execute_pyne_script(
    *,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    security_mode: str | None = None,
    executor_mode: str | None = None,
    timeout_seconds: float | None = None,
) -> PyneResult:
    """Execute a Pyne script using the configured strategy."""
    mode = (executor_mode or config.PYNE_EXECUTOR_MODE or "process").strip().lower()
    if mode == "inline":
        return PyneRuntime().execute(
            script=script,
            ohlcv=ohlcv,
            params=params or {},
            security_mode=security_mode,
        )
    return execute_pyne_script_in_process(
        script=script,
        ohlcv=ohlcv,
        params=params or {},
        security_mode=security_mode,
        timeout_seconds=timeout_seconds,
    )


def execute_pyne_script_in_process(
    *,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    security_mode: str | None = None,
    timeout_seconds: float | None = None,
) -> PyneResult:
    """Execute Pyne in a child process and terminate it on timeout."""
    policy = PyneSecurityPolicy.from_config(security_mode)
    timeout = policy.timeout_seconds if timeout_seconds is None else max(float(timeout_seconds), 0.0)
    grace = max(float(config.PYNE_PROCESS_GRACE_SECONDS), 0.0)
    ctx = _multiprocessing_context()
    result_queue = ctx.Queue(maxsize=1)
    process = ctx.Process(
        target=_pyne_worker,
        args=(result_queue, script, ohlcv, params or {}, security_mode),
        daemon=True,
    )
    process.start()
    process.join(timeout + grace if timeout > 0 else None)

    if process.is_alive():
        process.terminate()
        process.join(1)
        if process.is_alive():
            process.kill()
            process.join(1)
        return PyneResult(
            ok=False,
            code="PYNE_TIMEOUT",
            error=f"Pyne script exceeded {timeout:g}s timeout",
            hint="脚本执行超时，已终止独立执行进程。请减少循环、缩小窗口，或调整 PYNE_EXEC_TIMEOUT_SECONDS。",
        )

    try:
        payload = result_queue.get_nowait()
    except queue.Empty:
        return PyneResult(
            ok=False,
            code="PYNE_PROCESS_FAILED",
            error=f"Pyne executor process exited with code {process.exitcode}",
            hint="脚本执行进程异常退出。请检查 unsafe/research 模式下的第三方库或系统资源。",
        )

    if not isinstance(payload, dict):
        return PyneResult(
            ok=False,
            code="PYNE_PROCESS_FAILED",
            error="Pyne executor returned an invalid payload",
        )
    if payload.get("kind") == "result" and isinstance(payload.get("result"), dict):
        return PyneResult.from_dict(payload["result"])
    return PyneResult(
        ok=False,
        code=payload.get("code") or "PYNE_PROCESS_FAILED",
        error=payload.get("error") or "Pyne executor process failed",
        hint=payload.get("hint"),
    )


def _multiprocessing_context():
    try:
        return mp.get_context("fork")
    except ValueError:
        return mp.get_context()


def _pyne_worker(
    result_queue,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any],
    security_mode: str | None,
) -> None:
    try:
        result = PyneRuntime().execute(
            script=script,
            ohlcv=ohlcv,
            params=params,
            security_mode=security_mode,
        )
        result_queue.put({"kind": "result", "result": result.to_dict()})
    except BaseException as exc:
        result_queue.put({
            "kind": "error",
            "code": "PYNE_PROCESS_FAILED",
            "error": f"Pyne executor process failed: {exc}",
        })

