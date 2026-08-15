from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS = _BACKEND_ROOT / "scripts"
_BACKTEST_SDK = (
    _BACKEND_ROOT.parent / "packages" / "candlescope-backtest-sdk" / "src"
)
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from plugin_sdk_isolation import pin_in_repo_plugin_sdk

pin_in_repo_plugin_sdk(_BACKEND_ROOT, _BACKTEST_SDK)


@pytest.fixture
def anyio_backend() -> str:
    """Run anyio-marked tests on the asyncio backend used by the app."""
    return "asyncio"
