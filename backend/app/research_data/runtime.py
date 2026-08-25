"""Shared research-data lifecycle: one writable local-data owner."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.backtest.runtime import BacktestRuntime
from app.core.config import BacktestSettings
from app.local_data.runtime import LocalDataRuntime, LocalOfflineBoundary
from app.local_data.service import LocalDatasetService


class ResearchDataRuntime:
    """Owns LocalDataRuntime and optionally injects it into BacktestRuntime."""

    def __init__(
        self,
        *,
        local_data: LocalDataRuntime,
        backtest: BacktestRuntime | None = None,
        boundary: LocalOfflineBoundary | None = None,
    ) -> None:
        self.local_data = local_data
        self.backtest = backtest
        self.boundary = boundary
        self._shutdown = False

    @property
    def service(self) -> LocalDatasetService:
        return self.local_data.service

    @classmethod
    def start(
        cls,
        root: Path,
        *,
        backtest_settings: BacktestSettings | None = None,
        trade_archive_dir: Path | None = None,
        install_offline_boundary: bool = False,
    ) -> ResearchDataRuntime:
        local_data = LocalDataRuntime(root)
        backtest: BacktestRuntime | None = None
        boundary: LocalOfflineBoundary | None = None
        try:
            local_data.start()
            if backtest_settings is not None and backtest_settings.enabled:
                backtest = BacktestRuntime.start(
                    backtest_settings,
                    local_data_service=local_data.service,
                    trade_archive_dir=trade_archive_dir,
                )
            if install_offline_boundary:
                boundary = LocalOfflineBoundary()
                boundary.install()
        except BaseException:
            if backtest is not None:
                backtest.shutdown()
            local_data.shutdown()
            if boundary is not None:
                boundary.uninstall()
            raise
        return cls(local_data=local_data, backtest=backtest, boundary=boundary)

    def writable_owners(self) -> list[LocalDatasetService]:
        owners = [self.local_data.service]
        if self.backtest is not None:
            owners.append(self.backtest.local_data)
            owners.append(self.backtest.worker.local_data)
        return owners

    def unique_writable_owner(self) -> LocalDatasetService:
        owners = self.writable_owners()
        first = owners[0]
        if any(owner is not first for owner in owners[1:]):
            raise RuntimeError("multiple writable LocalDatasetService owners")
        return first

    def shutdown(self) -> None:
        if self._shutdown:
            return
        self._shutdown = True
        if self.backtest is not None:
            self.backtest.shutdown()
        self.local_data.shutdown()
        if self.boundary is not None:
            self.boundary.uninstall()

    def diagnostics(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "local_data": self.local_data.service.diagnostics(),
            "writable_owner_id": id(self.unique_writable_owner()),
        }
        if self.boundary is not None:
            payload["network"] = self.boundary.snapshot()
        return payload
