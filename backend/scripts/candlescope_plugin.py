"""Repository entry point for the CandleScope runtime plugin manager."""

from __future__ import annotations

import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.plugin_runtime.installer_cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
