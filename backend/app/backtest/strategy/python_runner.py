"""Isolated JSONL runner. Does not import service, repository, or database."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Mapping

from candlescope_backtest_sdk import canonical_sha256

SDK_SRC = (
    Path(__file__).resolve().parents[4]
    / "packages"
    / "candlescope-backtest-sdk"
    / "src"
)
WORKER = SDK_SRC / "candlescope_backtest_sdk" / "worker.py"
DEFAULT_CALL_TIMEOUT_S = 2.0
DEFAULT_STARTUP_TIMEOUT_S = 5.0


class PythonRunnerError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def _real_python() -> Path:
    candidate = Path(sys.base_prefix) / "python.exe"
    if not candidate.is_file():
        candidate = Path(sys.executable)
    return candidate


def _require_trusted_local(*, confirmed: bool) -> None:
    if os.environ.get("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "0").strip() != "1":
        raise PythonRunnerError(
            "TRUSTED_LOCAL_DISABLED",
            "TRUSTED_LOCAL requires BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED=1",
        )
    if not confirmed:
        raise PythonRunnerError(
            "TRUSTED_LOCAL_UNCONFIRMED",
            "TRUSTED_LOCAL requires an explicit operator confirmation",
        )


def sandbox_available() -> bool:
    if os.name != "nt":
        return False
    try:
        from app.plugin_security_v2.sandbox import ensure_appcontainer_profile

        ensure_appcontainer_profile("candlescope.python.strategy.v1")
        return True
    except Exception:
        return False


class IsolatedPythonRunner:
    def __init__(
        self,
        bundle_dir: Path,
        *,
        entrypoint: str = "strategy:Strategy",
        mode: str = "SANDBOXED_LOCAL",
        trusted_confirmed: bool = False,
        step_timeout_s: float = DEFAULT_CALL_TIMEOUT_S,
    ) -> None:
        if mode == "TRUSTED_LOCAL":
            _require_trusted_local(confirmed=trusted_confirmed)
        elif mode == "SANDBOXED_LOCAL":
            if not sandbox_available():
                raise PythonRunnerError(
                    "SANDBOX_UNAVAILABLE",
                    "SANDBOXED_LOCAL failed closed because AppContainer is unavailable",
                )
        else:
            raise PythonRunnerError("INVALID_RUNTIME_MODE", mode)
        self.bundle_dir = Path(bundle_dir)
        self.entrypoint = entrypoint
        self.mode = mode
        self.step_timeout_s = step_timeout_s
        self._process: subprocess.Popen[str] | None = None
        self._transcript: list[dict[str, Any]] = []

    def start(self) -> None:
        environment = {
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONNOUSERSITE": "1",
        }
        self._process = subprocess.Popen(
            [_real_python(), "-I", "-u", str(WORKER), str(SDK_SRC)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
            cwd=str(self.bundle_dir),
        )

    def call(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        if self._process is None or self._process.stdin is None or self._process.stdout is None:
            raise PythonRunnerError("RUNNER_NOT_STARTED", "start the runner first")
        request = {"id": len(self._transcript) + 1, "method": method, "params": dict(params or {})}
        self._process.stdin.write(json.dumps(request) + "\n")
        self._process.stdin.flush()
        started = time.perf_counter()
        while time.perf_counter() - started < self.step_timeout_s:
            line = self._process.stdout.readline()
            if not line:
                raise PythonRunnerError("PROVIDER_EOF", "worker closed stdout")
            payload = json.loads(line)
            self._transcript.append({"request": request, "response": payload})
            if not payload.get("ok"):
                raise PythonRunnerError("PROVIDER_PROTOCOL_VIOLATION", str(payload.get("error")))
            return payload.get("result")
        self.close()
        raise PythonRunnerError("PROVIDER_TIMEOUT", f"{method} exceeded {self.step_timeout_s}s")

    def close(self) -> dict[str, Any]:
        process = self._process
        self._process = None
        if process is None:
            return self.receipt()
        try:
            if process.stdin:
                process.stdin.close()
        except OSError:
            pass
        process.kill()
        process.wait(timeout=2)
        return self.receipt()

    def receipt(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "runtime": str(_real_python()),
            "bundleDir": str(self.bundle_dir),
            "limits": {"stepTimeoutS": self.step_timeout_s},
            "transcriptHash": canonical_sha256(self._transcript),
        }


def probe_twice(bundle_dir: Path, frames: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
    hashes: list[str] = []
    for _ in range(2):
        runner = IsolatedPythonRunner(bundle_dir, **kwargs)
        runner.start()
        try:
            runner.call(
                "prepare",
                {
                    "bundleDir": str(bundle_dir),
                    "entrypoint": kwargs.get("entrypoint", "strategy:Strategy"),
                    "parameters": {"fast": 2, "slow": 3, "length": 2, "lookback": 2},
                },
            )
            for frame in frames:
                runner.call("step", {"observation": frame})
            runner.call("close")
        finally:
            receipt = runner.close()
        hashes.append(str(receipt["transcriptHash"]))
    if hashes[0] != hashes[1]:
        raise PythonRunnerError("DETERMINISM_PROBE_FAILED", "repeat probe hashes differ")
    return {"transcriptHash": hashes[0], "repeats": 2}
