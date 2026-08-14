from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .schema import apply_schema


class BacktestRepository:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._connection: sqlite3.Connection | None = None

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

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    @property
    def connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("backtest repository is not open")
        return self._connection

    def get_run_by_id(self, run_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    def get_run_by_idempotency(self, key: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_runs WHERE idempotency_key = ?",
            (key,),
        ).fetchone()
        return dict(row) if row is not None else None

    def list_runs(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM backtest_runs ORDER BY created_at_ms DESC"
        ).fetchall()
        return [dict(row) for row in rows]

    def insert_run(self, payload: dict[str, Any]) -> None:
        self.connection.execute(
            """
            INSERT INTO backtest_runs(
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

    def get_study(self, study_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_studies WHERE study_id = ?",
            (study_id,),
        ).fetchone()
        return dict(row) if row is not None else None

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

    def get_lease(self, run_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_job_leases WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return dict(row) if row is not None else None

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

    def list_trials(self, study_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM backtest_trials WHERE study_id = ? ORDER BY ordinal ASC",
            (study_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def update_study_state(self, study_id: str, state: str) -> None:
        self.connection.execute(
            "UPDATE backtest_studies SET state = ? WHERE study_id = ?",
            (state, study_id),
        )
        self.connection.commit()

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

    def get_report(self, run_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM backtest_reports WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return dict(row) if row is not None else None

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
