from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.backtest.strategy.python_runner import (
    IsolatedPythonRunner,
    PythonRunnerError,
    probe_twice,
    sandbox_available,
)

SMA = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "candlescope-backtest-sdk"
    / "fixtures"
    / "sma_cross"
)


def _write_bundle(root: Path, source: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "strategy.py").write_text(source, encoding="utf-8", newline="\n")
    (root / "strategy.json").write_text(
        (SMA / "strategy.json").read_text(encoding="utf-8"),
        encoding="utf-8",
        newline="\n",
    )
    (root / "requirements.lock").write_text(
        (SMA / "requirements.lock").read_text(encoding="utf-8"),
        encoding="utf-8",
        newline="\n",
    )
    return root


def _frame(sequence: int = 1) -> dict:
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
            "open": "10",
            "high": "10",
            "low": "10",
            "close": "10",
            "volume": "1",
        },
        "features": {"close": "10"},
        "accountView": {"equity": "1"},
        "inputHash": "sha256:" + "ab" * 32,
    }


def _runner(path: Path, monkeypatch, timeout: float = 1.5) -> IsolatedPythonRunner:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    return IsolatedPythonRunner(
        path, mode="TRUSTED_LOCAL", trusted_confirmed=True, step_timeout_s=timeout
    )


def test_sandboxed_does_not_silently_downgrade(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.backtest.strategy.python_runner.sandbox_available", lambda: False
    )
    with pytest.raises(PythonRunnerError, match="SANDBOX_UNAVAILABLE"):
        IsolatedPythonRunner(SMA, mode="SANDBOXED_LOCAL")


def test_timeout_kills_infinite_loop_and_leaves_no_child(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_bundle(
        tmp_path / "loop",
        "class Strategy:\n"
        "    def prepare(self, context): pass\n"
        "    def warmup(self, observation): pass\n"
        "    def step(self, observation):\n"
        "        while True:\n"
        "            pass\n"
        "    def on_execution_report(self, report): pass\n"
        "    def snapshot(self): return {}\n"
        "    def restore(self, payload): pass\n"
        "    def close(self): pass\n",
    )
    runner = _runner(bundle, monkeypatch, timeout=0.4)
    runner.start()
    proc = runner._process
    with pytest.raises(PythonRunnerError, match="PROVIDER_TIMEOUT"):
        runner.call("prepare", {"bundleDir": str(bundle), "entrypoint": "strategy:Strategy", "parameters": {}})
        runner.call("step", {"observation": _frame()})
    assert runner._process is None
    assert proc is not None
    assert proc.poll() is not None


def test_stdout_noise_from_user_print_does_not_break_protocol(
    tmp_path: Path, monkeypatch
) -> None:
    bundle = _write_bundle(
        tmp_path / "printy",
        "from candlescope_backtest_sdk import TargetPosition\n"
        "class Strategy:\n"
        "    def prepare(self, context): print('user-log')\n"
        "    def warmup(self, observation): pass\n"
        "    def step(self, observation):\n"
        "        print('noise')\n"
        "        return TargetPosition(quantity='0')\n"
        "    def on_execution_report(self, report): pass\n"
        "    def snapshot(self): return {}\n"
        "    def restore(self, payload): pass\n"
        "    def close(self): pass\n",
    )
    runner = _runner(bundle, monkeypatch)
    runner.start()
    try:
        runner.call(
            "prepare",
            {"bundleDir": str(bundle), "entrypoint": "strategy:Strategy", "parameters": {}},
        )
        output = runner.call("step", {"observation": _frame()})
        assert output["kind"] == "TARGET_POSITION"
    finally:
        runner.close()


def test_invalid_json_and_eof_are_classified(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_bundle(
        tmp_path / "crash",
        "class Strategy:\n"
        "    def prepare(self, context): raise SystemExit(0)\n"
        "    def warmup(self, observation): pass\n"
        "    def step(self, observation): pass\n"
        "    def on_execution_report(self, report): pass\n"
        "    def snapshot(self): return {}\n"
        "    def restore(self, payload): pass\n"
        "    def close(self): pass\n",
    )
    runner = _runner(bundle, monkeypatch)
    runner.start()
    with pytest.raises(PythonRunnerError, match="PROVIDER_EOF|PROVIDER_PROTOCOL"):
        runner.call(
            "prepare",
            {"bundleDir": str(bundle), "entrypoint": "strategy:Strategy", "parameters": {}},
        )
    runner.close()


def test_probe_twice_matches_for_sma(monkeypatch) -> None:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    result = probe_twice(
        SMA,
        [_frame(1), _frame(2)],
        mode="TRUSTED_LOCAL",
        trusted_confirmed=True,
        step_timeout_s=5,
    )
    assert result["repeats"] == 2
    assert result["transcriptHash"].startswith("sha256:")


def test_attack_matrix_records_sandbox_unavailable_fail_closed() -> None:
    assert sandbox_available() in {True, False}
    # AST/builtin stripping is not the security boundary; SANDBOXED_LOCAL
    # must fail closed when AppContainer is missing.
    if not sandbox_available():
        with pytest.raises(PythonRunnerError, match="SANDBOX_UNAVAILABLE"):
            IsolatedPythonRunner(SMA, mode="SANDBOXED_LOCAL")
