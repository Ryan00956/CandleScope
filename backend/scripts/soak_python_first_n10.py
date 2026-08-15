"""Host-owned Python lifecycle soak. Default is a short smoke; 1h needs --duration-ms."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages" / "candlescope-backtest-sdk" / "src"))
sys.path.insert(0, str(ROOT / "backend"))

from app.backtest.python_first_lifecycle import (  # noqa: E402
    run_python_host_lifecycle,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=1)
    parser.add_argument("--duration-ms", type=int, default=0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    deadline = (
        None if args.duration_ms <= 0 else time.monotonic() + args.duration_ms / 1000
    )
    cycles = 0
    last: dict = {}
    started = time.monotonic()
    while True:
        with tempfile.TemporaryDirectory(prefix="n10-soak-") as raw:
            last = run_python_host_lifecycle(Path(raw), cycles=1)
        cycles += 1
        if deadline is None:
            if cycles >= args.cycles:
                break
        elif (
            time.monotonic() >= deadline
            or cycles >= max(args.cycles, 1)
            and args.duration_ms == 0
        ):
            break
        if deadline is not None and time.monotonic() >= deadline:
            break
    payload = {
        "schemaVersion": "candlescope.python-first-soak/1",
        "requestedCycles": args.cycles,
        "requestedDurationMs": args.duration_ms,
        "completedCycles": cycles,
        "durationSeconds": time.monotonic() - started,
        "last": last,
        "ok": bool(last.get("ok")),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
