from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from candlescope_plugin_sdk.platform_v2 import JavaJarRuntime

from app.plugin_core_v2.runtime_providers import (
    JAVA_RUNTIME_ENABLED_ENV,
    JavaJarProvider,
    RuntimeArtifact,
    RuntimeInstallationRequest,
    RuntimeProviderError,
    RuntimeSupplyBinding,
    default_runtime_provider_registry,
)
from app.plugin_runtime_registry_v3 import (
    EVIDENCE_ROLES,
    ManagedRuntimeRegistryService,
    OFFICIAL_REGISTRY_V1_PATH,
    OFFICIAL_REGISTRY_V2_PATH,
    OFFICIAL_REGISTRY_PATH,
    OFFICIAL_ROOTS_PATH,
    RuntimeRegistryError,
    build_official_runtime_registry,
    load_runtime_registry_roots_bytes,
    verify_runtime_registry_bytes,
)


def _sha256(path: Path) -> tuple[str, int]:
    payload = path.read_bytes()
    return f"sha256:{hashlib.sha256(payload).hexdigest()}", len(payload)


def _write_jar(
    path: Path,
    *,
    main_class: str = "io.candlescope.fixture.Main",
    manifest_main_class: str | None = None,
    class_major: int = 61,
    extra: tuple[tuple[str, bytes], ...] = (),
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest = (
        "Manifest-Version: 1.0\r\n"
        f"Main-Class: {manifest_main_class or main_class}\r\n"
        "\r\n"
    ).encode()
    class_payload = b"\xca\xfe\xba\xbe\x00\x00" + class_major.to_bytes(2, "big")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.writestr("META-INF/MANIFEST.MF", manifest)
        package.writestr(main_class.replace(".", "/") + ".class", class_payload)
        for name, payload in extra:
            package.writestr(name, payload)


class _ManagedRegistry:
    def __init__(self, executable: Path, *, fail: bool = False) -> None:
        self.executable = executable
        self.calls: list[tuple[str, str, bool]] = []
        self.fail = fail
        digest, size = _sha256(executable)
        self.supply = RuntimeSupplyBinding(
            source="host-managed",
            runtime_id="temurin-25.0.4.7",
            runtime_kind="java",
            version="25.0.4+7",
            executable=executable,
            artifact_sha256=digest,
            artifact_size=size,
            probe_sha256="sha256:" + "2" * 64,
            verification_status="verified",
            reproducible=True,
            registry_id="candlescope.reference-runtime",
            registry_revision=2,
            registry_sha256="sha256:" + "3" * 64,
            source_url="https://runtime.candlescope.test/temurin-25.zip",
            license_spdx="GPL-2.0 WITH Classpath-exception-2.0",
        )

    def ensure(self, runtime_id: str, kind: str, *, offline: bool = False):
        self.calls.append((runtime_id, kind, offline))
        if self.fail or runtime_id != self.supply.runtime_id or kind != "java":
            error = RuntimeError("missing runtime")
            error.code = "PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND"  # type: ignore[attr-defined]
            raise error
        return SimpleNamespace(executable=self.executable, supply=self.supply)

    def resolve(self, *args, **kwargs):
        return object()

    def public_status(self, *args, **kwargs):
        return {}


def _fixture(tmp_path: Path):
    installation = tmp_path / "installation"
    jar = installation / "content" / "runtime" / "fixture.jar"
    _write_jar(jar)
    digest, size = _sha256(jar)
    java = tmp_path / "runtime" / "bin" / "java.exe"
    java.parent.mkdir(parents=True)
    java.write_bytes(b"fixture managed Java executable")
    registry = _ManagedRegistry(java.resolve())
    provider = JavaJarProvider(registry)
    artifact = RuntimeArtifact(
        relative_path="runtime/fixture.jar",
        path=jar,
        role="java-jar",
        sha256=digest,
        size=size,
        operating_systems=("windows",),
        architectures=("x86_64",),
    )
    request = RuntimeInstallationRequest(
        installation=installation,
        host_executable=Path(__file__).resolve(),
        wheel_paths=(),
        distributions=(),
        runtime_ids=("temurin-25.0.4.7",),
        artifacts=(artifact,),
    )
    runtime = JavaJarRuntime(
        artifact="runtime/fixture.jar",
        runtime_id="temurin-25.0.4.7",
        main_class="io.candlescope.fixture.Main",
        jvm_args=("-Xmx256m", "-XX:+UseG1GC"),
    )
    return installation, jar, digest, registry, provider, request, runtime


def test_official_registry_revision_2_pins_temurin_25_and_retains_revision_1() -> None:
    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
    revision_1 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V1_PATH.read_bytes(), roots
    )
    revision_2 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V2_PATH.read_bytes(), roots
    )

    assert OFFICIAL_REGISTRY_PATH == OFFICIAL_REGISTRY_V2_PATH
    assert len(roots) == 2
    assert revision_1.revision == 1
    assert revision_2.revision == 2
    assert revision_2.previous_registry_sha256 == revision_1.sha256
    assert revision_2.automatic_network_updates is False
    releases = {item.runtime_id: item for item in revision_2.runtimes}
    assert set(releases) == {"temurin-21.0.12.8", "temurin-25.0.4.7"}
    release = releases["temurin-25.0.4.7"]
    assert release.version == "25.0.4+7-LTS"
    assert release.sha256 == (
        "sha256:5b0d58f043f762fa3ee6cc12b6774b59b245cafdcb357e45ce61f822aa9a56cb"
    )
    assert release.size == 58_474_646
    assert release.file_count == 320
    assert release.extracted_size == 187_841_444
    assert release.legal_file_count == 183
    assert release.legal_size == 231_846
    assert {item.role for item in release.evidence} == set(EVIDENCE_ROLES)
    assert release.probe.argv == ("bin/java.exe", "-version")


