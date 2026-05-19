from __future__ import annotations

from pathlib import Path

import pyne_runtime as pn


EXAMPLES_DIR = Path(__file__).resolve().parents[1] / "examples"


def test_all_packaged_examples_run() -> None:
    data = pn.read_ohlcv(EXAMPLES_DIR / "sample_ohlcv.csv")

    for script in sorted(EXAMPLES_DIR.glob("*.py")):
        result = pn.run(script, data)

        assert result.ok, f"{script.name} failed: {result.error}"
        assert result.meta.get("title")
        assert result.lines or result.output
