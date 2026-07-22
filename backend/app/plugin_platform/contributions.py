"""Generation-owned in-memory contribution registry for Plugin Platform v2."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from candlescope_plugin_sdk.platform_v2 import ContributionDescriptor

from app.plugin_host.errors import PlatformHostRequestError, PlatformHostStateError


OwnerKey = tuple[str, str]


@dataclass(frozen=True, slots=True)
class RegisteredContribution:
    full_id: str
    plugin_id: str
    entrypoint_id: str
    generation: int
    descriptor: ContributionDescriptor

    @property
    def owner_key(self) -> OwnerKey:
        return (self.plugin_id, self.entrypoint_id)

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.full_id,
            "pluginId": self.plugin_id,
            "entrypointId": self.entrypoint_id,
            "generation": self.generation,
            "descriptor": self.descriptor.to_wire(),
        }


def contribution_full_id(plugin_id: str, contribution_id: str) -> str:
    return f"{plugin_id}.{contribution_id}"


class ContributionRegistry:
    """Atomically project active descriptors without accepting stale generations."""

    def __init__(self) -> None:
        self._items: dict[str, RegisteredContribution] = {}
        self._owner_generations: dict[OwnerKey, int] = {}

    def replace_owner(
        self,
        *,
        plugin_id: str,
        entrypoint_id: str,
        generation: int,
        contributions: tuple[ContributionDescriptor, ...],
    ) -> tuple[RegisteredContribution, ...]:
        owner = (plugin_id, entrypoint_id)
        if (
            isinstance(generation, bool)
            or not isinstance(generation, int)
            or generation < 1
        ):
            raise PlatformHostRequestError(
                code="PLUGIN_PLATFORM_CONTRIBUTION_INVALID",
                message="contribution owner generation must be a positive integer",
                plugin_id=plugin_id,
                entrypoint_id=entrypoint_id,
            )
        current_generation = self._owner_generations.get(owner, 0)
        if generation <= current_generation:
            raise PlatformHostStateError(
                code="PLUGIN_PLATFORM_STALE_GENERATION",
                message="stale activation cannot replace contribution ownership",
                plugin_id=plugin_id,
                entrypoint_id=entrypoint_id,
                details={
                    "currentGeneration": current_generation,
                    "attemptedGeneration": generation,
                },
            )
        candidates: list[RegisteredContribution] = []
        for descriptor in contributions:
            if not isinstance(descriptor, ContributionDescriptor):
                raise PlatformHostRequestError(
                    code="PLUGIN_PLATFORM_CONTRIBUTION_INVALID",
                    message="descriptor contains an invalid contribution",
                    plugin_id=plugin_id,
                    entrypoint_id=entrypoint_id,
                )
            if descriptor.entrypoint != entrypoint_id:
                raise PlatformHostRequestError(
                    code="PLUGIN_PLATFORM_CONTRIBUTION_INVALID",
                    message="contribution entrypoint does not match its owner",
                    plugin_id=plugin_id,
                    entrypoint_id=entrypoint_id,
                    details={"contributionId": descriptor.id},
                )
            candidates.append(
                RegisteredContribution(
                    full_id=contribution_full_id(plugin_id, descriptor.id),
                    plugin_id=plugin_id,
                    entrypoint_id=entrypoint_id,
                    generation=generation,
                    descriptor=descriptor,
                )
            )
        if not candidates:
            raise PlatformHostRequestError(
                code="PLUGIN_PLATFORM_CONTRIBUTION_INVALID",
                message="active entrypoint descriptor has no contributions",
                plugin_id=plugin_id,
                entrypoint_id=entrypoint_id,
            )
        candidate_ids = [item.full_id for item in candidates]
        if len(set(candidate_ids)) != len(candidate_ids):
            raise PlatformHostRequestError(
                code="PLUGIN_PLATFORM_CONTRIBUTION_CONFLICT",
                message="active descriptor contains duplicate full contribution ids",
                plugin_id=plugin_id,
                entrypoint_id=entrypoint_id,
            )
        retained = {
            full_id: item
            for full_id, item in self._items.items()
            if item.owner_key != owner
        }
        conflicts = sorted(full_id for full_id in candidate_ids if full_id in retained)
        if conflicts:
            raise PlatformHostRequestError(
                code="PLUGIN_PLATFORM_CONTRIBUTION_CONFLICT",
                message="contribution ids are already owned by another active entrypoint",
                plugin_id=plugin_id,
                entrypoint_id=entrypoint_id,
                details={"conflicts": conflicts},
            )
        retained.update((item.full_id, item) for item in candidates)
        self._items = retained
        self._owner_generations[owner] = generation
        return tuple(candidates)

    def remove_owner(
        self,
        *,
        plugin_id: str,
        entrypoint_id: str,
        generation: int,
    ) -> bool:
        owner = (plugin_id, entrypoint_id)
        if self._owner_generations.get(owner) != generation:
            return False
        self._items = {
            full_id: item
            for full_id, item in self._items.items()
            if item.owner_key != owner
        }
        return True

    def resolve(self, full_id: str) -> RegisteredContribution:
        item = self._items.get(full_id)
        if item is None:
            raise PlatformHostRequestError(
                code="PLUGIN_PLATFORM_CONTRIBUTION_NOT_FOUND",
                message=f"contribution {full_id!r} is not active",
                details={"contributionId": full_id},
            )
        return item

    def snapshot(self) -> list[dict[str, Any]]:
        return [self._items[key].to_wire() for key in sorted(self._items)]

    def registrations(self) -> tuple[RegisteredContribution, ...]:
        return tuple(self._items[key] for key in sorted(self._items))

    def clear(self) -> None:
        self._items.clear()
