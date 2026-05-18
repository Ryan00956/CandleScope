from __future__ import annotations

import pyne_runtime as pn


def test_public_version_is_available() -> None:
    assert isinstance(pn.__version__, str)
    assert pn.__version__
