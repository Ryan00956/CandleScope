from __future__ import annotations

import argparse
import shutil
import sqlite3
from pathlib import Path

M9_TABLES = (
    "backtest_strategy_revisions",
    "backtest_strategy_smokes",
    "backtest_signal_trace",
    "backtest_review_bridges",
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Verified backtest M9 schema rollback")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args()
    if args.confirm != "ROLLBACK_M9_SCHEMA_TO_V3":
        raise RuntimeError("explicit ROLLBACK_M9_SCHEMA_TO_V3 confirmation required")
    connection = sqlite3.connect(args.database)
    version = int(
        connection.execute(
            "SELECT schema_version FROM backtest_schema_meta"
        ).fetchone()[0]
    )
    if version != 4:
        raise RuntimeError("rollback requires exact schema version 4")
    counts = {
        table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in M9_TABLES
    }
    if any(counts.values()):
        raise RuntimeError(
            f"M9 tables contain data; export evidence before rollback: {counts}"
        )
    connection.close()
    args.backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.database, args.backup)
    connection = sqlite3.connect(args.database)
    try:
        connection.execute("BEGIN IMMEDIATE")
        for table in reversed(M9_TABLES):
            connection.execute(f"DROP TABLE {table}")
        connection.execute("UPDATE backtest_schema_meta SET schema_version = 3")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    main()
