from __future__ import annotations

import json
from pathlib import Path

from app.local_data.service import LocalDatasetError, LocalDatasetService
from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import (
    MarketDatasetError,
    MarketDatasetSnapshot,
    MarketEvent,
    sha256_hex,
)

LOCAL_BAR_ROLES = frozenset({"BARS", "INSTRUMENT_RULES"})
UNMODELED_RULES = {
    "price_tick": "UNMODELED",
    "qty_step": "UNMODELED",
    "min_notional": "UNMODELED",
    "contract_multiplier": "1",
    "account_model": "LINEAR_PERP_ONE_WAY_V1",
}


class LocalBarSnapshotProvider:
    """Read-only adapter from an immutable local BAR revision."""

    def __init__(self, service: LocalDatasetService) -> None:
        self._service = service

    def open(self, ref: DatasetRef) -> MarketDatasetSnapshot:
        requested = tuple(ref.roles) or ("BARS", "INSTRUMENT_RULES")
        unknown = [role for role in requested if role not in LOCAL_BAR_ROLES]
        if unknown:
            raise MarketDatasetError(
                f"local BAR adapter cannot supply {unknown}",
                code="FIDELITY_UNSUPPORTED",
            )
        try:
            manifest, bars = self._service.load_canonical_bars(
                ref.dataset_id,
                data_epoch=ref.data_epoch,
                max_rows=200_000,
                interval=ref.interval,
            )
        except LocalDatasetError as exc:
            raise MarketDatasetError(str(exc), code=exc.code) from exc
        if manifest["symbol"] != ref.symbol:
            raise MarketDatasetError(
                "Dataset symbol does not match DatasetRef",
                code="DATA_QUALITY_FAILED",
            )

        selected: list[MarketEvent] = []
        for index, row in enumerate(bars, start=1):
            open_ms = int(row["open_time_ms"])
            close_ms = int(row["close_time_ms"])
            if close_ms < ref.start_time_ms or open_ms > ref.end_time_ms:
                continue
            selected.append(
                MarketEvent(
                    sequence=index,
                    event_time_ms=close_ms,
                    role="BARS",
                    payload={
                        "open_time_ms": open_ms,
                        "close_time_ms": close_ms,
                        "open": row["open"],
                        "high": row["high"],
                        "low": row["low"],
                        "close": row["close"],
                        "volume": row["volume"],
                    },
                )
            )

        quality = self._quality(ref, manifest)
        rules_hash = sha256_hex(UNMODELED_RULES)
        bars_hash = sha256_hex([event.payload for event in selected])
        role_hashes = {"BARS": f"sha256:{bars_hash}"}
        if "INSTRUMENT_RULES" in requested:
            role_hashes["INSTRUMENT_RULES"] = f"sha256:{rules_hash}"
        snapshot_hash = sha256_hex(
            {
                "dataset_id": ref.dataset_id,
                "data_epoch": ref.data_epoch,
                "interval": ref.interval or manifest["interval"],
                "start_time_ms": ref.start_time_ms,
                "end_time_ms": ref.end_time_ms,
                "roles": requested,
                "role_hashes": role_hashes,
            }
        )
        if ref.snapshot_hash and ref.snapshot_hash not in {
            snapshot_hash,
            f"sha256:{snapshot_hash}",
        }:
            raise MarketDatasetError(
                "Declared snapshot hash does not match content",
                code="DATA_SNAPSHOT_MISMATCH",
            )
        return MarketDatasetSnapshot(
            ref_identity={
                "dataset_id": ref.dataset_id,
                "data_epoch": ref.data_epoch,
                "venue": ref.venue,
                "market_type": ref.market_type,
                "symbol": ref.symbol,
                "interval": ref.interval or manifest["interval"],
            },
            coverage_start_ms=selected[0].payload["open_time_ms"] if selected else ref.start_time_ms,
            coverage_end_ms=selected[-1].payload["close_time_ms"] if selected else ref.end_time_ms,
            events=tuple(selected),
            role_hashes=role_hashes,
            quality=quality,
            provenance={
                "source": ref.source,
                "retention_policy": ref.retention_policy,
                "calendar_id": ref.calendar_id,
                "local_data_epoch": manifest["data_epoch"],
                "rows": manifest["rows"],
            },
            fidelity_capabilities=("BAR_APPROX",),
            snapshot_hash=f"sha256:{snapshot_hash}",
        )

    def _quality(self, ref: DatasetRef, manifest: dict) -> dict:
        revision = ref.data_epoch.removeprefix("sha256:")
        path = Path(self._service.root) / ref.dataset_id / revision / "quality-report.json"
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            report = {"status": "unknown"}
        return {
            "status": report.get("status"),
            "gap_count": manifest.get("excluded_range_count", 0),
            "duplicate_count": 0,
            "out_of_order_count": 0,
            "invalid_row_count": 0,
            "volume_available": manifest.get("volume_available"),
            "excluded_ranges": report.get("excluded_ranges", []),
        }