def test_official_registry_bootstraps_the_continuous_history_and_can_rollback(
    tmp_path: Path,
) -> None:
    service = build_official_runtime_registry(root=tmp_path / "official", enabled=True)
    status = service.public_status()

    assert status["active"]["revision"] == 2
    assert status["active"]["rollbackAvailable"] is True
    rolled = service.rollback_registry()
    assert rolled["fromRevision"] == 2
    assert rolled["toRevision"] == 1
    restored = service.activate_registry(OFFICIAL_REGISTRY_V2_PATH.read_bytes())
    assert restored["revision"] == 2

    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
    with pytest.raises(RuntimeRegistryError) as missing_history:
        ManagedRuntimeRegistryService(
            root=tmp_path / "missing-history",
            roots=roots,
            bootstrap_registry=OFFICIAL_REGISTRY_V2_PATH.read_bytes(),
            enabled=True,
        )
    assert missing_history.value.code == "PLUGIN_RUNTIME_REGISTRY_CHAIN_INVALID"


def test_java_provider_is_default_off_and_has_an_independent_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    java = tmp_path / "java.exe"
    java.write_bytes(b"java")
    registry = _ManagedRegistry(java.resolve())
    monkeypatch.delenv(JAVA_RUNTIME_ENABLED_ENV, raising=False)
    assert default_runtime_provider_registry(
        managed_runtime_registry=registry
    ).kinds == ("python-module",)
    assert default_runtime_provider_registry(
        java_enabled=True,
        managed_runtime_registry=registry,
    ).kinds == ("java-jar", "python-module")
    monkeypatch.setenv(JAVA_RUNTIME_ENABLED_ENV, "true")
    assert default_runtime_provider_registry(
        managed_runtime_registry=registry
    ).kinds == ("java-jar", "python-module")
    monkeypatch.setenv(JAVA_RUNTIME_ENABLED_ENV, "maybe")
    with pytest.raises(RuntimeProviderError) as failure:
        default_runtime_provider_registry(managed_runtime_registry=registry)
    assert failure.value.code == "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID"


def test_java_provider_binds_exact_jar_jre_and_host_launch_policy(
    tmp_path: Path,
) -> None:
    installation, jar, digest, registry, provider, request, runtime = _fixture(tmp_path)
    prepared_bindings = provider.prepare_installation(
        request, lambda *args, **kwargs: b""
    )
    repeated_bindings = provider.verify_installation(
        request, lambda *args, **kwargs: b""
    )
    assert prepared_bindings == repeated_bindings
    assert registry.calls == [
        ("temurin-25.0.4.7", "java", False),
        ("temurin-25.0.4.7", "java", True),
    ]
    assert prepared_bindings[0].runtime_supply == registry.supply

    prepared = provider.prepare_runtime(
        runtime=runtime,
        executable=jar,
        working_directory=installation,
        artifact_sha256=digest,
    )
    launch = provider.build_runtime_launch(prepared)

    assert prepared.artifact == jar.resolve()
    assert prepared.executable == registry.executable
    assert prepared.runtime_supply == registry.supply
    assert launch.manage_process_tree is True
    assert launch.isolated_search_path is True
    assert launch.max_processes == 1
    assert launch.arguments[-3:] == ("-cp", str(jar.resolve()), runtime.main_class)
    assert "-Dfile.encoding=UTF-8" in launch.arguments
    assert "-XX:+ExitOnOutOfMemoryError" in launch.arguments
    assert "-Xmx256m" in launch.arguments
    assert "-Xmx512m" not in launch.arguments


@pytest.mark.parametrize(
    "arguments",
    [
        ("-jar",),
        ("-javaagent:evil.jar",),
        ("-Djava.system.class.loader=evil.Loader",),
        ("-Xmx4096m",),
        ("-Xmx256m", "-Xmx512m"),
    ],
)
def test_java_provider_rejects_jvm_options_that_can_replace_host_policy(
    tmp_path: Path, arguments: tuple[str, ...]
) -> None:
    *_, provider, _request, runtime = _fixture(tmp_path)
    with pytest.raises(RuntimeProviderError) as failure:
        provider.validate_runtime(
            JavaJarRuntime(
                artifact=runtime.artifact,
                runtime_id=runtime.runtime_id,
                main_class=runtime.main_class,
                jvm_args=arguments,
            )
        )
    assert failure.value.code == "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID"


