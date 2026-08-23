"""In-memory activation manager for the Phase 2 Plugin Platform slice."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping
from typing import Any

from candlescope_plugin_sdk.platform_v2 import CapabilityGrant

from app.plugin_security_v2.grants import EffectiveGrant

from app.plugin_host import (
    EntrypointSupervisor,
    PlatformHostError,
    PlatformHostRequestError,
    PlatformHostStateError,
)

from .contributions import ContributionRegistry, OwnerKey


class PluginManager:
    """Own v2 supervisors and publish only successfully activated generations."""

    def __init__(
        self,
        supervisors: Iterable[EntrypointSupervisor],
        *,
        activation_capabilities: Mapping[OwnerKey, tuple[CapabilityGrant, ...]]
        | None = None,
    ) -> None:
        values = tuple(supervisors)
        by_owner = {item.owner_key: item for item in values}
        if len(by_owner) != len(values):
            raise ValueError("supervisor owner keys must be unique")
        self._supervisors = by_owner
        self._activation_capabilities = dict(activation_capabilities or {})
        unknown = sorted(set(self._activation_capabilities) - set(by_owner))
        if unknown:
            raise ValueError(
                f"activation capabilities reference unknown owners: {unknown}"
            )
        self.contributions = ContributionRegistry()
        self._activation_failures: dict[OwnerKey, dict[str, Any]] = {}
        self._lifecycle_lock = asyncio.Lock()
        self._started = False

    async def start(self) -> None:
        async with self._lifecycle_lock:
            if self._started:
                return
            activated: list[tuple[EntrypointSupervisor, int]] = []
            try:
                for owner in sorted(self._supervisors):
                    supervisor = self._supervisors[owner]
                    if not supervisor.spec.enabled or not supervisor.spec.auto_start:
                        continue
                    try:
                        await self._activate_supervisor(
                            supervisor,
                            self._activation_capabilities.get(owner, ()),
                        )
                        activated.append((supervisor, supervisor.generation))
                    except PlatformHostError as exc:
                        self._activation_failures[owner] = exc.to_dict()
                        await supervisor.stop()
                        if supervisor.spec.required:
                            raise PlatformHostStateError(
                                code="PLUGIN_PLATFORM_REQUIRED_START_FAILED",
                                message=(
                                    f"required entrypoint {supervisor.plugin_id!r}/"
                                    f"{supervisor.entrypoint_id!r} failed to activate"
                                ),
                                plugin_id=supervisor.plugin_id,
                                entrypoint_id=supervisor.entrypoint_id,
                                details={"cause": exc.to_dict()},
                            ) from exc
                        # Optional failures remain local and observable.
                self._started = True
            except BaseException:
                for supervisor, generation in reversed(activated):
                    self.contributions.remove_owner(
                        plugin_id=supervisor.plugin_id,
                        entrypoint_id=supervisor.entrypoint_id,
                        generation=generation,
                    )
                    await supervisor.stop()
                raise

    async def activate(
        self,
        plugin_id: str,
        entrypoint_id: str,
        *,
        capabilities: tuple[CapabilityGrant, ...] | None = None,
        effective_grants: tuple[EffectiveGrant, ...] | None = None,
    ) -> None:
        async with self._lifecycle_lock:
            supervisor = self._supervisor((plugin_id, entrypoint_id))
            selected = (
                capabilities
                if capabilities is not None
                else self._activation_capabilities.get(supervisor.owner_key, ())
            )
            if capabilities is not None and effective_grants is not None:
                raise ValueError("capabilities and effective_grants must not be mixed")
            try:
                await self._activate_supervisor(
                    supervisor,
                    tuple(selected),
                    effective_grants=tuple(effective_grants or ()),
                )
            except PlatformHostError as exc:
                self._activation_failures[supervisor.owner_key] = exc.to_dict()
                await supervisor.stop()
                raise
            self._started = True

    async def add_supervisors(
        self, supervisors: Iterable[EntrypointSupervisor]
    ) -> None:
        """Add a newly active installation without disturbing other plugins."""

        values = tuple(supervisors)
        additions = {item.owner_key: item for item in values}
        if len(additions) != len(values):
            raise ValueError("added supervisor owner keys must be unique")
        async with self._lifecycle_lock:
            conflicts = sorted(set(additions) & set(self._supervisors))
            if conflicts:
                raise ValueError(
                    f"supervisor owner keys are already registered: {conflicts}"
                )
            self._supervisors.update(additions)

    async def remove_plugin(self, plugin_id: str) -> int:
        """Stop and forget every owner for one plugin generation."""

        async with self._lifecycle_lock:
            owners = sorted(
                (owner for owner in self._supervisors if owner[0] == plugin_id),
                reverse=True,
            )
            registrations = tuple(
                item
                for item in self.contributions.registrations()
                if item.plugin_id == plugin_id
            )
            for registration in registrations:
                self.contributions.remove_owner(
                    plugin_id=registration.plugin_id,
                    entrypoint_id=registration.entrypoint_id,
                    generation=registration.generation,
                )
            for owner in owners:
                supervisor = self._supervisors.pop(owner)
                await supervisor.stop()
                self.contributions.forget_owner(
                    plugin_id=owner[0], entrypoint_id=owner[1]
                )
                self._activation_capabilities.pop(owner, None)
                self._activation_failures.pop(owner, None)
            return len(owners)

    async def _activate_supervisor(
        self,
        supervisor: EntrypointSupervisor,
        capabilities: tuple[CapabilityGrant, ...],
        *,
        effective_grants: tuple[EffectiveGrant, ...] = (),
    ) -> None:
        descriptor = await supervisor.activate(
            capabilities,
            effective_grants=effective_grants,
        )
        try:
            self.contributions.replace_owner(
                plugin_id=supervisor.plugin_id,
                entrypoint_id=supervisor.entrypoint_id,
                generation=supervisor.generation,
                contributions=descriptor.contributions,
            )
            self._activation_failures.pop(supervisor.owner_key, None)
        except BaseException:
            await supervisor.deactivate("Contribution registration failed")
            raise

    async def deactivate(
        self,
        plugin_id: str,
        entrypoint_id: str,
        *,
        reason: str,
    ) -> None:
        async with self._lifecycle_lock:
            supervisor = self._supervisor((plugin_id, entrypoint_id))
            generation = supervisor.generation
            try:
                await supervisor.deactivate(reason)
            finally:
                if (
                    supervisor.state not in {"active", "quiescing"}
                    or supervisor.generation != generation
                ):
                    self.contributions.remove_owner(
                        plugin_id=plugin_id,
                        entrypoint_id=entrypoint_id,
                        generation=generation,
                    )

    async def invoke(
        self,
        full_contribution_id: str,
        input_value: dict[str, Any],
        *,
        user_action: bool,
        trace_id: str,
        locale: str | None = None,
    ) -> dict[str, Any]:
        registration = self.contributions.resolve(full_contribution_id)
        supervisor = self._supervisor(registration.owner_key)
        if (
            supervisor.state != "active"
            or supervisor.generation != registration.generation
        ):
            self.contributions.remove_owner(
                plugin_id=registration.plugin_id,
                entrypoint_id=registration.entrypoint_id,
                generation=registration.generation,
            )
            raise PlatformHostStateError(
                code="PLUGIN_PLATFORM_STALE_GENERATION",
                message="contribution registration belongs to a stale generation",
                plugin_id=registration.plugin_id,
                entrypoint_id=registration.entrypoint_id,
            )
        try:
            return await supervisor.invoke(
                registration.descriptor.id,
                input_value,
                user_action=user_action,
                trace_id=trace_id,
                locale=locale,
            )
        finally:
            if (
                supervisor.state != "active"
                or supervisor.generation != registration.generation
            ):
                self.contributions.remove_owner(
                    plugin_id=registration.plugin_id,
                    entrypoint_id=registration.entrypoint_id,
                    generation=registration.generation,
                )

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            self.contributions.clear()
            for owner in reversed(sorted(self._supervisors)):
                await self._supervisors[owner].stop()
            self._started = False

    def _supervisor(self, owner: OwnerKey) -> EntrypointSupervisor:
        supervisor = self._supervisors.get(owner)
        if supervisor is None:
            raise PlatformHostRequestError(
                code="PLUGIN_PLATFORM_ENTRYPOINT_NOT_FOUND",
                message=f"entrypoint {owner[0]!r}/{owner[1]!r} is not registered",
                plugin_id=owner[0],
                entrypoint_id=owner[1],
            )
        return supervisor

    def supervisor(self, plugin_id: str, entrypoint_id: str) -> EntrypointSupervisor:
        return self._supervisor((plugin_id, entrypoint_id))

    def owner_keys(self) -> tuple[OwnerKey, ...]:
        return tuple(sorted(self._supervisors))

    def health_summary(self) -> dict[str, Any]:
        self._prune_stale_contributions()
        snapshots = {
            owner: supervisor.snapshot()
            for owner, supervisor in self._supervisors.items()
        }
        enabled = {owner: item for owner, item in snapshots.items() if item["enabled"]}
        active = sum(item["state"] == "active" for item in enabled.values())
        failed = sum(
            item["state"] == "failed" or owner in self._activation_failures
            for owner, item in enabled.items()
        )
        return {
            "status": "degraded" if failed else "ok",
            "configured": len(snapshots),
            "enabled": len(enabled),
            "active": active,
            "failed": failed,
            "contributions": len(self.contributions.snapshot()),
        }

    def diagnostics(self, *, include_stderr: bool = False) -> dict[str, Any]:
        self._prune_stale_contributions()
        return {
            "schemaVersion": 1,
            "started": self._started,
            "contributions": self.contributions.snapshot(),
            "activationFailures": [
                {
                    "pluginId": owner[0],
                    "entrypointId": owner[1],
                    "cause": dict(self._activation_failures[owner]),
                }
                for owner in sorted(self._activation_failures)
            ],
            "entrypoints": [
                self._supervisors[owner].snapshot(include_stderr=include_stderr)
                for owner in sorted(self._supervisors)
            ],
        }

    def _prune_stale_contributions(self) -> None:
        for registration in self.contributions.registrations():
            supervisor = self._supervisors.get(registration.owner_key)
            if supervisor is None:
                self.contributions.remove_owner(
                    plugin_id=registration.plugin_id,
                    entrypoint_id=registration.entrypoint_id,
                    generation=registration.generation,
                )
                continue
            if (
                supervisor.state != "active"
                or supervisor.generation != registration.generation
            ):
                self.contributions.remove_owner(
                    plugin_id=registration.plugin_id,
                    entrypoint_id=registration.entrypoint_id,
                    generation=registration.generation,
                )
