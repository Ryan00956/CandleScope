"""Append-only schema v6 rollback. Fails closed when Python bundle rows exist."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def rollback_python_bundles(database: Path) -> dict[str, object]:
    connection = sqlite3.connect(database)
    try:
        version = int(
            connection.execute(
                "SELECT schema_version FROM backtest_schema_meta LIMIT 1"
            ).fetchone()[0]
        )
        if version != 6:
            raise RuntimeError("python bundle rollback requires exact schema version 6")
        count = int(
            connection.execute(
                "SELECT COUNT(*) FROM backtest_strategy_bundles"
            ).fetchone()[0]
        )
        if count:
            raise RuntimeError(
                "python bundle rollback is fail-closed while bundle rows exist"
            )
        connection.execute("DROP TABLE IF EXISTS backtest_strategy_bundles")
        connection.execute(
            "UPDATE backtest_schema_meta SET schema_version = 5"
        )
        connection.commit()
        return {"schemaVersion": 5, "droppedBundles": True, "bundleRows": 0}
    finally:
        connection.close()
