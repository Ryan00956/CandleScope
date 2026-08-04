"""Phase 12 signed Plugin Marketplace public surface."""

from .crypto import ED25519_ALGORITHM, encode_base64url, key_id
from .errors import MarketplaceError
from .models import (
    INDEX_SCHEMA_VERSION,
    INDEX_SCHEMA_VERSION_V2,
    ROOTS_SCHEMA_VERSION,
    MarketplaceRoot,
    PublisherRecord,
    ReleaseRecord,
    VerifiedMarketplaceIndex,
    load_marketplace_roots_bytes,
    verify_marketplace_index,
)
from .supply_chain import (
    MultiRuntimeReleaseRecord,
    SignedArtifactRecord,
)
from .service import (
    BundleTrust,
    MarketplaceFetcher,
    PinnedMarketplaceFetcher,
    PluginMarketplaceService,
)

__all__ = [
    "BundleTrust",
    "ED25519_ALGORITHM",
    "INDEX_SCHEMA_VERSION",
    "INDEX_SCHEMA_VERSION_V2",
    "MarketplaceError",
    "MarketplaceFetcher",
    "MarketplaceRoot",
    "MultiRuntimeReleaseRecord",
    "PinnedMarketplaceFetcher",
    "PluginMarketplaceService",
    "PublisherRecord",
    "ROOTS_SCHEMA_VERSION",
    "ReleaseRecord",
    "SignedArtifactRecord",
    "VerifiedMarketplaceIndex",
    "encode_base64url",
    "key_id",
    "load_marketplace_roots_bytes",
    "verify_marketplace_index",
]
