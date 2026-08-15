from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src" / "candlescope_backtest_sdk"
FORBIDDEN = (
    "app",
    "sqlite3",
    "socket",
    "http",
    "urllib",
    "requests",
    "candlescope_plugin_sdk",
    "candlescope_plugin_pyne",
    "pyne_runtime",
)


def test_sdk_has_no_backend_database_network_or_plugin_imports() -> None:
    violations: list[str] = []
    for path in ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                names.append(node.module)
            for module in names:
                if any(module == item or module.startswith(item + ".") for item in FORBIDDEN):
                    violations.append(f"{path.name}:{module}")
    assert violations == []
