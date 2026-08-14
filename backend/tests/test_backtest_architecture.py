from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "app" / "backtest"
FORBIDDEN = (
    "app.replay",
    "app.plugin_core_v2",
    "app.plugin_host",
    "candlescope_plugin_pyne",
)


def test_backtest_domain_does_not_import_replay_or_plugin_packages() -> None:
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


def test_models_identity_and_errors_do_not_import_fastapi() -> None:
    for name in ("models.py", "errors.py", "identity.py", "schema.py"):
        text = (ROOT / name).read_text(encoding="utf-8")
        assert "fastapi" not in text
        assert "starlette" not in text
