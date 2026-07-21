"""Strict loading of resolved script-runtime activation records.

The registry is activation state, not an installer manifest. Phase 3 owns
creating it atomically after package verification and isolated installation.
"""

from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk import DEFAULT_MAX_MESSAGE_BYTES

from .errors import PluginRegistryError


RUNTIME_REGISTRY_SCHEMA_VERSION = 1
MAX_REGISTRY_BYTES = 1024 * 1024
MAX_REGISTERED_RUNTIMES = 128
DEFAULT_STARTUP_TIMEOUT_SECONDS = 5.0
DEFAULT_REQUEST_TIMEOUT_SECONDS = 30.0
DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 2.0
DEFAULT_MAX_STDERR_BYTES = 64 * 1024
DEFAULT_MAX_RESTARTS = 3
DEFAULT_RESTART_WINDOW_SECONDS = 60.0

_PLUGIN_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
_PACKAGE_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$")


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PluginRegistryError(f"{label} must be a JSON object")
    return value


def _only_keys(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise PluginRegistryError(
            f"{label} contains unsupported fields: {', '.join(unknown)}"
        )


def _string(value: Any, label: str, *, max_length: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PluginRegistryError(f"{label} must be a non-empty string")
    if "\0" in value:
        raise PluginRegistryError(f"{label} must not contain NUL")
    if len(value) > max_length:
        raise PluginRegistryError(f"{label} exceeds {max_length} characters")
    return value


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise PluginRegistryError(f"{label} must be a boolean")
    return value


def _integer(value: Any, label: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PluginRegistryError(f"{label} must be an integer")
    if value < minimum or value > maximum:
        raise PluginRegistryError(f"{label} must be between {minimum} and {maximum}")
    return value


def _number(value: Any, label: str, *, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PluginRegistryError(f"{label} must be a number")
    result = float(value)
    if not math.isfinite(result) or result < minimum or result > maximum:
        raise PluginRegistryError(f"{label} must be between {minimum} and {maximum}")
    return result


@dataclass(frozen=True, slots=True)
class RuntimeProcessSpec:
    """Resolved, immutable launch and supervision policy for one runtime."""

    runtime_id: str
    expected_package: str
    expected_version: str
    executable: Path
    arguments: tuple[str, ...] = ()
    working_directory: Path | None = None
    enabled: bool = True
    auto_start: bool = False
    required: bool = False
    startup_timeout_seconds: float = DEFAULT_STARTUP_TIMEOUT_SECONDS
    request_timeout_seconds: float = DEFAULT_REQUEST_TIMEOUT_SECONDS
    shutdown_timeout_seconds: float = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS
    max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES
    max_stderr_bytes: int = DEFAULT_MAX_STDERR_BYTES
    max_restart_attempts: int = DEFAULT_MAX_RESTARTS
    restart_window_seconds: float = DEFAULT_RESTART_WINDOW_SECONDS

    def __post_init__(self) -> None:
        if not _PLUGIN_ID.fullmatch(self.runtime_id):
            raise PluginRegistryError(f"invalid runtime id {self.runtime_id!r}")
        if not _PACKAGE_NAME.fullmatch(self.expected_package):
            raise PluginRegistryError(
                f"runtime {self.runtime_id!r} has an invalid package name"
            )
        _string(
            self.expected_version, f"runtime {self.runtime_id}.version", max_length=128
        )

        executable = Path(self.executable).expanduser()
        if not executable.is_absolute():
            raise PluginRegistryError(
                f"runtime {self.runtime_id!r} executable must be an absolute path"
            )
        object.__setattr__(self, "executable", executable.resolve(strict=False))

        arguments = tuple(self.arguments)
        if len(arguments) > 64:
            raise PluginRegistryError(
                f"runtime {self.runtime_id!r} has too many arguments"
            )
        for index, argument in enumerate(arguments):
            _string(
                argument,
                f"runtime {self.runtime_id}.launch.args[{index}]",
                max_length=4096,
            )
        object.__setattr__(self, "arguments", arguments)

        if self.working_directory is not None:
            working_directory = Path(self.working_directory).expanduser()
            if not working_directory.is_absolute():
                raise PluginRegistryError(
                    f"runtime {self.runtime_id!r} workingDirectory must be absolute"
                )
            object.__setattr__(
                self,
                "working_directory",
                working_directory.resolve(strict=False),
            )

        for name in ("enabled", "auto_start", "required"):
            if not isinstance(getattr(self, name), bool):
                raise PluginRegistryError(
                    f"runtime {self.runtime_id}.{name} must be boolean"
                )
        if not self.enabled and self.auto_start:
            raise PluginRegistryError(
                f"disabled runtime {self.runtime_id!r} cannot use autoStart"
            )
        if self.required and (not self.enabled or not self.auto_start):
            raise PluginRegistryError(
                f"required runtime {self.runtime_id!r} must be enabled and autoStart"
            )

        _number(
            self.startup_timeout_seconds,
            f"runtime {self.runtime_id}.timeouts.startupSeconds",
            minimum=0.05,
            maximum=300.0,
        )
        _number(
            self.request_timeout_seconds,
            f"runtime {self.runtime_id}.timeouts.requestSeconds",
            minimum=0.05,
            maximum=300.0,
        )
        _number(
            self.shutdown_timeout_seconds,
            f"runtime {self.runtime_id}.timeouts.shutdownSeconds",
            minimum=0.05,
            maximum=30.0,
        )
        _integer(
            self.max_message_bytes,
            f"runtime {self.runtime_id}.limits.maxMessageBytes",
            minimum=1024,
            maximum=DEFAULT_MAX_MESSAGE_BYTES,
        )
        _integer(
            self.max_stderr_bytes,
            f"runtime {self.runtime_id}.limits.maxStderrBytes",
            minimum=1024,
            maximum=1024 * 1024,
        )
        _integer(
            self.max_restart_attempts,
            f"runtime {self.runtime_id}.restart.maxAttempts",
            minimum=0,
            maximum=10,
        )
        _number(
            self.restart_window_seconds,
            f"runtime {self.runtime_id}.restart.windowSeconds",
            minimum=1.0,
            maximum=3600.0,
        )

    @property
    def command(self) -> tuple[str, ...]:
        return (str(self.executable), *self.arguments)


@dataclass(frozen=True, slots=True)
class RuntimeRegistry:
    plugins: tuple[RuntimeProcessSpec, ...] = ()
    source: Path | None = None

    def __post_init__(self) -> None:
        plugins = tuple(self.plugins)
        ids = [plugin.runtime_id for plugin in plugins]
        if len(ids) != len(set(ids)):
            raise PluginRegistryError("runtime registry contains duplicate plugin ids")
        if len(plugins) > MAX_REGISTERED_RUNTIMES:
            raise PluginRegistryError(
                f"runtime registry exceeds {MAX_REGISTERED_RUNTIMES} plugins"
            )
        object.__setattr__(self, "plugins", plugins)

    def by_id(self) -> dict[str, RuntimeProcessSpec]:
        return {plugin.runtime_id: plugin for plugin in self.plugins}


def default_runtime_registry_path(
    environ: Mapping[str, str] | None = None,
) -> Path:
    env = os.environ if environ is None else environ
    if os.name == "nt":
        base = env.get("LOCALAPPDATA")
        if base:
            return Path(base) / "CandleScope" / "plugins" / "runtime-registry.json"
    xdg_data = env.get("XDG_DATA_HOME")
    base_path = (
        Path(xdg_data).expanduser() if xdg_data else Path.home() / ".local" / "share"
    )
    return base_path / "candlescope" / "plugins" / "runtime-registry.json"


def _parse_launch(value: Any, label: str) -> tuple[Path, tuple[str, ...], Path | None]:
    launch = _mapping(value, label)
    _only_keys(launch, {"executable", "args", "workingDirectory"}, label)
    executable = Path(_string(launch.get("executable"), f"{label}.executable"))

    raw_args = launch.get("args", [])
    if isinstance(raw_args, (str, bytes)) or not isinstance(raw_args, Sequence):
        raise PluginRegistryError(f"{label}.args must be an array")
    arguments = tuple(
        _string(argument, f"{label}.args[{index}]")
        for index, argument in enumerate(raw_args)
    )

    raw_working_directory = launch.get("workingDirectory")
    working_directory = (
        Path(_string(raw_working_directory, f"{label}.workingDirectory"))
        if raw_working_directory is not None
        else None
    )
    return executable, arguments, working_directory


def _parse_plugin(value: Any, index: int) -> RuntimeProcessSpec:
    label = f"runtime registry.plugins[{index}]"
    plugin = _mapping(value, label)
    _only_keys(
        plugin,
        {
            "id",
            "package",
            "version",
            "enabled",
            "autoStart",
            "required",
            "launch",
            "timeouts",
            "limits",
            "restart",
        },
        label,
    )
    runtime_id = _string(plugin.get("id"), f"{label}.id", max_length=64)
    package = _string(plugin.get("package"), f"{label}.package", max_length=128)
    version = _string(plugin.get("version"), f"{label}.version", max_length=128)
    executable, arguments, working_directory = _parse_launch(
        plugin.get("launch"), f"{label}.launch"
    )

    timeouts = _mapping(plugin.get("timeouts", {}), f"{label}.timeouts")
    _only_keys(
        timeouts,
        {"startupSeconds", "requestSeconds", "shutdownSeconds"},
        f"{label}.timeouts",
    )
    limits = _mapping(plugin.get("limits", {}), f"{label}.limits")
    _only_keys(
        limits,
        {"maxMessageBytes", "maxStderrBytes"},
        f"{label}.limits",
    )
    restart = _mapping(plugin.get("restart", {}), f"{label}.restart")
    _only_keys(restart, {"maxAttempts", "windowSeconds"}, f"{label}.restart")

    return RuntimeProcessSpec(
        runtime_id=runtime_id,
        expected_package=package,
        expected_version=version,
        executable=executable,
        arguments=arguments,
        working_directory=working_directory,
        enabled=_boolean(plugin.get("enabled", True), f"{label}.enabled"),
        auto_start=_boolean(plugin.get("autoStart", False), f"{label}.autoStart"),
        required=_boolean(plugin.get("required", False), f"{label}.required"),
        startup_timeout_seconds=_number(
            timeouts.get("startupSeconds", DEFAULT_STARTUP_TIMEOUT_SECONDS),
            f"{label}.timeouts.startupSeconds",
            minimum=0.05,
            maximum=300.0,
        ),
        request_timeout_seconds=_number(
            timeouts.get("requestSeconds", DEFAULT_REQUEST_TIMEOUT_SECONDS),
            f"{label}.timeouts.requestSeconds",
            minimum=0.05,
            maximum=300.0,
        ),
        shutdown_timeout_seconds=_number(
            timeouts.get("shutdownSeconds", DEFAULT_SHUTDOWN_TIMEOUT_SECONDS),
            f"{label}.timeouts.shutdownSeconds",
            minimum=0.05,
            maximum=30.0,
        ),
        max_message_bytes=_integer(
            limits.get("maxMessageBytes", DEFAULT_MAX_MESSAGE_BYTES),
            f"{label}.limits.maxMessageBytes",
            minimum=1024,
            maximum=DEFAULT_MAX_MESSAGE_BYTES,
        ),
        max_stderr_bytes=_integer(
            limits.get("maxStderrBytes", DEFAULT_MAX_STDERR_BYTES),
            f"{label}.limits.maxStderrBytes",
            minimum=1024,
            maximum=1024 * 1024,
        ),
        max_restart_attempts=_integer(
            restart.get("maxAttempts", DEFAULT_MAX_RESTARTS),
            f"{label}.restart.maxAttempts",
            minimum=0,
            maximum=10,
        ),
        restart_window_seconds=_number(
            restart.get("windowSeconds", DEFAULT_RESTART_WINDOW_SECONDS),
            f"{label}.restart.windowSeconds",
            minimum=1.0,
            maximum=3600.0,
        ),
    )


def load_runtime_registry(
    path: Path | str,
    *,
    allow_missing: bool = False,
) -> RuntimeRegistry:
    registry_path = Path(path).expanduser().resolve(strict=False)
    try:
        size = registry_path.stat().st_size
    except FileNotFoundError:
        if allow_missing:
            return RuntimeRegistry(source=registry_path)
        raise PluginRegistryError(
            f"runtime registry does not exist: {registry_path}"
        ) from None
    except OSError as exc:
        raise PluginRegistryError(f"unable to inspect runtime registry: {exc}") from exc
    if size > MAX_REGISTRY_BYTES:
        raise PluginRegistryError(
            f"runtime registry exceeds {MAX_REGISTRY_BYTES} bytes"
        )

    try:
        payload = registry_path.read_bytes()
        if len(payload) > MAX_REGISTRY_BYTES:
            raise PluginRegistryError(
                f"runtime registry exceeds {MAX_REGISTRY_BYTES} bytes"
            )
        root = json.loads(
            payload.decode("utf-8"),
            parse_constant=_reject_json_constant,
            object_pairs_hook=_unique_json_object,
        )
    except PluginRegistryError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise PluginRegistryError(
            f"runtime registry is not valid UTF-8 JSON: {exc}"
        ) from exc

    registry = _mapping(root, "runtime registry")
    _only_keys(registry, {"schemaVersion", "plugins"}, "runtime registry")
    schema_version = registry.get("schemaVersion")
    if (
        isinstance(schema_version, bool)
        or schema_version != RUNTIME_REGISTRY_SCHEMA_VERSION
    ):
        raise PluginRegistryError(
            "unsupported runtime registry schema; "
            f"expected {RUNTIME_REGISTRY_SCHEMA_VERSION}"
        )
    raw_plugins = registry.get("plugins")
    if isinstance(raw_plugins, (str, bytes)) or not isinstance(raw_plugins, Sequence):
        raise PluginRegistryError("runtime registry.plugins must be an array")
    if len(raw_plugins) > MAX_REGISTERED_RUNTIMES:
        raise PluginRegistryError(
            f"runtime registry exceeds {MAX_REGISTERED_RUNTIMES} plugins"
        )
    plugins = tuple(
        _parse_plugin(value, index) for index, value in enumerate(raw_plugins)
    )
    return RuntimeRegistry(plugins=plugins, source=registry_path)
