"""Standalone Windows AppContainer/Job Object launcher used by the Host.

This module intentionally imports only the Python standard library so the trusted
launcher never imports plugin code in its own process.
"""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO

from ctypes import wintypes


EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
CREATE_NO_WINDOW = 0x08000000
CREATE_SUSPENDED = 0x00000004
STARTF_USESTDHANDLES = 0x00000100
HANDLE_FLAG_INHERIT = 0x00000001
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
ERROR_BROKEN_PIPE = 109
ERROR_NO_DATA = 232

PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009

JOB_OBJECT_LIMIT_PROCESS_TIME = 0x00000002
JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1
JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION_CLASS = 15


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("nLength", wintypes.DWORD),
        ("lpSecurityDescriptor", ctypes.c_void_p),
        ("bInheritHandle", wintypes.BOOL),
    ]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_ubyte)),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]


class SECURITY_CAPABILITIES(ctypes.Structure):
    _fields_ = [
        ("AppContainerSid", ctypes.c_void_p),
        ("Capabilities", ctypes.POINTER(SID_AND_ATTRIBUTES)),
        ("CapabilityCount", wintypes.DWORD),
        ("Reserved", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class JOBOBJECT_CPU_RATE_CONTROL_INFORMATION(ctypes.Structure):
    _fields_ = [("ControlFlags", wintypes.DWORD), ("CpuRate", wintypes.DWORD)]


def _last_error(label: str) -> OSError:
    error = ctypes.get_last_error()
    return OSError(error, f"{label}: {ctypes.FormatError(error).strip()}")


def _configure_apis() -> tuple[Any, Any, Any]:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

    kernel32.CreatePipe.argtypes = [
        ctypes.POINTER(wintypes.HANDLE),
        ctypes.POINTER(wintypes.HANDLE),
        ctypes.POINTER(SECURITY_ATTRIBUTES),
        wintypes.DWORD,
    ]
    kernel32.CreatePipe.restype = wintypes.BOOL
    kernel32.SetHandleInformation.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    kernel32.SetHandleInformation.restype = wintypes.BOOL
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [
        wintypes.HANDLE,
        wintypes.HANDLE,
    ]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.InitializeProcThreadAttributeList.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    kernel32.InitializeProcThreadAttributeList.restype = wintypes.BOOL
    kernel32.UpdateProcThreadAttribute.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.c_size_t,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    kernel32.UpdateProcThreadAttribute.restype = wintypes.BOOL
    kernel32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    kernel32.DeleteProcThreadAttributeList.restype = None
    kernel32.CreateProcessW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.LPWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.BOOL,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.LPCWSTR,
        ctypes.POINTER(STARTUPINFOW),
        ctypes.POINTER(PROCESS_INFORMATION),
    ]
    kernel32.CreateProcessW.restype = wintypes.BOOL
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.ResumeThread.restype = wintypes.DWORD
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.GetExitCodeProcess.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.ReadFile.argtypes = [
        wintypes.HANDLE,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.c_void_p,
    ]
    kernel32.ReadFile.restype = wintypes.BOOL
    kernel32.WriteFile.argtypes = [
        wintypes.HANDLE,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.c_void_p,
    ]
    kernel32.WriteFile.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p

    userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [
        wintypes.LPCWSTR,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    userenv.DeriveAppContainerSidFromAppContainerName.restype = ctypes.c_long
    advapi32.FreeSid.argtypes = [ctypes.c_void_p]
    advapi32.FreeSid.restype = ctypes.c_void_p
    advapi32.ConvertSidToStringSidW.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.LPWSTR),
    ]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
    return kernel32, userenv, advapi32


