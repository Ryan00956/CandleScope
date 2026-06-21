from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_ta_capture_prepare_priority_manifest(tmp_path: Path) -> None:
    out_dir = tmp_path / "capture-pack"

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "ta_capture_prepare.py"),
            "--out-dir",
            str(out_dir),
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert "prepared 1 TA capture script(s)" in completed.stdout
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["capture_type"] == "ta"
    assert manifest["default_scope"] == "priority"
    assert manifest["fixture_count"] == 1
    first = manifest["entries"][0]
    assert first["fixture"] == "ta_core_indicators.json"
    assert first["priority"] is True
    assert first["status"] == "captured"
    assert first["bar_count"] == 10
    assert first["capture_index_title"] == "Pyne Capture Index"
    assert "--assertion parity" in first["diff_command"]

    pine_text = (out_dir / first["pine_file"]).read_text(encoding="utf-8")
    assert pine_text.startswith("//@version=5\n_pyne_capture_bars = 10\n")
    assert 'plot(_pyne_capture_active ? _pyne_capture_index : na, "Pyne Capture Index")' in pine_text
    assert "_pyne_dmi(h, l, c, di_length, adx_smoothing) =>" in pine_text
    assert "ta.sma(_pyne_close, 3)" in pine_text
    assert "condition = _pyne_close > 14" in pine_text
    assert "mintick=" not in pine_text
    assert (out_dir / first["bars_file"]).read_text(encoding="utf-8").startswith(
        "time,open,high,low,close,volume\n"
    )


def test_ta_capture_prepare_all_fixtures(tmp_path: Path) -> None:
    out_dir = tmp_path / "capture-pack"

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "ta_capture_prepare.py"),
            "--out-dir",
            str(out_dir),
            "--all",
        ],
        check=True,
        cwd=ROOT,
    )

    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["default_scope"] == "all"
    assert manifest["fixture_count"] == 9
    statuses = {entry["fixture"]: entry["status"] for entry in manifest["entries"]}
    assert statuses["ta_core_indicators.json"] == "captured"
    assert statuses["ta_advanced_indicators.json"] == "captured"
    assert statuses["ta_context_indicators.json"] == "captured"
    assert statuses["ta_oscillator_edges_indicators.json"] == "captured"
    assert statuses["ta_remaining_indicators.json"] == "captured"
    assert statuses["ta_statistics_edges_indicators.json"] == "captured"
    assert statuses["ta_trend_switch_indicators.json"] == "captured"
    assert statuses["ta_tuple_outputs_indicators.json"] == "captured"
    assert statuses["ta_warmup_boundaries_indicators.json"] == "captured"
    assert sum(status == "missing" for status in statuses.values()) == 0

    advanced = next(entry for entry in manifest["entries"] if entry["fixture"] == "ta_advanced_indicators.json")
    advanced_pine = (out_dir / advanced["pine_file"]).read_text(encoding="utf-8")
    assert "[plus_di, minus_di, adx] = _pyne_dmi(_pyne_high, _pyne_low, _pyne_close, 3, 3)" in advanced_pine
    assert "_pyne_atr(_pyne_high, _pyne_low, _pyne_close, 3)" in advanced_pine
    assert "_pyne_sar(_pyne_high, _pyne_low, _pyne_close, 0.02, 0.02, 0.2)" in advanced_pine

    context = next(entry for entry in manifest["entries"] if entry["fixture"] == "ta_context_indicators.json")
    context_pine = (out_dir / context["pine_file"]).read_text(encoding="utf-8")
    assert "_pyne_supertrend(_pyne_high, _pyne_low, _pyne_close, 2, 3)" in context_pine
    assert "_pyne_mfi(_pyne_close, _pyne_volume, 4)" in context_pine
    assert "_pyne_vwma(_pyne_close, _pyne_volume, 4)" in context_pine

    oscillator = next(entry for entry in manifest["entries"] if entry["fixture"] == "ta_oscillator_edges_indicators.json")
    oscillator_pine = (out_dir / oscillator["pine_file"]).read_text(encoding="utf-8")
    assert "_pyne_wpr(_pyne_high, _pyne_low, _pyne_close, 3)" in oscillator_pine
    assert "_pyne_mfi(_pyne_close, _pyne_volume, 6)" in oscillator_pine
    assert "ta.cmo(_pyne_close, 6)" in oscillator_pine

    statistics = next(entry for entry in manifest["entries"] if entry["fixture"] == "ta_statistics_edges_indicators.json")
    statistics_pine = (out_dir / statistics["pine_file"]).read_text(encoding="utf-8")
    assert "ta.percentile_nearest_rank(_pyne_close, 4, 25)" in statistics_pine
    assert "ta.percentile_linear_interpolation(_pyne_close, 7, 75)" in statistics_pine
    assert "ta.variance(_pyne_close, 4, false)" in statistics_pine

    trend_switch = next(entry for entry in manifest["entries"] if entry["fixture"] == "ta_trend_switch_indicators.json")
    trend_switch_pine = (out_dir / trend_switch["pine_file"]).read_text(encoding="utf-8")
    assert "_pyne_supertrend(_pyne_high, _pyne_low, _pyne_close, 1.5, 3)" in trend_switch_pine
    assert "_pyne_sar(_pyne_high, _pyne_low, _pyne_close, 0.04, 0.04, 0.2)" in trend_switch_pine
    assert "[plus_di, minus_di, adx] = _pyne_dmi(_pyne_high, _pyne_low, _pyne_close, 4, 3)" in trend_switch_pine

    tuple_outputs = next(entry for entry in manifest["entries"] if entry["fixture"] == "ta_tuple_outputs_indicators.json")
    tuple_pine = (out_dir / tuple_outputs["pine_file"]).read_text(encoding="utf-8")
    assert "[macd_line, macd_signal, macd_hist] = ta.macd(_pyne_close, 4, 8, 3)" in tuple_pine
    assert "[bb_mid, bb_upper, bb_lower] = ta.bb(_pyne_close, 5, 1.5)" in tuple_pine
    assert "[plus_di, minus_di, adx] = _pyne_dmi(_pyne_high, _pyne_low, _pyne_close, 5, 4)" in tuple_pine


def test_ta_capture_prepare_explicit_fixture_bypasses_priority(tmp_path: Path) -> None:
    out_dir = tmp_path / "capture-pack"

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "ta_capture_prepare.py"),
            "--out-dir",
            str(out_dir),
            "--fixture",
            "ta_warmup_boundaries_indicators.json",
        ],
        check=True,
        cwd=ROOT,
    )

    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["fixture_count"] == 1
    entry = manifest["entries"][0]
    assert entry["fixture"] == "ta_warmup_boundaries_indicators.json"
    assert entry["priority"] is False
    assert entry["status"] == "captured"
    assert entry["plot_titles"] == [
        "SMA 1",
        "SMA 12",
        "EMA 2",
        "RMA 2",
        "RSI 2",
        "Stoch 5",
        "MFI 5",
        "VWMA 5",
        "PNR 80",
        "PLI 80",
        "STDEV 5",
        "VAR 5",
        "DEV 5",
    ]

    pine_text = (out_dir / entry["pine_file"]).read_text(encoding="utf-8")
    assert "ta.sma(_pyne_close, 12)" in pine_text
    assert "ta.stoch(_pyne_close, _pyne_high, _pyne_low, 5)" in pine_text
    assert "_pyne_mfi(_pyne_close, _pyne_volume, 5)" in pine_text
    assert "_pyne_vwma(_pyne_close, _pyne_volume, 5)" in pine_text
