"""Fail-closed M8 schema rollback for a backed-up, inactive SQLite database."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

M8_TABLES = (
    "backtest_study_oos_reports",
    "backtest_study_holdouts",
    "backtest_selection_receipts",
    "backtest_train_trials",
    "backtest_study_folds",
)


def rollback_m8_schema(database: Path, backup: Path) -> None:
    database = database.resolve()
    backup = backup.resolve()
    if database == backup:
        raise RuntimeError("backup path must differ from database")
    if backup.exists():
        raise RuntimeError("backup path already exists; refusing to overwrite evidence")
    source = sqlite3.connect(database)
    source.row_factory = sqlite3.Row
    try:
        version = source.execute(
            "SELECT schema_version FROM backtest_schema_meta LIMIT 1"
        ).fetchone()
        if version is None or int(version[0]) != 3:
            raise RuntimeError("rollback requires exact schema version 3")
        active = source.execute(
            """
            SELECT COUNT(*) FROM backtest_studies
            WHERE json_extract(config_json, '$.study_protocol_revision') = 'BACKTEST_WALK_FORWARD_V2'
            """
        ).fetchone()[0]
        if int(active) != 0:
            raise RuntimeError(
                "M8 Study data exists; export/delete authority is required before downgrade"
            )
        backup.parent.mkdir(parents=True, exist_ok=True)
        target = sqlite3.connect(backup)
        try:
            source.backup(target)
        finally:
            target.close()
        source.execute("BEGIN IMMEDIATE")
        for table in M8_TABLES:
            source.execute(f"DROP TABLE IF EXISTS {table}")
        source.execute(
            "UPDATE backtest_schema_meta SET schema_version = 2, migrated_at_ms = 0"
        )
        if source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite quick_check failed after rollback")
        source.commit()
    except Exception:
        source.rollback()
        raise
    finally:
        source.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument(
        "--confirm", required=True, choices=["ROLLBACK_M8_SCHEMA_TO_V2"]
    )
    args = parser.parse_args()
    rollback_m8_schema(args.database, args.backup)
    print(
        f"rolled back {args.database.resolve()} to schema 2; backup={args.backup.resolve()}"
    )


if __name__ == "__main__":
    main()
