"""Launch the Phase 9 browser fixture with repository-local SDK sources."""

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
    parser.add_argument("--origin", default="http://127.0.0.1:18129")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18129)
    args = parser.parse_args()

    repository = Path(__file__).resolve().parents[2]
    backend_source = repository / "backend"
    sdk_source = repository / "packages" / "candlescope-plugin-sdk" / "src"
    sys.path.insert(0, str(backend_source))
    sys.path.insert(0, str(sdk_source))
    os.environ["PYTHONIOENCODING"] = "utf-8"
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PHASE9_BROWSER_PLATFORM_ROOT"] = str(args.root.resolve())
    os.environ["PHASE9_BROWSER_BUNDLE_DIRECTORY"] = str(args.bundle_directory.resolve())
    os.environ["PHASE9_BROWSER_ORIGIN"] = args.origin
    uvicorn.run(
        "tests.plugin_platform_phase9_browser_server:app",
        host=args.host,
        port=args.port,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
