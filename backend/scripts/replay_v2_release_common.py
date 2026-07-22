"""Shared fail-closed helpers for replay.v2 clean-HEAD release evidence."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = BACKEND_ROOT.parent
FRONTEND_ROOT = REPOSITORY_ROOT / "frontend"
FULL_GIT_OBJECT_ID = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def run_git(*arguments: str, cwd: Path = REPOSITORY_ROOT) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"git {' '.join(arguments)} failed: {detail}")
    return completed.stdout


def capture_clean_head() -> dict[str, object]:
    head = run_git("rev-parse", "--verify", "HEAD^{commit}").strip().lower()
    if FULL_GIT_OBJECT_ID.fullmatch(head) is None:
        raise RuntimeError("release evidence requires a full Git HEAD object id")
    status = run_git(
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    )
    if status:
        raise RuntimeError(f"release evidence requires a clean worktree:\n{status}")
    verified = run_git("rev-parse", "--verify", "HEAD^{commit}").strip().lower()
    if verified != head:
        raise RuntimeError("Git HEAD changed during clean-worktree verification")
    return {
        "schema_version": "replay-release-evidence.v1",
        "git_head": head,
        "git_dirty": False,
    }


def assert_clean_head(expected_head: str) -> None:
    current = capture_clean_head()
    if current["git_head"] != expected_head:
        raise RuntimeError(
            f"release evidence HEAD drifted: {current['git_head']} != {expected_head}"
        )


def require_external_head_path(path: Path, head: str) -> Path:
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(REPOSITORY_ROOT.resolve())
    except ValueError:
        pass
    else:
        raise ValueError("release evidence must be written outside the repository")
    if head.lower() not in {part.lower() for part in resolved.parts}:
        raise ValueError("release evidence path must contain the full clean Git HEAD")
    return resolved


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def artifact(path: Path) -> dict[str, object]:
    payload = path.read_bytes()
    return {
        "path": str(path.resolve()),
        "bytes": len(payload),
        "sha256": sha256_bytes(payload),
    }


def write_json(path: Path, value: Mapping[str, object]) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode(
        "utf-8"
    )
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(encoded)
    temporary.replace(path)
    return artifact(path)


def parse_json_output(value: str) -> Mapping[str, object]:
    stripped = value.strip()
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start < 0 or end < start:
            raise ValueError("command output did not contain a JSON object") from None
        parsed = json.loads(stripped[start : end + 1])
    if not isinstance(parsed, Mapping):
        raise ValueError("command output JSON must be an object")
    return parsed


def npm_command(npm: str, *arguments: str) -> list[str]:
    candidate = str(Path(npm).expanduser()) if ("/" in npm or "\\" in npm) else npm
    if os.name == "nt" and candidate.lower().endswith((".cmd", ".bat")):
        command_line = subprocess.list2cmdline([candidate, *arguments])
        return [os.environ.get("ComSpec", "cmd.exe"), "/d", "/s", "/c", command_line]
    return [candidate, *arguments]


def run_recorded_command(
    *,
    name: str,
    command: Sequence[str],
    cwd: Path,
    log_directory: Path,
    expected_head: str,
    timeout_seconds: int,
    environment: Mapping[str, str] | None = None,
) -> tuple[dict[str, object], str, str]:
    assert_clean_head(expected_head)
    started_at = utc_now()
    started = time.perf_counter()
    completed = subprocess.run(
        list(command),
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_seconds,
        env=None if environment is None else dict(environment),
    )
    duration_seconds = time.perf_counter() - started
    stdout_path = log_directory / f"{name}.stdout.log"
    stderr_path = log_directory / f"{name}.stderr.log"
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_path.write_text(completed.stdout, encoding="utf-8")
    stderr_path.write_text(completed.stderr, encoding="utf-8")
    assert_clean_head(expected_head)
    record = {
        "name": name,
        "command": list(command),
        "cwd": str(cwd.resolve()),
        "started_at": started_at,
        "duration_seconds": round(duration_seconds, 3),
        "returncode": completed.returncode,
        "passed": completed.returncode == 0,
        "stdout": artifact(stdout_path),
        "stderr": artifact(stderr_path),
        "stdout_tail": completed.stdout.splitlines()[-40:],
        "stderr_tail": completed.stderr.splitlines()[-40:],
    }
    if completed.returncode != 0:
        raise RuntimeError(
            f"release command {name} failed ({completed.returncode}); "
            f"see {stdout_path} and {stderr_path}"
        )
    return record, completed.stdout, completed.stderr


def load_bound_json(
    path: Path,
    *,
    expected_head: str,
    expected_schema: str,
    require_passed: bool = True,
) -> tuple[Mapping[str, object], dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    if payload.get("schema_version") != expected_schema:
        raise ValueError(
            f"{path} schema drifted: {payload.get('schema_version')} != {expected_schema}"
        )
    evidence = payload.get("release_evidence")
    if not isinstance(evidence, Mapping) or evidence.get("git_head") != expected_head:
        raise ValueError(f"{path} is not bound to clean HEAD {expected_head}")
    if evidence.get("git_dirty") is not False:
        raise ValueError(f"{path} was not captured from a clean worktree")
    if require_passed and payload.get("passed") is not True:
        raise ValueError(f"{path} is not a passing artifact")
    return payload, artifact(path)
