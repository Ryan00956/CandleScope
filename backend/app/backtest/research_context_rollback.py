"""Schema v7 rollback for the additive research launch-context table."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def rollback_research_contexts(database: Path) -> dict[str, object]:
    connection = sqlite3.connect(database)
    try:
        version = int(
            connection.execute(
                "SELECT schema_version FROM backtest_schema_meta LIMIT 1"
            ).fetchone()[0]
        )
        if version != 7:
            raise RuntimeError(
                "research context rollback requires exact schema version 7"
            )
        count = int(
            connection.execute(
                "SELECT COUNT(*) FROM backtest_research_launch_contexts"
            ).fetchone()[0]
        )
        if count:
            raise RuntimeError(
                "research context rollback is fail-closed while context rows exist"
            )
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DROP INDEX IF EXISTS idx_backtest_research_context_created")
        connection.execute("DROP TABLE IF EXISTS backtest_research_launch_contexts")
        connection.execute("UPDATE backtest_schema_meta SET schema_version = 6")
        connection.commit()
        return {
            "schemaVersion": 6,
            "droppedResearchContexts": True,
            "researchContextRows": 0,
        }
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
