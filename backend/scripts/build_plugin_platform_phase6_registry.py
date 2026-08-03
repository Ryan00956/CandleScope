"""Build Runtime Registry revision 3 for the AppContainer-compatible JRE.

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
    "https://github.com/adoptium/temurin26-binaries/releases/download/jdk-26.0.2%2B10"
)
FILES = {
    "OpenJDK26U-jre_x64_windows_hotspot_26.0.2_10.zip": (
        60081605,
        "sha256:4323e886b6320e2166072bdfd604a4236c3dba6e5ab289e10aef623f09d355a0",
    ),
    "OpenJDK26U-jre_x64_windows_hotspot_26.0.2_10.zip.sha256.txt": (
        115,
        "sha256:5bc250cd5bb167fcc70ce91146c156b83ffa900f98f3f42b26ea596c3a8277e2",
    ),
    "OpenJDK26U-jre_x64_windows_hotspot_26.0.2_10.zip.json": (
        31383,
        "sha256:9f3bd8995aec46b329ff11d8d7022ea4f89907d66a69aaca73fc7eddf03ecdc1",
    ),
    "OpenJDK26U-sbom_x64_windows_hotspot_26.0.2_10.json": (
        167942,
        "sha256:26f1ab84eaca4058e5b3f851bec12671e9ca622591d0d26a77a55623b0bf8d86",
    ),
    "OpenJDK26U-jre_x64_windows_hotspot_26.0.2_10.zip.sig": (
        310,
        "sha256:a20b89be3921989500bab01b3c8448beb7b30ca7e75b68bdbd2b52f80b3f9a7e",
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
    archive = "OpenJDK26U-jre_x64_windows_hotspot_26.0.2_10.zip"
    return {
        "id": "temurin-26.0.2.10",
        "kind": "java",
        "version": "26.0.2+10",
        "os": "windows",
        "arch": "x86_64",
        "url": f"{RELEASE_BASE}/{archive}",
        "sha256": FILES[archive][1],
        "size": FILES[archive][0],
        "archive": "zip",
        "stripPrefix": "jdk-26.0.2+10-jre",
        "executable": "bin/java.exe",
        "extractedSize": 192461498,
        "fileCount": 315,
        "license": {
            "spdx": "GPL-2.0 WITH Classpath-exception-2.0",
            "name": "GNU General Public License v2 with the Classpath Exception",
            "url": "https://openjdk.org/legal/gplv2+ce.html",
            "legalDirectory": "legal",
            "legalFileCount": 179,
            "legalSize": 230270,
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
                "vendor-sbom", "OpenJDK26U-sbom_x64_windows_hotspot_26.0.2_10.json"
            ),
            evidence("vendor-signature", f"{archive}.sig"),
        ],
        "probe": {
            "argv": ["bin/java.exe", "-version"],
            "expectedExitCode": 0,
            "stdoutRegex": "(?s)^$",
            "stderrRegex": '(?s)^openjdk version \\"26\\.0\\.2\\".*Temurin-26\\.0\\.2\\+10.*$',
            "timeoutSeconds": 15,
        },
        "upstream": {
            "releaseUrl": "https://github.com/adoptium/temurin26-binaries/releases/tag/jdk-26.0.2%2B10",
            "scmRef": "jdk-26.0.2+10_adopt",
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
    archive = next(iter(FILES))
    checksum = (evidence_directory / f"{archive}.sha256.txt").read_text(
        encoding="utf-8"
    )
    if FILES[archive][1].removeprefix("sha256:") not in checksum:
        raise SystemExit("vendor checksum does not bind the JRE archive")
    old_roots_bytes = arguments.roots.read_bytes()
    old_roots = load_runtime_registry_roots_bytes(old_roots_bytes)
    previous_bytes = arguments.previous_registry.read_bytes()
    previous = verify_runtime_registry_bytes(previous_bytes, old_roots)
    if previous.registry_id != REGISTRY_ID or previous.revision != 2:
        raise SystemExit("previous official registry is not revision 2")
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
            "revision": 3,
            "issuedAt": "2026-08-03T14:25:00Z",
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
    if verified.revision != 3 or len(verified.runtimes) != 3:
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
