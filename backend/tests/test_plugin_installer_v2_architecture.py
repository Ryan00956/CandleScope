from __future__ import annotations

import ast
from pathlib import Path


PACKAGE = Path(__file__).parents[1] / "app" / "plugin_installer_v2"


def test_v2_installer_does_not_depend_on_legacy_or_business_modules() -> None:
    forbidden = (
        "app.plugin_runtime",
        "app.indicator",
        "app.exchanges",
        "app.data_engine",
        "app.replay",
    )
    imports: list[str] = []
    for source in PACKAGE.glob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append(node.module)
    assert not [name for name in imports if name.startswith(forbidden)]