def test_java_provider_rejects_digest_main_class_bytecode_and_supply_failures(
    tmp_path: Path,
) -> None:
    installation, jar, digest, registry, provider, _request, runtime = _fixture(
        tmp_path
    )
    with pytest.raises(RuntimeProviderError) as mismatch:
        provider.prepare_runtime(
            runtime=runtime,
            executable=jar,
            working_directory=installation,
            artifact_sha256="sha256:" + "0" * 64,
        )
    assert mismatch.value.code == "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH"

    wrong_manifest = installation / "content" / "runtime" / "wrong.jar"
    _write_jar(wrong_manifest, manifest_main_class="io.candlescope.fixture.Other")
    wrong_digest, _ = _sha256(wrong_manifest)
    wrong_runtime = JavaJarRuntime(
        artifact="runtime/wrong.jar",
        runtime_id=runtime.runtime_id,
        main_class=runtime.main_class,
    )
    with pytest.raises(RuntimeProviderError) as main_failure:
        provider.prepare_runtime(
            runtime=wrong_runtime,
            executable=wrong_manifest,
            working_directory=installation,
            artifact_sha256=wrong_digest,
        )
    assert main_failure.value.code == "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID"

    future = installation / "content" / "runtime" / "future.jar"
    _write_jar(future, class_major=70)
    future_digest, _ = _sha256(future)
    future_runtime = JavaJarRuntime(
        artifact="runtime/future.jar",
        runtime_id=runtime.runtime_id,
        main_class=runtime.main_class,
    )
    with pytest.raises(RuntimeProviderError) as version_failure:
        provider.prepare_runtime(
            runtime=future_runtime,
            executable=future,
            working_directory=installation,
            artifact_sha256=future_digest,
        )
    assert version_failure.value.code == "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE"

    failing = JavaJarProvider(_ManagedRegistry(registry.executable, fail=True))
    with pytest.raises(RuntimeProviderError) as supply_failure:
        failing.prepare_runtime(
            runtime=runtime,
            executable=jar,
            working_directory=installation,
            artifact_sha256=digest,
        )
    assert supply_failure.value.code == "PLUGIN_RUNTIME_PROVIDER_SUPPLY_UNAVAILABLE"
    assert supply_failure.value.details["causeCode"] == (
        "PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND"
    )


def test_java_provider_rejects_unsafe_jar_paths_and_sandbox_substitution(
    tmp_path: Path,
) -> None:
    installation, _jar, _digest, registry, provider, _request, runtime = _fixture(
        tmp_path
    )
    unsafe = installation / "content" / "runtime" / "unsafe.jar"
    _write_jar(unsafe, extra=(("../escape.txt", b"bad"),))
    unsafe_digest, _ = _sha256(unsafe)
    unsafe_runtime = JavaJarRuntime(
        artifact="runtime/unsafe.jar",
        runtime_id=runtime.runtime_id,
        main_class=runtime.main_class,
    )
    unsafe_artifact = RuntimeArtifact(
        relative_path="runtime/unsafe.jar",
        path=unsafe,
        role="java-jar",
        sha256=unsafe_digest,
        size=unsafe.stat().st_size,
        operating_systems=("windows",),
        architectures=("x86_64",),
    )
    unsafe_request = RuntimeInstallationRequest(
        installation=installation,
        host_executable=Path(__file__).resolve(),
        wheel_paths=(),
        distributions=(),
        runtime_ids=(runtime.runtime_id,),
        artifacts=(unsafe_artifact,),
    )
    with pytest.raises(RuntimeProviderError) as install_failure:
        provider.prepare_installation(unsafe_request, lambda *args, **kwargs: b"")
    assert install_failure.value.code == "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID"

    with pytest.raises(RuntimeProviderError) as unsafe_failure:
        provider.prepare_runtime(
            runtime=unsafe_runtime,
            executable=unsafe,
            working_directory=installation,
            artifact_sha256=unsafe_digest,
        )
    assert unsafe_failure.value.code == "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID"

    prepared = provider.prepare_runtime(
        runtime=runtime,
        executable=installation / "content" / "runtime" / "fixture.jar",
        working_directory=installation,
        artifact_sha256=_sha256(installation / "content" / "runtime" / "fixture.jar")[
            0
        ],
    )
    from app.plugin_core_v2.runtime_providers import SandboxRuntime

    with pytest.raises(RuntimeProviderError) as sandbox_failure:
        provider.build_runtime_launch(
            prepared,
            sandbox_runtime=SandboxRuntime(
                executable=registry.executable,
                site_packages=tmp_path,
            ),
        )
    assert sandbox_failure.value.code == "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID"
