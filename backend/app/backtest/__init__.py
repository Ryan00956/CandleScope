"""Host-owned backtest control plane. Disabled unless BACKTEST_ENABLED=1."""

from typing import Any

__all__ = [
    "BacktestError",
    "BacktestRun",
    "BacktestService",
    "BacktestStudy",
    "RunState",
]


def __getattr__(name: str) -> Any:
    if name == "BacktestError":
        from .errors import BacktestError

        return BacktestError
    if name == "BacktestRun":
        from .models import BacktestRun

        return BacktestRun
    if name == "BacktestStudy":
        from .models import BacktestStudy

        return BacktestStudy
    if name == "RunState":
        from .models import RunState

        return RunState
    if name == "BacktestService":
        from .service import BacktestService

        return BacktestService
    raise AttributeError(name)
