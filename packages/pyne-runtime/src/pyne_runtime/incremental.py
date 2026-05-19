"""Incremental Pyne runtime primitives.

This module supports stateful user scripts that define ``on_bar`` and process
one bar at a time. Batch Pyne remains implemented by ``runtime.py``.
"""
from __future__ import annotations

import ast
import copy
import inspect
import math
import re
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

from .cache import pyne as pyne_cache_namespace
from .color import color as color_singleton
from .math_ext import pyne_math
from .security import (
    PyneSecurityError,
    PyneSecurityPolicy,
    build_builtins,
    execution_timeout,
    validate_script_security,
)
from .settings import PyneSettings

SAFE_MAX_WINDOW_SIZE = 10_000
SAFE_MAX_TOTAL_WINDOW_ITEMS = 50_000
SAFE_MAX_STATE_KEYS = 100


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


@dataclass
class IncrementalBar:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    is_confirmed: bool = True

    @classmethod
    def from_dict(cls, item: dict[str, Any], *, is_confirmed: bool = True) -> "IncrementalBar":
        return cls(
            time=int(item.get("time", 0)),
            open=float(item.get("open", 0)),
            high=float(item.get("high", 0)),
            low=float(item.get("low", 0)),
            close=float(item.get("close", 0)),
            volume=float(item.get("volume", 0)),
            is_confirmed=is_confirmed,
        )


class StateCell:
    """Mutable state value exposed to incremental scripts."""

    def __init__(self, value: Any) -> None:
        self.value = value


class Window:
    """Fixed-size rolling window exposed to incremental scripts."""

    def __init__(self, size: int) -> None:
        self.size = max(int(size), 1)
        self._values: deque[Any] = deque(maxlen=self.size)

    def append(self, value: Any) -> None:
        self._values.append(value)

    @property
    def full(self) -> bool:
        return len(self._values) >= self.size

    def __len__(self) -> int:
        return len(self._values)

    def __iter__(self):
        return iter(self._values)

    def __getitem__(self, index: int) -> Any:
        return list(self._values)[index]

    def values(self) -> list[Any]:
        return list(self._values)


@dataclass
class IncrementalLimits:
    enabled: bool = False
    max_window_size: int = SAFE_MAX_WINDOW_SIZE
    max_total_window_items: int = SAFE_MAX_TOTAL_WINDOW_ITEMS
    max_state_keys: int = SAFE_MAX_STATE_KEYS

    @classmethod
    def for_policy(cls, policy: PyneSecurityPolicy) -> "IncrementalLimits":
        return cls(enabled=policy.mode == "safe")


class _LimitTracker:
    def __init__(self, limits: IncrementalLimits) -> None:
        self.limits = limits
        self.total_window_items = 0

    def reserve_window(self, size: int, *, label: str) -> None:
        if not self.limits.enabled:
            return
        normalized = max(int(size), 1)
        if normalized > self.limits.max_window_size:
            raise PyneSecurityError(
                f"Incremental window '{label}' size {normalized} exceeds safe-mode limit "
                f"{self.limits.max_window_size}"
            )
        next_total = self.total_window_items + normalized
        if next_total > self.limits.max_total_window_items:
            raise PyneSecurityError(
                f"Incremental windows need {next_total} items, exceeding safe-mode total "
                f"limit {self.limits.max_total_window_items}"
            )
        self.total_window_items = next_total


class _StepSMA:
    def __init__(self, period: int) -> None:
        self.period = max(int(period), 1)
        self.window: deque[float] = deque()
        self.sum = 0.0

    def update(self, value: Any) -> float | None:
        if value is None:
            return None
        number = float(value)
        self.window.append(number)
        self.sum += number
        if len(self.window) > self.period:
            self.sum -= self.window.popleft()
        if len(self.window) < self.period:
            return None
        return self.sum / self.period


class _StepEMA:
    def __init__(self, period: int) -> None:
        self.period = max(int(period), 1)
        self.alpha = 2.0 / (self.period + 1)
        self.count = 0
        self.seed_sum = 0.0
        self.ema: float | None = None

    def update(self, value: Any) -> float | None:
        if value is None:
            return self.ema
        number = float(value)
        if self.ema is None:
            self.count += 1
            self.seed_sum += number
            if self.count < self.period:
                return None
            self.ema = self.seed_sum / self.period
            return self.ema
        self.ema = self.alpha * number + (1 - self.alpha) * self.ema
        return self.ema


