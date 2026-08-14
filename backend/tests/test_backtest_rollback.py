from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.backtest.schema import SCHEMA_VERSION, apply_schema
from app.backtest.service import BacktestService
from app.core.config import load_backtest_settings
from app.main import app


def test_newer_schema_is_rejected_by_older_binary(tmp_path: Path) -> None:
    path = tmp_path / "backtest.db"
    connection = sqlite3.connect(path)
    apply_schema(connection, now_ms=1)
    connection.execute(
        "UPDATE backtest_schema_meta SET schema_version = ?",
        (SCHEMA_VERSION + 1,),
    )
    connection.commit()
    with pytest.raises(RuntimeError, match="newer than this binary"):
        apply_schema(connection, now_ms=2)
    connection.close()


def test_flag_off_ignores_existing_backtest_database(tmp_path: Path) -> None:
    enabled = BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    db_path = tmp_path / "backtest.db"
    assert db_path.is_file()
    enabled.shutdown()
    from app.backtest.errors import BacktestError

    with pytest.raises(BacktestError, match="FLAG_DISABLED"):
        BacktestService.start(
            load_backtest_settings(
                {},
                data_dir=tmp_path,
                klines_db_path=tmp_path / "candlescope.db",
                replay_db_path=tmp_path / "replay.db",
            ),
            now_ms=2,
        )
    assert db_path.is_file()
    assert not any(
        getattr(route, "path", "").startswith("/api/v1/backtests") for route in app.routes
    )
