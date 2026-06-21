"""CandleScope bridge for the standalone ``pyne_runtime`` package.

The CandleScope backend imports Pyne through ``app.indicator.pyne``.  The
implementation lives in the standalone ``pyne_runtime`` package; this module
only maps CandleScope configuration and keeps the frontend-facing payload shape
stable.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import sys
from typing import Any

_BUNDLED_PYNE_SRC = Path(__file__).resolve().parents[4] / "packages" / "pyne-runtime" / "src"
_OVERRIDE_PYNE_SRC = os.getenv("CANDLESCOPE_PYNE_RUNTIME_SRC")
_PYNE_SRC = (
    Path(_OVERRIDE_PYNE_SRC).resolve()
    if _OVERRIDE_PYNE_SRC
    else _BUNDLED_PYNE_SRC
)
if not _PYNE_SRC.exists():
    raise RuntimeError(f"Pyne runtime source path does not exist: {_PYNE_SRC}")
pyne_src_path = str(_PYNE_SRC)
if pyne_src_path not in sys.path:
    sys.path.insert(0, pyne_src_path)

import pyne_runtime as pn

from app.core import config


def build_external_settings(*, executor_mode: str | None = None) -> Any:
    return pn.PyneSettings(
        security_mode=config.PYNE_SECURITY_MODE,
        executor_mode=executor_mode or config.PYNE_EXECUTOR_MODE,
        timeout_seconds=max(float(config.PYNE_EXEC_TIMEOUT_SECONDS), 0.0),
        process_grace_seconds=max(float(config.PYNE_PROCESS_GRACE_SECONDS), 0.0),
        max_bars=max(int(config.PYNE_MAX_BARS), 1),
        max_output_series=max(int(config.PYNE_MAX_OUTPUT_SERIES), 1),
        max_output_points=max(int(config.PYNE_MAX_OUTPUT_POINTS), 1),
        cache_max_items=max(int(config.PYNE_CACHE_MAX_ITEMS), 1),
        allowed_imports=tuple(config.PYNE_ALLOWED_IMPORTS),
    )


def normalize_external_result(result: Any) -> Any:
    """Normalize standalone Pyne output to CandleScope's payload shape."""
    for line in getattr(result, "lines", []) or []:
        if line.get("type") != "histogram":
            continue
        default_color = line.get("color")
        for point in line.get("data") or []:
            if point.get("color") == default_color:
                point.pop("color", None)
    return result


class CandleScopePyneRuntime:
    """CandleScope-facing wrapper around ``pyne_runtime.PyneRuntime``."""

    def __init__(self) -> None:
        self._settings = build_external_settings()

    def execute(
        self,
        script: str,
        ohlcv: list[dict[str, Any]],
        params: dict[str, Any] | None = None,
        security_mode: str | None = None,
    ) -> Any:
        result = pn.PyneRuntime(settings=self._settings).execute(
            script=script,
            ohlcv=ohlcv,
            params=params or {},
            security_mode=security_mode,
        )
        return normalize_external_result(result)


def execute_pyne_script(
    *,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    security_mode: str | None = None,
    executor_mode: str | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    result = pn.execute_pyne_script(
        script=script,
        ohlcv=ohlcv,
        params=params or {},
        security_mode=security_mode,
        executor_mode=executor_mode or config.PYNE_EXECUTOR_MODE,
        timeout_seconds=timeout_seconds,
        settings=build_external_settings(executor_mode=executor_mode),
    )
    return normalize_external_result(result)


def execute_pyne_script_in_process(
    *,
    script: str,
    ohlcv: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    security_mode: str | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    result = pn.execute_pyne_script_in_process(
        script=script,
        ohlcv=ohlcv,
        params=params or {},
        security_mode=security_mode,
        timeout_seconds=timeout_seconds,
        settings=build_external_settings(executor_mode="process"),
    )
    return normalize_external_result(result)


def cache_stats() -> dict[str, Any]:
    stats = pn.pyne_cache.stats()
    return dict(stats) if isinstance(stats, dict) else {}


@dataclass(frozen=True)
class RuntimeBackendSnapshot:
    package: str
    active: str
    version: str | None
    source_path: str

    @classmethod
    def current(cls) -> "RuntimeBackendSnapshot":
        return cls(
            package="pyne_runtime",
            active="external",
            version=getattr(pn, "__version__", None),
            source_path=pyne_src_path,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "package": self.package,
            "active": self.active,
            "version": self.version,
            "sourcePath": self.source_path,
        }


PyneRuntime = CandleScopePyneRuntime
PyneResult = pn.PyneResult
PyneIncrementalSession = pn.PyneIncrementalSession
PyneIncrementalSessionManager = pn.PyneIncrementalSessionManager
SharedPyneIncrementalSession = pn.SharedPyneIncrementalSession
is_incremental_pyne_script = pn.is_incremental_pyne_script
pyne_cache = pn.pyne_cache