class _StepBOLL:
    def __init__(self, period: int, multiplier: float = 2.0) -> None:
        self.period = max(int(period), 1)
        self.multiplier = float(multiplier)
        self.window: deque[float] = deque()
        self.sum = 0.0
        self.sumsq = 0.0

    def update(self, value: Any) -> tuple[float | None, float | None, float | None]:
        if value is None:
            return None, None, None
        number = float(value)
        self.window.append(number)
        self.sum += number
        self.sumsq += number * number
        if len(self.window) > self.period:
            removed = self.window.popleft()
            self.sum -= removed
            self.sumsq -= removed * removed
        if len(self.window) < self.period:
            return None, None, None
        mid = self.sum / self.period
        variance = max(self.sumsq / self.period - mid * mid, 0.0)
        std = math.sqrt(variance)
        return mid + self.multiplier * std, mid, mid - self.multiplier * std


class _StepMACD:
    def __init__(self, fast: int = 12, slow: int = 26, signal: int = 9) -> None:
        self.fast = _StepEMA(max(int(fast), 1))
        self.slow = _StepEMA(max(int(slow), 1))
        self.signal = _StepEMA(max(int(signal), 1))

    def update(self, value: Any) -> tuple[float | None, float | None, float | None]:
        fast_value = self.fast.update(value)
        slow_value = self.slow.update(value)
        if fast_value is None or slow_value is None:
            return None, None, None
        dif = fast_value - slow_value
        dea = self.signal.update(dif)
        hist = dif - dea if dea is not None else None
        return dif, dea, hist


class _StepRSI:
    def __init__(self, period: int = 14) -> None:
        self.period = max(int(period), 1)
        self.prev: float | None = None
        self.count = 0
        self.gain_sum = 0.0
        self.loss_sum = 0.0
        self.avg_gain: float | None = None
        self.avg_loss: float | None = None

    def update(self, value: Any) -> float | None:
        if value is None:
            return None
        current = float(value)
        if self.prev is None:
            self.prev = current
            return None
        delta = current - self.prev
        self.prev = current
        gain = max(delta, 0.0)
        loss = max(-delta, 0.0)
        if self.avg_gain is None or self.avg_loss is None:
            self.count += 1
            self.gain_sum += gain
            self.loss_sum += loss
            if self.count < self.period:
                return None
            self.avg_gain = self.gain_sum / self.period
            self.avg_loss = self.loss_sum / self.period
        else:
            self.avg_gain = (self.avg_gain * (self.period - 1) + gain) / self.period
            self.avg_loss = (self.avg_loss * (self.period - 1) + loss) / self.period
        return _rsi_from_avgs(self.avg_gain, self.avg_loss)


class _StepATR:
    def __init__(self, period: int = 14) -> None:
        self.period = max(int(period), 1)
        self.prev_close: float | None = None
        self.count = 0
        self.tr_sum = 0.0
        self.atr: float | None = None

    def update(self, bar_or_high: Any, low: Any = None, close: Any = None) -> float | None:
        if low is None and close is None:
            high = float(getattr(bar_or_high, "high"))
            low = float(getattr(bar_or_high, "low"))
            close = float(getattr(bar_or_high, "close"))
        else:
            high = float(bar_or_high)
            low = float(low)
            close = float(close)

        if self.prev_close is None:
            tr = high - low
        else:
            tr = max(high - low, abs(high - self.prev_close), abs(low - self.prev_close))
        self.prev_close = close

        if self.atr is None:
            self.count += 1
            self.tr_sum += tr
            if self.count < self.period:
                return None
            self.atr = self.tr_sum / self.period
        else:
            self.atr = (self.atr * (self.period - 1) + tr) / self.period
        return self.atr


class _StepMonotonic:
    def __init__(self, period: int, *, highest: bool) -> None:
        self.period = max(int(period), 1)
        self.highest = highest
        self.index = -1
        self.window: deque[tuple[int, float]] = deque()

    def update(self, value: Any) -> float | None:
        if value is None:
            return None
        self.index += 1
        number = float(value)
        expiry = self.index - self.period
        while self.window and self.window[0][0] <= expiry:
            self.window.popleft()
        if self.highest:
            while self.window and self.window[-1][1] <= number:
                self.window.pop()
        else:
            while self.window and self.window[-1][1] >= number:
                self.window.pop()
        self.window.append((self.index, number))
        if self.index + 1 < self.period:
            return None
        return self.window[0][1]