def _load_config(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schemaVersion",
        "profileName",
        "appContainerSid",
        "command",
        "workingDirectory",
        "environment",
        "statusPath",
        "limits",
        "monitoredDirectories",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected
        or value["schemaVersion"] != 1
    ):
        raise ValueError("sandbox config schema is invalid")
    for key in (
        "profileName",
        "appContainerSid",
        "workingDirectory",
        "statusPath",
    ):
        if not isinstance(value[key], str) or not value[key] or "\0" in value[key]:
            raise ValueError(f"sandbox config {key} is invalid")
    if not value["appContainerSid"].startswith("S-1-15-2-"):
        raise ValueError("sandbox config AppContainer SID is invalid")
    if (
        not isinstance(value["command"], list)
        or not value["command"]
        or not all(isinstance(item, str) and item for item in value["command"])
        or not isinstance(value["environment"], dict)
        or not all(
            isinstance(key, str)
            and key
            and "=" not in key
            and "\0" not in key
            and isinstance(item, str)
            and "\0" not in item
            for key, item in value["environment"].items()
        )
        or not isinstance(value["limits"], dict)
        or set(value["limits"])
        != {
            "memoryBytes",
            "cpuRatePercent",
            "cpuTimeSeconds",
            "diskBytes",
            "activeProcesses",
            "wallSeconds",
        }
        or not isinstance(value["monitoredDirectories"], list)
        or not value["monitoredDirectories"]
        or not all(
            isinstance(item, str) and item and "\0" not in item
            for item in value["monitoredDirectories"]
        )
        or not all(
            isinstance(item, int) and not isinstance(item, bool) and item > 0
            for item in value["limits"].values()
        )
    ):
        raise ValueError("sandbox config values are invalid")
    return value


def _create_pipe(kernel32: Any) -> tuple[wintypes.HANDLE, wintypes.HANDLE]:
    read_handle = wintypes.HANDLE()
    write_handle = wintypes.HANDLE()
    attributes = SECURITY_ATTRIBUTES(
        ctypes.sizeof(SECURITY_ATTRIBUTES),
        None,
        True,
    )
    if not kernel32.CreatePipe(
        ctypes.byref(read_handle),
        ctypes.byref(write_handle),
        ctypes.byref(attributes),
        0,
    ):
        raise _last_error("CreatePipe")
    return read_handle, write_handle


def _set_not_inherited(kernel32: Any, handle: wintypes.HANDLE) -> None:
    if not kernel32.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0):
        raise _last_error("SetHandleInformation")


def _set_job_limits(
    kernel32: Any, job: wintypes.HANDLE, limits: dict[str, int]
) -> None:
    information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    information.BasicLimitInformation.LimitFlags = (
        JOB_OBJECT_LIMIT_PROCESS_TIME
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    )
    information.BasicLimitInformation.PerProcessUserTimeLimit = (
        int(limits["cpuTimeSeconds"]) * 10_000_000
    )
    information.BasicLimitInformation.ActiveProcessLimit = int(
        limits["activeProcesses"]
    )
    information.ProcessMemoryLimit = int(limits["memoryBytes"])
    information.JobMemoryLimit = int(limits["memoryBytes"])
    if not kernel32.SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        ctypes.byref(information),
        ctypes.sizeof(information),
    ):
        raise _last_error("SetInformationJobObject(extended)")
    cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION(
        JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
        int(limits["cpuRatePercent"]) * 100,
    )
    if not kernel32.SetInformationJobObject(
        job,
        JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION_CLASS,
        ctypes.byref(cpu),
        ctypes.sizeof(cpu),
    ):
        raise _last_error("SetInformationJobObject(cpu)")


def _update_attribute(
    kernel32: Any,
    attribute_list: ctypes.c_void_p,
    attribute: int,
    value: Any,
    size: int,
) -> None:
    if not kernel32.UpdateProcThreadAttribute(
        attribute_list,
        0,
        attribute,
        ctypes.cast(ctypes.byref(value), ctypes.c_void_p),
        size,
        None,
        None,
    ):
        raise _last_error(f"UpdateProcThreadAttribute({attribute:#x})")


def _environment_block(environment: dict[str, str]) -> ctypes.Array[Any]:
    text = "\0".join(
        f"{key}={value}"
        for key, value in sorted(environment.items(), key=lambda item: item[0].upper())
    )
    return ctypes.create_unicode_buffer(text + "\0\0")


def _read_handle(kernel32: Any, handle: wintypes.HANDLE, stream: BinaryIO) -> None:
    buffer = ctypes.create_string_buffer(65_536)
    count = wintypes.DWORD()
    while True:
        if not kernel32.ReadFile(
            handle, buffer, len(buffer), ctypes.byref(count), None
        ):
            if ctypes.get_last_error() in {ERROR_BROKEN_PIPE, ERROR_NO_DATA}:
                break
            break
        if count.value == 0:
            break
        stream.write(buffer.raw[: count.value])
        stream.flush()


