from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from candlescope_plugin_sdk.platform_v2 import NodeModuleRuntime

from app.plugin_core_v2.runtime_providers import (
    NODE_MODULE_PROVIDER_VERSION,
    NODE_RUNTIME_ENABLED_ENV,
    NodeModuleProvider,
    RuntimeArtifact,
    RuntimeInstallationRequest,
    RuntimeProviderError,
    RuntimeSupplyBinding,
    default_runtime_provider_registry,
)
from app.plugin_runtime_registry_v3 import (
    OFFICIAL_REGISTRY_V3_PATH,
    OFFICIAL_REGISTRY_V4_PATH,
    OFFICIAL_ROOTS_PATH,
    OFFICIAL_ROOTS_V3_PATH,
    load_runtime_registry_roots_bytes,
    verify_runtime_registry_bytes,
)


def _sha(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


class _ManagedNodeRegistry:
    def __init__(self, executable: Path) -> None:
        self.calls: list[tuple[str, str, bool]] = []
        self.supply = RuntimeSupplyBinding(
            source="host-managed",
            runtime_id="node-24.19.0",
            runtime_kind="node",
            version="24.19.0+LTS-Krypton",
            executable=executable,
            artifact_sha256="sha256:" + "1" * 64,
            artifact_size=37_304_352,
            probe_sha256="sha256:" + "2" * 64,
            verification_status="verified",
            reproducible=True,
            registry_id="candlescope.reference-runtime",
            registry_revision=4,
            registry_sha256="sha256:" + "3" * 64,
            source_url="https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip",
            license_spdx="MIT",
        )

    def ensure(self, runtime_id: str, kind: str, *, offline: bool = False) -> object:
        self.calls.append((runtime_id, kind, offline))
        return SimpleNamespace(supply=self.supply, executable=self.supply.executable)


def _fixture(
    tmp_path: Path,
) -> tuple[NodeModuleProvider, NodeModuleRuntime, Path, Path]:
    node = tmp_path / "managed" / "node.exe"
    node.parent.mkdir()
    node.write_bytes(b"node-fixture")
    installation = tmp_path / "install"
    runtime_root = installation / "content" / "runtime"
    maps = installation / "content" / "source-maps"
    runtime_root.mkdir(parents=True)
    maps.mkdir()
    (runtime_root / "sdk.mjs").write_text(
        "export const serve = () => 'ok';\n", encoding="utf-8", newline="\n"
    )
    (maps / "main.mjs.map").write_text(
        json.dumps(
            {"version": 3, "sources": ["src/main.mts"], "names": [], "mappings": ""},
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    main = runtime_root / "main.mjs"
    main.write_text(
        'import { serve } from "./sdk.mjs";\n'
        "serve();\n"
        "//# sourceMappingURL=../source-maps/main.mjs.map\n",
        encoding="utf-8",
        newline="\n",
    )
    runtime = NodeModuleRuntime(
        artifact="runtime/main.mjs",
        runtime_id="node-24.19.0",
        node_args=("--enable-source-maps", "--max-old-space-size=128"),
    )
    return NodeModuleProvider(_ManagedNodeRegistry(node)), runtime, installation, main


def test_revision4_adds_exact_signed_node_lts_release() -> None:
    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
    old_roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V3_PATH.read_bytes())
    revision3 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V3_PATH.read_bytes(), old_roots
    )
    revision4 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V4_PATH.read_bytes(), roots
    )
    assert len(old_roots) == 3
    assert len(roots) == 4
    assert revision4.revision == 4
    assert revision4.previous_registry_sha256 == revision3.sha256
    node = next(
        item for item in revision4.runtimes if item.runtime_id == "node-24.19.0"
    )
    assert node.kind == "node"
    assert node.version == "24.19.0+LTS-Krypton"
    assert (
        node.sha256
        == "sha256:57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
    )
    assert node.size == 37_304_352
    assert node.executable == "node.exe"
    assert node.file_count == 1_989
    assert node.extracted_size == 106_112_876
    assert [item.role for item in node.evidence] == [
        "vendor-checksum",
        "vendor-metadata",
        "vendor-sbom",
        "vendor-signature",
    ]
    # Node does not publish a release SBOM. Registry v1's frozen compatibility
    # slot is deliberately bound to the exact-tag vendor LICENSE inventory.
    assert node.evidence[2].file_name == "LICENSE.vendor"
    assert node.license_spdx == "MIT"


def test_node_provider_is_default_off_and_requires_managed_registry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv(NODE_RUNTIME_ENABLED_ENV, raising=False)
    assert default_runtime_provider_registry().kinds == ("python-module",)
    node = tmp_path / "node.exe"
    node.write_bytes(b"node")
    managed = _ManagedNodeRegistry(node)
    assert default_runtime_provider_registry(
        node_enabled=True, managed_runtime_registry=managed
    ).kinds == ("node-module", "python-module")
    monkeypatch.setenv(NODE_RUNTIME_ENABLED_ENV, "true")
    assert default_runtime_provider_registry(
        managed_runtime_registry=managed
    ).kinds == (
        "node-module",
        "python-module",
    )
    with pytest.raises(RuntimeProviderError, match="Host-managed Runtime Registry"):
        default_runtime_provider_registry(node_enabled=True)


