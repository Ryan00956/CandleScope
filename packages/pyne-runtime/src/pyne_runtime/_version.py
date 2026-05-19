"""Package version helpers."""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version


def package_version() -> str:
    """Return the installed pyne-runtime package version."""
    try:
        return version("pyne-runtime")
    except PackageNotFoundError:
        return "0.0.0+unknown"


__version__ = package_version()
