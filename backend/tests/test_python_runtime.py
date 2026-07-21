from __future__ import annotations

import pytest

from app.python_runtime import MIN_PYTHON, require_supported_python


def test_python_runtime_accepts_minimum_and_newer_versions() -> None:
    assert MIN_PYTHON == (3, 11)
    assert require_supported_python((3, 11, 0)) == (3, 11)
    assert require_supported_python((3, 12, 7)) == (3, 12)


def test_python_runtime_rejects_python_310_with_actionable_error() -> None:
    with pytest.raises(
        RuntimeError,
        match=(
            r"CandleScope requires Python 3\.11 or newer; "
            r"detected Python 3\.10"
        ),
    ):
        require_supported_python((3, 10, 16))


def test_python_runtime_rejects_incomplete_version_info() -> None:
    with pytest.raises(ValueError, match="major and minor"):
        require_supported_python((3,))
