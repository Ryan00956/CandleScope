"""Explicit v2 bundle and installation control plane.

This package is intentionally separate from :mod:`app.plugin_runtime`.  The
legacy runtime bundle parser and activation registry remain authoritative for
schema v1 artifacts.
"""

from .bundle import (
    ARTIFACT_ROLES,
    BUNDLE_FORMAT,
    BUNDLE_FORMAT_V2,
    BUNDLE_FORMAT_V3,
    BUNDLE_SCHEMA_VERSION,
    BUNDLE_SCHEMA_VERSION_V2,
    BUNDLE_SCHEMA_VERSION_V3,
    ArtifactRecord,
    VerifiedPlatformBundle,
    build_platform_bundle,
    inspect_platform_bundle,
    verify_platform_bundle,
)
from .errors import (
    MultiRuntimeFeatureDisabledError,
    PlatformBundleError,
    PlatformInstallerError,
    RuntimeProviderReceiptMismatchError,
    RuntimeProviderUnavailableError,
)
from .installer import PlatformPluginInstaller

__all__ = [
    "ARTIFACT_ROLES",
    "BUNDLE_FORMAT",
    "BUNDLE_FORMAT_V2",
    "BUNDLE_FORMAT_V3",
    "BUNDLE_SCHEMA_VERSION",
    "BUNDLE_SCHEMA_VERSION_V2",
    "BUNDLE_SCHEMA_VERSION_V3",
    "ArtifactRecord",
    "PlatformBundleError",
    "PlatformInstallerError",
    "MultiRuntimeFeatureDisabledError",
    "RuntimeProviderUnavailableError",
    "RuntimeProviderReceiptMismatchError",
    "PlatformPluginInstaller",
    "VerifiedPlatformBundle",
    "build_platform_bundle",
    "inspect_platform_bundle",
    "verify_platform_bundle",
]
