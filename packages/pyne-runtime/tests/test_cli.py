from __future__ import annotations

import json
from pathlib import Path

from pyne_runtime.cli import main


def test_cli_run_writes_result(tmp_path: Path) -> None:
    script = tmp_path / "script.py"
    script.write_text('plot(close, "Close")\n', encoding="utf-8")
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        "1,1,2,1,1.5,100\n"
        "2,1.5,2.5,1.4,2,120\n",
        encoding="utf-8",
    )
    out = tmp_path / "result.json"

    exit_code = main(["run", str(script), "--ohlcv", str(csv_path), "--out", str(out)])

    assert exit_code == 0
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["ok"] is True
    assert len(payload["lines"]) == 1


def test_cli_run_accepts_param_overrides(tmp_path: Path) -> None:
    script = tmp_path / "script.py"
    script.write_text(
        """
length = input.int(2, "Length")
mult = input.float(1.0, "Multiplier")
enabled = input.bool(True, "Enabled")
if enabled:
    plot(ta.sma(close, length) * mult, "Adjusted")
""",
        encoding="utf-8",
    )
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        "1,1,2,1,1,100\n"
        "2,1,2,1,2,100\n"
        "3,1,2,1,3,100\n",
        encoding="utf-8",
    )
    out = tmp_path / "result.json"

    exit_code = main([
        "run",
        str(script),
        "--ohlcv",
        str(csv_path),
        "--out",
        str(out),
        "--param",
        "Length=3",
        "--param",
        "Multiplier=2.5",
        "--param",
        "Enabled=true",
    ])

    assert exit_code == 0
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["ok"] is True
    assert payload["lines"][0]["data"][-1]["value"] == 5.0


def test_cli_run_accepts_params_json_file(tmp_path: Path) -> None:
    script = tmp_path / "script.py"
    script.write_text(
        """
name = input.string("Default", "Name")
plot(close, name)
""",
        encoding="utf-8",
    )
    params_path = tmp_path / "params.json"
    params_path.write_text('{"Name": "Custom"}', encoding="utf-8")
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        "1,1,2,1,1,100\n",
        encoding="utf-8",
    )
    out = tmp_path / "result.json"

    exit_code = main([
        "run",
        str(script),
        "--ohlcv",
        str(csv_path),
        "--out",
        str(out),
        "--params-json",
        str(params_path),
    ])

    assert exit_code == 0
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["lines"][0]["name"] == "Custom"
