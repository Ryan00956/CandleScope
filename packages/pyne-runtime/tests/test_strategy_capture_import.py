from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_strategy_capture_import_json_values(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "name": "sample",
                        "values": {
                            "Position": [0.0, 1.0],
                            "Net Profit": [0.0, 2.0],
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    values = tmp_path / "values.json"
    values.write_text(
        json.dumps({"values": {"Position": [0, 1], "Net Profit": ["0", "2.5"]}}),
        encoding="utf-8",
    )

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_import.py"),
            str(fixture),
            "--case",
            "sample",
            "--values",
            str(values),
            "--tolerance",
            "1e-9",
            "--note",
            "exported from TradingView",
        ],
        check=True,
        cwd=ROOT,
    )

    updated = json.loads(fixture.read_text(encoding="utf-8"))
    capture = updated["cases"][0]["external_capture"]
    assert capture == {
        "provider": "tradingview",
        "status": "captured",
        "assertion": "reference",
        "tolerance": 1e-09,
        "values": {
            "Position": [0.0, 1.0],
            "Net Profit": [0.0, 2.5],
        },
        "notes": ["exported from TradingView"],
    }


def test_strategy_capture_import_csv_ignores_chart_columns_and_empty_rows(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "name": "sample",
                        "values": {
                            "Position": [0.0, 1.0],
                            "Net Profit": [0.0, 2.0],
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    values = tmp_path / "values.csv"
    values.write_text(
        (
            "time,open,high,low,close,Position,Net Profit,Volume\n"
            "1,10,11,9,10,,,100\n"
            "2,10,11,9,10,0,0,100\n"
            "3,11,12,10,11,1,2,200\n"
            "4,12,13,11,12,,,300\n"
        ),
        encoding="utf-8",
    )

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_import.py"),
            str(fixture),
            "--case",
            "sample",
            "--values",
            str(values),
        ],
        check=True,
        cwd=ROOT,
    )

    updated = json.loads(fixture.read_text(encoding="utf-8"))
    assert updated["cases"][0]["external_capture"]["values"] == {
        "Position": [0.0, 1.0],
        "Net Profit": [0.0, 2.0],
    }
    assert updated["cases"][0]["external_capture"]["bars"] == [
        {"time": 2, "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.0, "volume": 100.0},
        {"time": 3, "open": 11.0, "high": 12.0, "low": 10.0, "close": 11.0, "volume": 200.0},
    ]


def test_strategy_capture_import_rejects_unknown_plot(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps({"cases": [{"name": "sample", "values": {"Position": [0.0]}}]}),
        encoding="utf-8",
    )
    values = tmp_path / "values.json"
    values.write_text(json.dumps({"Unknown": [1]}), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_import.py"),
            str(fixture),
            "--case",
            "sample",
            "--values",
            str(values),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "not present in fixture values" in completed.stderr


def test_strategy_capture_import_rejects_missing_plot_by_default(
    tmp_path: Path,
) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "name": "sample",
                        "bars": [{}, {}],
                        "values": {
                            "Position": [0.0, 1.0],
                            "Net Profit": [0.0, 2.0],
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    values = tmp_path / "values.json"
    values.write_text(json.dumps({"Position": [0, 1]}), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_import.py"),
            str(fixture),
            "--case",
            "sample",
            "--values",
            str(values),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "export missing fixture plot title(s): Net Profit" in completed.stderr


def test_strategy_capture_import_allows_partial_plots_when_requested(
    tmp_path: Path,
) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "name": "sample",
                        "bars": [{}, {}],
                        "values": {
                            "Position": [0.0, 1.0],
                            "Net Profit": [0.0, 2.0],
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    values = tmp_path / "values.json"
    values.write_text(json.dumps({"Position": [0, 1]}), encoding="utf-8")

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_import.py"),
            str(fixture),
            "--case",
            "sample",
            "--values",
            str(values),
            "--allow-partial-plots",
        ],
        check=True,
        cwd=ROOT,
    )

    updated = json.loads(fixture.read_text(encoding="utf-8"))
    assert updated["cases"][0]["external_capture"]["values"] == {
        "Position": [0.0, 1.0],
    }


def test_strategy_capture_import_rejects_length_mismatch(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "name": "sample",
                        "bars": [{}, {}],
                        "values": {
                            "Position": [0.0, 1.0],
                            "Net Profit": [0.0, 2.0],
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    values = tmp_path / "values.json"
    values.write_text(
        json.dumps({"Position": [0], "Net Profit": [0, 2]}),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_import.py"),
            str(fixture),
            "--case",
            "sample",
            "--values",
            str(values),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "export length must match fixture bar count 2; got Position=1" in (
        completed.stderr
    )
