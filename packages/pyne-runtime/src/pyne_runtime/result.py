"""Pyne execution result model."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .errors import error_detail, error_hint
from .schema import PYNE_OUTPUT_SCHEMA_VERSION


@dataclass
class PyneResult:
    """Result of a Pyne script execution."""

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
    schema_version: int = PYNE_OUTPUT_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "ok": self.ok,
            "error": self.error,
            "code": self.code,
            "line": self.line,
            "column": self.column,
            "hint": self.hint,
            "errorDetail": self.error_detail,
            "lines": self.lines,
            "output": self.output,
            "param_schema": self.param_schema,
            "meta": self.meta,
        }

    def to_json(self, *, indent: int | None = None) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent)

    def to_frame(self) -> Any:
        try:
            import pandas as pd
        except ImportError as exc:  # pragma: no cover - depends on optional env
            raise ImportError(
                "Pandas support requires the optional dependency: "
                "pip install pyne-runtime[pandas]"
            ) from exc

        rows: dict[int, dict[str, Any]] = {}
        for line in self.lines:
            name = line.get("name") or line.get("title") or line.get("id") or "value"
            for point in line.get("data") or []:
                timestamp = point.get("time")
                if timestamp is None:
                    continue
                row = rows.setdefault(timestamp, {"time": timestamp})
                row[str(name)] = point.get("value")
        return pd.DataFrame(rows.values()).sort_values("time").reset_index(drop=True)

    def plot(self) -> Any:
        try:
            import matplotlib.pyplot as plt
        except ImportError as exc:  # pragma: no cover - depends on optional env
            raise ImportError(
                "Plot support requires the optional dependency: "
                "pip install pyne-runtime[plot]"
            ) from exc

        for line in self.lines:
            data = line.get("data") or []
            if not data:
                continue
            x = [point.get("time") for point in data]
            y = [point.get("value") for point in data]
            plt.plot(x, y, label=line.get("name") or line.get("id"))
        if self.lines:
            plt.legend()
        return plt.gca()

    def __repr__(self) -> str:
        if self.ok:
            title = self.meta.get("title") or self.meta.get("name") or ""
            title_part = f', title="{title}"' if title else ""
            return (
                f"PyneResult(ok=True, series={len(self.lines)}, "
                f"outputs={len(self.output)}{title_part})"
            )
        return f'PyneResult(ok=False, code="{self.code}", error="{self.error}")'

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PyneResult":
        return cls(
            ok=bool(data.get("ok")),
            error=data.get("error"),
            code=data.get("code"),
            line=data.get("line"),
            column=data.get("column"),
            hint=data.get("hint") or error_hint(str(data.get("code") or "")),
            lines=data.get("lines") if isinstance(data.get("lines"), list) else [],
            output=data.get("output") if isinstance(data.get("output"), dict) else {},
            param_schema=data.get("param_schema") if isinstance(data.get("param_schema"), list) else [],
            meta=data.get("meta") if isinstance(data.get("meta"), dict) else {},
            schema_version=int(data.get("schemaVersion") or PYNE_OUTPUT_SCHEMA_VERSION),
        )

    @property
    def error_detail(self) -> dict[str, Any] | None:
        if self.ok or not self.code or not self.error:
            return None
        return error_detail(
            self.code,
            self.error,
            line=self.line,
            column=self.column,
            hint=self.hint,
        )
