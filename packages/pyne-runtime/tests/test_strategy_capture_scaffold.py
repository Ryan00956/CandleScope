from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_strategy_capture_scaffold_adds_missing_placeholder(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        """{
  "cases": [
    {
      "name": "sample",
      "values": {
        "Position": [0.0]
      },
      "bars": [
      ]
    }
  ]
}
""",
        encoding="utf-8",
    )

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_scaffold.py"),
            str(fixture),
        ],
        check=True,
        cwd=ROOT,
    )

    updated = json.loads(fixture.read_text(encoding="utf-8"))
    assert updated["cases"][0]["external_capture"] == {
        "provider": "tradingview",
        "status": "not_captured",
        "notes": [
            "Populate values from TradingView's exported plot data when an external capture is available."
        ],
    }


def test_strategy_capture_scaffold_preserves_existing_capture(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        """{
  "cases": [
    {
      "name": "sample",
      "external_capture": {
        "provider": "tradingview",
        "status": "captured",
        "values": {
          "Position": [0.0]
        }
      },
      "bars": [
      ]
    }
  ]
}
""",
        encoding="utf-8",
    )
    before = fixture.read_text(encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_scaffold.py"),
            str(fixture),
            "--check",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert "would add 0 placeholder(s)" in completed.stdout
    assert fixture.read_text(encoding="utf-8") == before


def test_strategy_capture_scaffold_check_fails_when_missing(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        """{
  "cases": [
    {
      "name": "sample",
      "bars": [
      ]
    }
  ]
}
""",
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_scaffold.py"),
            str(fixture),
            "--check",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    assert "missing TradingView capture placeholder" in completed.stdout


def test_strategy_capture_scaffold_check_real_golden_fixtures() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_scaffold.py"),
            "--check",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert "would add 0 placeholder(s)" in completed.stdout
