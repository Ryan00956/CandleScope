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

import math as _builtin_math
import traceback
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .context import PyneContext
from .ta import TaModule
from .input import InputModule
from .color import Color, color as color_singleton
from .math_ext import PyneMath, pyne_math
from .plot import OutputCollector, create_plot_functions
from . import utils


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
    lines: list[dict[str, Any]] = field(default_factory=list)
    output: dict[str, Any] = field(default_factory=dict)
    param_schema: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "error": self.error,
            "lines": self.lines,
            "output": self.output,
            "param_schema": self.param_schema,
            "meta": self.meta,
        }


class PyneRuntime:
    """Pyne script execution engine.

    Stateless — each ``execute()`` call creates fresh context objects.
    Can be reused across multiple executions safely.
    """

    def __init__(self) -> None:
        pass

    def execute(
        self,
        script: str,
        ohlcv: list[dict[str, Any]],
        params: dict[str, Any] | None = None,
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
            return PyneResult(ok=False, error="No OHLCV data provided")

        if len(ohlcv) > 50_000:
            return PyneResult(ok=False, error="Too many data points (max 50,000)")

        params = params or {}

        try:
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
            )

            # 4. Execute
            exec(script, script_globals)  # noqa: S102

            # 5. Collect outputs
            return self._collect_result(collector, input_mod)

        except Exception as exc:
            tb = traceback.format_exc()
            # Extract the most useful part of the traceback
            error_msg = f"Script error: {exc}"
            return PyneResult(ok=False, error=error_msg)

    def _build_namespace(
        self,
        ctx: PyneContext,
        ta: TaModule,
        input_mod: InputModule,
        plot_funcs: dict[str, Any],
        params: dict[str, Any],
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

        # ── Layer 2.5: Utility functions (global access) ─────
        # These are also available via ta.* but exposed at top level
        # for convenience, matching Pine's global functions
        ns["crossover"] = utils.crossover
        ns["crossunder"] = utils.crossunder
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

        # ── Layer 3: Python standard library ─────────────────
        ns["np"] = np
        ns["numpy"] = np

        # ── Legacy compatibility ─────────────────────────────
        ns["params"] = params

        # ── Allow imports (Layer 4: advanced users) ──────────
        ns["__builtins__"] = __builtins__

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
    mapping = {
        "solid": 0,
        "dashed": 2,
        "dotted": 1,
    }
    return mapping.get(style, 0)
