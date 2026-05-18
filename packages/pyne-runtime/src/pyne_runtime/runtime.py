"""
Pyne Runtime — script execution engine.

The runtime is responsible for:
  1. Building the data context (OHLCV arrays + derived fields)
  2. Constructing the execution namespace (ta, input, plot, color, etc.)
  3. Executing the user script
  4. Collecting and returning all outputs (lines, markers, fills, etc.)

Usage::

    runtime = PyneRuntime()
    result = runtime.execute(script_code, ohlcv_data, user_params)
    # result.lines  → list of line dicts for frontend
    # result.output → full structured output (histograms, markers, etc.)
    # result.param_schema → collected parameter schemas for UI
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .context import PyneContext
from .ta import TaModule
from .input import InputModule
from .color import color as color_singleton
from .cache import pyne as pyne_cache_namespace
from .math_ext import pyne_math
from .plot import OutputCollector, create_plot_functions
from .incremental import IncrementalPyneResult, PyneIncrementalSession, is_incremental_pyne_script
from . import utils
from .cache import pyne_cache
from .errors import error_detail
from .security import (
    PyneSecurityError,
    PyneSecurityPolicy,
    PyneTimeoutError,
    build_builtins,
    enforce_output_limits,
    execution_timeout,
    validate_script_security,
)
from .settings import PyneSettings


@dataclass
class PyneResult:
    """Result of a Pyne script execution.

    Attributes:
        ok:           Whether execution succeeded.
        error:        Error message if failed.
        lines:        Flat list of line dicts (backward compatible with frontend).
        output:       Full structured output (lines, histograms, markers, etc.).
        param_schema: Collected parameter schemas for dynamic UI generation.
        meta:         Indicator metadata from ``indicator()`` call.
    """
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

    def to_dict(self) -> dict[str, Any]:
        return {
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
            hint=data.get("hint"),
            lines=data.get("lines") if isinstance(data.get("lines"), list) else [],
            output=data.get("output") if isinstance(data.get("output"), dict) else {},
            param_schema=data.get("param_schema") if isinstance(data.get("param_schema"), list) else [],
            meta=data.get("meta") if isinstance(data.get("meta"), dict) else {},
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


class PyneRuntime:
    """Pyne script execution engine.

    Stateless — each ``execute()`` call creates fresh context objects.
    Can be reused across multiple executions safely.
    """

    def __init__(self, settings: PyneSettings | None = None) -> None:
        self.settings = settings or PyneSettings.from_env()
        pyne_cache.configure(max_items=self.settings.cache_max_items)

    def execute(
        self,
        script: str,
        ohlcv: list[dict[str, Any]],
        params: dict[str, Any] | None = None,
        security_mode: str | None = None,
    ) -> PyneResult:
        """Execute a Pyne/Python indicator script.

        Args:
            script: The Python script code.
            ohlcv: List of OHLCV bar dicts (time, open, high, low, close, volume).
            params: User-provided parameter overrides.

        Returns:
            PyneResult with all computed outputs.
        """
        if not ohlcv:
            return PyneResult(
                ok=False,
                code="INVALID_OHLCV",
                error="No OHLCV data provided",
                hint="请确认当前图表已经加载 K 线数据。",
            )

        params = params or {}

        try:
            policy = PyneSecurityPolicy.from_settings(self.settings, security_mode)

            if len(ohlcv) > policy.max_bars:
                return PyneResult(
                    ok=False,
                    code="INVALID_OHLCV",
                    error=f"Too many data points (max {policy.max_bars})",
                    hint="缩小历史窗口，或调大 PYNE_MAX_BARS 配置。",
                )

            validate_script_security(script, policy)

            if is_incremental_pyne_script(script):
                incremental = PyneIncrementalSession(
                    script=script,
                    params=params,
                    policy=policy,
                )
                result = self._collect_incremental_result(incremental.seed(ohlcv))
                result.meta = {**result.meta, "securityMode": policy.mode}
                enforce_output_limits(result.output, policy)
                return result

            # 1. Build data context
            ctx = PyneContext.from_ohlcv(ohlcv)

            # 2. Create module instances bound to this context
            ta = TaModule(ctx)
            input_mod = InputModule(params=params, context=ctx)
            collector = OutputCollector(times=ctx.time)
            plot_funcs = create_plot_functions(collector)

            # 3. Build script execution namespace
            script_globals = self._build_namespace(
                ctx=ctx,
                ta=ta,
                input_mod=input_mod,
                plot_funcs=plot_funcs,
                params=params,
                policy=policy,
            )

            # 4. Execute
            with execution_timeout(policy.timeout_seconds):
                exec(script, script_globals)  # noqa: S102

            # 5. Collect outputs
            result = self._collect_result(collector, input_mod)
            enforce_output_limits(result.output, policy)
            result.meta = {**result.meta, "securityMode": policy.mode}
            return result

        except SyntaxError as exc:
            return PyneResult(
                ok=False,
                code="PYNE_SYNTAX_ERROR",
                error=str(exc.msg or exc),
                line=exc.lineno,
                column=exc.offset,
                hint="这是 Python/Pyne 语法错误，请检查报错行附近的括号、缩进、逗号或赋值写法。",
            )

        except PyneTimeoutError as exc:
            return PyneResult(
                ok=False,
                code="PYNE_TIMEOUT",
                error=str(exc),
                hint="脚本执行超时。请减少循环、缩小窗口，或在确认风险后调高超时时间。",
            )
        except PyneSecurityError as exc:
            message = str(exc)
            if "output series" in message or "output points" in message:
                code = "PYNE_OUTPUT_LIMIT_EXCEEDED"
                hint = "脚本输出过多。请减少 plot/marker 数量，或降低单次输出点数。"
            elif "Import" in message or "import" in message:
                code = "PYNE_IMPORT_BLOCKED"
                hint = "当前安全模式不允许该 import。可切换 research/unsafe，或配置 PYNE_ALLOWED_IMPORTS。"
            else:
                code = "PYNE_SECURITY_ERROR"
                hint = "当前 Pyne 安全策略拒绝执行该脚本。"
            return PyneResult(ok=False, code=code, error=message, hint=hint)
        except Exception as exc:
            error_msg = f"Script error: {exc}"
            return PyneResult(
                ok=False,
                code="PYNE_RUNTIME_ERROR",
                error=error_msg,
                hint="脚本运行时失败。请检查变量名、函数参数，以及数组长度是否一致。",
            )

    def _collect_incremental_result(self, result: IncrementalPyneResult) -> PyneResult:
        return PyneResult(
            ok=result.ok,
            error=result.error,
            code=result.code,
            line=result.line,
            column=result.column,
            hint=result.hint,
            lines=result.lines,
            output=result.output,
            param_schema=result.param_schema,
            meta=result.meta,
        )

    def _build_namespace(
        self,
        ctx: PyneContext,
        ta: TaModule,
        input_mod: InputModule,
        plot_funcs: dict[str, Any],
        params: dict[str, Any],
        policy: PyneSecurityPolicy,
    ) -> dict[str, Any]:
        """Build the global namespace injected into user scripts.

        This is where all the magic happens — every Pine-style API
        becomes a Python variable/function available without imports.
        """
        ns: dict[str, Any] = {}

        # ── Layer 1: Data context (OHLCV arrays) ────────────
        ns["open"] = ctx.open
        ns["high"] = ctx.high
        ns["low"] = ctx.low
        ns["close"] = ctx.close
        ns["volume"] = ctx.volume
        ns["time"] = ctx.time
        ns["bar_count"] = ctx.bar_count

        # Derived sources
        ns["hl2"] = ctx.hl2
        ns["hlc3"] = ctx.hlc3
        ns["ohlc4"] = ctx.ohlc4
        ns["hlcc4"] = ctx.hlcc4

        # ── Layer 2: Pyne API (Pine-style) ───────────────────
        # ta.* — technical analysis functions
        ns["ta"] = ta

        # input.* — parameter declaration
        ns["input"] = input_mod

        # Drawing functions
        ns.update(plot_funcs)  # plot, hline, fill, bar, marker, etc.

        # color.* — color constants and helpers
        ns["color"] = color_singleton

        # math.* — array-aware math (overrides Python's math)
        ns["math"] = pyne_math

        # pyne.* — local helper namespace for cache and future runtime helpers.
        ns["pyne"] = pyne_cache_namespace
        ns["cache"] = pyne_cache_namespace.cache
        ns["cache_clear"] = pyne_cache_namespace.cache_clear
        ns["cache_stats"] = pyne_cache_namespace.cache_stats

        # ── Layer 2.5: Utility functions (global access) ─────
        # These are also available via ta.* but exposed at top level
        # for convenience, matching Pine's global functions
        ns["crossover"] = utils.crossover
        ns["crossunder"] = utils.crossunder
        ns["iff"] = lambda cond, a, b: np.where(cond, a, b)
        ns["where"] = ns["iff"]
        ns["ref"] = utils.shift
        ns["highest"] = utils.highest
        ns["lowest"] = utils.lowest
        ns["change"] = utils.change
        ns["roc"] = utils.roc
        ns["barssince"] = utils.barssince
        ns["valuewhen"] = utils.valuewhen
        ns["shift"] = utils.shift
        ns["na"] = utils.na
        ns["nz"] = utils.nz
        ns["na_check"] = utils.na_check
        ns["cum"] = utils.cum
        ns["rising"] = utils.rising
        ns["falling"] = utils.falling

        # Pine-style lowercase constants and common TA aliases. These are
        # ordinary Python names, so they do not require a custom parser.
        ns["true"] = True
        ns["false"] = False
        ns["sma"] = ta.sma
        ns["ema"] = ta.ema
        ns["wma"] = ta.wma
        ns["rma"] = ta.rma
        ns["vwma"] = ta.vwma
        ns["rsi"] = ta.rsi
        ns["macd"] = ta.macd
        ns["atr"] = ta.atr
        ns["bb"] = ta.bb

        # ── Layer 3: Python standard library ─────────────────
        ns["np"] = np
        ns["numpy"] = np

        # ── Legacy compatibility ─────────────────────────────
        ns["params"] = params

        # ── Builtins / imports (policy-controlled) ──────────
        ns["__builtins__"] = build_builtins(policy)

        return ns

    def _collect_result(
        self,
        collector: OutputCollector,
        input_mod: InputModule,
    ) -> PyneResult:
        """Collect all outputs from the execution into a PyneResult."""
        output = collector.to_dict()

        # Build flat lines list for backward compatibility
        # The frontend expects [{name, color, type, pane, data}, ...]
        flat_lines: list[dict[str, Any]] = []

        for line in collector.lines:
            entry: dict[str, Any] = {
                "name": line.get("title", ""),
                "color": line.get("color", "#f59e0b"),
                "type": "line",
                "pane": line.get("pane", "main"),
                "lineWidth": line.get("linewidth", 2),
                "lineStyle": _style_to_int(line.get("style", "solid")),
                "data": line.get("data", []),
            }
            # Include plot id for fill() cross-referencing
            if "id" in line:
                entry["id"] = line["id"]
            # Per-bar color flag
            if line.get("per_bar_color"):
                entry["per_bar_color"] = True
            flat_lines.append(entry)

        for hist in collector.histograms:
            flat_lines.append({
                "name": hist.get("title", ""),
                "color": hist.get("color_up", "#26a69a"),
                "type": "histogram",
                "pane": hist.get("pane", "separate"),
                "lineWidth": 2,
                "lineStyle": 0,
                "data": hist.get("data", []),
            })

        return PyneResult(
            ok=True,
            error=None,
            lines=flat_lines,
            output=output,
            param_schema=input_mod.schema,
            meta=collector.indicator_meta,
        )


def _style_to_int(style: str) -> int:
    """Convert line style string to lightweight-charts integer."""
    if isinstance(style, int):
        return style
    mapping = {
        "solid": 0,
        "line": 0,
        "dashed": 2,
        "dotted": 1,
    }
    return mapping.get(style, 0)
