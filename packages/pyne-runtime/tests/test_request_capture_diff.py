from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_request_capture_diff_reports_zero_for_matching_capture(tmp_path: Path) -> None:
    fixture = _write_fixture(tmp_path, 100.0)

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_diff.py"),
            "--assertion",
            "parity",
            str(fixture),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)
    assert report["counts"]["captured_fixtures"] == 1
    assert report["counts"]["differences"] == 0


def test_request_capture_diff_fails_for_mismatch(tmp_path: Path) -> None:
    fixture = _write_fixture(tmp_path, 101.0)

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_diff.py"),
            "--assertion",
            "parity",
            str(fixture),
            "--json",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    report = json.loads(completed.stdout)
    assert report["counts"]["differences"] == 1


def test_request_capture_diff_uses_provider_metadata(tmp_path: Path) -> None:
    fixture = tmp_path / "request_security_metadata_capture.json"
    fixture.write_text(
        json.dumps(
            {
                "name": "request_security_metadata_capture",
                "chart_bars": [
                    {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                    {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                ],
                "provider_bars": [
                    {"time": 1, "open": 90, "high": 110, "low": 80, "close": 100, "volume": 1000}
                ],
                "provider_metadata": {
                    "BTCUSDT|240": {
                        "syminfo": {"tickerid": "BINANCE:BTCUSDT.P", "mintick": 0.1},
                        "timeframe": "240",
                    }
                },
                "script": (
                    'mintick = request.security("BTCUSDT", "240", '
                    'lambda ctx: ctx.syminfo.mintick)\n'
                    'plot(mintick, "Requested Mintick")\n'
                ),
                "expected_series": {
                    "Requested Mintick": [
                        {"time": 1, "value": 0.1},
                        {"time": 2, "value": 0.1},
                    ]
                },
                "external_capture": {
                    "provider": "tradingview",
                    "status": "captured",
                    "assertion": "parity",
                    "tolerance": 1e-9,
                    "series": {
                        "Requested Mintick": [
                            {"time": 1, "value": 0.1},
                            {"time": 2, "value": 0.1},
                        ]
                    },
                    "bars": [
                        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                        {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                    ],
                    "provider_bars": [
                        {
                            "time": 1,
                            "open": 90,
                            "high": 110,
                            "low": 80,
                            "close": 100,
                            "volume": 1000,
                        }
                    ],
                    "provider_metadata": {
                        "BTCUSDT|240": {
                            "syminfo": {"tickerid": "BINANCE:BTCUSDT.P", "mintick": 0.1},
                            "timeframe": "240",
                        }
                    },
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_diff.py"),
            "--assertion",
            "parity",
            str(fixture),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)
    assert report["counts"]["captured_fixtures"] == 1
    assert report["counts"]["differences"] == 0


def test_request_capture_diff_can_replay_ignored_invalid_symbol(tmp_path: Path) -> None:
    fixture = tmp_path / "request_security_invalid_symbol_ignore_capture.json"
    fixture.write_text(
        json.dumps(
            {
                "name": "request_security_invalid_symbol_ignore_capture",
                "chart_bars": [
                    {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                    {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                ],
                "provider_bars": [],
                "invalid_symbols": ["MISSING"],
                "script": (
                    'missing = request.security("MISSING", "240", close, '
                    "ignore_invalid_symbol=True)\n"
                    'plot(nz(missing, -999), "Invalid NZ Fallback")\n'
                ),
                "expected_series": {
                    "Invalid NZ Fallback": [
                        {"time": 1, "value": -999},
                        {"time": 2, "value": -999},
                    ]
                },
                "external_capture": {
                    "provider": "tradingview",
                    "status": "captured",
                    "assertion": "parity",
                    "tolerance": 1e-9,
                    "series": {
                        "Invalid NZ Fallback": [
                            {"time": 1, "value": -999},
                            {"time": 2, "value": -999},
                        ]
                    },
                    "bars": [
                        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                        {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                    ],
                    "provider_bars": [],
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_diff.py"),
            "--assertion",
            "parity",
            str(fixture),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)
    assert report["counts"]["captured_fixtures"] == 1
    assert report["counts"]["differences"] == 0


def _write_fixture(tmp_path: Path, captured_value: float) -> Path:
    fixture = tmp_path / "request_security_sample_capture.json"
    fixture.write_text(
        json.dumps(
            {
                "name": "request_security_sample_capture",
                "chart_bars": [
                    {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                    {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                ],
                "provider_bars": [
                    {"time": 1, "open": 90, "high": 110, "low": 80, "close": 100, "volume": 1000}
                ],
                "script": 'higher = request.security("BTCUSDT", "240", "close")\nplot(higher, "HTF Close")\n',
                "expected_series": {
                    "HTF Close": [
                        {"time": 1, "value": 100},
                        {"time": 2, "value": 100},
                    ]
                },
                "external_capture": {
                    "provider": "tradingview",
                    "status": "captured",
                    "assertion": "parity",
                    "tolerance": 1e-9,
                    "series": {
                        "HTF Close": [
                            {"time": 1, "value": captured_value},
                            {"time": 2, "value": 100.0},
                        ]
                    },
                    "bars": [
                        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
                        {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 200},
                    ],
                    "provider_bars": [
                        {"time": 1, "open": 90, "high": 110, "low": 80, "close": 100, "volume": 1000}
                    ],
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return fixture
