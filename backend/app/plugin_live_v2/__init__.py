"""Fail-closed foundations for the Phase 11B isolated Live authority."""

from .accounts import OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
from .client import (
    AccountDescription,
    AccountHandle,
    CredentialDescription,
    CredentialHandle,
    LiveBrokerController,
)
from .errors import LiveBrokerError
from .protocol import (
    LIVE_BROKER_METHODS,
    LIVE_BROKER_PROTOCOL_VERSION,
)
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
    "LIVE_RELEASE_LOCK_SCHEMA_VERSION",
    "LiveBrokerController",
    "LiveBrokerError",
    "PUBLISHER_EVIDENCE_SCHEMA_VERSION",
    "OKX_DEMO_SPOT_READONLY_CONNECTOR_ID",
    "FirstPartyLiveRelease",
    "FirstPartyLiveReleaseLock",
    "LivePublisherTrustStore",
    "LiveTrustError",
    "PublisherEvidence",
    "WindowsDpapiCredentialVault",
    "load_first_party_live_release_lock",
]
