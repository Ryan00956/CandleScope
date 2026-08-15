"""Verify a Python First N10 release manifest without enabling production."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.backtest.python_first_n10 import (  # noqa: E402
    PRODUCTION_FLAGS,
    VALIDATED_STATUS,
    enabled_production_flags,
    n10_status,
)

try:
    import jsonschema
except ImportError:  # pragma: no cover - validator is optional for local smoke
    jsonschema = None


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
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    if jsonschema is not None:
        jsonschema.Draft202012Validator(schema).validate(manifest)
    if (
        manifest.get("merged")
        or manifest.get("pushed")
        or manifest.get("productionEnabled")
    ):
        raise RuntimeError(
            "N10 manifest cannot claim merge, push, or production enablement"
        )
    flags = manifest.get("effectiveFlags") or {}
    missing = [name for name in PRODUCTION_FLAGS if name not in flags]
    enabled = enabled_production_flags(flags)
    if missing or enabled:
        raise RuntimeError(
            f"production flags incomplete or enabled: missing={missing}, enabled={enabled}"
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
        raw = Path(str(artifact["path"]))
        path = raw if raw.is_absolute() else repository / raw
        if not path.is_file():
            raise RuntimeError(f"release artifact is missing: {path}")
        actual = _sha256(path)
        if actual != artifact["sha256"]:
            raise RuntimeError(f"release artifact hash mismatch: {path}")
        artifacts.append(
            {"kind": artifact["kind"], "path": str(path), "sha256": actual}
        )
    head = _git("rev-parse", "HEAD", cwd=repository)
    return {
        "schemaVersion": "candlescope.python-first-release-verification/1",
        "status": "PASS",
        "manifestStatus": manifest["status"],
        "candidateSha": manifest["gitSha"],
        "currentHead": head,
        "artifactCount": len(artifacts),
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
