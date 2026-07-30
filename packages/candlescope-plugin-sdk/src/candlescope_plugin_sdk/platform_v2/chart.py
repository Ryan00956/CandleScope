"""Typed chart-context and chart-layer contracts for Plugin Platform v2."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .errors import contract_error
from .market import MarketContext, MarketSeries
from .render import RENDER_IR_V2, RenderBudget, validate_render_ir


CHART_CONTEXT_V1 = "candlescope.chart-context/1"
CHART_CONTEXT_CHANGED_EVENT_V1 = "candlescope.chart.context-changed/1"
CHART_CONTEXT_READ_METHOD = "chart.context.read"
CHART_LAYER_PUBLISH_METHOD = "chart.layer.publish"
MAIN_CHART_ID = "main-chart"

_CHART_ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_LAYER_ID = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$")


def _exact_object(
    value: Any,
    path: str,
    *,
    required: frozenset[str],
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise contract_error(f"{path} must be an object", path=path)
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required)
    if missing or unknown:
        raise contract_error(
            f"{path} has an invalid shape; missing={missing}, unknown={unknown}",
            path=path,
        )
    return value


def _chart_id(value: Any, path: str) -> str:
    if not isinstance(value, str) or len(value) > 64 or _CHART_ID.fullmatch(value) is None:
        raise contract_error(f"{path} is invalid", path=path)
    return value


def _positive_revision(value: Any, path: str, *, allow_zero: bool = False) -> int:
    minimum = 0 if allow_zero else 1
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= 9_007_199_254_740_991
    ):
        raise contract_error(f"{path} is invalid", path=path)
    return value


@dataclass(frozen=True, slots=True)
class ChartContextReadRequest:
    chart_id: str = MAIN_CHART_ID

    def __post_init__(self) -> None:
        object.__setattr__(self, "chart_id", _chart_id(self.chart_id, "chartContext.chartId"))

    def to_wire(self) -> dict[str, str]:
        return {"chartId": self.chart_id}

    @classmethod
    def from_wire(cls, value: Any) -> "ChartContextReadRequest":
        data = _exact_object(
            value,
            "chartContext",
            required=frozenset({"chartId"}),
        )
        return cls(chart_id=data["chartId"])


@dataclass(frozen=True, slots=True)
class ChartContextSnapshot:
    chart_id: str
    revision: int
    active: bool
    context: MarketContext | None
    series: MarketSeries | None
    updated_at_ms: int | None
    schema_version: str = CHART_CONTEXT_V1

    def __post_init__(self) -> None:
        if self.schema_version != CHART_CONTEXT_V1:
            raise contract_error(
                f"chartContext.schemaVersion must be {CHART_CONTEXT_V1}",
                path="chartContext.schemaVersion",
            )
        object.__setattr__(self, "chart_id", _chart_id(self.chart_id, "chartContext.chartId"))
        object.__setattr__(
            self,
            "revision",
            _positive_revision(
                self.revision,
                "chartContext.revision",
                allow_zero=True,
            ),
        )
        if not isinstance(self.active, bool):
            raise contract_error(
                "chartContext.active must be a boolean",
                path="chartContext.active",
            )
        if self.active:
            if not isinstance(self.context, MarketContext) or not isinstance(
                self.series, MarketSeries
            ):
                raise contract_error(
                    "active chart context requires context and series",
                    path="chartContext",
                )
            if self.context.mode != "live":
                raise contract_error(
                    "chartContext only supports live mode",
                    path="chartContext.context.mode",
                )
        elif self.context is not None or self.series is not None:
            raise contract_error(
                "inactive chart context must not expose context or series",
                path="chartContext",
            )
        if self.updated_at_ms is not None and (
            isinstance(self.updated_at_ms, bool)
            or not isinstance(self.updated_at_ms, int)
            or self.updated_at_ms < 0
        ):
            raise contract_error(
                "chartContext.updatedAtMs is invalid",
                path="chartContext.updatedAtMs",
            )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "chartId": self.chart_id,
            "revision": self.revision,
            "active": self.active,
            "context": self.context.to_wire() if self.context is not None else None,
            "series": self.series.to_wire() if self.series is not None else None,
            "updatedAtMs": self.updated_at_ms,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "ChartContextSnapshot":
        data = _exact_object(
            value,
            "chartContext",
            required=frozenset(
                {
                    "schemaVersion",
                    "chartId",
                    "revision",
                    "active",
                    "context",
                    "series",
                    "updatedAtMs",
                }
            ),
        )
        active = data["active"]
        if not isinstance(active, bool):
            raise contract_error(
                "chartContext.active must be a boolean",
                path="chartContext.active",
            )
        if not active and (data["context"] is not None or data["series"] is not None):
            raise contract_error(
                "inactive chart context must not expose context or series",
                path="chartContext",
            )
        return cls(
            schema_version=data["schemaVersion"],
            chart_id=data["chartId"],
            revision=data["revision"],
            active=active,
            context=MarketContext.from_wire(data["context"]) if active else None,
            series=MarketSeries.from_wire(data["series"]) if active else None,
            updated_at_ms=data["updatedAtMs"],
        )


@dataclass(frozen=True, slots=True)
class ChartLayerPublishRequest:
    layer_id: str
    chart_id: str
    chart_revision: int
    context: MarketContext
    series: MarketSeries
    revision: int
    render: dict[str, Any]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.layer_id, str)
            or len(self.layer_id) > 64
            or _LAYER_ID.fullmatch(self.layer_id) is None
        ):
            raise contract_error(
                "chartLayer.layerId is invalid",
                path="chartLayer.layerId",
            )
        object.__setattr__(self, "chart_id", _chart_id(self.chart_id, "chartLayer.chartId"))
        object.__setattr__(
            self,
            "chart_revision",
            _positive_revision(self.chart_revision, "chartLayer.chartRevision"),
        )
        if not isinstance(self.context, MarketContext) or self.context.mode != "live":
            raise contract_error(
                "chartLayer.context must be a live MarketContext",
                path="chartLayer.context",
            )
        if not isinstance(self.series, MarketSeries):
            raise contract_error(
                "chartLayer.series must be a MarketSeries",
                path="chartLayer.series",
            )
        object.__setattr__(
            self,
            "revision",
            _positive_revision(self.revision, "chartLayer.revision"),
        )
        normalized = validate_render_ir(
            self.render,
            budget=RenderBudget(
                max_items=5_000,
                max_points=100_000,
                max_bytes=1024 * 1024,
                max_text_chars=1_024,
            ),
        )
        if normalized["schemaVersion"] != RENDER_IR_V2:
            raise contract_error(
                f"chartLayer.render must use {RENDER_IR_V2}",
                path="chartLayer.render.schemaVersion",
            )
        object.__setattr__(self, "render", normalized)

    def to_wire(self) -> dict[str, Any]:
        return {
            "layerId": self.layer_id,
            "chartId": self.chart_id,
            "chartRevision": self.chart_revision,
            "context": self.context.to_wire(),
            "series": self.series.to_wire(),
            "revision": self.revision,
            "render": {
                "schemaVersion": self.render["schemaVersion"],
                "items": [dict(item) for item in self.render["items"]],
            },
        }

    @classmethod
    def from_wire(cls, value: Any) -> "ChartLayerPublishRequest":
        data = _exact_object(
            value,
            "chartLayer",
            required=frozenset(
                {
                    "layerId",
                    "chartId",
                    "chartRevision",
                    "context",
                    "series",
                    "revision",
                    "render",
                }
            ),
        )
        return cls(
            layer_id=data["layerId"],
            chart_id=data["chartId"],
            chart_revision=data["chartRevision"],
            context=MarketContext.from_wire(data["context"]),
            series=MarketSeries.from_wire(data["series"]),
            revision=data["revision"],
            render=dict(data["render"]) if isinstance(data["render"], Mapping) else data["render"],
        )


__all__ = [
    "CHART_CONTEXT_CHANGED_EVENT_V1",
    "CHART_CONTEXT_READ_METHOD",
    "CHART_CONTEXT_V1",
    "CHART_LAYER_PUBLISH_METHOD",
    "ChartContextReadRequest",
    "ChartContextSnapshot",
    "ChartLayerPublishRequest",
    "MAIN_CHART_ID",
]
