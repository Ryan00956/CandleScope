#!/usr/bin/env python3
"""Build the Node TypeScript reference as a deterministic pre-built ESM graph."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPOSITORY_ROOT = ROOT.parents[1]
SDK = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-typescript"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
if str(SDK_SOURCE) not in sys.path:
    sys.path.insert(0, str(SDK_SOURCE))

from candlescope_plugin_sdk.platform_v2 import canonical_sha256  # noqa: E402


RUNTIME = ROOT / "runtime"
SOURCE_MAPS = ROOT / "source-maps"
LOCK = ROOT / "supply-chain.lock.json"


class BuildError(RuntimeError):
    pass


def digest(path: Path) -> tuple[str, int]:
    value = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{value}", path.stat().st_size


def run(
    command: list[str],
    *,
    cwd: Path = ROOT,
    input_bytes: bytes | None = None,
    timeout: float = 120,
) -> subprocess.CompletedProcess[bytes]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        input=input_bytes,
        stdin=None if input_bytes is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        shell=False,
    )
    if completed.returncode:
        raise BuildError(
            f"command failed ({completed.returncode}): {command}\n"
            + completed.stderr[-4000:].decode("utf-8", errors="replace")
        )
    return completed


def build(node: Path, tsc: Path, type_roots: Path, destination: Path) -> dict[str, Path]:
    source = destination / "source"
    output = destination / "output"
    source.mkdir(parents=True)
    output.mkdir()
    shutil.copyfile(ROOT / "src" / "main.mts", source / "main.mts")
    shutil.copyfile(SDK / "dist" / "index.d.mts", source / "sdk.d.mts")
    run(
        [
            str(node),
            str(tsc),
            "--target",
            "ES2023",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--strict",
            "--noUncheckedIndexedAccess",
            "--exactOptionalPropertyTypes",
            "--noImplicitOverride",
            "--types",
            "node",
            "--typeRoots",
            str(type_roots),
            "--sourceMap",
            "--inlineSources",
            "false",
            "--newLine",
            "lf",
            "--rootDir",
            str(source),
            "--outDir",
            str(output),
            str(source / "main.mts"),
        ]
    )
    main = output / "main.mjs"
    raw_map = output / "main.mjs.map"
    if not main.is_file() or not raw_map.is_file():
        raise BuildError("TypeScript did not emit the reference ESM and source map")
    mapping = json.loads(raw_map.read_text(encoding="utf-8"))
    mapping["sources"] = ["src/main.mts"]
    mapping.pop("sourceRoot", None)
    mapping.pop("sourcesContent", None)
    clean_map = destination / "main.mjs.map"
    clean_map.write_text(
        json.dumps(mapping, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    text = main.read_text(encoding="utf-8")
    marker = "//# sourceMappingURL=main.mjs.map"
    if text.count(marker) != 1:
        raise BuildError("TypeScript output has another source-map marker")
    clean_main = destination / "main.mjs"
    clean_main.write_text(
        text.replace(marker, "//# sourceMappingURL=../source-maps/main.mjs.map"),
        encoding="utf-8",
        newline="\n",
    )
    sdk = destination / "sdk.mjs"
    shutil.copyfile(SDK / "dist" / "index.mjs", sdk)
    return {"main.mjs": clean_main, "sdk.mjs": sdk, "main.mjs.map": clean_map}


def transcript_requests() -> list[dict[str, object]]:
    context = {
        "contributionId": "node-hello",
        "userAction": True,
        "generation": 1,
        "traceId": "phase7-node",
    }
    return [
        {
            "jsonrpc": "2.0",
            "id": "handshake-1",
            "method": "handshake",
            "params": {
                "protocols": ["candlescope.plugin/2"],
                "host": {"name": "CandleScope", "version": "0.4.0"},
                "entrypointId": "main",
                "hostApis": [],
                "transports": ["jsonl/1"],
            },
            "generation": 0,
        },
        {"jsonrpc": "2.0", "id": "describe-1", "method": "describe", "params": {}, "generation": 0},
        {
            "jsonrpc": "2.0",
            "id": "activate-1",
            "method": "activate",
            "params": {"instanceId": "node-instance-1", "generation": 1, "capabilities": []},
            "generation": 1,
        },
        {
            "jsonrpc": "2.0",
            "id": "invoke-1",
            "method": "invoke",
            "params": {
                "contributionId": "node-hello",
                "input": {"name": "CandleScope"},
                "requestContext": context,
            },
            "generation": 1,
        },
        {
            "jsonrpc": "2.0",
            "id": "invoke-deferred-1",
            "method": "invoke",
            "params": {
                "contributionId": "node-hello",
                "input": {"name": "later", "defer": True},
                "requestContext": {**context, "traceId": "phase7-node-deferred"},
            },
            "generation": 1,
        },
        {"jsonrpc": "2.0", "id": "health-1", "method": "healthCheck", "params": {}, "generation": 1},
        {
            "jsonrpc": "2.0",
            "id": "cancel-1",
            "method": "cancel",
            "params": {"requestId": "invoke-deferred-1"},
            "generation": 1,
        },
        {
            "jsonrpc": "2.0",
            "id": "prepare-1",
            "method": "prepareUpgrade",
            "params": {},
            "generation": 1,
        },
        {"jsonrpc": "2.0", "id": "health-2", "method": "healthCheck", "params": {}, "generation": 1},
        {
            "jsonrpc": "2.0",
            "id": "deactivate-1",
            "method": "deactivate",
            "params": {"reason": "phase7 transcript"},
            "generation": 1,
        },
        {
            "jsonrpc": "2.0",
            "id": "activate-2",
            "method": "activate",
            "params": {"instanceId": "node-instance-2", "generation": 2, "capabilities": []},
            "generation": 2,
        },
        {
            "jsonrpc": "2.0",
            "id": "events-1",
            "method": "eventBatch",
            "params": {"events": [{"type": "tick"}], "delivery": {}},
            "generation": 2,
        },
        {"jsonrpc": "2.0", "id": "shutdown-1", "method": "shutdown", "params": {}, "generation": 2},
    ]


def generate_transcript(node: Path, artifacts: dict[str, Path], root: Path) -> tuple[dict[str, object], str]:
    requests = transcript_requests()
    payload = b"".join(
        json.dumps(item, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        for item in requests
    )
    completed = run(
        [
            str(node),
            "--permission",
            f"--allow-fs-read={root}",
            "--no-addons",
            "--no-global-search-paths",
            "--disable-proto=throw",
            "--unhandled-rejections=strict",
            "--max-old-space-size=128",
            "--enable-source-maps",
            str(artifacts["main.mjs"]),
        ],
        cwd=root,
        input_bytes=payload,
        timeout=30,
    )
    if completed.stderr:
        raise BuildError(
            "reference transcript emitted stderr: "
            + completed.stderr[-4000:].decode("utf-8", errors="replace")
        )
    responses = [json.loads(line) for line in completed.stdout.decode("utf-8").splitlines()]
    if len(responses) != 13:
        raise BuildError(f"reference transcript emitted {len(responses)} responses, expected 13")
    transcript_sha = canonical_sha256(responses)
    return (
        {
            "schemaVersion": "candlescope.plugin-v2-transcript.v1",
            "protocol": "candlescope.plugin/2",
            "transport": "jsonl/1",
            "requests": requests,
            "expected": {
                "responseSha256": [canonical_sha256(item) for item in responses],
                "transcriptSha256": transcript_sha,
            },
        },
        transcript_sha,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--tsc", type=Path, required=True)
    parser.add_argument("--type-roots", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    node = args.node.resolve(strict=True)
    tsc = args.tsc.resolve(strict=True)
    type_roots = args.type_roots.resolve(strict=True)
    if run([str(node), "--version"]).stdout.decode().strip() != "v24.19.0":
        raise BuildError("reference build requires Node v24.19.0")
    sdk_lock = json.loads((SDK / "supply-chain.lock.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="candlescope-node-reference-") as raw:
        temporary = Path(raw)
        artifacts = build(node, tsc, type_roots, temporary / "build")
        transcript, transcript_sha = generate_transcript(node, artifacts, temporary / "build")
        lock = {
            "schemaVersion": "candlescope.node-reference-release/1",
            "plugin": {"id": "candlescope.node-hello", "version": "0.1.0"},
            "runtime": {"id": "node-24.19.0", "version": "v24.19.0"},
            "compiler": run([str(node), str(tsc), "--version"]).stdout.decode().strip(),
            "sdk": {
                "package": sdk_lock["package"],
                "version": sdk_lock["version"],
                "sourceSha256": sdk_lock["sourceSha256"],
                "runtimeSha256": digest(artifacts["sdk.mjs"])[0],
            },
            "artifacts": {
                name: {"sha256": digest(path)[0], "size": digest(path)[1]}
                for name, path in sorted(artifacts.items())
            },
            "transcriptSha256": transcript_sha,
            "packageManagerInvoked": False,
            "lifecycleScripts": False,
            "sourceMapPathsScrubbed": True,
        }
        if args.refresh:
            RUNTIME.mkdir(parents=True, exist_ok=True)
            SOURCE_MAPS.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(artifacts["main.mjs"], RUNTIME / "main.mjs")
            shutil.copyfile(artifacts["sdk.mjs"], RUNTIME / "sdk.mjs")
            shutil.copyfile(artifacts["main.mjs.map"], SOURCE_MAPS / "main.mjs.map")
            (ROOT / "probes").mkdir(parents=True, exist_ok=True)
            (ROOT / "probes" / "node-control.json").write_text(
                json.dumps(transcript, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                + "\n",
                encoding="utf-8",
                newline="\n",
            )
            manifest_path = ROOT / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["probes"][0]["sha256"] = transcript_sha
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            LOCK.write_text(
                json.dumps(lock, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                + "\n",
                encoding="utf-8",
                newline="\n",
            )
        else:
            if not LOCK.is_file() or json.loads(LOCK.read_text(encoding="utf-8")) != lock:
                raise BuildError("reference release lock differs from a clean build")
            expected = {
                "main.mjs": RUNTIME / "main.mjs",
                "sdk.mjs": RUNTIME / "sdk.mjs",
                "main.mjs.map": SOURCE_MAPS / "main.mjs.map",
            }
            for name, path in expected.items():
                if not path.is_file() or digest(path) != digest(artifacts[name]):
                    raise BuildError(f"checked-in Node reference artifact drifted: {name}")
            if json.loads((ROOT / "probes" / "node-control.json").read_text(encoding="utf-8")) != transcript:
                raise BuildError("checked-in Node control transcript drifted")
            manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
            if manifest["probes"][0]["sha256"] != transcript_sha:
                raise BuildError("Node manifest does not bind the control transcript")
    print(json.dumps(lock, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
