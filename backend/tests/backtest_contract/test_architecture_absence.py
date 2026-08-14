from __future__ import annotations

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
        "app.api.v1.stream_backtests",
    ],
)
def test_production_imports_fail_closed_until_later_phases(module_name: str) -> None:
    with pytest.raises(ModuleNotFoundError):
        __import__(module_name)


def test_main_registers_backtest_routes_only_behind_the_master_flag() -> None:
    main_text = (BACKEND_ROOT / "app" / "main.py").read_text(encoding="utf-8")
    assert "if BACKTEST_SETTINGS.enabled:" in main_text
    assert "stream_backtests" not in main_text
    from app.main import app

    assert not any(
        getattr(route, "path", "").startswith("/api/v1/backtests")
        for route in app.routes
    )


def test_frontend_backtest_feature_stays_isolated_from_replay() -> None:
    feature_root = REPO_ROOT / "frontend" / "src" / "features" / "backtest"
    assert feature_root.is_dir()
    hits: list[str] = []
    for path in feature_root.rglob("*"):
        if path.suffix not in {".ts", ".tsx"}:
            continue
        if "__tests__" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        if "features/replay" in text or "replayStore" in text or "TrainingRun" in text:
            hits.append(str(path.relative_to(REPO_ROOT)))
    assert hits == []
