"""Pyne execution strategies.

The process executor gives the host application a hard timeout boundary for
untrusted or buggy scripts. Inline execution remains available for local users
who prefer performance or long-lived ML/library state over isolation.
"""
from __future__ import annotations

import multiprocessing as mp
import pickle
import queue
import time
from dataclasses import replace
from typing import Any

from .errors import error_hint
from .request.provider import DataProvider
from .result import PyneResult
from .runtime import PyneRuntime
from .security import PyneSecurityPolicy
from .settings import PyneSettings


def execute_pyne_script(
    *,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    security_mode: str | None = None,
    executor_mode: str | None = None,
    timeout_seconds: float | None = None,
    settings: PyneSettings | None = None,
    data_provider: DataProvider | None = None,
    syminfo: Any = None,
    timeframe: Any = None,
    session: Any = None,
) -> PyneResult:
    """Execute a Pyne script using the configured strategy."""
    settings = settings or PyneSettings.from_env()
    if data_provider is not None:
        settings = replace(settings, data_provider=data_provider)
    if syminfo is not None:
        settings = replace(settings, syminfo=syminfo)
    if timeframe is not None:
        settings = replace(settings, timeframe=timeframe)
    if session is not None:
        settings = replace(settings, session=session)
    mode = (executor_mode or settings.executor_mode or "process").strip().lower()
    if mode == "inline":
        return PyneRuntime(settings=settings).execute(
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
        settings=settings,
    )


def execute_pyne_script_in_process(
    *,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    security_mode: str | None = None,
    timeout_seconds: float | None = None,
    settings: PyneSettings | None = None,
) -> PyneResult:
    """Execute Pyne in a child process and terminate it on timeout."""
    settings = settings or PyneSettings.from_env()
    policy = PyneSecurityPolicy.from_settings(settings, security_mode)
    timeout = policy.timeout_seconds if timeout_seconds is None else max(float(timeout_seconds), 0.0)
    grace = settings.process_grace_seconds
    serialization_error = _process_serialization_error(
        script,
        ohlcv,
        params or {},
        security_mode,
        settings,
    )
    if serialization_error is not None:
        return serialization_error

    ctx = _multiprocessing_context()
    result_queue = ctx.Queue(maxsize=1)
    process = ctx.Process(
        target=_pyne_worker,
        args=(result_queue, script, ohlcv, params or {}, security_mode, settings),
        daemon=True,
    )
    process.start()

    payload = _read_process_result(result_queue, process, timeout + grace if timeout > 0 else None)

    if payload is None and process.is_alive():
        process.terminate()
        process.join(1)
        if process.is_alive():
            process.kill()
            process.join(1)
        return PyneResult(
            ok=False,
            code="PYNE_TIMEOUT",
            error=f"Pyne script exceeded {timeout:g}s timeout",
            hint=error_hint("PYNE_TIMEOUT"),
        )

    process.join(1)
    if process.is_alive():
        process.terminate()
        process.join(1)

    if payload is None:
        return PyneResult(
            ok=False,
            code="PYNE_PROCESS_FAILED",
            error=f"Pyne executor process exited with code {process.exitcode}",
            hint=error_hint("PYNE_PROCESS_FAILED"),
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
        hint=payload.get("hint") or error_hint(payload.get("code") or "PYNE_PROCESS_FAILED"),
    )


def _read_process_result(result_queue, process, timeout_seconds: float | None) -> Any:
    """Read the worker result while the process is still running.

    Large indicator payloads can block a child process in ``Queue.put()`` until
    the parent drains the pipe. Polling the queue before ``join()`` avoids a
    false timeout for scripts that finished computing but are returning many
    points.
    """
    deadline = None
    if timeout_seconds is not None:
        deadline = time.monotonic() + max(float(timeout_seconds), 0.0)

    while True:
        try:
            return result_queue.get(timeout=0.05)
        except queue.Empty:
            pass

        if not process.is_alive():
            try:
                return result_queue.get_nowait()
            except queue.Empty:
                return None

        if deadline is not None and time.monotonic() >= deadline:
            return None


def _process_serialization_error(*payloads: Any) -> PyneResult | None:
    try:
        pickle.dumps(payloads)
    except Exception as exc:
        code = "PYNE_PROCESS_SERIALIZATION_ERROR"
        return PyneResult(
            ok=False,
            code=code,
            error=(
                "Pyne process executor arguments must be pickle-serializable "
                f"({type(exc).__name__})"
            ),
            hint=error_hint(code),
        )
    return None


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
    settings: PyneSettings,
) -> None:
    try:
        result = PyneRuntime(settings=settings).execute(
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
