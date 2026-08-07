"""CandleScope-owned extensions around the upstream CCXT runtime.

The package is intentionally not wired into the production exchange registry
yet.  It provides a narrow compatibility boundary for shadow/parity testing
without allowing CCXT's unified structures to bypass CandleScope data-quality
contracts.
"""

from .binance_usdm import (
    SUPPORTED_CCXT_VERSION,
    CandleScopeBinanceUSDM,
    CcxtCompatibilityError,
)
from .hooks import CcxtRawHooksMixin, build_hooked_exchange_class
from .models import CcxtLifecycleEvent, CcxtRawMarketEvent
from .runtime import CcxtRuntime, CcxtRuntimePool, get_shared_ccxt_runtime_pool
from .session import CcxtProviderSession, CcxtRawQueueOverflow
from .shadow import (
    SHADOW_SCHEMA_VERSION,
    BinanceCcxtShadowComparator,
    BinanceCcxtShadowRunner,
)

__all__ = [
    "SHADOW_SCHEMA_VERSION",
    "SUPPORTED_CCXT_VERSION",
    "BinanceCcxtShadowComparator",
    "BinanceCcxtShadowRunner",
    "CandleScopeBinanceUSDM",
    "CcxtCompatibilityError",
    "CcxtLifecycleEvent",
    "CcxtProviderSession",
    "CcxtRawHooksMixin",
    "CcxtRawMarketEvent",
    "CcxtRawQueueOverflow",
    "CcxtRuntime",
    "CcxtRuntimePool",
    "build_hooked_exchange_class",
    "get_shared_ccxt_runtime_pool",
]
