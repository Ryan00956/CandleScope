"""Publish the lightweight remote exact-aggTrade metadata index."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.remote_trade_archive import publish_remote_agg_trade_index  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build trade-index.json from immutable compatibility proofs."
    )
    parser.add_argument("--archive-dir", type=Path, required=True)
    args = parser.parse_args()
    index = publish_remote_agg_trade_index(args.archive_dir)
    print(json.dumps(index.to_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
