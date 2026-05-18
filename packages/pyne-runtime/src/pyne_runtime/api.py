"""Friendly top-level API for Pyne."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .data import PyneData, coerce_ohlcv
from .errors import classify_security_error, error_detail
from .executor import execute_pyne_script
from .result import PyneResult
from .schema import schema as schema_bundle
from .security import PyneSecurityPolicy, validate_script_security
from .settings import PyneSettings


def run(
    script: str | Path,
    data: Any,
    params: dict[str, Any] | None = None,
    *,
    settings: PyneSettings | None = None,
    security_mode: str | None = None,
    executor_mode: str | None = None,
) -> PyneResult:
    """Run a Pyne script against OHLCV data."""
    script_text = _read_script(script)
    return execute_pyne_script(
        script=script_text,
        ohlcv=coerce_ohlcv(data),
        params=params or {},
        security_mode=security_mode,
        executor_mode=executor_mode,
        settings=settings,
    )


def read_ohlcv(
    path: str | Path,
    *,
    time_unit: str = "s",
    columns: dict[str, str] | None = None,
) -> PyneData:
    return PyneData.from_csv(path, time_unit=time_unit, columns=columns)


def from_pandas(df: Any, **columns: Any) -> PyneData:
    return PyneData.from_pandas(df, **columns)


def validate(script: str | Path, *, settings: PyneSettings | None = None) -> list[dict[str, Any]]:
    """Return diagnostics for syntax/security validation."""
    script_text = _read_script(script)
    diagnostics: list[dict[str, Any]] = []
    try:
        compile(script_text, "<pyne>", "exec")
    except SyntaxError as exc:
        diagnostics.append(error_detail(
            "PYNE_SYNTAX_ERROR",
            str(exc.msg or exc),
            line=exc.lineno,
            column=exc.offset,
        ))
        return diagnostics

    policy = PyneSecurityPolicy.from_settings(settings or PyneSettings.from_env())
    try:
        validate_script_security(script_text, policy)
    except Exception as exc:
        code = classify_security_error(str(exc))
        diagnostics.append(error_detail(code, str(exc)))
    return diagnostics


def schema() -> dict[str, Any]:
    return schema_bundle()


def _read_script(script: str | Path) -> str:
    if isinstance(script, Path):
        return script.read_text(encoding="utf-8")
    if isinstance(script, str):
        path = Path(script)
        if "\n" not in script and path.exists():
            return path.read_text(encoding="utf-8")
        return script
    raise TypeError("script must be a string or path")
