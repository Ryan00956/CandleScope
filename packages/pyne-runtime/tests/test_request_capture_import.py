from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_request_capture_import_rebuilds_provider_bars(tmp_path: Path) -> None:
    fixture = _write_fixture(tmp_path)
    csv_path = tmp_path / "export.csv"
    csv_path.write_text(
        "\n".join(
            [
                ",".join(
                    [
                        "time",
                        "open",
                        "high",
                        "low",
                        "close",
                        "HTF Close",
                        "HTF Time",
                        "Requested Time",
                        "Requested Session Market",
                        "Requested Session First",
                        "Requested Session Last",
                        "HTF Open",
                        "HTF High",
                        "HTF Low",
                        "HTF Provider Close",
                        "HTF Volume",
                        "Pyne Capture Index",
                        "Volume",
                    ]
                ),
                (
                    "1,10,11,9,10,100,1700000000000,1700000000000,1,1,0,"
                    "90,110,80,100,5000,0,100"
                ),
                "2,11,12,10,11,100,,1700000000000,,,,,,,5000,1,200",
                (
                    "3,12,13,11,12,200,1700003600000,1700003600000,0,0,1,"
                    "190,210,180,200,6000,2,300"
                ),
                "",
            ]
        ),
        encoding="utf-8",
    )

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_import.py"),
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
    assert capture["status"] == "captured"
    assert capture["assertion"] == "parity"
    assert capture["series"]["HTF Close"] == [
        {"time": 1, "value": 100.0},
        {"time": 2, "value": 100.0},
        {"time": 3, "value": 200.0},
    ]
    assert capture["series"]["Requested Time"] == [
        {"time": 1, "value": 1700000000},
        {"time": 2, "value": 1700000000},
        {"time": 3, "value": 1700003600},
    ]
    assert capture["provider_bars"] == [
        {
            "time": 1700000000,
            "open": 90.0,
            "high": 110.0,
            "low": 80.0,
            "close": 100.0,
            "volume": 5000.0,
            "session_ismarket": True,
            "session_isfirstbar": True,
            "session_islastbar": False,
        },
        {
            "time": 1700003600,
            "open": 190.0,
            "high": 210.0,
            "low": 180.0,
            "close": 200.0,
            "volume": 6000.0,
            "session_ismarket": False,
            "session_isfirstbar": False,
            "session_islastbar": True,
        },
    ]
    assert capture["provider_metadata"] == {
        "BTCUSDT|240": {
            "syminfo": {"tickerid": "BINANCE:BTCUSDT.P", "mintick": 0.1},
            "timeframe": "240",
            "session": {"ismarket": True},
        }
    }
    assert capture["provider_extra_bar_plots"] == {
        "session_ismarket": "Requested Session Market",
        "session_isfirstbar": "Requested Session First",
        "session_islastbar": "Requested Session Last",
    }
    assert capture["time_value_plots"] == ["Requested Time"]


def test_request_capture_import_rebuilds_lower_tf_slot_provider_bars(tmp_path: Path) -> None:
    fixture = _write_lower_tf_fixture(tmp_path)
    csv_path = tmp_path / "export.csv"
    csv_path.write_text(
        "\n".join(
            [
                ",".join(
                    [
                        "time",
                        "open",
                        "high",
                        "low",
                        "close",
                        "LTF Count",
                        "LTF Time 0",
                        "LTF Open 0",
                        "LTF High 0",
                        "LTF Low 0",
                        "LTF Provider Close 0",
                        "LTF Volume 0",
                        "LTF Time 1",
                        "LTF Open 1",
                        "LTF High 1",
                        "LTF Low 1",
                        "LTF Provider Close 1",
                        "LTF Volume 1",
                        "Pyne Capture Index",
                        "Volume",
                    ]
                ),
                (
        "10,10,11,9,10,2,1700000000000,90,110,80,100,5000,"
        "1700000300000,95,115,85,105,5500,0,100"
    ),
    "20,11,12,10,11,1,1700000600000,190,210,180,200,6000,,,,,,,1,200",
                "",
            ]
        ),
        encoding="utf-8",
    )

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_import.py"),
            str(fixture),
            "--values",
            str(csv_path),
            "--tolerance",
            "1e-9",
            "--assertion",
            "parity",
        ],
        check=True,
        cwd=ROOT,
    )

    updated = json.loads(fixture.read_text(encoding="utf-8"))
    capture = updated["external_capture"]
    assert capture["provider_bars"] == [
        {
            "time": 1700000000,
            "open": 90.0,
            "high": 110.0,
            "low": 80.0,
            "close": 100.0,
            "volume": 5000.0,
        },
        {
            "time": 1700000300,
            "open": 95.0,
            "high": 115.0,
            "low": 85.0,
            "close": 105.0,
            "volume": 5500.0,
        },
        {
            "time": 1700000600,
            "open": 190.0,
            "high": 210.0,
            "low": 180.0,
            "close": 200.0,
            "volume": 6000.0,
        },
    ]


