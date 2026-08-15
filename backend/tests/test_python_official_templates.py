from __future__ import annotations

import json
from pathlib import Path

from app.backtest.service import BacktestService
from app.backtest.strategy.python_bundle import inspect_directory
from app.backtest.strategy.python_provider import PythonHostProvider
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent

TEMPLATES = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "candlescope-backtest-sdk"
    / "templates"
)
GOLDENS = TEMPLATES / "goldens"
CATALOG = json.loads((TEMPLATES / "catalog.json").read_text(encoding="utf-8"))
PARAMETERS = {
    "sma_cross": {"fast": 2, "slow": 3},
    "rsi_wilder_24": {"length": 3, "oversold": 30, "overbought": 70},
    "donchian_breakout": {"lookback": 2},
    "mean_reversion": {"lookback": 3, "band": 0.5},
    "buy_and_hold": {},
    "always_flat": {},
    "order_intents": {},
    "snapshot_restore": {"fast": 2, "slow": 3},
}


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def _events() -> tuple[MarketEvent, ...]:
    closes = (10, 10, 10, 11, 12, 13, 20, 21)
    events = []
    for index, close in enumerate(closes, start=1):
        events.append(
            MarketEvent(
                sequence=index,
                event_time_ms=(1_700_000_000 + index * 60) * 1000,
                role="BARS",
                payload={
                    "open_time_ms": (1_700_000_000 + (index - 1) * 60) * 1000,
                    "close_time_ms": (1_700_000_000 + index * 60) * 1000,
                    "open": str(close),
                    "high": str(close),
                    "low": str(close),
                    "close": str(close),
                    "volume": "1",
                    "time": 1_700_000_000 + index * 60,
                },
            )
        )
    return tuple(events)


def test_official_templates_produce_host_report_goldens(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    events = _events()
    required = (
        "sma_cross",
        "rsi_wilder_24",
        "donchian_breakout",
        "mean_reversion",
        "buy_and_hold",
        "order_intents",
    )
    for name in required:
        inspected = inspect_directory(TEMPLATES / name)
        golden = json.loads((GOLDENS / f"{name}.json").read_text(encoding="utf-8"))
        assert inspected["bundle_hash"] == golden["bundle_hash"]
        bundle = service.create_python_strategy_bundle(
            directory=str(TEMPLATES / name), now_ms=2
        )
        revision = service.create_python_strategy_revision(bundle["bundle_id"], now_ms=3)
        created = service.create_run(
            {
                "strategy_revision_id": revision["revision_id"],
                "dataset_id": "local-0123456789abcdef0123456789abcdef",
                "data_epoch": "sha256:" + "ab" * 32,
                "snapshot_hash": "sha256:" + "cd" * 32,
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": 1,
                "end_time_ms": 2,
                "parameters": PARAMETERS[name],
                "output_mode": inspected["manifest"]["outputModes"][0],
            },
            idempotency_key=f"tpl-{name}",
            now_ms=4,
        )
        completed = service.execute_bar_run(
            created["run_id"],
            events=events,
            provider=PythonHostProvider(
                TEMPLATES / name, parameters=PARAMETERS[name]
            ),
            now_ms=5,
        )
        assert completed["state"] == "COMPLETED"
        report = completed["result"]
        assert report["report_hash"].startswith("sha256:")
        assert report["decision_hash"] == golden["decision_hash"]
    service.shutdown()


def test_catalog_templates_have_committed_goldens() -> None:
    for name in CATALOG["templates"]:
        payload = json.loads((GOLDENS / f"{name}.json").read_text(encoding="utf-8"))
        assert payload["bundle_hash"].startswith("sha256:")
        assert payload["decision_hash"]
        inspected = inspect_directory(TEMPLATES / name)
        assert inspected["bundle_hash"] == payload["bundle_hash"]
