from __future__ import annotations

import ast
from pathlib import Path

import pytest

from tests.backtest_contract.spec import load_golden

REPO_ROOT = Path(__file__).resolve().parents[3]
BACKEND_ROOT = REPO_ROOT / "backend"


def test_host_backtest_modules_are_still_absent() -> None:
    golden = load_golden()
    missing = [
        REPO_ROOT / relative
        for relative in golden["forbidden_implementation_paths"]
        if (REPO_ROOT / relative).exists()
    ]
    assert missing == [], f"Phase 0 must not ship Host implementation: {missing}"


@pytest.mark.parametrize(
    "module_name",
    [
        "app.backtest",
        "app.backtest.service",
        "app.market_dataset",
        "app.market_dataset.ports",
        "app.simulation",
        "app.simulation.clock",
        "app.api.v1.backtests",
        "app.api.v1.stream_backtests",
    ],
)
def test_production_imports_fail_closed_until_later_phases(module_name: str) -> None:
    with pytest.raises(ModuleNotFoundError):
        __import__(module_name)


def test_main_does_not_register_backtest_routes() -> None:
    main_text = (BACKEND_ROOT / "app" / "main.py").read_text(encoding="utf-8")
    assert "backtests" not in main_text
    assert "stream_backtests" not in main_text
    tree = ast.parse(main_text)
    imported = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)
    assert all("backtest" not in module for module in imported)


def test_frontend_has_no_backtest_store_or_entry() -> None:
    frontend_root = REPO_ROOT / "frontend" / "src"
    assert not (frontend_root / "features" / "backtest").exists()
    hits: list[str] = []
    for path in frontend_root.rglob("*"):
        if path.suffix not in {".ts", ".tsx"}:
            continue
        text = path.read_text(encoding="utf-8")
        if "VITE_BACKTEST_ENTRY_ENABLED" in text or "features/backtest" in text:
            hits.append(str(path.relative_to(REPO_ROOT)))
    assert hits == []
