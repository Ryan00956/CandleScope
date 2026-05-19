from __future__ import annotations

import pyne_runtime as pn
from pyne_runtime import PyneSettings


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 1.5, "high": 2.5, "low": 1.4, "close": 2.0, "volume": 120},
    ]


def test_process_executor_runs_script() -> None:
    result = pn.run('plot(close, "Close")', _bars(), executor_mode="process")

    assert result.ok
    assert len(result.lines) == 1


def test_process_executor_kills_infinite_loop() -> None:
    settings = PyneSettings(timeout_seconds=0.2, process_grace_seconds=0.1)

    result = pn.run("while True:\n    pass", _bars(), settings=settings, executor_mode="process")

    assert not result.ok
    assert result.code == "PYNE_TIMEOUT"

