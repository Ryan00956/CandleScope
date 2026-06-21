"""Runtime settings for standalone Pyne execution."""
from __future__ import annotations

import os
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from .metadata import normalize_session_info, normalize_symbol_info, normalize_timeframe_info

if TYPE_CHECKING:
    from .request.provider import DataProvider


SECURITY_MODES = {"safe", "research", "unsafe"}
EXECUTOR_MODES = {"inline", "process"}
DEFAULT_ALLOWED_IMPORTS = ("numpy", "pandas", "scipy", "sklearn", "torch")


@dataclass(frozen=True)
class PyneSettings:
    """Configuration for a Pyne runtime or executor."""

    security_mode: str = "safe"
    executor_mode: str = "process"
    timeout_seconds: float = 5.0
    process_grace_seconds: float = 0.5
    max_bars: int = 50_000
    max_output_series: int = 20
    max_output_points: int = 1_000_000
    max_drawing_objects: int = 500
    max_array_size: int = 100_000
    max_map_size: int = 100_000
    max_matrix_cells: int = 100_000
    max_collection_depth: int = 8
    cache_max_items: int = 32
    allowed_imports: tuple[str, ...] = DEFAULT_ALLOWED_IMPORTS
    data_provider: DataProvider | None = None
    syminfo: Any = None
    timeframe: Any = "1"
    session: Any = None

    def __post_init__(self) -> None:
        security_mode = normalize_security_mode(self.security_mode)
        executor_mode = normalize_executor_mode(self.executor_mode)
        object.__setattr__(self, "security_mode", security_mode)
        object.__setattr__(self, "executor_mode", executor_mode)
        object.__setattr__(self, "timeout_seconds", max(float(self.timeout_seconds), 0.0))
        object.__setattr__(
            self,
            "process_grace_seconds",
            max(float(self.process_grace_seconds), 0.0),
        )
        object.__setattr__(self, "max_bars", max(int(self.max_bars), 1))
        object.__setattr__(self, "max_output_series", max(int(self.max_output_series), 1))
        object.__setattr__(self, "max_output_points", max(int(self.max_output_points), 1))
        object.__setattr__(self, "max_drawing_objects", max(int(self.max_drawing_objects), 1))
        object.__setattr__(self, "max_array_size", max(int(self.max_array_size), 1))
        object.__setattr__(self, "max_map_size", max(int(self.max_map_size), 1))
        object.__setattr__(self, "max_matrix_cells", max(int(self.max_matrix_cells), 1))
        object.__setattr__(self, "max_collection_depth", max(int(self.max_collection_depth), 1))
        object.__setattr__(self, "cache_max_items", max(int(self.cache_max_items), 1))
        object.__setattr__(
            self,
            "allowed_imports",
            tuple(str(item).strip() for item in self.allowed_imports if str(item).strip()),
        )
        object.__setattr__(self, "syminfo", normalize_symbol_info(self.syminfo))
        object.__setattr__(self, "timeframe", normalize_timeframe_info(self.timeframe))
        object.__setattr__(self, "session", normalize_session_info(self.session))

    @classmethod
    def from_env(cls) -> "PyneSettings":
        """Build settings from PYNE_* environment variables."""
        allowed_imports = tuple(
            item.strip()
            for item in os.getenv("PYNE_ALLOWED_IMPORTS", ",".join(DEFAULT_ALLOWED_IMPORTS)).split(",")
            if item.strip()
        )
        return cls(
            security_mode=os.getenv("PYNE_SECURITY_MODE", "safe"),
            executor_mode=os.getenv("PYNE_EXECUTOR_MODE", "process"),
            timeout_seconds=_float_env("PYNE_EXEC_TIMEOUT_SECONDS", 5.0),
            process_grace_seconds=_float_env("PYNE_PROCESS_GRACE_SECONDS", 0.5),
            max_bars=_int_env("PYNE_MAX_BARS", 50_000),
            max_output_series=_int_env("PYNE_MAX_OUTPUT_SERIES", 20),
            max_output_points=_int_env("PYNE_MAX_OUTPUT_POINTS", 1_000_000),
            max_drawing_objects=_int_env("PYNE_MAX_DRAWING_OBJECTS", 500),
            max_array_size=_int_env("PYNE_MAX_ARRAY_SIZE", 100_000),
            max_map_size=_int_env("PYNE_MAX_MAP_SIZE", 100_000),
            max_matrix_cells=_int_env("PYNE_MAX_MATRIX_CELLS", 100_000),
            max_collection_depth=_int_env("PYNE_MAX_COLLECTION_DEPTH", 8),
            cache_max_items=_int_env("PYNE_CACHE_MAX_ITEMS", 32),
            allowed_imports=allowed_imports,
            syminfo={
                "tickerid": os.getenv("PYNE_TICKERID", ""),
                "ticker": os.getenv("PYNE_TICKER", ""),
                "prefix": os.getenv("PYNE_SYMBOL_PREFIX", ""),
                "currency": os.getenv("PYNE_CURRENCY", ""),
                "basecurrency": os.getenv("PYNE_BASE_CURRENCY", ""),
                "mintick": _float_env("PYNE_MINTICK", 1.0),
                "pointvalue": _float_env("PYNE_POINTVALUE", 1.0),
                "type": os.getenv("PYNE_SYMBOL_TYPE", ""),
            },
            timeframe=os.getenv("PYNE_TIMEFRAME", "1"),
        )

    def with_security_mode(self, security_mode: str | None) -> "PyneSettings":
        """Return a copy with a requested security mode override."""
        if security_mode is None:
            return self
        return replace(self, security_mode=security_mode)


def normalize_security_mode(mode: str | None) -> str:
    normalized = (mode or "safe").strip().lower()
    if normalized not in SECURITY_MODES:
        raise ValueError("security_mode must be 'safe', 'research', or 'unsafe'")
    return normalized


def normalize_executor_mode(mode: str | None) -> str:
    normalized = (mode or "process").strip().lower()
    if normalized not in EXECUTOR_MODES:
        return "process"
    return normalized


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default