class IncrementalTaNamespace:
    """Stateful TA helper namespace available as ``ctx.ta``."""

    def __init__(self, limits: _LimitTracker | None = None) -> None:
        self._helpers: dict[str, Any] = {}
        self._limits = limits or _LimitTracker(IncrementalLimits(enabled=False))

    def sma(self, name: str, period: int | None = None) -> _StepSMA:
        key = f"sma:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.sma('{name}') has not been initialized")
            self._limits.reserve_window(period, label=key)
            self._helpers[key] = _StepSMA(period)
        return self._helpers[key]

    def ema(self, name: str, period: int | None = None) -> _StepEMA:
        key = f"ema:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.ema('{name}') has not been initialized")
            self._helpers[key] = _StepEMA(period)
        return self._helpers[key]

    def boll(self, name: str, period: int | None = None, multiplier: float = 2.0) -> _StepBOLL:
        key = f"boll:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.boll('{name}') has not been initialized")
            self._limits.reserve_window(period, label=key)
            self._helpers[key] = _StepBOLL(period, multiplier)
        return self._helpers[key]

    def macd(
        self,
        name: str,
        fast: int | None = None,
        slow: int = 26,
        signal: int = 9,
    ) -> _StepMACD:
        key = f"macd:{name}"
        if key not in self._helpers:
            if fast is None:
                raise ValueError(f"ctx.ta.macd('{name}') has not been initialized")
            self._helpers[key] = _StepMACD(fast, slow, signal)
        return self._helpers[key]

    def rsi(self, name: str, period: int | None = None) -> _StepRSI:
        key = f"rsi:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.rsi('{name}') has not been initialized")
            self._helpers[key] = _StepRSI(period)
        return self._helpers[key]

    def atr(self, name: str, period: int | None = None) -> _StepATR:
        key = f"atr:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.atr('{name}') has not been initialized")
            self._helpers[key] = _StepATR(period)
        return self._helpers[key]

    def highest(self, name: str, period: int | None = None) -> _StepMonotonic:
        key = f"highest:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.highest('{name}') has not been initialized")
            self._limits.reserve_window(period, label=key)
            self._helpers[key] = _StepMonotonic(period, highest=True)
        return self._helpers[key]

    def lowest(self, name: str, period: int | None = None) -> _StepMonotonic:
        key = f"lowest:{name}"
        if key not in self._helpers:
            if period is None:
                raise ValueError(f"ctx.ta.lowest('{name}') has not been initialized")
            self._limits.reserve_window(period, label=key)
            self._helpers[key] = _StepMonotonic(period, highest=False)
        return self._helpers[key]


