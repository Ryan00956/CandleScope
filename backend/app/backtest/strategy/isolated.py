"""Killable process boundary for runtime strategy providers."""

from __future__ import annotations

import multiprocessing
from multiprocessing.process import BaseProcess
from typing import Any

from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
)


class IsolatedStrategyProvider:
    """Provider proxy whose individual calls have a real termination boundary."""

    def __init__(self, revision_id: str, *, step_timeout_s: float) -> None:
        self._revision_id = revision_id
        self._step_timeout_s = max(0.001, float(step_timeout_s))
        self._process: BaseProcess | None = None
        self._connection: Any = None
        self._identity: dict[str, Any] = {}

    def describe(self) -> ProviderCapabilities:
        return self._call("describe", timeout_s=5.0)

    def prepare(self, context: dict[str, Any]) -> None:
        self._call("prepare", dict(context), timeout_s=5.0)
        identity = self._call("identity", timeout_s=5.0)
        self._identity = dict(identity or {})

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        return self._call("warmup", frame, timeout_s=self._step_timeout_s)

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        return self._call("step", frame, timeout_s=self._step_timeout_s)

    def on_execution_report(self, report: dict[str, Any]) -> None:
        self._call("on_execution_report", dict(report), timeout_s=self._step_timeout_s)

    def snapshot(self) -> dict[str, Any]:
        return self._call("snapshot", timeout_s=5.0)

    def restore(self, payload: dict[str, Any]) -> None:
        self._call("restore", dict(payload), timeout_s=5.0)

    def close(self) -> str:
        try:
            return str(self._call("close", timeout_s=5.0))
        finally:
            self._terminate()

    def identity(self) -> dict[str, Any]:
        return dict(self._identity)

    def report_metadata(self) -> dict[str, Any]:
        return dict(self._call("report_metadata", timeout_s=5.0) or {})

    def _ensure_started(self) -> None:
        if self._process is not None:
            if self._process.is_alive():
                return
            raise StrategyProviderError(
                "PROVIDER_CRASH_UNRECOVERABLE",
                "strategy provider process exited",
            )
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe(duplex=True)
        process = context.Process(
            target=_provider_process_main,
            args=(child, self._revision_id),
            name=f"backtest-provider-{self._revision_id}",
            daemon=True,
        )
        process.start()
        child.close()
        self._connection = parent
        self._process = process

    def _call(self, operation: str, payload: object = None, *, timeout_s: float) -> Any:
        self._ensure_started()
        try:
            self._connection.send((operation, payload))
            if not self._connection.poll(timeout_s):
                self._terminate()
                raise StrategyProviderError(
                    "PROVIDER_TIMEOUT",
                    f"provider {operation} exceeded {timeout_s:.3f}s",
                )
            status, result = self._connection.recv()
        except (BrokenPipeError, EOFError, OSError) as exc:
            self._terminate()
            raise StrategyProviderError(
                "PROVIDER_CRASH_UNRECOVERABLE",
                f"provider process failed during {operation}",
            ) from exc
        if status == "ok":
            return result
        code, message = result
        raise StrategyProviderError(str(code), str(message))

    def _terminate(self) -> None:
        connection, process = self._connection, self._process
        self._connection = None
        self._process = None
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
        if process is not None:
            if process.is_alive():
                process.terminate()
            process.join(timeout=2)
            if process.is_alive():
                process.kill()
                process.join(timeout=2)


def _provider_process_main(connection: Any, revision_id: str) -> None:
    from app.backtest.strategy.registry import build_default_strategy_registry
    from app.backtest.strategy.pine_adapter import PineStrategyProvider

    try:
        provider = (
            PineStrategyProvider()
            if revision_id == "pine-long-flat-v1"
            else build_default_strategy_registry().build(revision_id)
        )
        while True:
            operation, payload = connection.recv()
            try:
                if operation == "identity":
                    identity = getattr(provider, "identity", None)
                    result = identity() if callable(identity) else {}
                elif operation == "report_metadata":
                    report_metadata = getattr(provider, "report_metadata", None)
                    result = report_metadata() if callable(report_metadata) else {}
                else:
                    method = getattr(provider, operation)
                    result = method() if payload is None else method(payload)
                connection.send(("ok", result))
                if operation == "close":
                    return
            except StrategyProviderError as exc:
                connection.send(("error", (exc.code, str(exc))))
            except Exception as exc:
                connection.send(
                    (
                        "error",
                        (
                            "PROVIDER_CRASH_UNRECOVERABLE",
                            f"{type(exc).__name__}: {exc}",
                        ),
                    )
                )
    except (EOFError, BrokenPipeError, OSError):
        return
    finally:
        try:
            connection.close()
        except OSError:
            pass
