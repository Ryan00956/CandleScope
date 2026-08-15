"""Verified Python First schema rollback: v6 -> v5 -> v4.

M10 rollback stays exact-v5. This orchestrator first drops empty Python bundle
tables, then reuses the frozen M10 v5->v4 path.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "backend" / "scripts"))

from app.backtest.python_bundle_rollback import rollback_python_bundles  # noqa: E402
from rollback_backtest_m10_schema import rollback as rollback_m10  # noqa: E402


def rollback(database: Path, backup: Path, receipt_path: Path) -> dict[str, object]:
    v5 = rollback_python_bundles(database)
    receipt = rollback_m10(database, backup, receipt_path)
    receipt["pythonBundleRollback"] = v5
    receipt["sourceSchemaVersion"] = 6
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verified Python First N10 schema rollback"
    )
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args()
    if args.confirm != "ROLLBACK_N10_SCHEMA_TO_V4":
        raise RuntimeError("explicit ROLLBACK_N10_SCHEMA_TO_V4 confirmation required")
    rollback(args.database, args.backup, args.receipt)


if __name__ == "__main__":
    main()
