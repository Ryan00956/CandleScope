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
from .errors import classify_security_error, error_hint
from .result import PyneResult
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
                code="PYNE_INVALID_OHLCV",
                error="No OHLCV data provided",
                hint=error_hint("PYNE_INVALID_OHLCV"),
            )

        params = params or {}

        try:
            policy = PyneSecurityPolicy.from_settings(self.settings, security_mode)

            if len(ohlcv) > policy.max_bars:
                return PyneResult(
                    ok=False,
                    code="PYNE_INVALID_OHLCV",
                    error=f"Too many data points (max {policy.max_bars})",
                    hint="Reduce the history window or increase max_bars for trusted workloads.",
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
                hint=error_hint("PYNE_SYNTAX_ERROR"),
            )

        except PyneTimeoutError as exc:
            return PyneResult(
                ok=False,
                code="PYNE_TIMEOUT",
                error=str(exc),
                hint=error_hint("PYNE_TIMEOUT"),
            )
        except PyneSecurityError as exc:
            message = str(exc)
            code = classify_security_error(message)
            return PyneResult(ok=False, code=code, error=message, hint=error_hint(code))
        except Exception as exc:
            error_msg = f"Script error: {exc}"
            return PyneResult(
                ok=False,
                code="PYNE_RUNTIME_ERROR",
                error=error_msg,
                hint=error_hint("PYNE_RUNTIME_ERROR"),
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
