"""Concurrent bidirectional JSON-RPC transport for Plugin Platform v2."""

from __future__ import annotations

import asyncio
import contextlib
import math
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    HostCallRequest,
    JsonLimits,
    PlatformContractError,
    RpcError,
    RpcFailure,
    RpcRequest,
    RpcSuccess,
    canonical_dumps,
    loads_strict,
    normalize_json,
    parse_rpc_frame,
)
from candlescope_plugin_sdk.platform_v2.constants import (
    METHOD_CANCEL,
    METHOD_HOST_CALL,
    RPC_CAPABILITY_INVALID,
    RPC_GENERATION_MISMATCH,
    RPC_INTERNAL_ERROR,
    RPC_INVALID_PARAMS,
    RPC_METHOD_NOT_FOUND,
)

from .errors import (
    PlatformHostError,
    PlatformHostRemoteError,
    PlatformHostRequestError,
    PlatformHostTransportError,
)
from .framing import JsonLineError
from .process import ManagedSidecarProcess, SidecarProcessSpec


HostCallHandler = Callable[[HostCallRequest], Awaitable[dict[str, Any]]]


def _wasmtime_exit_failure(stderr: str) -> tuple[str, str] | None:
    normalized = stderr.casefold()
    if "all fuel consumed by webassembly" in normalized:
        return (
            "PLUGIN_WASM_FUEL_EXHAUSTED",
            "WASM component exhausted its Host-owned process fuel budget",
        )
    if any(
        marker in normalized
        for marker in (
            "forcing trap when growing memory",
            "failed to grow memory",
            "memory allocation of",
            "cannot grow memory",
        )
    ):
        return (
            "PLUGIN_WASM_MEMORY_LIMIT_EXCEEDED",
            "WASM component exceeded its Host-owned linear-memory budget",
        )
    if "wasm trap:" in normalized or "failed to invoke `run` function" in normalized:
        return (
            "PLUGIN_WASM_TRAP",
            "WASM component trapped while executing wasi:cli/run",
        )
    return None


@dataclass(slots=True)
class _PendingRequest:
    request_id: str
    method: str
    generation: int
    future: asyncio.Future[dict[str, Any]]


