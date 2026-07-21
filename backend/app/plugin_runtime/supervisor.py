"""Async process supervision and strict JSON-RPC for runtime sidecars."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import subprocess
import time
from collections import deque
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, TypeVar

from candlescope_plugin_sdk import (
    AnalyzeRequest,
    AnalyzeResult,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    HandshakeRequest,
    HandshakeResult,
    JSONRPC_VERSION,
    KNOWN_FEATURES_V1,
    PROTOCOL_V1,
    ProtocolError,
    RuntimeDescriptor,
)
from candlescope_plugin_sdk.constants import (
    METHOD_ANALYZE,
    METHOD_DESCRIBE,
    METHOD_EXECUTE_BATCH,
    METHOD_HANDSHAKE,
    METHOD_SHUTDOWN,
)

from .errors import (
    PluginHostError,
    PluginRemoteError,
    PluginRequestError,
    PluginTransportError,
)
from .registry import RuntimeProcessSpec


STATE_DISABLED = "disabled"
STATE_STOPPED = "stopped"
STATE_STARTING = "starting"
STATE_READY = "ready"
STATE_STOPPING = "stopping"
STATE_FAILED = "failed"

_T = TypeVar("_T")

_SAFE_ENVIRONMENT_KEYS = frozenset(
    {
        "APPDATA",
        "COMSPEC",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WINDIR",
    }
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _plugin_environment(executable_directory: str) -> dict[str, str]:
    """Return a small inherited environment without ambient application secrets."""

    environment = {
        key.upper(): value
        for key, value in os.environ.items()
        if key.upper() in _SAFE_ENVIRONMENT_KEYS
    }
    inherited_path = environment.get("PATH", "")
    environment["PATH"] = (
        executable_directory
        if not inherited_path
        else executable_directory + os.pathsep + inherited_path
    )
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


class RuntimeSupervisor:
    """Own one sidecar session and serialize all requests sent to it."""

    def __init__(
        self,
        spec: RuntimeProcessSpec,
        *,
        host_name: str,
        host_version: str,
        host_features: tuple[str, ...] = KNOWN_FEATURES_V1,
    ) -> None:
        self.spec = spec
        self.host_name = host_name
        self.host_version = host_version
        self.host_features = tuple(host_features)
        if len(set(self.host_features)) != len(self.host_features):
            raise ValueError("host_features must not contain duplicates")

        self._state = STATE_STOPPED if spec.enabled else STATE_DISABLED
        self._lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._watch_task: asyncio.Task[None] | None = None
        self._stderr_tail = bytearray()
        self._descriptor: RuntimeDescriptor | None = None
        self._negotiated_features: tuple[str, ...] = ()
        self._generation = 0
        self._next_request_id = 1
        self._launch_attempts = 0
        self._restart_times: deque[float] = deque()
        self._recorded_failure_tokens: set[int] = set()
        self._start_count = 0
        self._restart_count = 0
        self._request_count = 0
        self._failure_count = 0
        self._remote_error_count = 0
        self._last_failure: dict[str, Any] | None = None
        self._last_remote_error: dict[str, Any] | None = None
        self._started_at: str | None = None
        self._last_request_at: str | None = None

    @property
    def runtime_id(self) -> str:
        return self.spec.runtime_id

    @property
    def state(self) -> str:
        return self._state

    async def start(self) -> RuntimeDescriptor:
        async with self._lock:
            return await self._ensure_started_locked()

    async def descriptor(self) -> RuntimeDescriptor:
        return await self.start()

    async def analyze(self, request: AnalyzeRequest) -> AnalyzeResult:
        if not isinstance(request, AnalyzeRequest):
            raise PluginRequestError(
                code="PLUGIN_REQUEST_INVALID",
                message="analyze requires an AnalyzeRequest value",
                runtime_id=self.runtime_id,
            )
        return await self._call(
            METHOD_ANALYZE,
            request.to_wire(),
            AnalyzeResult.from_wire,
            required_feature="source-analysis/1",
        )

    async def execute_batch(self, request: ExecuteBatchRequest) -> ExecuteBatchResult:
        if not isinstance(request, ExecuteBatchRequest):
            raise PluginRequestError(
                code="PLUGIN_REQUEST_INVALID",
                message="execute_batch requires an ExecuteBatchRequest value",
                runtime_id=self.runtime_id,
            )
        return await self._call(
            METHOD_EXECUTE_BATCH,
            request.to_wire(),
            ExecuteBatchResult.from_wire,
            required_feature="batch-execution/1",
        )

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _ensure_started_locked(self) -> RuntimeDescriptor:
        if not self.spec.enabled:
            raise PluginRequestError(
                code="PLUGIN_DISABLED",
                message=f"runtime {self.runtime_id!r} is disabled",
                runtime_id=self.runtime_id,
            )
        if (
            self._state == STATE_READY
            and self._process is not None
            and self._process.returncode is None
            and self._descriptor is not None
        ):
            return self._descriptor

        await self._cleanup_finished_process_locked()
        self._consume_launch_budget_locked()
        self._state = STATE_STARTING
        self._descriptor = None
        self._negotiated_features = ()
        self._stderr_tail.clear()
        self._generation += 1
        generation = self._generation

        try:
            self._validate_launch_target()
            process_kwargs: dict[str, Any] = {
                "stdin": asyncio.subprocess.PIPE,
                "stdout": asyncio.subprocess.PIPE,
                "stderr": asyncio.subprocess.PIPE,
                "cwd": str(self.spec.working_directory or self.spec.executable.parent),
                "env": _plugin_environment(str(self.spec.executable.parent)),
                "limit": self.spec.max_message_bytes + 1,
            }
            if os.name == "nt":
                process_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                process_kwargs["start_new_session"] = True
            self._process = await asyncio.create_subprocess_exec(
                *self.spec.command,
                **process_kwargs,
            )
            self._start_count += 1
            self._started_at = _utc_now()
            self._stderr_task = asyncio.create_task(
                self._drain_stderr(self._process),
                name=f"plugin-stderr:{self.runtime_id}:{generation}",
            )
            self._watch_task = asyncio.create_task(
                self._watch_process(self._process, generation),
                name=f"plugin-watch:{self.runtime_id}:{generation}",
            )

            handshake_raw = await self._request_locked(
                METHOD_HANDSHAKE,
                HandshakeRequest(
                    protocols=(PROTOCOL_V1,),
                    host_name=self.host_name,
                    host_version=self.host_version,
                    host_features=self.host_features,
                ).to_wire(),
                timeout=self.spec.startup_timeout_seconds,
            )
            handshake = self._parse_sdk_result(
                handshake_raw,
                HandshakeResult.from_wire,
                "handshake result",
            )
            self._validate_handshake(handshake)

            describe_raw = await self._request_locked(
                METHOD_DESCRIBE,
                {},
                timeout=self.spec.startup_timeout_seconds,
            )
            described = self._parse_sdk_result(
                describe_raw,
                RuntimeDescriptor.from_wire,
                "runtime descriptor",
            )
            if described != handshake.runtime:
                raise PluginTransportError(
                    code="PLUGIN_DESCRIPTOR_CHANGED",
                    message="runtime descriptor changed after handshake",
                    runtime_id=self.runtime_id,
                )
            await asyncio.sleep(0)
            if self._process is None or self._process.returncode is not None:
                raise self._exited_error(self._process)

            self._descriptor = described
            self._negotiated_features = handshake.negotiated_features
            self._state = STATE_READY
            return described
        except asyncio.CancelledError:
            error = PluginTransportError(
                code="PLUGIN_START_CANCELLED",
                message="runtime startup was cancelled",
                runtime_id=self.runtime_id,
            )
            await self._mark_failed_locked(error, generation)
            raise
        except PluginHostError as exc:
            await self._mark_failed_locked(exc, generation)
            raise
        except (OSError, ValueError) as exc:
            error = PluginTransportError(
                code="PLUGIN_START_FAILED",
                message=f"unable to start runtime: {exc}",
                runtime_id=self.runtime_id,
            )
            await self._mark_failed_locked(error, generation)
            raise error from exc

    def _consume_launch_budget_locked(self) -> None:
        now = time.monotonic()
        cutoff = now - self.spec.restart_window_seconds
        while self._restart_times and self._restart_times[0] < cutoff:
            self._restart_times.popleft()
        if self._launch_attempts:
            if len(self._restart_times) >= self.spec.max_restart_attempts:
                error = PluginRequestError(
                    code="PLUGIN_RESTART_LIMIT",
                    message=(
                        f"runtime restart limit reached: "
                        f"{self.spec.max_restart_attempts} attempts in "
                        f"{self.spec.restart_window_seconds:g} seconds"
                    ),
                    runtime_id=self.runtime_id,
                )
                self._state = STATE_FAILED
                self._record_failure(error, -self._launch_attempts - 1)
                raise error
            self._restart_times.append(now)
            self._restart_count += 1
        self._launch_attempts += 1

    def _validate_launch_target(self) -> None:
        if not self.spec.executable.is_file():
            raise PluginTransportError(
                code="PLUGIN_EXECUTABLE_MISSING",
                message="runtime executable does not exist or is not a file",
                runtime_id=self.runtime_id,
            )
        if os.name != "nt" and not os.access(self.spec.executable, os.X_OK):
            raise PluginTransportError(
                code="PLUGIN_EXECUTABLE_NOT_RUNNABLE",
                message="runtime executable is not executable",
                runtime_id=self.runtime_id,
            )
        working_directory = self.spec.working_directory or self.spec.executable.parent
        if not working_directory.is_dir():
            raise PluginTransportError(
                code="PLUGIN_WORKING_DIRECTORY_MISSING",
                message="runtime working directory does not exist",
                runtime_id=self.runtime_id,
            )

    def _validate_handshake(self, handshake: HandshakeResult) -> None:
        descriptor = handshake.runtime
        if descriptor.id != self.spec.runtime_id:
            raise PluginTransportError(
                code="PLUGIN_IDENTITY_MISMATCH",
                message=(
                    f"runtime declared id {descriptor.id!r}; "
                    f"expected {self.spec.runtime_id!r}"
                ),
                runtime_id=self.runtime_id,
            )
        if descriptor.package != self.spec.expected_package:
            raise PluginTransportError(
                code="PLUGIN_IDENTITY_MISMATCH",
                message=(
                    f"runtime declared package {descriptor.package!r}; "
                    f"expected {self.spec.expected_package!r}"
                ),
                runtime_id=self.runtime_id,
            )
        if descriptor.version != self.spec.expected_version:
            raise PluginTransportError(
                code="PLUGIN_IDENTITY_MISMATCH",
                message=(
                    f"runtime declared version {descriptor.version!r}; "
                    f"expected {self.spec.expected_version!r}"
                ),
                runtime_id=self.runtime_id,
            )
        expected_negotiated = tuple(
            feature for feature in descriptor.features if feature in self.host_features
        )
        if handshake.negotiated_features != expected_negotiated:
            raise PluginTransportError(
                code="PLUGIN_FEATURE_NEGOTIATION_INVALID",
                message="runtime returned an invalid negotiated feature set",
                runtime_id=self.runtime_id,
                details={
                    "expected": list(expected_negotiated),
                    "actual": list(handshake.negotiated_features),
                },
            )
        missing = sorted(
            set(descriptor.required_host_features) - set(handshake.negotiated_features)
        )
        if missing:
            raise PluginTransportError(
                code="PLUGIN_HOST_FEATURE_MISSING",
                message="runtime requires host features that were not negotiated",
                runtime_id=self.runtime_id,
                details={"missingFeatures": missing},
            )

    async def _call(
        self,
        method: str,
        params: dict[str, Any],
        parser: Callable[[Any], _T],
        *,
        required_feature: str,
    ) -> _T:
        async with self._lock:
            await self._ensure_started_locked()
            if required_feature not in self._negotiated_features:
                raise PluginRequestError(
                    code="PLUGIN_FEATURE_UNAVAILABLE",
                    message=f"runtime did not negotiate feature {required_feature!r}",
                    runtime_id=self.runtime_id,
                    details={"feature": required_feature},
                )
            try:
                raw = await self._request_locked(
                    method,
                    params,
                    timeout=self.spec.request_timeout_seconds,
                )
            except PluginRemoteError as exc:
                self._remote_error_count += 1
                self._last_remote_error = {**exc.to_dict(), "at": _utc_now()}
                raise
            except PluginRequestError:
                raise
            except asyncio.CancelledError:
                error = PluginTransportError(
                    code="PLUGIN_REQUEST_CANCELLED",
                    message="runtime request was cancelled; the session was discarded",
                    runtime_id=self.runtime_id,
                )
                await self._mark_failed_locked(error, self._generation)
                raise
            except PluginHostError as exc:
                await self._mark_failed_locked(exc, self._generation)
                raise

            try:
                return parser(raw)
            except ProtocolError as exc:
                error = PluginTransportError(
                    code="PLUGIN_RESULT_INVALID",
                    message=f"runtime returned an invalid {method} result: {exc.message}",
                    runtime_id=self.runtime_id,
                    details={"protocolCode": exc.code},
                )
                await self._mark_failed_locked(error, self._generation)
                raise error from exc

    async def _request_locked(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            raise PluginTransportError(
                code="PLUGIN_NOT_RUNNING",
                message="runtime process is not available",
                runtime_id=self.runtime_id,
            )
        if process.returncode is not None:
            raise self._exited_error(process)

        request_id = f"host-{self._generation}-{self._next_request_id}"
        self._next_request_id += 1
        request = {
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": method,
            "params": params,
        }
        try:
            encoded = json.dumps(
                request,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise PluginRequestError(
                code="PLUGIN_REQUEST_NOT_JSON",
                message=f"runtime request is not JSON-compatible: {exc}",
                runtime_id=self.runtime_id,
            ) from exc
        if len(encoded) > self.spec.max_message_bytes:
            raise PluginRequestError(
                code="PLUGIN_REQUEST_TOO_LARGE",
                message="runtime request exceeds the configured message limit",
                runtime_id=self.runtime_id,
                details={"maxMessageBytes": self.spec.max_message_bytes},
            )

        self._request_count += 1
        self._last_request_at = _utc_now()
        try:
            async with asyncio.timeout(timeout):
                process.stdin.write(encoded + b"\n")
                await process.stdin.drain()
                line = await process.stdout.readline()
        except TimeoutError as exc:
            raise PluginTransportError(
                code="PLUGIN_TIMEOUT",
                message=f"runtime did not answer {method!r} within {timeout:g} seconds",
                runtime_id=self.runtime_id,
                details={"method": method, "timeoutSeconds": timeout},
            ) from exc
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            raise PluginTransportError(
                code="PLUGIN_IO_FAILED",
                message=f"runtime transport failed during {method!r}: {exc}",
                runtime_id=self.runtime_id,
            ) from exc
        except ValueError as exc:
            raise PluginTransportError(
                code="PLUGIN_RESPONSE_TOO_LARGE",
                message="runtime response exceeds the configured message limit",
                runtime_id=self.runtime_id,
                details={"maxMessageBytes": self.spec.max_message_bytes},
            ) from exc

        if not line:
            raise self._exited_error(process)
        if not line.endswith(b"\n"):
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message="runtime response is not newline terminated",
                runtime_id=self.runtime_id,
            )
        message = line[:-1]
        if message.endswith(b"\r"):
            message = message[:-1]
        if len(message) > self.spec.max_message_bytes:
            raise PluginTransportError(
                code="PLUGIN_RESPONSE_TOO_LARGE",
                message="runtime response exceeds the configured message limit",
                runtime_id=self.runtime_id,
                details={"maxMessageBytes": self.spec.max_message_bytes},
            )
        try:
            response = json.loads(
                message.decode("utf-8"),
                parse_constant=_reject_json_constant,
                object_pairs_hook=_unique_json_object,
            )
        except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise PluginTransportError(
                code="PLUGIN_RESPONSE_INVALID_JSON",
                message="runtime response is not strict UTF-8 JSON",
                runtime_id=self.runtime_id,
            ) from exc
        return self._validate_response(response, request_id)

    def _validate_response(self, response: Any, request_id: str) -> Any:
        if not isinstance(response, Mapping):
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message="JSON-RPC response must be an object",
                runtime_id=self.runtime_id,
            )
        unknown = sorted(set(response) - {"jsonrpc", "id", "result", "error"})
        if unknown:
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message=f"JSON-RPC response contains unsupported fields: {', '.join(unknown)}",
                runtime_id=self.runtime_id,
            )
        if response.get("jsonrpc") != JSONRPC_VERSION:
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message=f"JSON-RPC response must use version {JSONRPC_VERSION}",
                runtime_id=self.runtime_id,
            )
        if response.get("id") != request_id or not isinstance(response.get("id"), str):
            raise PluginTransportError(
                code="PLUGIN_RESPONSE_ID_MISMATCH",
                message="runtime response id does not match the request id",
                runtime_id=self.runtime_id,
            )
        has_result = "result" in response
        has_error = "error" in response
        if has_result == has_error:
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message="JSON-RPC response must contain exactly one of result or error",
                runtime_id=self.runtime_id,
            )
        if has_result:
            return response["result"]

        error = response["error"]
        if not isinstance(error, Mapping):
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message="JSON-RPC error must be an object",
                runtime_id=self.runtime_id,
            )
        remote_code = error.get("code")
        remote_message = error.get("message")
        remote_data = error.get("data", {})
        if (
            isinstance(remote_code, bool)
            or not isinstance(remote_code, int)
            or not isinstance(remote_message, str)
            or not remote_message
            or not isinstance(remote_data, Mapping)
        ):
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message="JSON-RPC error has an invalid shape",
                runtime_id=self.runtime_id,
            )
        remote_symbol = remote_data.get("code")
        if remote_symbol is not None and not isinstance(remote_symbol, str):
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message="JSON-RPC symbolic error code must be a string",
                runtime_id=self.runtime_id,
            )
        raise PluginRemoteError(
            code="PLUGIN_RPC_ERROR",
            message=remote_message,
            runtime_id=self.runtime_id,
            details={
                "rpcCode": remote_code,
                **({"remoteCode": remote_symbol} if remote_symbol else {}),
                "data": dict(remote_data),
            },
        )

    def _parse_sdk_result(
        self,
        value: Any,
        parser: Callable[[Any], _T],
        label: str,
    ) -> _T:
        try:
            return parser(value)
        except ProtocolError as exc:
            raise PluginTransportError(
                code="PLUGIN_PROTOCOL_VIOLATION",
                message=f"invalid {label}: {exc.message}",
                runtime_id=self.runtime_id,
                details={"protocolCode": exc.code},
            ) from exc

    async def _drain_stderr(self, process: asyncio.subprocess.Process) -> None:
        if process.stderr is None:
            return
        while True:
            chunk = await process.stderr.read(4096)
            if not chunk:
                return
            self._stderr_tail.extend(chunk)
            overflow = len(self._stderr_tail) - self.spec.max_stderr_bytes
            if overflow > 0:
                del self._stderr_tail[:overflow]

    async def _watch_process(
        self,
        process: asyncio.subprocess.Process,
        generation: int,
    ) -> None:
        return_code = await process.wait()
        if self._process is not process or self._generation != generation:
            return
        if self._state in {STATE_STARTING, STATE_READY}:
            error = PluginTransportError(
                code="PLUGIN_EXITED",
                message=f"runtime exited unexpectedly with code {return_code}",
                runtime_id=self.runtime_id,
                details={"returnCode": return_code},
            )
            self._state = STATE_FAILED
            self._record_failure(error, generation)

    def _exited_error(
        self,
        process: asyncio.subprocess.Process | None,
    ) -> PluginTransportError:
        return_code = None if process is None else process.returncode
        return PluginTransportError(
            code="PLUGIN_EXITED",
            message=f"runtime exited unexpectedly with code {return_code}",
            runtime_id=self.runtime_id,
            details={"returnCode": return_code},
        )

    async def _mark_failed_locked(self, error: PluginHostError, token: int) -> None:
        self._state = STATE_FAILED
        self._record_failure(error, token)
        await self._terminate_process_locked()

    def _record_failure(self, error: PluginHostError, token: int) -> None:
        if token in self._recorded_failure_tokens:
            return
        self._recorded_failure_tokens.add(token)
        self._failure_count += 1
        self._last_failure = {**error.to_dict(), "at": _utc_now()}

    async def _cleanup_finished_process_locked(self) -> None:
        process = self._process
        if process is None:
            return
        if process.returncode is None:
            await self._terminate_process_locked()
        else:
            await self._finish_process_tasks_locked()

    async def _terminate_process_locked(self) -> None:
        process = self._process
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
        if process.returncode is None:
            self._signal_process(process, force=False)
            try:
                await asyncio.wait_for(process.wait(), timeout=0.5)
            except TimeoutError:
                self._signal_process(process, force=True)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=1.0)
        await self._finish_process_tasks_locked()

    async def _finish_process_tasks_locked(self) -> None:
        stderr_task = self._stderr_task
        watch_task = self._watch_task
        self._stderr_task = None
        self._watch_task = None
        if stderr_task is not None:
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(stderr_task, timeout=0.5)
        if watch_task is not None and watch_task is not asyncio.current_task():
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(watch_task, timeout=0.5)
        self._process = None

    @staticmethod
    def _signal_process(process: asyncio.subprocess.Process, *, force: bool) -> None:
        if process.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            elif force:
                process.kill()
            else:
                process.terminate()

    async def _stop_locked(self) -> None:
        process = self._process
        if process is None:
            self._state = STATE_STOPPED if self.spec.enabled else STATE_DISABLED
            return
        previous_state = self._state
        self._state = STATE_STOPPING
        shutdown_error: PluginHostError | None = None
        if process.returncode is None and previous_state == STATE_READY:
            try:
                result = await self._request_locked(
                    METHOD_SHUTDOWN,
                    {},
                    timeout=self.spec.shutdown_timeout_seconds,
                )
                if result != {"ok": True}:
                    raise PluginTransportError(
                        code="PLUGIN_SHUTDOWN_INVALID",
                        message="runtime returned an invalid shutdown result",
                        runtime_id=self.runtime_id,
                    )
                await asyncio.wait_for(
                    process.wait(),
                    timeout=self.spec.shutdown_timeout_seconds,
                )
            except asyncio.CancelledError:
                shutdown_error = PluginTransportError(
                    code="PLUGIN_SHUTDOWN_CANCELLED",
                    message="runtime shutdown was cancelled",
                    runtime_id=self.runtime_id,
                )
            except TimeoutError:
                shutdown_error = PluginTransportError(
                    code="PLUGIN_SHUTDOWN_TIMEOUT",
                    message="runtime did not exit within the shutdown timeout",
                    runtime_id=self.runtime_id,
                )
            except PluginHostError as exc:
                shutdown_error = exc
        if shutdown_error is not None:
            self._record_failure(shutdown_error, self._generation)
        await self._terminate_process_locked()
        self._state = STATE_STOPPED if self.spec.enabled else STATE_DISABLED

    def snapshot(self, *, include_stderr: bool = False) -> dict[str, Any]:
        process = self._process
        if (
            process is not None
            and process.returncode is not None
            and self._state in {STATE_STARTING, STATE_READY}
        ):
            error = self._exited_error(process)
            self._state = STATE_FAILED
            self._record_failure(error, self._generation)
        descriptor = self._descriptor
        return {
            "id": self.runtime_id,
            "state": self._state,
            "enabled": self.spec.enabled,
            "autoStart": self.spec.auto_start,
            "required": self.spec.required,
            "expected": {
                "package": self.spec.expected_package,
                "version": self.spec.expected_version,
                "protocol": PROTOCOL_V1,
            },
            "pid": (
                process.pid
                if process is not None and process.returncode is None
                else None
            ),
            "generation": self._generation,
            "starts": self._start_count,
            "restarts": self._restart_count,
            "requests": self._request_count,
            "failures": self._failure_count,
            "remoteErrors": self._remote_error_count,
            "startedAt": self._started_at,
            "lastRequestAt": self._last_request_at,
            "negotiatedFeatures": list(self._negotiated_features),
            "descriptor": descriptor.to_wire() if descriptor is not None else None,
            "lastFailure": dict(self._last_failure) if self._last_failure else None,
            "lastRemoteError": (
                dict(self._last_remote_error) if self._last_remote_error else None
            ),
            **(
                {"stderrTail": self._stderr_tail.decode("utf-8", errors="replace")}
                if include_stderr
                else {}
            ),
        }
