"""Stable source identity for manual-history release evidence.

Evidence may be captured before a release commit exists. In that case HEAD is
not sufficient: hash the manual-history release patch plus its untracked source
files, while excluding generated evidence and unrelated mixed-worktree edits.
"""

from __future__ import annotations

import hashlib
from fnmatch import fnmatch
import subprocess
from pathlib import Path
from typing import Any


_EVIDENCE_PREFIX = "docs/perf-baselines/manual-history/"
_RELEASE_PATHS = (
    "backend/app/api/v1/manual_history.py",
    "backend/app/core/config.py",
    "backend/app/data_engine/backfill/reconciler.py",
    "backend/app/data_engine/data_manager/manager.py",
    "backend/app/data_engine/manual_history/**",
    "backend/app/data_engine/runtime.py",
    "backend/scripts/manual_history_*.py",
    "backend/tests/test_manual_history_*.py",
    "backend/tests/test_settings_api.py",
    "docs/MANUAL_HISTORY_DOWNLOAD_EXECUTION_zh.md",
    "frontend/src/features/data-workbench/ManualHistoryDownloadPanel.tsx",
    "frontend/src/features/data-workbench/manualHistory*.ts",
    "frontend/src/services/manualHistoryApi.ts",
)


def _in_release_scope(relative: str) -> bool:
    normalized = relative.replace("\\", "/")
    return any(fnmatch(normalized, pattern) for pattern in _RELEASE_PATHS)


def _git(root: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        check=False,
    )


def build_source_identity(repository_root: Path) -> dict[str, Any]:
    root = repository_root.resolve()
    head = _git(root, "rev-parse", "HEAD")
    if head.returncode != 0:
        raise RuntimeError(head.stderr.decode("utf-8", errors="replace"))

    diff = _git(root, "diff", "--binary", "HEAD", "--", *_RELEASE_PATHS)
    names = _git(root, "diff", "--name-only", "HEAD", "--", *_RELEASE_PATHS)
    untracked = _git(root, "ls-files", "--others", "--exclude-standard")
    for result in (diff, names, untracked):
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))

    tracked_files = [
        item for item in names.stdout.decode("utf-8").splitlines() if item
    ]
    untracked_files = [
        item
        for item in untracked.stdout.decode("utf-8").splitlines()
        if item
        and not item.replace("\\", "/").startswith(_EVIDENCE_PREFIX)
        and _in_release_scope(item)
    ]
    digest = hashlib.sha256()
    digest.update(diff.stdout)
    for relative in sorted(untracked_files):
        digest.update(b"\0untracked\0")
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update((root / relative).read_bytes())
    source_files = sorted(set(tracked_files + untracked_files))
    return {
        "git_commit": head.stdout.decode("ascii").strip(),
        "worktree_dirty": bool(source_files),
        "worktree_sha256": digest.hexdigest(),
        "worktree_files": source_files,
        "generated_evidence_excluded": _EVIDENCE_PREFIX,
        "release_scope": list(_RELEASE_PATHS),
    }