class PlatformV2Transport:
    """Own one process connection with a dedicated reader and serialized writer."""

    def __init__(
        self,
        process_spec: SidecarProcessSpec,
        *,
        plugin_id: str,
        entrypoint_id: str,
        host_call_handler: HostCallHandler | None = None,
        max_in_flight: int = 32,
        max_host_calls: int = 8,
    ) -> None:
        if (
            isinstance(max_in_flight, bool)
            or not isinstance(max_in_flight, int)
            or max_in_flight < 1
            or max_in_flight > 1024
        ):
            raise ValueError("max_in_flight is outside the supported range")
        if (
            isinstance(max_host_calls, bool)
            or not isinstance(max_host_calls, int)
            or max_host_calls < 1
            or max_host_calls > max_in_flight
        ):
            raise ValueError("max_host_calls is outside the supported range")
        self.process_spec = process_spec
        self.plugin_id = plugin_id
        self.entrypoint_id = entrypoint_id
        self.max_in_flight = max_in_flight
        self.max_host_calls = max_host_calls
        self._host_call_handler = host_call_handler or self._deny_host_call
        self._process = ManagedSidecarProcess(process_spec)
        self._limits = JsonLimits(max_message_bytes=process_spec.max_message_bytes)
        self._reader_task: asyncio.Task[None] | None = None
        self._termination_task: asyncio.Task[None] | None = None
        self._pending: dict[str, _PendingRequest] = {}
        self._incoming_ids: set[str | int] = set()
        self._host_tasks: set[asyncio.Task[None]] = set()
        self._cancel_tasks: set[asyncio.Task[None]] = set()
        self._tombstones: deque[str] = deque()
        self._tombstone_set: set[str] = set()
        self._next_request_id = 1
        self._active_generation = 0
        self._closing = False
        self._expect_eof = False
        self._fatal_error: PlatformHostTransportError | None = None
        self._late_response_count = 0
        self._host_call_count = 0
        self._request_count = 0

    @property
    def process(self) -> asyncio.subprocess.Process | None:
        return self._process.process

    @property
    def active_generation(self) -> int:
        return self._active_generation

    @property
    def fatal_error(self) -> PlatformHostTransportError | None:
        return self._fatal_error

    @property
    def stderr_tail(self) -> str:
        return self._process.stderr_tail

    def set_active_generation(self, generation: int) -> None:
        if (
            isinstance(generation, bool)
            or not isinstance(generation, int)
            or generation < 0
        ):
            raise ValueError("generation must be a non-negative integer")
        self._active_generation = generation

    async def start(self) -> None:
        if self._reader_task is not None:
            raise RuntimeError("transport has already been started")
        await self._process.start()
        self._reader_task = asyncio.create_task(
            self._reader_loop(),
            name=f"plugin-host-reader:{self.plugin_id}:{self.entrypoint_id}",
        )

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        generation: int,
        timeout: float,
        send_cancel_on_cancel: bool = True,
    ) -> dict[str, Any]:
        if not isinstance(method, str) or not method:
            raise PlatformHostRequestError(
                code="PLUGIN_PLATFORM_REQUEST_INVALID",
                message="method must be a non-empty string",
                plugin_id=self.plugin_id,
                entrypoint_id=self.entrypoint_id,
            )
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise ValueError("timeout must be positive")
        self._require_usable()
        if len(self._pending) >= self.max_in_flight:
            raise PlatformHostRequestError(
                code="PLUGIN_PLATFORM_IN_FLIGHT_LIMIT",
                message="entrypoint reached its bounded in-flight request limit",
                plugin_id=self.plugin_id,
                entrypoint_id=self.entrypoint_id,
                details={"maxInFlight": self.max_in_flight},
            )
        request_id = f"host:{self._next_request_id}"
        self._next_request_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        pending = _PendingRequest(request_id, method, generation, future)
        self._pending[request_id] = pending
        self._request_count += 1
        try:
            await self._write_frame(
                RpcRequest(
                    id=request_id,
                    method=method,
                    params=params,
                    generation=generation,
                )
            )
        except asyncio.CancelledError:
            self._cancel_pending_request(
                request_id,
                method=method,
                generation=generation,
                send_cancel=send_cancel_on_cancel,
            )
            raise
        except BaseException:
            removed = self._pending.pop(request_id, None)
            if removed is not None and not removed.future.done():
                removed.future.cancel()
            raise
        try:
            result = await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
            # The stderr drainer and stdout reader are independent tasks. A
            # sidecar can fill stderr before reading the request yet race a
            # successful stdout response ahead of the drainer on a busy loop.
            # Yield once so an already-buffered overflow is observed before a
            # business result crosses the Host boundary.
            await asyncio.sleep(0)
            if self._process.stderr_overflow:
                error = PlatformHostTransportError(
                    code="PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
                    message="plugin process exceeded its bounded stderr budget",
                    plugin_id=self.plugin_id,
                    entrypoint_id=self.entrypoint_id,
                    details={"maxStderrBytes": self.process_spec.max_stderr_bytes},
                    fatal=True,
                )
                self._fail(error)
                raise error
            if self._fatal_error is not None:
                raise self._fatal_error
            return result
        except asyncio.CancelledError:
            self._cancel_pending_request(
                request_id,
                method=method,
                generation=generation,
                send_cancel=send_cancel_on_cancel,
            )
            raise
        except TimeoutError as exc:
            removed = self._pending.pop(request_id, None)
            if removed is not None:
                if not removed.future.done():
                    removed.future.cancel()
                self._remember_tombstone(request_id)
            error = PlatformHostTransportError(
                code="PLUGIN_PLATFORM_TIMEOUT",
                message=f"plugin did not answer {method!r} within {timeout:g} seconds",
                plugin_id=self.plugin_id,
                entrypoint_id=self.entrypoint_id,
                details={"method": method, "timeoutSeconds": timeout},
                fatal=True,
            )
            self._fail(error)
            raise error from exc

    def _cancel_pending_request(
        self,
        request_id: str,
        *,
        method: str,
        generation: int,
        send_cancel: bool,
    ) -> None:
        pending = self._pending.pop(request_id, None)
        if pending is None:
            return
        if not pending.future.done():
            pending.future.cancel()
        self._remember_tombstone(request_id)
        if self.process_spec.terminate_on_cancel and method != METHOD_CANCEL:
            self._fail(
                PlatformHostTransportError(
                    code="PLUGIN_WASM_CANCELLED",
                    message="WASM invocation was cancelled by terminating its isolated process",
                    plugin_id=self.plugin_id,
                    entrypoint_id=self.entrypoint_id,
                    details={"method": method, "requestId": request_id},
                    fatal=True,
                )
            )
            return
        if not send_cancel or generation < 1 or method == METHOD_CANCEL:
            return
        task = asyncio.create_task(
            self._send_cancel(request_id, generation),
            name=f"plugin-host-cancel:{self.plugin_id}:{request_id}",
        )
        self._cancel_tasks.add(task)
        task.add_done_callback(self._on_cancel_task_done)

    async def _send_cancel(self, request_id: str, generation: int) -> None:
        try:
            await self.request(
                METHOD_CANCEL,
                {"requestId": request_id},
                generation=generation,
                timeout=1.0,
                send_cancel_on_cancel=False,
            )
        except (asyncio.CancelledError, PlatformHostError):
            return

    def expect_process_exit(self) -> None:
        self._expect_eof = True

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        error = PlatformHostTransportError(
            code="PLUGIN_PLATFORM_SESSION_CLOSED",
            message="plugin transport session closed",
            plugin_id=self.plugin_id,
            entrypoint_id=self.entrypoint_id,
            fatal=True,
        )
        self._fail_pending(error)
        current = asyncio.current_task()
        tasks = tuple(
            task
            for task in tuple(self._host_tasks) + tuple(self._cancel_tasks)
            if task is not current
        )
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=0.5)
        await self._process.terminate()
        reader_task = self._reader_task
        self._reader_task = None
        if reader_task is not None and reader_task is not asyncio.current_task():
            reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(reader_task, timeout=0.5)
        termination_task = self._termination_task
        self._termination_task = None
        if (
            termination_task is not None
            and termination_task is not asyncio.current_task()
        ):
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(termination_task, timeout=1.5)

    async def _reader_loop(self) -> None:
        connection = self._process.connection
        if connection is None:
            self._fail(
                PlatformHostTransportError(
                    code="PLUGIN_PLATFORM_NOT_RUNNING",
                    message="plugin process connection is unavailable",
                    plugin_id=self.plugin_id,
                    entrypoint_id=self.entrypoint_id,
                    fatal=True,
                )
            )
            return
        try:
            while True:
                payload = await connection.read()
                value = loads_strict(payload, limits=self._limits)
                frame = parse_rpc_frame(value)
                if isinstance(frame, RpcRequest):
                    self._accept_host_call(frame)
                else:
                    self._accept_response(frame)
                if self._fatal_error is not None:
                    return
        except asyncio.CancelledError:
            raise
        except JsonLineError as exc:
            if self._closing or (exc.code == "EOF" and self._expect_eof):
                return
            if exc.code == "EOF":
                await self._process.settle_stderr()
                if self._process.stderr_overflow:
                    self._fail(
                        PlatformHostTransportError(
                            code="PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
                            message=(
                                "plugin process exceeded its bounded stderr budget"
                            ),
                            plugin_id=self.plugin_id,
                            entrypoint_id=self.entrypoint_id,
                            details={
                                "maxStderrBytes": self.process_spec.max_stderr_bytes
                            },
                            fatal=True,
                        )
                    )
                    return
                if self.process_spec.failure_classifier == "wasmtime-v1":
                    classified = _wasmtime_exit_failure(self._process.stderr_tail)
                    if classified is not None:
                        process = self._process.process
                        self._fail(
                            PlatformHostTransportError(
                                code=classified[0],
                                message=classified[1],
                                plugin_id=self.plugin_id,
                                entrypoint_id=self.entrypoint_id,
                                details={
                                    "classifier": "wasmtime-v1",
                                    "returnCode": (
                                        process.returncode
                                        if process is not None
                                        else None
                                    ),
                                },
                                fatal=True,
                            )
                        )
                        return
            code = {
                "MESSAGE_TOO_LARGE": "PLUGIN_PLATFORM_RESPONSE_TOO_LARGE",
                "INVALID_JSON": "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON",
                "NOT_TERMINATED": "PLUGIN_PLATFORM_PROTOCOL_VIOLATION",
                "EOF": "PLUGIN_PLATFORM_EXITED",
                "IO_FAILED": "PLUGIN_PLATFORM_IO_FAILED",
            }.get(exc.code, "PLUGIN_PLATFORM_PROTOCOL_VIOLATION")
            self._fail(
                PlatformHostTransportError(
                    code=code,
                    message=exc.message,
                    plugin_id=self.plugin_id,
                    entrypoint_id=self.entrypoint_id,
                    fatal=True,
                )
            )
        except PlatformContractError as exc:
            if not self._closing:
                invalid_json_codes = {
                    "DUPLICATE_JSON_KEY",
                    "INVALID_JSON",
                    "INVALID_UNICODE",
                    "INVALID_UTF8",
                    "NON_FINITE_NUMBER",
                    "UNSAFE_INTEGER",
                }
                self._fail(
                    PlatformHostTransportError(
                        code=(
                            "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON"
                            if exc.code in invalid_json_codes
                            else "PLUGIN_PLATFORM_PROTOCOL_VIOLATION"
                        ),
                        message="plugin emitted an invalid Plugin Platform frame",
                        plugin_id=self.plugin_id,
                        entrypoint_id=self.entrypoint_id,
                        details={"contractCode": exc.code, "path": exc.path},
                        fatal=True,
                    )
                )
        except Exception as exc:
            if not self._closing:
                self._fail(
                    PlatformHostTransportError(
                        code="PLUGIN_PLATFORM_READER_FAILED",
                        message="plugin reader failed unexpectedly",
                        plugin_id=self.plugin_id,
                        entrypoint_id=self.entrypoint_id,
                        details={"exceptionType": type(exc).__name__},
                        fatal=True,
                    )
                )

    def _accept_response(self, response: RpcSuccess | RpcFailure) -> None:
        if not isinstance(response.id, str):
            self._fail_protocol("plugin response id must be a Host string id")
            return
        pending = self._pending.get(response.id)
        if pending is None:
            if response.id in self._tombstone_set:
                self._late_response_count += 1
                return
            self._fail_protocol(
                "plugin response id does not match an in-flight request"
            )
            return
        if response.generation != pending.generation:
            self._fail_protocol(
                "plugin response generation does not match its in-flight request",
                details={
                    "requestId": response.id,
                    "expectedGeneration": pending.generation,
                    "actualGeneration": response.generation,
                },
            )
            return
        self._pending.pop(response.id, None)
        if isinstance(response, RpcFailure):
            pending.future.set_exception(
                PlatformHostRemoteError(
                    code="PLUGIN_PLATFORM_RPC_ERROR",
                    message=response.error.message,
                    plugin_id=self.plugin_id,
                    entrypoint_id=self.entrypoint_id,
                    details={
                        "rpcCode": response.error.rpc_code,
                        "remoteCode": response.error.code,
                        "data": dict(response.error.data),
                        "method": pending.method,
                    },
                )
            )
        else:
            pending.future.set_result(dict(response.result))

    def _accept_host_call(self, request: RpcRequest) -> None:
        if request.id in self._incoming_ids:
            self._fail_protocol(
                "plugin reused an in-flight Host call id",
                details={"requestId": request.id},
            )
            return
        if len(self._incoming_ids) >= self.max_host_calls:
            self._fail_protocol(
                "plugin exceeded the bounded concurrent Host call limit",
                details={"maxHostCalls": self.max_host_calls},
            )
            return
        self._incoming_ids.add(request.id)
        task = asyncio.create_task(
            self._handle_host_call(request),
            name=f"plugin-host-call:{self.plugin_id}:{request.id}",
        )
        self._track_host_task(task)

    def _track_host_task(self, task: asyncio.Task[None]) -> None:
        self._host_tasks.add(task)
        task.add_done_callback(self._on_host_task_done)

    def _on_host_task_done(self, task: asyncio.Task[None]) -> None:
        self._host_tasks.discard(task)
        if not task.cancelled():
            task.exception()

    def _on_cancel_task_done(self, task: asyncio.Task[None]) -> None:
        self._cancel_tasks.discard(task)
        if not task.cancelled():
            task.exception()

    async def _handle_host_call(self, request: RpcRequest) -> None:
        try:
            if request.method != METHOD_HOST_CALL:
                await self._write_failure(
                    request,
                    rpc_code=RPC_METHOD_NOT_FOUND,
                    code="METHOD_NOT_FOUND",
                    message="plugin may only initiate host.call requests",
                )
                return
            if not self._host_call_is_current(request):
                await self._write_failure(
                    request,
                    rpc_code=RPC_GENERATION_MISMATCH,
                    code="GENERATION_MISMATCH",
                    message="host.call does not belong to the active generation",
                )
                return
            try:
                call = HostCallRequest.from_wire(request.params)
            except PlatformContractError as exc:
                await self._write_failure(
                    request,
                    rpc_code=RPC_INVALID_PARAMS,
                    code=exc.code,
                    message=exc.message,
                    data={"path": exc.path} if exc.path else {},
                )
                return
            if call.request_context.generation != request.generation:
                await self._write_failure(
                    request,
                    rpc_code=RPC_GENERATION_MISMATCH,
                    code="GENERATION_MISMATCH",
                    message="host.call requestContext generation does not match the envelope",
                )
                return
            self._host_call_count += 1
            try:
                result = normalize_json(
                    await self._host_call_handler(call),
                    path="host.call.result",
                )
                if not isinstance(result, dict):
                    raise PlatformContractError(
                        "INVALID_CONTRACT",
                        "Host call handler must return an object",
                        "host.call.result",
                    )
                if not self._host_call_is_current(request):
                    return
                await self._write_frame(
                    RpcSuccess(request.id, result, request.generation)
                )
            except PlatformHostError as exc:
                if not self._host_call_is_current(request):
                    return
                await self._write_failure(
                    request,
                    rpc_code=RPC_CAPABILITY_INVALID,
                    code=exc.code,
                    message=exc.message,
                    data=exc.details,
                )
            except PlatformContractError as exc:
                if not self._host_call_is_current(request):
                    return
                await self._write_failure(
                    request,
                    rpc_code=RPC_INTERNAL_ERROR,
                    code=exc.code,
                    message="Host call handler returned an invalid result",
                    data={"path": exc.path} if exc.path else {},
                )
            except Exception:
                if not self._host_call_is_current(request):
                    return
                await self._write_failure(
                    request,
                    rpc_code=RPC_INTERNAL_ERROR,
                    code="INTERNAL_ERROR",
                    message="Host call handler failed unexpectedly",
                )
        finally:
            self._incoming_ids.discard(request.id)

    def _host_call_is_current(self, request: RpcRequest) -> bool:
        return (
            self._active_generation > 0
            and request.generation == self._active_generation
        )

    async def _write_failure(
        self,
        request: RpcRequest,
        *,
        rpc_code: int,
        code: str,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        await self._write_frame(
            RpcFailure(
                request.id,
                RpcError(
                    rpc_code=rpc_code, message=message, code=code, data=data or {}
                ),
                request.generation,
            )
        )

    async def _write_frame(self, frame: RpcRequest | RpcSuccess | RpcFailure) -> None:
        self._require_usable()
        connection = self._process.connection
        if connection is None:
            raise PlatformHostTransportError(
                code="PLUGIN_PLATFORM_NOT_RUNNING",
                message="plugin process connection is unavailable",
                plugin_id=self.plugin_id,
                entrypoint_id=self.entrypoint_id,
                fatal=True,
            )
        try:
            payload = canonical_dumps(frame.to_wire(), limits=self._limits).encode(
                "utf-8"
            )
            await connection.write(payload)
        except (JsonLineError, PlatformContractError) as exc:
            error = PlatformHostTransportError(
                code="PLUGIN_PLATFORM_WRITE_FAILED",
                message="unable to write a bounded Plugin Platform frame",
                plugin_id=self.plugin_id,
                entrypoint_id=self.entrypoint_id,
                details={"cause": getattr(exc, "code", type(exc).__name__)},
                fatal=True,
            )
            self._fail(error)
            raise error from exc

    async def _deny_host_call(self, call: HostCallRequest) -> dict[str, Any]:
        raise PlatformHostRequestError(
            code="CAPABILITY_HANDLE_INVALID",
            message="no Host API capabilities are available for this entrypoint",
            plugin_id=self.plugin_id,
            entrypoint_id=self.entrypoint_id,
            details={"method": call.method},
        )

    def _require_usable(self) -> None:
        if self._fatal_error is not None:
            raise self._fatal_error
        process = self._process.process
        if self._closing or process is None or process.returncode is not None:
            raise PlatformHostTransportError(
                code="PLUGIN_PLATFORM_NOT_RUNNING",
                message="plugin transport is not running",
                plugin_id=self.plugin_id,
                entrypoint_id=self.entrypoint_id,
                fatal=True,
            )

    def _fail_protocol(
        self, message: str, *, details: dict[str, Any] | None = None
    ) -> None:
        self._fail(
            PlatformHostTransportError(
                code="PLUGIN_PLATFORM_PROTOCOL_VIOLATION",
                message=message,
                plugin_id=self.plugin_id,
                entrypoint_id=self.entrypoint_id,
                details=details or {},
                fatal=True,
            )
        )

    def _fail(self, error: PlatformHostTransportError) -> None:
        if self._fatal_error is not None or self._closing:
            return
        self._fatal_error = error
        self._fail_pending(error)
        if self._termination_task is None:
            self._termination_task = asyncio.create_task(
                self._process.terminate(),
                name=f"plugin-host-terminate:{self.plugin_id}:{self.entrypoint_id}",
            )

    def _fail_pending(self, error: PlatformHostTransportError) -> None:
        for request_id, pending in tuple(self._pending.items()):
            self._remember_tombstone(request_id)
            if not pending.future.done():
                pending.future.set_exception(error)
        self._pending.clear()

    def _remember_tombstone(self, request_id: str) -> None:
        if request_id in self._tombstone_set:
            return
        self._tombstones.append(request_id)
        self._tombstone_set.add(request_id)
        while len(self._tombstones) > 1024:
            expired = self._tombstones.popleft()
            self._tombstone_set.discard(expired)

    def snapshot(self, *, include_stderr: bool = False) -> dict[str, Any]:
        process = self._process.process
        return {
            "pid": (
                process.pid
                if process is not None and process.returncode is None
                else None
            ),
            "activeGeneration": self._active_generation,
            "pending": len(self._pending),
            "hostCallsPending": len(self._incoming_ids),
            "requests": self._request_count,
            "hostCalls": self._host_call_count,
            "lateResponses": self._late_response_count,
            "processTreeControl": self._process.process_tree_control_active,
            "fatalError": self._fatal_error.to_dict() if self._fatal_error else None,
            **({"stderrTail": self.stderr_tail} if include_stderr else {}),
        }
