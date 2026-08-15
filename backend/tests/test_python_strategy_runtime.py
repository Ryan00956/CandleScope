from __future__ import annotations

import ast
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
    monkeypatch.delenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", raising=False)
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
