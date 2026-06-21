"""Output collection and serialization for plot APIs."""
from __future__ import annotations

from typing import Any

from ..security import PyneSecurityError


class OutputCollector:
    """Collects all drawing outputs from a script execution.

    The runtime creates one per execution and passes it to all
    plot/drawing functions. After execution, it's read to build
    the JSON response.
    """

    def __init__(self, times: list[int], max_drawing_objects: int = 500) -> None:
        self.times = times
        self.max_drawing_objects = max(int(max_drawing_objects), 1)
        self.lines: list[dict[str, Any]] = []
        self.histograms: list[dict[str, Any]] = []
        self.hlines: list[dict[str, Any]] = []
        self.fills: list[dict[str, Any]] = []
        self.markers: list[dict[str, Any]] = []
        self.bgcolors: list[dict[str, Any]] = []
        self.labels: list[dict[str, Any]] = []
        self.barcolors: list[dict[str, Any]] = []
        self.signals: list[dict[str, Any]] = []
        self.strategy_orders: list[dict[str, Any]] = []
        self.strategy_position: dict[str, Any] = {}
        self.strategy_report: dict[str, Any] = {}
        self._object_lines: dict[str, dict[str, Any]] = {}
        self._object_labels: dict[str, dict[str, Any]] = {}
        self._object_boxes: dict[str, dict[str, Any]] = {}
        self._object_tables: dict[str, dict[str, Any]] = {}
        self._indicator_meta: dict[str, Any] = {}
        self._plot_counter: int = 0
        self._object_counter: int = 0

    def _next_id(self) -> str:
        self._plot_counter += 1
        return f"plot_{self._plot_counter}"

    def _next_object_id(self, kind: str) -> str:
        self._ensure_object_capacity()
        self._object_counter += 1
        return f"{kind}_{self._object_counter}"

    def _ensure_object_capacity(self) -> None:
        total = (
            len(self._object_lines)
            + len(self._object_labels)
            + len(self._object_boxes)
            + len(self._object_tables)
        )
        if total >= self.max_drawing_objects:
            raise PyneSecurityError(
                f"Drawing object limit exceeded (max {self.max_drawing_objects})"
            )

    def set_indicator_meta(self, title: str = "", overlay: bool = True, **kwargs: Any) -> None:
        """Set indicator metadata (from ``indicator()`` call)."""
        self._indicator_meta = {
            "title": title,
            "overlay": overlay,
            **kwargs,
        }

    @property
    def indicator_meta(self) -> dict[str, Any]:
        return self._indicator_meta

    def to_dict(self) -> dict[str, Any]:
        """Serialize all outputs for JSON response."""
        result: dict[str, Any] = {}

        if self._indicator_meta:
            result["meta"] = self._indicator_meta

        if self.lines:
            result["lines"] = self.lines
        if self.histograms:
            result["histograms"] = self.histograms
        if self.hlines:
            result["hlines"] = self.hlines
        if self.fills:
            result["fills"] = self.fills
        if self.markers:
            result["markers"] = self.markers
        if self.bgcolors:
            result["bgcolors"] = self.bgcolors
        if self.labels:
            result["labels"] = self.labels
        if self.barcolors:
            result["barcolors"] = self.barcolors
        if self.signals:
            result["signals"] = self.signals
        if self.strategy_orders or self.strategy_position:
            orders = [
                {key: value for key, value in order.items() if not str(key).startswith("_")}
                for order in sorted(
                    self.strategy_orders,
                    key=lambda item: (item.get("time", 0), item.get("_seq", 0)),
                )
                if order.get("_active", True)
            ]
            result["strategy"] = {
                "orders": orders,
                "position": self.strategy_position,
            }
            if self.strategy_report:
                result["strategy"].update(self.strategy_report)

        objects: dict[str, Any] = {}
        if self._object_lines:
            objects["lines"] = list(self._object_lines.values())
        if self._object_labels:
            objects["labels"] = list(self._object_labels.values())
        if self._object_boxes:
            objects["boxes"] = list(self._object_boxes.values())
        if self._object_tables:
            objects["tables"] = list(self._object_tables.values())
        if objects:
            result["objects"] = objects

        return result
