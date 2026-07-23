"""Fail-closed foundations for the Phase 11B isolated Live authority."""

from .accounts import (
    OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
    OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
)
from .audit_export import (
    LIVE_AUDIT_EXPORT_SCHEMA,
    LIVE_AUDIT_EXPORT_SCHEMA_V2,
    LiveAuditExportError,
    verify_live_audit_export,
)
from .client import (
    AccountDescription,
    AccountHandle,
    CredentialDescription,
    CredentialHandle,
    LiveBrokerController,
    ShadowOrderDescription,
    ShadowOrderHandle,
)
from .errors import LiveBrokerError
from .execution import (
    DEMO_EXECUTION_INSTRUMENT,
    LIVE_EXECUTION_FILENAME,
    LiveExecutionLedger,
)
from .protocol import (
    LIVE_BROKER_METHODS,
    LIVE_BROKER_PROTOCOL_VERSION,
)
from .shadow import ShadowOrderIntent
from .trust import (
    DEFAULT_LIVE_RELEASE_LOCK_PATH,
    FIRST_PARTY_PINNED_TRUST_LEVEL,
    LIVE_RELEASE_LOCK_SCHEMA_VERSION,
    PUBLISHER_EVIDENCE_SCHEMA_VERSION,
    FirstPartyLiveRelease,
    FirstPartyLiveReleaseLock,
    LivePublisherTrustStore,
    LiveTrustError,
    PublisherEvidence,
    load_first_party_live_release_lock,
)
from .vault import (
    CredentialVault,
    FakeCredentialVault,
    WindowsDpapiCredentialVault,
)

__all__ = [
    "AccountDescription",
    "AccountHandle",
    "CredentialDescription",
    "CredentialHandle",
    "CredentialVault",
    "DEFAULT_LIVE_RELEASE_LOCK_PATH",
    "FakeCredentialVault",
    "FIRST_PARTY_PINNED_TRUST_LEVEL",
    "LIVE_BROKER_METHODS",
    "LIVE_BROKER_PROTOCOL_VERSION",
    "LIVE_AUDIT_EXPORT_SCHEMA",
    "LIVE_AUDIT_EXPORT_SCHEMA_V2",
    "LIVE_EXECUTION_FILENAME",
    "LIVE_RELEASE_LOCK_SCHEMA_VERSION",
    "LiveBrokerController",
    "LiveBrokerError",
    "LiveAuditExportError",
    "PUBLISHER_EVIDENCE_SCHEMA_VERSION",
    "OKX_DEMO_SPOT_READONLY_CONNECTOR_ID",
    "OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID",
    "DEMO_EXECUTION_INSTRUMENT",
    "FirstPartyLiveRelease",
    "FirstPartyLiveReleaseLock",
    "LivePublisherTrustStore",
    "LiveExecutionLedger",
    "LiveTrustError",
    "PublisherEvidence",
    "ShadowOrderDescription",
    "ShadowOrderHandle",
    "ShadowOrderIntent",
    "WindowsDpapiCredentialVault",
    "load_first_party_live_release_lock",
    "verify_live_audit_export",
]
