"""Host-owned chart layer registry and Render IR budget enforcement."""

from __future__ import annotations

import copy
import threading
from dataclasses import dataclass
from typing import Any, Callable

from candlescope_plugin_sdk.platform_v2 import (
    RENDER_IR_V2,
    ChartLayerPublishRequest,
    MarketContext,
    MarketSeries,
    PlatformContractError,
    RenderBudget,
    validate_render_ir,
)

from app.plugin_security_v2.capabilities import CapabilityLease

from .chart_contexts import ChartContextRegistry
from .errors import market_error


@dataclass(frozen=True, slots=True)
class ChartLayerRecord:
    plugin_id: str
    full_id: str
    local_id: str
    instance_id: str
    generation: int
    revision: int
    chart_id: str | None
    chart_revision: int | None
    z_order: str | None
    context: dict[str, str]
    series: dict[str, str]
    render: dict[str, Any]

    def summary(self) -> dict[str, Any]:
        value = {
            "id": self.full_id,
            "pluginId": self.plugin_id,
            "generation": self.generation,
            "revision": self.revision,
            "context": dict(self.context),
            "series": dict(self.series),
            "itemCount": len(self.render["items"]),
            "schemaVersion": self.render["schemaVersion"],
        }
        if self.chart_id is not None:
            value["chartId"] = self.chart_id
            value["chartRevision"] = self.chart_revision
            value["zOrder"] = self.z_order
        return value

    def projection(self) -> dict[str, Any]:
        return {
            **self.summary(),
            "render": copy.deepcopy(self.render),
        }


