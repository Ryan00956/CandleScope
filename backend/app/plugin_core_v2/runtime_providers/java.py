"""Managed Java JAR Runtime Provider with strict archive and launch validation."""

from __future__ import annotations

import hashlib
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from candlescope_plugin_sdk.platform_v2 import JavaJarRuntime, canonical_sha256

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


JAVA_JAR_PROVIDER_VERSION = "1.0.0"
JAVA_RUNTIME_ENABLED_ENV = "CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED"
_MAX_JAR_FILES = 50_000
_MAX_JAR_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
_MAX_JAR_ENTRY_BYTES = 64 * 1024 * 1024
_MAX_MANIFEST_BYTES = 64 * 1024
_CLASS_MAGIC = b"\xca\xfe\xba\xbe"
_JVM_MEMORY = re.compile(r"^-(?P<kind>Xms|Xmx)(?P<size>[0-9]{1,4})m$")
_SAFE_EXACT_JVM_ARGS = frozenset(
    {
        "-XX:+UseG1GC",
        "-XX:+UseSerialGC",
    }
)


def _provider_error(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
) -> RuntimeProviderError:
    return RuntimeProviderError(code, message, details=details)


def _digest(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR could not be read",
            details={"errorType": type(exc).__name__},
        ) from exc
    return f"sha256:{digest.hexdigest()}", size


def _manifest_main_class(payload: bytes) -> str:
    if not payload or len(payload) > _MAX_MANIFEST_BYTES:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR manifest is missing or exceeds its size limit",
        )
    try:
        text = payload.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR manifest must be strict UTF-8",
        ) from exc
    unfolded: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.startswith(" "):
            if not unfolded:
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                    "Java JAR manifest has an orphan continuation line",
                )
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    values = [
        line.split(":", 1)[1].strip()
        for line in unfolded
        if line.casefold().startswith("main-class:")
    ]
    if len(values) != 1 or not values[0]:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR must declare exactly one Main-Class",
        )
    return values[0]


def _safe_jar_name(value: str) -> str:
    if "\\" in value or "\0" in value:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR contains a non-portable entry path",
        )
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or ".." in path.parts
        or "." in path.parts
        or path.as_posix() != value
        or (path.parts and ":" in path.parts[0])
    ):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR contains an unsafe entry path",
        )
    return value


def _class_major(payload: bytes, *, entry: str) -> int:
    if len(payload) < 8 or payload[:4] != _CLASS_MAGIC:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR contains an invalid class file",
            details={"entry": entry},
        )
    return int.from_bytes(payload[6:8], "big")


def _inspect_jar(
    artifact: RuntimeArtifact | None,
    *,
    path: Path,
    expected_sha256: str,
    main_class: str,
    java_major: int,
) -> tuple[str, int, int]:
    actual_sha256, actual_size = _digest(path)
    if actual_sha256 != expected_sha256 or (
        artifact is not None
        and (actual_sha256, actual_size) != (artifact.sha256, artifact.size)
    ):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
            "Java JAR digest or size does not match its immutable inventory",
            details={"artifact": artifact.relative_path if artifact else path.name},
        )
    expected_class = main_class.replace(".", "/") + ".class"
    manifest: bytes | None = None
    main_class_payload: bytes | None = None
    maximum_major = 0
    total = 0
    identities: set[str] = set()
    try:
        with zipfile.ZipFile(path, "r") as package:
            records = package.infolist()
            if not records or len(records) > _MAX_JAR_FILES:
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                    "Java JAR file count is empty or exceeds its limit",
                )
            for record in records:
                name = _safe_jar_name(record.filename)
                identity = name.casefold()
                if identity in identities:
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                        "Java JAR contains a duplicate case-insensitive path",
                        details={"entry": name},
                    )
                identities.add(identity)
                mode = record.external_attr >> 16
                file_type = stat.S_IFMT(mode)
                if file_type == stat.S_IFLNK or (mode and mode & 0o111):
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                        "Java JAR contains a symlink or executable archive entry",
                        details={"entry": name},
                    )
                if record.is_dir():
                    continue
                if record.flag_bits & 0x1:
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                        "Java JAR must not contain encrypted entries",
                        details={"entry": name},
                    )
                if record.file_size < 0 or record.file_size > _MAX_JAR_ENTRY_BYTES:
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                        "Java JAR entry exceeds its uncompressed size limit",
                        details={"entry": name},
                    )
                total += record.file_size
                if total > _MAX_JAR_UNCOMPRESSED_BYTES:
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                        "Java JAR exceeds its total uncompressed size limit",
                    )
                if record.compress_size == 0 and record.file_size > 0:
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                        "Java JAR entry has an invalid compression size",
                        details={"entry": name},
                    )
                if record.compress_size > 0 and record.file_size > max(
                    1024 * 1024, record.compress_size * 250
                ):
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                        "Java JAR entry exceeds the compression-ratio limit",
                        details={"entry": name},
                    )
                if name == "META-INF/MANIFEST.MF":
                    manifest = package.read(record)
                if name == expected_class:
                    main_class_payload = package.read(record)
                if name.endswith(".class"):
                    with package.open(record, "r") as stream:
                        header = stream.read(8)
                    maximum_major = max(
                        maximum_major,
                        _class_major(header, entry=name),
                    )
    except RuntimeProviderError:
        raise
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR is not a readable safe ZIP archive",
            details={"errorType": type(exc).__name__},
        ) from exc
    if manifest is None or _manifest_main_class(manifest) != main_class:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR Main-Class does not match the runtime descriptor",
            details={"mainClass": main_class},
        )
    if main_class_payload is None:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "Java JAR does not contain the declared Main-Class",
            details={"mainClass": main_class},
        )
    _class_major(main_class_payload[:8], entry=expected_class)
    supported_major = 44 + java_major
    if maximum_major > supported_major:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE",
            "Java JAR bytecode requires a newer JRE than the signed runtime",
            details={
                "classMajor": maximum_major,
                "supportedClassMajor": supported_major,
            },
        )
    return actual_sha256, actual_size, maximum_major


