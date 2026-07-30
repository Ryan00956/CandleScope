"""Run the repository Plugin Platform v2 Hello example without installing it."""

from __future__ import annotations

import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
sys.path.insert(0, str(SDK_SOURCE))

from candlescope_plugin_sdk.platform_v2.examples.hello_command import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
