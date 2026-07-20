from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from scripts.snapshot_replay_klines import SnapshotError, create_snapshot


def _source_database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            "CREATE TABLE bars (open_time_ms INTEGER PRIMARY KEY, close TEXT NOT NULL)"
        )
        connection.executemany(
            "INSERT INTO bars(open_time_ms, close) VALUES (?, ?)",
            [(60_000, "100.5"), (120_000, "101.25")],
        )


def test_snapshot_uses_online_backup_and_publishes_quick_checked_database(tmp_path: Path) -> None:
    source = tmp_path / "source.db"
    destination = tmp_path / "nested" / "snapshot.db"
    _source_database(source)

    result = create_snapshot(source, destination, require_quick_check=True)

    assert result.source == source.resolve()
    assert result.destination == destination.resolve()
    assert result.quick_check == "ok"
    with sqlite3.connect(destination) as connection:
        assert connection.execute("SELECT * FROM bars ORDER BY open_time_ms").fetchall() == [
            (60_000, "100.5"),
            (120_000, "101.25"),
        ]
    assert list(destination.parent.glob(f".{destination.name}.*.tmp")) == []


def test_snapshot_rejects_source_destination_identity(tmp_path: Path) -> None:
    source = tmp_path / "source.db"
    _source_database(source)

    with pytest.raises(SnapshotError, match="same file"):
        create_snapshot(source, source, require_quick_check=True)


def test_snapshot_refuses_existing_destination_without_overwrite(tmp_path: Path) -> None:
    source = tmp_path / "source.db"
    destination = tmp_path / "snapshot.db"
    _source_database(source)
    destination.write_bytes(b"keep-me")

    with pytest.raises(SnapshotError, match="already exists"):
        create_snapshot(source, destination, require_quick_check=True)

    assert destination.read_bytes() == b"keep-me"
    assert list(tmp_path.glob(f".{destination.name}.*.tmp")) == []


def test_snapshot_failure_cleans_temporary_database_and_never_publishes(tmp_path: Path) -> None:
    source = tmp_path / "invalid.db"
    destination = tmp_path / "snapshot.db"
    source.write_bytes(b"not a sqlite database")

    with pytest.raises(SnapshotError, match="snapshot failed"):
        create_snapshot(source, destination, require_quick_check=True)

    assert not destination.exists()
    assert list(tmp_path.glob(f".{destination.name}.*.tmp")) == []