def _java_major(version: str) -> int:
    match = re.match(r"^(?:1\.)?([0-9]{1,3})(?:[.+_-]|$)", version)
    if match is None:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_SUPPLY_INVALID",
            "managed Java runtime version cannot be mapped to a class-file level",
        )
    major = int(match.group(1))
    if not 17 <= major <= 99:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_SUPPLY_INVALID",
            "managed Java runtime version is outside the supported range",
        )
    return major


def _validate_jvm_args(values: tuple[str, ...]) -> None:
    seen: set[str] = set()
    for value in values:
        if value in _SAFE_EXACT_JVM_ARGS:
            key = value
        else:
            match = _JVM_MEMORY.fullmatch(value)
            if match is None:
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                    "java-jar jvmArgs contain an option outside the Host allowlist",
                    details={"argument": value},
                )
            size = int(match.group("size"))
            minimum, maximum = (16, 256) if match.group("kind") == "Xms" else (64, 1024)
            if not minimum <= size <= maximum:
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                    "java-jar memory option is outside the Host resource envelope",
                    details={"argument": value},
                )
            key = match.group("kind")
        if key in seen:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "java-jar jvmArgs contain a duplicate policy option",
                details={"argument": value},
            )
        seen.add(key)


def _runtime_identity(runtime_id: str, supply: RuntimeSupplyBinding) -> str:
    return canonical_sha256(
        {
            "runtimeKind": "java-jar",
            "runtimeId": runtime_id,
            "providerVersion": JAVA_JAR_PROVIDER_VERSION,
            "runtimeSupply": supply.to_wire(),
            "policy": {
                "jarFormat": "strict-jar-v1",
                "mainClass": "manifest-and-descriptor-v1",
                "jvmArgs": "host-allowlist-v1",
                "processTree": "host-managed-v1",
                "searchPath": "isolated-v1",
                "maxProcesses": 1,
            },
        }
    )


