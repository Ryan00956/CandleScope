from __future__ import annotations

import os
import subprocess
import sys
import types
from pathlib import Path

from plugin_sdk_isolation import SDK_SOURCE, pin_in_repo_plugin_sdk


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def test_pin_evicts_sibling_worktree_plugin_sdk(tmp_path: Path, monkeypatch) -> None:
    foreign_root = tmp_path / "CandleScope-other" / "packages" / "candlescope-plugin-sdk" / "src"
    foreign_pkg = foreign_root / "candlescope_plugin_sdk"
    foreign_pkg.mkdir(parents=True)
    (foreign_pkg / "__init__.py").write_text("__version__ = 'foreign'\n", encoding="utf-8")
    constants = foreign_pkg / "platform_v2"
    constants.mkdir()
    (constants / "__init__.py").write_text("", encoding="utf-8")
    (constants / "constants.py").write_text(
        'ACTIVATION_EVENTS = frozenset({"onBacktestRun"})\n',
        encoding="utf-8",
    )

    fake = types.ModuleType("candlescope_plugin_sdk")
    fake.__file__ = str(foreign_pkg / "__init__.py")
    fake.__version__ = "foreign"
    monkeypatch.setitem(sys.modules, "candlescope_plugin_sdk", fake)
    sys.path.insert(0, str(foreign_root))

    pinned = pin_in_repo_plugin_sdk()

    assert pinned == SDK_SOURCE
    assert Path(sys.path[0]).resolve() == SDK_SOURCE
    assert "candlescope_plugin_sdk" not in sys.modules
    import candlescope_plugin_sdk
    from candlescope_plugin_sdk.platform_v2.constants import ACTIVATION_EVENTS

    assert "onBacktestRun" not in ACTIVATION_EVENTS
    origin = Path(candlescope_plugin_sdk.__file__).resolve()
    assert SDK_SOURCE in origin.parents


def test_repository_cli_bootstraps_sdk_in_clean_child_process() -> None:
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    environment["PYTHONNOUSERSITE"] = "1"

    completed = subprocess.run(
        [
            sys.executable,
            str(BACKEND_ROOT / "scripts" / "candlescope_plugin.py"),
            "v3",
            "--help",
        ],
        cwd=BACKEND_ROOT.parent,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert "source-lock-check" in completed.stdout
