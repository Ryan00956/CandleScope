from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rollback(database: Path, backup: Path, receipt_path: Path) -> dict[str, object]:
    database = database.resolve()
    backup = backup.resolve()
    if database == backup:
        raise RuntimeError("backup must not overwrite the source database")
    if not database.is_file():
        raise RuntimeError("backtest database does not exist")
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    version = int(
        connection.execute("SELECT schema_version FROM backtest_schema_meta").fetchone()[0]
    )
    if version != 5:
        raise RuntimeError("rollback requires exact schema version 5")
    rows = [
        dict(row)
        for row in connection.execute(
            "SELECT run_id, cache_schema, interval, bars_json, bar_count, bars_hash "
            "FROM backtest_chart_cache ORDER BY run_id"
        )
    ]
    for row in rows:
        expected = "sha256:" + hashlib.sha256(
            str(row["bars_json"]).encode("utf-8")
        ).hexdigest()
        if row["bars_hash"] != expected:
            raise RuntimeError(f"chart cache hash mismatch for {row['run_id']}")
    authoritative_before = {
        table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in ("backtest_runs", "backtest_reports", "backtest_audit")
    }
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup_connection = sqlite3.connect(backup)
    try:
        connection.backup(backup_connection)
    finally:
        backup_connection.close()
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DROP TABLE backtest_chart_cache")
        connection.execute("UPDATE backtest_schema_meta SET schema_version = 4")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    verified = sqlite3.connect(database)
    try:
        authoritative_after = {
            table: int(verified.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in ("backtest_runs", "backtest_reports", "backtest_audit")
        }
        if authoritative_after != authoritative_before:
            raise RuntimeError("authoritative row counts changed during schema rollback")
        if (
            verified.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' "
                "AND name='backtest_chart_cache'"
            ).fetchone()
            is not None
        ):
            raise RuntimeError("derived chart cache table survived rollback")
    finally:
        verified.close()
    receipt = {
        "schemaVersion": "candlescope.backtest-m10-schema-rollback/1",
        "database": str(database),
        "backup": str(backup),
        "backupSha256": _sha256(backup),
        "droppedDerivedChartCacheRows": len(rows),
        "authoritativeRunsReportsAndAuditPreserved": True,
        "authoritativeRowCounts": authoritative_after,
        "targetSchemaVersion": 4,
    }
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description="Verified backtest M10 schema rollback")
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args()
    if args.confirm != "ROLLBACK_M10_SCHEMA_TO_V4":
        raise RuntimeError("explicit ROLLBACK_M10_SCHEMA_TO_V4 confirmation required")
    rollback(args.database, args.backup, args.receipt)


if __name__ == "__main__":
    main()
