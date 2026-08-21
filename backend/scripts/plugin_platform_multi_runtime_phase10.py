"""Phase 10 signed multi-runtime Marketplace reference gate.

The build subcommand creates deterministic Marketplace-specific wrappers for
the already reviewed ta4j Java and aho-corasick native adapters.  It does not
compile on an end-user machine: all runtime payloads must already be present
and are re-enveloped only to bind the Marketplace SBOM identity.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)
from plugin_sdk_isolation import pin_in_repo_plugin_sdk

pin_in_repo_plugin_sdk(BACKEND_ROOT)

from app.plugin_installer_v2.bundle import (  # noqa: E402
    VerifiedPlatformBundle,
    build_platform_bundle,
    verify_platform_bundle,
)
from app.plugin_marketplace_v2 import (  # noqa: E402
    MarketplaceRoot,
    encode_base64url,
    key_id,
    verify_marketplace_index,
)
from app.plugin_marketplace_v2.models import ZERO_SHA256  # noqa: E402
from candlescope_plugin_sdk.platform_v2 import (  # noqa: E402
    canonical_dumps,
    canonical_sha256,
)
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: E402
    Ed25519PrivateKey,
)


TA4J_ROOT = REPOSITORY_ROOT / "examples" / "plugins" / "ta4j-elliott-adapter"
AHO_ROOT = REPOSITORY_ROOT / "examples" / "plugins" / "aho-corasick-adapter"
MANIFEST_SCHEMA = (
    SDK_SOURCE
    / "candlescope_plugin_sdk"
    / "platform_v2"
    / "schemas"
    / "manifest-v3.schema.json"
)
JAVA_RUNTIME_ID = "temurin-26.0.2.10"
TA4J_SOURCE_COMMIT = "07f6659d915081c2639f59ee82a87c32c9eccf36"
AHO_SOURCE_COMMIT = "be9ac39a2c2984255433d0b0a4fea28393f785a5"
SOURCE_REPOSITORY = "https://github.com/helenananaa/CandleScope"
REFERENCE_ORIGIN = "https://plugins.candlescope.invalid"
REFERENCE_MARKETPLACE_ID = "candlescope.phase10.reference"
REFERENCE_INDEX_URL = f"{REFERENCE_ORIGIN}/index-v2.json"
REAL_GATE_SCHEMA_VERSION = "candlescope.plugin-platform-phase10-real/1"
REAL_EVIDENCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "evidence"
    / "plugin-platform-multi-runtime-phase10-real.json"
)


class Phase10GateError(RuntimeError):
    pass


def _sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _reference_private_key(label: str) -> Ed25519PrivateKey:
    """Return a deterministic, non-production key used only by this real gate.

    The corresponding root is injected into the temporary CorePluginPlatform;
    it is never added to CandleScope's build-pinned production roots.  Stable
    conformance keys keep the signed release chain reproducible without
    pretending that this repository contains a deployable Marketplace secret.
    """

    seed = hashlib.sha256(
        f"CandleScope Phase 10 non-production reference key: {label}".encode()
    ).digest()
    return Ed25519PrivateKey.from_private_bytes(seed)


def _public_key_bytes(private_key: Ed25519PrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def _signature(
    private_key: Ed25519PrivateKey,
    statement: dict[str, Any],
) -> dict[str, str]:
    public_key = _public_key_bytes(private_key)
    return {
        "algorithm": "ed25519",
        "keyId": key_id(public_key),
        "value": encode_base64url(
            private_key.sign(canonical_dumps(statement).encode("utf-8"))
        ),
    }


class _SignedReferenceMarketplace:
    """Build an append-only signed index chain for the real Phase 10 gate."""

    def __init__(self) -> None:
        self.root_private_key = _reference_private_key("root")
        self.publisher_private_keys = {
            "candlescope": _reference_private_key("publisher:candlescope"),
            "candlescope-contributors": _reference_private_key(
                "publisher:candlescope-contributors"
            ),
        }
        self.releases: list[dict[str, Any]] = []

    @property
    def root(self) -> MarketplaceRoot:
        public_key = _public_key_bytes(self.root_private_key)
        return MarketplaceRoot(
            REFERENCE_MARKETPLACE_ID,
            REFERENCE_INDEX_URL,
            key_id(public_key),
            public_key,
            True,
        )

    @property
    def publishers(self) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        for publisher_id in sorted(self.publisher_private_keys):
            public_key = _public_key_bytes(self.publisher_private_keys[publisher_id])
            official = publisher_id == "candlescope"
            values.append(
                {
                    "publisherId": publisher_id,
                    "displayName": (
                        "CandleScope Official"
                        if official
                        else "CandleScope Contributors"
                    ),
                    "keyId": key_id(public_key),
                    "publicKey": encode_base64url(public_key),
                    "status": "active",
                    "verificationTier": "official" if official else "verified",
                }
            )
        return values

    def add_release(
        self,
        projection: dict[str, Any],
        *,
        published_at: str,
        official_maintained: bool,
        rollout_stage: str = "stable",
    ) -> dict[str, Any]:
        publisher_id = str(projection["publisherId"])
        private_key = self.publisher_private_keys.get(publisher_id)
        if private_key is None:
            raise Phase10GateError(
                f"reference projection has unknown publisher: {publisher_id}"
            )
        artifact_statement = copy.deepcopy(projection["artifact"])
        artifact_signature_statement = {
            "pluginId": projection["pluginId"],
            "version": projection["version"],
            "publisherId": publisher_id,
            "artifact": artifact_statement,
        }
        artifact = {
            **artifact_statement,
            "signature": _signature(private_key, artifact_signature_statement),
        }
        permissions = {
            kind: sorted(
                copy.deepcopy(projection["permissions"][kind]),
                key=lambda item: item["id"],
            )
            for kind in ("required", "optional")
        }
        sha256_sums = (
            f"{artifact['sha256'].removeprefix('sha256:')}  {artifact['fileName']}\n"
        )
        statement = {
            "pluginId": projection["pluginId"],
            "version": projection["version"],
            "publisherId": publisher_id,
            "artifacts": [artifact],
            "publishedAt": published_at,
            "licenseExpression": projection["licenseExpression"],
            "dependencies": copy.deepcopy(projection["dependencies"]),
            "minimumHostVersion": "0.4.0",
            "rolloutStage": rollout_stage,
            "officialMaintained": official_maintained,
            "permissions": permissions,
            "sha256Sums": sha256_sums,
            "sha256SumsSha256": _sha256_bytes(sha256_sums.encode("utf-8")),
        }
        signature = _signature(private_key, statement)
        leaf = canonical_sha256({"statement": statement, "signature": signature})
        previous = (
            self.releases[-1]["transparency"]["recordSha256"]
            if self.releases
            else ZERO_SHA256
        )
        log_index = len(self.releases) + 1
        record = canonical_sha256(
            {
                "logIndex": log_index,
                "leafSha256": leaf,
                "previousRecordSha256": previous,
            }
        )
        release = {
            **statement,
            "signature": signature,
            "transparency": {
                "logIndex": log_index,
                "leafSha256": leaf,
                "previousRecordSha256": previous,
                "recordSha256": record,
            },
        }
        self.releases.append(release)
        return copy.deepcopy(release)

    def index_bytes(
        self,
        *,
        sequence: int,
        generated_at: datetime,
        release_count: int,
        previous_index_sha256: str | None,
        revocations: list[dict[str, Any]] | None = None,
    ) -> bytes:
        releases = copy.deepcopy(self.releases[:release_count])
        body = {
            "schemaVersion": "candlescope.marketplace-index/2",
            "marketplace": {
                "id": REFERENCE_MARKETPLACE_ID,
                "sequence": sequence,
                "generatedAt": generated_at.isoformat().replace("+00:00", "Z"),
                "expiresAt": (generated_at + timedelta(days=30))
                .isoformat()
                .replace("+00:00", "Z"),
                "previousIndexSha256": previous_index_sha256,
                "sourceOrigin": REFERENCE_ORIGIN,
                "transparencyHeadSha256": (
                    releases[-1]["transparency"]["recordSha256"]
                    if releases
                    else ZERO_SHA256
                ),
            },
            "publishers": self.publishers,
            "releases": releases,
            "revocations": sorted(
                copy.deepcopy(revocations or []),
                key=lambda item: (
                    item["scope"],
                    item["subject"],
                    item["effectiveAt"],
                ),
            ),
        }
        document = {
            **body,
            "signature": _signature(self.root_private_key, body),
        }
        return canonical_dumps(document).encode("utf-8")


def _content(bundle: VerifiedPlatformBundle, path: str) -> Any:
    try:
        return next(item for item in bundle.envelope.contents if item.path == path)
    except StopIteration as exc:
        raise Phase10GateError(f"bundle content is missing: {path}") from exc


def _copy(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise Phase10GateError(f"reference input is not a regular file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def _normalize_sbom(
    path: Path,
    *,
    plugin_id: str,
    version: str,
    plugin_license: str,
) -> None:
    value = json.loads(path.read_text(encoding="utf-8"))
    metadata = value.get("metadata")
    component = metadata.get("component") if isinstance(metadata, dict) else None
    if not isinstance(component, dict):
        raise Phase10GateError("reference SBOM has no application component")
    component["name"] = plugin_id
    component["version"] = version
    component["licenses"] = [{"license": {"id": plugin_license}}]
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _license_inventory(
    *,
    plugin_license: str,
    dependencies: list[dict[str, str]],
    runtime_licenses: list[str],
) -> str:
    from candlescope_plugin_sdk.platform_v2 import canonical_sha256

    return canonical_sha256(
        {
            "plugin": plugin_license,
            "dependencies": dependencies,
            "runtimeLicenses": sorted(runtime_licenses),
        }
    )


def _provenance(
    *,
    source_commit: str,
    project_root: Path,
    receipt_relative: str,
    rebuild_relative: str,
) -> dict[str, Any]:
    receipt = project_root / receipt_relative
    rebuild = project_root / rebuild_relative
    commit_path = project_root.relative_to(REPOSITORY_ROOT).as_posix()
    return {
        "sourceRepository": SOURCE_REPOSITORY,
        "sourceCommit": source_commit,
        "buildReceiptUrl": (
            f"https://raw.githubusercontent.com/helenananaa/CandleScope/"
            f"{source_commit}/{commit_path}/{receipt_relative}"
        ),
        "buildReceiptSha256": _sha256_bytes(receipt.read_bytes()),
        "rebuildInstructionsUrl": (
            f"https://raw.githubusercontent.com/helenananaa/CandleScope/"
            f"{source_commit}/{commit_path}/{rebuild_relative}"
        ),
        "rebuildInstructionsSha256": _sha256_bytes(rebuild.read_bytes()),
        "reproducibleBuilds": True,
    }


def _dependencies_from_sbom(bundle: VerifiedPlatformBundle) -> list[dict[str, str]]:
    import zipfile

    with zipfile.ZipFile(bundle.path, "r") as archive:
        value = json.loads(archive.read("sbom/cyclonedx.json"))
    dependencies: list[dict[str, str]] = []
    for item in value.get("components", []):
        licenses = item.get("licenses")
        if not isinstance(licenses, list) or len(licenses) != 1:
            raise Phase10GateError("SBOM dependency must have one license expression")
        license_item = licenses[0]
        expression = license_item.get("expression")
        if expression is None and isinstance(license_item.get("license"), dict):
            expression = license_item["license"].get("id")
        if not isinstance(expression, str):
            raise Phase10GateError("SBOM dependency license is invalid")
        dependencies.append(
            {
                "name": str(item["name"]).replace("_", "-").lower(),
                "version": str(item["version"]),
                "licenseExpression": expression,
            }
        )
    return sorted(dependencies, key=lambda item: (item["name"], item["version"]))


def _release_projection(
    bundle: VerifiedPlatformBundle,
    *,
    source_commit: str,
    project_root: Path,
    receipt_relative: str,
    rebuild_relative: str,
    runtime_binding: dict[str, Any],
    runtime_licenses: list[str],
) -> dict[str, Any]:
    plugin = bundle.manifest.plugin
    dependencies = _dependencies_from_sbom(bundle)
    sbom = _content(bundle, "sbom/cyclonedx.json")
    return {
        "pluginId": plugin.id,
        "version": plugin.version,
        "publisherId": plugin.publisher,
        "licenseExpression": plugin.license,
        "permissions": bundle.manifest.permissions.to_wire(),
        "dependencies": dependencies,
        "artifact": {
            "artifactId": "windows-x86_64",
            "os": "windows",
            "arch": "x86_64",
            "fileName": bundle.path.name,
            "url": f"{REFERENCE_ORIGIN}/artifacts/{bundle.path.name}",
            "sha256": bundle.sha256,
            "size": bundle.size,
            "manifestSha256": bundle.manifest_sha256,
            "sbomSha256": sbom.sha256,
            "licenseInventorySha256": _license_inventory(
                plugin_license=plugin.license,
                dependencies=dependencies,
                runtime_licenses=runtime_licenses,
            ),
            "runtimeBindings": [runtime_binding],
            "provenance": _provenance(
                source_commit=source_commit,
                project_root=project_root,
                receipt_relative=receipt_relative,
                rebuild_relative=rebuild_relative,
            ),
            "reviewPolicy": {
                "distribution": "prebuilt-only",
                "sourceBuild": False,
                "systemRuntimeFallback": False,
                "undeclaredDownloads": False,
            },
        },
    }


def build_ta4j_marketplace_bundle(
    directory: Path,
    *,
    version: str,
    runtime_artifact: Path,
    transcript: dict[str, Any],
) -> tuple[VerifiedPlatformBundle, dict[str, Any]]:
    source = directory / "source"
    for name in ("runtime", "schemas", "probes", "sbom", "licenses"):
        (source / name).mkdir(parents=True, exist_ok=True)
    manifest = json.loads((TA4J_ROOT / "manifest.json").read_text(encoding="utf-8"))
    manifest["plugin"]["version"] = version
    runtime = manifest["backend"]["entrypoints"][0]["runtime"]
    runtime["runtimeId"] = JAVA_RUNTIME_ID
    runtime["artifact"] = f"runtime/ta4j-elliott-adapter-{version}.jar"
    manifest["probes"][0]["sha256"] = transcript["expected"]["transcriptSha256"]
    (source / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    jar_path = str(runtime["artifact"])
    _copy(runtime_artifact, source / jar_path)
    _copy(MANIFEST_SCHEMA, source / "schemas" / MANIFEST_SCHEMA.name)
    (source / "probes" / "ta4j-control.json").write_text(
        json.dumps(
            transcript, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    _copy(
        TA4J_ROOT / "sbom" / "cyclonedx.json",
        source / "sbom" / "cyclonedx.json",
    )
    _normalize_sbom(
        source / "sbom" / "cyclonedx.json",
        plugin_id=str(manifest["plugin"]["id"]),
        version=version,
        plugin_license=str(manifest["plugin"]["license"]),
    )
    for license_path in sorted(TA4J_ROOT.joinpath("licenses").iterdir()):
        _copy(license_path, source / "licenses" / license_path.name)
    _copy(REPOSITORY_ROOT / "LICENSE", source / "licenses" / "GPL-3.0-only.txt")
    bundle = build_platform_bundle(
        source,
        directory / f"ta4j-elliott-adapter-{version}-windows-x86_64.cspkg",
        operating_systems=("windows",),
        architectures=("x86_64",),
    )
    jar = _content(bundle, jar_path)
    registry_sha256 = (
        "sha256:815409a99dc7dd77297b86bc1cefce92abcbee5ac53f20c0ea20dd3c254a390d"
    )
    projection = _release_projection(
        bundle,
        source_commit=TA4J_SOURCE_COMMIT,
        project_root=TA4J_ROOT,
        receipt_relative=f"evidence/build-report-{version}.json",
        rebuild_relative="README_zh.md",
        runtime_binding={
            "entrypointId": "main",
            "runtimeKind": "java-jar",
            "runtimeId": JAVA_RUNTIME_ID,
            "pluginArtifactPath": jar.path,
            "pluginArtifactSha256": jar.sha256,
            "supplySource": "host-managed",
            "hostRuntime": {
                "registryId": "candlescope.reference-runtime",
                "registryRevision": 5,
                "registrySha256": registry_sha256,
                "runtimeArtifactSha256": (
                    "sha256:4323e886b6320e2166072bdfd604a4236c3dba6e5ab289e10aef623f09d355a0"
                ),
                "licenseExpression": "GPL-2.0 WITH Classpath-exception-2.0",
            },
        },
        runtime_licenses=["GPL-2.0 WITH Classpath-exception-2.0"],
    )
    return bundle, projection


def _ta4j_candidate_transcript(
    jar: Path,
    *,
    version: str,
    jdk_home: Path,
) -> dict[str, Any]:
    transcript = json.loads(
        (TA4J_ROOT / "probes" / "ta4j-control.json").read_text(encoding="utf-8")
    )
    requests = transcript.get("requests")
    if not isinstance(requests, list) or len(requests) != 8:
        raise Phase10GateError("ta4j reviewed control transcript shape drifted")
    java = jdk_home / "bin" / ("java.exe" if os.name == "nt" else "java")
    if java.is_symlink() or not java.is_file():
        raise Phase10GateError("ta4j publisher JDK has no regular java executable")
    payload = "".join(f"{canonical_dumps(item)}\n" for item in requests)
    completed = subprocess.run(
        (
            str(java),
            "-Dfile.encoding=UTF-8",
            "-Djava.awt.headless=true",
            "-Xms32m",
            "-Xmx256m",
            "-XX:+UseSerialGC",
            "-jar",
            str(jar),
        ),
        cwd=TA4J_ROOT,
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=45,
        check=False,
    )
    if completed.returncode != 0:
        raise Phase10GateError(
            f"ta4j {version} transcript process failed: {completed.stderr[-2_000:]}"
        )
    try:
        responses = [json.loads(line) for line in completed.stdout.splitlines()]
    except json.JSONDecodeError as exc:
        raise Phase10GateError(
            f"ta4j {version} transcript returned invalid JSONL"
        ) from exc
    if (
        len(responses) != len(requests)
        or not all(isinstance(item, dict) and "error" not in item for item in responses)
        or responses[0]
        .get("result", {})
        .get("descriptor", {})
        .get("plugin", {})
        .get("version")
        != version
    ):
        raise Phase10GateError(
            f"ta4j {version} transcript identity or response count drifted"
        )
    transcript["expected"] = {
        "responseSha256": [canonical_sha256(item) for item in responses],
        "transcriptSha256": canonical_sha256(responses),
    }
    return transcript


def _build_ta4j_candidate(
    directory: Path,
    *,
    version: str,
    jdk_home: Path,
    dependency_cache: Path,
) -> tuple[Path, dict[str, Any]]:
    directory.mkdir(parents=True, exist_ok=False)
    output = directory / f"ta4j-elliott-adapter-{version}.jar"
    report = directory / f"build-report-{version}.json"
    command = (
        sys.executable,
        str(TA4J_ROOT / "scripts" / "build_release.py"),
        "--jdk-home",
        str(jdk_home),
        "--dependency-cache",
        str(dependency_cache),
        "--candidate-version",
        version,
        "--output",
        str(output),
        "--report",
        str(report),
    )
    completed = subprocess.run(
        command,
        cwd=TA4J_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if completed.returncode != 0:
        raise Phase10GateError(
            f"ta4j {version} publisher build failed: "
            + (completed.stderr or completed.stdout)[-2_000:]
        )
    expected_report = TA4J_ROOT / "evidence" / f"build-report-{version}.json"
    if report.read_bytes() != expected_report.read_bytes():
        raise Phase10GateError(
            f"ta4j {version} publisher build receipt does not match reviewed evidence"
        )
    expected = json.loads(expected_report.read_text(encoding="utf-8"))["output"]
    if (
        output.name != expected["path"]
        or output.stat().st_size != expected["size"]
        or _sha256_bytes(output.read_bytes()) != expected["sha256"]
    ):
        raise Phase10GateError(
            f"ta4j {version} publisher artifact does not match reviewed evidence"
        )
    return output, _ta4j_candidate_transcript(
        output,
        version=version,
        jdk_home=jdk_home,
    )


def _build_reviewed_aho_bundle(directory: Path) -> VerifiedPlatformBundle:
    output = directory / "reviewed-aho.cspkg"
    command = (
        sys.executable,
        str(BACKEND_ROOT / "scripts" / "candlescope_plugin.py"),
        "v3",
        "--json",
        "build",
        str(AHO_ROOT),
        str(output),
        "--os",
        "windows",
        "--arch",
        "x86_64",
    )
    completed = subprocess.run(
        command,
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if completed.returncode != 0:
        raise Phase10GateError(
            "reviewed aho-corasick bundle build failed: "
            + (completed.stderr or completed.stdout)[-2_000:]
        )
    return verify_platform_bundle(
        output,
        expected_sha256=_sha256_bytes(output.read_bytes()),
        host_version="0.4.0",
    )


def build_aho_marketplace_bundle(
    directory: Path,
) -> tuple[VerifiedPlatformBundle, dict[str, Any]]:
    reviewed = _build_reviewed_aho_bundle(directory / "reviewed")
    source = directory / "source"
    reviewed.extract_to(source)
    (source / "bundle.json").unlink()
    _normalize_sbom(
        source / "sbom" / "cyclonedx.json",
        plugin_id=reviewed.manifest.plugin.id,
        version=reviewed.manifest.plugin.version,
        plugin_license=reviewed.manifest.plugin.license,
    )
    bundle = build_platform_bundle(
        source,
        directory / "aho-corasick-adapter-0.1.0-windows-x86_64.cspkg",
        operating_systems=("windows",),
        architectures=("x86_64",),
    )
    executable = _content(bundle, "runtime/adapter.exe")
    projection = _release_projection(
        bundle,
        source_commit=AHO_SOURCE_COMMIT,
        project_root=AHO_ROOT,
        receipt_relative="build-receipt.json",
        rebuild_relative="README_zh.md",
        runtime_binding={
            "entrypointId": "main",
            "runtimeKind": "native-executable",
            "runtimeId": "native-host",
            "pluginArtifactPath": executable.path,
            "pluginArtifactSha256": executable.sha256,
            "supplySource": "plugin-bundled",
            "hostRuntime": None,
        },
        runtime_licenses=[],
    )
    return bundle, projection


def build_references(
    output_directory: Path,
    *,
    jdk_home: Path,
    dependency_cache: Path,
) -> dict[str, Any]:
    output_directory.mkdir(parents=True, exist_ok=False)
    ta4j_011_jar, ta4j_011_transcript = _build_ta4j_candidate(
        output_directory / "publisher-ta4j-0.1.1",
        version="0.1.1",
        jdk_home=jdk_home,
        dependency_cache=dependency_cache,
    )
    ta4j_012_jar, ta4j_012_transcript = _build_ta4j_candidate(
        output_directory / "publisher-ta4j-0.1.2",
        version="0.1.2",
        jdk_home=jdk_home,
        dependency_cache=dependency_cache,
    )
    ta4j_011, ta4j_011_release = build_ta4j_marketplace_bundle(
        output_directory / "ta4j-0.1.1",
        version="0.1.1",
        runtime_artifact=ta4j_011_jar,
        transcript=ta4j_011_transcript,
    )
    ta4j_012, ta4j_012_release = build_ta4j_marketplace_bundle(
        output_directory / "ta4j-0.1.2",
        version="0.1.2",
        runtime_artifact=ta4j_012_jar,
        transcript=ta4j_012_transcript,
    )
    aho, aho_release = build_aho_marketplace_bundle(output_directory / "aho-0.1.0")
    return {
        "schemaVersion": "candlescope.phase10-reference-build/1",
        "artifacts": [
            ta4j_011_release,
            aho_release,
            ta4j_012_release,
        ],
        "paths": {
            ta4j_011_release["pluginId"] + "@0.1.1": str(ta4j_011.path),
            aho_release["pluginId"] + "@0.1.0": str(aho.path),
            ta4j_012_release["pluginId"] + "@0.1.2": str(ta4j_012.path),
        },
    }


def build_signed_reference_chain(
    references: dict[str, Any],
    *,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    projections = references["artifacts"]
    if (
        not isinstance(projections, list)
        or len(projections) != 3
        or [item["pluginId"] for item in projections]
        != [
            "candlescope.ta4j-elliott",
            "candlescope.aho-corasick",
            "candlescope.ta4j-elliott",
        ]
        or [item["version"] for item in projections] != ["0.1.1", "0.1.0", "0.1.2"]
    ):
        raise Phase10GateError("reference release projections are incomplete")
    signer = _SignedReferenceMarketplace()
    signer.add_release(
        projections[0],
        published_at="2026-08-03T00:00:00Z",
        official_maintained=True,
    )
    signer.add_release(
        projections[1],
        published_at="2026-08-03T00:01:00Z",
        official_maintained=False,
    )
    signer.add_release(
        projections[2],
        published_at="2026-08-03T00:02:00Z",
        official_maintained=True,
    )
    generated = generated_at or datetime.now(UTC).replace(microsecond=0)
    index_1 = signer.index_bytes(
        sequence=1,
        generated_at=generated,
        release_count=2,
        previous_index_sha256=None,
    )
    index_1_sha256 = _sha256_bytes(index_1)
    index_2 = signer.index_bytes(
        sequence=2,
        generated_at=generated,
        release_count=3,
        previous_index_sha256=index_1_sha256,
    )
    index_2_sha256 = _sha256_bytes(index_2)
    revoked_digest = projections[1]["artifact"]["sha256"]
    index_3 = signer.index_bytes(
        sequence=3,
        generated_at=generated,
        release_count=3,
        previous_index_sha256=index_2_sha256,
        revocations=[
            {
                "scope": "artifact",
                "subject": revoked_digest,
                "reasonCode": "MALICIOUS_RELEASE",
                "effectiveAt": generated.isoformat().replace("+00:00", "Z"),
            }
        ],
    )
    indexes = (index_1, index_2, index_3)
    verified = tuple(
        verify_marketplace_index(value, root=signer.root) for value in indexes
    )
    if (
        [item.sequence for item in verified] != [1, 2, 3]
        or [len(item.releases) for item in verified] != [2, 3, 3]
        or len(verified[2].revocations) != 1
        or not verified[2].is_revoked(verified[2].releases[1])
    ):
        raise Phase10GateError("signed reference index chain verification drifted")
    return {
        "root": signer.root,
        "indexes": indexes,
        "indexSha256": [_sha256_bytes(value) for value in indexes],
        "publisherKeyIds": [item["keyId"] for item in signer.publishers],
        "revokedArtifactSha256": revoked_digest,
    }


class _LocalMarketplaceFetcher:
    def __init__(self, values: dict[str, bytes]) -> None:
        self.values = dict(values)
        self.calls: list[str] = []
        self.offline = False

    def get(self, url: str, *, maximum: int) -> bytes:
        self.calls.append(url)
        if self.offline:
            raise Phase10GateError(f"offline Marketplace fetch attempted: {url}")
        value = self.values.get(url)
        if value is None:
            raise Phase10GateError(f"unmapped Marketplace fetch attempted: {url}")
        if len(value) > maximum:
            raise Phase10GateError(f"Marketplace fixture exceeds signed maximum: {url}")
        return value


class _LocalRuntimeEvidenceFetcher:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)
        self.calls: list[str] = []

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        source = self.root / url.rsplit("/", 1)[-1]
        if source.is_symlink() or not source.is_file():
            raise Phase10GateError(f"missing frozen JRE evidence: {source.name}")
        if source.stat().st_size > maximum:
            raise Phase10GateError("frozen JRE evidence exceeds the signed maximum")
        shutil.copyfile(source, destination)


def _process_exited(process_id: int) -> bool:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(0x00100000, False, process_id)
    if not handle:
        return True
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0
    finally:
        kernel32.CloseHandle(handle)


async def _wait_for_exit(process_id: int) -> bool:
    for _attempt in range(200):
        if _process_exited(process_id):
            return True
        await asyncio.sleep(0.025)
    return _process_exited(process_id)


def _projection(
    references: dict[str, Any],
    plugin_id: str,
    version: str,
) -> dict[str, Any]:
    matches = [
        item
        for item in references["artifacts"]
        if item["pluginId"] == plugin_id and item["version"] == version
    ]
    if len(matches) != 1:
        raise Phase10GateError(
            f"reference projection is not unique: {plugin_id}@{version}"
        )
    return matches[0]


def _reference_artifact_bytes(references: dict[str, Any]) -> dict[str, bytes]:
    values: dict[str, bytes] = {}
    for projection in references["artifacts"]:
        key = f"{projection['pluginId']}@{projection['version']}"
        path = Path(references["paths"][key]).resolve(strict=True)
        payload = path.read_bytes()
        artifact = projection["artifact"]
        if (
            len(payload) != artifact["size"]
            or _sha256_bytes(payload) != artifact["sha256"]
        ):
            raise Phase10GateError(f"reference artifact projection drifted: {key}")
        values[artifact["url"]] = payload
    if len(values) != 3:
        raise Phase10GateError("reference artifact URLs are not unique")
    return values


async def _inspect_active_runtime(
    platform: Any,
    *,
    plugin_id: str,
    expected_version: str,
    expected_runtime_kind: str,
    profiles: set[str],
    process_ids: set[int],
) -> dict[str, Any]:
    supervisor = await platform._ensure_active(plugin_id, "main")
    await supervisor.health_check()
    snapshot = supervisor.snapshot()
    policy = supervisor.spec.sandbox_policy
    transport = snapshot.get("transport")
    if (
        supervisor.spec.trust_level != "untrusted"
        or policy is None
        or snapshot.get("state") != "active"
        or not isinstance(transport, dict)
        or transport.get("processTreeControl") is not True
        or not isinstance(transport.get("pid"), int)
    ):
        raise Phase10GateError(
            f"signed Marketplace runtime is not sandboxed: {plugin_id}"
        )
    configs = sorted(policy.runtime_directory.glob("launch-*/config.json"))
    if not configs:
        raise Phase10GateError(f"runtime sandbox config is missing: {plugin_id}")
    config = json.loads(configs[-1].read_text(encoding="utf-8"))
    detail = platform.management_detail(plugin_id)
    trust = detail.get("trust")
    plugin = detail.get("plugin", {})
    runtime = plugin.get("runtime", {}).get("entrypoints", [{}])[0]
    if (
        plugin.get("version") != expected_version
        or runtime.get("runtimeKind") != expected_runtime_kind
        or not isinstance(trust, dict)
        or trust.get("mode") != "marketplace-sandboxed"
        or trust.get("authorization", {}).get("sandbox", {}).get("active") is not True
        or trust.get("authorization", {}).get("sandbox", {}).get("status")
        != "windows-appcontainer"
        or not str(config.get("appContainerSid", "")).startswith("S-1-15-2-")
        or config.get("limits", {}).get("activeProcesses") != 1
    ):
        raise Phase10GateError(
            f"signed Marketplace trust evidence is incomplete: {plugin_id}"
        )
    profiles.add(policy.profile_name)
    process_ids.add(transport["pid"])
    authorization_entrypoint = trust.get("authorization", {}).get("entrypoints", [{}])[
        0
    ]
    return {
        "pluginId": plugin_id,
        "version": expected_version,
        "runtimeKind": expected_runtime_kind,
        "runtimeId": runtime.get("runtimeId"),
        "trustMode": trust["mode"],
        "sandboxStatus": trust["authorization"]["sandbox"]["status"],
        "hostManaged": authorization_entrypoint.get("hostManaged"),
        "activeProcessLimit": config["limits"]["activeProcesses"],
        "processTreeControl": True,
    }


async def _install_marketplace_release(
    platform: Any,
    fetcher: _LocalMarketplaceFetcher,
    projection: dict[str, Any],
    *,
    profiles: set[str],
    process_ids: set[int],
) -> dict[str, Any]:
    plugin_id = projection["pluginId"]
    version = projection["version"]
    artifact = projection["artifact"]
    calls_before = fetcher.calls.count(artifact["url"])
    first = platform.marketplace.prepare(plugin_id, version=version)
    if (
        first["compatibility"]["cacheReuse"] is not False
        or fetcher.calls.count(artifact["url"]) != calls_before + 1
    ):
        raise Phase10GateError(
            f"fresh Marketplace download semantics drifted: {plugin_id}@{version}"
        )
    fetcher.offline = True
    try:
        repeat = platform.marketplace.prepare(plugin_id, version=version)
    finally:
        fetcher.offline = False
    if (
        repeat["compatibility"]["cacheReuse"] is not True
        or fetcher.calls.count(artifact["url"]) != calls_before + 1
    ):
        raise Phase10GateError(
            f"offline Marketplace cache semantics drifted: {plugin_id}@{version}"
        )
    try:
        applied = platform.marketplace.apply(plugin_id)
    except Exception as exc:
        detail = exc.to_dict() if hasattr(exc, "to_dict") else str(exc)
        raise Phase10GateError(
            f"Marketplace apply failed for {plugin_id}@{version}: {detail}"
        ) from exc
    for permission in projection["permissions"]["required"]:
        platform.installer.grant_permission(
            plugin_id,
            permission["id"],
            scope=permission["scope"],
            source="management-api",
            trace_id=f"phase10-real-grant-{plugin_id}-{version}",
        )
    platform.marketplace.begin_activation(plugin_id)
    await platform.reconcile_plugin(plugin_id)
    health = await platform.observe_plugin_health(plugin_id)
    platform.marketplace.finish_observation(
        plugin_id,
        healthy=True,
        detail=f"Phase 10 {projection['artifact']['runtimeBindings'][0]['runtimeKind']} gate passed",
    )
    runtime_kind = projection["artifact"]["runtimeBindings"][0]["runtimeKind"]
    runtime = await _inspect_active_runtime(
        platform,
        plugin_id=plugin_id,
        expected_version=version,
        expected_runtime_kind=runtime_kind,
        profiles=profiles,
        process_ids=process_ids,
    )
    return {
        "freshDownload": True,
        "offlineRepeat": True,
        "installationPath": applied["installation"]["installationPath"],
        "healthEntrypoints": len(health),
        "runtime": runtime,
    }


def _assert_catalog_assurances(catalog: dict[str, Any]) -> dict[str, Any]:
    entries = {item["pluginId"]: item for item in catalog["plugins"]}
    if (
        catalog.get("schemaVersion") != "candlescope.marketplace-catalog/2"
        or catalog.get("rollout", {}).get("channel") != "stable"
        or set(entries) != {"candlescope.ta4j-elliott", "candlescope.aho-corasick"}
    ):
        raise Phase10GateError("Marketplace v2 catalog is incomplete")
    java = entries["candlescope.ta4j-elliott"]
    native = entries["candlescope.aho-corasick"]
    if (
        java["publisher"].get("verificationTier") != "official"
        or java["assurances"].get("publisherVerified") is not True
        or java["assurances"].get("officialMaintained") is not True
        or java["assurances"].get("sandbox", {}).get("available") is not True
        or java["assurances"].get("permissions", {}).get("required", [{}])[0].get("id")
        != "market.bars.read"
        or native["publisher"].get("verificationTier") != "verified"
        or native["assurances"].get("publisherVerified") is not True
        or native["assurances"].get("officialMaintained") is not False
        or native["assurances"].get("sandbox", {}).get("available") is not True
        or not java.get("installable")
        or not native.get("installable")
    ):
        raise Phase10GateError("Marketplace trust assurances are conflated or absent")
    return {
        "publisherVerifiedSeparated": True,
        "officialMaintenanceSeparated": True,
        "sandboxAvailabilitySeparated": True,
        "permissionScopeSeparated": True,
        "rolloutStage": catalog["rollout"]["channel"],
    }


async def _real_gate_async(
    root: Path,
    *,
    jre_evidence_directory: Path,
    jdk_home: Path,
    dependency_cache: Path,
) -> dict[str, Any]:
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_installer_v2.registry import load_activation_registry
    from app.plugin_marketplace_v2 import MarketplaceError
    from app.plugin_runtime_registry_v3 import build_official_runtime_registry
    from app.plugin_security_v2 import delete_appcontainer_profile

    reference = build_references(
        root / "reference-build",
        jdk_home=jdk_home,
        dependency_cache=dependency_cache,
    )
    rebuilt = build_references(
        root / "reference-rebuild",
        jdk_home=jdk_home,
        dependency_cache=dependency_cache,
    )
    if reference["artifacts"] != rebuilt["artifacts"]:
        raise Phase10GateError("Marketplace reference rebuild is not deterministic")
    chain = build_signed_reference_chain(reference)
    artifact_values = _reference_artifact_bytes(reference)
    marketplace_fetcher = _LocalMarketplaceFetcher(artifact_values)
    runtime_fetcher = _LocalRuntimeEvidenceFetcher(jre_evidence_directory)
    registry = build_official_runtime_registry(
        root=root / "managed-runtimes",
        enabled=True,
        network_updates_enabled=False,
        fetcher=runtime_fetcher,
    )
    defaults = CorePluginPlatform(
        root=root / "defaults",
        host_name="CandleScope",
        host_version="0.4.0",
    )
    if defaults.marketplace_enabled or defaults.marketplace.enabled:
        raise Phase10GateError("Marketplace default was widened")
    platform = CorePluginPlatform(
        root=root / "product",
        host_name="CandleScope",
        host_version="0.4.0",
        marketplace_enabled=True,
        marketplace_roots=(chain["root"],),
        marketplace_fetcher=marketplace_fetcher,
        trust_ux_enabled=True,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=True,
        java_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    profiles: set[str] = set()
    process_ids: set[int] = set()
    lifecycle: dict[str, Any] = {}
    rollback_steps: list[dict[str, Any]] = []
    revocation: dict[str, Any] = {}
    await platform.start()
    try:
        imported_1 = platform.marketplace.import_index(
            chain["indexes"][0],
            marketplace_id=REFERENCE_MARKETPLACE_ID,
        )
        if imported_1["sequence"] != 1 or imported_1["releaseCount"] != 2:
            raise Phase10GateError("initial signed Marketplace index import drifted")
        catalog_assurances = _assert_catalog_assurances(
            platform.marketplace.public_catalog()
        )
        initial_status = platform.marketplace.status()
        if (
            initial_status.get("telemetry", {}).get("enabled") is not False
            or initial_status.get("telemetry", {}).get("uploadEnabled") is not False
        ):
            raise Phase10GateError("Marketplace telemetry is not local opt-in")

        java_011 = _projection(reference, "candlescope.ta4j-elliott", "0.1.1")
        aho = _projection(reference, "candlescope.aho-corasick", "0.1.0")
        lifecycle["javaInitial"] = await _install_marketplace_release(
            platform,
            marketplace_fetcher,
            java_011,
            profiles=profiles,
            process_ids=process_ids,
        )
        lifecycle["nativeInitial"] = await _install_marketplace_release(
            platform,
            marketplace_fetcher,
            aho,
            profiles=profiles,
            process_ids=process_ids,
        )
        runtime_repeat = registry.ensure(JAVA_RUNTIME_ID, "java", offline=True)
        if not runtime_repeat.quick_repeat or len(runtime_fetcher.calls) != 5:
            raise Phase10GateError("managed JRE fresh/offline semantics drifted")

        imported_2 = platform.marketplace.import_index(
            chain["indexes"][1],
            marketplace_id=REFERENCE_MARKETPLACE_ID,
        )
        if imported_2["sequence"] != 2 or imported_2["releaseCount"] != 3:
            raise Phase10GateError("signed Marketplace update index import drifted")
        update_status = platform.marketplace.update_status("candlescope.ta4j-elliott")
        if (
            update_status.get("available") is not True
            or update_status.get("latest", {}).get("version") != "0.1.2"
        ):
            raise Phase10GateError("signed Java update was not surfaced")
        java_012 = _projection(reference, "candlescope.ta4j-elliott", "0.1.2")
        lifecycle["javaUpdate"] = await _install_marketplace_release(
            platform,
            marketplace_fetcher,
            java_012,
            profiles=profiles,
            process_ids=process_ids,
        )

        rollback_reauthorized = False
        for _attempt in range(3):
            current = load_activation_registry(
                platform.installer.registry_path
            ).by_id()["candlescope.ta4j-elliott"]
            if current.version == "0.1.1":
                break
            rolled = platform.installer.rollback("candlescope.ta4j-elliott")
            await platform.reconcile_plugin("candlescope.ta4j-elliott")
            current = load_activation_registry(
                platform.installer.registry_path
            ).by_id()["candlescope.ta4j-elliott"]
            rollback_steps.append(
                {
                    "removed": rolled.removed,
                    "version": current.version,
                    "state": current.state,
                }
            )
        rolled_back = load_activation_registry(
            platform.installer.registry_path
        ).by_id()["candlescope.ta4j-elliott"]
        if rolled_back.version == "0.1.1" and rolled_back.state != "active":
            for permission in java_011["permissions"]["required"]:
                platform.installer.grant_permission(
                    "candlescope.ta4j-elliott",
                    permission["id"],
                    scope=permission["scope"],
                    source="management-api",
                    trace_id="phase10-rollback-reauthorize-java",
                )
            platform.installer.enable("candlescope.ta4j-elliott")
            await platform.reconcile_plugin("candlescope.ta4j-elliott")
            rollback_reauthorized = True
            rolled_back = load_activation_registry(
                platform.installer.registry_path
            ).by_id()["candlescope.ta4j-elliott"]
        if rolled_back.version != "0.1.1" or rolled_back.state != "active":
            raise Phase10GateError(
                "Java Marketplace update did not roll back to active 0.1.1: "
                f"current={rolled_back.version}/{rolled_back.state}, "
                f"steps={rollback_steps!r}"
            )
        platform.marketplace.mark_rolled_back(
            "candlescope.ta4j-elliott",
            detail="Phase 10 signed update rollback drill passed",
        )
        lifecycle["javaRolledBack"] = await _inspect_active_runtime(
            platform,
            plugin_id="candlescope.ta4j-elliott",
            expected_version="0.1.1",
            expected_runtime_kind="java-jar",
            profiles=profiles,
            process_ids=process_ids,
        )

        aho_installation = Path(lifecycle["nativeInitial"]["installationPath"])
        imported_3 = platform.marketplace.import_index(
            chain["indexes"][2],
            marketplace_id=REFERENCE_MARKETPLACE_ID,
        )
        if imported_3["sequence"] != 3 or imported_3["revocationCount"] != 1:
            raise Phase10GateError("signed revocation index import drifted")
        changed = platform.marketplace.enforce_trust_policy()
        await platform.reconcile_plugin("candlescope.aho-corasick")
        marketplace_status = platform.marketplace.status()
        aho_candidate = next(
            item
            for item in marketplace_status["candidates"]
            if item["pluginId"] == "candlescope.aho-corasick"
        )
        aho_record = load_activation_registry(platform.installer.registry_path).by_id()[
            "candlescope.aho-corasick"
        ]
        aho_source_bundle = Path(reference["paths"]["candlescope.aho-corasick@0.1.0"])
        if (
            changed != ("candlescope.aho-corasick",)
            or aho_candidate["phase"] != "quarantined"
            or aho_record.state == "active"
            or not aho_installation.is_dir()
            or not aho_source_bundle.is_file()
            or platform.marketplace._artifact_path(
                chain["revokedArtifactSha256"]
            ).exists()
            or len(marketplace_status.get("quarantine", [])) != 1
        ):
            raise Phase10GateError("signed native revocation quarantine drifted")
        try:
            platform.marketplace.prepare("candlescope.aho-corasick", version="0.1.0")
        except MarketplaceError as exc:
            if exc.code != "PLUGIN_MARKETPLACE_RELEASE_NOT_FOUND":
                raise
        else:
            raise Phase10GateError("revoked native release remained installable")
        revocation = {
            "disabled": True,
            "candidateQuarantined": True,
            "cachedArtifactQuarantined": True,
            "installedPayloadRetained": True,
            "localSourceArtifactRetained": True,
            "reasonCode": "MALICIOUS_RELEASE",
        }
    finally:
        await platform.stop()
        residual = [pid for pid in process_ids if not await _wait_for_exit(pid)]
        for profile in sorted(profiles):
            delete_appcontainer_profile(profile)
    if residual or platform.manager.owner_keys():
        raise Phase10GateError(
            f"Marketplace lifecycle left residual processes: {residual}"
        )
    for item in lifecycle.values():
        item.pop("installationPath", None)
    projections = [
        {
            "pluginId": item["pluginId"],
            "version": item["version"],
            "runtimeKind": item["artifact"]["runtimeBindings"][0]["runtimeKind"],
            "artifactSha256": item["artifact"]["sha256"],
            "manifestSha256": item["artifact"]["manifestSha256"],
            "sbomSha256": item["artifact"]["sbomSha256"],
            "licenseInventorySha256": item["artifact"]["licenseInventorySha256"],
            "sourceCommit": item["artifact"]["provenance"]["sourceCommit"],
            "reproducibleBuilds": item["artifact"]["provenance"]["reproducibleBuilds"],
            "reviewPolicy": item["artifact"]["reviewPolicy"],
        }
        for item in reference["artifacts"]
    ]
    return {
        "schemaVersion": REAL_GATE_SCHEMA_VERSION,
        "generatedAt": datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "result": "pass",
        "signedIndexChain": {
            "marketplaceId": REFERENCE_MARKETPLACE_ID,
            "rootKeyId": chain["root"].key_id,
            "publisherKeyIds": chain["publisherKeyIds"],
            "sequences": [1, 2, 3],
            "indexSha256": chain["indexSha256"],
            "releaseCounts": [2, 3, 3],
            "revocationCounts": [0, 0, 1],
        },
        "referenceReleases": projections,
        "rebuild": {
            "independentBuilds": 2,
            "allArtifactDigestsEqual": True,
        },
        "catalogAssurances": catalog_assurances,
        "lifecycle": lifecycle,
        "update": {
            "fromVersion": "0.1.1",
            "toVersion": "0.1.2",
            "manualOnly": True,
            "passed": True,
        },
        "rollback": {
            "targetVersion": "0.1.1",
            "targetState": "active",
            "steps": rollback_steps,
            "reauthorizationRequired": rollback_reauthorized,
            "passed": True,
        },
        "revocation": revocation,
        "managedRuntime": {
            "runtimeId": runtime_repeat.release.runtime_id,
            "registryRevision": runtime_repeat.supply.registry_revision,
            "registrySha256": runtime_repeat.supply.registry_sha256,
            "archiveSha256": runtime_repeat.release.sha256,
            "offlineQuickRepeat": runtime_repeat.quick_repeat,
            "downloadedEvidenceFiles": len(runtime_fetcher.calls),
        },
        "marketplaceArtifacts": {
            "downloadCalls": len(marketplace_fetcher.calls),
            "uniqueDownloadUrls": len(set(marketplace_fetcher.calls)),
            "offlineCacheRepeat": True,
        },
        "telemetry": {
            "enabledByDefault": False,
            "uploadEnabled": False,
            "privacyFieldsExcluded": [
                "identifiers",
                "strategyInputs",
                "accounts",
                "pluginPrivateData",
            ],
        },
        "defaults": {
            "marketplaceEnabled": defaults.marketplace_enabled,
            "telemetryEnabled": False,
        },
        "sandbox": {
            "platform": "windows-x86_64",
            "runtimeKinds": ["java-jar", "native-executable"],
            "appContainer": True,
            "residualProcesses": 0,
            "residualSupervisors": 0,
        },
    }


def run_real_gate(
    *,
    jre_evidence_directory: Path,
    jdk_home: Path,
    dependency_cache: Path,
) -> dict[str, Any]:
    if os.name != "nt":
        raise Phase10GateError("Phase 10 real Marketplace gate requires Windows")
    with tempfile.TemporaryDirectory(prefix="candlescope-phase10-real-") as value:
        return asyncio.run(
            _real_gate_async(
                Path(value),
                jre_evidence_directory=jre_evidence_directory.resolve(strict=True),
                jdk_home=jdk_home.resolve(strict=True),
                dependency_cache=dependency_cache.resolve(strict=True),
            )
        )


def validate_real_gate_evidence() -> dict[str, Any]:
    if REAL_EVIDENCE_PATH.is_symlink() or not REAL_EVIDENCE_PATH.is_file():
        raise Phase10GateError("recorded Phase 10 real gate evidence is missing")
    value = json.loads(REAL_EVIDENCE_PATH.read_text(encoding="utf-8"))
    if (
        value.get("schemaVersion") != REAL_GATE_SCHEMA_VERSION
        or value.get("result") != "pass"
        or value.get("defaults", {}).get("marketplaceEnabled") is not False
        or value.get("telemetry", {}).get("enabledByDefault") is not False
        or value.get("sandbox", {}).get("residualProcesses") != 0
        or value.get("sandbox", {}).get("residualSupervisors") != 0
        or value.get("rebuild", {}).get("allArtifactDigestsEqual") is not True
        or value.get("update", {}).get("passed") is not True
        or value.get("rollback", {}).get("passed") is not True
        or value.get("revocation", {}).get("candidateQuarantined") is not True
    ):
        raise Phase10GateError("recorded Phase 10 real gate evidence is incomplete")
    kinds = {item.get("runtimeKind") for item in value.get("referenceReleases", [])}
    if kinds != {"java-jar", "native-executable"}:
        raise Phase10GateError("recorded Phase 10 release kinds are incomplete")
    return value


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--build-only",
        action="store_true",
        help="build and print deterministic reference projections without lifecycle gates",
    )
    parser.add_argument(
        "--run-real",
        action="store_true",
        help="run the Windows fresh/offline/update/rollback/revocation gate",
    )
    parser.add_argument("--output-directory", type=Path)
    parser.add_argument("--jre-evidence-directory", type=Path)
    parser.add_argument("--jdk-home", type=Path)
    parser.add_argument("--dependency-cache", type=Path)
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.build_only and args.run_real:
        raise Phase10GateError("choose either --build-only or --run-real")
    if args.build_only:
        if args.jdk_home is None or args.dependency_cache is None:
            raise Phase10GateError(
                "--build-only requires --jdk-home and --dependency-cache"
            )
        output = args.output_directory
        if output is None:
            output = Path(tempfile.mkdtemp(prefix="candlescope-phase10-reference-"))
            output.rmdir()
        result = build_references(
            output.resolve(strict=False),
            jdk_home=args.jdk_home.resolve(strict=True),
            dependency_cache=args.dependency_cache.resolve(strict=True),
        )
    elif args.run_real:
        if (
            args.jre_evidence_directory is None
            or args.jdk_home is None
            or args.dependency_cache is None
        ):
            raise Phase10GateError(
                "--run-real requires --jre-evidence-directory, --jdk-home, and --dependency-cache"
            )
        result = run_real_gate(
            jre_evidence_directory=args.jre_evidence_directory,
            jdk_home=args.jdk_home,
            dependency_cache=args.dependency_cache,
        )
    else:
        result = validate_real_gate_evidence()
    if args.output is not None:
        _atomic_json(args.output.resolve(strict=False), result)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Phase10GateError, OSError, ValueError) as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "errorType": type(exc).__name__,
                    "message": str(exc),
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
