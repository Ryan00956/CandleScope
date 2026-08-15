"""Host-facing StrategyProvider that talks to the isolated Python runner."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping

from app.backtest.strategy.protocol import (
    ObservationFrame,
    ProviderCapabilities,
    StrategyOutput,
    StrategyProviderError,
    canonical_hash,
)
from app.backtest.strategy.python_runner import IsolatedPythonRunner, PythonRunnerError


def _author_observation(frame: ObservationFrame) -> dict[str, Any]:
    bar = dict(frame.bar or {})
    return {
        "schemaVersion": "candlescope.python-strategy-observation/1",
        "runId": frame.run_id,
        "revisionId": str((frame.features or {}).get("revision_id") or "python-source"),
        "generation": 1,
        "sequence": frame.sequence,
        "eventTimeMs": frame.event_time_ms,
        "watermarkMs": frame.watermark_ms,
        "phase": frame.phase,
        "market": dict(frame.market),
        "bar": {
            "openTimeMs": int(bar.get("open_time_ms") or bar.get("openTimeMs") or 0),
            "closeTimeMs": int(bar.get("close_time_ms") or bar.get("closeTimeMs") or 0),
            "open": str(bar.get("open") or "0"),
            "high": str(bar.get("high") or "0"),
            "low": str(bar.get("low") or "0"),
            "close": str(bar.get("close") or "0"),
            "volume": str(bar.get("volume") or "0"),
        },
        "features": {str(key): str(value) for key, value in dict(frame.features).items()},
        "accountView": {
            str(key): str(value) for key, value in dict(frame.account_view).items()
        },
        "inputHash": frame.input_hash,
    }


def _to_host_output(sequence: int, payload: Mapping[str, Any] | None) -> StrategyOutput | None:
    if not payload:
        return None
    kind = str(payload.get("kind") or "")
    body = dict(payload.get("payload") or {})
    if kind == "TARGET_POSITION" and "targetExposure" not in body and "quantity" in body:
        body["targetExposure"] = body["quantity"]
    if kind == "ORDER_INTENT" and "qty" not in body and "quantity" in body:
        body["qty"] = body["quantity"]
    return StrategyOutput(
        sequence=sequence,
        kind=kind,
        payload=body,
        state_hash=canonical_hash(body),
        output_hash=str(payload.get("outputHash") or canonical_hash(body)),
    )


class PythonHostProvider:
    def __init__(
        self,
        bundle_dir: Path,
        *,
        entrypoint: str = "strategy:Strategy",
        parameters: Mapping[str, Any] | None = None,
        mode: str | None = None,
        trusted_confirmed: bool | None = None,
    ) -> None:
        if mode is None:
            mode = "TRUSTED_LOCAL"
            if os.environ.get("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "0").strip() != "1":
                mode = "SANDBOXED_LOCAL"
            trusted_confirmed = mode == "TRUSTED_LOCAL"
        from app.backtest.strategy.python_scale import scale_v1_enabled

        self.runner = IsolatedPythonRunner(
            bundle_dir,
            entrypoint=entrypoint,
            mode=mode,
            trusted_confirmed=bool(trusted_confirmed),
            step_timeout_s=5.0,
            bound_transcript=scale_v1_enabled(),
        )
        self.entrypoint = entrypoint
        self.parameters = dict(parameters or {})
        self.bundle_dir = Path(bundle_dir)

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("BAR_CLOSE",),
            output_modes=("SIGNAL", "TARGET_POSITION", "ORDER_INTENT"),
            signal_clock="BAR_CLOSE",
            required_features=("open", "high", "low", "close", "volume"),
        )

    def prepare(self, context: dict[str, Any]) -> None:
        self.runner.start()
        try:
            self.runner.call(
                "prepare",
                {
                    "bundleDir": str(self.bundle_dir),
                    "entrypoint": self.entrypoint,
                    "runId": str(context.get("run_id") or "bt_python"),
                    "revisionId": str(context.get("revision_id") or "python-source"),
                    "parameters": dict(context.get("parameters") or self.parameters),
                },
            )
        except PythonRunnerError as exc:
            raise StrategyProviderError(exc.code, str(exc)) from exc

    def warmup(self, frame: ObservationFrame) -> StrategyOutput | None:
        try:
            self.runner.call("warmup", {"observation": _author_observation(frame)})
        except PythonRunnerError as exc:
            raise StrategyProviderError(exc.code, str(exc)) from exc
        return None

    def step(self, frame: ObservationFrame) -> StrategyOutput | None:
        try:
            payload = self.runner.call("step", {"observation": _author_observation(frame)})
        except PythonRunnerError as exc:
            raise StrategyProviderError(exc.code, str(exc)) from exc
        return _to_host_output(frame.sequence, payload)

    def on_execution_report(self, report: dict[str, Any]) -> None:
        try:
            self.runner.call("on_execution_report", {"report": report})
        except PythonRunnerError as exc:
            raise StrategyProviderError(exc.code, str(exc)) from exc

    def snapshot(self) -> dict[str, Any]:
        try:
            payload = self.runner.call("snapshot") or {}
        except PythonRunnerError as exc:
            raise StrategyProviderError(exc.code, str(exc)) from exc
        return dict(payload.get("payload") or payload)

    def restore(self, payload: dict[str, Any]) -> None:
        try:
            self.runner.call("restore", {"payload": payload})
        except PythonRunnerError as exc:
            raise StrategyProviderError(exc.code, str(exc)) from exc

    def close(self) -> str:
        try:
            self.runner.call("close")
        except PythonRunnerError:
            pass
        receipt = self.runner.close()
        return str(receipt.get("transcriptHash") or "")
