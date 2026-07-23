"""Launch the Phase 11 browser fixture with repository-local sources."""

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
    parser.add_argument("--origin", default="http://127.0.0.1:18131")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18131)
    parser.add_argument(
        "--live-native-control",
        action="store_true",
        help="enable the WP-E Host-native control fixture",
    )
    args = parser.parse_args()

    repository = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repository / "backend"))
    sys.path.insert(0, str(repository / "packages" / "candlescope-plugin-sdk" / "src"))
    os.environ.update(
        {
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "PHASE11_BROWSER_PLATFORM_ROOT": str(args.root.resolve()),
            "PHASE11_BROWSER_BUNDLE_DIRECTORY": str(args.bundle_directory.resolve()),
            "PHASE11_BROWSER_ORIGIN": args.origin,
            "PHASE11_BROWSER_MANAGEMENT_API_ORIGIN": f"http://localhost:{args.port}",
            "PHASE11_BROWSER_LIVE_NATIVE_CONTROL": (
                "1" if args.live_native_control else "0"
            ),
        }
    )
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")
    uvicorn.run(
        "tests.plugin_platform_phase11_browser_server:app",
        host=args.host,
        port=args.port,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
