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
        "3,1,3,1,3,100\n",
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


def test_cli_run_reports_invalid_param_payload(tmp_path: Path, capsys) -> None:
    script = tmp_path / "script.py"
    script.write_text(
        """
length = input.int(2, "Length", minval=1, maxval=10)
plot(length, "Length")
""",
        encoding="utf-8",
    )
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        "1,1,2,1,1,100\n",
        encoding="utf-8",
    )

    exit_code = main([
        "run",
        str(script),
        "--ohlcv",
        str(csv_path),
        "--executor-mode",
        "inline",
        "--param",
        "Length=abc",
    ])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert exit_code == 1
    assert payload["ok"] is False
    assert payload["code"] == "PYNE_INVALID_PARAM"
    assert "Length" in payload["error"]


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


def test_cli_run_reports_input_read_errors_as_json(tmp_path: Path, capsys) -> None:
    script = tmp_path / "script.py"
    script.write_text('plot(close, "Close")\n', encoding="utf-8")
    missing_csv = tmp_path / "missing.csv"

    exit_code = main(["run", str(script), "--ohlcv", str(missing_csv)])

    assert exit_code == 2
    captured = capsys.readouterr()
    payload = json.loads(captured.err)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "PYNE_CLI_INPUT_ERROR"


def test_cli_run_process_mode_writes_success_payload(tmp_path: Path) -> None:
    script = tmp_path / "script.py"
    script.write_text('plot(close, "Close")\n', encoding="utf-8")
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        "1,1,2,1,1.5,100\n",
        encoding="utf-8",
    )
    out = tmp_path / "result.json"

    exit_code = main([
        "run",
        str(script),
        "--ohlcv",
        str(csv_path),
        "--executor-mode",
        "process",
        "--out",
        str(out),
    ])

    assert exit_code == 0
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "Close"


def test_cli_run_failure_payload_uses_nonzero_exit(tmp_path: Path, capsys) -> None:
    script = tmp_path / "script.py"
    script.write_text("plot(close,\n", encoding="utf-8")
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        "1,1,2,1,1.5,100\n",
        encoding="utf-8",
    )

    exit_code = main([
        "run",
        str(script),
        "--ohlcv",
        str(csv_path),
        "--executor-mode",
        "process",
    ])

    assert exit_code == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["ok"] is False
    assert payload["code"] == "PYNE_SYNTAX_ERROR"
