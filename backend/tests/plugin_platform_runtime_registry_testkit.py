from __future__ import annotations

import io
import os
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.plugin_runtime_registry_v3 import (
    EVIDENCE_ROLES,
    ManagedRuntimeRegistryService,
    RuntimeRegistryError,
    canonical_bytes,
    encode_base64url,
    host_platform,
    key_id,
    load_runtime_registry_roots_bytes,
    registry_error,
    sha256_bytes,
)


FIXTURE_ORIGIN = "https://runtime-fixtures.candlescope.test"
FIXTURE_RUNTIME_ID = "fixture-java-1"
FIXTURE_RUNTIME_VERSION = "1.0.0+fixture"
FIXTURE_OUTPUT = "candlescope-fixture-runtime-1.0.0"


class LocalRuntimeArtifactFetcher:
    """Deterministic fetcher that still exercises staging and digest checks."""

    def __init__(
        self,
        payloads: Mapping[str, bytes],
        *,
        interrupt_url: str | None = None,
    ) -> None:
        self.payloads = dict(payloads)
        self.interrupt_url = interrupt_url
        self.calls: list[str] = []

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        payload = self.payloads.get(url)
        if payload is None:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
                "fixture fetcher has no payload for the signed URL",
            )
        if self.interrupt_url == url:
            with destination.open("xb") as stream:
                stream.write(payload[: max(1, len(payload) // 2)])
                stream.flush()
                os.fsync(stream.fileno())
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
                "fixture transport was interrupted",
            )
        if len(payload) > maximum:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_LIMIT_EXCEEDED",
                "fixture payload exceeds its signed maximum",
            )
        with destination.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())


@dataclass(frozen=True, slots=True)
class RuntimeRegistryFixture:
    private_key: Ed25519PrivateKey
    roots_bytes: bytes
    registry_bytes: bytes
    runtime_release: dict[str, Any]
    archive_url: str
    evidence_urls: tuple[str, ...]
    payloads: dict[str, bytes]

    @property
    def archive_sha256(self) -> str:
        return self.runtime_release["sha256"]

    def service(
        self,
        root: Path,
        *,
        fetcher: LocalRuntimeArtifactFetcher | None = None,
        enabled: bool = True,
    ) -> ManagedRuntimeRegistryService:
        return ManagedRuntimeRegistryService(
            root=root,
            roots=load_runtime_registry_roots_bytes(self.roots_bytes),
            bootstrap_registry=self.registry_bytes,
            enabled=enabled,
            network_updates_enabled=False,
            fetcher=fetcher or LocalRuntimeArtifactFetcher(self.payloads),
        )

    def signed_revision(
        self,
        *,
        revision: int,
        previous_registry_sha256: str,
        revocations: tuple[dict[str, str], ...] = (),
        runtimes: tuple[dict[str, Any], ...] | None = None,
    ) -> bytes:
        return _signed_registry(
            self.private_key,
            revision=revision,
            previous_registry_sha256=previous_registry_sha256,
            runtimes=(self.runtime_release,) if runtimes is None else runtimes,
            revocations=revocations,
        )

    def write_configuration(self, directory: Path) -> tuple[Path, Path]:
        directory.mkdir(parents=True, exist_ok=True)
        roots = directory / "roots.json"
        registry = directory / "registry.json"
        roots.write_bytes(self.roots_bytes)
        registry.write_bytes(self.registry_bytes)
        return roots, registry


