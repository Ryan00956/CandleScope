"""Host-managed Node.js ESM Runtime Provider.

Node plugins are shipped as immutable, pre-built module graphs. The Host never
invokes npm, npx, corepack, package-manager lifecycle scripts, a compiler, or a
loader hook while installing, probing, or running a plugin.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from candlescope_plugin_sdk.platform_v2 import NodeModuleRuntime, canonical_sha256

from .base import (
    RUNTIME_PROVIDER_API_VERSION,
    InstallCommandRunner,
    PreparedLaunch,
    PreparedRuntime,
    RuntimeArtifact,
    RuntimeInstallationRequest,
    RuntimeProviderBinding,
    RuntimeProviderError,
    RuntimeSupplyBinding,
    SandboxRuntime,
)


NODE_MODULE_PROVIDER_VERSION = "1.0.0"
NODE_RUNTIME_ENABLED_ENV = "CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED"
_MAX_MAIN_BYTES = 32 * 1024 * 1024
_MAX_MODULE_BYTES = 32 * 1024 * 1024
_MAX_MODULE_GRAPH_BYTES = 128 * 1024 * 1024
_MAX_MODULE_GRAPH_FILES = 10_000
_MAX_SOURCE_MAP_BYTES = 16 * 1024 * 1024
_NODE_MEMORY = re.compile(r"^--max-old-space-size=(?P<size>[0-9]{2,4})$")
_STATIC_SPECIFIER = re.compile(
    r"(?mx)"
    r"(?:^|[;}]|\n)\s*(?:"
    r"import\s+(?:[^\n;]*?\s+from\s+)?|"
    r"export\s+[^\n;]*?\s+from\s+"
    r")[\"'](?P<specifier>[^\"']+)[\"']"
)
_DYNAMIC_IMPORT = re.compile(r"\bimport(?:\s|/\*.*?\*/|//[^\n]*(?:\n|$))*\(", re.DOTALL)
_OBSCURED_MODULE_KEYWORD = re.compile(r"\b(?:import|from)\s*/[*/]")
_DISCOVERED_SPECIFIER = re.compile(
    r"\b(?:import|from)\s*[\"'](?P<specifier>[^\"']+)[\"']"
)
_SOURCE_MAP = re.compile(r"(?m)^[ \t]*//[@#][ \t]*sourceMappingURL=(?P<url>\S+)[ \t]*$")
_WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[/\\]")


def _provider_error(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
) -> RuntimeProviderError:
    return RuntimeProviderError(code, message, details=details)


def _digest(path: Path) -> tuple[str, int]:
    value = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                value.update(chunk)
                size += len(chunk)
                if size > _MAX_MAIN_BYTES:
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_LIMIT_EXCEEDED",
                        "Node.js entry module exceeds the Host size limit",
                    )
    except RuntimeProviderError:
        raise
    except OSError as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Node.js entry module could not be read",
            details={"errorType": type(exc).__name__},
        ) from exc
    return f"sha256:{value.hexdigest()}", size


def _strict_text(path: Path, *, maximum: int = _MAX_MODULE_BYTES) -> str:
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Node.js module graph could not be read",
            details={"path": path.name, "errorType": type(exc).__name__},
        ) from exc
    if not payload or len(payload) > maximum:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_LIMIT_EXCEEDED",
            "Node.js module graph contains an empty or oversized text file",
            details={"path": path.name},
        )
    try:
        return payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Node.js modules and source maps must be strict UTF-8",
            details={"path": path.name},
        ) from exc


def _json_no_duplicates(payload: str, *, label: str) -> dict[str, Any]:
    def pairs(values: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in values:
            if key in result:
                raise ValueError("duplicate object key")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite number {value}")

    try:
        value = json.loads(
            payload,
            object_pairs_hook=pairs,
            parse_constant=reject_constant,
        )
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            f"{label} is not strict JSON",
        ) from exc
    if not isinstance(value, dict):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            f"{label} must be a JSON object",
        )
    return value


def _safe_source_name(value: Any, *, label: str) -> None:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 4096:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            f"{label} contains an invalid source path",
        )
    path = PurePosixPath(value)
    lowered = value.casefold()
    if (
        "\\" in value
        or path.is_absolute()
        or ".." in path.parts
        or "." in path.parts
        or _WINDOWS_ABSOLUTE.match(value)
        or "://" in lowered
        or lowered.startswith(("file:", "webpack:", "http:", "https:"))
    ):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            f"{label} leaks an absolute, parent, or URI source path",
            details={"source": value[:256]},
        )


def _validate_source_map_value(value: dict[str, Any], *, label: str) -> None:
    if value.get("version") != 3:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            f"{label} must use source-map version 3",
        )
    sources = value.get("sources")
    if not isinstance(sources, list) or len(sources) > 10_000:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_LIMIT_EXCEEDED",
            f"{label} sources exceed the Host limit",
        )
    for source in sources:
        _safe_source_name(source, label=label)
    source_root = value.get("sourceRoot")
    if source_root not in (None, ""):
        _safe_source_name(source_root, label=f"{label}.sourceRoot")
    sources_content = value.get("sourcesContent")
    if sources_content is not None and (
        not isinstance(sources_content, list)
        or len(sources_content) != len(sources)
        or any(
            item is not None and not isinstance(item, str) for item in sources_content
        )
    ):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            f"{label}.sourcesContent does not match sources",
        )


def _validate_source_map(
    mapping_url: str,
    *,
    module: Path,
    content_root: Path,
) -> None:
    label = f"source map for {module.name}"
    if mapping_url.startswith("data:application/json;base64,"):
        encoded = mapping_url.removeprefix("data:application/json;base64,")
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                f"{label} has invalid base64",
            ) from exc
        if not payload or len(payload) > _MAX_SOURCE_MAP_BYTES:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_LIMIT_EXCEEDED",
                f"{label} exceeds the Host limit",
            )
        try:
            text = payload.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                f"{label} must be strict UTF-8",
            ) from exc
    else:
        if (
            not mapping_url
            or "\\" in mapping_url
            or "?" in mapping_url
            or "#" in mapping_url
            or "%" in mapping_url
            or ":" in mapping_url
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                f"{label} URL is outside the immutable bundle",
            )
        try:
            mapping = module.parent.joinpath(*PurePosixPath(mapping_url).parts).resolve(
                strict=True
            )
            source_maps = (content_root / "source-maps").resolve(strict=True)
        except OSError as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                f"{label} file is unavailable",
            ) from exc
        if (
            source_maps not in mapping.parents
            or mapping.suffix.casefold() != ".map"
            or mapping.is_symlink()
            or not mapping.is_file()
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                f"{label} must resolve under content/source-maps",
            )
        text = _strict_text(mapping, maximum=_MAX_SOURCE_MAP_BYTES)
    _validate_source_map_value(_json_no_duplicates(text, label=label), label=label)


def _resolve_relative_module(
    specifier: str, *, module: Path, module_root: Path
) -> Path:
    if (
        "\\" in specifier
        or "?" in specifier
        or "#" in specifier
        or "%" in specifier
        or "\0" in specifier
    ):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Node.js ESM import contains a non-portable path",
            details={"specifier": specifier[:256]},
        )
    pure = PurePosixPath(specifier)
    try:
        target = module.parent.joinpath(*pure.parts).resolve(strict=True)
    except OSError as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Node.js ESM import target is missing",
            details={"specifier": specifier[:256]},
        ) from exc
    if (
        module_root not in target.parents
        or target.is_symlink()
        or not target.is_file()
        or target.suffix.casefold() != ".mjs"
    ):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Node.js ESM imports must resolve to .mjs files under the runtime directory",
            details={"specifier": specifier[:256]},
        )
    return target


def _inspect_module_graph(
    artifact: RuntimeArtifact | None,
    *,
    main: Path,
    expected_sha256: str,
    content_root: Path,
) -> tuple[str, int, int, int, frozenset[Path]]:
    actual_sha256, actual_size = _digest(main)
    if actual_sha256 != expected_sha256 or (
        artifact is not None
        and (actual_sha256, actual_size) != (artifact.sha256, artifact.size)
    ):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
            "Node.js entry module digest or size does not match its immutable inventory",
            details={"artifact": artifact.relative_path if artifact else main.name},
        )
    try:
        module_root = (content_root / "runtime").resolve(strict=True)
    except OSError as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Node.js runtime module directory is unavailable",
        ) from exc
    if module_root not in main.parents or main.suffix.casefold() != ".mjs":
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
            "Node.js Provider v1 accepts only ESM .mjs entry modules under runtime/",
        )
    pending = [main]
    visited: set[Path] = set()
    total = 0
    while pending:
        module = pending.pop()
        if module in visited:
            continue
        visited.add(module)
        if len(visited) > _MAX_MODULE_GRAPH_FILES:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_LIMIT_EXCEEDED",
                "Node.js ESM graph exceeds the Host file-count limit",
            )
        text = _strict_text(module)
        total += len(text.encode("utf-8"))
        if total > _MAX_MODULE_GRAPH_BYTES:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_LIMIT_EXCEEDED",
                "Node.js ESM graph exceeds the Host total-size limit",
            )
        if _DYNAMIC_IMPORT.search(text):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                "Node.js Provider v1 rejects dynamic import; bundle imports statically",
                details={"module": module.name},
            )
        if _OBSCURED_MODULE_KEYWORD.search(text):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                "Node.js Provider v1 rejects comment-obscured module syntax",
                details={"module": module.name},
            )
        maps = list(_SOURCE_MAP.finditer(text))
        if len(maps) > 1:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                "Node.js module declares more than one source map",
                details={"module": module.name},
            )
        if maps:
            _validate_source_map(
                maps[0].group("url"), module=module, content_root=content_root
            )
        static_matches = list(_STATIC_SPECIFIER.finditer(text))
        if sorted(match.group("specifier") for match in static_matches) != sorted(
            match.group("specifier") for match in _DISCOVERED_SPECIFIER.finditer(text)
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                "Node.js Provider v1 requires canonical static module syntax",
                details={"module": module.name},
            )
        for match in static_matches:
            specifier = match.group("specifier")
            if specifier.startswith("node:"):
                continue
            if not specifier.startswith(("./", "../")):
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                    "Node.js Provider v1 requires bare packages to be bundled into relative ESM",
                    details={"specifier": specifier[:256]},
                )
            pending.append(
                _resolve_relative_module(
                    specifier,
                    module=module,
                    module_root=module_root,
                )
            )
    return actual_sha256, actual_size, len(visited), total, frozenset(visited)


def _validate_node_args(values: tuple[str, ...]) -> None:
    seen: set[str] = set()
    for value in values:
        if value == "--enable-source-maps":
            key = "source-maps"
        else:
            match = _NODE_MEMORY.fullmatch(value)
            if match is None:
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                    "node-module nodeArgs contain an option outside the Host allowlist",
                    details={"argument": value},
                )
            size = int(match.group("size"))
            if not 64 <= size <= 384:
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                    "node-module heap option is outside the restricted-node-v1 envelope",
                    details={"argument": value},
                )
            key = "heap"
        if key in seen:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "node-module nodeArgs contain a duplicate policy option",
                details={"argument": value},
            )
        seen.add(key)


def _runtime_identity(runtime_id: str, supply: RuntimeSupplyBinding) -> str:
    return canonical_sha256(
        {
            "runtimeKind": "node-module",
            "runtimeId": runtime_id,
            "providerVersion": NODE_MODULE_PROVIDER_VERSION,
            "runtimeSupply": supply.to_wire(),
            "policy": {
                "moduleFormat": "esm-mjs-v1",
                "moduleGraph": "static-relative-or-node-v1",
                "sourceMaps": "inline-or-content-source-maps-v1",
                "nodeArgs": "host-allowlist-v1",
                "permissionModel": "node-permission-v1",
                "globalSearchPaths": False,
                "nativeAddons": False,
                "childProcesses": False,
                "workers": False,
                "packageManagerAtRuntime": False,
                "processTree": "host-managed-v1",
                "searchPath": "isolated-v1",
                "maxProcesses": 1,
            },
        }
    )


class NodeModuleProvider:
    api_version = RUNTIME_PROVIDER_API_VERSION
    kind = "node-module"
    provider_version = NODE_MODULE_PROVIDER_VERSION

    def __init__(self, managed_runtime_registry: Any) -> None:
        if managed_runtime_registry is None or not callable(
            getattr(managed_runtime_registry, "ensure", None)
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_CONFIGURATION_INVALID",
                "NodeModuleProvider requires the Host-managed Runtime Registry",
            )
        self._managed_runtime_registry = managed_runtime_registry

    def validate_runtime(self, runtime: object) -> None:
        if not isinstance(runtime, NodeModuleRuntime):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "NodeModuleProvider received a non-Node runtime descriptor",
            )
        if PurePosixPath(runtime.artifact).suffix.casefold() != ".mjs":
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "Node.js Provider v1 supports ESM .mjs entry modules only",
            )
        _validate_node_args(runtime.node_args)

    @staticmethod
    def _validate_request(request: RuntimeInstallationRequest) -> None:
        if not request.artifacts:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "node-module installation requires a declared Node bundle artifact",
            )
        if request.wheel_paths or request.distributions:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "node-module installation must not receive Python packages",
            )
        if any(item.role != "node-bundle" for item in request.artifacts):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "NodeModuleProvider received a wrongly typed artifact",
            )
        if not request.entry_artifacts:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "node-module installation requires an immutable ESM entry artifact",
            )

    def _ensure(self, runtime_id: str, *, offline: bool) -> Any:
        try:
            ensured = self._managed_runtime_registry.ensure(
                runtime_id,
                "node",
                offline=offline,
            )
        except Exception as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_SUPPLY_UNAVAILABLE",
                "exact Host-managed Node.js runtime could not be resolved and verified",
                details={
                    "runtimeId": runtime_id,
                    "causeCode": getattr(exc, "code", type(exc).__name__),
                },
            ) from exc
        supply = getattr(ensured, "supply", None)
        executable = getattr(ensured, "executable", None)
        if (
            not isinstance(supply, RuntimeSupplyBinding)
            or supply.runtime_kind != "node"
            or supply.runtime_id != runtime_id
            or not isinstance(executable, Path)
            or executable.resolve(strict=False) != supply.executable
            or not executable.is_file()
            or executable.is_symlink()
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_SUPPLY_INVALID",
                "Host-managed Node.js result does not match the requested identity",
                details={"runtimeId": runtime_id},
            )
        if not supply.version.startswith("24.19.0"):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE",
                "Node.js Provider v1 requires the pinned 24.19.0 LTS runtime",
                details={"runtimeId": runtime_id, "version": supply.version},
            )
        return ensured

    def _bindings(
        self,
        request: RuntimeInstallationRequest,
        *,
        offline: bool,
    ) -> tuple[RuntimeProviderBinding, ...]:
        result: list[RuntimeProviderBinding] = []
        for runtime_id in sorted(request.runtime_ids):
            ensured = self._ensure(runtime_id, offline=offline)
            result.append(
                RuntimeProviderBinding(
                    runtime_kind=self.kind,
                    runtime_id=runtime_id,
                    provider_version=self.provider_version,
                    runtime_identity=_runtime_identity(runtime_id, ensured.supply),
                    runtime_supply=ensured.supply,
                )
            )
        return tuple(result)

    @staticmethod
    def _inspect_install_artifacts(request: RuntimeInstallationRequest) -> None:
        content_root = (request.installation / "content").resolve(strict=True)
        by_path = {item.relative_path: item for item in request.artifacts}
        reachable: set[Path] = set()
        for entry_path in request.entry_artifacts:
            artifact = by_path[entry_path]
            graph = _inspect_module_graph(
                artifact,
                main=artifact.path,
                expected_sha256=artifact.sha256,
                content_root=content_root,
            )
            reachable.update(graph[4])
        declared = {item.path.resolve(strict=True) for item in request.artifacts}
        if reachable != declared:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                "Node.js runtime inventory must equal the statically reachable ESM graph",
                details={
                    "unreachable": sorted(path.name for path in declared - reachable),
                    "missing": sorted(path.name for path in reachable - declared),
                },
            )

    def prepare_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        del run_command
        self._validate_request(request)
        bindings = self._bindings(request, offline=False)
        self._inspect_install_artifacts(request)
        return bindings

    def verify_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        del run_command
        self._validate_request(request)
        bindings = self._bindings(request, offline=True)
        self._inspect_install_artifacts(request)
        return bindings

    def prepare_runtime(
        self,
        *,
        runtime: object,
        executable: Path,
        working_directory: Path,
        artifact_sha256: str | None,
    ) -> PreparedRuntime:
        self.validate_runtime(runtime)
        assert isinstance(runtime, NodeModuleRuntime)
        if artifact_sha256 is None:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
                "node-module activation has no immutable artifact digest",
            )
        try:
            working = Path(working_directory).resolve(strict=True)
            content_root = (working / "content").resolve(strict=True)
            expected = content_root.joinpath(
                *PurePosixPath(runtime.artifact).parts
            ).resolve(strict=True)
            module = Path(executable).resolve(strict=True)
        except OSError as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "Node.js launch target or working directory is unavailable",
                details={"artifact": runtime.artifact},
            ) from exc
        if module != expected or module.is_symlink() or not module.is_file():
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "Node.js launch target is not the declared immutable ESM module",
                details={"artifact": runtime.artifact},
            )
        ensured = self._ensure(runtime.runtime_id, offline=True)
        _inspect_module_graph(
            None,
            main=module,
            expected_sha256=artifact_sha256,
            content_root=content_root,
        )
        arguments = [
            "--permission",
            f"--allow-fs-read={working}",
            "--no-addons",
            "--no-global-search-paths",
            "--disallow-code-generation-from-strings",
            "--preserve-symlinks",
            "--preserve-symlinks-main",
            "--disable-proto=throw",
            "--unhandled-rejections=strict",
        ]
        if not any(
            item.startswith("--max-old-space-size=") for item in runtime.node_args
        ):
            arguments.append("--max-old-space-size=384")
        arguments.extend(runtime.node_args)
        arguments.append(str(module))
        return PreparedRuntime(
            runtime_kind=self.kind,
            runtime_id=runtime.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=_runtime_identity(runtime.runtime_id, ensured.supply),
            executable=ensured.executable,
            working_directory=working,
            artifact=module,
            arguments=tuple(arguments),
            artifact_sha256=artifact_sha256,
            runtime_supply=ensured.supply,
        )

    def _build_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None,
    ) -> PreparedLaunch:
        if sandbox_runtime is not None:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "node-module runtime must use its frozen Node.js supply",
            )
        if (
            prepared.runtime_kind != self.kind
            or prepared.artifact is None
            or prepared.runtime_supply is None
            or prepared.runtime_supply.runtime_kind != "node"
            or prepared.executable != prepared.runtime_supply.executable
            or not prepared.artifact.is_file()
            or prepared.artifact.is_symlink()
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "prepared node-module runtime is incomplete or has the wrong supply",
            )
        return PreparedLaunch(
            runtime_kind=self.kind,
            runtime_id=prepared.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=prepared.runtime_identity,
            executable=prepared.executable,
            arguments=prepared.arguments,
            working_directory=prepared.working_directory,
            manage_process_tree=True,
            isolated_search_path=True,
            max_processes=1,
        )

    def build_probe_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None = None,
    ) -> PreparedLaunch:
        return self._build_launch(prepared, sandbox_runtime=sandbox_runtime)

    def build_runtime_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None = None,
    ) -> PreparedLaunch:
        return self._build_launch(prepared, sandbox_runtime=sandbox_runtime)


__all__ = [
    "NODE_MODULE_PROVIDER_VERSION",
    "NODE_RUNTIME_ENABLED_ENV",
    "NodeModuleProvider",
]
