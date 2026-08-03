#!/usr/bin/env python3
"""Finalize reviewed provenance, transcript, SBOM, receipt, and source lock."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
ADAPTER_ROOT = HERE.parent
ASSESSMENT_PATH = ADAPTER_ROOT / "assessment" / "github-assessment.json"
BINARY_PATH = ADAPTER_ROOT / "runtime" / "adapter.exe"
MANIFEST_PATH = ADAPTER_ROOT / "manifest.json"
SUPPLY_LOCK_PATH = ADAPTER_ROOT / "supply-chain.lock.json"
TRANSCRIPT_PATH = ADAPTER_ROOT / "conformance" / "control-transcript.json"
SBOM_PATH = ADAPTER_ROOT / "sbom" / "cyclonedx.json"
RECEIPT_PATH = ADAPTER_ROOT / "build-receipt.json"
SOURCE_LOCK_PATH = ADAPTER_ROOT / "source-lock.json"


def json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, indent=2)
        + "\n"
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    raw = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def digest(path: Path) -> tuple[str, int]:
    raw = path.read_bytes()
    return digest_bytes(raw), len(raw)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"JSON root must be an object: {path}")
    return value


def write_json(path: Path, value: Any) -> bytes:
    raw = json_bytes(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return raw


def requests() -> list[dict[str, Any]]:
    contribution = "candlescope-aho-corasick"
    context = {
        "contributionId": contribution,
        "generation": 1,
        "traceId": "phase9-aho-corasick",
        "userAction": True,
    }
    return [
        {
            "generation": 0,
            "id": "handshake-1",
            "jsonrpc": "2.0",
            "method": "handshake",
            "params": {
                "entrypointId": "main",
                "host": {"name": "CandleScope", "version": "0.4.0"},
                "hostApis": [],
                "protocols": ["candlescope.plugin/2"],
                "transports": ["jsonl/1"],
            },
        },
        {
            "generation": 0,
            "id": "describe-1",
            "jsonrpc": "2.0",
            "method": "describe",
            "params": {},
        },
        {
            "generation": 1,
            "id": "activate-1",
            "jsonrpc": "2.0",
            "method": "activate",
            "params": {
                "capabilities": [],
                "generation": 1,
                "instanceId": "aho-corasick-instance-1",
            },
        },
        {
            "generation": 1,
            "id": "invoke-1",
            "jsonrpc": "2.0",
            "method": "invoke",
            "params": {
                "contributionId": contribution,
                "input": {
                    "haystack": "ushers 波浪-wave-WAVE",
                    "patterns": ["he", "she", "hers", "波浪", "wave"],
                    "asciiCaseInsensitive": True,
                    "overlapping": True,
                    "maxMatches": 100,
                },
                "requestContext": context,
            },
        },
        {
            "generation": 1,
            "id": "health-1",
            "jsonrpc": "2.0",
            "method": "healthCheck",
            "params": {},
        },
        {
            "generation": 1,
            "id": "cancel-1",
            "jsonrpc": "2.0",
            "method": "cancel",
            "params": {"requestId": "not-pending"},
        },
        {
            "generation": 1,
            "id": "prepare-1",
            "jsonrpc": "2.0",
            "method": "prepareUpgrade",
            "params": {},
        },
        {
            "generation": 1,
            "id": "health-2",
            "jsonrpc": "2.0",
            "method": "healthCheck",
            "params": {},
        },
        {
            "generation": 1,
            "id": "deactivate-1",
            "jsonrpc": "2.0",
            "method": "deactivate",
            "params": {"reason": "phase9 transcript"},
        },
        {
            "generation": 2,
            "id": "activate-2",
            "jsonrpc": "2.0",
            "method": "activate",
            "params": {
                "capabilities": [],
                "generation": 2,
                "instanceId": "aho-corasick-instance-2",
            },
        },
        {
            "generation": 2,
            "id": "events-1",
            "jsonrpc": "2.0",
            "method": "eventBatch",
            "params": {"delivery": {}, "events": [{"type": "tick"}]},
        },
        {
            "generation": 2,
            "id": "shutdown-1",
            "jsonrpc": "2.0",
            "method": "shutdown",
            "params": {},
        },
    ]


def capture_transcript() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not BINARY_PATH.is_file() or BINARY_PATH.is_symlink():
        raise SystemExit("reviewed runtime/adapter.exe is unavailable")
    request_values = requests()
    input_bytes = b"".join(
        json.dumps(
            item,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
        for item in request_values
    )
    completed = subprocess.run(
        [str(BINARY_PATH.resolve(strict=True))],
        input=input_bytes,
        capture_output=True,
        timeout=30,
        check=True,
    )
    if completed.stderr:
        raise SystemExit("control transcript wrote unexpected stderr")
    lines = completed.stdout.splitlines()
    if len(lines) != len(request_values):
        raise SystemExit(
            f"control transcript returned {len(lines)} responses for "
            f"{len(request_values)} requests"
        )
    responses = [json.loads(line) for line in lines]
    if not all(isinstance(item, dict) for item in responses):
        raise SystemExit("control transcript response is not an object")
    if [item.get("id") for item in responses] != [item["id"] for item in request_values]:
        raise SystemExit("control transcript response IDs changed")
    transcript = {
        "schemaVersion": "candlescope.plugin-v2-transcript.v1",
        "protocol": "candlescope.plugin/2",
        "transport": "jsonl/1",
        "requests": request_values,
        "expected": {
            "responseSha256": [canonical_sha256(item) for item in responses],
            "transcriptSha256": canonical_sha256(responses),
        },
    }
    return transcript, responses


def sbom(supply: dict[str, Any]) -> dict[str, Any]:
    components = [
        {
            "bom-ref": "pkg:cargo/candlescope-aho-corasick-adapter@0.1.0",
            "type": "application",
            "name": "candlescope-aho-corasick-adapter",
            "version": "0.1.0",
            "licenses": [{"license": {"id": "GPL-3.0-only"}}],
        },
        {
            "bom-ref": "pkg:cargo/candlescope-plugin-sdk-wasm@0.1.0",
            "type": "library",
            "name": "candlescope-plugin-sdk-wasm",
            "version": "0.1.0",
            "licenses": [{"license": {"id": "GPL-3.0-only"}}],
        },
    ]
    for dependency in supply["dependencies"]:
        components.append(
            {
                "bom-ref": f"pkg:cargo/{dependency['name']}@{dependency['version']}",
                "type": "library",
                "name": dependency["name"],
                "version": dependency["version"],
                "hashes": [
                    {
                        "alg": "SHA-256",
                        "content": str(dependency["sha256"]).removeprefix("sha256:"),
                    }
                ],
                "licenses": [{"expression": dependency["licenseSpdx"]}],
                "purl": f"pkg:cargo/{dependency['name']}@{dependency['version']}",
            }
        )
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:3bd424de-5cbe-4d56-8d6d-e0643f0a9114",
        "version": 1,
        "metadata": {
            "component": {
                "bom-ref": "pkg:cargo/candlescope-aho-corasick-adapter@0.1.0",
                "type": "application",
                "name": "candlescope-aho-corasick-adapter",
                "version": "0.1.0",
            }
        },
        "components": components,
        "dependencies": [
            {
                "ref": "pkg:cargo/candlescope-aho-corasick-adapter@0.1.0",
                "dependsOn": [
                    "pkg:cargo/aho-corasick@1.1.4",
                    "pkg:cargo/candlescope-plugin-sdk-wasm@0.1.0",
                    "pkg:cargo/memchr@2.8.3",
                ],
            }
        ],
    }


def output_record(relative: str) -> dict[str, Any]:
    path = ADAPTER_ROOT.joinpath(*relative.split("/"))
    sha256, size = digest(path)
    return {"path": relative, "sha256": sha256, "size": size}


def file_digest_record(relative: str) -> dict[str, Any]:
    path = ADAPTER_ROOT.joinpath(*relative.split("/"))
    sha256, size = digest(path)
    return {"sha256": sha256, "size": size}


def canonical_timestamp(value: str) -> str:
    if not value.endswith("Z"):
        raise SystemExit("--confirmed-at must be canonical UTC ending in Z")
    parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.isoformat().replace("+00:00", "Z") != value:
        raise SystemExit("--confirmed-at must be canonical UTC without fractional seconds")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--confirmed-at", required=True)
    parser.add_argument("--approve-reviewed-source", action="store_true")
    arguments = parser.parse_args()
    if not arguments.approve_reviewed_source:
        raise SystemExit("explicit --approve-reviewed-source is required")
    reviewer = arguments.reviewer.strip()
    if not reviewer or len(reviewer) > 256 or "\n" in reviewer or "\r" in reviewer:
        raise SystemExit("--reviewer is invalid")
    confirmed_at = canonical_timestamp(arguments.confirmed_at)

    assessment_raw = ASSESSMENT_PATH.read_bytes()
    assessment = read_json(ASSESSMENT_PATH)
    supply = read_json(SUPPLY_LOCK_PATH)
    release_sha256, release_size = digest(BINARY_PATH)
    expected_release = supply["releaseArtifact"]
    if (release_sha256, release_size) != (
        expected_release["sha256"],
        expected_release["size"],
    ):
        raise SystemExit("runtime artifact does not match supply-chain.lock.json")
    resolved = assessment["resolvedPin"]
    if (
        assessment["decision"]["mayExecute"] is not False
        or assessment["behavior"]["executedRepositoryCode"] is not False
        or resolved["commitSha"] != supply["upstream"]["commit"]
        or resolved["requested"] != supply["upstream"]["tag"]
    ):
        raise SystemExit("assessment and supply-chain lock identity diverged")

    transcript, responses = capture_transcript()
    transcript_raw = write_json(TRANSCRIPT_PATH, transcript)
    manifest = read_json(MANIFEST_PATH)
    manifest["probes"][0]["sha256"] = transcript["expected"]["transcriptSha256"]
    write_json(MANIFEST_PATH, manifest)
    write_json(SBOM_PATH, sbom(supply))

    package_paths = [
        "conformance/control-transcript.json",
        *sorted(
            path.relative_to(ADAPTER_ROOT).as_posix()
            for path in (ADAPTER_ROOT / "licenses").iterdir()
            if path.is_file()
        ),
        "manifest.json",
        "runtime/adapter.exe",
        "sbom/cyclonedx.json",
    ]
    receipt = {
        "schemaVersion": "candlescope.adapter-build-receipt/1",
        "status": "complete",
        "pluginId": "candlescope.aho-corasick",
        "templateKind": "native-cli",
        "reviewedCommit": supply["upstream"]["commit"],
        "networkAccessDuringBuild": False,
        "sourceCompilation": True,
        "reproducibleBuilds": 2,
        "sourceDateEpoch": supply["sourceDateEpoch"],
        "commands": [
            "cargo test --locked --offline",
            "python scripts/build_release.py --report evidence/build-report.json",
        ],
        "toolchain": supply["toolchain"],
        "outputs": [output_record(path) for path in sorted(package_paths)],
    }
    receipt_raw = write_json(RECEIPT_PATH, receipt)

    source_lock = read_json(SOURCE_LOCK_PATH)
    source_lock.update(
        {
            "status": "complete",
            "artifactPins": [
                {
                    "name": dependency["file"],
                    "role": "upstream-source",
                    "url": dependency["url"],
                    "sha256": dependency["sha256"],
                    "size": dependency["size"],
                    "licenseSpdx": dependency["licenseSpdx"],
                }
                for dependency in supply["dependencies"]
            ],
            "licenses": {
                "reviewed": True,
                "redistributionApproved": True,
                "files": [
                    {
                        "name": "aho-corasick COPYING",
                        "role": "upstream-license-selection",
                        "url": (
                            "https://github.com/BurntSushi/aho-corasick/blob/"
                            "17f8b32e3b7c845ef3c5429b823804f552f14ec9/COPYING"
                        ),
                        **file_digest_record("licenses/UPSTREAM_COPYING.txt"),
                        "licenseSpdx": "Unlicense OR MIT",
                        "localPath": "licenses/UPSTREAM_COPYING.txt",
                    },
                    {
                        "name": "aho-corasick LICENSE-MIT",
                        "role": "upstream-license",
                        "url": (
                            "https://github.com/BurntSushi/aho-corasick/blob/"
                            "17f8b32e3b7c845ef3c5429b823804f552f14ec9/LICENSE-MIT"
                        ),
                        **file_digest_record("licenses/UPSTREAM_LICENSE_MIT.txt"),
                        "licenseSpdx": "MIT",
                        "localPath": "licenses/UPSTREAM_LICENSE_MIT.txt",
                    },
                    {
                        "name": "aho-corasick UNLICENSE",
                        "role": "upstream-license",
                        "url": (
                            "https://github.com/BurntSushi/aho-corasick/blob/"
                            "17f8b32e3b7c845ef3c5429b823804f552f14ec9/UNLICENSE"
                        ),
                        **file_digest_record("licenses/UPSTREAM_UNLICENSE.txt"),
                        "licenseSpdx": "Unlicense",
                        "localPath": "licenses/UPSTREAM_UNLICENSE.txt",
                    },
                    {
                        "name": "GNU GPL version 3",
                        "role": "adapter-and-sdk-license",
                        "url": "https://www.gnu.org/licenses/gpl-3.0.txt",
                        **file_digest_record("licenses/GPL-3.0-only.txt"),
                        "licenseSpdx": "GPL-3.0-only",
                        "localPath": "licenses/GPL-3.0-only.txt",
                    },
                ],
            },
            "adapter": {
                "entryArtifact": "runtime/adapter.exe",
                "entryArtifactSha256": release_sha256,
                "buildReceipt": "build-receipt.json",
                "buildReceiptSha256": digest_bytes(receipt_raw),
                "conformanceTranscriptSha256": digest_bytes(transcript_raw),
            },
            "review": {
                "confirmedBy": reviewer,
                "confirmedAt": confirmed_at,
                "stablePublicApi": True,
                "capabilities": [],
                "generatedSourceContainsHostInternalImports": False,
                "thirdPartyCodeExecutionApproved": True,
                "marketplaceApproved": False,
            },
        }
    )
    source_lock["assessment"] = {
        "present": True,
        "schemaVersion": assessment["schemaVersion"],
        "sha256": digest_bytes(assessment_raw),
        "assessmentIdentity": assessment["assessmentSha256"],
    }
    source_lock["upstream"] = {
        "repository": assessment["repository"]["url"],
        "pinKind": resolved["kind"],
        "requestedPin": resolved["requested"],
        "commit": resolved["commitSha"],
    }
    write_json(SOURCE_LOCK_PATH, source_lock)
    print(
        json.dumps(
            {
                "schemaVersion": "candlescope.aho-corasick-release-finalization/1",
                "result": "complete",
                "reviewer": reviewer,
                "artifactSha256": release_sha256,
                "assessmentSha256": assessment["assessmentSha256"],
                "transcriptResponses": len(responses),
                "transcriptSha256": transcript["expected"]["transcriptSha256"],
                "sourceLockSha256": digest(SOURCE_LOCK_PATH)[0],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
