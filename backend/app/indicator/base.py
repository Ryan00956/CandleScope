"""
Indicator Base — abstract base class for all indicators.

Every indicator (built-in or user-defined) must implement this protocol.
The engine calls these methods in a well-defined lifecycle:

  1. ``init(bars)``         — first-time full computation from historical bars
  2. ``update_partial(bar)`` — current bar is still forming (tick update)
  3. ``update_closed(bar)``  — bar has closed, advance state permanently
  4. ``recompute(bars)``     — re-run from scratch (after backfill/correction)

The base class provides sensible defaults and utility methods so that
concrete indicators only need to implement the core math.
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections import deque
from typing import Any

from app.data_engine.data_manager.models import BarData

from .types import (
    IndicatorKey,
    IndicatorMeta,
    IndicatorOutput,
    IndicatorParam,
    IndicatorResult,
    IndicatorSpec,
    OutputPoint,
    PaneType,
    SeriesType,
)


class Indicator(ABC):
    """Abstract base class for all indicators.

    Subclasses must implement:
      * ``init(bars)``          — bulk compute from historical data
      * ``update_partial(bar)`` — preview update for forming bar
      * ``update_closed(bar)``  — finalize update when bar closes

    Optional overrides:
      * ``recompute(bars)``     — defaults to calling ``reset()`` + ``init()``
      * ``get_spec()``          — returns the indicator specification

    Attributes:
        name:           Indicator type name (e.g. "MA", "MACD")
        version:        Indicator version string
        input_specs:    Required input fields from BarData (e.g. ["close"])
        output_specs:   Names of output series (e.g. ["ma"] or ["dif", "dea", "hist"])
        warmup_period:  Bars needed before outputs are valid
    """

    # ── Class-level metadata (override in subclasses) ────────
    name: str = "UNKNOWN"
    version: str = "1.0"
    input_specs: list[str] = ["close"]
    output_specs: list[str] = ["value"]
    warmup_period: int = 0

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        self.params: dict[str, Any] = params or {}
        self._initialized: bool = False
        self._bar_count: int = 0
        # Outputs: name → list of OutputPoint
        self._outputs: dict[str, list[OutputPoint]] = {
            name: [] for name in self.output_specs
        }
        # Preview values (for partial bar updates, not committed)
        self._preview: dict[str, float | None] = {
            name: None for name in self.output_specs
        }

    # ═══════════════════════════════════════════════════════════
    #  Lifecycle — must implement
    # ═══════════════════════════════════════════════════════════

    @abstractmethod
    def init(self, bars: list[BarData]) -> None:
        """Initialize with historical bars — full computation.

        After this call, all outputs should be populated with
        historical values (including None for warmup period).

        Args:
            bars: Historical bars sorted by time ascending.
        """
        ...

    @abstractmethod
    def update_partial(self, bar: BarData) -> None:
        """Update preview values for a forming (unclosed) bar.

        This is called on every tick while the current bar is still open.
        The indicator should compute temporary values WITHOUT advancing
        its internal state.  Results go into ``self._preview``.

        Args:
            bar: The current forming bar (OHLCV may change).
        """
        ...

    @abstractmethod
    def update_closed(self, bar: BarData) -> None:
        """Finalize computation for a closed bar.

        The bar is confirmed — advance internal state permanently
        and append the new values to ``self._outputs``.

        Args:
            bar: The finalized closed bar.
        """
        ...

    # ═══════════════════════════════════════════════════════════
    #  Optional overrides
    # ═══════════════════════════════════════════════════════════

    def recompute(self, bars: list[BarData]) -> None:
        """Re-run computation from scratch.

        Called when historical data is corrected or backfilled.
        Default implementation resets state and re-inits.
        """
        self.reset()
        self.init(bars)

    def reset(self) -> None:
        """Reset all internal state to initial (pre-init) condition.

        Automatically calls ``_reset_state()`` if the subclass defines it,
        ensuring custom internal state (rolling windows, accumulators, etc.)
        is also properly cleared.
        """
        self._initialized = False
        self._bar_count = 0
        self._outputs = {name: [] for name in self.output_specs}
        self._preview = {name: None for name in self.output_specs}
        # Reset subclass-specific state if available
        if hasattr(self, "_reset_state") and callable(self._reset_state):
            self._reset_state()

    # ═══════════════════════════════════════════════════════════
    #  Output Access
    # ═══════════════════════════════════════════════════════════

    def get_latest(self) -> dict[str, float | None]:
        """Return the latest committed value for each output.

        Returns:
            Dict mapping output name → latest value (or None).
        """
        result = {}
        for name, points in self._outputs.items():
            if points:
                result[name] = points[-1].value
            else:
                result[name] = None
        return result

    def get_preview(self) -> dict[str, float | None]:
        """Return the current preview values (for forming bar).

        Returns:
            Dict mapping output name → preview value (or None).
        """
        return dict(self._preview)

    def get_series(self, output_name: str | None = None, limit: int = -1) -> dict[str, list[OutputPoint]]:
        """Return historical output series.

        Args:
            output_name: Specific output to return.  None = all.
            limit:       Max points to return (-1 = all).

        Returns:
            Dict mapping output name → list of OutputPoint.
        """
        if output_name is not None:
            points = self._outputs.get(output_name, [])
            if limit > 0:
                points = points[-limit:]
            return {output_name: points}

        result = {}
        for name, points in self._outputs.items():
            if limit > 0:
                result[name] = points[-limit:]
            else:
                result[name] = list(points)
        return result

    def get_meta(self) -> IndicatorMeta:
        """Return indicator metadata.  Override for custom metadata."""
        return IndicatorMeta(
            name=self.name,
            warmup_period=self.warmup_period,
        )

    # ═══════════════════════════════════════════════════════════
    #  Result Building
    # ═══════════════════════════════════════════════════════════

    def build_result(self, key: IndicatorKey) -> IndicatorResult:
        """Build a complete IndicatorResult for this instance.

        Called by the engine to package indicator output for consumers.
        """
        meta = self.get_meta()
        outputs = {}
        output_configs = self._get_output_configs()

        for name, points in self._outputs.items():
            cfg = output_configs.get(name, {})
            outputs[name] = IndicatorOutput(
                name=name,
                display_name=cfg.get("display_name", name),
                series_type=cfg.get("series_type", SeriesType.LINE),
                pane=cfg.get("pane", meta.pane),
                color=cfg.get("color", "#f59e0b"),
                line_width=cfg.get("line_width", 2),
                line_style=cfg.get("line_style", 0),
                data=list(points),
                color_data=cfg.get("color_data"),
            )

        return IndicatorResult(key=key, meta=meta, outputs=outputs)

    def _get_output_configs(self) -> dict[str, dict]:
        """Return per-output rendering config.

        Override in subclasses to specify colors, pane, series_type
        for each output.

        Returns:
            Dict mapping output name → config dict with keys:
              display_name, series_type, pane, color, line_width, line_style
        """
        return {}

    # ═══════════════════════════════════════════════════════════
    #  Spec (for registry)
    # ═══════════════════════════════════════════════════════════

    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        """Return the full indicator specification.

        Override in subclasses to provide param_schema, descriptions, etc.
        """
        return IndicatorSpec(
            name=cls.name,
            input_specs=cls.input_specs,
            output_specs=cls.output_specs,
            is_builtin=True,
        )

    # ═══════════════════════════════════════════════════════════
    #  Utility helpers for subclasses
    # ═══════════════════════════════════════════════════════════

    @staticmethod
    def _get_field(bar: BarData, field: str) -> float:
        """Extract a named field from a BarData object.

        Supports: open, high, low, close, volume, hl2, hlc3, ohlc4, hlcc4
        """
        if field == "open":
            return bar.open
        elif field == "high":
            return bar.high
        elif field == "low":
            return bar.low
        elif field == "close":
            return bar.close
        elif field == "volume":
            return bar.volume
        elif field == "hl2":
            return (bar.high + bar.low) / 2
        elif field == "hlc3":
            return (bar.high + bar.low + bar.close) / 3
        elif field == "ohlc4":
            return (bar.open + bar.high + bar.low + bar.close) / 4
        elif field == "hlcc4":
            return (bar.high + bar.low + bar.close + bar.close) / 4
        else:
            raise ValueError(f"Unknown bar field: {field}")

    def _append_output(self, name: str, ts: int, value: float | None) -> None:
        """Append a data point to a named output series.

        Args:
            name: Output series name.
            ts:   Bar timestamp (Unix seconds, i.e. ``BarData.time``).
            value: Indicator value (or None during warmup).
        """
        self._outputs[name].append(OutputPoint(timestamp=ts, value=value))

    def _update_last_output(self, name: str, ts: int, value: float | None) -> None:
        """Update the last data point (or append if empty/different timestamp)."""
        points = self._outputs[name]
        if points and points[-1].timestamp == ts:
            points[-1] = OutputPoint(timestamp=ts, value=value)
        else:
            points.append(OutputPoint(timestamp=ts, value=value))

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    @property
    def bar_count(self) -> int:
        return self._bar_count
