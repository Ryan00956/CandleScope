"""Build the signed reference Runtime Registry revision for the Phase 5 JRE.

The Ed25519 signing seed must be supplied through
CANDLESCOPE_RUNTIME_REGISTRY_ED25519_KEY_HEX. The seed is never written to disk
or included in output. Production releases should inject this value from the
release signer, not from a developer shell.
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
RELEASE_BASE = (
    "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4%2B7"
)
FILES = {
    "OpenJDK25U-jre_x64_windows_hotspot_25.0.4_7.zip": (
        58474646,
        "sha256:5b0d58f043f762fa3ee6cc12b6774b59b245cafdcb357e45ce61f822aa9a56cb",
    ),
    "OpenJDK25U-jre_x64_windows_hotspot_25.0.4_7.zip.sha256.txt": (
        114,
        "sha256:040cc4cdb5ef5a2b955a632d2cc9d47cbe91ef458a4115a23beb1d312b459551",
    ),
    "OpenJDK25U-jre_x64_windows_hotspot_25.0.4_7.zip.json": (
        31632,
        "sha256:afef4b556904ff15e0f9d4513d6900652d006a3aba19ceed7584fc417a717b7b",
    ),
    "OpenJDK25U-sbom_x64_windows_hotspot_25.0.4_7.json": (
        169153,
        "sha256:b0d560e1a32296d90b805932ad539b92aa113fae10b885a286b63c8151068105",
    ),
    "OpenJDK25U-jre_x64_windows_hotspot_25.0.4_7.zip.sig": (
        310,
        "sha256:fa72019f229ccfdee10478c180cc4cb97d84980ebc6d5175ecf073f5bce6f968",
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


def evidence(role: str, name: str) -> dict[str, object]:
    size, sha256 = FILES[name]
    return {
        "role": role,
        "url": f"{RELEASE_BASE}/{name}",
        "sha256": sha256,
        "size": size,
        "fileName": name,
    }


def release() -> dict[str, object]:
    archive = "OpenJDK25U-jre_x64_windows_hotspot_25.0.4_7.zip"
    return {
        "id": "temurin-25.0.4.7",
        "kind": "java",
        "version": "25.0.4+7-LTS",
        "os": "windows",
        "arch": "x86_64",
        "url": f"{RELEASE_BASE}/{archive}",
        "sha256": FILES[archive][1],
        "size": FILES[archive][0],
        "archive": "zip",
        "stripPrefix": "jdk-25.0.4+7-jre",
        "executable": "bin/java.exe",
        "extractedSize": 187841444,
        "fileCount": 320,
        "license": {
            "spdx": "GPL-2.0 WITH Classpath-exception-2.0",
            "name": "GNU General Public License v2 with the Classpath Exception",
            "url": "https://openjdk.org/legal/gplv2+ce.html",
            "legalDirectory": "legal",
            "legalFileCount": 183,
            "legalSize": 231846,
        },
        "licenseFiles": [
            {
                "path": "NOTICE",
                "sha256": "sha256:c02756bcd9fa8191bf0fda4451bc018414dd44ee35bf09922c24377a475e4b5a",
                "size": 2400,
            },
            {
                "path": "legal/java.base/ADDITIONAL_LICENSE_INFO",
                "sha256": "sha256:a69bce275ba7a3570af6579cb0f55682cd75fedfcd49e0e8e9022270c447c916",
                "size": 2114,
            },
            {
                "path": "legal/java.base/ASSEMBLY_EXCEPTION",
                "sha256": "sha256:75292f03bf23d3db7c985aecc191029b93883200721ed23ed34a2e601463df33",
                "size": 1514,
            },
            {
                "path": "legal/java.base/LICENSE",
                "sha256": "sha256:4b9abebc4338048a7c2dc184e9f800deb349366bdf28eb23c2677a77b4c87726",
                "size": 19274,
            },
        ],
        "evidence": [
            evidence("vendor-checksum", f"{archive}.sha256.txt"),
            evidence("vendor-metadata", f"{archive}.json"),
            evidence(
                "vendor-sbom", "OpenJDK25U-sbom_x64_windows_hotspot_25.0.4_7.json"
            ),
            evidence("vendor-signature", f"{archive}.sig"),
        ],
        "probe": {
            "argv": ["bin/java.exe", "-version"],
            "expectedExitCode": 0,
            "stdoutRegex": "(?s)^$",
            "stderrRegex": '(?s)^openjdk version \\"25\\.0\\.4\\".*Temurin-25\\.0\\.4\\+7.*$',
            "timeoutSeconds": 15,
        },
        "upstream": {
            "releaseUrl": "https://github.com/adoptium/temurin25-binaries/releases/tag/jdk-25.0.4%2B7",
            "scmRef": "jdk-25.0.4+7_adopt",
            "buildRef": "https://github.com/adoptium/temurin-build/commit/e6ba7dec3d07654074559310376a3ae89da5f4ac",
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
            raise SystemExit(f"Temurin evidence mismatch: {name}")
    checksum = (evidence_directory / f"{next(iter(FILES))}.sha256.txt").read_text(
        encoding="utf-8"
    )
    if FILES[next(iter(FILES))][1].removeprefix("sha256:") not in checksum:
        raise SystemExit("vendor checksum does not bind the JRE archive")
    old_roots_bytes = arguments.roots.read_bytes()
    old_roots = load_runtime_registry_roots_bytes(old_roots_bytes)
    previous_bytes = arguments.previous_registry.read_bytes()
    previous = verify_runtime_registry_bytes(previous_bytes, old_roots)
    if previous.registry_id != REGISTRY_ID or previous.revision != 1:
        raise SystemExit("previous official registry is not revision 1")
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
            "sourceOrigins": ["https://github.com", "https://openjdk.org"],
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
            "revision": 2,
            "issuedAt": "2026-08-03T11:30:00Z",
            "previousRegistrySha256": previous.sha256,
            "automaticNetworkUpdates": False,
        },
        "runtimes": sorted(
            [*json.loads(previous_bytes)["runtimes"], release()],
            key=lambda item: (item["kind"], item["id"], item["os"], item["arch"]),
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
    if verified.revision != 2 or len(verified.runtimes) != 2:
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
