"""Backend descriptor for the Phase 8 isolated Sandbox View reference plugin."""

from __future__ import annotations

from importlib.resources import files

from ..errors import PlatformContractError
from ..json_codec import loads_strict
from ..models import InvokeRequest, PluginManifest, RuntimeDescriptor, descriptor_from_manifest
from ..runtime import BasePlatformPlugin, InvocationOutcome
from ..server import serve_platform_plugin


def sandbox_view_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("sandbox-view.manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


class SandboxViewPlugin(BasePlatformPlugin):
    """A lazy descriptor sidecar; the sandbox UI has no backend capabilities."""

    def __init__(self) -> None:
        self._manifest = sandbox_view_manifest()

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        raise PlatformContractError(
            "INVALID_CONTRACT",
            "Sandbox View exposes no invokable backend contribution",
            f"invoke.{request.contribution_id}",
        )

    def health_check(self) -> dict[str, object]:
        return {"status": "ready", "backendCapabilities": 0}


def main() -> int:
    return serve_platform_plugin(SandboxViewPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
