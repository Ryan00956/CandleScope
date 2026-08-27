from __future__ import annotations

from types import SimpleNamespace

from app.exchanges.support import serialize_exchange_support


def _capabilities(*, ccxt_version: str) -> SimpleNamespace:
    return SimpleNamespace(
        protocol_features=("provider.ccxt_unified",),
        markets=(object(),),
        channels=(object(),),
        capability_schema_version=3,
        limits={"ccxt.version": ccxt_version},
    )


def test_retained_qualification_is_bound_to_the_pinned_ccxt_version() -> None:
    plugin = SimpleNamespace(id="bybit")

    qualified = serialize_exchange_support(
        plugin,
        _capabilities(ccxt_version="4.5.60"),
    )
    changed_version = serialize_exchange_support(
        plugin,
        _capabilities(ccxt_version="4.5.61"),
    )

    assert qualified["verification_level"] == "soak"
    assert qualified["qualification"]["evidence_id"].startswith(
        "ccxt-unified-bybit-linear-4h"
    )
    assert changed_version == {
        "provider": "ccxt_unified",
        "routable": True,
        "verification_level": "capability_contract",
        "qualification": None,
        "qualifications": [],
        "products": {"markets": {}},
    }


def test_empty_catalog_entry_is_not_routable() -> None:
    payload = serialize_exchange_support(
        SimpleNamespace(id="aster"),
        SimpleNamespace(
            protocol_features=("provider.ccxt_unified",),
            markets=(),
            channels=(),
            capability_schema_version=3,
            limits={"ccxt.version": "4.5.60"},
        ),
    )

    assert payload == {
        "provider": "ccxt_unified",
        "routable": False,
        "verification_level": "catalog_only",
        "qualification": None,
        "qualifications": [],
        "products": {"markets": {}},
    }
