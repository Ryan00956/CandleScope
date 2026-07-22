"""Host-owned chart layer registry and Render IR budget enforcement."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from candlescope_plugin_sdk.platform_v2 import (
    MarketContext,
    MarketSeries,
    PlatformContractError,
    RenderBudget,
    validate_render_ir,
)

from app.plugin_security_v2.capabilities import CapabilityLease

from .errors import market_error


@dataclass(frozen=True, slots=True)
class ChartLayerRecord:
    plugin_id: str
    full_id: str
    local_id: str
    instance_id: str
    generation: int
    revision: int
    context: dict[str, str]
    series: dict[str, str]
    render: dict[str, Any]

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.full_id,
            "pluginId": self.plugin_id,
            "generation": self.generation,
            "revision": self.revision,
            "context": dict(self.context),
            "series": dict(self.series),
            "itemCount": len(self.render["items"]),
            "schemaVersion": self.render["schemaVersion"],
        }

    def projection(self) -> dict[str, Any]:
        return {
            **self.summary(),
            "render": {
                "schemaVersion": self.render["schemaVersion"],
                "items": [dict(item) for item in self.render["items"]],
            },
        }


class ChartLayerRegistry:
    def __init__(self, resolve_contribution: Callable[[str, str, str], Any]) -> None:
        self._resolve_contribution = resolve_contribution
        self._records: dict[tuple[str, str], ChartLayerRecord] = {}
        self._accepting = True
        self._revoked_owners: set[tuple[str, str, int]] = set()

    def start(self) -> None:
        self._accepting = True

    def stop(self) -> None:
        self._accepting = False

    @staticmethod
    def _params(value: dict[str, Any]) -> dict[str, Any]:
        expected = {"layerId", "context", "series", "revision", "render"}
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
        value = self._params(dict(params))
        owner = (lease.plugin_id, lease.instance_id, lease.generation)
        if not self._accepting or owner in self._revoked_owners:
            raise market_error(
                "CHART_LAYER_GENERATION_REVOKED",
                "chart layer activation is stopping or revoked",
                plugin_id=lease.plugin_id,
            )
        layer_id = value["layerId"]
        if not isinstance(layer_id, str):
            raise market_error(
                "CHART_LAYER_PARAMS_INVALID",
                "layerId must be a string",
                plugin_id=lease.plugin_id,
            )
        contribution = self._resolve_contribution(
            lease.plugin_id, "chart-layer/1", layer_id
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
        if context.mode != "live":
            raise market_error(
                "MARKET_CONTEXT_ISOLATION_DENIED",
                "live chart layers cannot target replay context",
                plugin_id=lease.plugin_id,
            )
        revision = value["revision"]
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
        try:
            render = validate_render_ir(
                value["render"],
                budget=RenderBudget(
                    max_items=min(configured_max, granted_max),
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
            "published": True,
        }

    def clear_plugin(self, plugin_id: str) -> int:
        keys = [key for key in self._records if key[0] == plugin_id]
        for key in keys:
            self._records.pop(key, None)
        return len(keys)

    def clear_leases(self, leases: tuple[CapabilityLease, ...]) -> int:
        owners = {
            (item.plugin_id, item.instance_id, item.generation) for item in leases
        }
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
        return {
            "active": len(self._records),
            "layers": [
                value.summary()
                for value in sorted(
                    self._records.values(), key=lambda item: item.full_id
                )
            ],
        }

    def projections(self) -> tuple[dict[str, Any], ...]:
        return tuple(
            value.projection()
            for value in sorted(self._records.values(), key=lambda item: item.full_id)
        )


__all__ = ["ChartLayerRecord", "ChartLayerRegistry"]
