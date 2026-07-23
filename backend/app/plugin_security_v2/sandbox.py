"""Windows AppContainer preparation for Plugin Platform v2 sidecars."""

from __future__ import annotations

import ctypes
import hashlib
import os
import re
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ctypes import wintypes

from .errors import security_error
from .storage import atomic_write_json


SANDBOX_CONFIG_SCHEMA_VERSION = 1
SANDBOX_MODE_WINDOWS_APPCONTAINER = "windows-appcontainer"
_PROFILE_NAME = re.compile(r"^[-_. A-Za-z0-9]{1,64}$")


def sandbox_profile_name(
    plugin_id: str, publisher_identity: str, major_version: int
) -> str:
    digest = hashlib.sha256(
        f"{publisher_identity}\0{plugin_id}\0{major_version}".encode("utf-8")
    ).hexdigest()[:32]
    return f"CandleScope.Plugin.{digest}"


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _paths_overlap(left: Path, right: Path) -> bool:
    return _is_within(left, right) or _is_within(right, left)


def _is_drive_root(path: Path) -> bool:
    return bool(path.anchor) and path == Path(path.anchor)


@dataclass(frozen=True, slots=True)
class SandboxPolicy:
    profile_name: str
    installation_directory: Path
    private_directory: Path
    runtime_directory: Path
    additional_read_only_paths: tuple[Path, ...] = ()
    environment: tuple[tuple[str, str], ...] = ()
    memory_limit_bytes: int = 256 * 1024 * 1024
    cpu_rate_percent: int = 25
    cpu_time_seconds: int = 60
    disk_limit_bytes: int = 64 * 1024 * 1024
    max_processes: int = 1
    max_wall_seconds: int = 300
    mode: str = SANDBOX_MODE_WINDOWS_APPCONTAINER

    def __post_init__(self) -> None:
        if self.mode != SANDBOX_MODE_WINDOWS_APPCONTAINER:
            raise ValueError("sandbox mode is unsupported")
        if not _PROFILE_NAME.fullmatch(self.profile_name):
            raise ValueError("AppContainer profile name is invalid")
        installation = Path(self.installation_directory).resolve(strict=False)
        private = Path(self.private_directory).resolve(strict=False)
        runtime = Path(self.runtime_directory).resolve(strict=False)
        roots = (installation, private, runtime)
        if any(_is_drive_root(item) for item in roots):
            raise ValueError("sandbox roots must not be drive roots")
        if any(
            _paths_overlap(left, right)
            for index, left in enumerate(roots)
            for right in roots[index + 1 :]
        ):
            raise ValueError("sandbox installation and writable roots must not overlap")
        read_paths = tuple(
            Path(item).resolve(strict=False) for item in self.additional_read_only_paths
        )
        if any(_is_drive_root(item) for item in read_paths):
            raise ValueError("sandbox read-only roots must not be drive roots")
        if any(
            _paths_overlap(item, writable)
            for item in read_paths
            for writable in (private, runtime)
        ):
            raise ValueError("writable paths must not overlap read-only roots")
        environment = tuple(self.environment)
        allowed_environment = {
            "LANG",
            "LC_ALL",
            "PYTHONHOME",
            "PYTHONPATH",
            "SSL_CERT_DIR",
            "SSL_CERT_FILE",
        }
        seen: set[str] = set()
        for key, value in environment:
            normalized = key.upper()
            if (
                normalized not in allowed_environment
                or normalized in seen
                or not isinstance(value, str)
                or "\0" in value
            ):
                raise ValueError("sandbox environment override is invalid")
            seen.add(normalized)
        for name, value, lower, upper in (
            (
                "memory_limit_bytes",
                self.memory_limit_bytes,
                32 * 1024 * 1024,
                8 * 1024**3,
            ),
            ("cpu_rate_percent", self.cpu_rate_percent, 1, 100),
            ("cpu_time_seconds", self.cpu_time_seconds, 1, 3_600),
            ("disk_limit_bytes", self.disk_limit_bytes, 1024 * 1024, 10 * 1024**3),
            ("max_processes", self.max_processes, 1, 32),
            ("max_wall_seconds", self.max_wall_seconds, 1, 86_400),
        ):
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not lower <= value <= upper
            ):
                raise ValueError(f"{name} is outside the supported range")
        object.__setattr__(self, "installation_directory", installation)
        object.__setattr__(self, "private_directory", private)
        object.__setattr__(self, "runtime_directory", runtime)
        object.__setattr__(self, "additional_read_only_paths", read_paths)
        object.__setattr__(self, "environment", environment)

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "mode": self.mode,
            "profileName": self.profile_name,
            "installationDirectory": str(self.installation_directory),
            "privateDirectory": str(self.private_directory),
            "runtimeDirectory": str(self.runtime_directory),
            "additionalReadOnlyPaths": [
                str(item) for item in self.additional_read_only_paths
            ],
            "environment": [
                {"name": key, "value": value} for key, value in self.environment
            ],
            "limits": {
                "memoryBytes": self.memory_limit_bytes,
                "cpuRatePercent": self.cpu_rate_percent,
                "cpuTimeSeconds": self.cpu_time_seconds,
                "diskBytes": self.disk_limit_bytes,
                "maxProcesses": self.max_processes,
                "maxWallSeconds": self.max_wall_seconds,
            },
        }

    @classmethod
    def from_wire(cls, value: Any) -> "SandboxPolicy":
        if not isinstance(value, dict) or set(value) != {
            "schemaVersion",
            "mode",
            "profileName",
            "installationDirectory",
            "privateDirectory",
            "runtimeDirectory",
            "additionalReadOnlyPaths",
            "environment",
            "limits",
        }:
            raise ValueError("sandbox policy wire schema is invalid")
        if value["schemaVersion"] != 1:
            raise ValueError("sandbox policy wire schemaVersion is unsupported")
        read_paths = value["additionalReadOnlyPaths"]
        environment = value["environment"]
        limits = value["limits"]
        if (
            not isinstance(read_paths, list)
            or not all(isinstance(item, str) for item in read_paths)
            or not isinstance(environment, list)
            or not all(
                isinstance(item, dict)
                and set(item) == {"name", "value"}
                and isinstance(item["name"], str)
                and isinstance(item["value"], str)
                for item in environment
            )
            or not isinstance(limits, dict)
            or set(limits)
            != {
                "memoryBytes",
                "cpuRatePercent",
                "cpuTimeSeconds",
                "diskBytes",
                "maxProcesses",
                "maxWallSeconds",
            }
            or not all(
                isinstance(value.get(key), str)
                for key in {
                    "mode",
                    "profileName",
                    "installationDirectory",
                    "privateDirectory",
                    "runtimeDirectory",
                }
            )
        ):
            raise ValueError("sandbox policy wire values are invalid")
        return cls(
            mode=value["mode"],
            profile_name=value["profileName"],
            installation_directory=Path(value["installationDirectory"]),
            private_directory=Path(value["privateDirectory"]),
            runtime_directory=Path(value["runtimeDirectory"]),
            additional_read_only_paths=tuple(Path(item) for item in read_paths),
            environment=tuple((item["name"], item["value"]) for item in environment),
            memory_limit_bytes=limits["memoryBytes"],
            cpu_rate_percent=limits["cpuRatePercent"],
            cpu_time_seconds=limits["cpuTimeSeconds"],
            disk_limit_bytes=limits["diskBytes"],
            max_processes=limits["maxProcesses"],
            max_wall_seconds=limits["maxWallSeconds"],
        )


