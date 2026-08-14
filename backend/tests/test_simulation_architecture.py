from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "app" / "simulation"
FORBIDDEN = ("app.replay", "app.api", "fastapi", "starlette", "candlescope_plugin_pyne")


def test_simulation_does_not_import_replay_fastapi_or_specific_plugins() -> None:
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
