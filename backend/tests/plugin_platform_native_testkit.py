from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle, build_platform_bundle
from tests.plugin_platform_bundle_testkit import build_platform_sdk_wheel


REPOSITORY_ROOT = Path(__file__).parents[2]
RUST_REFERENCE = REPOSITORY_ROOT / "examples" / "plugin-platform-native-rust"
SDK_ROOT = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk"
V3_SCHEMA = (
    SDK_ROOT
    / "src"
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "schemas"
    / "manifest-v3.schema.json"
)
V2_SCHEMA = (
    SDK_ROOT
    / "src"
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "schemas"
    / "manifest-v2.schema.json"
)
NATIVE_TRANSCRIPT = (
    Path(__file__).parent
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "native_reference_transcript_v1.json"
)
NATIVE_PLUGIN_ID = "candlescope.native-reference"
NATIVE_PLUGIN_NAME = "CandleScope Native Reference"
NATIVE_PLUGIN_VERSION = "0.1.0"
NATIVE_TRANSCRIPT_SHA256 = (
    "sha256:a3da7d49d645be03a6d33962c0a6c5f6664c4398fda5c260ddea47bb92e003d5"
)


@dataclass(frozen=True, slots=True)
class NativeReferenceBuild:
    executable: Path
    sha256: str
    rustc_version: str
    cargo_version: str


@dataclass(frozen=True, slots=True)
class NativeBundleFixture:
    bundle: VerifiedPlatformBundle
    source_directory: Path
    manifest: dict[str, Any]
    executable: Path
    mode: str


@dataclass(frozen=True, slots=True)
class PythonFallbackBundleFixture:
    bundle: VerifiedPlatformBundle
    source_directory: Path
    manifest: dict[str, Any]


def host_platform() -> tuple[str, str]:
    operating_system = {
        "darwin": "macos",
        "linux": "linux",
        "windows": "windows",
    }.get(platform.system().casefold())
    architecture = {
        "aarch64": "arm64",
        "amd64": "x86_64",
        "arm64": "arm64",
        "x86_64": "x86_64",
    }.get(platform.machine().casefold())
    if operating_system is None or architecture is None:
        raise RuntimeError(
            f"unsupported test Host platform: {platform.system()}/{platform.machine()}"
        )
    return operating_system, architecture


