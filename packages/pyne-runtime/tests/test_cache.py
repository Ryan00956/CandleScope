from __future__ import annotations

import pyne_runtime as pn
import pyne_runtime.cache as cache_module
from pyne_runtime.cache import PyneCache


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


def test_cache_ttl_starts_after_loader_completes(monkeypatch) -> None:
    now = {"value": 100.0}
    monkeypatch.setattr(cache_module.time, "time", lambda: now["value"])
    cache = PyneCache()
    calls = {"count": 0}

    def loader() -> dict[str, int]:
        calls["count"] += 1
        now["value"] += 5.0
        return {"value": calls["count"]}

    first = cache.get_or_load("slow", loader, ttl=10)

    now["value"] = 110.1
    assert cache.get_or_load("slow", lambda: {"value": 99}, ttl=10) is first
    assert calls["count"] == 1

    now["value"] = 115.1
    second = cache.get_or_load("slow", loader, ttl=10)

    assert second == {"value": 2}
    assert calls["count"] == 2


def test_cache_respects_configured_limit() -> None:
    pn.pyne_cache.clear()
    pn.pyne_cache.configure(max_items=1)
    pn.pyne_cache.get_or_load("a", lambda: 1)
    pn.pyne_cache.get_or_load("b", lambda: 2)

    assert pn.pyne_cache.stats()["size"] == 1
    assert pn.pyne_cache.stats()["maxItems"] == 1
    pn.pyne_cache.configure(max_items=32)
    pn.pyne_cache.clear()