class IncrementalContext:
    """Per-session context exposed to incremental Pyne callbacks."""

    def __init__(
        self,
        *,
        params: dict[str, Any],
        meta: dict[str, Any] | None = None,
        limits: IncrementalLimits | None = None,
    ) -> None:
        self.params = params
        self.meta = meta or {}
        self._limits = limits or IncrementalLimits(enabled=False)
        self._limit_tracker = _LimitTracker(self._limits)
        self.ta = IncrementalTaNamespace(self._limit_tracker)
        self._states: dict[str, StateCell] = {}
        self._windows: dict[str, Window] = {}
        self._series: dict[str, dict[str, Any]] = {}
        self._markers: dict[str, dict[str, Any]] = {}
        self.current_bar: IncrementalBar | None = None

    def clone_for_preview(self) -> "IncrementalContext":
        clone = copy.deepcopy(self)
        clone._series = {}
        clone._markers = {}
        clone.current_bar = None
        return clone

    def clear_outputs(self) -> None:
        self._series = {}
        self._markers = {}

    def begin_bar(self, bar: IncrementalBar) -> None:
        self.current_bar = bar

    def state(self, name: str, default: Any = None) -> StateCell:
        key = str(name)
        if key not in self._states:
            if self._limits.enabled and len(self._states) >= self._limits.max_state_keys:
                raise PyneSecurityError(
                    f"Incremental state keys exceed safe-mode limit {self._limits.max_state_keys}"
                )
            self._states[key] = StateCell(copy.deepcopy(default))
        return self._states[key]

    def window(self, name: str, size: int) -> Window:
        key = str(name)
        if key not in self._windows:
            self._limit_tracker.reserve_window(size, label=f"window:{key}")
            self._windows[key] = Window(size)
        return self._windows[key]

    def plot(
        self,
        name_or_value: Any,
        value: Any = None,
        *,
        title: str | None = None,
        color: str = "#f59e0b",
        pane: str = "main",
        linewidth: int = 2,
        style: str = "solid",
        type: str = "line",
    ) -> None:
        if self.current_bar is None:
            return

        if isinstance(name_or_value, str):
            name = name_or_value
            point_value = value
        else:
            name = title or "plot"
            point_value = name_or_value

        if point_value is None:
            return
        try:
            number = float(point_value)
        except (TypeError, ValueError):
            return
        if math.isnan(number):
            return

        local_id = _slug(name)
        entry = self._series.setdefault(local_id, {
            "id": local_id,
            "title": title or name,
            "color": color,
            "linewidth": linewidth,
            "style": style,
            "type": type,
            "pane": pane,
            "data": [],
        })
        entry["data"].append({
            "time": self.current_bar.time,
            "value": round(number, 8),
        })

    def marker(
        self,
        condition: bool,
        *,
        text: str = "",
        shape: str = "circle",
        color: str = "#f59e0b",
        position: str = "above",
        pane: str = "main",
    ) -> None:
        if self.current_bar is None or not condition:
            return
        key = _slug(text or shape or "marker")
        entry = self._markers.setdefault(key, {
            "id": key,
            "shape": shape,
            "color": color,
            "text": text,
            "position": position,
            "pane": pane,
            "data": [],
        })
        entry["data"].append({
            "time": self.current_bar.time,
            "shape": shape,
            "color": color,
            "text": text,
            "position": position,
            "pane": pane,
        })

    def to_result(self, *, start_s: int | None = None, end_s: int | None = None) -> IncrementalPyneResult:
        lines = []
        for item in self._series.values():
            data = _filter_points(item.get("data") or [], start_s, end_s)
            if not data:
                continue
            line = {**item, "data": data}
            lines.append({
                "id": line["id"],
                "name": line.get("title", line["id"]),
                "color": line.get("color", "#f59e0b"),
                "type": line.get("type", "line"),
                "pane": line.get("pane", "main"),
                "lineWidth": line.get("linewidth", 2),
                "lineStyle": _style_to_int(line.get("style", "solid")),
                "data": data,
            })

        markers = []
        for item in self._markers.values():
            data = _filter_points(item.get("data") or [], start_s, end_s)
            if data:
                markers.append({**item, "data": data})

        output: dict[str, Any] = {}
        if lines:
            output["lines"] = [
                {
                    "id": line.get("id"),
                    "title": line.get("name"),
                    "color": line.get("color"),
                    "linewidth": line.get("lineWidth", 2),
                    "style": "solid",
                    "pane": line.get("pane", "main"),
                    "data": line.get("data") or [],
                }
                for line in lines
            ]
        if markers:
            output["markers"] = markers

        return IncrementalPyneResult(
            ok=True,
            lines=lines,
            output=output,
            meta={**self.meta, "mode": "incremental"},
        )


