"""Explicit v2 bundle and installation control plane.

This package is intentionally separate from :mod:`app.plugin_runtime`.  The
legacy runtime bundle parser and activation registry remain authoritative for
schema v1 artifacts.
"""

from .bundle import (
    BUNDLE_FORMAT,
    BUNDLE_SCHEMA_VERSION,
    VerifiedPlatformBundle,
    build_platform_bundle,
    inspect_platform_bundle,
    verify_platform_bundle,
)
from .errors import PlatformBundleError, PlatformInstallerError
from .installer import PlatformPluginInstaller

__all__ = [
    "BUNDLE_FORMAT",
    "BUNDLE_SCHEMA_VERSION",
    "PlatformBundleError",
    "PlatformInstallerError",
    "PlatformPluginInstaller",
    "VerifiedPlatformBundle",
    "build_platform_bundle",
    "inspect_platform_bundle",
    "verify_platform_bundle",
]
