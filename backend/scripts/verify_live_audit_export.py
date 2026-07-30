"""Verify a redacted Phase 11B WP-E Live audit export offline."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
for source_root in (BACKEND_ROOT, SDK_SOURCE):
    source = str(source_root)
    if source not in sys.path:
        sys.path.insert(0, source)

from app.plugin_host.framing import strict_json_loads  # noqa: E402
from app.plugin_live_v2 import (  # noqa: E402
    LiveAuditExportError,
    verify_live_audit_export,
)


MAX_EXPORT_BYTES = 16 * 1024 * 1024


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("export", type=Path)
    arguments = parser.parse_args(argv)
    path = arguments.export.expanduser().resolve(strict=True)
    payload = path.read_bytes()
    if not payload or len(payload) > MAX_EXPORT_BYTES:
        print("LIVE_AUDIT_EXPORT_SIZE_INVALID", file=sys.stderr)
        return 2
    try:
        value = strict_json_loads(payload, max_message_bytes=MAX_EXPORT_BYTES)
        verified = verify_live_audit_export(value)
    except (LiveAuditExportError, ValueError) as exc:
        print(
            f"LIVE_AUDIT_EXPORT_INVALID: {exc}",
            file=sys.stderr,
        )
        return 2
    print(
        "LIVE_AUDIT_EXPORT_OK "
        f"control={verified['controlHead']['sequence']} "
        f"shadow={verified['shadowHead']['sequence']} "
        f"digest={verified['exportSha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
