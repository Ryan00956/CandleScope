"""Build Runtime Registry revision 4 with the pinned Node.js 24 LTS runtime.

The Ed25519 signing seed must be supplied through
CANDLESCOPE_RUNTIME_REGISTRY_ED25519_KEY_HEX. The seed is never written to disk
or included in output. Production releases should inject this value from the
release signer, not from a developer shell.

Node.js does not publish a release-specific CycloneDX/SPDX document beside the
binary ZIP. Registry schema v1 nevertheless has a frozen ``vendor-sbom`` slot,
so revision 4 binds the exact-tag generated LICENSE inventory in that slot and
records this compatibility mapping in the Phase 7 contract and operator docs.
It must not be presented to users as a standards-format SBOM.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = BACKEND_ROOT.parent
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
for candidate in (BACKEND_ROOT, SDK_SOURCE):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from app.plugin_runtime_registry_v3 import (  # noqa: E402
    canonical_bytes,
    encode_base64url,
    key_id,
    load_runtime_registry_roots_bytes,
    sha256_bytes,
    verify_runtime_registry_bytes,
)


REGISTRY_ID = "candlescope.reference-runtime"
NODE_RUNTIME_ID = "node-24.19.0"
NODE_TAG_OBJECT = "1dbab0e88e7ccc6b44c801418911767447796ed0"
NODE_COMMIT = "cdc1b38d40cb567b7ad0b39c86addf830a0af0ae"
NODE_RELEASE_BASE = "https://nodejs.org/dist/v24.19.0"
NODE_RAW_BASE = f"https://raw.githubusercontent.com/nodejs/node/{NODE_COMMIT}"
FILES = {
    "node-v24.19.0-win-x64.zip": (
        37_304_352,
        "sha256:57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
    ),
    "SHASUMS256.txt": (
        2_967,
        "sha256:be0629ee2bcd8e40bb856abdd3407f0762101b76bd60a36b8867f637733631c0",
    ),
    "CHANGELOG_V24.vendor.md": (
        617_482,
        "sha256:c9dc3721df61896345feb1dac21e7da97ca5264132c55385c77e67f46b0a9211",
    ),
    "LICENSE.vendor": (
        157_606,
        "sha256:148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5",
    ),
    "SHASUMS256.txt.sig": (
        119,
        "sha256:801534e2d4c769c087e2e3eec89e879032872357e64e82336f86f03e72ece630",
    ),
}


def digest(path: Path) -> tuple[int, str]:
    value = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
            size += len(chunk)
    return size, f"sha256:{value.hexdigest()}"


def evidence(role: str, local_name: str, url: str) -> dict[str, object]:
    size, sha256 = FILES[local_name]
    return {
        "role": role,
        "url": url,
        "sha256": sha256,
        "size": size,
        "fileName": local_name,
    }


def release() -> dict[str, object]:
    archive = "node-v24.19.0-win-x64.zip"
    return {
        "id": NODE_RUNTIME_ID,
        "kind": "node",
        "version": "24.19.0+LTS-Krypton",
        "os": "windows",
        "arch": "x86_64",
        "url": f"{NODE_RELEASE_BASE}/{archive}",
        "sha256": FILES[archive][1],
        "size": FILES[archive][0],
        "archive": "zip",
        "stripPrefix": "node-v24.19.0-win-x64",
        "executable": "node.exe",
        "extractedSize": 106_112_876,
        "fileCount": 1_989,
        "license": {
            "spdx": "MIT",
            "name": "Node.js MIT license with bundled third-party notices",
            "url": f"https://github.com/nodejs/node/blob/{NODE_COMMIT}/LICENSE",
            # The official Windows ZIP has no dedicated legal directory. Bind
            # the complete bundled package tree plus exact top-level licenses.
            "legalDirectory": "node_modules",
            "legalFileCount": 1_975,
            "legalSize": 13_014_904,
        },
        "licenseFiles": [
            {
                "path": "LICENSE",
                "sha256": "sha256:d9c4eeda951d6d08f4aa1316b61aafcf67e6da5f79b18f8edeb56fa6abdc038c",
                "size": 160_552,
            },
            {
                "path": "node_modules/corepack/LICENSE.md",
                "sha256": "sha256:517d52969f11b2b587f2e5116069aea3887ff08251689a198a857a115f250dbf",
                "size": 1_070,
            },
            {
                "path": "node_modules/npm/LICENSE",
                "sha256": "sha256:af1573a67c9d9051fbf8a9c123a22b7f51ec58cb6a588b4c23bead776dd046ab",
                "size": 9_977,
            },
        ],
        "evidence": [
            evidence(
                "vendor-checksum",
                "SHASUMS256.txt",
                f"{NODE_RELEASE_BASE}/SHASUMS256.txt",
            ),
            evidence(
                "vendor-metadata",
                "CHANGELOG_V24.vendor.md",
                f"{NODE_RAW_BASE}/doc/changelogs/CHANGELOG_V24.md",
            ),
            evidence(
                "vendor-sbom",
                "LICENSE.vendor",
                f"{NODE_RAW_BASE}/LICENSE",
            ),
            evidence(
                "vendor-signature",
                "SHASUMS256.txt.sig",
                f"{NODE_RELEASE_BASE}/SHASUMS256.txt.sig",
            ),
        ],
        "probe": {
            "argv": ["node.exe", "--version"],
            "expectedExitCode": 0,
            "stdoutRegex": "(?s)^v24\\.19\\.0\\r?\\n?$",
            "stderrRegex": "(?s)^$",
            "timeoutSeconds": 15,
        },
        "upstream": {
            "releaseUrl": "https://github.com/nodejs/node/releases/tag/v24.19.0",
            "scmRef": (f"v24.19.0 tag-object={NODE_TAG_OBJECT} commit={NODE_COMMIT}"),
            "buildRef": f"https://github.com/nodejs/node/commit/{NODE_COMMIT}",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-directory", type=Path, required=True)
    parser.add_argument("--previous-registry", type=Path, required=True)
    parser.add_argument("--roots", type=Path, required=True)
    parser.add_argument("--output-registry", type=Path, required=True)
    arguments = parser.parse_args()
    evidence_directory = arguments.evidence_directory.resolve()
    for name, expected in FILES.items():
        path = evidence_directory / name
        if not path.is_file() or path.is_symlink() or digest(path) != expected:
            raise SystemExit(f"Node.js evidence mismatch: {name}")
    checksum = (evidence_directory / "SHASUMS256.txt").read_text(encoding="utf-8")
    if FILES["node-v24.19.0-win-x64.zip"][1].removeprefix("sha256:") not in checksum:
        raise SystemExit("vendor checksum does not bind the Node.js archive")
    old_roots_bytes = arguments.roots.read_bytes()
    old_roots = load_runtime_registry_roots_bytes(old_roots_bytes)
    previous_bytes = arguments.previous_registry.read_bytes()
    previous = verify_runtime_registry_bytes(previous_bytes, old_roots)
    if previous.registry_id != REGISTRY_ID or previous.revision != 3:
        raise SystemExit("previous official registry is not revision 3")
    seed_hex = os.environ.get("CANDLESCOPE_RUNTIME_REGISTRY_ED25519_KEY_HEX", "")
    try:
        seed = bytes.fromhex(seed_hex)
    except ValueError as exc:
        raise SystemExit("registry signing seed must be lowercase hexadecimal") from exc
    if len(seed) != 32 or seed_hex != seed.hex():
        raise SystemExit("registry signing seed must contain exactly 32 bytes")
    private_key = Ed25519PrivateKey.from_private_bytes(seed)
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    key = key_id(public_key)
    roots_value = json.loads(old_roots_bytes)
    roots_value["registries"].append(
        {
            "registryId": REGISTRY_ID,
            "keyId": key,
            "publicKey": encode_base64url(public_key),
            "sourceOrigins": [
                "https://github.com",
                "https://nodejs.org",
                "https://openjdk.org",
                "https://raw.githubusercontent.com",
            ],
            "enabled": True,
        }
    )
    roots_value["registries"] = sorted(
        roots_value["registries"], key=lambda item: (item["registryId"], item["keyId"])
    )
    roots_bytes = canonical_bytes(roots_value)
    body = {
        "schemaVersion": 1,
        "registry": {
            "id": REGISTRY_ID,
            "revision": 4,
            "issuedAt": "2026-08-03T18:00:00Z",
            "previousRegistrySha256": previous.sha256,
            "automaticNetworkUpdates": False,
        },
        "runtimes": sorted(
            [*json.loads(previous_bytes)["runtimes"], release()],
            key=lambda item: (item["id"], item["kind"], item["os"], item["arch"]),
        ),
        "revocations": [],
    }
    registry_bytes = canonical_bytes(
        {
            **body,
            "signature": {
                "algorithm": "ed25519",
                "keyId": key,
                "value": encode_base64url(private_key.sign(canonical_bytes(body))),
            },
        }
    )
    arguments.roots.write_bytes(roots_bytes)
    arguments.output_registry.write_bytes(registry_bytes)
    verified_roots = load_runtime_registry_roots_bytes(roots_bytes)
    verified = verify_runtime_registry_bytes(registry_bytes, verified_roots)
    if verified.revision != 4 or len(verified.runtimes) != 4:
        raise SystemExit("generated registry failed semantic verification")
    print(
        json.dumps(
            {
                "keyId": key,
                "rootsSha256": sha256_bytes(roots_bytes),
                "registrySha256": sha256_bytes(registry_bytes),
                "previousRegistrySha256": previous.sha256,
                "runtimeIds": [item.runtime_id for item in verified.runtimes],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
