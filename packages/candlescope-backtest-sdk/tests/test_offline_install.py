from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_wheel_and_sdist_install_and_import_twice_offline(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    subprocess.run(
        [sys.executable, "-m", "pip", "wheel", "--no-deps", "-w", str(dist), str(ROOT)],
        check=True,
        capture_output=True,
        text=True,
    )
    wheels = list(dist.glob("candlescope_backtest_sdk-*.whl"))
    assert len(wheels) == 1
    target = tmp_path / "site"
    target.mkdir()
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            "--target",
            str(target),
            str(wheels[0]),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    env_path = str(target)
    script = (
        "import sys; sys.path.insert(0, %r); "
        "import candlescope_backtest_sdk as m; "
        "from candlescope_backtest_sdk import Observation, StrategyContext, "
        "Signal, TargetPosition, OrderIntent; "
        "print(m.AUTHOR_CONTRACT, Observation.__name__, "
        "StrategyContext.__name__, Signal.__name__, "
        "TargetPosition.__name__, OrderIntent.__name__)"
        % env_path
    )
    first = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
    )
    second = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
    )
    assert first.stdout == second.stdout
    assert "candlescope.python-strategy/1" in first.stdout
    assert "Observation" in first.stdout
    assert "TargetPosition" in first.stdout
    assert "OrderIntent" in first.stdout
