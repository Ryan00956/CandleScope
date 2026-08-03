"""Shared safe process launch and termination for sidecar protocols."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.plugin_security_v2.sandbox import SandboxPolicy, prepare_sandbox_launch

from .framing import AsyncJsonLineConnection
from .windows_job import CREATE_SUSPENDED, WindowsJobController


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
_TRUST_LEVELS = frozenset({"first-party-pinned", "local-trusted", "untrusted"})
_WINDOWS_JOBS: dict[int, WindowsJobController] = {}


def _windows_extended_path(path: Path) -> str:
    value = str(path)
    if os.name != "nt" or len(value) < 248 or value.startswith("\\\\?\\"):
        return value
    if value.startswith("\\\\"):
        return "\\\\?\\UNC\\" + value.lstrip("\\")
    return "\\\\?\\" + value


def plugin_environment(
    executable_directory: str,
    *,
    isolated_search_path: bool = False,
) -> dict[str, str]:
    """Return the minimal inherited environment shared by all sidecars."""

    environment = {
        key.upper(): value
        for key, value in os.environ.items()
        if key.upper() in _SAFE_ENVIRONMENT_KEYS
    }
    inherited_path = environment.get("PATH", "")
    environment["PATH"] = (
        executable_directory
        if isolated_search_path or not inherited_path
        else executable_directory + os.pathsep + inherited_path
    )
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


@dataclass(frozen=True, slots=True)
class SidecarProcessSpec:
    identity: str
    executable: Path
    arguments: tuple[str, ...] = ()
    working_directory: Path | None = None
    max_message_bytes: int = 1024 * 1024
    max_stderr_bytes: int = 64 * 1024
    sandbox_policy: SandboxPolicy | None = None
    trust_level: str = "local-trusted"
    manage_process_tree: bool = False
    isolated_search_path: bool = False
    max_processes: int = 1

    def __post_init__(self) -> None:
        if (
            not isinstance(self.identity, str)
            or not self.identity
            or len(self.identity) > 256
        ):
            raise ValueError("identity must be a non-empty string")
        executable = Path(self.executable).resolve(strict=False)
        working_directory = (
            Path(self.working_directory).resolve(strict=False)
            if self.working_directory is not None
            else None
        )
        if isinstance(self.arguments, (str, bytes)):
            raise ValueError("arguments must be a tuple of non-empty strings")
        arguments = tuple(self.arguments)
        if not all(isinstance(item, str) and item for item in arguments):
            raise ValueError("arguments must contain non-empty strings")
        for name, lower, upper in (
            ("max_message_bytes", 1024, 16 * 1024 * 1024),
            ("max_stderr_bytes", 1024, 4 * 1024 * 1024),
        ):
            value = getattr(self, name)
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not lower <= value <= upper
            ):
                raise ValueError(f"{name} is outside the supported range")
        object.__setattr__(self, "executable", executable)
        object.__setattr__(self, "working_directory", working_directory)
        object.__setattr__(self, "arguments", arguments)
        if self.sandbox_policy is not None and not isinstance(
            self.sandbox_policy, SandboxPolicy
        ):
            raise ValueError("sandbox_policy must be a SandboxPolicy")
        if (
            not isinstance(self.trust_level, str)
            or self.trust_level not in _TRUST_LEVELS
        ):
            raise ValueError("trust_level is unsupported")
        if self.trust_level == "untrusted" and self.sandbox_policy is None:
            raise ValueError("untrusted sidecars require an OS sandbox policy")
        if not isinstance(self.manage_process_tree, bool):
            raise ValueError("manage_process_tree must be a boolean")
        if not isinstance(self.isolated_search_path, bool):
            raise ValueError("isolated_search_path must be a boolean")
        if (
            isinstance(self.max_processes, bool)
            or not isinstance(self.max_processes, int)
            or not 1 <= self.max_processes <= 32
        ):
            raise ValueError("max_processes is outside the supported range")

    @property
    def command(self) -> tuple[str, ...]:
        return (str(self.executable), *self.arguments)


def validate_launch_target(spec: SidecarProcessSpec) -> None:
    if not spec.executable.is_file():
        raise FileNotFoundError("sidecar executable does not exist or is not a file")
    if os.name != "nt" and not os.access(spec.executable, os.X_OK):
        raise PermissionError("sidecar executable is not executable")
    working_directory = spec.working_directory or spec.executable.parent
    if not working_directory.is_dir():
        raise FileNotFoundError("sidecar working directory does not exist")


async def launch_sidecar_process(
    spec: SidecarProcessSpec,
) -> asyncio.subprocess.Process:
    validate_launch_target(spec)
    command = spec.command
    working_directory = spec.working_directory or spec.executable.parent
    environment = plugin_environment(
        str(spec.executable.parent),
        isolated_search_path=spec.isolated_search_path,
    )
    if spec.sandbox_policy is not None:
        prepared = prepare_sandbox_launch(
            spec.sandbox_policy,
            command,
            working_directory,
        )
        command = prepared.command
        working_directory = prepared.working_directory
        environment = prepared.environment
    if os.name == "nt":
        command = (
            _windows_extended_path(Path(command[0]).resolve(strict=False)),
            *command[1:],
        )
    process_kwargs: dict[str, Any] = {
        "stdin": asyncio.subprocess.PIPE,
        "stdout": asyncio.subprocess.PIPE,
        "stderr": asyncio.subprocess.PIPE,
        "cwd": _windows_extended_path(working_directory),
        "env": environment,
        "limit": spec.max_message_bytes + 1,
    }
    if os.name == "nt":
        process_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        # Passing lpApplicationName explicitly is required for executable paths
        # beyond MAX_PATH; otherwise CreateProcessW reparses argv[0] and fails
        # with WinError 206 even when the path uses the extended-length prefix.
        process_kwargs["executable"] = command[0]
        if spec.manage_process_tree and spec.sandbox_policy is None:
            process_kwargs["creationflags"] |= CREATE_SUSPENDED
    else:
        process_kwargs["start_new_session"] = True
    process = await asyncio.create_subprocess_exec(*command, **process_kwargs)
    if os.name == "nt" and spec.manage_process_tree and spec.sandbox_policy is None:
        try:
            controller = WindowsJobController.attach_and_resume(
                process.pid,
                max_processes=spec.max_processes,
            )
        except BaseException:
            with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
                process.kill()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), timeout=5.0)
            raise
        _WINDOWS_JOBS[process.pid] = controller
    return process


def signal_process(process: asyncio.subprocess.Process, *, force: bool) -> None:
    if process.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        elif force:
            controller = _WINDOWS_JOBS.get(process.pid)
            if controller is not None:
                controller.terminate()
            else:
                process.kill()
        else:
            process.terminate()


def _release_windows_job(process: asyncio.subprocess.Process) -> None:
    controller = _WINDOWS_JOBS.pop(process.pid, None)
    if controller is not None:
        with contextlib.suppress(OSError):
            controller.close()


class ManagedSidecarProcess:
    """Own a launched process, bounded stderr, and its JSONL connection."""

    def __init__(self, spec: SidecarProcessSpec) -> None:
        self.spec = spec
        self.process: asyncio.subprocess.Process | None = None
        self.connection: AsyncJsonLineConnection | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr_tail = bytearray()
        self._stderr_total = 0
        self._stderr_overflow = False
        self._terminate_lock = asyncio.Lock()

    @property
    def stderr_tail(self) -> str:
        return self._stderr_tail.decode("utf-8", errors="replace")

    @property
    def stderr_overflow(self) -> bool:
        return self._stderr_overflow

    @property
    def process_tree_control_active(self) -> bool:
        process = self.process
        if process is None:
            return False
        return (
            self.spec.sandbox_policy is not None
            or process.pid in _WINDOWS_JOBS
            or os.name != "nt"
        )

    async def settle_stderr(self, *, timeout_seconds: float = 0.1) -> None:
        """Let a terminating pipe drainer publish overflow before EOF is classified."""

        task = self._stderr_task
        if task is None or task.done():
            return
        with contextlib.suppress(asyncio.CancelledError, TimeoutError):
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout_seconds)

    async def start(self) -> asyncio.subprocess.Process:
        if self.process is not None and self.process.returncode is None:
            raise RuntimeError("sidecar process is already running")
        self._stderr_tail.clear()
        self._stderr_total = 0
        self._stderr_overflow = False
        process = await launch_sidecar_process(self.spec)
        if process.stdin is None or process.stdout is None:
            signal_process(process, force=True)
            _release_windows_job(process)
            raise RuntimeError("sidecar process did not expose control pipes")
        self.process = process
        self.connection = AsyncJsonLineConnection(
            process.stdout,
            process.stdin,
            max_message_bytes=self.spec.max_message_bytes,
        )
        self._stderr_task = asyncio.create_task(
            self._drain_stderr(process),
            name=f"plugin-host-stderr:{self.spec.identity}",
        )
        return process

    async def _drain_stderr(self, process: asyncio.subprocess.Process) -> None:
        if process.stderr is None:
            return
        while True:
            chunk = await process.stderr.read(4096)
            if not chunk:
                return
            self._stderr_total += len(chunk)
            self._stderr_tail.extend(chunk)
            overflow = len(self._stderr_tail) - self.spec.max_stderr_bytes
            if overflow > 0:
                del self._stderr_tail[:overflow]
            if (
                self._stderr_total > self.spec.max_stderr_bytes
                and not self._stderr_overflow
            ):
                self._stderr_overflow = True
                signal_process(process, force=True)

    async def terminate(self) -> None:
        async with self._terminate_lock:
            process = self.process
            if process is None:
                return
            if process.stdin is not None:
                process.stdin.close()
            if process.returncode is None:
                signal_process(process, force=False)
                try:
                    await asyncio.wait_for(process.wait(), timeout=0.5)
                except TimeoutError:
                    signal_process(process, force=True)
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(process.wait(), timeout=1.0)
            task = self._stderr_task
            self._stderr_task = None
            if task is not None:
                with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                    await asyncio.wait_for(task, timeout=0.5)
            _release_windows_job(process)
            self.connection = None
            self.process = None
