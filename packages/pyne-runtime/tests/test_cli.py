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