@dataclass(frozen=True, slots=True)
class PreparedSandboxLaunch:
    command: tuple[str, ...]
    working_directory: Path
    environment: dict[str, str]
    config_path: Path
    status_path: Path
    appcontainer_sid: str
    profile_directory: Path


def _require_windows() -> None:
    if os.name != "nt":
        raise security_error(
            "PLUGIN_SANDBOX_UNAVAILABLE",
            "Windows AppContainer sandbox is unavailable on this operating system",
        )


def _failed_hresult(value: int) -> bool:
    return ctypes.c_long(value).value < 0


def _windows_error(label: str, value: int) -> Exception:
    return security_error(
        "PLUGIN_SANDBOX_WINDOWS_ERROR",
        f"{label} failed",
        details={"hresult": f"0x{ctypes.c_ulong(value).value:08x}"},
    )


def ensure_appcontainer_profile(profile_name: str) -> tuple[str, Path]:
    _require_windows()
    if not _PROFILE_NAME.fullmatch(profile_name):
        raise security_error(
            "PLUGIN_SANDBOX_PROFILE_INVALID", "AppContainer profile name is invalid"
        )
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ole32 = ctypes.OleDLL("ole32")

    create_profile = userenv.CreateAppContainerProfile
    create_profile.argtypes = [
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    create_profile.restype = ctypes.c_long
    derive_sid = userenv.DeriveAppContainerSidFromAppContainerName
    derive_sid.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
    derive_sid.restype = ctypes.c_long
    get_folder = userenv.GetAppContainerFolderPath
    get_folder.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.LPWSTR)]
    get_folder.restype = ctypes.c_long
    convert_sid = advapi32.ConvertSidToStringSidW
    convert_sid.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    convert_sid.restype = wintypes.BOOL
    free_sid = advapi32.FreeSid
    free_sid.argtypes = [ctypes.c_void_p]
    free_sid.restype = ctypes.c_void_p
    local_free = kernel32.LocalFree
    local_free.argtypes = [ctypes.c_void_p]
    local_free.restype = ctypes.c_void_p
    co_task_mem_free = ole32.CoTaskMemFree
    co_task_mem_free.argtypes = [ctypes.c_void_p]
    co_task_mem_free.restype = None

    sid = ctypes.c_void_p()
    result = create_profile(
        profile_name,
        profile_name,
        "CandleScope Plugin Platform v2 sandbox",
        None,
        0,
        ctypes.byref(sid),
    )
    already_exists = ctypes.c_long(0x800700B7).value
    if ctypes.c_long(result).value == already_exists:
        result = derive_sid(profile_name, ctypes.byref(sid))
    if _failed_hresult(result) or not sid.value:
        raise _windows_error("Create/derive AppContainer profile", result)
    sid_text = wintypes.LPWSTR()
    folder_text = wintypes.LPWSTR()
    try:
        if not convert_sid(sid, ctypes.byref(sid_text)):
            raise security_error(
                "PLUGIN_SANDBOX_WINDOWS_ERROR",
                "unable to convert AppContainer SID",
                details={"winerror": ctypes.get_last_error()},
            )
        result = get_folder(sid_text.value, ctypes.byref(folder_text))
        if _failed_hresult(result) or not folder_text.value:
            raise _windows_error("GetAppContainerFolderPath", result)
        return sid_text.value, Path(folder_text.value).resolve(strict=False)
    finally:
        if sid_text:
            local_free(sid_text)
        if folder_text:
            co_task_mem_free(folder_text)
        free_sid(sid)


