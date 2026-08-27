from __future__ import annotations

import sqlite3

import pytest

from app.data_engine.storage import klines_repo
from app.data_engine.storage.bootstrap import initialize_market_storage
from app.data_engine.storage.sqlite_runtime import (
    SQLiteConnectionPolicy,
    open_sqlite,
)


def test_open_sqlite_applies_shared_connection_policy(tmp_path) -> None:
    database = tmp_path / "policy.sqlite"
    policy = SQLiteConnectionPolicy(
        busy_timeout_ms=1234,
        journal_mode="WAL",
        synchronous="NORMAL",
    )

    with open_sqlite(database, policy=policy) as connection:
        assert connection.execute("PRAGMA busy_timeout").fetchone()[0] == 1234
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("PRAGMA synchronous").fetchone()[0] == 1
        row = connection.execute("SELECT 1 AS value").fetchone()
        assert isinstance(row, sqlite3.Row)
        assert row["value"] == 1


def test_market_storage_bootstrap_initializes_manifest_and_domain_tables(
    tmp_path,
    monkeypatch,
) -> None:
    database = tmp_path / "candlescope.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", database)

    report = initialize_market_storage(
        klines_db_path=database,
        trade_flow_backend="sqlite",
        trade_flow_db_path=database,
        liquidation_backend="sqlite",
        liquidation_db_path=database,
    )

    assert report.manifest_path == database
    assert [component.component for component in report.components] == [
        "bars",
        "market_metrics",
        "trade_flow_rollup",
        "liquidation_rollup",
    ]

    with sqlite3.connect(database) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table'",
            )
        }
        manifest = connection.execute(
            """
            SELECT component, backend, schema_version, initialized
            FROM market_storage_schema
            ORDER BY component
            """,
        ).fetchall()

    assert {
        "klines",
        "funding_rate_history",
        "trade_flow_rollup_1m",
        "liquidation_rollup_1m",
        "market_storage_schema",
    } <= tables
    assert manifest == [
        ("bars", "sqlite", 1, 1),
        ("liquidation_rollup", "sqlite", 1, 1),
        ("market_metrics", "sqlite", 1, 1),
        ("trade_flow_rollup", "sqlite", 1, 1),
    ]


def test_market_storage_bootstrap_rejects_newer_manifest_before_initializers(
    tmp_path,
    monkeypatch,
) -> None:
    database = tmp_path / "candlescope.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", database)
    initialize_market_storage(
        klines_db_path=database,
        trade_flow_backend="sqlite",
        trade_flow_db_path=database,
        liquidation_backend="sqlite",
        liquidation_db_path=database,
    )
    with sqlite3.connect(database) as connection:
        connection.execute(
            "UPDATE market_storage_schema SET schema_version = 99 WHERE component = 'bars'",
        )

    monkeypatch.setattr(
        klines_repo,
        "init_klines_storage",
        lambda: pytest.fail("domain initializer ran before manifest preflight"),
    )
    with pytest.raises(RuntimeError, match="newer than this runtime"):
        initialize_market_storage(
            klines_db_path=database,
            trade_flow_backend="sqlite",
            trade_flow_db_path=database,
            liquidation_backend="sqlite",
            liquidation_db_path=database,
        )
