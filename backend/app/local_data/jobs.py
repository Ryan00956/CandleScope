"""Bounded background jobs for large local dataset imports."""

from __future__ import annotations

import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .service import LocalDatasetError, LocalDatasetService, LocalImportOptions

MAX_RETAINED_IMPORT_JOBS = 200


class LocalImportJobManager:
    def __init__(self, service: LocalDatasetService, *, max_workers: int = 2) -> None:
        self.service = service
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="local-import",
        )
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._futures: dict[str, Future[None]] = {}
        self._upload_paths: dict[str, Path] = {}
        self._closed = False

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def submit(self, upload_path: Path, options: LocalImportOptions) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                raise LocalDatasetError(
                    "Import worker is shutting down", code="job_unavailable"
                )
            self._prune_finished_locked()
            job_id = f"job-{uuid.uuid4().hex}"
            event = threading.Event()
            self._cancel_events[job_id] = event
            self._upload_paths[job_id] = Path(upload_path)
            self._jobs[job_id] = {
                "job_id": job_id,
                "kind": "csv_import",
                "status": "queued",
                "stage": "queued",
                "processed_rows": 0,
                "total_rows": None,
                "created_at": self._now(),
                "started_at": None,
                "finished_at": None,
                "dataset": None,
                "error": None,
                "cancel_requested": False,
            }
            future = self._executor.submit(
                self._run, job_id, Path(upload_path), options
            )
            self._futures[job_id] = future
            return dict(self._jobs[job_id])

    def _prune_finished_locked(self) -> None:
        finished = sorted(
            (
                job
                for job in self._jobs.values()
                if job["status"] in {"completed", "failed", "cancelled"}
            ),
            key=lambda item: item["created_at"],
            reverse=True,
        )
        for job in finished[MAX_RETAINED_IMPORT_JOBS:]:
            job_id = job["job_id"]
            self._jobs.pop(job_id, None)
            self._cancel_events.pop(job_id, None)
            self._futures.pop(job_id, None)
            self._upload_paths.pop(job_id, None)

    def _run(self, job_id: str, upload_path: Path, options: LocalImportOptions) -> None:
        event = self._cancel_events[job_id]
        with self._lock:
            job = self._jobs[job_id]
            if event.is_set():
                self._finish_cancelled(job)
                upload_path.unlink(missing_ok=True)
                self._upload_paths.pop(job_id, None)
                return
            job.update(status="running", stage="validating", started_at=self._now())

        def progress(stage: str, processed: int, total: int | None) -> None:
            with self._lock:
                current = self._jobs[job_id]
                current.update(
                    stage=stage,
                    processed_rows=processed,
                    total_rows=total,
                )

        try:
            dataset = self.service.import_csv(
                upload_path,
                options,
                progress=progress,
                cancelled=event.is_set,
            )
        except LocalDatasetError as exc:
            with self._lock:
                job = self._jobs[job_id]
                if exc.code == "job_cancelled" or event.is_set():
                    self._finish_cancelled(job)
                else:
                    job.update(
                        status="failed",
                        stage="failed",
                        finished_at=self._now(),
                        error={"code": exc.code, "message": str(exc)},
                    )
        except Exception:
            with self._lock:
                self._jobs[job_id].update(
                    status="failed",
                    stage="failed",
                    finished_at=self._now(),
                    error={
                        "code": "import_internal_error",
                        "message": "Import failed unexpectedly",
                    },
                )
        else:
            with self._lock:
                self._jobs[job_id].update(
                    status="completed",
                    stage="completed",
                    finished_at=self._now(),
                    dataset=dataset,
                    processed_rows=dataset["rows"],
                    total_rows=dataset["rows"],
                )
        finally:
            upload_path.unlink(missing_ok=True)
            with self._lock:
                self._upload_paths.pop(job_id, None)

    def _finish_cancelled(self, job: dict[str, Any]) -> None:
        job.update(
            status="cancelled",
            stage="cancelled",
            finished_at=self._now(),
            error={"code": "job_cancelled", "message": "Import cancelled"},
        )

    def get(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            try:
                return dict(self._jobs[job_id])
            except KeyError as exc:
                raise LocalDatasetError(
                    "Import job not found", code="job_not_found"
                ) from exc

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            jobs = [dict(job) for job in self._jobs.values()]
        return sorted(jobs, key=lambda item: item["created_at"], reverse=True)

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            if job_id not in self._jobs:
                raise LocalDatasetError("Import job not found", code="job_not_found")
            job = self._jobs[job_id]
            if job["status"] in {"completed", "failed", "cancelled"}:
                return dict(job)
            job["cancel_requested"] = True
            job["stage"] = "cancelling"
            self._cancel_events[job_id].set()
            future = self._futures.get(job_id)
            if future is not None and future.cancel():
                self._finish_cancelled(job)
                upload_path = self._upload_paths.pop(job_id, None)
                if upload_path is not None:
                    upload_path.unlink(missing_ok=True)
            return dict(job)

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            for event in self._cancel_events.values():
                event.set()
        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._lock:
            remaining = list(self._upload_paths.values())
            self._upload_paths.clear()
        for path in remaining:
            path.unlink(missing_ok=True)