def delete_appcontainer_profile(profile_name: str) -> None:
    _require_windows()
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    delete_profile = userenv.DeleteAppContainerProfile
    delete_profile.argtypes = [wintypes.LPCWSTR]
    delete_profile.restype = ctypes.c_long
    result = delete_profile(profile_name)
    file_not_found = ctypes.c_long(0x80070002).value
    if _failed_hresult(result) and ctypes.c_long(result).value != file_not_found:
        raise _windows_error("DeleteAppContainerProfile", result)


def _grant_acl(path: Path, sid: str, permission: str) -> None:
    if path.is_symlink() or not path.exists():
        raise security_error(
            "PLUGIN_SANDBOX_PATH_UNSAFE",
            "sandbox ACL target must exist and must not be a symlink",
            details={"path": str(path)},
        )
    inheritance = "(OI)(CI)" if path.is_dir() else ""
    command = [
        str(
            Path(os.environ.get("SYSTEMROOT", r"C:\Windows"))
            / "System32"
            / "icacls.exe"
        ),
        str(path),
        "/grant:r",
        f"*{sid}:{inheritance}{permission}",
    ]
    if path.is_dir():
        command.extend(("/T", "/Q"))
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise security_error(
            "PLUGIN_SANDBOX_ACL_FAILED",
            f"unable to apply AppContainer ACL: {exc}",
            details={"path": str(path)},
        ) from exc
    if completed.returncode != 0:
        raise security_error(
            "PLUGIN_SANDBOX_ACL_FAILED",
            "icacls rejected the AppContainer ACL",
            details={
                "path": str(path),
                "returnCode": completed.returncode,
                "stderr": completed.stderr[-1_024:],
            },
        )


