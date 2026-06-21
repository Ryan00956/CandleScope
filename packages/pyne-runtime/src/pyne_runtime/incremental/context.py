"""Per-session incremental callback context."""
from __future__ import annotations

import copy
import math
import re
from dataclasses import asdict
from typing import Any

from ..barstate import PyneIncrementalBarState
from ..metadata import SessionInfo, SymbolInfo, TimeframeInfo
from ..security import PyneSecurityError
from .bar import IncrementalBar, _session_info_for_bar
from .drawing import IncrementalDrawingMixin, _filter_object_events
from .limits import IncrementalLimits, StateCell, Window, _LimitTracker
from .result import IncrementalPyneResult
from .strategy import IncrementalStrategyNamespace
from .ta import IncrementalTaNamespace


class IncrementalContext(IncrementalDrawingMixin):
    """Per-session context exposed to incremental Pyne callbacks."""

    def __init__(
        self,
        *,
        params: dict[str, Any],
        meta: dict[str, Any] | None = None,
        limits: IncrementalLimits | None = None,
        syminfo: SymbolInfo | None = None,
        timeframe: TimeframeInfo | None = None,
        session: SessionInfo | None = None,
        max_drawing_objects: int = 500,
    ) -> None:
        self.params = params
        self.meta = meta or {}
        self._limits = limits or IncrementalLimits(enabled=False)
        self._limit_tracker = _LimitTracker(self._limits)
        self.ta = IncrementalTaNamespace(self._limit_tracker)
        self.syminfo = syminfo or SymbolInfo()
        self.timeframe = timeframe or TimeframeInfo()
        self._default_session = session or SessionInfo()
        self.session = self._default_session
        self.strategy = IncrementalStrategyNamespace(self)
        self._states: dict[str, StateCell] = {}
        self._varip_states: dict[str, StateCell] = {}
        self._windows: dict[str, Window] = {}
        self._series: dict[str, dict[str, Any]] = {}
        self._markers: dict[str, dict[str, Any]] = {}
        self._object_lines: dict[str, dict[str, Any]] = {}
        self._object_labels: dict[str, dict[str, Any]] = {}
        self._object_boxes: dict[str, dict[str, Any]] = {}
        self._object_tables: dict[str, dict[str, Any]] = {}
        self._object_events: list[dict[str, Any]] = []
        self._object_counter = 0
        self._max_drawing_objects = max(int(max_drawing_objects), 1)
        self.current_bar: IncrementalBar | None = None
        self.bar_index = -1
        self.last_bar_index = -1
        self.barstate = PyneIncrementalBarState()

    def clone_for_preview(self) -> "IncrementalContext":
        clone = copy.deepcopy(self)
        clone._series = {}
        clone._markers = {}
        clone.current_bar = None
        return clone

    def clear_outputs(self) -> None:
        self._series = {}
        self._markers = {}

    def begin_bar(
        self,
        bar: IncrementalBar,
        *,
        bar_index: int,
        last_bar_index: int,
        barstate: PyneIncrementalBarState,
    ) -> None:
        bar.bar_index = bar_index
        bar.last_bar_index = last_bar_index
        bar.is_first = barstate.isfirst
        bar.is_last = barstate.islast
        bar.is_history = barstate.ishistory
        bar.is_realtime = barstate.isrealtime
        bar.is_new = barstate.isnew
        bar.is_last_confirmed_history = barstate.islastconfirmedhistory
        self.current_bar = bar
        self.bar_index = bar_index
        self.last_bar_index = last_bar_index
        self.barstate = barstate
        if barstate.isconfirmed:
            self._varip_states = {}
        self.session = _session_info_for_bar(bar, self._default_session)
        self.strategy.begin_bar()

    def state(self, name: str, default: Any = None) -> StateCell:
        key = str(name)
        if key not in self._states:
            self._ensure_state_key_available()
            self._states[key] = StateCell(
                copy.deepcopy(default),
                max_history=self._limits.max_state_history,
            )
        return self._states[key]

    def varip(self, name: str, default: Any = None) -> StateCell:
        """Return an intrabar state cell for realtime preview callbacks.

        ``varip`` cells persist across preview updates for the same realtime
        bar, but reset before confirmed callbacks and when a new preview bar
        starts. This mirrors Pine's intrabar-state intent without letting
        preview state mutate the persistent session context.
        """
        key = str(name)
        if key not in self._varip_states:
            self._ensure_state_key_available()
            self._varip_states[key] = StateCell(
                copy.deepcopy(default),
                max_history=self._limits.max_state_history,
            )
        return self._varip_states[key]

    def commit_state_history(self) -> None:
        for cell in self._states.values():
            cell.commit_history()

    def _ensure_state_key_available(self) -> None:
        if not self._limits.enabled:
            return
        key_count = len(self._states) + len(self._varip_states)
        if key_count >= self._limits.max_state_keys:
            raise PyneSecurityError(
                f"Incremental state keys exceed safe-mode limit {self._limits.max_state_keys}"
            )

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
        pane: str | None = None,
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

        resolved_pane = pane or self._default_pane()
        local_id = _slug(name)
        normalized_type = "histogram" if _is_histogram_style(style) else type
        entry = self._series.setdefault(local_id, {
            "id": local_id,
            "title": title or name,
            "color": color,
            "linewidth": linewidth,
            "style": style,
            "type": normalized_type,
            "pane": resolved_pane,
            "data": [],
        })
        point: dict[str, Any] = {
            "time": self.current_bar.time,
            "value": round(number, 8),
        }
        if normalized_type == "histogram":
            point["color"] = color
        entry["data"].append(point)

    def marker(
        self,
        condition: bool,
        *,
        text: str = "",
        shape: str = "circle",
        color: str = "#f59e0b",
        position: str = "above",
        size: str = "normal",
        pane: str | None = None,
    ) -> None:
        if self.current_bar is None or not condition:
            return
        resolved_pane = pane or self._default_pane()
        key = _slug(text or shape or "marker")
        entry = self._markers.setdefault(key, {
            "id": key,
            "shape": shape,
            "color": color,
            "text": text,
            "position": position,
            "size": size,
            "pane": resolved_pane,
            "data": [],
        })
        entry["data"].append({
            "time": self.current_bar.time,
            "shape": shape,
            "color": color,
            "text": text,
            "position": position,
            "size": size,
            "pane": resolved_pane,
        })

    def _default_pane(self) -> str:
        return "main" if self.meta.get("overlay", True) else "separate"


    def to_result(
        self,
        *,
        start_s: int | None = None,
        end_s: int | None = None,
    ) -> IncrementalPyneResult:
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
                "style": line.get("style", "solid"),
                "data": data,
            })

        markers = []
        for item in self._markers.values():
            data = _filter_points(item.get("data") or [], start_s, end_s)
            if data:
                markers.append({**item, "data": data})

        output: dict[str, Any] = {}
        line_outputs = [line for line in lines if line.get("type") != "histogram"]
        histogram_outputs = [line for line in lines if line.get("type") == "histogram"]
        if line_outputs:
            output["lines"] = [
                {
                    "id": line.get("id"),
                    "title": line.get("name"),
                    "color": line.get("color"),
                    "linewidth": line.get("lineWidth", 2),
                    "style": _line_output_style(line.get("style", "solid")),
                    "pane": line.get("pane", "main"),
                    "data": line.get("data") or [],
                }
                for line in line_outputs
            ]
        if histogram_outputs:
            output["histograms"] = [
                {
                    "title": line.get("name"),
                    "color_up": line.get("color"),
                    "color_down": line.get("color"),
                    "pane": line.get("pane", "main"),
                    "data": line.get("data") or [],
                }
                for line in histogram_outputs
            ]
        if markers:
            output["markers"] = markers
        if self.strategy.touched:
            output["strategy"] = self.strategy.to_report()
        objects = self._objects_snapshot()
        if objects:
            output["objects"] = objects
        object_events = _filter_object_events(self._object_events, start_s, end_s)
        if object_events:
            output["object_events"] = object_events

        return IncrementalPyneResult(
            ok=True,
            lines=lines,
            output=output,
            meta={
                **self.meta,
                "mode": "incremental",
                "bar_index": self.bar_index,
                "last_bar_index": self.last_bar_index,
                "barstate": asdict(self.barstate),
            },
        )

def _slug(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_]+", "_", str(value).strip()).strip("_").lower()
    return normalized or "plot"

def _filter_points(
    points: list[dict[str, Any]],
    start_s: int | None,
    end_s: int | None,
) -> list[dict[str, Any]]:
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

def _style_to_int(style: Any) -> int:
    if isinstance(style, int):
        return style
    normalized = str(style or "solid").lower()
    if normalized in {"dashed", "dash"}:
        return 2
    if normalized in {"dotted", "dot"}:
        return 1
    return 0

def _is_histogram_style(style: Any) -> bool:
    return str(style or "").lower() in {"histogram", "columns", "column", "bar"}

def _line_output_style(style: Any) -> str:
    if isinstance(style, str):
        normalized = style.lower()
        if normalized in {"dashed", "dash"}:
            return "dashed"
        if normalized in {"dotted", "dot"}:
            return "dotted"
        return "solid"
    return {1: "dotted", 2: "dashed"}.get(int(style or 0), "solid")
