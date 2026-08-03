"""Repository entry point for legacy runtimes and explicit platform v2 plugins."""

from __future__ import annotations

import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["v2"]:
        from app.plugin_installer_v2.cli import main as platform_v2_main

        return platform_v2_main(arguments[1:])
    if arguments[:1] == ["v3"]:
        from app.plugin_github_import_v3.cli import main as platform_v3_main

        return platform_v3_main(arguments[1:])
    from app.plugin_runtime.installer_cli import main as legacy_main

    return legacy_main(arguments)


if __name__ == "__main__":
    raise SystemExit(main())
