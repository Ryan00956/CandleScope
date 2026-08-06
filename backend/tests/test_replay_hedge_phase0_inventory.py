from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = BACKEND_ROOT / "scripts" / "audit_replay_hedge_phase0.py"
EVIDENCE = (
    BACKEND_ROOT.parent
    / "docs"
    / "evidence"
    / "KLINE_REPLAY_HEDGE_PHASE0_DATA_INVENTORY_20260806.json"
)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE replay_training_schema_version (
                singleton INTEGER PRIMARY KEY,
                version INTEGER NOT NULL
            );
            INSERT INTO replay_training_schema_version VALUES (1, 13);
            CREATE TABLE replay_session (session_id TEXT PRIMARY KEY);
            INSERT INTO replay_session VALUES ('session-1');
            CREATE TABLE replay_training_run (
                run_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            );
            INSERT INTO replay_training_run VALUES ('run-1', 'HEDGE fixture', 'PAUSED', 1);
            CREATE TABLE replay_training_rule (
                run_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                rule_json TEXT NOT NULL
            );
            INSERT INTO replay_training_rule
            VALUES ('run-1', 1, '{"position_mode":"HEDGE"}');
            """
        )


def test_phase0_inventory_is_read_only_and_detects_hedge_runs(tmp_path: Path) -> None:
    database = tmp_path / "replay.db"
    archive = tmp_path / "account-history"
    output = tmp_path / "inventory.json"
    archive.mkdir()
    (archive / "sample.sqlite3").write_bytes(b"fixture")
    _database(database)
    before = _sha256(database)

    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--replay-db",
            str(database),
            "--archive-root",
            f"ACCOUNT_HISTORY={archive}",
            "--captured-at",
            "2026-08-06T00:00:00Z",
            "--output",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)

    assert _sha256(database) == before
    assert json.loads(output.read_text(encoding="utf-8")) == payload
    assert payload["schema_version"] == "replay.hedge-phase0.data-inventory.v1"
    assert payload["read_only"] is True
    assert payload["replay_database"]["sqlite"]["quick_check"] == ["ok"]
    assert payload["replay_database"]["sqlite"]["foreign_key_violation_count"] == 0
    assert payload["replay_database"]["sqlite"]["training_schema_version"] == 13
    assert payload["migration_gate"]["explicit_hedge_rule_count"] == 1
    assert payload["archive_roots"][0]["file_count"] == 1
    assert (
        payload["recovery_scope"]["phase0_action"] == "INVENTORY_ONLY_NO_COPY_NO_DELETE"
    )


def test_checked_in_phase0_inventory_is_valid_and_did_not_find_formal_hedge_runs() -> (
    None
):
    payload = json.loads(EVIDENCE.read_text(encoding="utf-8"))

    assert payload["schema_version"] == "replay.hedge-phase0.data-inventory.v1"
    assert payload["read_only"] is True
    assert payload["replay_database"]["sqlite"]["quick_check"] == ["ok"]
    assert payload["replay_database"]["sqlite"]["foreign_key_violation_count"] == 0
    assert payload["replay_database"]["sqlite"]["training_schema_version"] == 13
    assert payload["migration_gate"]["explicit_hedge_rule_count"] == 0
    assert (
        payload["recovery_scope"]["phase0_action"] == "INVENTORY_ONLY_NO_COPY_NO_DELETE"
    )
