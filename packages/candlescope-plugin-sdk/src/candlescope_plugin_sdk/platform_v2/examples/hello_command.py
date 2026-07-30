"""Minimal command plugin proving the additive Plugin Platform v2 contract."""

from __future__ import annotations

from importlib.resources import files

from ..errors import PlatformContractError
from ..json_codec import loads_strict
from ..models import (
    InvokeRequest,
    PluginManifest,
    RuntimeDescriptor,
    descriptor_from_manifest,
)
from ..runtime import BasePlatformPlugin, DeferredInvocation, InvocationOutcome
from ..server import serve_platform_plugin


def hello_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("hello-command.manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


class HelloCommandPlugin(BasePlatformPlugin):
    def __init__(self) -> None:
        self._manifest = hello_manifest()
        self._pending_tokens: set[str] = set()

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        unknown = sorted(set(request.input) - {"name", "defer"})
        if unknown:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "hello input contains unknown fields: " + ", ".join(unknown),
                "invoke.input",
            )
        name = request.input.get("name", "world")
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "hello input name must be a non-empty string of at most 80 characters",
                "invoke.input.name",
            )
        defer = request.input.get("defer", False)
        if not isinstance(defer, bool):
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "hello input defer must be a boolean",
                "invoke.input.defer",
            )
        if defer:
            token = f"hello:{request.request_context.trace_id}"
            self._pending_tokens.add(token)
            return DeferredInvocation(token)
        return {
            "message": f"Hello, {name.strip()}!",
            "contributionId": request.contribution_id,
        }

    def cancel(self, token: str) -> None:
        self._pending_tokens.discard(token)

    def health_check(self) -> dict[str, object]:
        return {"status": "ready", "pending": len(self._pending_tokens)}


def main() -> int:
    return serve_platform_plugin(HelloCommandPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
