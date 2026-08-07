"""CandleScope-owned generic, strict-raw, and shadow CCXT integrations."""

from .binance_usdm import (
    SUPPORTED_CCXT_VERSION,
    CandleScopeBinanceUSDM,
    CcxtCompatibilityError,
)
from .binance_spot import CandleScopeBinanceSpot
from .hooks import CcxtRawHooksMixin, build_hooked_exchange_class
from .catalog import (
    CcxtCatalogEntry,
    ccxt_catalog_summary,
    get_ccxt_catalog,
)
from .generic import CcxtUnifiedPlugin, register_ccxt_plugins
from .models import CcxtLifecycleEvent, CcxtRawMarketEvent
from .okx import CandleScopeOkx, CandleScopeOkxSpot
from .runtime import CcxtRuntime, CcxtRuntimePool, get_shared_ccxt_runtime_pool
from .session import CcxtProviderSession, CcxtRawQueueOverflow
from .unified import (
    CcxtUnifiedNormalizer,
    CcxtUnifiedOrderBookOutOfSync,
    CcxtUnifiedProjector,
)
from .shadow import (
    SHADOW_SCHEMA_VERSION,
    SPOT_SHADOW_SCHEMA_VERSION,
    BinanceCcxtShadowComparator,
    BinanceCcxtShadowRunner,
)
from .shadow_matrix import (
    DEFAULT_MATRIX_SYMBOLS,
    MATRIX_SHADOW_SCHEMA_VERSION,
    CcxtShadowMatrixRunner,
    CcxtShadowMatrixSpec,
    CcxtShadowTarget,
    load_shadow_matrix_spec,
)
from .shadow_okx import (
    OKX_SHADOW_SCHEMA_VERSION,
    OKX_SPOT_SHADOW_SCHEMA_VERSION,
    OkxCcxtShadowComparator,
)

__all__ = [
    "SHADOW_SCHEMA_VERSION",
    "SPOT_SHADOW_SCHEMA_VERSION",
    "MATRIX_SHADOW_SCHEMA_VERSION",
    "OKX_SHADOW_SCHEMA_VERSION",
    "OKX_SPOT_SHADOW_SCHEMA_VERSION",
    "SUPPORTED_CCXT_VERSION",
    "BinanceCcxtShadowComparator",
    "BinanceCcxtShadowRunner",
    "CandleScopeBinanceSpot",
    "CcxtShadowMatrixRunner",
    "CcxtShadowMatrixSpec",
    "CcxtShadowTarget",
    "DEFAULT_MATRIX_SYMBOLS",
    "CandleScopeBinanceUSDM",
    "CandleScopeOkx",
    "CandleScopeOkxSpot",
    "CcxtCatalogEntry",
    "CcxtCompatibilityError",
    "CcxtLifecycleEvent",
    "CcxtProviderSession",
    "CcxtRawHooksMixin",
    "CcxtRawMarketEvent",
    "CcxtRawQueueOverflow",
    "CcxtRuntime",
    "CcxtRuntimePool",
    "CcxtUnifiedNormalizer",
    "CcxtUnifiedOrderBookOutOfSync",
    "CcxtUnifiedPlugin",
    "CcxtUnifiedProjector",
    "OkxCcxtShadowComparator",
    "build_hooked_exchange_class",
    "ccxt_catalog_summary",
    "get_ccxt_catalog",
    "get_shared_ccxt_runtime_pool",
    "load_shadow_matrix_spec",
    "register_ccxt_plugins",
]
