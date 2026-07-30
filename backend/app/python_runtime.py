"""Authoritative Python runtime requirement for the CandleScope backend."""
from __future__ import annotations

import sys
from collections.abc import Sequence


MIN_PYTHON: tuple[int, int] = (3, 11)


def require_supported_python(
    version_info: Sequence[int] | None = None,
) -> tuple[int, int]:
    """Fail before application imports continue on an unsupported interpreter."""

    source = sys.version_info if version_info is None else version_info
    if len(source) < 2:
        raise ValueError("version_info must contain major and minor components")
    detected = (int(source[0]), int(source[1]))
    if detected < MIN_PYTHON:
        required = ".".join(str(part) for part in MIN_PYTHON)
        actual = ".".join(str(part) for part in detected)
        raise RuntimeError(
            f"CandleScope requires Python {required} or newer; "
            f"detected Python {actual}. Use a supported interpreter before "
            "installing backend dependencies."
        )
    return detected
