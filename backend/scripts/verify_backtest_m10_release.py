from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

import jsonschema

PRODUCTION_FLAGS = {
    "BACKTEST_ENABLED",
    "BACKTEST_BAR_ENABLED",
    "BACKTEST_TRADE_TAPE_ENABLED",
    "BACKTEST_STUDY_ENABLED",
    "BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED",
    "BACKTEST_EXTERNAL_PROVIDER_ENABLED",
    "BACKTEST_BOOK_ASSISTED_ENABLED",
    "BACKTEST_MULTI_MARKET_ENABLED",
    "BACKTEST_ONLINE_LEARNING_ENABLED",
}


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


def verify(manifest_path: Path, schema_path: Path, repository: Path) -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    schema_path = schema_path.resolve()
    repository = repository.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(manifest)

    candidate = str(manifest["gitSha"])
    head = _git("rev-parse", "HEAD", cwd=repository)
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", candidate, head],
        cwd=repository,
        check=False,
    )
    if ancestor.returncode != 0:
        raise RuntimeError("manifest candidate SHA is not an ancestor of current HEAD")
    changed = (
        []
        if candidate == head
        else _git("diff", "--name-only", f"{candidate}..{head}", cwd=repository).splitlines()
    )
    forbidden = [path for path in changed if not path.startswith("docs/evidence/")]
    if forbidden:
        raise RuntimeError(
            f"code changed after clean candidate validation: {forbidden[:5]}"
        )

    flags = manifest["effectiveFlags"]
    missing_flags = sorted(PRODUCTION_FLAGS - set(flags))
    enabled_flags = sorted(name for name in PRODUCTION_FLAGS if flags.get(name) != "0")
    if missing_flags or enabled_flags:
        raise RuntimeError(
            f"production flags are incomplete or enabled: missing={missing_flags}, enabled={enabled_flags}"
        )
    verified_artifacts: list[dict[str, object]] = []
    for artifact in manifest["artifactPaths"]:
        raw_path = Path(str(artifact["path"]))
        path = raw_path if raw_path.is_absolute() else repository / raw_path
        if not path.is_file():
            raise RuntimeError(f"release artifact is missing: {path}")
        actual = _sha256(path)
        if actual != artifact["sha256"]:
            raise RuntimeError(f"release artifact hash mismatch: {path}")
        verified_artifacts.append(
            {"kind": artifact["kind"], "path": str(path), "sha256": actual}
        )
    return {
        "schemaVersion": "candlescope.backtest-release-verification/1",
        "status": "PASS",
        "candidateSha": candidate,
        "currentHead": head,
        "postCandidateChangedPaths": changed,
        "artifactCount": len(verified_artifacts),
        "artifacts": verified_artifacts,
        "allProductionFlagsDefaultOff": True,
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
