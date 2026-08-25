from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

REQUIRED_FLAGS = (
    "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED",
    "VITE_RESEARCH_DATA_LIBRARY_ENABLED",
)
PHASE_KEYS = tuple(f"phase{index}" for index in range(13))
RELEASE_EVIDENCE_PREFIX = "docs/evidence/"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(*args: str, cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True, encoding="utf-8").strip()


def _is_release_evidence_path(value: str) -> bool:
    return value.replace("\\", "/").startswith(RELEASE_EVIDENCE_PREFIX)


def _require_clean_worktree(repository: Path) -> None:
    status = _git("status", "--porcelain", "--untracked-files=all", cwd=repository)
    if status:
        raise RuntimeError("release verification requires a clean worktree")


def _require_candidate_code_unchanged(candidate: str, head: str, repository: Path) -> None:
    changed = _git("diff", "--name-only", f"{candidate}..{head}", cwd=repository).splitlines()
    non_evidence = [path for path in changed if not _is_release_evidence_path(path)]
    if non_evidence:
        joined = ", ".join(non_evidence[:8])
        raise RuntimeError(f"code changed after the release candidate: {joined}")


def _validate_schema(manifest: dict[str, Any], schema: dict[str, Any]) -> None:
    try:
        import jsonschema
    except ImportError:
        if manifest.get("schemaVersion") != schema.get("properties", {}).get("schemaVersion", {}).get("const"):
            raise RuntimeError("manifest schemaVersion is invalid") from None
        for key in schema.get("required", []):
            if key not in manifest:
                raise RuntimeError(f"manifest missing {key}")
        return
    jsonschema.Draft202012Validator(schema).validate(manifest)


def verify(manifest_path: Path, schema_path: Path, repository: Path) -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    schema_path = schema_path.resolve()
    repository = repository.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    _validate_schema(manifest, schema)
    _require_clean_worktree(repository)

    candidate = str(manifest["candidateSha"])
    head = _git("rev-parse", "HEAD", cwd=repository)
    missing_phases = [key for key in PHASE_KEYS if key not in manifest["phaseCommits"]]
    if missing_phases:
        raise RuntimeError(f"phase commits missing: {missing_phases}")
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", candidate, head],
        cwd=repository,
        check=False,
    )
    if ancestor.returncode != 0:
        raise RuntimeError("manifest candidate SHA is not an ancestor of current HEAD")
    if str(manifest["phaseCommits"]["phase12"]["sha"]) != candidate:
        raise RuntimeError("phase12 commit must be the release candidate SHA")
    _require_candidate_code_unchanged(candidate, head, repository)

    flags = manifest["effectiveFlags"]
    for name in REQUIRED_FLAGS:
        if flags.get(name) != "0":
            raise RuntimeError(f"{name} must remain default 0 in this release")

    config = (repository / "backend" / "app" / "core" / "config.py").read_text(encoding="utf-8").replace("\r\n", "\n")
    flags_ts = (
        repository / "frontend" / "src" / "features" / "research-data" / "researchDataFlags.ts"
    ).read_text(encoding="utf-8")
    if (
        'RESEARCH_DATA_LIBRARY_ENABLED = _parse_strict_flag(\n    "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED",\n    "0",\n)'
        not in config
    ):
        raise RuntimeError("backend library flag default is not 0")
    if 'return raw === true || raw === 1 || raw === "1";' not in flags_ts:
        raise RuntimeError("frontend library flag is not strict opt-in")

    if manifest["legacyWorktree"]["deleted"] or manifest["scope"]["oldWorktreeDeleted"]:
        raise RuntimeError("legacy worktree must not be deleted")
    if manifest["scope"]["push"] or manifest["scope"]["merge"] or manifest["scope"]["deploy"]:
        raise RuntimeError("release scope forbids push/merge/deploy")
    if manifest["scope"]["productionFlagsChanged"]:
        raise RuntimeError("production flag defaults must stay 0")

    for key in PHASE_KEYS:
        phase_sha = str(manifest["phaseCommits"][key]["sha"])
        phase_ancestor = subprocess.run(
            ["git", "merge-base", "--is-ancestor", phase_sha, candidate],
            cwd=repository,
            check=False,
        )
        if phase_ancestor.returncode != 0:
            raise RuntimeError(f"{key} commit is not an ancestor of the release candidate")

    artifacts = []
    for artifact in manifest["artifactPaths"]:
        raw_path = Path(str(artifact["path"]))
        path = raw_path if raw_path.is_absolute() else repository / raw_path
        if not path.is_file():
            raise RuntimeError(f"release artifact is missing: {path}")
        actual = _sha256(path)
        if actual != artifact["sha256"]:
            raise RuntimeError(f"release artifact hash mismatch: {path}")
        artifacts.append({"kind": artifact["kind"], "path": str(path), "sha256": actual})

    return {
        "schemaVersion": "candlescope.strategy-research-unification-verification/1",
        "status": "PASS",
        "candidateSha": candidate,
        "currentHead": head,
        "artifactCount": len(artifacts),
        "artifacts": artifacts,
        "libraryFlagsDefaultOff": True,
        "legacyWorktreePreserved": True,
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