class PyneIncrementalSession:
    """Long-lived incremental Pyne execution session."""

    def __init__(
        self,
        *,
        script: str,
        params: dict[str, Any] | None = None,
        security_mode: str | None = None,
        policy: PyneSecurityPolicy | None = None,
        settings: PyneSettings | None = None,
    ) -> None:
        self.script = script
        self.params = params or {}
        self.settings = settings or PyneSettings.from_env()
        self.policy = policy or PyneSecurityPolicy.from_settings(self.settings, security_mode)
        self.security_mode = self.policy.mode
        self._limits = IncrementalLimits.for_policy(self.policy)
        self._globals: dict[str, Any] = {}
        self._meta: dict[str, Any] = {}
        self._init_func: Callable[..., Any] | None = None
        self._on_bar: Callable[..., Any] | None = None
        self._on_preview: Callable[..., Any] | None = None
        self._ctx: IncrementalContext | None = None
        self._prepared = False
        self.last_closed_time: int | None = None

    def prepare(self) -> None:
        if self._prepared:
            return
        validate_script_security(self.script, self.policy)
        self._globals = self._build_namespace()
        with execution_timeout(self.policy.timeout_seconds):
            exec(self.script, self._globals)  # noqa: S102
        self._init_func = self._globals.get("init") if callable(self._globals.get("init")) else None
        self._on_bar = self._globals.get("on_bar") if callable(self._globals.get("on_bar")) else None
        self._on_preview = self._globals.get("on_preview") if callable(self._globals.get("on_preview")) else None
        if self._on_bar is None:
            raise PyneSecurityError("Incremental Pyne scripts must define on_bar(ctx, bar)")
        self._prepared = True

    def seed(
        self,
        ohlcv: list[dict[str, Any]],
        *,
        start_s: int | None = None,
        end_s: int | None = None,
    ) -> IncrementalPyneResult:
        self.prepare()
        self._ctx = IncrementalContext(params=self.params, meta=self._meta, limits=self._limits)
        self._call_optional(self._init_func, self._ctx)
        for item in ohlcv:
            bar = IncrementalBar.from_dict(item, is_confirmed=True)
            self._run_bar(self._ctx, bar, preview=False)
            self.last_closed_time = bar.time
        return self._ctx.to_result(start_s=start_s, end_s=end_s)

    def on_bar_closed(self, item: dict[str, Any]) -> IncrementalPyneResult:
        self.prepare()
        if self._ctx is None:
            self._ctx = IncrementalContext(params=self.params, meta=self._meta, limits=self._limits)
            self._call_optional(self._init_func, self._ctx)
        bar = IncrementalBar.from_dict(item, is_confirmed=True)
        self._run_bar(self._ctx, bar, preview=False)
        self.last_closed_time = bar.time
        return self._ctx.to_result(start_s=bar.time, end_s=bar.time)

    def on_bar_updated(self, item: dict[str, Any]) -> IncrementalPyneResult:
        self.prepare()
        if self._ctx is None:
            self._ctx = IncrementalContext(params=self.params, meta=self._meta, limits=self._limits)
            self._call_optional(self._init_func, self._ctx)
        bar = IncrementalBar.from_dict(item, is_confirmed=False)
        preview_ctx = self._ctx.clone_for_preview()
        self._run_bar(preview_ctx, bar, preview=True)
        return preview_ctx.to_result(start_s=bar.time, end_s=bar.time)

    def _run_bar(self, ctx: IncrementalContext, bar: IncrementalBar, *, preview: bool) -> None:
        ctx.begin_bar(bar)
        func = self._on_preview if preview and self._on_preview is not None else self._on_bar
        with execution_timeout(self.policy.timeout_seconds):
            self._call_required(func, ctx, bar)

    def _build_namespace(self) -> dict[str, Any]:
        def indicator(title: str = "", overlay: bool = True, **kwargs: Any) -> None:
            self._meta = {"title": title, "overlay": overlay, **kwargs}

        return {
            "indicator": indicator,
            "params": self.params,
            "true": True,
            "false": False,
            "color": color_singleton,
            "math": pyne_math,
            "pyne": pyne_cache_namespace,
            "cache": pyne_cache_namespace.cache,
            "cache_clear": pyne_cache_namespace.cache_clear,
            "cache_stats": pyne_cache_namespace.cache_stats,
            "__builtins__": build_builtins(self.policy),
        }

    def _call_optional(self, func: Callable[..., Any] | None, ctx: IncrementalContext) -> None:
        if func is None:
            return
        with execution_timeout(self.policy.timeout_seconds):
            self._call_by_arity(func, ctx)

    def _call_required(self, func: Callable[..., Any] | None, ctx: IncrementalContext, bar: IncrementalBar) -> None:
        if func is None:
            raise PyneSecurityError("Incremental Pyne scripts must define on_bar(ctx, bar)")
        self._call_by_arity(func, ctx, bar)

    def _call_by_arity(self, func: Callable[..., Any], ctx: IncrementalContext, bar: IncrementalBar | None = None) -> None:
        signature = inspect.signature(func)
        params = list(signature.parameters.values())
        has_varargs = any(item.kind == inspect.Parameter.VAR_POSITIONAL for item in params)
        if bar is None:
            if len(params) == 0 and not has_varargs:
                func()
            else:
                func(ctx)
            return
        if has_varargs or len(params) >= 2:
            func(ctx, bar)
        elif len(params) == 1:
            func(bar)
        else:
            func()

    def snapshot_result(
        self,
        *,
        start_s: int | None = None,
        end_s: int | None = None,
    ) -> IncrementalPyneResult:
        self.prepare()
        if self._ctx is None:
            self._ctx = IncrementalContext(params=self.params, meta=self._meta, limits=self._limits)
            self._call_optional(self._init_func, self._ctx)
        return self._ctx.to_result(start_s=start_s, end_s=end_s)


