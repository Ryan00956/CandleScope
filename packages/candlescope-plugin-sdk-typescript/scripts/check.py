#!/usr/bin/env python3
"""Build, package and smoke-test the dependency-free Node SDK without npm."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = ROOT.parents[1]
DIST = ROOT / "dist"
RELEASE = ROOT / "release" / "candlescope-plugin-sdk-node-0.1.0.tgz"
LOCK = ROOT / "supply-chain.lock.json"
FIXED_MTIME = 1_785_715_200  # 2026-08-03T00:00:00Z


class CheckError(RuntimeError):
    pass


def digest_bytes(payload: bytes) -> tuple[str, int]:
    return f"sha256:{hashlib.sha256(payload).hexdigest()}", len(payload)


def digest(path: Path) -> tuple[str, int]:
    return digest_bytes(path.read_bytes())


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
        raise CheckError(
            f"command failed ({completed.returncode}): {command}\n"
            + completed.stderr[-4000:].decode("utf-8", errors="replace")
        )
    return completed


def compile_sdk(
    node: Path, tsc: Path, type_roots: Path, destination: Path
) -> dict[str, tuple[str, int]]:
    run(
        [
            str(node),
            str(tsc),
            "-p",
            str(ROOT / "tsconfig.json"),
            "--outDir",
            str(destination),
            "--typeRoots",
            str(type_roots),
        ]
    )
    expected = {"index.mjs", "index.d.mts"}
    actual = {item.relative_to(destination).as_posix() for item in destination.rglob("*") if item.is_file()}
    if actual != expected:
        raise CheckError(f"TypeScript SDK emitted unexpected files: {sorted(actual)}")
    return {name: digest(destination / name) for name in sorted(expected)}


def tarball(compiled: Path) -> bytes:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    forbidden = {"dependencies", "optionalDependencies", "peerDependencies", "scripts"}
    if forbidden.intersection(package):
        raise CheckError("SDK package must have no dependencies or lifecycle scripts")
    files: dict[str, bytes] = {
        "package/package.json": (
            json.dumps(package, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
        ).encode(),
        "package/LICENSE": (REPOSITORY_ROOT / "LICENSE").read_bytes(),
        "package/README_zh.md": (ROOT / "README_zh.md").read_bytes(),
        "package/dist/index.mjs": (compiled / "index.mjs").read_bytes(),
        "package/dist/index.d.mts": (compiled / "index.d.mts").read_bytes(),
    }
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for name, payload in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o644
            info.mtime = FIXED_MTIME
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            archive.addfile(info, io.BytesIO(payload))
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as stream:
        stream.write(tar_buffer.getvalue())
    return output.getvalue()


def safe_extract(payload: bytes, destination: Path) -> Path:
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        names = [item.name for item in archive.getmembers()]
        if any(
            not name.startswith("package/")
            or "\\" in name
            or ".." in Path(name).parts
            for name in names
        ):
            raise CheckError("SDK tarball contains an unsafe path")
        archive.extractall(destination, filter="data")
    return destination / "package"


def serve_smoke(node: Path, sdk: Path) -> dict[str, object]:
    requests = [
        {
            "jsonrpc": "2.0",
            "id": "h",
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
        {
            "jsonrpc": "2.0",
            "id": "a",
            "method": "activate",
            "params": {"instanceId": "node-sdk-smoke", "generation": 1, "capabilities": []},
            "generation": 1,
        },
        {
            "jsonrpc": "2.0",
            "id": "i",
            "method": "invoke",
            "params": {
                "contributionId": "hello",
                "input": {},
                "requestContext": {
                    "contributionId": "hello",
                    "userAction": True,
                    "generation": 1,
                    "traceId": "node-sdk-smoke",
                },
            },
            "generation": 1,
        },
        {
            "jsonrpc": "2.0",
            "id": "s",
            "method": "shutdown",
            "params": {},
            "generation": 1,
        },
    ]
    stdin = b"".join(
        json.dumps(item, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        for item in requests
    )
    completed = run(
        [str(node), str(ROOT / "tests" / "serve-fixture.mjs"), str(sdk)],
        input_bytes=stdin,
        timeout=30,
    )
    lines = [json.loads(item) for item in completed.stdout.decode("utf-8").splitlines()]
    if len(lines) != 4 or lines[2].get("result") != {"ok": True}:
        raise CheckError(f"SDK serve smoke returned another protocol transcript: {lines}")
    stderr = completed.stderr.decode("utf-8")
    if "plugin-log-on-stderr" not in stderr or "plugin-direct-stdout-isolated" not in stderr:
        raise CheckError("SDK did not isolate plugin stdout to stderr")
    if b"plugin-" in completed.stdout:
        raise CheckError("plugin logging polluted protocol stdout")
    return {"responses": len(lines), "stdoutIsolation": True}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--tsc", type=Path, required=True)
    parser.add_argument("--type-roots", type=Path, required=True)
    parser.add_argument("--python-transcript", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    node = args.node.resolve(strict=True)
    tsc = args.tsc.resolve(strict=True)
    type_roots = args.type_roots.resolve(strict=True)
    version = run([str(node), "--version"]).stdout.decode().strip()
    if version != "v24.19.0":
        raise CheckError(f"SDK check requires Node v24.19.0, got {version!r}")
    compiler_version = run([str(node), str(tsc), "--version"]).stdout.decode().strip()
    with tempfile.TemporaryDirectory(prefix="candlescope-node-sdk-") as raw:
        temporary = Path(raw)
        compiled = temporary / "dist"
        compiled.mkdir()
        contents = compile_sdk(node, tsc, type_roots, compiled)
        payload = tarball(compiled)
        package = safe_extract(payload, temporary / "extract")
        self_test = run(
            [
                str(node),
                str(ROOT / "tests" / "self-test.mjs"),
                str(package / "dist" / "index.mjs"),
                str(args.python_transcript.resolve(strict=True)),
            ],
            timeout=60,
        )
        if self_test.stdout != b"candlescope-plugin-sdk-node self-test: PASS\n":
            raise CheckError(f"unexpected SDK self-test output: {self_test.stdout!r}")
        serve = serve_smoke(node, package / "dist" / "index.mjs")
        release_digest, release_size = digest_bytes(payload)
        lock = {
            "schemaVersion": "candlescope.plugin-sdk-node-release/1",
            "package": "@candlescope/plugin-sdk-node",
            "version": "0.1.0",
            "node": version,
            "compiler": compiler_version,
            "sourceSha256": digest(ROOT / "src" / "index.mts")[0],
            "contents": {
                name: {"sha256": value[0], "size": value[1]}
                for name, value in sorted(contents.items())
            },
            "tarball": {
                "path": RELEASE.relative_to(ROOT).as_posix(),
                "sha256": release_digest,
                "size": release_size,
            },
            "pythonParityTranscriptSha256": "sha256:d98ebd2fc9f5b0695925caf47ecf961eae47a56b5e8ec110f28acc9365afdd38",
            "packageManagerInvoked": False,
            "lifecycleScripts": False,
        }
        if args.refresh:
            if DIST.exists():
                shutil.rmtree(DIST)
            shutil.copytree(compiled, DIST)
            RELEASE.parent.mkdir(parents=True, exist_ok=True)
            RELEASE.write_bytes(payload)
            LOCK.write_text(
                json.dumps(lock, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                + "\n",
                encoding="utf-8",
                newline="\n",
            )
        else:
            if not LOCK.is_file() or json.loads(LOCK.read_text(encoding="utf-8")) != lock:
                raise CheckError("SDK release lock differs from a clean deterministic build")
            if not RELEASE.is_file() or digest(RELEASE) != (release_digest, release_size):
                raise CheckError("fixed SDK tarball differs from a clean deterministic build")
            for name, expected in contents.items():
                if not (DIST / name).is_file() or digest(DIST / name) != expected:
                    raise CheckError(f"checked-in SDK dist drifted: {name}")
    print(
        json.dumps(
            {
                "schemaVersion": "candlescope.plugin-sdk-node-check/1",
                "result": "pass",
                "node": version,
                "compiler": compiler_version,
                "tarballSha256": release_digest,
                "tarballSize": release_size,
                "selfTest": self_test.stdout.decode().strip(),
                "serve": serve,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