def _tool_version(command: str) -> str:
    completed = subprocess.run(
        (command, "--version"),
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return completed.stdout.strip()


def compile_native_reference(directory: Path) -> NativeReferenceBuild:
    cargo = shutil.which("cargo")
    rustc = shutil.which("rustc")
    if cargo is None or rustc is None:
        raise RuntimeError("Phase 3 requires cargo and rustc on PATH")
    target = directory.resolve(strict=False) / "cargo-target"
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(target)
    completed = subprocess.run(
        (
            cargo,
            "build",
            "--release",
            "--locked",
            "--offline",
            "--manifest-path",
            str(RUST_REFERENCE / "Cargo.toml"),
        ),
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
        env=environment,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "native reference compilation failed:\n"
            + (completed.stderr or completed.stdout)[-8_192:]
        )
    executable = (
        target
        / "release"
        / (
            "candlescope-native-reference.exe"
            if os.name == "nt"
            else "candlescope-native-reference"
        )
    ).resolve(strict=True)
    digest = f"sha256:{hashlib.sha256(executable.read_bytes()).hexdigest()}"
    return NativeReferenceBuild(
        executable=executable,
        sha256=digest,
        rustc_version=_tool_version(rustc),
        cargo_version=_tool_version(cargo),
    )


def native_reference_manifest(
    *,
    mode: str = "good",
    include_probe: bool = True,
    extra_args: tuple[str, ...] = (),
    operating_systems: tuple[str, ...] | None = None,
    architectures: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    host_os, host_arch = host_platform()
    os_values = operating_systems or (host_os,)
    arch_values = architectures or (host_arch,)
    executable_name = (
        "candlescope-native-reference.exe"
        if host_os == "windows"
        else "candlescope-native-reference"
    )
    arguments = ["--jsonl"]
    if mode != "good":
        arguments.extend(("--mode", mode))
    arguments.extend(extra_args)
    return {
        "schemaVersion": 3,
        "plugin": {
            "id": NATIVE_PLUGIN_ID,
            "name": NATIVE_PLUGIN_NAME,
            "version": NATIVE_PLUGIN_VERSION,
            "publisher": "candlescope",
            "license": "MIT",
            "engines": {"candlescope": ">=0.4.0 <0.5.0"},
        },
        "backend": {
            "entrypoints": [
                {
                    "id": "main",
                    "runtime": {
                        "kind": "native-executable",
                        "artifact": f"runtime/{executable_name}",
                        "operatingSystems": list(os_values),
                        "architectures": list(arch_values),
                        "args": arguments,
                    },
                    "transport": "jsonl/1",
                    "resourceProfile": "minimal",
                    "activationEvents": ["onCommand"],
                }
            ]
        },
        "contributions": [
            {
                "id": "hello",
                "kind": "command/1",
                "title": "Say hello",
                "entrypoint": "main",
                "configuration": {},
            }
        ],
        "permissions": {"required": [], "optional": []},
        "probes": (
            [
                {
                    "id": "native-control",
                    "kind": "controlTranscript",
                    "sha256": NATIVE_TRANSCRIPT_SHA256,
                    "entrypoint": "main",
                }
            ]
            if include_probe
            else []
        ),
    }


def build_native_reference_bundle(
    directory: Path,
    build: NativeReferenceBuild,
    *,
    mode: str = "good",
    include_probe: bool = True,
    extra_args: tuple[str, ...] = (),
) -> NativeBundleFixture:
    host_os, host_arch = host_platform()
    manifest = native_reference_manifest(
        mode=mode,
        include_probe=include_probe,
        extra_args=extra_args,
    )
    source = directory / "source"
    (source / "runtime").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "probes").mkdir()
    (source / "sbom").mkdir()
    (source / "licenses").mkdir()
    artifact_relative = manifest["backend"]["entrypoints"][0]["runtime"]["artifact"]
    artifact = source.joinpath(*artifact_relative.split("/"))
    shutil.copyfile(build.executable, artifact)
    shutil.copyfile(V3_SCHEMA, source / "schemas" / "manifest-v3.schema.json")
    shutil.copyfile(RUST_REFERENCE / "LICENSE", source / "licenses" / "LICENSE")
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    if include_probe:
        shutil.copyfile(
            NATIVE_TRANSCRIPT,
            source / "probes" / "native-control.json",
        )
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000033",
        "version": 1,
        "components": [
            {
                "type": "application",
                "name": "candlescope-native-reference",
                "version": NATIVE_PLUGIN_VERSION,
                "hashes": [
                    {
                        "alg": "SHA-256",
                        "content": build.sha256.removeprefix("sha256:"),
                    }
                ],
            }
        ],
    }
    (source / "sbom" / "cyclonedx.json").write_text(
        json.dumps(sbom, indent=2), encoding="utf-8"
    )
    bundle = build_platform_bundle(
        source,
        directory / f"native-reference-{mode}.cspkg",
        operating_systems=(host_os,),
        architectures=(host_arch,),
    )
    return NativeBundleFixture(bundle, source, manifest, artifact, mode)


def build_python_fallback_bundle(
    directory: Path,
    *,
    version: str = "0.0.9",
) -> PythonFallbackBundleFixture:
    directory.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "schemaVersion": 2,
        "plugin": {
            "id": NATIVE_PLUGIN_ID,
            "name": NATIVE_PLUGIN_NAME,
            "version": version,
            "publisher": "candlescope",
            "license": "MIT",
            "engines": {"candlescope": ">=0.4.0 <0.5.0"},
        },
        "backend": {
            "entrypoints": [
                {
                    "id": "main",
                    "pythonModule": (
                        "candlescope_plugin_sdk.platform_v2.examples.hello_command"
                    ),
                    "resourceProfile": "minimal",
                    "activationEvents": ["onCommand"],
                }
            ]
        },
        "contributions": [
            {
                "id": "hello",
                "kind": "command/1",
                "title": "Say hello",
                "entrypoint": "main",
                "configuration": {},
            }
        ],
        "permissions": {"required": [], "optional": []},
        "probes": [],
    }
    source = directory / "source"
    (source / "wheels").mkdir(parents=True)
    (source / "schemas").mkdir()
    (source / "sbom").mkdir()
    wheel = build_platform_sdk_wheel(directory / "wheelhouse", manifest)
    shutil.copyfile(wheel, source / "wheels" / wheel.name)
    shutil.copyfile(V2_SCHEMA, source / "schemas" / "manifest-v2.schema.json")
    (source / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:00000000-0000-4000-8000-000000000034",
        "version": 1,
        "components": [
            {
                "type": "library",
                "name": "candlescope-plugin-sdk",
                "version": "0.2.0",
            }
        ],
    }
    (source / "sbom" / "cyclonedx.json").write_text(
        json.dumps(sbom, indent=2), encoding="utf-8"
    )
    bundle = build_platform_bundle(
        source,
        directory / f"native-reference-python-fallback-{version}.cspkg",
        python_requires=">=3.11,<3.14",
        operating_systems=("linux", "macos", "windows"),
        architectures=("arm64", "x86_64"),
    )
    return PythonFallbackBundleFixture(bundle, source, manifest)
