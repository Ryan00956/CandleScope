from __future__ import annotations

import ast
import os
import socket
from pathlib import Path

import pytest

from app.backtest.strategy.python_runner import (
    IsolatedPythonRunner,
    PythonRunnerError,
    sandbox_available,
)

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "candlescope-backtest-sdk"
    / "fixtures"
    / "sma_cross"
)
RUNNER_PATH = (
    Path(__file__).resolve().parents[1]
    / "app"
    / "backtest"
    / "strategy"
    / "python_runner.py"
)


def _frame(sequence: int, close: str) -> dict:
    return {
        "schemaVersion": "candlescope.python-strategy-observation/1",
        "runId": "bt_1",
        "revisionId": "rev_1",
        "generation": 1,
        "sequence": sequence,
        "eventTimeMs": sequence * 60_000,
        "watermarkMs": sequence * 60_000,
        "phase": "STEP",
        "market": {"symbol": "BTCUSDT"},
        "bar": {
            "openTimeMs": (sequence - 1) * 60_000,
            "closeTimeMs": sequence * 60_000,
            "open": close,
            "high": close,
            "low": close,
            "close": close,
            "volume": "1",
        },
        "features": {"close": close},
        "accountView": {"equity": "10000"},
        "inputHash": "sha256:" + "ab" * 32,
    }


def test_trusted_local_requires_flag_and_confirmation(monkeypatch) -> None:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "0")
    with pytest.raises(PythonRunnerError, match="TRUSTED_LOCAL_DISABLED"):
        IsolatedPythonRunner(FIXTURE, mode="TRUSTED_LOCAL", trusted_confirmed=True)
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    with pytest.raises(PythonRunnerError, match="TRUSTED_LOCAL_UNCONFIRMED"):
        IsolatedPythonRunner(FIXTURE, mode="TRUSTED_LOCAL", trusted_confirmed=False)


def test_sandboxed_local_fails_closed_when_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.backtest.strategy.python_runner.sandbox_available", lambda: False
    )
    with pytest.raises(PythonRunnerError, match="SANDBOX_UNAVAILABLE"):
        IsolatedPythonRunner(FIXTURE, mode="SANDBOXED_LOCAL")


def test_trusted_local_lifecycle_and_probe(monkeypatch) -> None:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    runner = IsolatedPythonRunner(
        FIXTURE, mode="TRUSTED_LOCAL", trusted_confirmed=True, step_timeout_s=5
    )
    runner.start()
    try:
        runner.call(
            "prepare",
            {
                "bundleDir": str(FIXTURE),
                "entrypoint": "strategy:Strategy",
                "parameters": {"fast": 2, "slow": 3},
            },
        )
        runner.call("warmup", {"observation": _frame(1, "10")})
        output = runner.call("step", {"observation": _frame(2, "20")})
        assert output["kind"] == "TARGET_POSITION"
        runner.call("close")
    finally:
        receipt = runner.close()
    assert runner._process is None
    assert receipt["mode"] == "TRUSTED_LOCAL"
    assert receipt["transcriptHash"].startswith("sha256:")


def test_runner_source_does_not_import_service_repository_or_database() -> None:
    tree = ast.parse(RUNNER_PATH.read_text(encoding="utf-8"))
    imported: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)
    forbidden = (
        "app.backtest.service",
        "app.backtest.repository",
        "sqlite3",
        "app.backtest.schema",
    )
    assert all(name not in imported for name in forbidden)
    assert sandbox_available() in {True, False}


