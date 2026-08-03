"""Strict Runtime Provider lookup owned by the Plugin Platform Host."""

from __future__ import annotations

import os
import re
from collections.abc import Iterable

from .base import RUNTIME_PROVIDER_API_VERSION, RuntimeProvider, RuntimeProviderError
from .java import JAVA_RUNTIME_ENABLED_ENV, JavaJarProvider
from .native import NativeExecutableProvider
from .node import NODE_RUNTIME_ENABLED_ENV, NodeModuleProvider
from .python import PythonModuleProvider


_KIND = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
NATIVE_RUNTIME_ENABLED_ENV = "CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED"


class RuntimeProviderRegistry:
    def __init__(self, providers: Iterable[RuntimeProvider]) -> None:
        by_kind: dict[str, RuntimeProvider] = {}
        for provider in providers:
            kind = getattr(provider, "kind", None)
            version = getattr(provider, "provider_version", None)
            api_version = getattr(provider, "api_version", None)
            if not isinstance(kind, str) or _KIND.fullmatch(kind) is None:
                raise RuntimeProviderError(
                    "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                    "Runtime Provider kind is invalid",
                )
            if not isinstance(version, str) or _VERSION.fullmatch(version) is None:
                raise RuntimeProviderError(
                    "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE",
                    "Runtime Provider version is invalid",
                    details={"runtimeKind": kind},
                )
            if api_version != RUNTIME_PROVIDER_API_VERSION:
                raise RuntimeProviderError(
                    "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE",
                    "Runtime Provider API version is incompatible with this Host",
                    details={
                        "runtimeKind": kind,
                        "expectedApiVersion": RUNTIME_PROVIDER_API_VERSION,
                        "actualApiVersion": api_version,
                    },
                )
            required_methods = (
                "validate_runtime",
                "prepare_installation",
                "verify_installation",
                "prepare_runtime",
                "build_probe_launch",
                "build_runtime_launch",
            )
            if not all(
                callable(getattr(provider, name, None)) for name in required_methods
            ):
                raise RuntimeProviderError(
                    "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                    "Runtime Provider does not implement the complete Host contract",
                    details={"runtimeKind": kind},
                )
            if kind in by_kind:
                raise RuntimeProviderError(
                    "PLUGIN_RUNTIME_PROVIDER_DUPLICATE",
                    "more than one Runtime Provider registered the same kind",
                    details={"runtimeKind": kind},
                )
            by_kind[kind] = provider
        self._by_kind = by_kind

    @property
    def kinds(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_kind))

    def get(self, runtime_kind: str) -> RuntimeProvider:
        provider = self._by_kind.get(runtime_kind)
        if provider is None:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
                "no compatible Runtime Provider is registered for this kind",
                details={"runtimeKinds": [runtime_kind]},
            )
        return provider

    def resolve(self, runtime: object) -> RuntimeProvider:
        runtime_kind = getattr(runtime, "kind", None)
        if not isinstance(runtime_kind, str):
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "runtime descriptor does not declare a valid kind",
            )
        provider = self.get(runtime_kind)
        provider.validate_runtime(runtime)
        return provider


def _provider_enabled(value: bool | None, *, environment_name: str, label: str) -> bool:
    if value is not None:
        if not isinstance(value, bool):
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                f"{label} Runtime Provider enablement must be a boolean",
            )
        return value
    raw = os.environ.get(environment_name)
    if raw is None:
        return False
    normalized = raw.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeProviderError(
        "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
        f"{environment_name} must be one of 0/1/false/true/no/yes/off/on",
    )


def default_runtime_provider_registry(
    *,
    native_enabled: bool | None = None,
    java_enabled: bool | None = None,
    node_enabled: bool | None = None,
    managed_runtime_registry: object | None = None,
) -> RuntimeProviderRegistry:
    providers: list[RuntimeProvider] = [PythonModuleProvider()]
    if _provider_enabled(
        native_enabled,
        environment_name=NATIVE_RUNTIME_ENABLED_ENV,
        label="native",
    ):
        providers.append(NativeExecutableProvider())
    if _provider_enabled(
        java_enabled,
        environment_name=JAVA_RUNTIME_ENABLED_ENV,
        label="Java",
    ):
        providers.append(JavaJarProvider(managed_runtime_registry))
    if _provider_enabled(
        node_enabled,
        environment_name=NODE_RUNTIME_ENABLED_ENV,
        label="Node.js",
    ):
        providers.append(NodeModuleProvider(managed_runtime_registry))
    return RuntimeProviderRegistry(providers)