def _write_handle(kernel32: Any, handle: wintypes.HANDLE, stream: BinaryIO) -> None:
    written = wintypes.DWORD()
    try:
        while True:
            chunk = stream.read(65_536)
            if not chunk:
                break
            buffer = ctypes.create_string_buffer(chunk)
            if not kernel32.WriteFile(
                handle,
                buffer,
                len(chunk),
                ctypes.byref(written),
                None,
            ):
                if ctypes.get_last_error() in {ERROR_BROKEN_PIPE, ERROR_NO_DATA}:
                    break
                break
    finally:
        kernel32.CloseHandle(handle)


def _directory_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for root, directories, files in os.walk(path, followlinks=False):
        root_path = Path(root)
        directories[:] = [
            name for name in directories if not (root_path / name).is_symlink()
        ]
        for name in files:
            item = root_path / name
            if item.is_symlink():
                continue
            try:
                total += item.stat().st_size
            except OSError:
                continue
    return total


def _write_status(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(
            value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def run(config_path: Path) -> int:
    if os.name != "nt":
        raise RuntimeError("windows_runner requires Windows")
    config = _load_config(config_path)
    kernel32, userenv, advapi32 = _configure_apis()
    status_path = Path(config["statusPath"])
    handles: list[wintypes.HANDLE] = []
    attribute_list: ctypes.c_void_p | None = None
    sid = ctypes.c_void_p()
    process_info = PROCESS_INFORMATION()
    violation: str | None = None
    started = time.monotonic()
    try:
        result = userenv.DeriveAppContainerSidFromAppContainerName(
            config["profileName"], ctypes.byref(sid)
        )
        if ctypes.c_long(result).value < 0 or not sid.value:
            raise OSError(
                ctypes.c_ulong(result).value,
                "DeriveAppContainerSidFromAppContainerName failed",
            )
        sid_text = wintypes.LPWSTR()
        if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(sid_text)):
            raise _last_error("ConvertSidToStringSidW")
        try:
            if sid_text.value != config["appContainerSid"]:
                raise ValueError("sandbox profile SID does not match launch config")
        finally:
            kernel32.LocalFree(sid_text)

        child_stdin_read, parent_stdin_write = _create_pipe(kernel32)
        parent_stdout_read, child_stdout_write = _create_pipe(kernel32)
        parent_stderr_read, child_stderr_write = _create_pipe(kernel32)
        handles.extend(
            (
                child_stdin_read,
                parent_stdin_write,
                parent_stdout_read,
                child_stdout_write,
                parent_stderr_read,
                child_stderr_write,
            )
        )
        _set_not_inherited(kernel32, parent_stdin_write)
        _set_not_inherited(kernel32, parent_stdout_read)
        _set_not_inherited(kernel32, parent_stderr_read)

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise _last_error("CreateJobObjectW")
        handles.append(job)
        _set_job_limits(kernel32, job, config["limits"])

        attribute_size = ctypes.c_size_t()
        kernel32.InitializeProcThreadAttributeList(
            None, 2, 0, ctypes.byref(attribute_size)
        )
        attribute_buffer = ctypes.create_string_buffer(attribute_size.value)
        attribute_list = ctypes.c_void_p(ctypes.addressof(attribute_buffer))
        if not kernel32.InitializeProcThreadAttributeList(
            attribute_list, 2, 0, ctypes.byref(attribute_size)
        ):
            raise _last_error("InitializeProcThreadAttributeList")

        security_capabilities = SECURITY_CAPABILITIES(sid, None, 0, 0)
        inherited_handles = (wintypes.HANDLE * 3)(
            child_stdin_read,
            child_stdout_write,
            child_stderr_write,
        )
        _update_attribute(
            kernel32,
            attribute_list,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            security_capabilities,
            ctypes.sizeof(security_capabilities),
        )
        _update_attribute(
            kernel32,
            attribute_list,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited_handles,
            ctypes.sizeof(inherited_handles),
        )
        startup = STARTUPINFOEXW()
        startup.StartupInfo.cb = ctypes.sizeof(startup)
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES
        startup.StartupInfo.hStdInput = child_stdin_read
        startup.StartupInfo.hStdOutput = child_stdout_write
        startup.StartupInfo.hStdError = child_stderr_write
        startup.lpAttributeList = attribute_list
        command = tuple(config["command"])
        command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(command))
        environment = _environment_block(config["environment"])
        if not kernel32.CreateProcessW(
            command[0],
            command_line,
            None,
            None,
            True,
            EXTENDED_STARTUPINFO_PRESENT
            | CREATE_UNICODE_ENVIRONMENT
            | CREATE_NO_WINDOW
            | CREATE_SUSPENDED,
            environment,
            config["workingDirectory"],
            ctypes.byref(startup.StartupInfo),
            ctypes.byref(process_info),
        ):
            raise _last_error("CreateProcessW(AppContainer)")
        handles.extend((process_info.hProcess, process_info.hThread))
        if not kernel32.AssignProcessToJobObject(job, process_info.hProcess):
            kernel32.TerminateProcess(process_info.hProcess, 247)
            kernel32.WaitForSingleObject(process_info.hProcess, 5_000)
            raise _last_error("AssignProcessToJobObject")
        if kernel32.ResumeThread(process_info.hThread) == 0xFFFFFFFF:
            kernel32.TerminateJobObject(job, 247)
            kernel32.WaitForSingleObject(process_info.hProcess, 5_000)
            raise _last_error("ResumeThread")
        kernel32.CloseHandle(process_info.hThread)
        handles.remove(process_info.hThread)
        for child_handle in (child_stdin_read, child_stdout_write, child_stderr_write):
            kernel32.CloseHandle(child_handle)
            handles.remove(child_handle)

        stdin_thread = threading.Thread(
            target=_write_handle,
            args=(kernel32, parent_stdin_write, sys.stdin.buffer),
            daemon=True,
        )
        threads = (
            stdin_thread,
            threading.Thread(
                target=_read_handle,
                args=(kernel32, parent_stdout_read, sys.stdout.buffer),
                daemon=True,
            ),
            threading.Thread(
                target=_read_handle,
                args=(kernel32, parent_stderr_read, sys.stderr.buffer),
                daemon=True,
            ),
        )
        handles.remove(parent_stdin_write)
        try:
            stdin_thread.start()
        except BaseException:
            handles.append(parent_stdin_write)
            raise
        for thread in threads[1:]:
            thread.start()

        monitored = tuple(Path(item) for item in config["monitoredDirectories"])
        while True:
            wait = kernel32.WaitForSingleObject(process_info.hProcess, 50)
            if wait == WAIT_OBJECT_0:
                break
            if wait != WAIT_TIMEOUT:
                raise _last_error("WaitForSingleObject")
            if time.monotonic() - started > int(config["limits"]["wallSeconds"]):
                violation = "wall-time"
            elif sum(_directory_size(path) for path in monitored) > int(
                config["limits"]["diskBytes"]
            ):
                violation = "disk"
            if violation is not None:
                kernel32.TerminateJobObject(job, 246)
                kernel32.WaitForSingleObject(process_info.hProcess, 5_000)
                break

        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(
            process_info.hProcess, ctypes.byref(exit_code)
        ):
            raise _last_error("GetExitCodeProcess")
        for thread in threads[1:]:
            thread.join(timeout=1.0)
        _write_status(
            status_path,
            {
                "schemaVersion": 1,
                "status": "violated" if violation else "exited",
                "violation": violation,
                "childPid": process_info.dwProcessId,
                "exitCode": exit_code.value,
                "elapsedMillis": int((time.monotonic() - started) * 1_000),
            },
        )
        if violation is not None:
            print(
                "CANDLESCOPE_SANDBOX_VIOLATION:"
                + json.dumps({"kind": violation}, separators=(",", ":")),
                file=sys.stderr,
                flush=True,
            )
            return 246
        return int(exit_code.value) if exit_code.value <= 255 else 1
    except BaseException as exc:
        try:
            _write_status(
                status_path,
                {
                    "schemaVersion": 1,
                    "status": "launcher-error",
                    "errorType": type(exc).__name__,
                    "message": str(exc)[:1_024],
                    "elapsedMillis": int((time.monotonic() - started) * 1_000),
                },
            )
        except BaseException:
            pass
        print(
            "CANDLESCOPE_SANDBOX_LAUNCH_ERROR:"
            + json.dumps(
                {"type": type(exc).__name__, "message": str(exc)[:1_024]},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
            flush=True,
        )
        return 247
    finally:
        if attribute_list is not None:
            kernel32.DeleteProcThreadAttributeList(attribute_list)
        for handle in reversed(handles):
            if handle:
                kernel32.CloseHandle(handle)
        if sid.value:
            advapi32.FreeSid(sid)


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 1:
        print("usage: windows_runner.py CONFIG", file=sys.stderr)
        return 2
    return run(Path(arguments[0]).resolve(strict=True))


if __name__ == "__main__":
    raise SystemExit(main())
