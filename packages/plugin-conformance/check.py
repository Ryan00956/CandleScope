#!/usr/bin/env python3
"""Validate the language-neutral Plugin Platform v2 conformance registry."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = ROOT.parents[1]
SUITE_PATH = ROOT / "suite.json"
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_DEPTH = 64
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
REQUIRED_CASES = frozenset(
    {
        "handshake-before-method",
        "feature-negotiation",
        "describe-manifest-parity",
        "generation-mismatch",
        "duplicate-request-id",
        "invoke-success",
        "invoke-business-error",
        "invoke-internal-error",
        "host-call-request-response",
        "host-call-cancel",
        "health-check",
        "deactivate-prepare-upgrade-shutdown",
        "invalid-json",
        "duplicate-json-field",
        "nan",
        "over-depth",
        "oversized-message",
        "invalid-utf8",
        "stdout-pollution",
        "stderr-redaction",
        "timeout",
        "cancel-race",
        "late-response",
        "process-exit",
        "restart-budget",
        "circuit-breaker",
        "capability-lease-revoke",
        "deterministic-canonical-output",
    }
)
RUNTIME_KINDS = frozenset(
    {"python-module", "native-executable", "java-jar", "node-module", "wasm-component"}
)


class ConformanceError(RuntimeError):
    pass


def _pairs(values: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in values:
        if key in result:
            raise ConformanceError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _depth(value: Any, current: int = 0) -> int:
    if current > MAX_DEPTH:
        raise ConformanceError("JSON exceeds the conformance depth limit")
    if isinstance(value, dict):
        for item in value.values():
            _depth(item, current + 1)
    elif isinstance(value, list):
        for item in value:
            _depth(item, current + 1)
    return current


def strict_json(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ConformanceError(f"required JSON file is unavailable: {path}")
    payload = path.read_bytes()
    if not payload or len(payload) > MAX_JSON_BYTES:
        raise ConformanceError(f"JSON file has an invalid size: {path}")
    try:
        text = payload.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_pairs,
            parse_constant=lambda token: (_ for _ in ()).throw(
                ConformanceError(f"non-finite JSON number: {token}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConformanceError(f"strict JSON decode failed: {path}") from exc
    if not isinstance(value, dict):
        raise ConformanceError(f"JSON root must be an object: {path}")
    _depth(value)
    return value


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def repository_path(relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ConformanceError("suite paths must be non-empty POSIX repository paths")
    candidate = (REPOSITORY_ROOT / relative).resolve(strict=False)
    try:
        candidate.relative_to(REPOSITORY_ROOT)
    except ValueError as exc:
        raise ConformanceError(f"suite path leaves the repository: {relative}") from exc
    return candidate


def _manifest_probe(path: Path, transcript_sha256: str) -> bool:
    manifest = strict_json(path)
    probes = manifest.get("probes")
    return isinstance(probes, list) and any(
        isinstance(item, dict) and item.get("sha256") == transcript_sha256
        for item in probes
    )


def _validate_transcript(record: dict[str, Any]) -> dict[str, Any]:
    required = {
        "runtimeKind",
        "runtimeId",
        "path",
        "fileSha256",
        "transcriptSha256",
        "manifestPath",
        "requiredMethods",
    }
    if set(record) != required:
        raise ConformanceError("runtime transcript registry fields changed")
    path = repository_path(record["path"])
    manifest_path = repository_path(record["manifestPath"])
    actual_file_sha256 = sha256_path(path)
    if actual_file_sha256 != record["fileSha256"]:
        raise ConformanceError(f"transcript file digest changed: {record['path']}")
    transcript = strict_json(path)
    if (
        transcript.get("schemaVersion") != "candlescope.plugin-v2-transcript.v1"
        or transcript.get("protocol") != "candlescope.plugin/2"
        or transcript.get("transport") != "jsonl/1"
    ):
        raise ConformanceError(f"transcript envelope changed: {record['path']}")
    requests = transcript.get("requests")
    expected = transcript.get("expected")
    if not isinstance(requests, list) or not requests or not isinstance(expected, dict):
        raise ConformanceError(f"transcript body is incomplete: {record['path']}")
    if expected.get("transcriptSha256") != record["transcriptSha256"]:
        raise ConformanceError(f"transcript result digest changed: {record['path']}")
    response_sha256 = expected.get("responseSha256")
    if (
        not isinstance(response_sha256, list)
        or len(response_sha256) != len(requests)
        or not all(
            isinstance(item, str) and SHA256.fullmatch(item) for item in response_sha256
        )
    ):
        raise ConformanceError(
            f"response digest inventory is incomplete: {record['path']}"
        )
    methods = [item.get("method") for item in requests if isinstance(item, dict)]
    observed = {item for item in methods if isinstance(item, str)}
    if methods[0] != "handshake" or methods[-1] != "shutdown":
        raise ConformanceError(
            f"transcript lifecycle boundary changed: {record['path']}"
        )
    missing = set(record["requiredMethods"]) - observed
    if missing:
        raise ConformanceError(
            f"transcript lacks required methods {sorted(missing)}: {record['path']}"
        )
    request_ids = [item.get("id") for item in requests if isinstance(item, dict)]
    if any(
        not isinstance(item, (str, int)) or isinstance(item, bool)
        for item in request_ids
    ):
        raise ConformanceError(
            f"transcript has an invalid request id: {record['path']}"
        )
    if len(request_ids) != len(set(request_ids)):
        raise ConformanceError(
            f"transcript has duplicate request ids: {record['path']}"
        )
    if not _manifest_probe(manifest_path, record["transcriptSha256"]):
        raise ConformanceError(
            f"manifest probe is not bound to transcript: {record['path']}"
        )
    return {
        "runtimeKind": record["runtimeKind"],
        "runtimeId": record["runtimeId"],
        "path": record["path"],
        "fileSha256": actual_file_sha256,
        "transcriptSha256": record["transcriptSha256"],
        "requestCount": len(requests),
        "methods": sorted(observed),
        "manifestProbeBound": True,
    }


def _validate_cases(cases: Any) -> tuple[list[str], list[str]]:
    if not isinstance(cases, list):
        raise ConformanceError("conformance cases must be an array")
    ids: list[str] = []
    nodeids: list[str] = []
    for item in cases:
        if not isinstance(item, dict) or set(item) != {"id", "evidence"}:
            raise ConformanceError("conformance case fields changed")
        case_id = item["id"]
        evidence = item["evidence"]
        if (
            not isinstance(case_id, str)
            or not isinstance(evidence, str)
            or "::" not in evidence
        ):
            raise ConformanceError("conformance case identity is invalid")
        relative, symbol = evidence.split("::", 1)
        source = repository_path(relative)
        if source.is_symlink() or not source.is_file():
            raise ConformanceError(
                f"conformance evidence source is unavailable: {relative}"
            )
        if f"def {symbol}(" not in source.read_text(encoding="utf-8"):
            raise ConformanceError(
                f"conformance evidence symbol is unavailable: {evidence}"
            )
        ids.append(case_id)
        nodeids.append(evidence)
    if len(ids) != len(set(ids)) or frozenset(ids) != REQUIRED_CASES:
        raise ConformanceError("conformance case inventory is incomplete or duplicated")
    return ids, nodeids


def validate_suite() -> tuple[dict[str, Any], list[str]]:
    suite = strict_json(SUITE_PATH)
    if set(suite) != {
        "schemaVersion",
        "protocol",
        "transport",
        "canonicalTranscript",
        "sdkConsumers",
        "runtimeTranscripts",
        "cases",
    }:
        raise ConformanceError("conformance suite fields changed")
    if (
        suite["schemaVersion"] != "candlescope.plugin-conformance-suite/1"
        or suite["protocol"] != "candlescope.plugin/2"
        or suite["transport"] != "jsonl/1"
    ):
        raise ConformanceError("conformance suite protocol identity changed")
    canonical = suite["canonicalTranscript"]
    if not isinstance(canonical, dict):
        raise ConformanceError("canonical transcript registration is invalid")
    transcript_records = suite["runtimeTranscripts"]
    if not isinstance(transcript_records, list):
        raise ConformanceError("runtime transcripts must be an array")
    transcripts = [_validate_transcript(item) for item in transcript_records]
    if {item["runtimeKind"] for item in transcripts} != RUNTIME_KINDS:
        raise ConformanceError("runtime transcript coverage is incomplete")
    python_record = next(
        item for item in transcript_records if item["runtimeKind"] == "python-module"
    )
    if any(python_record[key] != canonical[key] for key in canonical):
        raise ConformanceError(
            "canonical transcript is not the Python runtime transcript"
        )
    consumers = suite["sdkConsumers"]
    if not isinstance(consumers, list) or {
        item.get("language") for item in consumers
    } != {"python", "java", "typescript"}:
        raise ConformanceError(
            "cross-SDK canonical transcript consumers are incomplete"
        )
    for item in consumers:
        source = repository_path(item.get("checkPath"))
        text = source.read_text(encoding="utf-8")
        if (
            item["language"] in {"java", "typescript"}
            and "python-transcript" not in text
        ):
            raise ConformanceError(
                f"{item['language']} SDK does not accept the canonical fixture path"
            )
        if (
            item["language"] == "python"
            and "hello_command_transcript_v2.json" not in text
        ):
            raise ConformanceError("Python SDK does not read the canonical fixture")
    cases, nodeids = _validate_cases(suite["cases"])
    return (
        {
            "schemaVersion": "candlescope.plugin-conformance-check/1",
            "result": "pass",
            "suiteSha256": sha256_path(SUITE_PATH),
            "canonicalTranscriptSha256": canonical["transcriptSha256"],
            "sdkConsumers": sorted(item["language"] for item in consumers),
            "runtimeTranscripts": transcripts,
            "caseCount": len(cases),
            "cases": sorted(cases),
        },
        nodeids,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-python-cases", action="store_true")
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    result, nodeids = validate_suite()
    if args.run_python_cases:
        grouped: dict[str, list[str]] = {}
        for nodeid in nodeids:
            grouped.setdefault(nodeid.split("::", 1)[0], []).append(nodeid)
        output: list[str] = []
        for source, source_nodeids in grouped.items():
            completed = subprocess.run(
                [
                    str(args.python.resolve(strict=True)),
                    "-m",
                    "pytest",
                    *source_nodeids,
                    "-q",
                ],
                cwd=REPOSITORY_ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                timeout=300,
                check=False,
            )
            output.append(f"[{source}]\n{completed.stdout.strip()}")
            if completed.returncode:
                raise ConformanceError(
                    "registered Python conformance cases failed\n"
                    + "\n".join(output)[-8000:]
                )
        combined = "\n".join(output)
        result["pythonCases"] = {
            "result": "pass",
            "nodeids": len(nodeids),
            "sourceFiles": len(grouped),
            "outputTail": combined[-4000:].strip(),
        }
    payload = (
        json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    )
    if args.output is not None:
        output = args.output.resolve(strict=False)
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_name(f".{output.name}.tmp")
        temporary.write_text(payload, encoding="utf-8", newline="\n")
        temporary.replace(output)
    sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ConformanceError, OSError, ValueError) as exc:
        print(
            json.dumps(
                {"ok": False, "errorType": type(exc).__name__, "message": str(exc)},
                ensure_ascii=False,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
