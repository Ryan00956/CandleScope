"""Incremental runtime result model."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class IncrementalPyneResult:
    ok: bool = True
    error: str | None = None
    code: str | None = None
    line: int | None = None
    column: int | None = None
    hint: str | None = None
    lines: list[dict[str, Any]] = field(default_factory=list)
    output: dict[str, Any] = field(default_factory=dict)
    param_schema: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)
