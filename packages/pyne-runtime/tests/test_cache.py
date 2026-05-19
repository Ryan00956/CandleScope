from __future__ import annotations

import pyne_runtime as pn


def test_cache_reuses_loader_value() -> None:
    pn.pyne_cache.clear()
    calls = {"count": 0}

    def loader() -> dict[str, int]:
        calls["count"] += 1
        return {"value": calls["count"]}

    first = pn.pyne_cache.get_or_load("x", loader)
    second = pn.pyne_cache.get_or_load("x", loader)

    assert first is second
    assert calls["count"] == 1
    pn.pyne_cache.clear()


def test_cache_respects_configured_limit() -> None:
    pn.pyne_cache.clear()
    pn.pyne_cache.configure(max_items=1)
    pn.pyne_cache.get_or_load("a", lambda: 1)
    pn.pyne_cache.get_or_load("b", lambda: 2)

    assert pn.pyne_cache.stats()["size"] == 1
    assert pn.pyne_cache.stats()["maxItems"] == 1
    pn.pyne_cache.configure(max_items=32)
    pn.pyne_cache.clear()

