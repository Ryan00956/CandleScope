from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_SDK_SOURCE = (
    BACKEND_ROOT.parent / "packages" / "candlescope-plugin-sdk" / "src"
)


def source_checkout_environment(
    overrides: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return an isolated child environment for running from repository sources."""

    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        value
        for value in (
            str(BACKEND_ROOT),
            str(PLUGIN_SDK_SOURCE),
            environment.get("PYTHONPATH", ""),
        )
        if value
    )
    if overrides:
        environment.update(overrides)
    return environment
