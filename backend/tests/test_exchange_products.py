from __future__ import annotations

from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.products import serialize_product_support
from app.exchanges.support import load_qualification_manifest


def _market(exchange: str, market_type: str) -> dict[str, object]:
    bootstrap_default_adapters()
    plugin = get_exchange_registry().get_plugin(exchange)
    products = serialize_product_support(plugin.capabilities())
    return products["markets"][market_type]


def test_binance_native_enhancements_remain_strict_products() -> None:
    futures = _market("binance", "futures")

    assert futures["order_book"] == {
        "supported": True,
        "channel": "depth",
        "mode": "snapshot",
        "snapshot_mode": "live_snapshot",
        "strict_full_depth": True,
    }
    assert futures["trade_flow"] == {
        "supported": True,
        "channel": "agg_trade",
        "mode": "strict_repairable",
        "sequence_continuity": True,
        "history": True,
        "delivery_mode": "live_stream",
    }


def test_unified_ccxt_products_do_not_overclaim_strict_semantics() -> None:
    for exchange, market_type in (("okx", "spot"), ("bybit", "swap.linear")):
        market = _market(exchange, market_type)
        assert market["order_book"] == {
            "supported": True,
            "channel": "depth",
            "mode": "snapshot",
            "snapshot_mode": "live_snapshot",
            "strict_full_depth": False,
        }
        assert market["trade_flow"] == {
            "supported": True,
            "channel": "trade",
            "mode": "observational",
            "sequence_continuity": False,
            "history": False,
            "delivery_mode": "live_stream",
        }


def test_rest_only_ccxt_depth_is_an_explicit_polling_snapshot_product() -> None:
    market = _market("bigone", "spot")

    assert market["order_book"] == {
        "supported": True,
        "channel": "depth",
        "mode": "snapshot",
        "snapshot_mode": "polling_snapshot",
        "strict_full_depth": False,
    }
    assert market["trade_flow"]["delivery_mode"] == "polling_observational"


def test_advanced_market_products_preserve_live_polling_and_history_only_modes() -> None:
    bybit = _market("bybit", "swap.linear")["advanced_market_data"]
    assert bybit["supported"] is True
    assert bybit["channels"]["funding_rate"] == {
        "supported": True,
        "realtime": True,
        "history": True,
        "delivery_mode": "polling_snapshot",
    }
    assert bybit["channels"]["liquidation"]["delivery_mode"] == (
        "live_observational"
    )

    bitfinex = _market("bitfinex", "swap.linear")["advanced_market_data"]
    assert bitfinex["channels"]["liquidation"]["delivery_mode"] == (
        "polling_observational"
    )

    apex = _market("apex", "swap.linear")["advanced_market_data"]
    assert apex["channels"]["funding_rate"] == {
        "supported": True,
        "realtime": False,
        "history": True,
        "delivery_mode": "history_only",
    }


def test_qualification_manifest_is_version_bound_and_evidence_scoped() -> None:
    manifest = load_qualification_manifest()

    assert manifest["ccxt_version"] == "4.5.60"
    assert len(manifest["records"]) == 5
    assert {record["level"] for record in manifest["records"]} == {
        "shadow",
        "soak",
    }
    assert len({record["evidence_id"] for record in manifest["records"]}) == 5
