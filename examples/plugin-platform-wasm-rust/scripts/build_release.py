"""Deterministically build and exercise the Rust/WASI Preview 2 reference."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import runpy
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence


REFERENCE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = REFERENCE_ROOT.parents[1]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_PYTHON_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
SDK_ROOT = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-rust-wasm"
RUNTIME_PATH = REFERENCE_ROOT / "runtime" / "main.wasm"
PROBE_PATH = REFERENCE_ROOT / "probes" / "wasm-control.json"
MANIFEST_PATH = REFERENCE_ROOT / "manifest.json"
LOCK_PATH = REFERENCE_ROOT / "supply-chain.lock.json"
TARGET = "wasm32-wasip2"
TOOLCHAIN = "1.97.1"
COMPONENT_HEADER = b"\x00asm\x0d\x00\x01\x00"
WASMTIME_POLICY = runpy.run_path(
    str(
        BACKEND_ROOT
        / "app"
        / "plugin_core_v2"
        / "runtime_providers"
        / "wasmtime_policy.py"
    )
)
WASMTIME_FIXED_ARGUMENTS = tuple(WASMTIME_POLICY["WASMTIME_FIXED_ARGUMENTS"])


class BuildError(RuntimeError):
    pass


def _ensure_import_paths() -> None:
    for path in (SDK_PYTHON_SOURCE, BACKEND_ROOT):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)


def _run(
    command: Sequence[str],
    *,
    cwd: Path = REFERENCE_ROOT,
    environment: dict[str, str] | None = None,
    input_bytes: bytes | None = None,
    timeout: float = 180,
) -> subprocess.CompletedProcess[bytes]:
    completed = subprocess.run(
        tuple(command),
        cwd=cwd,
        env=environment,
        input=input_bytes,
        stdin=None if input_bytes is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        shell=False,
        timeout=timeout,
    )
    if completed.returncode:
        raise BuildError(
            f"command failed ({completed.returncode}): {tuple(command)!r}\n"
            + completed.stderr[-6000:].decode("utf-8", errors="replace")
        )
    return completed


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_path(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _build_once(cargo: Path, target_directory: Path) -> Path:
    environment = dict(os.environ)
    environment["CARGO_TARGET_DIR"] = str(target_directory)
    environment["CARGO_NET_OFFLINE"] = "true"
    relative_source_prefix = f"src{os.sep}"
    environment["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(
        (
            (
                f"--remap-path-prefix={(SDK_ROOT / 'src' / 'lib.rs').resolve()}="
                "/workspace/packages/candlescope-plugin-sdk-rust-wasm/src/lib.rs"
            ),
            (
                f"--remap-path-prefix={relative_source_prefix}="
                "/workspace/examples/plugin-platform-wasm-rust/src/"
            ),
        )
    )
    _run(
        (
            str(cargo),
            f"+{TOOLCHAIN}",
            "build",
            "--manifest-path",
            str(REFERENCE_ROOT / "Cargo.toml"),
            "--release",
            "--target",
            TARGET,
            "--locked",
            "--offline",
        ),
        environment=environment,
    )
    output = target_directory / TARGET / "release" / "candlescope-wasm-reference.wasm"
    if not output.is_file() or output.read_bytes()[:8] != COMPONENT_HEADER:
        raise BuildError("Rust did not produce a WASM Component Model command binary")
    return output


def _requests() -> list[dict[str, Any]]:
    context = {
        "contributionId": "wasm-hello",
        "generation": 1,
        "traceId": "phase8-wasm",
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
                "instanceId": "wasm-instance-1",
            },
        },
        {
            "generation": 1,
            "id": "invoke-1",
            "jsonrpc": "2.0",
            "method": "invoke",
            "params": {
                "contributionId": "wasm-hello",
                "input": {"name": "CandleScope 波浪", "numbers": [1, 2, 3]},
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
            "params": {"reason": "phase8 transcript"},
        },
        {
            "generation": 2,
            "id": "activate-2",
            "jsonrpc": "2.0",
            "method": "activate",
            "params": {
                "capabilities": [],
                "generation": 2,
                "instanceId": "wasm-instance-2",
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


def _transcript(wasmtime: Path, component: Path) -> tuple[dict[str, Any], list[Any]]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import (
        canonical_sha256,
        loads_strict,
    )

    requests = _requests()
    input_bytes = b"".join(_canonical_bytes(item) + b"\n" for item in requests)
    completed = _run(
        (
            str(wasmtime.resolve(strict=True)),
            *WASMTIME_FIXED_ARGUMENTS,
            "--",
            str(component.resolve(strict=True)),
        ),
        input_bytes=input_bytes,
        timeout=60,
    )
    if completed.stderr:
        raise BuildError("reference control transcript wrote unexpected stderr")
    lines = completed.stdout.splitlines()
    if len(lines) != len(requests):
        raise BuildError(
            f"reference transcript returned {len(lines)} responses for {len(requests)} requests"
        )
    responses = [loads_strict(line) for line in lines]
    expected_ids = [item["id"] for item in requests]
    if [item.get("id") for item in responses if isinstance(item, dict)] != expected_ids:
        raise BuildError("reference transcript response IDs are not deterministic")
    transcript = {
        "schemaVersion": "candlescope.plugin-v2-transcript.v1",
        "protocol": "candlescope.plugin/2",
        "transport": "jsonl/1",
        "requests": requests,
        "expected": {
            "responseSha256": [canonical_sha256(item) for item in responses],
            "transcriptSha256": canonical_sha256(responses),
        },
    }
    return transcript, responses


def build(cargo: Path, wasmtime: Path, *, write: bool) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import canonical_sha256

    # Keep the rustup proxy path intact on Unix: resolving the ``cargo`` symlink
    # changes argv[0] to ``rustup`` and disables rustup's proxy dispatch.
    cargo = cargo.absolute()
    if not cargo.is_file():
        raise BuildError(f"cargo executable is unavailable: {cargo}")
    wasmtime = wasmtime.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="candlescope-wasm-build-a-") as first_raw:
        with tempfile.TemporaryDirectory(
            prefix="candlescope-wasm-build-b-"
        ) as second_raw:
            first = _build_once(cargo, Path(first_raw))
            second = _build_once(cargo, Path(second_raw))
            first_bytes = first.read_bytes()
            second_bytes = second.read_bytes()
            if first_bytes != second_bytes:
                raise BuildError("two clean Rust/WASM builds produced different bytes")
            transcript, responses = _transcript(wasmtime, first)
            manifest = json.loads(MANIFEST_PATH.read_bytes())
            manifest["probes"][0]["sha256"] = transcript["expected"]["transcriptSha256"]
            sdk_source = (SDK_ROOT / "src" / "lib.rs").read_bytes()
            reference_source = (REFERENCE_ROOT / "src" / "main.rs").read_bytes()
            lock = {
                "schemaVersion": "candlescope.wasm-reference-release/1",
                "plugin": {"id": "candlescope.wasm-reference", "version": "0.1.0"},
                "runtime": {"id": "wasmtime-47.0.3", "version": "47.0.3"},
                "toolchain": {
                    "rust": TOOLCHAIN,
                    "target": TARGET,
                    "componentExport": "wasi:cli/run",
                    "componentHeader": COMPONENT_HEADER.hex(),
                },
                "dependencies": [],
                "offline": True,
                "reproducibleBuilds": 2,
                "artifacts": {
                    "main.wasm": {
                        "sha256": _sha256_bytes(first_bytes),
                        "size": len(first_bytes),
                    }
                },
                "sdk": {
                    "package": "candlescope-plugin-sdk-wasm",
                    "version": "0.1.0",
                    "sourceSha256": _sha256_bytes(sdk_source),
                    "cargoLockSha256": _sha256_path(SDK_ROOT / "Cargo.lock"),
                },
                "sourceSha256": _sha256_bytes(reference_source),
                "cargoLockSha256": _sha256_path(REFERENCE_ROOT / "Cargo.lock"),
                "transcriptSha256": transcript["expected"]["transcriptSha256"],
                "transcriptResponses": len(responses),
                "packageManagerInvoked": False,
                "networkAccessDuringBuild": False,
            }
            if write:
                RUNTIME_PATH.parent.mkdir(parents=True, exist_ok=True)
                PROBE_PATH.parent.mkdir(parents=True, exist_ok=True)
                RUNTIME_PATH.write_bytes(first_bytes)
                PROBE_PATH.write_bytes(_canonical_bytes(transcript))
                MANIFEST_PATH.write_text(
                    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                    newline="\n",
                )
                LOCK_PATH.write_bytes(_canonical_bytes(lock))
            return {
                "schemaVersion": "candlescope.wasm-reference-build/1",
                "result": "pass",
                "wrote": write,
                "artifactSha256": lock["artifacts"]["main.wasm"]["sha256"],
                "artifactSize": lock["artifacts"]["main.wasm"]["size"],
                "transcriptSha256": lock["transcriptSha256"],
                "transcriptResponses": lock["transcriptResponses"],
                "manifestSha256": canonical_sha256(manifest),
                "sdkSourceSha256": lock["sdk"]["sourceSha256"],
            }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cargo", type=Path, required=True)
    parser.add_argument("--wasmtime", type=Path, required=True)
    parser.add_argument("--write", action="store_true")
    arguments = parser.parse_args()
    result = build(arguments.cargo, arguments.wasmtime, write=arguments.write)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
