from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import uuid
import ctypes
import zipfile
from pathlib import Path

import pytest

from app.plugin_host.process import ManagedSidecarProcess, SidecarProcessSpec
from app.plugin_security_v2 import (
    PlatformSecurityError,
    SandboxPolicy,
    delete_appcontainer_profile,
    prepare_sandbox_launch,
)
from app.plugin_security_v2.python_runtime import (
    _destination_files,
    _source_inventory,
    _validate_cached_runtime,
)


FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures" / "plugin_platform_v2"
PROBE_SOURCE = FIXTURE_DIRECTORY / "windows_malicious_probe.c"


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows AppContainer only")


def test_pinned_runtime_copies_base_interpreter_instead_of_venv_launcher() -> None:
    base, copied, _standard_library = _source_inventory(Path(sys.executable))

    source, destination = copied[0]
    assert destination == "python.exe"
    assert os.path.samefile(source, base / "python.exe")
    if sys.prefix != sys.base_prefix:
        assert not os.path.samefile(source, Path(sys.executable))


def test_cached_pinned_runtime_manifest_cannot_rebind_tampered_content(
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    executable = runtime / "python.exe"
    executable.write_bytes(b"host-python")
    library_source = b"VALUE = 'host-stdlib'\n"
    archive_name = f"python{sys.version_info.major}{sys.version_info.minor}.zip"
    with zipfile.ZipFile(
        runtime / archive_name,
        "w",
        compression=zipfile.ZIP_STORED,
        allowZip64=False,
    ) as archive:
        info = zipfile.ZipInfo("host_module.py", (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = 0o444 << 16
        archive.writestr(info, library_source)
    identity = "sha256:" + ("a" * 64)
    records = [
        {
            "path": "python.exe",
            "sha256": f"sha256:{hashlib.sha256(b'host-python').hexdigest()}",
            "size": len(b"host-python"),
            "storage": "file",
        },
        {
            "path": "host_module.py",
            "sha256": f"sha256:{hashlib.sha256(library_source).hexdigest()}",
            "size": len(library_source),
            "storage": "stdlib-archive",
        },
    ]
    manifest_path = runtime / "runtime-manifest-v1.json"
    manifest = {
        "schemaVersion": 1,
        "identitySha256": identity,
        "pythonVersion": (
            f"{sys.version_info.major}.{sys.version_info.minor}."
            f"{sys.version_info.micro}"
        ),
        "files": _destination_files(runtime),
    }
    manifest_path.write_text(
        json.dumps(manifest, separators=(",", ":")),
        encoding="utf-8",
    )
    _validate_cached_runtime(runtime, identity, records)

    executable.write_bytes(b"attacker-python")
    manifest["files"] = _destination_files(runtime)
    manifest_path.write_text(
        json.dumps(manifest, separators=(",", ":")),
        encoding="utf-8",
    )
    with pytest.raises(PlatformSecurityError) as failure:
        _validate_cached_runtime(runtime, identity, records)
    assert failure.value.code == "PLUGIN_SANDBOX_PYTHON_RUNTIME_INVALID"


def test_sandbox_policy_rejects_overlapping_or_drive_roots(tmp_path: Path) -> None:
    installation = tmp_path / "installation"
    with pytest.raises(ValueError, match="must not overlap"):
        SandboxPolicy(
            "CandleScope.Test.Overlap",
            installation,
            tmp_path / "private",
            tmp_path / "private" / "runtime",
        )
    with pytest.raises(ValueError, match="read-only roots"):
        SandboxPolicy(
            "CandleScope.Test.ReadOverlap",
            installation,
            tmp_path / "private",
            tmp_path / "runtime",
            additional_read_only_paths=(tmp_path,),
        )
    with pytest.raises(ValueError, match="drive roots"):
        SandboxPolicy(
            "CandleScope.Test.DriveRoot",
            Path(tmp_path.anchor),
            tmp_path / "private",
            tmp_path / "runtime",
        )


@pytest.fixture
def compiled_probe(tmp_path: Path) -> tuple[Path, Path]:
    clang = shutil.which("clang-cl.exe")
    if clang is None:
        pytest.skip("clang.exe is required for the real native AppContainer probe")
    installation = tmp_path / "installation"
    installation.mkdir()
    executable = installation / "windows-malicious-probe.exe"
    completed = subprocess.run(
        [
            clang,
            "/O2",
            "/MT",
            str(PROBE_SOURCE),
            "/link",
            "/subsystem:console",
            "ws2_32.lib",
            "advapi32.lib",
            f"/out:{executable}",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        shell=False,
    )
    assert completed.returncode == 0, completed.stderr
    return installation, executable


@pytest.fixture
def sandbox_policy(
    tmp_path: Path,
    compiled_probe: tuple[Path, Path],
) -> SandboxPolicy:
    installation, _executable = compiled_probe
    profile_name = f"CandleScope.Test.{uuid.uuid4().hex[:24]}"
    policy = SandboxPolicy(
        profile_name,
        installation,
        tmp_path / "private",
        tmp_path / "runtime",
        memory_limit_bytes=256 * 1024 * 1024,
        cpu_rate_percent=25,
        cpu_time_seconds=10,
        disk_limit_bytes=4 * 1024 * 1024,
        max_processes=1,
        max_wall_seconds=15,
    )
    try:
        yield policy
    finally:
        delete_appcontainer_profile(profile_name)


def _run_prepared(
    prepared, *, timeout: float = 30.0
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(prepared.command),
        cwd=prepared.working_directory,
        env=prepared.environment,
        input="",
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        shell=False,
    )


def test_real_appcontainer_denies_files_network_and_children_and_enforces_memory(
    tmp_path: Path,
    compiled_probe: tuple[Path, Path],
    sandbox_policy: SandboxPolicy,
) -> None:
    installation, executable = compiled_probe
    secret = tmp_path / "outside-secret.txt"
    secret.write_text("must-not-be-readable", encoding="utf-8")
    installation_write = installation / "must-not-write.txt"
    private_write = sandbox_policy.private_directory / "data" / "allowed.txt"
    source_target = Path(__file__).parents[1] / "app" / "main.py"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as loopback_server:
        loopback_server.bind(("127.0.0.1", 0))
        loopback_server.listen(1)
        loopback_port = loopback_server.getsockname()[1]
        prepared = prepare_sandbox_launch(
            sandbox_policy,
            (
                str(executable),
                "attack",
                str(secret),
                str(source_target),
                str(installation_write),
                str(private_write),
                str(loopback_port),
            ),
            installation,
        )

        completed = _run_prepared(prepared)
        assert completed.returncode == 0, completed.stderr
        result = json.loads(completed.stdout)
        loopback_error = result.pop("loopbackError")
        external_error = result.pop("externalError")
        assert loopback_error in {10013, 10060}
        assert external_error == 10013
        loopback_server.setblocking(False)
        with pytest.raises(BlockingIOError):
            loopback_server.accept()
    assert result == {
        "secretRead": False,
        "sourceRead": False,
        "installationWrite": False,
        "privateWrite": True,
        "loopbackDenied": True,
        "externalDenied": True,
        "childProcessDenied": True,
        "appContainer": True,
        "inJob": True,
        "allocatedBytes": result["allocatedBytes"],
    }
    assert 0 < result["allocatedBytes"] < 512 * 1024 * 1024
    assert private_write.read_text(encoding="utf-8") == "sandbox-probe"
    assert not installation_write.exists()
    status = json.loads(prepared.status_path.read_text(encoding="utf-8"))
    assert status["status"] == "exited"
    assert status["exitCode"] == 0


def test_disk_quota_terminates_only_the_sandbox_process(
    compiled_probe: tuple[Path, Path],
    sandbox_policy: SandboxPolicy,
) -> None:
    installation, executable = compiled_probe
    disk_target = sandbox_policy.private_directory / "data" / "disk.bin"
    limited = SandboxPolicy(
        sandbox_policy.profile_name,
        installation,
        sandbox_policy.private_directory,
        sandbox_policy.runtime_directory,
        memory_limit_bytes=sandbox_policy.memory_limit_bytes,
        disk_limit_bytes=1024 * 1024,
        max_wall_seconds=15,
    )
    prepared = prepare_sandbox_launch(
        limited,
        (str(executable), "disk", str(disk_target)),
        installation,
    )

    completed = _run_prepared(prepared)
    assert completed.returncode == 246
    assert "CANDLESCOPE_SANDBOX_VIOLATION" in completed.stderr
    status = json.loads(prepared.status_path.read_text(encoding="utf-8"))
    assert status["status"] == "violated"
    assert status["violation"] == "disk"
    assert disk_target.stat().st_size >= 1024 * 1024


def test_cpu_time_quota_terminates_only_the_sandbox_process(
    compiled_probe: tuple[Path, Path],
    sandbox_policy: SandboxPolicy,
) -> None:
    installation, executable = compiled_probe
    limited = SandboxPolicy(
        sandbox_policy.profile_name,
        installation,
        sandbox_policy.private_directory,
        sandbox_policy.runtime_directory,
        memory_limit_bytes=sandbox_policy.memory_limit_bytes,
        cpu_rate_percent=100,
        cpu_time_seconds=1,
        disk_limit_bytes=sandbox_policy.disk_limit_bytes,
        max_wall_seconds=10,
    )
    prepared = prepare_sandbox_launch(
        limited,
        (str(executable), "cpu"),
        installation,
    )

    completed = _run_prepared(prepared)
    assert completed.returncode != 0
    status = json.loads(prepared.status_path.read_text(encoding="utf-8"))
    assert status["status"] == "exited"
    assert status["exitCode"] != 0
    assert status["elapsedMillis"] < 8_000


@pytest.mark.anyio
async def test_appcontainer_forwards_interactive_jsonl_without_waiting_for_eof(
    compiled_probe: tuple[Path, Path],
    sandbox_policy: SandboxPolicy,
) -> None:
    installation, executable = compiled_probe
    managed = ManagedSidecarProcess(
        SidecarProcessSpec(
            "candlescope.sandbox-probe:echo",
            executable,
            ("echo",),
            installation,
            sandbox_policy=sandbox_policy,
        )
    )
    await managed.start()
    try:
        assert managed.connection is not None
        payload = b'{"phase":12,"streaming":true}'
        await asyncio.wait_for(managed.connection.write(payload), timeout=3.0)
        echoed = await asyncio.wait_for(managed.connection.read(), timeout=3.0)
        assert echoed == payload
    finally:
        await managed.terminate()


def test_runner_exits_cleanly_while_parent_stdin_remains_open(
    compiled_probe: tuple[Path, Path],
    sandbox_policy: SandboxPolicy,
) -> None:
    installation, executable = compiled_probe
    prepared = prepare_sandbox_launch(
        sandbox_policy,
        (str(executable), "exit-without-reading-stdin"),
        installation,
    )
    process = subprocess.Popen(
        list(prepared.command),
        cwd=prepared.working_directory,
        env=prepared.environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
    )
    try:
        assert process.stdin is not None
        assert process.stdin.closed is False
        return_code = process.wait(timeout=10)
        assert process.stdin.closed is False
        stdout = process.stdout.read() if process.stdout is not None else ""
        stderr = process.stderr.read() if process.stderr is not None else ""
        assert return_code == 2, (stdout, stderr)
        assert "CANDLESCOPE_SANDBOX_LAUNCH_ERROR" not in stderr
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()
    status = json.loads(prepared.status_path.read_text(encoding="utf-8"))
    assert status["status"] == "exited"
    assert status["exitCode"] == 2


@pytest.mark.anyio
async def test_stderr_overflow_kills_wrapper_and_its_appcontainer_job_tree(
    compiled_probe: tuple[Path, Path],
    sandbox_policy: SandboxPolicy,
) -> None:
    installation, executable = compiled_probe
    child_pid_path = sandbox_policy.private_directory / "data" / "child.pid"
    managed = ManagedSidecarProcess(
        SidecarProcessSpec(
            "candlescope.sandbox-probe:main",
            executable,
            ("stderr", str(child_pid_path)),
            installation,
            max_stderr_bytes=16 * 1024,
            sandbox_policy=sandbox_policy,
        )
    )
    process = await managed.start()
    try:
        await process.wait()
        assert managed.stderr_overflow is True
        assert process.returncode != 0
        child_pid = int(child_pid_path.read_text(encoding="utf-8"))
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [
            ctypes.c_ulong,
            ctypes.c_int,
            ctypes.c_ulong,
        ]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel32.WaitForSingleObject.restype = ctypes.c_ulong
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.OpenProcess(0x00100000, False, child_pid)
        if handle:
            try:
                # Closing the runner's kill-on-close Job Object queues child
                # termination, but Windows does not guarantee that the child
                # handle is signalled in the same scheduler tick as the runner.
                assert kernel32.WaitForSingleObject(handle, 2_000) == 0
            finally:
                kernel32.CloseHandle(handle)
    finally:
        await managed.terminate()