@pytest.mark.parametrize("size,overflow", [(20_000, False), (100_000, True)])
def test_strategy_stderr_is_drained_and_bounded(tmp_path, monkeypatch, size, overflow):
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    (tmp_path / "strategy.py").write_text(
        f"class Strategy:\n def prepare(self, ctx):\n  print('x' * {size}, end='', flush=True)\n",
        encoding="utf-8",
    )
    runner = IsolatedPythonRunner(
        tmp_path, mode="TRUSTED_LOCAL", trusted_confirmed=True
    )
    runner.start()
    try:
        if overflow:
            with pytest.raises(PythonRunnerError, match="STDERR_TOO_LARGE"):
                runner.call(
                    "prepare",
                    {"bundleDir": str(tmp_path), "entrypoint": "strategy:Strategy"},
                )
        else:
            assert runner.call(
                "prepare",
                {"bundleDir": str(tmp_path), "entrypoint": "strategy:Strategy"},
            ) == {"ok": True}
    finally:
        receipt = runner.close()
    assert receipt["stderrBytes"] >= min(size, 65536)
    assert receipt["stderrOverflow"] is overflow


@pytest.mark.skipif(os.name != "nt", reason="Windows AppContainer only")
def test_sandboxed_strategy_runs_sdk_but_cannot_read_host_file_or_connect_loopback(
    tmp_path,
):
    marker = tmp_path / "host-private.txt"
    marker.write_text("host secret", encoding="utf-8")
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    (bundle / "strategy.py").write_text(
        f"""
import socket
from pathlib import Path
class Strategy:
 def prepare(self, ctx):
  try: Path({str(marker)!r}).read_text(); self.file = True
  except OSError: self.file = False
  try:
   with socket.create_connection(('127.0.0.1', {port}), timeout=0.3): self.network = True
  except OSError: self.network = False
 def snapshot(self): return {{'file': self.file, 'network': self.network}}
 def close(self): pass
""",
        encoding="utf-8",
    )
    runner = IsolatedPythonRunner(bundle, mode="SANDBOXED_LOCAL", step_timeout_s=5)
    try:
        runner.start()
        runner.call(
            "prepare", {"bundleDir": str(bundle), "entrypoint": "strategy:Strategy"}
        )
        snapshot = runner.call("snapshot")
        assert snapshot["payload"] == {"file": False, "network": False}
        runner.call("close")
    finally:
        runner.close()
        listener.close()


def test_request_write_is_covered_by_step_timeout(tmp_path, monkeypatch):
    import subprocess
    import sys
    import time

    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    runner = IsolatedPythonRunner(
        tmp_path, mode="TRUSTED_LOCAL", trusted_confirmed=True, step_timeout_s=0.1
    )
    # A hung worker deliberately never consumes stdin. The allowed request exceeds the OS pipe buffer.
    child = subprocess.Popen(
        [sys.executable, "-I", "-c", "import time; time.sleep(30)"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    runner._process = child
    started = time.monotonic()
    try:
        with pytest.raises(PythonRunnerError, match="PROVIDER_TIMEOUT"):
            runner.call("restore", {"payload": "x" * 100_000})
        assert time.monotonic() - started < 3
        assert child.poll() is not None
    finally:
        runner.close()


@pytest.mark.skipif(os.name != "nt", reason="Windows AppContainer ACL lifecycle")
def test_disposable_strategy_profiles_do_not_accumulate_shared_acl_grants(tmp_path):
    import re
    import subprocess
    from app.backtest.strategy.python_runner import SDK_SRC

    def grants(path):
        result = subprocess.run(
            ["icacls.exe", str(path)], check=True, capture_output=True
        )
        return sorted(
            re.findall(
                r"S-1-15-2-(?:\d+-)*\d+", result.stdout.decode("ascii", errors="ignore")
            )
        )

    baseline = grants(SDK_SRC)
    worker_baseline = grants(SDK_SRC / "candlescope_backtest_sdk" / "worker.py")
    for _ in range(2):
        runner = IsolatedPythonRunner(tmp_path, mode="SANDBOXED_LOCAL")
        try:
            runner.start()
            assert runner._sandbox_sid in grants(SDK_SRC)
        finally:
            runner.close()
        assert grants(SDK_SRC) == baseline
        assert (
            grants(SDK_SRC / "candlescope_backtest_sdk" / "worker.py")
            == worker_baseline
        )
