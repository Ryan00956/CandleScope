"""Prove that rolling Phase 0 code back preserves an existing replay.v1 DB."""

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


SENTINEL_SESSION_ID = "phase0-sentinel"
SENTINEL_STATE_HASH = f"sha256:{'1' * 64}"
SENTINEL_DATA_EPOCH = f"sha256:{'2' * 64}"


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


def _create_v1_sentinel(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        migrate_replay_schema(connection, now_ms=1_710_000_000_000)
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
                "{}",
                "{}",
                "PAUSED",
                "phase0_rollback",
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
        connection.commit()
        assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
    finally:
        connection.close()


_PARENT_VERIFIER = f"""
import sqlite3
import sys
from app.replay.storage.schema import migrate_replay_schema

path = sys.argv[1]
connection = sqlite3.connect(path)
try:
    assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
    row = connection.execute(
        "SELECT state, status_reason, revision, state_hash, data_epoch "
        "FROM replay_session WHERE session_id = ?",
        ({SENTINEL_SESSION_ID!r},),
    ).fetchone()
    assert row == (
        "PAUSED",
        "phase0_rollback",
        0,
        {SENTINEL_STATE_HASH!r},
        {SENTINEL_DATA_EPOCH!r},
    )
    migrate_replay_schema(connection, now_ms=1710000000001)
    connection.commit()
    assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
finally:
    connection.close()
"""


def verify(parent: str) -> dict[str, object]:
    parent_commit = _run_git("rev-parse", f"{parent}^{{commit}}")
    with tempfile.TemporaryDirectory(prefix="candlescope-phase0-rollback-") as temp:
        temp_root = Path(temp).resolve()
        parent_worktree = temp_root / "parent"
        database = temp_root / "replay-v1.db"
        _create_v1_sentinel(database)
        before = _sha256(database)
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
            after = _sha256(database)
            if before != after:
                raise RuntimeError(f"replay.v1 DB hash changed: {before} -> {after}")
            return {
                "schema": "replay.v2.phase0.rollback.v1",
                "parent_commit": parent_commit,
                "v1_db_sha256_before": before,
                "v1_db_sha256_after": after,
                "quick_check": "ok",
                "sentinel": "preserved",
                "decision": "PASS",
            }
        finally:
            if worktree_added:
                _run_git("worktree", "remove", "--force", str(parent_worktree))
            _run_git("worktree", "prune")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent", required=True, help="Phase 0 parent commit")
    args = parser.parse_args()
    print(json.dumps(verify(args.parent), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
