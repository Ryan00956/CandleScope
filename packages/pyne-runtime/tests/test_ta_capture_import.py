from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_ta_capture_import_csv_series(tmp_path: Path) -> None:
    fixture = _write_fixture(tmp_path)
    csv_path = tmp_path / "export.csv"
    csv_path.write_text(
        "time,open,high,low,close,Close,Pyne Capture Index,Volume\n"
        "1,10,11,9,10,10,0,100\n"
        "2,11,12,10,11,11,1,200\n",
        encoding="utf-8",
    )

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "ta_capture_import.py"),
            str(fixture),
            "--values",
            str(csv_path),
            "--tolerance",
            "1e-9",
            "--assertion",
            "parity",
            "--note",
            "unit test capture",
        ],
        check=True,
        cwd=ROOT,
    )

    updated = json.loads(fixture.read_text(encoding="utf-8"))
    capture = updated["external_capture"]
    assert capture["provider"] == "tradingview"
    assert capture["status"] == "captured"
    assert capture["assertion"] == "parity"
    assert capture["series"] == {
        "Close": [
            {"time": 1, "value": 10.0},
            {"time": 2, "value": 11.0},
        ]
    }
    assert capture["bars"] == [
        {"time": 1, "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.0, "volume": 100.0},
        {"time": 2, "open": 11.0, "high": 12.0, "low": 10.0, "close": 11.0, "volume": 200.0},
    ]


def test_ta_capture_import_requires_capture_index(tmp_path: Path) -> None:
    fixture = _write_fixture(tmp_path)
    csv_path = tmp_path / "export.csv"
    csv_path.write_text(
        "time,open,high,low,close,Close,Volume\n"
        "1,10,11,9,10,10,100\n"
        "2,11,12,10,11,11,200\n",
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "ta_capture_import.py"),
            str(fixture),
            "--values",
            str(csv_path),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    assert "missing capture index" in completed.stderr


def _write_fixture(tmp_path: Path) -> Path:
    fixture = tmp_path / "ta_sample_indicators.json"
    fixture.write_text(
        json.dumps(
            {
                "name": "ta_sample_indicators",
                "chart_bars": [
                    {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                    {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                ],
                "script": 'plot(close, "Close")\n',
                "expected_series": {
                    "Close": [
                        {"time": 1, "value": 10},
                        {"time": 2, "value": 11},
                    ]
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return fixture
