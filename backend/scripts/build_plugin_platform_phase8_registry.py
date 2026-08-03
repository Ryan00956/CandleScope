"""Build the one-time signed Runtime Registry revision 5 for Wasmtime 47.0.3.

The signing private key is intentionally not persisted by default. The committed roots
contain only its public key; rerunning a production signing ceremony requires an explicit
32-byte Ed25519 seed passed with ``--signing-key``.
"""

from __future__ import annotations

import argparse
import json
import shutil
import stat
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
REGISTRY_ROOT = BACKEND_ROOT / "app" / "plugin_runtime_registry_v3"
WASMTIME_VERSION = "47.0.3"
WASMTIME_COMMIT = "5554cc1a651da536af2cc46c7324bdc085b162e3"
WASMTIME_RUNTIME_ID = "wasmtime-47.0.3"
WINDOWS_ASSET_ID = 496894603
LINUX_ASSET_ID = 496894543
ISSUED_AT = "2026-08-03T21:00:00Z"


class RegistryBuildError(RuntimeError):
    pass


def _ensure_import_paths() -> None:
    for path in (SDK_SOURCE, BACKEND_ROOT):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)


def _github_api(endpoint: str) -> bytes:
    executable = shutil.which("gh")
    if executable is None:
        raise RegistryBuildError("GitHub CLI is required for the signing ceremony")
    completed = subprocess.run(
        (executable, "api", endpoint),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        shell=False,
        timeout=60,
    )
    if completed.returncode:
        raise RegistryBuildError(
            "GitHub API evidence fetch failed: "
            + completed.stderr[-2000:].decode("utf-8", errors="replace")
        )
    return completed.stdout


def _sha256_path(path: Path) -> str:
    _ensure_import_paths()
    from app.plugin_runtime_registry_v3 import sha256_bytes

    return sha256_bytes(path.read_bytes())


def _archive_inventory(
    path: Path,
    *,
    archive_format: str,
    strip_prefix: str,
) -> dict[str, bytes]:
    files: dict[str, bytes] = {}

    def add(name: str, payload: bytes, *, regular: bool) -> None:
        parts = PurePosixPath(name).parts
        if not parts or parts[0] != strip_prefix:
            raise RegistryBuildError(
                f"archive member is outside {strip_prefix}: {name}"
            )
        relative = PurePosixPath(*parts[1:]).as_posix()
        if not relative or relative == ".":
            return
        if not regular or relative in files:
            raise RegistryBuildError(f"archive member is unsafe or duplicated: {name}")
        files[relative] = payload

    if archive_format == "zip":
        with zipfile.ZipFile(path, "r") as package:
            for item in package.infolist():
                if item.is_dir():
                    continue
                mode = item.external_attr >> 16
                add(
                    item.filename,
                    package.read(item),
                    regular=not stat.S_ISLNK(mode),
                )
    elif archive_format == "tar.xz":
        with tarfile.open(path, "r:xz") as package:
            for item in package.getmembers():
                if item.isdir():
                    continue
                source = package.extractfile(item) if item.isfile() else None
                add(
                    item.name,
                    b"" if source is None else source.read(),
                    regular=item.isfile() and not item.issym() and not item.islnk(),
                )
    else:
        raise RegistryBuildError(f"unsupported build archive: {archive_format}")
    if sorted(files) != ["LICENSE", "README.md", "wasmtime", "wasmtime-min"] and sorted(
        files
    ) != ["LICENSE", "README.md", "wasmtime-min.exe", "wasmtime.exe"]:
        raise RegistryBuildError(
            f"unexpected Wasmtime archive inventory: {sorted(files)}"
        )
    return files


