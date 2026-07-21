"""Module entry point used by the managed plugin host."""

from __future__ import annotations

from candlescope_plugin_sdk import serve_runtime

from .runtime import PineCompatRuntimePlugin


def main() -> int:
    return serve_runtime(PineCompatRuntimePlugin())


if __name__ == "__main__":
    raise SystemExit(main())
