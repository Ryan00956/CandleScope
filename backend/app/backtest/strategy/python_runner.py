"""Isolated JSONL runner. Does not import service, repository, or database."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Mapping

from app.backtest.identity import sha256_hex

SDK_SRC = (
    Path(__file__).resolve().parents[4]
    / "packages"
    / "candlescope-backtest-sdk"
    / "src"
)
WORKER = SDK_SRC / "candlescope_backtest_sdk" / "worker.py"
DEFAULT_CALL_TIMEOUT_S = 2.0
DEFAULT_STARTUP_TIMEOUT_S = 5.0
MAX_MESSAGE_BYTES = 256 * 1024
MAX_STDERR_BYTES = 64 * 1024
MAX_JOB_PROCESSES = 2


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
        bound_transcript: bool = False,
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
        self._bound_transcript = bool(bound_transcript)
        self._process: subprocess.Popen[str] | None = None
        self._transcript: list[dict[str, Any]] = []
        self._transcript_chain = "sha256:GENESIS"
        self._job: Any = None
        self._stderr_bytes = 0

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
        self._attach_job()

    def _attach_job(self) -> None:
        if os.name != "nt" or self._process is None or self._process.pid is None:
            return
        try:
            kernel32 = __import__("ctypes").WinDLL("kernel32", use_last_error=True)
            job = kernel32.CreateJobObjectW(None, None)
            if not job:
                return
            process = kernel32.OpenProcess(0x1F0FFF, False, int(self._process.pid))
            if process:
                kernel32.AssignProcessToJobObject(job, process)
                kernel32.CloseHandle(process)
            self._job = job
        except Exception:
            self._job = None

    def call(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        if (
            self._process is None
            or self._process.stdin is None
            or self._process.stdout is None
        ):
            raise PythonRunnerError("RUNNER_NOT_STARTED", "start the runner first")
        request = json.loads(
            json.dumps(
                {
                    "id": len(self._transcript) + 1,
                    "method": method,
                    "params": dict(params or {}),
                },
                default=str,
            )
        )
        self._process.stdin.write(json.dumps(request) + "\n")
        self._process.stdin.flush()
        box: list[str | None] = []

        def _read() -> None:
            assert self._process is not None and self._process.stdout is not None
            box.append(self._process.stdout.readline())

        reader = threading.Thread(target=_read, name="python-runner-read", daemon=True)
        reader.start()
        reader.join(self.step_timeout_s)
        if reader.is_alive():
            self.close()
            raise PythonRunnerError(
                "PROVIDER_TIMEOUT", f"{method} exceeded {self.step_timeout_s}s"
            )
        line = box[0] if box else ""
        if not line:
            raise PythonRunnerError("PROVIDER_EOF", "worker closed stdout")
        encoded = line.encode("utf-8")
        if len(encoded) > MAX_MESSAGE_BYTES:
            self.close()
            raise PythonRunnerError("MESSAGE_TOO_LARGE", "worker JSON exceeded budget")
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            self.close()
            raise PythonRunnerError(
                "INVALID_JSON", "worker emitted invalid JSONL"
            ) from exc
        record = {"request": request, "response": payload}
        if self._bound_transcript:
            self._transcript_chain = "sha256:" + sha256_hex(
                {"previous": self._transcript_chain, "record": record}
            )
            self._transcript = [record]
        else:
            self._transcript.append(record)
        if not payload.get("ok"):
            raise PythonRunnerError(
                "PROVIDER_PROTOCOL_VIOLATION", str(payload.get("error"))
            )
        return payload.get("result")

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
        if self._job is not None:
            try:
                kernel32 = __import__("ctypes").WinDLL("kernel32", use_last_error=True)
                kernel32.TerminateJobObject(self._job, 1)
                kernel32.CloseHandle(self._job)
            except Exception:
                pass
            self._job = None
        process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        return self.receipt()

    def receipt(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "runtime": str(_real_python()),
            "bundleDir": str(self.bundle_dir),
            "profile": self.mode,
            "limits": {
                "stepTimeoutS": self.step_timeout_s,
                "maxMessageBytes": MAX_MESSAGE_BYTES,
                "maxStderrBytes": MAX_STDERR_BYTES,
                "maxProcesses": MAX_JOB_PROCESSES,
            },
            "transcriptHash": (
                self._transcript_chain
                if self._bound_transcript
                else "sha256:" + sha256_hex(self._transcript)
            ),
        }


def probe_twice(
    bundle_dir: Path, frames: list[dict[str, Any]], **kwargs: Any
) -> dict[str, Any]:
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
        raise PythonRunnerError(
            "DETERMINISM_PROBE_FAILED", "repeat probe hashes differ"
        )
    return {"transcriptHash": hashes[0], "repeats": 2}
