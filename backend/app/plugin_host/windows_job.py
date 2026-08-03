"""Atomic Windows Job Object attachment for direct sidecar launches."""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes


CREATE_SUSPENDED = 0x00000004
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
PROCESS_SUSPEND_RESUME = 0x0800
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x00100000
JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9


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


def _kernel32() -> ctypes.WinDLL:
    if os.name != "nt":
        raise OSError("Windows Job Objects are unavailable on this platform")
    library = ctypes.WinDLL("kernel32", use_last_error=True)
    library.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    library.CreateJobObjectW.restype = wintypes.HANDLE
    library.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    library.SetInformationJobObject.restype = wintypes.BOOL
    library.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    library.OpenProcess.restype = wintypes.HANDLE
    library.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    library.AssignProcessToJobObject.restype = wintypes.BOOL
    library.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    library.TerminateJobObject.restype = wintypes.BOOL
    library.CloseHandle.argtypes = [wintypes.HANDLE]
    library.CloseHandle.restype = wintypes.BOOL
    return library


def _last_error(label: str) -> OSError:
    code = ctypes.get_last_error()
    return OSError(code, f"{label} failed: {ctypes.FormatError(code).strip()}")


class WindowsJobController:
    """Own one kill-on-close Job after a child was created suspended."""

    def __init__(self, handle: wintypes.HANDLE) -> None:
        self._handle = handle

    @classmethod
    def attach_and_resume(
        cls,
        process_id: int,
        *,
        max_processes: int,
    ) -> "WindowsJobController":
        if (
            isinstance(process_id, bool)
            or not isinstance(process_id, int)
            or process_id <= 0
            or isinstance(max_processes, bool)
            or not isinstance(max_processes, int)
            or not 1 <= max_processes <= 32
        ):
            raise ValueError("Windows Job process limits are invalid")
        kernel32 = _kernel32()
        ntdll = ctypes.WinDLL("ntdll")
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        ntdll.NtResumeProcess.restype = ctypes.c_long
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise _last_error("CreateJobObjectW")
        process_handle = wintypes.HANDLE()
        try:
            limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            limits.BasicLimitInformation.LimitFlags = (
                JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            )
            limits.BasicLimitInformation.ActiveProcessLimit = max_processes
            if not kernel32.SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ):
                raise _last_error("SetInformationJobObject")
            process_handle = kernel32.OpenProcess(
                PROCESS_TERMINATE
                | PROCESS_SET_QUOTA
                | PROCESS_SUSPEND_RESUME
                | PROCESS_QUERY_LIMITED_INFORMATION
                | SYNCHRONIZE,
                False,
                process_id,
            )
            if not process_handle:
                raise _last_error("OpenProcess")
            if not kernel32.AssignProcessToJobObject(job, process_handle):
                raise _last_error("AssignProcessToJobObject")
            status = ntdll.NtResumeProcess(process_handle)
            if ctypes.c_long(status).value < 0:
                raise OSError(
                    ctypes.c_ulong(status).value,
                    "NtResumeProcess failed",
                )
            return cls(job)
        except BaseException:
            kernel32.TerminateJobObject(job, 247)
            kernel32.CloseHandle(job)
            raise
        finally:
            if process_handle:
                kernel32.CloseHandle(process_handle)

    @property
    def active(self) -> bool:
        return bool(self._handle)

    def terminate(self, exit_code: int = 246) -> None:
        if not self._handle:
            return
        kernel32 = _kernel32()
        if not kernel32.TerminateJobObject(self._handle, exit_code):
            code = ctypes.get_last_error()
            if code not in {5, 6}:
                raise _last_error("TerminateJobObject")

    def close(self) -> None:
        handle = self._handle
        self._handle = wintypes.HANDLE()
        if handle:
            kernel32 = _kernel32()
            if not kernel32.CloseHandle(handle):
                code = ctypes.get_last_error()
                if code != 6:
                    raise _last_error("CloseHandle(JobObject)")