def test_node_provider_prepares_fixed_permission_model_launch(tmp_path: Path) -> None:
    provider, runtime, installation, main = _fixture(tmp_path)
    artifact = RuntimeArtifact(
        relative_path="runtime/main.mjs",
        path=main,
        role="node-bundle",
        sha256=_sha(main),
        size=main.stat().st_size,
        operating_systems=("windows",),
        architectures=("x86_64",),
    )
    sdk = installation / "content" / "runtime" / "sdk.mjs"
    sdk_artifact = RuntimeArtifact(
        relative_path="runtime/sdk.mjs",
        path=sdk,
        role="node-bundle",
        sha256=_sha(sdk),
        size=sdk.stat().st_size,
        operating_systems=("windows",),
        architectures=("x86_64",),
    )
    request = RuntimeInstallationRequest(
        installation=installation,
        host_executable=Path(__file__),
        wheel_paths=(),
        distributions=(),
        runtime_ids=("node-24.19.0",),
        artifacts=(artifact, sdk_artifact),
        entry_artifacts=("runtime/main.mjs",),
    )
    binding = provider.prepare_installation(request, lambda *_args, **_kwargs: b"")[0]
    assert binding.provider_version == NODE_MODULE_PROVIDER_VERSION
    assert binding.runtime_supply is not None
    assert binding.runtime_supply.registry_revision == 4
    prepared = provider.prepare_runtime(
        runtime=runtime,
        executable=main,
        working_directory=installation,
        artifact_sha256=_sha(main),
    )
    launch = provider.build_runtime_launch(prepared)
    assert launch.arguments == (
        "--permission",
        f"--allow-fs-read={installation.resolve()}",
        "--no-addons",
        "--no-global-search-paths",
        "--disallow-code-generation-from-strings",
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        "--disable-proto=throw",
        "--unhandled-rejections=strict",
        "--enable-source-maps",
        "--max-old-space-size=128",
        str(main.resolve()),
    )
    assert launch.executable.name == "node.exe"
    assert launch.manage_process_tree
    assert launch.isolated_search_path
    assert launch.max_processes == 1


@pytest.mark.parametrize(
    "argument",
    [
        "--eval=process.exit()",
        "--allow-child-process",
        "--allow-worker",
        "--experimental-loader=evil.mjs",
        "--inspect",
        "--require=evil.cjs",
        "--max-old-space-size=1024",
    ],
)
def test_node_provider_rejects_privilege_and_loader_arguments(
    tmp_path: Path, argument: str
) -> None:
    provider, _runtime, _installation, _main = _fixture(tmp_path)
    with pytest.raises(RuntimeProviderError, match="allowlist|envelope"):
        provider.validate_runtime(
            NodeModuleRuntime(
                artifact="runtime/main.mjs",
                runtime_id="node-24.19.0",
                node_args=(argument,),
            )
        )


def test_node_provider_rejects_cjs_dynamic_bare_escape_and_path_leaking_maps(
    tmp_path: Path,
) -> None:
    provider, runtime, installation, main = _fixture(tmp_path)
    with pytest.raises(RuntimeProviderError, match="ESM .mjs"):
        provider.validate_runtime(
            NodeModuleRuntime(artifact="runtime/main.cjs", runtime_id="node-24.19.0")
        )

    cases = {
        "dynamic": 'await import("./sdk.mjs");\n',
        "dynamic-comment": 'await import/* hidden */("./sdk.mjs");\n',
        "bare": 'import "left-pad";\n',
        "escape": 'import "../../outside.mjs";\n',
    }
    (installation / "outside.mjs").write_text("export {};\n", encoding="utf-8")
    for source in cases.values():
        main.write_text(source, encoding="utf-8", newline="\n")
        artifact = RuntimeArtifact(
            relative_path="runtime/main.mjs",
            path=main,
            role="node-bundle",
            sha256=_sha(main),
            size=main.stat().st_size,
            operating_systems=("windows",),
            architectures=("x86_64",),
        )
        request = RuntimeInstallationRequest(
            installation=installation,
            host_executable=Path(__file__),
            wheel_paths=(),
            distributions=(),
            runtime_ids=("node-24.19.0",),
            artifacts=(artifact,),
            entry_artifacts=("runtime/main.mjs",),
        )
        with pytest.raises(
            RuntimeProviderError, match="dynamic import|bare packages|under the runtime"
        ):
            provider.verify_installation(request, lambda *_args, **_kwargs: b"")

    mapping = installation / "content" / "source-maps" / "main.mjs.map"
    mapping.write_text(
        json.dumps(
            {"version": 3, "sources": [r"C:\\Users\\secret\\main.ts"], "mappings": ""}
        ),
        encoding="utf-8",
    )
    main.write_text(
        "export {};\n//# sourceMappingURL=../source-maps/main.mjs.map\n",
        encoding="utf-8",
        newline="\n",
    )
    with pytest.raises(RuntimeProviderError, match="leaks an absolute"):
        provider.prepare_runtime(
            runtime=runtime,
            executable=main,
            working_directory=installation,
            artifact_sha256=_sha(main),
        )
