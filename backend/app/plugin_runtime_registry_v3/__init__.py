"""Host-managed Runtime Registry public contracts."""

from pathlib import Path

from .errors import RuntimeRegistryError, registry_error
from .models import (
    ARCHIVE_FORMATS,
    EVIDENCE_ROLES,
    REGISTRY_SCHEMA_ID,
    REGISTRY_SCHEMA_VERSION,
    ROOTS_SCHEMA_VERSION,
    RUNTIME_KINDS,
    RuntimeEvidence,
    RuntimeLicenseFile,
    RuntimeProbe,
    RuntimeRegistryRoot,
    RuntimeRelease,
    RuntimeRevocation,
    VerifiedRuntimeRegistry,
    canonical_bytes,
    encode_base64url,
    key_id,
    load_runtime_registry_roots_bytes,
    runtime_release_to_wire,
    sha256_bytes,
    verify_runtime_registry_bytes,
)
from .service import (
    DOWNLOAD_TIMEOUT_SECONDS,
    RUNTIME_CACHE_RECEIPT_SCHEMA,
    RUNTIME_REGISTRY_ENABLED_ENV,
    RUNTIME_REGISTRY_NETWORK_UPDATES_ENV,
    RUNTIME_REGISTRY_STATUS_SCHEMA,
    EnsuredRuntime,
    HttpsRuntimeArtifactFetcher,
    ManagedRuntimeRegistryService,
    ProbeResult,
    RuntimeArtifactFetcher,
    host_platform,
)


PACKAGE_ROOT = Path(__file__).resolve().parent
OFFICIAL_ROOTS_PATH = PACKAGE_ROOT / "official-runtime-registry-roots.json"
OFFICIAL_ROOTS_V1_PATH = PACKAGE_ROOT / "official-runtime-registry-roots-v1.json"
OFFICIAL_REGISTRY_V1_PATH = PACKAGE_ROOT / "official-runtime-registry-v1.json"
OFFICIAL_REGISTRY_V2_PATH = PACKAGE_ROOT / "official-runtime-registry-v2.json"
OFFICIAL_REGISTRY_PATH = OFFICIAL_REGISTRY_V2_PATH


def build_official_runtime_registry(
    *,
    root: Path | str,
    enabled: bool | None = None,
    network_updates_enabled: bool | None = None,
    fetcher: RuntimeArtifactFetcher | None = None,
) -> ManagedRuntimeRegistryService:
    try:
        roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
        revision_1 = OFFICIAL_REGISTRY_V1_PATH.read_bytes()
        revision_2 = OFFICIAL_REGISTRY_V2_PATH.read_bytes()
    except OSError as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_CONFIGURATION_INVALID",
            "build-pinned Runtime Registry assets could not be read",
            details={"errorType": type(exc).__name__},
        ) from exc
    return ManagedRuntimeRegistryService(
        root=root,
        roots=roots,
        bootstrap_registry=revision_2,
        bootstrap_history=(revision_1,),
        enabled=enabled,
        network_updates_enabled=network_updates_enabled,
        fetcher=fetcher,
    )


__all__ = [
    "ARCHIVE_FORMATS",
    "DOWNLOAD_TIMEOUT_SECONDS",
    "EVIDENCE_ROLES",
    "EnsuredRuntime",
    "HttpsRuntimeArtifactFetcher",
    "ManagedRuntimeRegistryService",
    "OFFICIAL_REGISTRY_PATH",
    "OFFICIAL_REGISTRY_V1_PATH",
    "OFFICIAL_REGISTRY_V2_PATH",
    "OFFICIAL_ROOTS_PATH",
    "OFFICIAL_ROOTS_V1_PATH",
    "ProbeResult",
    "REGISTRY_SCHEMA_ID",
    "REGISTRY_SCHEMA_VERSION",
    "ROOTS_SCHEMA_VERSION",
    "RUNTIME_CACHE_RECEIPT_SCHEMA",
    "RUNTIME_KINDS",
    "RUNTIME_REGISTRY_ENABLED_ENV",
    "RUNTIME_REGISTRY_NETWORK_UPDATES_ENV",
    "RUNTIME_REGISTRY_STATUS_SCHEMA",
    "RuntimeArtifactFetcher",
    "RuntimeEvidence",
    "RuntimeLicenseFile",
    "RuntimeProbe",
    "RuntimeRegistryError",
    "RuntimeRegistryRoot",
    "RuntimeRelease",
    "RuntimeRevocation",
    "VerifiedRuntimeRegistry",
    "build_official_runtime_registry",
    "canonical_bytes",
    "encode_base64url",
    "host_platform",
    "key_id",
    "load_runtime_registry_roots_bytes",
    "registry_error",
    "runtime_release_to_wire",
    "sha256_bytes",
    "verify_runtime_registry_bytes",
]
