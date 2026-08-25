from __future__ import annotations

from pathlib import Path

import pytest

from app.backtest.runtime import BacktestRuntime
from app.core.config import load_backtest_settings
from app.local_data.runtime import LocalDataRuntime, LocalOfflineBoundary, LocalOfflineRuntime
from app.local_data.service import LocalDatasetService
from app.research_data.runtime import ResearchDataRuntime


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def test_injected_local_data_service_is_the_only_writable_owner(tmp_path: Path) -> None:
    owner = LocalDataRuntime(tmp_path / "local")
    owner.start()
    runtime = BacktestRuntime.start(_settings(tmp_path), local_data_service=owner.service)
    try:
        assert runtime.local_data is owner.service
        assert runtime.worker.local_data is owner.service
        assert runtime.local_data is runtime.worker.local_data
    finally:
        runtime.shutdown()
        owner.shutdown()


def test_research_runtime_live_and_offline_share_one_writable_owner(tmp_path: Path) -> None:
    live = ResearchDataRuntime.start(
        tmp_path / "live-local",
        backtest_settings=_settings(tmp_path / "live"),
    )
    try:
        assert live.unique_writable_owner() is live.local_data.service
        assert live.backtest is not None
        assert live.backtest.worker.local_data is live.local_data.service
        assert live.boundary is None
    finally:
        live.shutdown()

    offline = ResearchDataRuntime.start(
        tmp_path / "offline-local",
        backtest_settings=_settings(tmp_path / "offline"),
        install_offline_boundary=True,
    )
    try:
        assert offline.unique_writable_owner() is offline.local_data.service
        assert offline.boundary is not None
        assert offline.boundary.network_guard._installed is True
    finally:
        offline.shutdown()
    assert offline.boundary.network_guard._installed is False


def test_shutdown_is_idempotent(tmp_path: Path) -> None:
    runtime = ResearchDataRuntime.start(
        tmp_path / "local",
        backtest_settings=_settings(tmp_path),
        install_offline_boundary=True,
    )
    runtime.shutdown()
    runtime.shutdown()
    assert runtime.backtest is not None
    assert runtime.backtest.worker._threads == []


def test_start_failure_does_not_leave_worker_or_guard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.backtest.runtime import BacktestWorker

    original_start = BacktestWorker.start
    leaked: dict[str, object] = {}

    def exploding_start(self: BacktestWorker) -> None:
        original_start(self)
        leaked["threads"] = list(self._threads)
        raise RuntimeError("forced worker start failure")

    monkeypatch.setattr(BacktestWorker, "start", exploding_start)
    with pytest.raises(RuntimeError, match="forced worker start failure"):
        ResearchDataRuntime.start(
            tmp_path / "local",
            backtest_settings=_settings(tmp_path),
            install_offline_boundary=True,
        )
    assert leaked["threads"]
    assert all(not thread.is_alive() for thread in leaked["threads"])  # type: ignore[union-attr]


def test_offline_facade_still_owns_one_service(tmp_path: Path) -> None:
    runtime = LocalOfflineRuntime(tmp_path / "local")
    runtime.start()
    try:
        assert runtime.data.service is runtime.service
        assert runtime.jobs.service is runtime.service
        assert isinstance(runtime.service, LocalDatasetService)
    finally:
        runtime.shutdown()
        runtime.shutdown()


def test_boundary_uninstall_is_safe_before_install() -> None:
    boundary = LocalOfflineBoundary()
    boundary.uninstall()
    boundary.install()
    boundary.uninstall()
    boundary.uninstall()
