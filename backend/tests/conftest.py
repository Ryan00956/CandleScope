from __future__ import annotations

import pytest


@pytest.fixture
def anyio_backend() -> str:
    """Run anyio-marked tests on the asyncio backend used by the app."""
    return "asyncio"
