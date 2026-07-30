"""Host-owned registry and lifecycle service for script runtime plugins."""

from __future__ import annotations

from typing import Any

from candlescope_plugin_sdk import (
    AnalyzeRequest,
    AnalyzeResult,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    RuntimeDescriptor,
)

from .errors import PluginHostError, PluginRequestError
from .registry import RUNTIME_REGISTRY_SCHEMA_VERSION, RuntimeRegistry
from .supervisor import STATE_FAILED, STATE_READY, RuntimeSupervisor


class RuntimeHostService:
    """Own the runtime registry while keeping indicator routing out of Phase 2."""

    def __init__(
        self,
        registry: RuntimeRegistry,
        *,
        host_name: str,
        host_version: str,
        enabled: bool = True,
    ) -> None:
        self.registry = registry
        self.host_name = host_name
        self.host_version = host_version
        self.enabled = enabled
        self._supervisors = {
            spec.runtime_id: RuntimeSupervisor(
                spec,
                host_name=host_name,
                host_version=host_version,
            )
            for spec in registry.plugins
        }
        self._started = False

    @classmethod
    def disabled(cls, *, host_name: str, host_version: str) -> "RuntimeHostService":
        return cls(
            RuntimeRegistry(),
            host_name=host_name,
            host_version=host_version,
            enabled=False,
        )

    async def start(self) -> None:
        if not self.enabled:
            self._started = True
            return
        started: list[RuntimeSupervisor] = []
        try:
            for supervisor in self._supervisors.values():
                if not supervisor.spec.enabled or not supervisor.spec.auto_start:
                    continue
                try:
                    await supervisor.start()
                    started.append(supervisor)
                except PluginHostError as exc:
                    if supervisor.spec.required:
                        raise PluginHostError(
                            code="PLUGIN_REQUIRED_START_FAILED",
                            message=(
                                f"required runtime {supervisor.runtime_id!r} "
                                f"failed to start: {exc.message}"
                            ),
                            runtime_id=supervisor.runtime_id,
                            details={"cause": exc.to_dict()},
                        ) from exc
                    # Optional runtimes remain visible as failed diagnostics.
            self._started = True
        except BaseException:
            for supervisor in reversed(started):
                await supervisor.stop()
            raise

    async def stop(self) -> None:
        for supervisor in reversed(tuple(self._supervisors.values())):
            await supervisor.stop()
        self._started = False

    async def descriptor(self, runtime_id: str) -> RuntimeDescriptor:
        return await self._supervisor(runtime_id).descriptor()

    async def analyze(
        self,
        runtime_id: str,
        request: AnalyzeRequest,
    ) -> AnalyzeResult:
        return await self._supervisor(runtime_id).analyze(request)

    async def execute_batch(
        self,
        runtime_id: str,
        request: ExecuteBatchRequest,
    ) -> ExecuteBatchResult:
        return await self._supervisor(runtime_id).execute_batch(request)

    def _supervisor(self, runtime_id: str) -> RuntimeSupervisor:
        if not self.enabled:
            raise PluginRequestError(
                code="PLUGIN_HOST_DISABLED",
                message="runtime plugin host is disabled",
                runtime_id=runtime_id,
            )
        supervisor = self._supervisors.get(runtime_id)
        if supervisor is None:
            raise PluginRequestError(
                code="PLUGIN_NOT_FOUND",
                message=f"runtime {runtime_id!r} is not registered",
                runtime_id=runtime_id,
            )
        if not supervisor.spec.enabled:
            raise PluginRequestError(
                code="PLUGIN_DISABLED",
                message=f"runtime {runtime_id!r} is disabled",
                runtime_id=runtime_id,
            )
        return supervisor

    def health_summary(self) -> dict[str, Any]:
        if not self.enabled:
            return {
                "status": "disabled",
                "configured": 0,
                "enabled": 0,
                "ready": 0,
                "failed": 0,
            }
        snapshots = [supervisor.snapshot() for supervisor in self._supervisors.values()]
        enabled = [snapshot for snapshot in snapshots if snapshot["enabled"]]
        failed = sum(snapshot["state"] == STATE_FAILED for snapshot in enabled)
        ready = sum(snapshot["state"] == STATE_READY for snapshot in enabled)
        return {
            "status": "degraded" if failed else "ok",
            "configured": len(snapshots),
            "enabled": len(enabled),
            "ready": ready,
            "failed": failed,
        }

    def diagnostics(self, *, include_stderr: bool = False) -> dict[str, Any]:
        return {
            "schemaVersion": RUNTIME_REGISTRY_SCHEMA_VERSION,
            "host": {
                "name": self.host_name,
                "version": self.host_version,
                "enabled": self.enabled,
                "started": self._started,
            },
            "registrySource": (
                str(self.registry.source) if self.registry.source is not None else None
            ),
            "runtimes": [
                supervisor.snapshot(include_stderr=include_stderr)
                for supervisor in self._supervisors.values()
            ],
        }
