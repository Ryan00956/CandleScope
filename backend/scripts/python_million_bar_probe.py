"""Collect the official 1,000,000 BAR Python Host evidence."""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.backtest.python_scale_run import run_python_bar_scale
from app.backtest.strategy.python_scale import OFFICIAL_BAR_CAPACITY


def main() -> int:
    work = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("output") / "n8-million"
    work.mkdir(parents=True, exist_ok=True)
    result = run_python_bar_scale(work, OFFICIAL_BAR_CAPACITY)
    print(json.dumps(result, indent=2, default=str))
    return 0 if result["state"] == "COMPLETED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
