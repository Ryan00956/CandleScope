"""Shared SQLite connection policy for DataEngine-owned repositories."""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SQLiteConnectionPolicy:
    timeout_seconds: float = 30.0
    busy_timeout_ms: int | None = 30_000
    check_same_thread: bool = False
    use_row_factory: bool = True
    configure_journal_mode: bool = True
    journal_mode: str = "WAL"
    fallback_journal_mode: str = "DELETE"
    synchronous: str = "NORMAL"

    def __post_init__(self) -> None:
        if self.timeout_seconds < 0:
            raise ValueError("SQLite timeout_seconds cannot be negative")
        if self.busy_timeout_ms is not None and self.busy_timeout_ms < 0:
            raise ValueError("SQLite busy_timeout_ms cannot be negative")
        for field_name in ("journal_mode", "fallback_journal_mode", "synchronous"):
            value = str(getattr(self, field_name)).strip().upper()
            if not value or not value.replace("_", "").isalnum():
                raise ValueError(f"invalid SQLite {field_name}: {value!r}")
            object.__setattr__(self, field_name, value)


DEFAULT_SQLITE_POLICY = SQLiteConnectionPolicy()


def open_sqlite(
    db_path: Path | str,
    *,
    policy: SQLiteConnectionPolicy = DEFAULT_SQLITE_POLICY,
    logger: logging.Logger | None = None,
) -> sqlite3.Connection:
    """Open one repository connection under the shared DataEngine policy."""

    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(
        str(path),
        timeout=float(policy.timeout_seconds),
        check_same_thread=policy.check_same_thread,
    )
    if policy.use_row_factory:
        connection.row_factory = sqlite3.Row
    if policy.busy_timeout_ms is not None:
        connection.execute(f"PRAGMA busy_timeout={int(policy.busy_timeout_ms)};")
    if policy.configure_journal_mode:
        try:
            connection.execute(f"PRAGMA journal_mode={policy.journal_mode};")
        except sqlite3.OperationalError as exc:
            if logger is not None:
                logger.warning(
                    "SQLite %s mode unavailable for %s, falling back to %s: %s",
                    policy.journal_mode,
                    path,
                    policy.fallback_journal_mode,
                    exc,
                )
            connection.execute(
                f"PRAGMA journal_mode={policy.fallback_journal_mode};",
            )
    connection.execute(f"PRAGMA synchronous={policy.synchronous};")
    return connection


__all__ = ["DEFAULT_SQLITE_POLICY", "SQLiteConnectionPolicy", "open_sqlite"]