def _write_fixture(tmp_path: Path) -> Path:
    fixture = tmp_path / "request_security_sample_capture.json"
    fixture.write_text(
        json.dumps(
            {
                "name": "request_security_sample_capture",
                "chart_bars": [
                    {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                    {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                    {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 300},
                ],
                "script": "",
                "expected_series": {
                    "HTF Close": [],
                    "HTF Time": [],
                    "Requested Time": [],
                    "Requested Session Market": [],
                    "Requested Session First": [],
                    "Requested Session Last": [],
                    "HTF Open": [],
                    "HTF High": [],
                    "HTF Low": [],
                    "HTF Provider Close": [],
                    "HTF Volume": [],
                },
                "external_capture": {
                    "provider": "tradingview",
                    "status": "not_captured",
                    "assertion": "reference",
                    "provider_bar_plots": {
                        "time": "HTF Time",
                        "open": "HTF Open",
                        "high": "HTF High",
                        "low": "HTF Low",
                        "close": "HTF Provider Close",
                        "volume": "HTF Volume",
                    },
                    "provider_extra_bar_plots": {
                        "session_ismarket": "Requested Session Market",
                        "session_isfirstbar": "Requested Session First",
                        "session_islastbar": "Requested Session Last",
                    },
                    "time_value_plots": ["Requested Time"],
                    "provider_metadata": {
                        "BTCUSDT|240": {
                            "syminfo": {"tickerid": "BINANCE:BTCUSDT.P", "mintick": 0.1},
                            "timeframe": "240",
                            "session": {"ismarket": True},
                        }
                    },
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return fixture


def _write_lower_tf_fixture(tmp_path: Path) -> Path:
    fixture = tmp_path / "request_security_lower_tf_sample_capture.json"
    fixture.write_text(
        json.dumps(
            {
                "name": "request_security_lower_tf_sample_capture",
                "chart_bars": [
                    {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                    {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                ],
                "script": "",
                "expected_series": {
                    "LTF Count": [],
                    "LTF Time 0": [],
                    "LTF Open 0": [],
                    "LTF High 0": [],
                    "LTF Low 0": [],
                    "LTF Provider Close 0": [],
                    "LTF Volume 0": [],
                    "LTF Time 1": [],
                    "LTF Open 1": [],
                    "LTF High 1": [],
                    "LTF Low 1": [],
                    "LTF Provider Close 1": [],
                    "LTF Volume 1": [],
                },
                "external_capture": {
                    "provider": "tradingview",
                    "status": "not_captured",
                    "assertion": "reference",
                    "provider_bar_plots": [
                        {
                            "time": "LTF Time 0",
                            "open": "LTF Open 0",
                            "high": "LTF High 0",
                            "low": "LTF Low 0",
                            "close": "LTF Provider Close 0",
                            "volume": "LTF Volume 0",
                        },
                        {
                            "time": "LTF Time 1",
                            "open": "LTF Open 1",
                            "high": "LTF High 1",
                            "low": "LTF Low 1",
                            "close": "LTF Provider Close 1",
                            "volume": "LTF Volume 1",
                        },
                    ],
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return fixture
