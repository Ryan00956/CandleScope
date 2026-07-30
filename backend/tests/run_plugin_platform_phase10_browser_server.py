"""Launch the Phase 10 browser fixture with repository-local sources."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import uvicorn


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--bundle-directory", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--origin", default="http://127.0.0.1:18130")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18130)
    args = parser.parse_args()

    database = args.database.resolve()
    if database.exists():
        raise RuntimeError("--database must identify a non-existent cold database")
    data_directory = database.parent
    replay_database = data_directory / "replay.db"
    repository = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repository / "backend"))
    sys.path.insert(
        0,
        str(repository / "packages" / "candlescope-plugin-sdk" / "src"),
    )
    os.environ.update(
        {
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "CANDLE_DATA_DIR": str(data_directory),
            "KLINES_DB_PATH": str(database),
            "TRADE_FLOW_DB_PATH": str(database),
            "LIQUIDATION_DB_PATH": str(database),
            "REPLAY_DB_PATH": str(replay_database),
            "REPLAY_ENABLED": "0",
            "RAW_AGG_TRADE_ARCHIVE_ENABLED": "0",
            "CANDLESCOPE_AUTO_GC_ENABLED": "0",
            "BACKFILL_FETCH_RATE_LIMIT_DELAY": "0",
            "BACKFILL_FETCH_MAX_RETRIES": "0",
            "PHASE10_BROWSER_PLATFORM_ROOT": str(args.root.resolve()),
            "PHASE10_BROWSER_BUNDLE_DIRECTORY": str(args.bundle_directory.resolve()),
            "PHASE10_BROWSER_ORIGIN": args.origin,
            "PHASE10_BROWSER_MANAGEMENT_API_ORIGIN": (f"http://localhost:{args.port}"),
        }
    )
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")
    uvicorn.run(
        "tests.plugin_platform_phase10_browser_server:app",
        host=args.host,
        port=args.port,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
