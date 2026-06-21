from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_strategy_capture_prepare_priority_manifest(tmp_path: Path) -> None:
    out_dir = tmp_path / "capture-pack"

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_prepare.py"),
            "--out-dir",
            str(out_dir),
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert "prepared 10 capture script(s)" in completed.stdout
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["default_scope"] == "priority"
    assert manifest["case_count"] == 10
    assert len(manifest["entries"]) == 10
    first = manifest["entries"][0]
    assert first["fixture"] == "strategy_pine_equivalent_smoke.json"
    assert first["case"] == "market_round_trip_process_on_close"
    assert first["priority"] is True
    assert first["status"] == "captured"
    assert first["bars_file"] == (
        "01_strategy_pine_equivalent_smoke__"
        "market_round_trip_process_on_close_bars.csv"
    )
    assert first["bar_count"] == 4
    assert first["plot_titles"] == [
        "Position",
        "Equity",
        "Net Profit",
        "Open Profit",
        "Closed Trades",
    ]
    assert "--assertion parity" in first["diff_command"]
    pine_text = (out_dir / first["pine_file"]).read_text(encoding="utf-8")
    assert pine_text.startswith("//@version=5\n_pyne_capture_bars = 4\n")
    assert "if _pyne_capture_bar(0)\n    strategy.entry" in pine_text
    assert "if _pyne_capture_bar(2)\n    strategy.close" in pine_text
    assert "bar_index - (last_bar_index - _pyne_capture_bars)" in pine_text
    assert "bar_index == 0" not in pine_text
    assert 'plot(_pyne_capture_active ? (strategy.position_size) : na, "Position")' in pine_text
    assert (out_dir / first["bars_file"]).read_text(encoding="utf-8") == (
        "time,open,high,low,close,volume\n"
        "1,10,10.5,9.5,10,100\n"
        "2,11,11.5,10.5,11,100\n"
        "3,13,13.5,12.5,13,100\n"
        "4,12,12.5,11.5,12,100\n"
    )
    assert (out_dir / "README.md").read_text(encoding="utf-8").startswith(
        "# TradingView Strategy Capture Export Pack"
    )


def test_strategy_capture_prepare_all_cases(tmp_path: Path) -> None:
    out_dir = tmp_path / "capture-pack"

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_prepare.py"),
            "--out-dir",
            str(out_dir),
            "--all",
        ],
        check=True,
        cwd=ROOT,
    )

    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["default_scope"] == "all"
    assert manifest["case_count"] == 27
    assert all(entry["status"] == "captured" for entry in manifest["entries"])
    assert all("--assertion parity" in entry["diff_command"] for entry in manifest["entries"])
    for entry in manifest["entries"]:
        pine_text = (out_dir / entry["pine_file"]).read_text(encoding="utf-8")
        assert "mintick=" not in pine_text


def test_strategy_capture_prepare_case_filter(tmp_path: Path) -> None:
    out_dir = tmp_path / "capture-pack"

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_prepare.py"),
            "--out-dir",
            str(out_dir),
            "--all",
            "--case",
            "bracket_stop_exit",
        ],
        check=True,
        cwd=ROOT,
    )

    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["case_count"] == 1
    assert manifest["entries"][0]["case"] == "bracket_stop_exit"


def test_strategy_capture_prepare_refuses_to_clean_repo_root() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_prepare.py"),
            "--out-dir",
            str(ROOT),
            "--clean",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    assert "refusing to clean protected directory" in completed.stderr
