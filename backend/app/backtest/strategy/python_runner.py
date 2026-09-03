"""Isolated JSONL runner. Does not import service, repository, or database."""

from __future__ import annotations

from app.core.config import getenv as app_getenv

import json
import os
import subprocess
import sys
import threading
import tempfile
import uuid
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
    if app_getenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "0").strip() != "1":
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
        self._sandbox_sid: str | None = None
        self._sandbox_read_roots: tuple[Path, ...] = ()
        self._stderr_bytes = 0
        self._stderr_tail = bytearray()
        self._stderr_overflow = threading.Event()
        self._stderr_thread: threading.Thread | None = None
        self._sandbox_profile: str | None = None
        self._sandbox_root: tempfile.TemporaryDirectory | None = None
        self._runtime = _real_python()

    def start(self) -> None:
        if self._process is not None:
            raise PythonRunnerError(
                "RUNNER_ALREADY_STARTED", "runner is already running"
            )
        environment = {
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONNOUSERSITE": "1",
        }
        command = [str(self._runtime), "-I", "-u", str(WORKER), str(SDK_SRC)]
        working = self.bundle_dir
        try:
            if self.mode == "SANDBOXED_LOCAL":
                from app.plugin_security_v2.sandbox import (
                    SandboxPolicy,
                    prepare_sandbox_launch,
                    ensure_appcontainer_profile,
                )
                from app.plugin_security_v2.python_runtime import (
                    prepare_pinned_python_runtime,
                )

                runtime = prepare_pinned_python_runtime(
                    Path(tempfile.gettempdir()) / "candlescope-python-runtime-v1",
                    sys.executable,
                )
                self._runtime = runtime.executable
                self._sandbox_root = tempfile.TemporaryDirectory(
                    prefix="candlescope-strategy-"
                )
                root = Path(self._sandbox_root.name)
                self._sandbox_profile = "cs.strategy." + uuid.uuid4().hex
                self._sandbox_sid, _ = ensure_appcontainer_profile(
                    self._sandbox_profile
                )
                self._sandbox_read_roots = (
                    self.bundle_dir.resolve(),
                    runtime.root,
                    SDK_SRC,
                )
                prepared = prepare_sandbox_launch(
                    SandboxPolicy(
                        profile_name=self._sandbox_profile,
                        installation_directory=self.bundle_dir,
                        private_directory=root / "private",
                        runtime_directory=root / "launcher",
                        additional_read_only_paths=(runtime.root, SDK_SRC),
                        max_processes=MAX_JOB_PROCESSES,
                        memory_limit_bytes=512 * 1024 * 1024,
                        cpu_time_seconds=3600,
                        max_wall_seconds=86_400,
                    ),
                    (str(runtime.executable), "-I", "-u", str(WORKER), str(SDK_SRC)),
                    self.bundle_dir,
                )
                command, working, environment = (
                    prepared.command,
                    prepared.working_directory,
                    prepared.environment,
                )
            self._process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                env=environment,
                cwd=str(working),
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            process = self._process

            def drain_stderr() -> None:
                assert process.stderr is not None
                while chunk := process.stderr.buffer.read1(4096):
                    self._stderr_bytes += len(chunk)
                    self._stderr_tail.extend(chunk)
                    del self._stderr_tail[:-MAX_STDERR_BYTES]
                    if self._stderr_bytes > MAX_STDERR_BYTES:
                        self._stderr_overflow.set()
                        process.kill()
                        break

            self._stderr_thread = threading.Thread(
                target=drain_stderr, name="python-runner-stderr", daemon=True
            )
            self._stderr_thread.start()
            self.call("ping", _timeout_s=DEFAULT_STARTUP_TIMEOUT_S)
        except Exception as exc:
            self.close()
            if self.mode == "SANDBOXED_LOCAL":
                raise PythonRunnerError(
                    "SANDBOX_UNAVAILABLE", "AppContainer worker could not start"
                ) from exc
            raise

    def call(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        _timeout_s: float | None = None,
    ) -> Any:
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
        process = self._process
        if self._stderr_overflow.is_set():
            self.close()
            raise PythonRunnerError("STDERR_TOO_LARGE", "worker stderr exceeded budget")
        wire = json.dumps(request) + "\n"
        if len(wire.encode("utf-8")) > MAX_MESSAGE_BYTES:
            raise PythonRunnerError("MESSAGE_TOO_LARGE", "request JSON exceeded budget")
        box: list[str | None] = []
        io_errors: list[OSError] = []

        def _read() -> None:
            try:
                process.stdin.write(wire)
                process.stdin.flush()
                box.append(process.stdout.readline(MAX_MESSAGE_BYTES + 1))
            except OSError as exc:
                io_errors.append(exc)

        reader = threading.Thread(target=_read, name="python-runner-read", daemon=True)
        reader.start()
        reader.join(self.step_timeout_s if _timeout_s is None else _timeout_s)
        if self._stderr_overflow.is_set():
            self.close()
            raise PythonRunnerError("STDERR_TOO_LARGE", "worker stderr exceeded budget")
        if reader.is_alive():
            self.close()
            raise PythonRunnerError(
                "PROVIDER_TIMEOUT", f"{method} exceeded {self.step_timeout_s}s"
            )
        line = box[0] if box else ""
        if not line:
            self.close()
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
            self._cleanup_sandbox()
            return self.receipt()
        process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=2)
            self._stderr_thread = None
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        self._cleanup_sandbox()
        return self.receipt()

    def _cleanup_sandbox(self) -> None:
        if self._sandbox_sid is not None:
            from app.plugin_security_v2.sandbox import revoke_appcontainer_read_access

            revoke_appcontainer_read_access(self._sandbox_read_roots, self._sandbox_sid)
            self._sandbox_sid = None
            self._sandbox_read_roots = ()
        if self._sandbox_profile is not None:
            from app.plugin_security_v2.sandbox import delete_appcontainer_profile

            delete_appcontainer_profile(self._sandbox_profile)
            self._sandbox_profile = None
        if self._sandbox_root is not None:
            self._sandbox_root.cleanup()
            self._sandbox_root = None

    def receipt(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "runtime": str(self._runtime),
            "stderrBytes": self._stderr_bytes,
            "stderrOverflow": self._stderr_overflow.is_set(),
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
