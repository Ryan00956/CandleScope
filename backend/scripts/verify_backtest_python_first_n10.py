"""Verify a Python First N10 release manifest without enabling production."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

import jsonschema

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.backtest.python_first_n10 import (  # noqa: E402
    FRONTEND_FLAGS,
    PRODUCTION_FLAGS,
    VALIDATED_STATUS,
    n10_status,
)


EVIDENCE_PREFIX = "docs/evidence/"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(*args: str, cwd: Path) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=cwd, text=True, encoding="utf-8"
    ).strip()


def _git_bytes(*args: str, cwd: Path) -> bytes:
    return subprocess.check_output(["git", *args], cwd=cwd)


def _git_result(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def _require_ancestor(ancestor: str, descendant: str, *, repository: Path) -> None:
    result = _git_result(
        "merge-base", "--is-ancestor", ancestor, descendant, cwd=repository
    )
    if result.returncode != 0:
        raise RuntimeError(f"Git commit {ancestor} is not an ancestor of {descendant}")


def _relative_artifact_path(value: object) -> str:
    raw = str(value)
    parsed = PurePosixPath(raw)
    if (
        not raw
        or "\\" in raw
        or parsed.is_absolute()
        or any(part in {"", ".", ".."} for part in parsed.parts)
    ):
        raise RuntimeError(f"release artifact path is not repository-relative: {raw}")
    return parsed.as_posix()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def verify(manifest_path: Path, schema_path: Path, repository: Path) -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    schema_path = schema_path.resolve()
    repository = repository.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(manifest)
    if (
        manifest.get("merged")
        or manifest.get("pushed")
        or manifest.get("productionEnabled")
    ):
        raise RuntimeError(
            "N10 manifest cannot claim merge, push, or production enablement"
        )
    if manifest.get("gitDirty") is not False:
        raise RuntimeError("N10 manifest must bind a clean candidate")

    base = str(manifest["baseSha"])
    candidate = str(manifest["gitSha"])
    head = _git("rev-parse", "HEAD", cwd=repository)
    branch = _git("branch", "--show-current", cwd=repository)
    if branch != manifest.get("branch"):
        raise RuntimeError(
            f"manifest branch {manifest.get('branch')} does not match current branch {branch}"
        )
    if _git("status", "--porcelain", "--untracked-files=all", cwd=repository):
        raise RuntimeError("repository worktree is dirty")
    _require_ancestor(base, candidate, repository=repository)
    _require_ancestor(candidate, head, repository=repository)

    candidate_diff = _git_result(
        "diff", "--check", f"{base}...{candidate}", cwd=repository
    )
    if candidate_diff.returncode != 0:
        raise RuntimeError(
            "candidate branch diff has whitespace errors:\n"
            + (candidate_diff.stdout or candidate_diff.stderr)
        )
    post_candidate_diff = _git_result(
        "diff", "--check", f"{candidate}..{head}", cwd=repository
    )
    if post_candidate_diff.returncode != 0:
        raise RuntimeError(
            "post-candidate evidence diff has whitespace errors:\n"
            + (post_candidate_diff.stdout or post_candidate_diff.stderr)
        )
    changed = (
        []
        if candidate == head
        else _git(
            "diff", "--name-only", f"{candidate}..{head}", cwd=repository
        ).splitlines()
    )
    forbidden = [path for path in changed if not path.startswith(EVIDENCE_PREFIX)]
    if forbidden:
        raise RuntimeError(
            f"non-evidence files changed after candidate validation: {forbidden[:5]}"
        )

    local_main = _git_result("rev-parse", "--verify", "refs/heads/main", cwd=repository)
    if local_main.returncode == 0:
        merged = _git_result(
            "merge-base", "--is-ancestor", candidate, "refs/heads/main", cwd=repository
        )
        if merged.returncode == 0:
            raise RuntimeError("candidate is already merged into local main")
    remote_refs = _git(
        "for-each-ref",
        "--format=%(refname)",
        "--contains",
        candidate,
        "refs/remotes",
        cwd=repository,
    ).splitlines()
    if remote_refs:
        raise RuntimeError(f"candidate is already present on remote refs: {remote_refs}")

    flags = manifest.get("effectiveFlags") or {}
    release_flags = (*PRODUCTION_FLAGS, *FRONTEND_FLAGS)
    missing = [name for name in release_flags if name not in flags]
    enabled = sorted(
        name
        for name in release_flags
        if str(flags.get(name, "0")).strip().lower()
        not in {"0", "false", "off", "no"}
    )
    enabled_environment = sorted(
        name
        for name in release_flags
        if str(os.environ.get(name, "0")).strip().lower()
        not in {"0", "false", "off", "no"}
    )
    if missing or enabled or enabled_environment:
        raise RuntimeError(
            "production flags incomplete or enabled: "
            f"missing={missing}, enabled={enabled}, environment={enabled_environment}"
        )
    computed = n10_status(manifest.get("gates") or {})
    if manifest.get("status") == VALIDATED_STATUS and computed != VALIDATED_STATUS:
        raise RuntimeError(
            "manifest claims VALIDATED_CLEAN_SHA_UNMERGED but gates are open"
        )
    if manifest.get("status") != computed:
        raise RuntimeError(
            f"manifest status {manifest.get('status')} does not match gates {computed}"
        )
    artifacts = []
    for artifact in manifest.get("artifactPaths") or []:
        relative = _relative_artifact_path(artifact["path"])
        path = repository / Path(*PurePosixPath(relative).parts)
        if not path.is_file():
            raise RuntimeError(f"release artifact is missing: {path}")
        candidate_bytes = _git_bytes(
            "show", f"{candidate}:{relative}", cwd=repository
        )
        candidate_sha256 = _sha256_bytes(candidate_bytes)
        current_sha256 = _sha256(path)
        if (
            candidate_sha256 != artifact["sha256"]
            or current_sha256 != artifact["sha256"]
        ):
            raise RuntimeError(f"release artifact hash mismatch: {path}")
        artifacts.append(
            {
                "kind": artifact["kind"],
                "path": relative,
                "sha256": current_sha256,
            }
        )
    return {
        "schemaVersion": "candlescope.python-first-release-verification/1",
        "status": "PASS",
        "manifestStatus": manifest["status"],
        "baseSha": base,
        "candidateSha": candidate,
        "currentHead": head,
        "branch": branch,
        "postCandidateChangedPaths": changed,
        "artifactCount": len(artifacts),
        "artifacts": artifacts,
        "allProductionFlagsDefaultOff": True,
        "merged": False,
        "pushed": False,
        "productionEnabled": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--repository", default=Path.cwd(), type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = verify(args.manifest, args.schema, args.repository)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
