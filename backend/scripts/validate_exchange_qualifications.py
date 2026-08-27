"""Validate retained exchange evidence against the installed capability graph."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import ccxt  # noqa: E402

from app.data_engine.market_data.models import MarketChannel  # noqa: E402
from app.exchanges import bootstrap_default_adapters, get_exchange_registry  # noqa: E402
from app.exchanges.products import serialize_product_support  # noqa: E402
from app.exchanges.support import load_qualification_manifest  # noqa: E402


def validate() -> dict[str, Any]:
    manifest = load_qualification_manifest()
    expected_version = str(manifest["ccxt_version"])
    installed_version = str(ccxt.__version__)
    errors: list[str] = []
    if installed_version != expected_version:
        errors.append(
            f"installed ccxt {installed_version} invalidates evidence for {expected_version}",
        )

    bootstrap_default_adapters()
    registry = get_exchange_registry()
    validated: list[dict[str, Any]] = []
    for record in manifest["records"]:
        exchange = str(record["exchange"]).strip().lower()
        try:
            capabilities = registry.get_plugin(exchange).capabilities()
        except KeyError:
            errors.append(f"{exchange}: plugin is not registered")
            continue
        declared_markets = {
            str(item.market_type).strip().lower()
            for item in capabilities.markets
        }
        missing_markets = [
            value
            for value in record["market_types"]
            if str(value).strip().lower() not in declared_markets
        ]
        if missing_markets:
            errors.append(f"{record['evidence_id']}: missing markets {missing_markets}")
        missing_channels: list[str] = []
        for market_type in record["market_types"]:
            for channel_value in record["channels"]:
                try:
                    channel = MarketChannel(str(channel_value).strip().lower())
                except ValueError:
                    missing_channels.append(str(channel_value))
                    continue
                capability = capabilities.channel_capability(channel, market_type)
                if capability is None or not (capability.realtime or capability.history):
                    missing_channels.append(f"{market_type}:{channel.value}")
        if missing_channels:
            errors.append(
                f"{record['evidence_id']}: missing channels {sorted(set(missing_channels))}",
            )
        validated.append({
            "evidence_id": record["evidence_id"],
            "exchange": exchange,
            "level": record["level"],
            "markets": record["market_types"],
            "channels": record["channels"],
            "products": serialize_product_support(capabilities)["markets"],
        })

    return {
        "ok": not errors,
        "schema_version": manifest["schema_version"],
        "expected_ccxt_version": expected_version,
        "installed_ccxt_version": installed_version,
        "records": validated,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()
    report = validate()
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(
            f"qualification manifest: {'PASS' if report['ok'] else 'FAIL'}; "
            f"CCXT {report['installed_ccxt_version']}; "
            f"{len(report['records'])} records",
        )
        for error in report["errors"]:
            print(f"- {error}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
