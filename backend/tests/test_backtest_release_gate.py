from __future__ import annotations

from pathlib import Path

from app.backtest.reports import LABELS, build_report
from app.core.config import load_backtest_settings
from app.main import app


def test_all_production_backtest_flags_default_off(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    assert settings.enabled is False
    assert settings.bar_effective is False
    assert settings.trade_tape_effective is False
    assert settings.study_enabled is False
    assert settings.external_provider_enabled is False
    assert settings.book_assisted_enabled is False
    assert settings.multi_market_enabled is False


def test_default_process_does_not_register_backtest_routes() -> None:
    assert not any(
        getattr(route, "path", "").startswith("/api/v1/backtests") for route in app.routes
    )


def test_report_labels_never_claim_perfect_or_queue_exact() -> None:
    assert "ORDER_LEVEL_REQUIRED" not in {
        LABELS["BAR_APPROX"],
        LABELS["TRADE_TAPE"],
        LABELS["AGG_TRADE_TAPE"],
        LABELS["BOOK_ASSISTED"],
    }
    report = build_report({"fidelity_mode": "TRADE_TAPE", "source_event_kind": "RAW_TRADE", "run_id": "x"})
    blob = str(report).lower()
    assert "完美" not in blob
    assert report["report_label"] == "TRADE_SEQUENCE"


def test_frontend_entry_flag_defaults_off() -> None:
    root = Path(__file__).resolve().parents[2] / "frontend" / "src" / "features" / "backtest" / "backtestFlags.ts"
    text = root.read_text(encoding="utf-8")
    assert 'VITE_BACKTEST_ENTRY_ENABLED ?? "0"' in text
