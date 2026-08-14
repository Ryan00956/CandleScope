from __future__ import annotations

import threading
import time
from pathlib import Path

from app.local_data import (
    LocalDatasetError,
    LocalDatasetService,
    LocalImportJobManager,
    LocalImportOptions,
)


class _CancellableService(LocalDatasetService):
    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.started = threading.Event()

    def import_csv(self, csv_path, options, *, progress=None, cancelled=None):
        self.started.set()
        if progress is not None:
            progress("parsing", 1_000, None)
        while cancelled is None or not cancelled():
            time.sleep(0.005)
        raise LocalDatasetError("Import cancelled", code="job_cancelled")


def test_background_import_cancellation_is_terminal_and_cleans_upload(
    tmp_path: Path,
) -> None:
    service = _CancellableService(tmp_path / "local-data")
    service.start()
    upload = service.new_upload_path()
    upload.write_text("time,open,high,low,close\n", encoding="utf-8")
    jobs = LocalImportJobManager(service, max_workers=1)
    submitted = jobs.submit(
        upload,
        LocalImportOptions(name="cancel", symbol="BTCUSDT", interval="1m"),
    )
    assert service.started.wait(timeout=2)
    jobs.cancel(submitted["job_id"])
    for _ in range(200):
        current = jobs.get(submitted["job_id"])
        if current["status"] == "cancelled":
            break
        time.sleep(0.005)
    jobs.shutdown()
    assert current["status"] == "cancelled"
    assert current["cancel_requested"] is True
    assert not upload.exists()
