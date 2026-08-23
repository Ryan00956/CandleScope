"""Versioned quick presets for chart-first backtests.

The UI selects one stable preset id. Run creation still expands every field so
the immutable Run contract remains self-contained.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from app.simulation.execution_realism import EXECUTION_REALISM_V2


_QUICK_PRESETS: tuple[dict[str, Any], ...] = (
    {
        "id": "CRYPTO_PERP_STANDARD_V1",
        "revision": "1",
        "label": "标准永续合约",
        "market_types": ["usdm", "futures", "swap", "linear_perpetual"],
        "account_model": "LINEAR_PERP_ONE_WAY_V1",
        "sizing_policy": "EQUITY_PERCENT_V1",
        "equity_percent": "10",
        "initial_cash": "10000",
        "leverage": "1",
        "fee_source": "exchange-market-preset",
        "fee_bps": "4",
        "slippage_bps": "1",
        "execution_model_revision": EXECUTION_REALISM_V2,
        "contract_data_mode": "LEGACY_FIXED_V1",
        "funding_mode": "OFF",
    },
    {
        "id": "CRYPTO_SPOT_STANDARD_V1",
        "revision": "1",
        "label": "标准现货",
        "market_types": ["spot"],
        "account_model": "LINEAR_PERP_ONE_WAY_V1",
        "sizing_policy": "EQUITY_PERCENT_V1",
        "equity_percent": "10",
        "initial_cash": "10000",
        "leverage": "1",
        "fee_source": "exchange-market-preset",
        "fee_bps": "10",
        "slippage_bps": "1",
        "execution_model_revision": EXECUTION_REALISM_V2,
        "contract_data_mode": "LEGACY_FIXED_V1",
        "funding_mode": "OFF",
    },
)


def list_quick_presets() -> list[dict[str, Any]]:
    """Return defensive copies so callers cannot mutate the frozen catalog."""

    return deepcopy(list(_QUICK_PRESETS))


def quick_preset_for_market(market_type: str) -> dict[str, Any]:
    normalized = str(market_type or "").strip().lower()
    for preset in _QUICK_PRESETS:
        if normalized in preset["market_types"]:
            return deepcopy(preset)
    return deepcopy(_QUICK_PRESETS[0])
