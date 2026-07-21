"""Prove that the Phase 0 build ignores Phase 1 tables and preserves v1 data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.storage.schema import migrate_replay_schema  # noqa: E402
from app.replay.training.schema import migrate_training_schema  # noqa: E402


SENTINEL_SESSION_ID = "phase1-adapter"
SENTINEL_RUN_ID = "phase1-run"
SENTINEL_STATE_HASH = f"sha256:{'1' * 64}"
SENTINEL_DATA_EPOCH = f"sha256:{'2' * 64}"
SENTINEL_CATALOG_EPOCH = f"sha256:{'3' * 64}"


def _run_git(*args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _json_value(value: object) -> object:
    if isinstance(value, bytes):
        return {"bytes_hex": value.hex()}
    return value


def _logical_digest(path: Path, *, training: bool) -> tuple[str, int]:
    connection = sqlite3.connect(path)
    try:
        prefix = "replay_training"
        rows = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'replay_%'"
        ).fetchall()
        tables = sorted(
            str(row[0])
            for row in rows
            if str(row[0]).startswith(prefix) is training
        )
        payload: list[object] = []
        row_count = 0
        for table in tables:
            columns = [
                str(row[1])
                for row in connection.execute(f'PRAGMA table_info("{table}")').fetchall()
            ]
            table_rows = connection.execute(f'SELECT * FROM "{table}"').fetchall()
            canonical_rows = sorted(
                ([_json_value(value) for value in row] for row in table_rows),
                key=lambda row: json.dumps(row, sort_keys=True, separators=(",", ":")),
            )
            row_count += len(canonical_rows)
            payload.append({"table": table, "columns": columns, "rows": canonical_rows})
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest(), row_count
    finally:
        connection.close()


def _create_phase1_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        migrate_replay_schema(connection, now_ms=1_710_000_000_000)
        migrate_training_schema(connection, now_ms=1_710_000_000_001)
        connection.execute(
            """
            INSERT INTO replay_session(
                session_id, config_json, broker_config_json, state, status_reason,
                revision, event_sequence, source_sequence, command_log_offset,
                state_hash, data_epoch, revealed, accepting, degraded_reason,
                created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                SENTINEL_SESSION_ID,
                '{"protocol":"replay.v1","symbol":"BTCUSDT"}',
                '{"initial_equity":"10000"}',
                "PAUSED",
                "phase1_rollback",
                0,
                0,
                0,
                0,
                SENTINEL_STATE_HASH,
                SENTINEL_DATA_EPOCH,
                0,
                1,
                None,
                1_710_000_000_000,
                1_710_000_000_000,
            ),
        )
        connection.execute(
            """
            INSERT INTO replay_training_run(
                run_id, adapter_session_id, parent_legacy_session_id, protocol,
                schema_version, name, state, source_kind, start_mode, integrity_mode,
                time_disclosure_policy, book_mode, margin_mode, funding_mode,
                execution_model, allow_rule_changes, exchange, market_type,
                last_symbol, settlement_asset, base_interval, display_interval,
                initial_equity, current_equity, summary_revision, revision,
                source_sequence, virtual_time_ms, active_rule_revision, catalog_epoch,
                dataset_epoch, compatibility, created_at_ms, updated_at_ms, saved_at_ms
            ) VALUES (
                :run_id, :session_id, NULL, 'replay.v2', 'replay.training.v1',
                'Phase 1 sentinel', 'PAUSED', 'BAR', 'RANDOM', 'CHALLENGE',
                'HIDE_ALL', 'OFF', 'CROSS', 'OFF', 'TOUCH_OR_TAPE_V2', 0,
                'binance', 'spot', 'BTCUSDT', 'USDT', '1m', '1m',
                '10000', '10000', 0, 0, 0, 0, 1, :catalog_epoch,
                :dataset_epoch, 'READY', :now_ms, :now_ms, :now_ms
            )
            """,
            {
                "run_id": SENTINEL_RUN_ID,
                "session_id": SENTINEL_SESSION_ID,
                "catalog_epoch": SENTINEL_CATALOG_EPOCH,
                "dataset_epoch": SENTINEL_DATA_EPOCH,
                "now_ms": 1_710_000_000_001,
            },
        )
        connection.execute(
            """
            INSERT INTO replay_training_track(
                run_id, track_id, adapter_session_id, exchange, market_type, symbol,
                source_kind, state, subscription_tier, dataset_epoch, virtual_time_ms,
                source_sequence, revision, forced_full_reasons_json,
                capabilities_json, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                SENTINEL_RUN_ID,
                "primary",
                SENTINEL_SESSION_ID,
                "binance",
                "spot",
                "BTCUSDT",
                "BAR",
                "READY",
                "FULL",
                SENTINEL_DATA_EPOCH,
                0,
                0,
                0,
                "[]",
                '{"OHLCV":"AVAILABLE_EXACT"}',
                1_710_000_000_001,
                1_710_000_000_001,
            ),
        )
        connection.execute(
            "INSERT INTO replay_training_rule VALUES (?, 1, ?, ?, ?)",
            (SENTINEL_RUN_ID, "{}", SENTINEL_STATE_HASH, 1_710_000_000_001),
        )
        connection.execute(
            "INSERT INTO replay_training_action VALUES (?, 1, ?, ?, ?)",
            (SENTINEL_RUN_ID, "CREATE", "{}", 1_710_000_000_001),
        )
        connection.execute(
            "INSERT INTO replay_training_pin VALUES (?, ?, ?, ?, ?, ?)",
            (
                SENTINEL_RUN_ID,
                "adapter",
                SENTINEL_DATA_EPOCH,
                "V1_DATASET",
                "{}",
                1_710_000_000_001,
            ),
        )
        connection.commit()
        assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()


_PARENT_VERIFIER = f"""
import importlib.util
import sqlite3
import sys
from app.replay.storage.schema import migrate_replay_schema

path = sys.argv[1]
assert importlib.util.find_spec("app.replay.training.schema") is None
connection = sqlite3.connect(path)
try:
    assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
    assert connection.execute(
        "SELECT state, status_reason, revision, state_hash, data_epoch "
        "FROM replay_session WHERE session_id = ?",
        ({SENTINEL_SESSION_ID!r},),
    ).fetchone() == (
        "PAUSED", "phase1_rollback", 0,
        {SENTINEL_STATE_HASH!r}, {SENTINEL_DATA_EPOCH!r},
    )
    assert connection.execute(
        "SELECT run_id FROM replay_training_run WHERE run_id = ?",
        ({SENTINEL_RUN_ID!r},),
    ).fetchone() == ({SENTINEL_RUN_ID!r},)
    migrate_replay_schema(connection, now_ms=1710000000002)
    connection.commit()
    assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
    assert connection.execute(
        "SELECT version FROM replay_schema_version WHERE singleton = 1"
    ).fetchone() == (2,)
    assert connection.execute(
        "SELECT COUNT(*) FROM replay_training_run"
    ).fetchone() == (1,)
finally:
    connection.close()
"""


def verify(parent: str) -> dict[str, object]:
    parent_commit = _run_git("rev-parse", f"{parent}^{{commit}}")
    with tempfile.TemporaryDirectory(prefix="candlescope-phase1-rollback-") as temp:
        temp_root = Path(temp).resolve()
        parent_worktree = temp_root / "phase0-build"
        database = temp_root / "replay-phase1.db"
        _create_phase1_database(database)
        file_before = _sha256(database)
        v1_before, v1_rows_before = _logical_digest(database, training=False)
        training_before, training_rows_before = _logical_digest(database, training=True)
        worktree_added = False
        try:
            _run_git("worktree", "add", "--detach", str(parent_worktree), parent_commit)
            worktree_added = True
            environment = os.environ.copy()
            environment["PYTHONPATH"] = str(parent_worktree / "backend")
            subprocess.run(
                [sys.executable, "-c", _PARENT_VERIFIER, str(database)],
                cwd=parent_worktree / "backend",
                env=environment,
                check=True,
            )
            file_after = _sha256(database)
            v1_after, v1_rows_after = _logical_digest(database, training=False)
            training_after, training_rows_after = _logical_digest(database, training=True)
            if (file_before, v1_before, training_before) != (
                file_after,
                v1_after,
                training_after,
            ):
                raise RuntimeError("Phase 0 build changed the Phase 1 database")
            return {
                "schema": "replay.v2.phase1.rollback.v1",
                "parent_commit": parent_commit,
                "file_sha256_before": file_before,
                "file_sha256_after": file_after,
                "v1_logical_sha256_before": v1_before,
                "v1_logical_sha256_after": v1_after,
                "v1_rows_before": v1_rows_before,
                "v1_rows_after": v1_rows_after,
                "training_logical_sha256_before": training_before,
                "training_logical_sha256_after": training_after,
                "training_rows_before": training_rows_before,
                "training_rows_after": training_rows_after,
                "quick_check": "ok",
                "old_build_training_module": "absent",
                "decision": "PASS",
            }
        finally:
            if worktree_added:
                _run_git("worktree", "remove", "--force", str(parent_worktree))
            _run_git("worktree", "prune")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent", required=True, help="Phase 1 rollback parent commit")
    args = parser.parse_args()
    print(json.dumps(verify(args.parent), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