def _assert_no_loopback_exemption(sid: str) -> None:
    executable = (
        Path(os.environ.get("SYSTEMROOT", r"C:\Windows"))
        / "System32"
        / "CheckNetIsolation.exe"
    )
    try:
        completed = subprocess.run(
            (str(executable), "LoopbackExempt", "-s"),
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise security_error(
            "PLUGIN_SANDBOX_NETWORK_POLICY_UNVERIFIED",
            f"unable to inspect AppContainer loopback exemptions: {exc}",
        ) from exc
    output = completed.stdout + b"\n" + completed.stderr
    if completed.returncode != 0:
        raise security_error(
            "PLUGIN_SANDBOX_NETWORK_POLICY_UNVERIFIED",
            "CheckNetIsolation could not verify loopback policy",
            details={"returnCode": completed.returncode},
        )
    if sid.casefold().encode("ascii") in output.lower():
        raise security_error(
            "PLUGIN_SANDBOX_LOOPBACK_EXEMPT",
            "AppContainer profile has a forbidden loopback exemption",
            details={"appContainerSid": sid},
        )


def _sandbox_environment(
    policy: SandboxPolicy,
    executable: Path,
    profile_directory: Path,
) -> dict[str, str]:
    system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
    temp = policy.private_directory / "temp"
    data = policy.private_directory / "data"
    temp.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)
    values = {
        "COMSPEC": str(Path(system_root) / "System32" / "cmd.exe"),
        "PATH": os.pathsep.join(
            (str(executable.parent), str(Path(system_root) / "System32"))
        ),
        "PATHEXT": os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
        "SYSTEMROOT": system_root,
        "SYSTEMDRIVE": Path(system_root).drive,
        "WINDIR": system_root,
        "LOCALAPPDATA": str(profile_directory),
        "APPDATA": str(profile_directory),
        "USERPROFILE": str(policy.private_directory),
        "HOME": str(policy.private_directory),
        "TEMP": str(temp),
        "TMP": str(temp),
        "CANDLESCOPE_PLUGIN_DATA": str(data),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    values.update({key.upper(): value for key, value in policy.environment})
    return values


def prepare_sandbox_launch(
    policy: SandboxPolicy,
    command: tuple[str, ...],
    working_directory: Path,
) -> PreparedSandboxLaunch:
    _require_windows()
    if not command:
        raise security_error(
            "PLUGIN_SANDBOX_COMMAND_INVALID", "sandbox command is empty"
        )
    executable = Path(command[0]).resolve(strict=False)
    working = Path(working_directory).resolve(strict=False)
    allowed_roots = (policy.installation_directory, *policy.additional_read_only_paths)
    if not any(_is_within(executable, root) for root in allowed_roots):
        raise security_error(
            "PLUGIN_SANDBOX_COMMAND_OUTSIDE_INSTALLATION",
            "sandbox executable is outside the immutable installation and Host-pinned runtime roots",
            details={"path": str(executable)},
        )
    if not _is_within(working, policy.installation_directory):
        raise security_error(
            "PLUGIN_SANDBOX_CWD_OUTSIDE_INSTALLATION",
            "sandbox working directory is outside the immutable installation",
            details={"path": str(working)},
        )
    sid, profile_directory = ensure_appcontainer_profile(policy.profile_name)
    _assert_no_loopback_exemption(sid)
    policy.private_directory.mkdir(parents=True, exist_ok=True)
    policy.runtime_directory.mkdir(parents=True, exist_ok=True)
    if any(
        _paths_overlap(profile_directory, item)
        for item in (
            policy.installation_directory,
            policy.private_directory,
            policy.runtime_directory,
            *policy.additional_read_only_paths,
        )
    ):
        raise security_error(
            "PLUGIN_SANDBOX_PATH_UNSAFE",
            "AppContainer profile path overlaps an explicit sandbox root",
        )
    if policy.private_directory.is_symlink() or policy.runtime_directory.is_symlink():
        raise security_error(
            "PLUGIN_SANDBOX_PATH_UNSAFE", "sandbox writable roots must not be symlinks"
        )

    acl_marker = policy.runtime_directory / "acl-v1.json"
    expected_marker = {
        "schemaVersion": 1,
        "appContainerSid": sid,
        "readOnlyPaths": [str(item) for item in allowed_roots],
        "writablePath": str(policy.private_directory),
    }
    marker_matches = False
    if acl_marker.is_file() and not acl_marker.is_symlink():
        try:
            import json

            marker_matches = (
                json.loads(acl_marker.read_text(encoding="utf-8")) == expected_marker
            )
        except (OSError, ValueError):
            marker_matches = False
    if not marker_matches:
        for path in allowed_roots:
            _grant_acl(path, sid, "RX")
        _grant_acl(policy.private_directory, sid, "M")
        atomic_write_json(acl_marker, expected_marker)

    launch_directory = policy.runtime_directory / f"launch-{uuid.uuid4().hex}"
    launch_directory.mkdir(parents=True)
    status_path = launch_directory / "status.json"
    config_path = launch_directory / "config.json"
    environment = _sandbox_environment(policy, executable, profile_directory)
    config: dict[str, Any] = {
        "schemaVersion": SANDBOX_CONFIG_SCHEMA_VERSION,
        "profileName": policy.profile_name,
        "appContainerSid": sid,
        "command": [str(executable), *command[1:]],
        "workingDirectory": str(working),
        "environment": environment,
        "statusPath": str(status_path),
        "limits": {
            "memoryBytes": policy.memory_limit_bytes,
            "cpuRatePercent": policy.cpu_rate_percent,
            "cpuTimeSeconds": policy.cpu_time_seconds,
            "diskBytes": policy.disk_limit_bytes,
            "activeProcesses": policy.max_processes,
            "wallSeconds": policy.max_wall_seconds,
        },
        "monitoredDirectories": [str(policy.private_directory), str(profile_directory)],
    }
    atomic_write_json(config_path, config)
    runner = Path(__file__).with_name("windows_runner.py").resolve(strict=True)
    wrapper_environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {"COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "WINDIR"}
    }
    wrapper_environment.update(
        {"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
    )
    return PreparedSandboxLaunch(
        (str(Path(sys.executable).resolve()), "-u", str(runner), str(config_path)),
        launch_directory,
        wrapper_environment,
        config_path,
        status_path,
        sid,
        profile_directory,
    )