class ChartLayerRegistry:
    def __init__(
        self,
        resolve_contribution: Callable[[str, str, str], Any],
        *,
        chart_contexts: ChartContextRegistry | None = None,
    ) -> None:
        self._resolve_contribution = resolve_contribution
        self._chart_contexts = chart_contexts
        self._records: dict[tuple[str, str], ChartLayerRecord] = {}
        self._accepting = True
        self._revoked_owners: set[tuple[str, str, int]] = set()
        self._lock = threading.RLock()

    def start(self) -> None:
        with self._lock:
            self._accepting = True

    def stop(self) -> None:
        with self._lock:
            self._accepting = False

    @staticmethod
    def _params(value: dict[str, Any]) -> dict[str, Any]:
        render = value.get("render")
        v2 = isinstance(render, dict) and render.get("schemaVersion") == RENDER_IR_V2
        expected = (
            {
                "layerId",
                "chartId",
                "chartRevision",
                "context",
                "series",
                "revision",
                "render",
            }
            if v2
            else {"layerId", "context", "series", "revision", "render"}
        )
        if set(value) != expected:
            raise market_error(
                "CHART_LAYER_PARAMS_INVALID",
                "chart layer publish parameters have an invalid shape",
                details={
                    "missing": sorted(expected - set(value)),
                    "unknown": sorted(set(value) - expected),
                },
            )
        return value

    def publish(self, params: dict[str, Any], lease: CapabilityLease) -> dict[str, Any]:
        with self._lock:
            return self._publish(params, lease)

    def _publish(
        self,
        params: dict[str, Any],
        lease: CapabilityLease,
    ) -> dict[str, Any]:
        value = self._params(dict(params))
        owner = (lease.plugin_id, lease.instance_id, lease.generation)
        if not self._accepting or owner in self._revoked_owners:
            raise market_error(
                "CHART_LAYER_GENERATION_REVOKED",
                "chart layer activation is stopping or revoked",
                plugin_id=lease.plugin_id,
            )
        render_value = value["render"]
        render_version = (
            render_value.get("schemaVersion")
            if isinstance(render_value, dict)
            else None
        )
        chart_id: str | None = None
        chart_revision: int | None = None
        if render_version == RENDER_IR_V2:
            try:
                parsed = ChartLayerPublishRequest.from_wire(value)
            except PlatformContractError as exc:
                raise market_error(
                    "CHART_LAYER_PARAMS_INVALID",
                    exc.message,
                    plugin_id=lease.plugin_id,
                    details={"path": exc.path},
                ) from exc
            layer_id = parsed.layer_id
            chart_id = parsed.chart_id
            chart_revision = parsed.chart_revision
            context = parsed.context
            series = parsed.series
            revision = parsed.revision
            contribution_kind = "chart-layer/2"
        else:
            layer_id = value["layerId"]
            if not isinstance(layer_id, str):
                raise market_error(
                    "CHART_LAYER_PARAMS_INVALID",
                    "layerId must be a string",
                    plugin_id=lease.plugin_id,
                )
            try:
                context = MarketContext.from_wire(value["context"])
                series = MarketSeries.from_wire(value["series"])
            except PlatformContractError as exc:
                raise market_error(
                    "CHART_LAYER_PARAMS_INVALID",
                    exc.message,
                    plugin_id=lease.plugin_id,
                    details={"path": exc.path},
                ) from exc
            revision = value["revision"]
            contribution_kind = "chart-layer/1"
        contribution = self._resolve_contribution(
            lease.plugin_id, contribution_kind, layer_id
        )
        if context.mode != "live":
            raise market_error(
                "MARKET_CONTEXT_ISOLATION_DENIED",
                "live chart layers cannot target replay context",
                plugin_id=lease.plugin_id,
            )
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise market_error(
                "CHART_LAYER_REVISION_INVALID",
                "chart layer revision must be a positive integer",
                plugin_id=lease.plugin_id,
            )
        configured_max = contribution.configuration["maxItems"]
        granted_max = lease.scope.get("maxItems", configured_max)
        if (
            isinstance(granted_max, bool)
            or not isinstance(granted_max, int)
            or granted_max < 1
        ):
            raise market_error(
                "CHART_LAYER_SCOPE_INVALID",
                "granted chart layer item budget is invalid",
                plugin_id=lease.plugin_id,
            )
        configured_points = contribution.configuration.get("maxPoints", 20_000)
        granted_points = lease.scope.get("maxPoints", configured_points)
        if (
            isinstance(granted_points, bool)
            or not isinstance(granted_points, int)
            or granted_points < 1
        ):
            raise market_error(
                "CHART_LAYER_SCOPE_INVALID",
                "granted chart layer point budget is invalid",
                plugin_id=lease.plugin_id,
            )
        if chart_id is not None:
            if (
                self._chart_contexts is None
                or chart_revision is None
                or not self._chart_contexts.matches(
                    chart_id=chart_id,
                    chart_revision=chart_revision,
                    context=context,
                    series=series,
                )
            ):
                raise market_error(
                    "CHART_LAYER_CONTEXT_STALE",
                    "chart layer does not match the active Host chart context",
                    plugin_id=lease.plugin_id,
                )
        try:
            render = validate_render_ir(
                value["render"],
                budget=RenderBudget(
                    max_items=min(configured_max, granted_max),
                    max_points=min(configured_points, granted_points),
                    max_bytes=contribution.configuration["maxBytes"],
                    max_text_chars=contribution.configuration["maxTextChars"],
                ),
            )
        except PlatformContractError as exc:
            raise market_error(
                "CHART_LAYER_RENDER_INVALID",
                exc.message,
                plugin_id=lease.plugin_id,
                details={"path": exc.path},
            ) from exc
        key = (lease.plugin_id, contribution.full_id)
        previous = self._records.get(key)
        if previous is not None and (
            lease.generation < previous.generation
            or (
                lease.generation == previous.generation
                and lease.instance_id != previous.instance_id
            )
        ):
            raise market_error(
                "CHART_LAYER_STALE_GENERATION",
                "chart layer publish belongs to a stale activation generation",
                plugin_id=lease.plugin_id,
            )
        if (
            previous is not None
            and previous.instance_id == lease.instance_id
            and previous.generation == lease.generation
            and revision <= previous.revision
        ):
            raise market_error(
                "CHART_LAYER_STALE_REVISION",
                "chart layer revision did not advance",
                plugin_id=lease.plugin_id,
            )
        record = ChartLayerRecord(
            plugin_id=lease.plugin_id,
            full_id=contribution.full_id,
            local_id=contribution.id,
            instance_id=lease.instance_id,
            generation=lease.generation,
            revision=revision,
            chart_id=chart_id,
            chart_revision=chart_revision,
            z_order=(
                contribution.configuration["zOrder"]
                if contribution_kind == "chart-layer/2"
                else None
            ),
            context=context.to_wire(),
            series=series.to_wire(),
            render=render,
        )
        self._records[key] = record
        return {
            "layerId": contribution.full_id,
            "generation": lease.generation,
            "revision": revision,
            "itemCount": len(render["items"]),
            **(
                {"chartId": chart_id, "chartRevision": chart_revision}
                if chart_id is not None
                else {}
            ),
            "published": True,
        }

    def clear_plugin(self, plugin_id: str) -> int:
        with self._lock:
            keys = [key for key in self._records if key[0] == plugin_id]
            for key in keys:
                self._records.pop(key, None)
            return len(keys)

    def clear_chart(self, chart_id: str) -> int:
        with self._lock:
            keys = [
                key
                for key, value in self._records.items()
                if value.chart_id == chart_id
            ]
            for key in keys:
                self._records.pop(key, None)
            return len(keys)

    def clear_leases(self, leases: tuple[CapabilityLease, ...]) -> int:
        owners = {
            (item.plugin_id, item.instance_id, item.generation) for item in leases
        }
        with self._lock:
            self._revoked_owners.update(owners)
            keys = [
                key
                for key, value in self._records.items()
                if (value.plugin_id, value.instance_id, value.generation) in owners
            ]
            for key in keys:
                self._records.pop(key, None)
            return len(keys)

    def snapshot(self) -> dict[str, Any]:
        visible = self._visible_records()
        return {
            "active": len(visible),
            "retained": len(self._records),
            "layers": [
                value.summary()
                for value in sorted(visible, key=lambda item: item.full_id)
            ],
        }

    def projections(self) -> tuple[dict[str, Any], ...]:
        return tuple(
            value.projection()
            for value in sorted(self._visible_records(), key=lambda item: item.full_id)
        )

    def _visible_records(self) -> tuple[ChartLayerRecord, ...]:
        with self._lock:
            values: list[ChartLayerRecord] = []
            for record in self._records.values():
                if record.chart_id is None:
                    values.append(record)
                    continue
                assert record.chart_revision is not None
                if self._chart_contexts is None:
                    continue
                try:
                    context = MarketContext.from_wire(record.context)
                    series = MarketSeries.from_wire(record.series)
                except PlatformContractError:
                    continue
                if self._chart_contexts.matches(
                    chart_id=record.chart_id,
                    chart_revision=record.chart_revision,
                    context=context,
                    series=series,
                ):
                    values.append(record)
            return tuple(values)


__all__ = ["ChartLayerRecord", "ChartLayerRegistry"]
