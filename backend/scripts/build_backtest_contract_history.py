"""Build one canonical offline contract-history bundle from operator-pinned files."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from app.market_dataset.adapters.contract_aux import (
    BUNDLE_SCHEMA,
    validate_contract_history,
)
from app.market_dataset.snapshot import canonical_json


def _rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"{path} has no header")
        return [dict(row) for row in reader]


def _integer(value: str, name: str) -> int:
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be integer milliseconds") from exc


def build(args: argparse.Namespace) -> dict[str, object]:
    mark_rows = _rows(args.mark_index_csv)
    funding_rows = _rows(args.funding_csv)
    rules = json.loads(args.rules_json.read_text(encoding="utf-8"))
    if not isinstance(rules, list):
        raise ValueError("rules JSON must be an array")
    provenance = {
        "provider": args.provider,
        "source_url": args.source_url,
        "capture_receipt": args.capture_receipt,
        "source_sha256": args.source_sha256,
    }
    payload = {
        "schema_version": BUNDLE_SCHEMA,
        "identity": {
            "venue": args.venue,
            "market_type": args.market_type,
            "symbol": args.symbol,
        },
        "roles": {
            "MARK_INDEX": {
                "cadence_ms": args.mark_cadence_ms,
                "retention_policy": args.retention_policy,
                "provenance": provenance,
                "records": [
                    {
                        "event_time_ms": _integer(
                            row["event_time_ms"], "event_time_ms"
                        ),
                        "mark_price": row["mark_price"],
                        "index_price": row["index_price"],
                    }
                    for row in mark_rows
                ],
            },
            "FUNDING": {
                "period_ms": args.funding_period_ms,
                "retention_policy": args.retention_policy,
                "provenance": provenance,
                "records": [
                    {
                        "settlement_time_ms": _integer(
                            row["settlement_time_ms"], "settlement_time_ms"
                        ),
                        "period_id": row["period_id"],
                        "funding_rate": row["funding_rate"],
                        "mark_price": row["mark_price"],
                    }
                    for row in funding_rows
                ],
            },
            "INSTRUMENT_RULES": {
                "retention_policy": args.retention_policy,
                "provenance": provenance,
                "records": rules,
            },
        },
    }
    descriptor = validate_contract_history(payload)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        canonical_json(descriptor.canonical_payload) + "\n", encoding="utf-8"
    )
    manifest_path = args.output.with_name("contract-history.manifest.json")
    manifest_path.write_text(
        json.dumps(descriptor.manifest, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    return {
        "output": str(args.output.resolve()),
        "manifest": str(manifest_path.resolve()),
        "bundle_hash": descriptor.bundle_hash,
        "role_hashes": dict(descriptor.role_hashes),
    }


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description=(
            "Build a local-only M3 contract bundle. The command never downloads data."
        )
    )
    value.add_argument("--mark-index-csv", type=Path, required=True)
    value.add_argument("--funding-csv", type=Path, required=True)
    value.add_argument("--rules-json", type=Path, required=True)
    value.add_argument("--output", type=Path, required=True)
    value.add_argument("--venue", required=True)
    value.add_argument("--market-type", required=True)
    value.add_argument("--symbol", required=True)
    value.add_argument("--mark-cadence-ms", type=int, required=True)
    value.add_argument("--funding-period-ms", type=int, required=True)
    value.add_argument("--provider", required=True)
    value.add_argument("--source-url", required=True)
    value.add_argument("--capture-receipt", required=True)
    value.add_argument("--source-sha256", required=True)
    value.add_argument("--retention-policy", default="user_local_immutable")
    return value


if __name__ == "__main__":
    print(json.dumps(build(parser().parse_args()), ensure_ascii=False, indent=2))