class JavaJarProvider:
    api_version = RUNTIME_PROVIDER_API_VERSION
    kind = "java-jar"
    provider_version = JAVA_JAR_PROVIDER_VERSION

    def __init__(self, managed_runtime_registry: Any) -> None:
        if managed_runtime_registry is None or not callable(
            getattr(managed_runtime_registry, "ensure", None)
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_CONFIGURATION_INVALID",
                "JavaJarProvider requires the Host-managed Runtime Registry",
            )
        self._managed_runtime_registry = managed_runtime_registry

    def validate_runtime(self, runtime: object) -> None:
        if not isinstance(runtime, JavaJarRuntime):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "JavaJarProvider received a non-Java runtime descriptor",
            )
        _validate_jvm_args(runtime.jvm_args)

    @staticmethod
    def _validate_request(request: RuntimeInstallationRequest) -> None:
        if not request.artifacts:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "java-jar installation requires a declared JAR artifact",
            )
        if request.wheel_paths or request.distributions:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "java-jar installation must not receive Python packages",
            )
        if any(item.role != "java-jar" for item in request.artifacts):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "JavaJarProvider received a wrongly typed artifact",
            )

    def _ensure(self, runtime_id: str, *, offline: bool) -> Any:
        try:
            ensured = self._managed_runtime_registry.ensure(
                runtime_id,
                "java",
                offline=offline,
            )
        except Exception as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_SUPPLY_UNAVAILABLE",
                "exact Host-managed JRE could not be resolved and verified",
                details={
                    "runtimeId": runtime_id,
                    "causeCode": getattr(exc, "code", type(exc).__name__),
                },
            ) from exc
        supply = getattr(ensured, "supply", None)
        executable = getattr(ensured, "executable", None)
        if (
            not isinstance(supply, RuntimeSupplyBinding)
            or supply.runtime_kind != "java"
            or supply.runtime_id != runtime_id
            or not isinstance(executable, Path)
            or executable.resolve(strict=False) != supply.executable
            or not executable.is_file()
            or executable.is_symlink()
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_SUPPLY_INVALID",
                "Host-managed JRE result does not match the requested identity",
                details={"runtimeId": runtime_id},
            )
        _java_major(supply.version)
        return ensured

    def _bindings(
        self,
        request: RuntimeInstallationRequest,
        *,
        offline: bool,
    ) -> tuple[RuntimeProviderBinding, ...]:
        bindings: list[RuntimeProviderBinding] = []
        for runtime_id in sorted(request.runtime_ids):
            ensured = self._ensure(runtime_id, offline=offline)
            bindings.append(
                RuntimeProviderBinding(
                    runtime_kind=self.kind,
                    runtime_id=runtime_id,
                    provider_version=self.provider_version,
                    runtime_identity=_runtime_identity(runtime_id, ensured.supply),
                    runtime_supply=ensured.supply,
                )
            )
        return tuple(bindings)

    @staticmethod
    def _inspect_install_artifacts(
        request: RuntimeInstallationRequest,
        bindings: tuple[RuntimeProviderBinding, ...],
    ) -> None:
        java_major = min(
            _java_major(binding.runtime_supply.version)
            for binding in bindings
            if binding.runtime_supply is not None
        )
        for artifact in request.artifacts:
            try:
                with zipfile.ZipFile(artifact.path, "r") as package:
                    matches = [
                        item
                        for item in package.infolist()
                        if item.filename == "META-INF/MANIFEST.MF"
                    ]
                    if len(matches) != 1:
                        raise _provider_error(
                            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                            "Java JAR must contain exactly one canonical manifest",
                            details={"artifact": artifact.relative_path},
                        )
                    main_class = _manifest_main_class(package.read(matches[0]))
            except RuntimeProviderError:
                raise
            except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as exc:
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                    "Java JAR is not a readable ZIP archive",
                    details={"artifact": artifact.relative_path},
                ) from exc
            _inspect_jar(
                artifact,
                path=artifact.path,
                expected_sha256=artifact.sha256,
                main_class=main_class,
                java_major=java_major,
            )

    def prepare_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        del run_command
        self._validate_request(request)
        bindings = self._bindings(request, offline=False)
        # Installation blocks unsafe ZIPs and incompatible bytecode before any
        # activation is published; descriptor/Main-Class equality is rechecked
        # against the activation descriptor in prepare_runtime.
        self._inspect_install_artifacts(request, bindings)
        return bindings

    def verify_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        del run_command
        self._validate_request(request)
        bindings = self._bindings(request, offline=True)
        self._inspect_install_artifacts(request, bindings)
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
        assert isinstance(runtime, JavaJarRuntime)
        if artifact_sha256 is None:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
                "java-jar activation has no immutable artifact digest",
            )
        try:
            working = Path(working_directory).resolve(strict=True)
            expected = working.joinpath(
                "content", *PurePosixPath(runtime.artifact).parts
            ).resolve(strict=True)
            jar = Path(executable).resolve(strict=True)
        except OSError as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "Java JAR launch target or working directory is unavailable",
                details={"artifact": runtime.artifact},
            ) from exc
        if jar != expected or jar.is_symlink() or not jar.is_file():
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "Java launch target is not the declared immutable JAR",
                details={"artifact": runtime.artifact},
            )
        ensured = self._ensure(runtime.runtime_id, offline=True)
        _inspect_jar(
            None,
            path=jar,
            expected_sha256=artifact_sha256,
            main_class=runtime.main_class,
            java_major=_java_major(ensured.supply.version),
        )
        arguments = [
            "-Dfile.encoding=UTF-8",
            "-Djava.awt.headless=true",
            "-Duser.language=en",
            "-Duser.country=US",
            "-XX:+ExitOnOutOfMemoryError",
        ]
        if not any(item.startswith("-Xms") for item in runtime.jvm_args):
            arguments.append("-Xms32m")
        if not any(item.startswith("-Xmx") for item in runtime.jvm_args):
            arguments.append("-Xmx512m")
        arguments.extend(runtime.jvm_args)
        arguments.extend(("-cp", str(jar), runtime.main_class))
        return PreparedRuntime(
            runtime_kind=self.kind,
            runtime_id=runtime.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=_runtime_identity(runtime.runtime_id, ensured.supply),
            executable=ensured.executable,
            working_directory=working,
            artifact=jar,
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
                "java-jar runtime must use its frozen JRE supply",
            )
        if (
            prepared.runtime_kind != self.kind
            or prepared.artifact is None
            or prepared.runtime_supply is None
            or prepared.runtime_supply.runtime_kind != "java"
            or prepared.executable != prepared.runtime_supply.executable
            or not prepared.artifact.is_file()
            or prepared.artifact.is_symlink()
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "prepared java-jar runtime is incomplete or has the wrong supply",
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
    "JAVA_JAR_PROVIDER_VERSION",
    "JAVA_RUNTIME_ENABLED_ENV",
    "JavaJarProvider",
]
