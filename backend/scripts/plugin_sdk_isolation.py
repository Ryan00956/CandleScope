"""Pin this worktree's Plugin SDK so tests never import a sibling copy."""

from __future__ import annotations

import sys
from pathlib import Path


SCRIPTS_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = SCRIPTS_ROOT.parent
REPOSITORY_ROOT = BACKEND_ROOT.parent
SDK_SOURCE = (REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src").resolve()


def pin_in_repo_plugin_sdk(*extra_paths: str | Path) -> Path:
    """Force ``sys.path`` and ``sys.modules`` onto this repository's SDK.

    Sibling CandleScope worktrees may already have ``candlescope_plugin_sdk``
    installed or earlier on ``PYTHONPATH``. Contract gates must hash *this*
    tree's schema, not another worktree's drifted or older copy.
    """

    pinned = [SDK_SOURCE, *[Path(path).resolve() for path in extra_paths]]
    pinned_set = set(pinned)
    remainder: list[str] = []
    for item in sys.path:
        if not item:
            remainder.append(item)
            continue
        try:
            resolved = Path(item).resolve()
        except OSError:
            remainder.append(item)
            continue
        if resolved not in pinned_set:
            remainder.append(item)
    sys.path[:] = [str(path) for path in pinned] + remainder

    for name in list(sys.modules):
        if name != "candlescope_plugin_sdk" and not name.startswith(
            "candlescope_plugin_sdk."
        ):
            continue
        module = sys.modules.get(name)
        origin = getattr(module, "__file__", None)
        if not origin:
            sys.modules.pop(name, None)
            continue
        try:
            file_path = Path(origin).resolve()
        except OSError:
            sys.modules.pop(name, None)
            continue
        if SDK_SOURCE not in file_path.parents and file_path.parent != SDK_SOURCE:
            sys.modules.pop(name, None)
    return SDK_SOURCE