@dataclass
class SharedPyneIncrementalSession:
    key: str
    session: PyneIncrementalSession
    ref_count: int = 0
    seeded: bool = False
    lock: threading.RLock = field(default_factory=threading.RLock)
    last_event_key: tuple[Any, ...] | None = None
    last_event_result: IncrementalPyneResult | None = None


class PyneIncrementalSessionManager:
    """Reference-counted in-process session cache for incremental Pyne."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, SharedPyneIncrementalSession] = {}

    def acquire(
        self,
        key: str,
        factory: Callable[[], PyneIncrementalSession],
    ) -> SharedPyneIncrementalSession:
        with self._lock:
            shared = self._sessions.get(key)
            if shared is None:
                shared = SharedPyneIncrementalSession(key=key, session=factory(), ref_count=0)
                self._sessions[key] = shared
            shared.ref_count += 1
            return shared

    def release(self, key: str) -> None:
        with self._lock:
            shared = self._sessions.get(key)
            if shared is None:
                return
            shared.ref_count -= 1
            if shared.ref_count <= 0:
                self._sessions.pop(key, None)

    def seed_or_snapshot(
        self,
        shared: SharedPyneIncrementalSession,
        ohlcv: list[dict[str, Any]],
        *,
        start_s: int | None = None,
        end_s: int | None = None,
    ) -> IncrementalPyneResult:
        with shared.lock:
            if not shared.seeded:
                result = shared.session.seed(ohlcv, start_s=start_s, end_s=end_s)
                shared.seeded = True
                return copy.deepcopy(result)
            return copy.deepcopy(shared.session.snapshot_result(start_s=start_s, end_s=end_s))

    def process_bar(
        self,
        shared: SharedPyneIncrementalSession,
        bar: dict[str, Any],
        *,
        preview: bool,
    ) -> IncrementalPyneResult:
        event_key = (
            "preview" if preview else "closed",
            int(bar.get("time") or 0),
            float(bar.get("open", 0)),
            float(bar.get("high", 0)),
            float(bar.get("low", 0)),
            float(bar.get("close", 0)),
            float(bar.get("volume", 0)),
        )
        with shared.lock:
            if shared.last_event_key == event_key and shared.last_event_result is not None:
                return copy.deepcopy(shared.last_event_result)
            result = shared.session.on_bar_updated(bar) if preview else shared.session.on_bar_closed(bar)
            shared.last_event_key = event_key
            shared.last_event_result = copy.deepcopy(result)
            return result

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "sessions": len(self._sessions),
                "keys": {
                    key: {"refCount": shared.ref_count, "seeded": shared.seeded}
                    for key, shared in self._sessions.items()
                },
            }


def is_incremental_pyne_script(script: str) -> bool:
    tree = ast.parse(script)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {"on_bar", "on_preview"}:
            return True
        if isinstance(node, ast.Call) and _call_name(node.func) == "indicator":
            for kw in node.keywords:
                if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                    if str(kw.value.value).lower() == "incremental":
                        return True
    return False


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _slug(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_]+", "_", str(value).strip()).strip("_").lower()
    return normalized or "plot"


def _filter_points(points: list[dict[str, Any]], start_s: int | None, end_s: int | None) -> list[dict[str, Any]]:
    if start_s is None and end_s is None:
        return list(points)
    filtered = []
    for point in points:
        try:
            ts = int(point.get("time"))
        except (TypeError, ValueError):
            continue
        if start_s is not None and ts < start_s:
            continue
        if end_s is not None and ts > end_s:
            continue
        filtered.append(point)
    return filtered


def _rsi_from_avgs(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 0.0
    if avg_gain == 0:
        return 0.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def _style_to_int(style: Any) -> int:
    if isinstance(style, int):
        return style
    normalized = str(style or "solid").lower()
    if normalized in {"dashed", "dash"}:
        return 1
    if normalized in {"dotted", "dot"}:
        return 2
    return 0
