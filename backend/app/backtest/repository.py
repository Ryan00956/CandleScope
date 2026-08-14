from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
from functools import wraps
from pathlib import Path
from typing import Any, Callable, TypeVar, cast

from .schema import apply_schema

F = TypeVar("F", bound=Callable[..., Any])


def _locked(method: F) -> F:
    @wraps(method)
    def wrapped(self: BacktestRepository, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            for attempt in range(8):
                try:
                    return method(self, *args, **kwargs)
                except sqlite3.OperationalError as exc:
                    if "locked" not in str(exc).lower() or attempt == 7:
                        raise
                    if self._connection is not None:
                        self._connection.rollback()
                    time.sleep(0.01 * (attempt + 1))
            raise AssertionError("unreachable SQLite retry loop")

    return cast(F, wrapped)


class BacktestRepository:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._connection: sqlite3.Connection | None = None
        self._lock = threading.RLock()

    @_locked
    def open(self, *, now_ms: int) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("PRAGMA foreign_keys=ON")
        apply_schema(connection, now_ms=now_ms)
        connection.commit()
        self._connection = connection

    @_locked
    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    @property
    def connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("backtest repository is not open")
        return self._connection

    @_locked
    def get_run_by_id(self, run_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    @_locked
    def get_run_by_idempotency(self, key: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_runs WHERE idempotency_key = ?",
            (key,),
        ).fetchone()
        return dict(row) if row is not None else None

    @_locked
    def list_runs(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM backtest_runs ORDER BY created_at_ms DESC"
        ).fetchall()
        return [dict(row) for row in rows]

    @_locked
    def insert_run(self, payload: dict[str, Any]) -> bool:
        cursor = self.connection.execute(
            """
            INSERT OR IGNORE INTO backtest_runs(
                run_id, study_id, idempotency_key, state, fidelity_mode,
                source_event_kind, strategy_revision_id, dataset_id, data_epoch,
                snapshot_hash, config_json, config_hash, engine_version,
                generation, failure_code, created_at_ms, updated_at_ms
            ) VALUES (
                :run_id, :study_id, :idempotency_key, :state, :fidelity_mode,
                :source_event_kind, :strategy_revision_id, :dataset_id, :data_epoch,
                :snapshot_hash, :config_json, :config_hash, :engine_version,
                :generation, :failure_code, :created_at_ms, :updated_at_ms
            )
            """,
            payload,
        )
        self.connection.commit()
        return cursor.rowcount == 1

    @_locked
    def insert_run_budgeted(
        self,
        payload: dict[str, Any],
        *,
        max_active: int,
        max_queued: int,
    ) -> str:
        connection = self.connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT run_id FROM backtest_runs WHERE idempotency_key = ?",
                (payload["idempotency_key"],),
            ).fetchone()
            if existing is not None:
                connection.commit()
                return "EXISTING"
            active = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM backtest_runs
                    WHERE state IN ('PREPARING','RUNNING','COMPLETING','PAUSING','CANCELLING')
                    """
                ).fetchone()[0]
            )
            if active >= max_active:
                connection.commit()
                return "ACTIVE_LIMIT"
            queued = int(
                connection.execute(
                    "SELECT COUNT(*) FROM backtest_runs WHERE state = 'QUEUED'"
                ).fetchone()[0]
            )
            if queued >= max_queued:
                connection.commit()
                return "QUEUE_LIMIT"
            columns = ", ".join(payload)
            placeholders = ", ".join(f":{name}" for name in payload)
            connection.execute(
                f"INSERT INTO backtest_runs({columns}) VALUES ({placeholders})",
                payload,
            )
            connection.commit()
            return "INSERTED"
        except Exception:
            connection.rollback()
            raise

    @_locked
    def update_run_state(
        self,
        run_id: str,
        *,
        state: str,
        updated_at_ms: int,
        failure_code: str | None = None,
        generation: int | None = None,
    ) -> None:
        fields = ["state = ?", "updated_at_ms = ?", "failure_code = ?"]
        values: list[object] = [state, updated_at_ms, failure_code]
        if generation is not None:
            fields.append("generation = ?")
            values.append(generation)
        values.append(run_id)
        self.connection.execute(
            f"UPDATE backtest_runs SET {', '.join(fields)} WHERE run_id = ?",
            values,
        )
        self.connection.commit()

    @_locked
    def compare_and_set_run_state(
        self,
        run_id: str,
        *,
        expected_state: str,
        expected_generation: int | None = None,
        state: str,
        updated_at_ms: int,
        failure_code: str | None = None,
        generation: int | None = None,
    ) -> bool:
        fields = ["state = ?", "updated_at_ms = ?", "failure_code = ?"]
        values: list[object] = [state, updated_at_ms, failure_code]
        if generation is not None:
            fields.append("generation = ?")
            values.append(generation)
        where = "run_id = ? AND state = ?"
        values.extend((run_id, expected_state))
        if expected_generation is not None:
            where += " AND generation = ?"
            values.append(expected_generation)
        cursor = self.connection.execute(
            f"UPDATE backtest_runs SET {', '.join(fields)} "
            f"WHERE {where}",
            values,
        )
        self.connection.commit()
        return cursor.rowcount == 1

    @_locked
    def insert_study(self, payload: dict[str, Any]) -> None:
        self.connection.execute(
            """
            INSERT INTO backtest_studies(
                study_id, name, hypothesis, strategy_revision_id,
                config_json, config_hash, state, created_at_ms
            ) VALUES (
                :study_id, :name, :hypothesis, :strategy_revision_id,
                :config_json, :config_hash, :state, :created_at_ms
            )
            """,
            payload,
        )
        self.connection.commit()

    @_locked
    def get_study(self, study_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_studies WHERE study_id = ?",
            (study_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    @_locked
    def list_studies(self, *, state: str | None = None) -> list[dict[str, Any]]:
        if state is None:
            rows = self.connection.execute(
                "SELECT * FROM backtest_studies ORDER BY created_at_ms DESC"
            ).fetchall()
        else:
            rows = self.connection.execute(
                "SELECT * FROM backtest_studies WHERE state = ? ORDER BY created_at_ms ASC",
                (state,),
            ).fetchall()
        return [dict(row) for row in rows]

    @_locked
    def claim_study_start(self, study_id: str, *, max_running: int) -> str:
        connection = self.connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT state FROM backtest_studies WHERE study_id = ?",
                (study_id,),
            ).fetchone()
            if row is None:
                connection.commit()
                return "UNKNOWN"
            state = str(row["state"])
            if state != "CREATED":
                connection.commit()
                return state
            running = int(
                connection.execute(
                    "SELECT COUNT(*) FROM backtest_studies WHERE state = 'RUNNING'"
                ).fetchone()[0]
            )
            if running >= max_running:
                connection.commit()
                return "BUDGET_EXCEEDED"
            connection.execute(
                "UPDATE backtest_studies SET state = 'RUNNING' WHERE study_id = ? AND state = 'CREATED'",
                (study_id,),
            )
            connection.commit()
            return "STARTED"
        except Exception:
            connection.rollback()
            raise

    @_locked
    def upsert_lease(
        self, run_id: str, owner: str, generation: int, expires_at_ms: int
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO backtest_job_leases(run_id, owner, generation, expires_at_ms)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                owner = excluded.owner,
                generation = excluded.generation,
                expires_at_ms = excluded.expires_at_ms
            """,
            (run_id, owner, generation, expires_at_ms),
        )
        self.connection.commit()

    @_locked
    def renew_lease(
        self,
        run_id: str,
        *,
        owner: str,
        generation: int,
        expires_at_ms: int,
    ) -> bool:
        cursor = self.connection.execute(
            """
            UPDATE backtest_job_leases
            SET expires_at_ms = ?
            WHERE run_id = ? AND owner = ? AND generation = ?
            """,
            (expires_at_ms, run_id, owner, generation),
        )
        self.connection.commit()
        return cursor.rowcount == 1

    @_locked
    def get_lease(self, run_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_job_leases WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    @_locked
    def save_checkpoint(self, payload: dict[str, Any]) -> bool:
        """Publish one verified checkpoint and retain only the newest complete one."""
        connection = self.connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            owner = connection.execute(
                "SELECT state, generation FROM backtest_runs WHERE run_id = ?",
                (payload["run_id"],),
            ).fetchone()
            if (
                owner is None
                or str(owner["state"]) != "RUNNING"
                or int(owner["generation"]) != int(payload["generation"])
            ):
                connection.rollback()
                return False
            connection.execute(
                """
                INSERT INTO backtest_checkpoints(
                    run_id, sequence, generation, payload_json, state_hash, created_at_ms
                ) VALUES (
                    :run_id, :sequence, :generation, :payload_json, :state_hash, :created_at_ms
                )
                ON CONFLICT(run_id, sequence) DO UPDATE SET
                    generation = excluded.generation,
                    payload_json = excluded.payload_json,
                    state_hash = excluded.state_hash,
                    created_at_ms = excluded.created_at_ms
                """,
                payload,
            )
            connection.execute(
                "DELETE FROM backtest_checkpoints WHERE run_id = ? AND sequence < ?",
                (payload["run_id"], payload["sequence"]),
            )
            connection.commit()
            return True
        except Exception:
            connection.rollback()
            raise

    @_locked
    def latest_checkpoint(self, run_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            """
            SELECT * FROM backtest_checkpoints
            WHERE run_id = ? ORDER BY sequence DESC LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    @_locked
    def delete_checkpoints(self, run_id: str) -> None:
        self.connection.execute(
            "DELETE FROM backtest_checkpoints WHERE run_id = ?",
            (run_id,),
        )
        self.connection.commit()

    @_locked
    def expire_leases(self, now_ms: int) -> list[str]:
        rows = self.connection.execute(
            "SELECT run_id FROM backtest_job_leases WHERE expires_at_ms < ?",
            (now_ms,),
        ).fetchall()
        expired = [str(row["run_id"]) for row in rows]
        if expired:
            self.connection.execute(
                "DELETE FROM backtest_job_leases WHERE expires_at_ms < ?",
                (now_ms,),
            )
            self.connection.commit()
        return expired

    @_locked
    def claim_next_queued(
        self,
        *,
        owner: str,
        now_ms: int,
        lease_ms: int,
    ) -> dict[str, Any] | None:
        """Atomically lease the oldest queued run to one local worker."""
        connection = self.connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "DELETE FROM backtest_job_leases WHERE expires_at_ms < ?",
                (now_ms,),
            )
            row = connection.execute(
                """
                SELECT runs.*
                FROM backtest_runs AS runs
                LEFT JOIN backtest_job_leases AS leases
                  ON leases.run_id = runs.run_id
                WHERE runs.state = 'QUEUED' AND leases.run_id IS NULL
                ORDER BY runs.created_at_ms ASC, runs.run_id ASC
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                connection.commit()
                return None
            connection.execute(
                """
                INSERT INTO backtest_job_leases(run_id, owner, generation, expires_at_ms)
                VALUES (?, ?, ?, ?)
                """,
                (
                    row["run_id"],
                    owner,
                    int(row["generation"]),
                    now_ms + lease_ms,
                ),
            )
            connection.commit()
            return dict(row)
        except Exception:
            connection.rollback()
            raise

    @_locked
    def release_lease(self, run_id: str, *, owner: str) -> None:
        self.connection.execute(
            "DELETE FROM backtest_job_leases WHERE run_id = ? AND owner = ?",
            (run_id, owner),
        )
        self.connection.commit()

    @_locked
    def insert_trial(self, payload: dict[str, Any]) -> None:
        self.connection.execute(
            """
            INSERT INTO backtest_trials(
                trial_id, study_id, ordinal, split_id, params_json,
                params_hash, run_id, state
            ) VALUES (
                :trial_id, :study_id, :ordinal, :split_id, :params_json,
                :params_hash, :run_id, :state
            )
            """,
            payload,
        )
        self.connection.commit()

    @_locked
    def list_trials(self, study_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM backtest_trials WHERE study_id = ? ORDER BY ordinal ASC",
            (study_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    @_locked
    def attach_trial_run(self, trial_id: str, *, run_id: str) -> bool:
        cursor = self.connection.execute(
            """
            UPDATE backtest_trials
            SET run_id = ?, state = 'QUEUED'
            WHERE trial_id = ? AND run_id IS NULL AND state = 'PLANNED'
            """,
            (run_id, trial_id),
        )
        self.connection.commit()
        return cursor.rowcount == 1

    @_locked
    def update_trial_for_run(self, run_id: str, *, state: str) -> None:
        self.connection.execute(
            "UPDATE backtest_trials SET state = ? WHERE run_id = ?",
            (state, run_id),
        )
        self.connection.commit()

    @_locked
    def cancel_planned_trials(self, study_id: str) -> None:
        self.connection.execute(
            """
            UPDATE backtest_trials SET state = 'CANCELLED'
            WHERE study_id = ? AND state = 'PLANNED' AND run_id IS NULL
            """,
            (study_id,),
        )
        self.connection.commit()

    @_locked
    def finish_study_if_terminal(self, study_id: str) -> None:
        row = self.connection.execute(
            """
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN state IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN 1 ELSE 0 END)
                       AS terminal
            FROM backtest_trials WHERE study_id = ?
            """,
            (study_id,),
        ).fetchone()
        study = self.get_study(study_id)
        if (
            study is not None
            and study["state"] == "RUNNING"
            and int(row["total"]) > 0
            and int(row["terminal"] or 0) == int(row["total"])
        ):
            states = {
                str(item["state"])
                for item in self.connection.execute(
                    "SELECT state FROM backtest_trials WHERE study_id = ?",
                    (study_id,),
                ).fetchall()
            }
            final_state = "FAILED" if "FAILED" in states else "COMPLETED"
            self.connection.execute(
                "UPDATE backtest_studies SET state = ? WHERE study_id = ?",
                (final_state, study_id),
            )
            self.connection.commit()

    @_locked
    def update_study_state(self, study_id: str, state: str) -> None:
        self.connection.execute(
            "UPDATE backtest_studies SET state = ? WHERE study_id = ?",
            (state, study_id),
        )
        self.connection.commit()

    @_locked
    def save_report(
        self,
        run_id: str,
        report_schema: str,
        report_json: str,
        report_hash: str | None,
        generated_at_ms: int,
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO backtest_reports(
                run_id, report_schema, report_json, report_hash, generated_at_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                report_schema = excluded.report_schema,
                report_json = excluded.report_json,
                report_hash = excluded.report_hash,
                generated_at_ms = excluded.generated_at_ms
            """,
            (run_id, report_schema, report_json, report_hash, generated_at_ms),
        )
        self.connection.commit()

    @_locked
    def finalize_run(
        self,
        *,
        run_id: str,
        expected_generation: int,
        report_schema: str,
        report_json: str,
        report_hash: str,
        generated_at_ms: int,
        audit_action: str,
        audit_actor: str,
        audit_details_json: str,
        updated_at_ms: int,
    ) -> None:
        """Atomically persist the immutable report, completion audit, and state."""
        connection = self.connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT state, generation FROM backtest_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if (
                row is None
                or str(row["state"]) != "COMPLETING"
                or int(row["generation"]) != expected_generation
            ):
                raise RuntimeError(
                    "run generation must still own COMPLETING before finalization"
                )
            ordinal_row = connection.execute(
                """
                SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
                FROM backtest_audit WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            ordinal = int(ordinal_row["next_ordinal"])
            chain_hash = (
                "sha256:"
                + hashlib.sha256(
                    f"{run_id}:{ordinal}:{audit_action}:{audit_details_json}".encode(
                        "utf-8"
                    )
                ).hexdigest()
            )
            connection.execute(
                """
                INSERT INTO backtest_reports(
                    run_id, report_schema, report_json, report_hash, generated_at_ms
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    report_schema = excluded.report_schema,
                    report_json = excluded.report_json,
                    report_hash = excluded.report_hash,
                    generated_at_ms = excluded.generated_at_ms
                """,
                (run_id, report_schema, report_json, report_hash, generated_at_ms),
            )
            connection.execute(
                """
                INSERT INTO backtest_audit(
                    run_id, ordinal, action, actor, details_json, chain_hash
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    ordinal,
                    audit_action,
                    audit_actor,
                    audit_details_json,
                    chain_hash,
                ),
            )
            connection.execute(
                """
                UPDATE backtest_runs
                SET state = 'COMPLETED', updated_at_ms = ?, failure_code = NULL
                WHERE run_id = ? AND state = 'COMPLETING' AND generation = ?
                """,
                (updated_at_ms, run_id, expected_generation),
            )
            connection.execute(
                "DELETE FROM backtest_checkpoints WHERE run_id = ?",
                (run_id,),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    @_locked
    def get_report(self, run_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_reports WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    @_locked
    def next_audit_ordinal(self, run_id: str) -> int:
        row = self.connection.execute(
            "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM backtest_audit WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return int(row["max_ordinal"]) + 1

    @_locked
    def append_audit(
        self,
        run_id: str,
        ordinal: int,
        action: str,
        actor: str,
        details_json: str,
        chain_hash: str,
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO backtest_audit(
                run_id, ordinal, action, actor, details_json, chain_hash
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (run_id, ordinal, action, actor, details_json, chain_hash),
        )
        self.connection.commit()
