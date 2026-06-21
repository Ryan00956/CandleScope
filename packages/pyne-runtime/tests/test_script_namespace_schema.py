from __future__ import annotations

import pyne_runtime as pn
from pyne_runtime.context import PyneContext
from pyne_runtime.namespace import RuntimeServices, build_script_namespace
from pyne_runtime.security import PyneSecurityPolicy


def test_script_namespace_schema_matches_runtime_namespace() -> None:
    settings = pn.PyneSettings()
    ctx = PyneContext.from_ohlcv([
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
    ])
    services = RuntimeServices(
        ctx=ctx,
        settings=settings,
        params={},
        policy=PyneSecurityPolicy.from_settings(settings),
    )

    runtime_names = set(build_script_namespace(services)) - {"__builtins__"}
    schema_names = set(pn.schema()["scriptNamespace"]["names"])

    assert schema_names == runtime_names


def test_script_namespace_schema_categories_are_disjoint() -> None:
    categories = pn.schema()["scriptNamespace"]["categories"]
    categorized_names: list[str] = []
    for entries in categories.values():
        if isinstance(entries, list):
            categorized_names.extend(entries)

    assert len(categorized_names) == len(set(categorized_names))