def _release(
    *,
    operating_system: str,
    archive: Path,
    archive_format: str,
    strip_prefix: str,
    executable: str,
    asset_id: int,
    asset_projection: bytes,
    commit_projection: bytes,
    releases: bytes,
    cargo_lock: bytes,
) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_runtime_registry_v3 import sha256_bytes

    inventory = _archive_inventory(
        archive,
        archive_format=archive_format,
        strip_prefix=strip_prefix,
    )
    license_bytes = inventory["LICENSE"]
    if operating_system == "windows":
        archive_name = f"wasmtime-v{WASMTIME_VERSION}-x86_64-windows.zip"
        content_type = "application/zip"
    else:
        archive_name = f"wasmtime-v{WASMTIME_VERSION}-x86_64-linux.tar.xz"
        content_type = "application/x-xz"
    archive_url = (
        "https://github.com/bytecodealliance/wasmtime/releases/download/"
        f"v{WASMTIME_VERSION}/{archive_name}"
    )
    asset_value = json.loads(asset_projection)
    if (
        asset_value["id"] != asset_id
        or asset_value["name"] != archive_name
        or asset_value["browserDownloadUrl"] != archive_url
        or asset_value["digest"] != _sha256_path(archive)
        or asset_value["size"] != archive.stat().st_size
        or asset_value["contentType"] != content_type
    ):
        raise RegistryBuildError(
            "GitHub release asset projection does not bind the archive"
        )
    raw_base = (
        f"https://raw.githubusercontent.com/bytecodealliance/wasmtime/{WASMTIME_COMMIT}"
    )
    return {
        "id": WASMTIME_RUNTIME_ID,
        "kind": "wasm",
        "version": WASMTIME_VERSION,
        "os": operating_system,
        "arch": "x86_64",
        "url": archive_url,
        "sha256": _sha256_path(archive),
        "size": archive.stat().st_size,
        "archive": archive_format,
        "stripPrefix": strip_prefix,
        "executable": executable,
        "extractedSize": sum(len(payload) for payload in inventory.values()),
        "fileCount": len(inventory),
        "license": {
            "spdx": "Apache-2.0 WITH LLVM-exception",
            "name": "Apache License 2.0 with LLVM Exceptions",
            "url": f"https://github.com/bytecodealliance/wasmtime/blob/{WASMTIME_COMMIT}/LICENSE",
            "legalDirectory": ".",
            "legalFileCount": 1,
            "legalSize": len(license_bytes),
        },
        "licenseFiles": [
            {
                "path": "LICENSE",
                "sha256": sha256_bytes(license_bytes),
                "size": len(license_bytes),
            }
        ],
        "evidence": [
            {
                "role": "vendor-checksum",
                "url": (
                    "https://api.github.com/repos/bytecodealliance/wasmtime/"
                    f"releases/assets/{asset_id}"
                ),
                "sha256": sha256_bytes(asset_projection),
                "size": len(asset_projection),
                "fileName": f"{archive_name}.asset.json",
                "projection": "github-release-asset-v1",
            },
            {
                "role": "vendor-metadata",
                "url": f"{raw_base}/RELEASES.md",
                "sha256": sha256_bytes(releases),
                "size": len(releases),
                "fileName": "RELEASES.vendor.md",
            },
            {
                "role": "vendor-sbom",
                "url": f"{raw_base}/Cargo.lock",
                "sha256": sha256_bytes(cargo_lock),
                "size": len(cargo_lock),
                "fileName": "Cargo.lock.vendor",
            },
            {
                "role": "vendor-signature",
                "url": (
                    "https://api.github.com/repos/bytecodealliance/wasmtime/"
                    f"git/commits/{WASMTIME_COMMIT}"
                ),
                "sha256": sha256_bytes(commit_projection),
                "size": len(commit_projection),
                "fileName": "git-commit-signature.json",
                "projection": "github-git-commit-v1",
            },
        ],
        "probe": {
            "argv": [executable, "--version"],
            "expectedExitCode": 0,
            "stdoutRegex": (r"(?s)^wasmtime 47\.0\.3 \(5554cc1a6 2026-07-31\)\r?\n?$"),
            "stderrRegex": r"(?s)^$",
            "timeoutSeconds": 15,
        },
        "upstream": {
            "releaseUrl": (
                "https://github.com/bytecodealliance/wasmtime/releases/tag/v47.0.3"
            ),
            "scmRef": WASMTIME_COMMIT,
            "buildRef": (
                "https://github.com/bytecodealliance/wasmtime/commit/" + WASMTIME_COMMIT
            ),
        },
    }