def _runtime_executable() -> tuple[bytes, str, list[str], str, str]:
    if os.name == "nt":
        source = Path(os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe"))
        executable = "bin/runtime.exe"
        arguments = [executable, "/d", "/c", f"echo {FIXTURE_OUTPUT}"]
        stdout_regex = rf"{FIXTURE_OUTPUT}\r?\n"
    else:
        source = Path("/bin/sh")
        executable = "bin/runtime"
        arguments = [executable, "-c", f"printf '{FIXTURE_OUTPUT}\\n'"]
        stdout_regex = rf"{FIXTURE_OUTPUT}\n"
    return source.read_bytes(), executable, arguments, stdout_regex, r"(?s)^$"


def _zip_bytes(files: Mapping[str, tuple[bytes, int]], prefix: str) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for relative in sorted(files):
            payload, mode = files[relative]
            info = zipfile.ZipInfo(f"{prefix}/{relative}")
            info.date_time = (2026, 8, 3, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            package.writestr(info, payload)
    return output.getvalue()


def _signed_registry(
    private_key: Ed25519PrivateKey,
    *,
    revision: int,
    previous_registry_sha256: str | None,
    runtimes: tuple[dict[str, Any], ...],
    revocations: tuple[dict[str, str], ...],
) -> bytes:
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    body = {
        "schemaVersion": 1,
        "registry": {
            "id": "candlescope.fixture-runtime",
            "revision": revision,
            "issuedAt": f"2026-08-03T00:00:{revision:02d}Z",
            "previousRegistrySha256": previous_registry_sha256,
            "automaticNetworkUpdates": False,
        },
        "runtimes": [dict(item) for item in runtimes],
        "revocations": [dict(item) for item in revocations],
    }
    signature = private_key.sign(canonical_bytes(body))
    return canonical_bytes(
        {
            **body,
            "signature": {
                "algorithm": "ed25519",
                "keyId": key_id(public_key),
                "value": encode_base64url(signature),
            },
        }
    )


def build_runtime_registry_fixture(
    *,
    archive_override: bytes | None = None,
) -> RuntimeRegistryFixture:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    roots = canonical_bytes(
        {
            "schemaVersion": 1,
            "registries": [
                {
                    "registryId": "candlescope.fixture-runtime",
                    "keyId": key_id(public_key),
                    "publicKey": encode_base64url(public_key),
                    "sourceOrigins": [FIXTURE_ORIGIN],
                    "enabled": True,
                }
            ],
        }
    )

    executable_bytes, executable, probe_argv, stdout_regex, stderr_regex = (
        _runtime_executable()
    )
    license_bytes = b"MIT License\nCopyright CandleScope fixture authors\n"
    prefix = "fixture-runtime-1"
    files = {
        executable: (executable_bytes, 0o755),
        "legal/LICENSE": (license_bytes, 0o444),
    }
    archive = (
        _zip_bytes(files, prefix) if archive_override is None else archive_override
    )
    archive_url = f"{FIXTURE_ORIGIN}/runtime/fixture-runtime-1.zip"

    evidence_payloads = {
        role: f"{role}:fixture-java-1:{sha256_bytes(archive)}\n".encode("utf-8")
        for role in sorted(EVIDENCE_ROLES)
    }
    evidence = []
    payloads = {archive_url: archive}
    evidence_urls: list[str] = []
    for role in sorted(EVIDENCE_ROLES):
        url = f"{FIXTURE_ORIGIN}/evidence/{role}.txt"
        payload = evidence_payloads[role]
        evidence_urls.append(url)
        payloads[url] = payload
        evidence.append(
            {
                "role": role,
                "url": url,
                "sha256": sha256_bytes(payload),
                "size": len(payload),
                "fileName": f"{role}.txt",
            }
        )

    os_name, arch_name = host_platform()
    release = {
        "id": FIXTURE_RUNTIME_ID,
        "kind": "java",
        "version": FIXTURE_RUNTIME_VERSION,
        "os": os_name,
        "arch": arch_name,
        "url": archive_url,
        "sha256": sha256_bytes(archive),
        "size": len(archive),
        "archive": "zip",
        "stripPrefix": prefix,
        "executable": executable,
        "extractedSize": sum(len(item[0]) for item in files.values()),
        "fileCount": len(files),
        "license": {
            "spdx": "MIT",
            "name": "MIT License",
            "url": f"{FIXTURE_ORIGIN}/license",
            "legalDirectory": "legal",
            "legalFileCount": 1,
            "legalSize": len(license_bytes),
        },
        "licenseFiles": [
            {
                "path": "legal/LICENSE",
                "sha256": sha256_bytes(license_bytes),
                "size": len(license_bytes),
            }
        ],
        "evidence": evidence,
        "probe": {
            "argv": probe_argv,
            "expectedExitCode": 0,
            "stdoutRegex": stdout_regex,
            "stderrRegex": stderr_regex,
            "timeoutSeconds": 10,
        },
        "upstream": {
            "releaseUrl": f"{FIXTURE_ORIGIN}/release/fixture-runtime-1",
            "scmRef": "fixture-runtime-1.0.0",
            "buildRef": f"{FIXTURE_ORIGIN}/commit/0000000000000000000000000000000000000001",
        },
    }
    registry = _signed_registry(
        private_key,
        revision=1,
        previous_registry_sha256=None,
        runtimes=(release,),
        revocations=(),
    )
    return RuntimeRegistryFixture(
        private_key=private_key,
        roots_bytes=roots,
        registry_bytes=registry,
        runtime_release=release,
        archive_url=archive_url,
        evidence_urls=tuple(evidence_urls),
        payloads=payloads,
    )


def copy_system_runtime_fixture(
    directory: Path,
) -> tuple[Path, tuple[str, ...], str]:
    payload, relative, argv, stdout_regex, _stderr_regex = _runtime_executable()
    path = directory / Path(relative).name
    directory.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    path.chmod(0o755)
    return path.resolve(), tuple(argv[1:]), stdout_regex


def interrupted_fetcher(fixture: RuntimeRegistryFixture) -> LocalRuntimeArtifactFetcher:
    return LocalRuntimeArtifactFetcher(
        fixture.payloads,
        interrupt_url=fixture.archive_url,
    )


def error_code(exc: BaseException) -> str:
    if not isinstance(exc, RuntimeRegistryError):
        raise AssertionError(f"expected RuntimeRegistryError, got {type(exc).__name__}")
    return exc.code
