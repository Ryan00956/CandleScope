from __future__ import annotations

import json
from pathlib import Path

from app.data_engine.interval_policy import parse_interval_spec
from app.local_data.service import LocalDatasetError, LocalDatasetService
from app.market_dataset.models import DatasetRef
from app.market_dataset.adapters.contract_aux import (
    AUX_ROLES,
    ContractAuxSnapshotProvider,
)
from app.market_dataset.snapshot import (
    MarketDatasetError,
    MarketDatasetSnapshot,
    MarketEvent,
    sha256_hex,
)

LOCAL_BAR_ROLES = frozenset({"BARS", *AUX_ROLES})
UNMODELED_RULES = {
    "price_tick": "UNMODELED",
    "qty_step": "UNMODELED",
    "min_notional": "UNMODELED",
    "contract_multiplier": "1",
    "account_model": "LINEAR_PERP_ONE_WAY_V1",
}


class LocalBarSnapshotProvider:
    """Read-only adapter from an immutable local BAR revision."""

    def __init__(
        self, service: LocalDatasetService, *, max_rows: int = 200_000
    ) -> None:
        self._service = service
        self._max_rows = int(max_rows)

    def open(
        self,
        ref: DatasetRef,
        *,
        allow_incomplete_contract: bool = False,
    ) -> MarketDatasetSnapshot:
        requested = tuple(ref.roles) or ("BARS",)
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
                max_rows=self._max_rows,
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
        interval = parse_interval_spec(str(ref.interval or manifest["interval"]))
        if interval is None:
            raise MarketDatasetError("invalid BAR interval", code="DATA_QUALITY_FAILED")
        sequence = 0
        previous_open_ms: int | None = None
        for row in bars:
            open_ms = int(row["open_time_ms"])
            close_ms = int(row["close_time_ms"])
            if close_ms < ref.start_time_ms or open_ms > ref.end_time_ms:
                continue
            sequence += (
                1
                if previous_open_ms is None
                or interval.is_successor(previous_open_ms, open_ms)
                else 2
            )
            selected.append(
                MarketEvent(
                    sequence=sequence,
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
            previous_open_ms = open_ms

        quality = self._quality(ref, manifest)
        bars_hash = sha256_hex([event.payload for event in selected])
        role_hashes = {"BARS": f"sha256:{bars_hash}"}
        contract_events: tuple[MarketEvent, ...] = ()
        contract_roles = tuple(role for role in requested if role in AUX_ROLES)
        contract_path = (
            Path(self._service.root)
            / ref.dataset_id
            / ref.data_epoch.removeprefix("sha256:")
            / "contract-history.json"
        )
        legacy_rules = (
            contract_roles == ("INSTRUMENT_RULES",) and not contract_path.exists()
        )
        if legacy_rules:
            role_hashes["INSTRUMENT_RULES"] = f"sha256:{sha256_hex(UNMODELED_RULES)}"
            quality["contract_data"] = {
                "status": "not_required",
                "required_roles": [],
                "role_status": {"INSTRUMENT_RULES": {"status": "legacy_unmodeled"}},
            }
        elif contract_roles and contract_path.exists():
            aux_ref = DatasetRef(
                dataset_id=ref.dataset_id,
                data_epoch=ref.data_epoch,
                snapshot_hash="",
                venue=ref.venue,
                market_type=ref.market_type,
                symbol=ref.symbol,
                start_time_ms=ref.start_time_ms,
                end_time_ms=ref.end_time_ms,
                roles=contract_roles,
                interval=None,
                calendar_id=ref.calendar_id,
                source=ref.source,
                retention_policy=ref.retention_policy,
            )
            try:
                aux = ContractAuxSnapshotProvider(contract_path).open(
                    aux_ref,
                    allow_incomplete=allow_incomplete_contract,
                )
            except MarketDatasetError:
                if not allow_incomplete_contract:
                    raise
                quality["contract_data"] = {
                    "status": "partial",
                    "required_roles": list(contract_roles),
                    "role_status": {
                        role: {"status": "partial"} for role in contract_roles
                    },
                }
            else:
                contract_events = aux.events
                role_hashes.update(aux.role_hashes)
                quality["contract_data"] = {
                    "status": aux.quality["status"],
                    "required_roles": list(contract_roles),
                    "role_status": aux.quality["roles"],
                    "missing_intervals": aux.quality["missing_intervals"],
                    "bundle_hash": aux.snapshot_hash,
                }
        elif contract_roles:
            quality["contract_data"] = {
                "status": "missing",
                "required_roles": list(contract_roles),
                "role_status": {
                    role: {
                        "status": "missing",
                        "missing_intervals": [
                            {"start_ms": ref.start_time_ms, "end_ms": ref.end_time_ms}
                        ],
                    }
                    for role in contract_roles
                },
            }
            if not allow_incomplete_contract:
                raise MarketDatasetError(
                    "historical contract roles are missing",
                    code="DATA_ROLE_MISSING",
                )
        else:
            quality["contract_data"] = {
                "status": "not_required",
                "required_roles": [],
                "role_status": {},
            }
        market_events = tuple(selected)
        if contract_events:
            combined = [*contract_events, *market_events]
            combined.sort(
                key=lambda event: (
                    event.event_time_ms,
                    {
                        "INSTRUMENT_RULES": 10,
                        "MARK_INDEX": 20,
                        "FUNDING": 30,
                        "BARS": 40,
                    }.get(event.role, 99),
                    event.sequence,
                )
            )
            events = tuple(
                MarketEvent(index, event.event_time_ms, event.role, event.payload)
                for index, event in enumerate(combined, start=1)
            )
        else:
            events = market_events
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
            coverage_start_ms=selected[0].payload["open_time_ms"]
            if selected
            else ref.start_time_ms,
            coverage_end_ms=selected[-1].payload["close_time_ms"]
            if selected
            else ref.end_time_ms,
            events=events,
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
        path = (
            Path(self._service.root) / ref.dataset_id / revision / "quality-report.json"
        )
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