def build(source_dir: Path, *, signing_key: Path | None, write: bool) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_runtime_registry_v3 import (
        canonical_bytes,
        encode_base64url,
        key_id,
        load_runtime_registry_roots_bytes,
        project_runtime_evidence_bytes,
        sha256_bytes,
        verify_runtime_registry_bytes,
    )

    source_dir = source_dir.resolve(strict=True)
    windows_archive = source_dir / f"wasmtime-v{WASMTIME_VERSION}-x86_64-windows.zip"
    linux_archive = source_dir / f"wasmtime-v{WASMTIME_VERSION}-x86_64-linux.tar.xz"
    releases = (source_dir / "RELEASES.md").read_bytes()
    cargo_lock = (source_dir / "Cargo.lock").read_bytes()
    for path in (windows_archive, linux_archive):
        path.resolve(strict=True)

    commit_url = (
        "https://api.github.com/repos/bytecodealliance/wasmtime/git/commits/"
        + WASMTIME_COMMIT
    )
    commit_projection = project_runtime_evidence_bytes(
        _github_api("repos/bytecodealliance/wasmtime/git/commits/" + WASMTIME_COMMIT),
        projection="github-git-commit-v1",
        source_url=commit_url,
    )

    def asset_projection(asset_id: int) -> bytes:
        url = (
            "https://api.github.com/repos/bytecodealliance/wasmtime/"
            f"releases/assets/{asset_id}"
        )
        return project_runtime_evidence_bytes(
            _github_api(f"repos/bytecodealliance/wasmtime/releases/assets/{asset_id}"),
            projection="github-release-asset-v1",
            source_url=url,
        )

    releases_to_add = (
        _release(
            operating_system="linux",
            archive=linux_archive,
            archive_format="tar.xz",
            strip_prefix=f"wasmtime-v{WASMTIME_VERSION}-x86_64-linux",
            executable="wasmtime",
            asset_id=LINUX_ASSET_ID,
            asset_projection=asset_projection(LINUX_ASSET_ID),
            commit_projection=commit_projection,
            releases=releases,
            cargo_lock=cargo_lock,
        ),
        _release(
            operating_system="windows",
            archive=windows_archive,
            archive_format="zip",
            strip_prefix=f"wasmtime-v{WASMTIME_VERSION}-x86_64-windows",
            executable="wasmtime.exe",
            asset_id=WINDOWS_ASSET_ID,
            asset_projection=asset_projection(WINDOWS_ASSET_ID),
            commit_projection=commit_projection,
            releases=releases,
            cargo_lock=cargo_lock,
        ),
    )

    previous_path = REGISTRY_ROOT / "official-runtime-registry-v4.json"
    previous_bytes = previous_path.read_bytes()
    previous_roots_bytes = (
        REGISTRY_ROOT / "official-runtime-registry-roots.json"
    ).read_bytes()
    previous_roots = load_runtime_registry_roots_bytes(previous_roots_bytes)
    previous = verify_runtime_registry_bytes(previous_bytes, previous_roots)
    previous_wire = json.loads(previous_bytes)

    if signing_key is None:
        private_key = Ed25519PrivateKey.generate()
    else:
        seed = signing_key.resolve(strict=True).read_bytes()
        if len(seed) != 32:
            raise RegistryBuildError("--signing-key must contain exactly 32 raw bytes")
        private_key = Ed25519PrivateKey.from_private_bytes(seed)
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    signing_key_id = key_id(public_key)
    body = {
        "schemaVersion": 1,
        "registry": {
            "id": "candlescope.reference-runtime",
            "revision": 5,
            "issuedAt": ISSUED_AT,
            "previousRegistrySha256": previous.sha256,
            "automaticNetworkUpdates": False,
        },
        "runtimes": sorted(
            [*previous_wire["runtimes"], *releases_to_add],
            key=lambda item: (item["id"], item["kind"], item["os"], item["arch"]),
        ),
        "revocations": previous_wire["revocations"],
    }
    registry_bytes = canonical_bytes(
        {
            **body,
            "signature": {
                "algorithm": "ed25519",
                "keyId": signing_key_id,
                "value": encode_base64url(private_key.sign(canonical_bytes(body))),
            },
        }
    )
    roots_wire = json.loads(previous_roots_bytes)
    roots_wire["registries"].append(
        {
            "registryId": "candlescope.reference-runtime",
            "keyId": signing_key_id,
            "publicKey": encode_base64url(public_key),
            "sourceOrigins": [
                "https://api.github.com",
                "https://github.com",
                "https://nodejs.org",
                "https://openjdk.org",
                "https://raw.githubusercontent.com",
            ],
            "enabled": True,
        }
    )
    roots_wire["registries"] = sorted(
        roots_wire["registries"],
        key=lambda item: (item["registryId"], item["keyId"]),
    )
    roots_bytes = canonical_bytes(roots_wire)
    verified = verify_runtime_registry_bytes(
        registry_bytes, load_runtime_registry_roots_bytes(roots_bytes)
    )
    if verified.revision != 5 or verified.previous_registry_sha256 != previous.sha256:
        raise RegistryBuildError("generated revision 5 failed its chain self-check")

    if write:
        roots_v4 = REGISTRY_ROOT / "official-runtime-registry-roots-v4.json"
        if roots_v4.exists() and roots_v4.read_bytes() != previous_roots_bytes:
            raise RegistryBuildError(
                "existing revision 4 roots differ from the active roots"
            )
        roots_v4.write_bytes(previous_roots_bytes)
        (REGISTRY_ROOT / "official-runtime-registry-roots.json").write_bytes(
            roots_bytes
        )
        (REGISTRY_ROOT / "official-runtime-registry-v5.json").write_bytes(
            registry_bytes
        )

    return {
        "schemaVersion": "candlescope.plugin-platform.phase8-registry-build/1",
        "result": "pass",
        "wrote": write,
        "keyId": signing_key_id,
        "rootsSha256": sha256_bytes(roots_bytes),
        "registrySha256": verified.sha256,
        "previousRegistrySha256": previous.sha256,
        "runtimes": [
            {
                "os": item["os"],
                "archive": item["archive"],
                "sha256": item["sha256"],
                "size": item["size"],
                "extractedSize": item["extractedSize"],
                "fileCount": item["fileCount"],
                "evidence": [
                    {
                        "role": evidence["role"],
                        "sha256": evidence["sha256"],
                        "size": evidence["size"],
                        "projection": evidence.get("projection", "raw"),
                    }
                    for evidence in item["evidence"]
                ],
            }
            for item in releases_to_add
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--signing-key", type=Path)
    parser.add_argument("--write", action="store_true")
    arguments = parser.parse_args()
    print(
        json.dumps(
            build(
                arguments.source_dir,
                signing_key=arguments.signing_key,
                write=arguments.write,
            ),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
