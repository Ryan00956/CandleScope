from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "app" / "market_dataset"
FORBIDDEN_PREFIXES = (
    "app.replay",
    "app.backtest",
    "app.plugin_core_v2",
    "app.plugin_host",
    "fastapi",
    "starlette",
)


def _imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.append(node.module)
    return names


def test_market_dataset_has_no_replay_backtest_or_plugin_imports() -> None:
    assert ROOT.is_dir()
    violations: list[str] = []
    for path in ROOT.rglob("*.py"):
        for module in _imports(path):
            if any(
                module == prefix or module.startswith(prefix + ".")
                for prefix in FORBIDDEN_PREFIXES
            ):
                violations.append(f"{path.name}:{module}")
    assert violations == []
