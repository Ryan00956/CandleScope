"""Runtime settings for standalone Pyne execution."""
from __future__ import annotations

import os
from dataclasses import dataclass


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
    cache_max_items: int = 32
    allowed_imports: tuple[str, ...] = DEFAULT_ALLOWED_IMPORTS

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
        object.__setattr__(self, "cache_max_items", max(int(self.cache_max_items), 1))
        object.__setattr__(
            self,
            "allowed_imports",
            tuple(str(item).strip() for item in self.allowed_imports if str(item).strip()),
        )

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
            cache_max_items=_int_env("PYNE_CACHE_MAX_ITEMS", 32),
            allowed_imports=allowed_imports,
        )

    def with_security_mode(self, security_mode: str | None) -> "PyneSettings":
        """Return a copy with a requested security mode override."""
        if security_mode is None:
            return self
        return PyneSettings(
            security_mode=security_mode,
            executor_mode=self.executor_mode,
            timeout_seconds=self.timeout_seconds,
            process_grace_seconds=self.process_grace_seconds,
            max_bars=self.max_bars,
            max_output_series=self.max_output_series,
            max_output_points=self.max_output_points,
            cache_max_items=self.cache_max_items,
            allowed_imports=self.allowed_imports,
        )


def normalize_security_mode(mode: str | None) -> str:
    normalized = (mode or "safe").strip().lower()
    if normalized not in SECURITY_MODES:
        return "safe"
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

