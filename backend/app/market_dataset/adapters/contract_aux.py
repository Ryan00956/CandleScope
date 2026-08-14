"""Canonical offline MARK_INDEX, FUNDING and INSTRUMENT_RULES bundles."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Mapping, Sequence

from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import (
    MarketDatasetError,
    MarketDatasetSnapshot,
    MarketEvent,
    canonical_json,
    sha256_hex,
)

BUNDLE_SCHEMA = "candlescope.contract-history.v1"
MANIFEST_SCHEMA = "candlescope.contract-history.manifest.v1"
AUX_ROLES = ("MARK_INDEX", "FUNDING", "INSTRUMENT_RULES")
ROLE_PHASE = {"INSTRUMENT_RULES": 10, "MARK_INDEX": 20, "FUNDING": 30}


@dataclass(frozen=True, slots=True)
class ContractHistoryDescriptor:
    canonical_payload: Mapping[str, object]
    bundle_hash: str
    role_hashes: Mapping[str, str]
    role_quality: Mapping[str, Mapping[str, object]]
    events: tuple[MarketEvent, ...]
    identity: Mapping[str, str]
    manifest: Mapping[str, object]


def _fail(message: str, code: str = "DATA_QUALITY_FAILED") -> MarketDatasetError:
    return MarketDatasetError(message, code=code)


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _fail(f"{name} must be non-empty text")
    return value.strip()


def _integer(value: object, name: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _fail(f"{name} must be an integer")
    if value < (1 if positive else 0):
        raise _fail(f"{name} is outside its allowed range")
    return value


def _decimal(value: object, name: str, *, positive: bool = False) -> str:
    if isinstance(value, bool):
        raise _fail(f"{name} must be canonical Decimal text")
    text = str(value)
    try:
        number = Decimal(text)
    except (InvalidOperation, ValueError) as exc:
        raise _fail(f"{name} must be canonical Decimal text") from exc
    if not number.is_finite() or (positive and number <= 0):
        raise _fail(f"{name} is outside its allowed range")
    canonical = format(number, "f")
    if "." in canonical:
        canonical = canonical.rstrip("0").rstrip(".")
    canonical = "0" if canonical == "-0" else canonical
    if text != canonical:
        raise _fail(f"{name} must use canonical Decimal encoding")
    return canonical


def _role(
    value: object, name: str
) -> tuple[dict[str, object], list[Mapping[str, object]]]:
    if not isinstance(value, Mapping):
        raise _fail(f"{name} must be an object")
    provenance = value.get("provenance")
    records = value.get("records")
    if not isinstance(provenance, Mapping) or not provenance:
        raise _fail(f"{name}.provenance is required")
    if (
        not isinstance(records, list)
        or not records
        or not all(isinstance(row, Mapping) for row in records)
    ):
        raise _fail(f"{name}.records must be a non-empty array")
    return {
        "retention_policy": _text(
            value.get("retention_policy"), f"{name}.retention_policy"
        ),
        "provenance": dict(provenance),
    }, records  # type: ignore[return-value]


def _quality(
    coverage_start_ms: int,
    coverage_end_ms: int | None,
    rows: int,
    gaps: list[dict[str, int]],
    *,
    first_event_ms: int,
    last_event_ms: int,
) -> dict[str, object]:
    return {
        "status": "complete" if not gaps else "partial",
        "coverage_start_ms": coverage_start_ms,
        "coverage_end_ms": coverage_end_ms,
        "row_count": rows,
        "first_event_ms": first_event_ms,
        "last_event_ms": last_event_ms,
        "gap_count": len(gaps),
        "gaps": gaps,
        "duplicate_count": 0,
        "out_of_order_count": 0,
    }


def _normalize_mark(
    value: object,
) -> tuple[dict[str, object], list[dict[str, object]], dict[str, object]]:
    header, records = _role(value, "MARK_INDEX")
    cadence = _integer(value.get("cadence_ms"), "MARK_INDEX.cadence_ms", positive=True)  # type: ignore[union-attr]
    result: list[dict[str, object]] = []
    gaps: list[dict[str, int]] = []
    previous: int | None = None
    for row in records:
        if set(row) != {"event_time_ms", "mark_price", "index_price"}:
            raise _fail("MARK_INDEX record fields do not match v1")
        stamp = _integer(row["event_time_ms"], "MARK_INDEX.event_time_ms")
        if previous is not None:
            if stamp <= previous:
                raise _fail("MARK_INDEX time is duplicate or out-of-order")
            if stamp != previous + cadence:
                gaps.append({"start_ms": previous + cadence, "end_ms": stamp - 1})
        result.append(
            {
                "event_time_ms": stamp,
                "mark_price": _decimal(
                    row["mark_price"], "MARK_INDEX.mark_price", positive=True
                ),
                "index_price": _decimal(
                    row["index_price"], "MARK_INDEX.index_price", positive=True
                ),
            }
        )
        previous = stamp
    return (
        {**header, "cadence_ms": cadence},
        result,
        _quality(
            int(result[0]["event_time_ms"]),
            int(result[-1]["event_time_ms"]) + cadence - 1,
            len(result),
            gaps,
            first_event_ms=int(result[0]["event_time_ms"]),
            last_event_ms=int(result[-1]["event_time_ms"]),
        ),
    )


def _normalize_funding(
    value: object,
) -> tuple[dict[str, object], list[dict[str, object]], dict[str, object]]:
    header, records = _role(value, "FUNDING")
    period = _integer(value.get("period_ms"), "FUNDING.period_ms", positive=True)  # type: ignore[union-attr]
    tolerance = _integer(
        value.get("settlement_tolerance_ms", 1_000),  # type: ignore[union-attr]
        "FUNDING.settlement_tolerance_ms",
    )
    result: list[dict[str, object]] = []
    gaps: list[dict[str, int]] = []
    period_ids: set[str] = set()
    previous: int | None = None
    for row in records:
        if set(row) != {
            "settlement_time_ms",
            "period_id",
            "funding_rate",
            "mark_price",
        }:
            raise _fail("FUNDING record fields do not match v1")
        stamp = _integer(row["settlement_time_ms"], "FUNDING.settlement_time_ms")
        period_id = _text(row["period_id"], "FUNDING.period_id")
        rate = _decimal(row["funding_rate"], "FUNDING.funding_rate")
        if abs(Decimal(rate)) > 1:
            raise _fail("FUNDING rate is outside [-1, 1]")
        if period_id in period_ids or (previous is not None and stamp <= previous):
            raise _fail("FUNDING settlement or period is duplicated/out-of-order")
        if previous is not None and abs(stamp - previous - period) > tolerance:
            gaps.append(
                {
                    "start_ms": previous + period,
                    "end_ms": stamp - 1,
                }
            )
        period_ids.add(period_id)
        result.append(
            {
                "event_time_ms": stamp,
                "settlement_time_ms": stamp,
                "period_id": period_id,
                "funding_rate": rate,
                "mark_price": _decimal(
                    row["mark_price"], "FUNDING.mark_price", positive=True
                ),
            }
        )
        previous = stamp
    return (
        {
            **header,
            "period_ms": period,
            "settlement_tolerance_ms": tolerance,
        },
        result,
        _quality(
            int(result[0]["settlement_time_ms"]) - period,
            int(result[-1]["settlement_time_ms"]) + period - 1,
            len(result),
            gaps,
            first_event_ms=int(result[0]["settlement_time_ms"]),
            last_event_ms=int(result[-1]["settlement_time_ms"]),
        ),
    )


def _tier(value: object) -> dict[str, str]:
    fields = {
        "notional_floor",
        "notional_cap",
        "maintenance_rate",
        "maintenance_deduction",
    }
    if not isinstance(value, Mapping) or set(value) != fields:
        raise _fail("maintenance tier fields do not match v1")
    result = {
        "notional_floor": _decimal(value["notional_floor"], "tier.notional_floor"),
        "notional_cap": _decimal(
            value["notional_cap"], "tier.notional_cap", positive=True
        ),
        "maintenance_rate": _decimal(
            value["maintenance_rate"], "tier.maintenance_rate"
        ),
        "maintenance_deduction": _decimal(
            value["maintenance_deduction"], "tier.maintenance_deduction"
        ),
    }
    if (
        Decimal(result["notional_floor"]) < 0
        or not (0 <= Decimal(result["maintenance_rate"]) <= 1)
        or Decimal(result["maintenance_deduction"]) < 0
    ):
        raise _fail("maintenance tier value is outside its range")
    return result


def _normalize_rules(
    value: object,
) -> tuple[dict[str, object], list[dict[str, object]], dict[str, object]]:
    header, records = _role(value, "INSTRUMENT_RULES")
    fields = {
        "effective_from_ms",
        "effective_to_ms",
        "rule_version",
        "contract_multiplier",
        "price_tick",
        "quantity_step",
        "min_quantity",
        "max_quantity",
        "min_notional",
        "maintenance_tiers",
    }
    result: list[dict[str, object]] = []
    gaps: list[dict[str, int]] = []
    previous_end: int | None = None
    for index, row in enumerate(records):
        if set(row) != fields:
            raise _fail("INSTRUMENT_RULES record fields do not match v1")
        start = _integer(row["effective_from_ms"], "rules.effective_from_ms")
        end = (
            None
            if row["effective_to_ms"] is None
            else _integer(row["effective_to_ms"], "rules.effective_to_ms")
        )
        if end is not None and end < start:
            raise _fail("rule interval ends before it starts")
        if previous_end is not None:
            if start <= previous_end:
                raise _fail("rule timeline overlaps or backtracks")
            if start != previous_end + 1:
                gaps.append({"start_ms": previous_end + 1, "end_ms": start - 1})
        if end is None and index != len(records) - 1:
            raise _fail("open-ended rule must be last")
        raw_tiers = row["maintenance_tiers"]
        if not isinstance(raw_tiers, list) or not raw_tiers:
            raise _fail("maintenance_tiers must be non-empty")
        tiers = [_tier(item) for item in raw_tiers]
        expected_floor = Decimal(0)
        for tier in tiers:
            if (
                Decimal(tier["notional_floor"]) != expected_floor
                or Decimal(tier["notional_cap"]) <= expected_floor
            ):
                raise _fail("maintenance tiers overlap or contain a gap")
            expected_floor = Decimal(tier["notional_cap"])
        result.append(
            {
                "event_time_ms": start,
                "effective_from_ms": start,
                "effective_to_ms": end,
                "rule_version": _text(row["rule_version"], "rules.rule_version"),
                "contract_multiplier": _decimal(
                    row["contract_multiplier"],
                    "rules.contract_multiplier",
                    positive=True,
                ),
                "price_tick": _decimal(
                    row["price_tick"], "rules.price_tick", positive=True
                ),
                "quantity_step": _decimal(
                    row["quantity_step"], "rules.quantity_step", positive=True
                ),
                "min_quantity": _decimal(
                    row["min_quantity"], "rules.min_quantity", positive=True
                ),
                "max_quantity": _decimal(
                    row["max_quantity"], "rules.max_quantity", positive=True
                ),
                "min_notional": _decimal(
                    row["min_notional"], "rules.min_notional", positive=True
                ),
                "maintenance_tiers": tiers,
            }
        )
        previous_end = end
    return (
        header,
        result,
        _quality(
            int(result[0]["effective_from_ms"]),
            result[-1]["effective_to_ms"],
            len(result),
            gaps,
            first_event_ms=int(result[0]["effective_from_ms"]),
            last_event_ms=int(result[-1]["effective_from_ms"]),
        ),
    )  # type: ignore[arg-type]


def validate_contract_history(payload: object) -> ContractHistoryDescriptor:
    if not isinstance(payload, Mapping) or set(payload) != {
        "schema_version",
        "identity",
        "roles",
    }:
        raise _fail("contract bundle root fields do not match v1")
    if payload["schema_version"] != BUNDLE_SCHEMA:
        raise _fail("unsupported contract bundle schema")
    identity_raw = payload["identity"]
    if not isinstance(identity_raw, Mapping) or set(identity_raw) != {
        "venue",
        "market_type",
        "symbol",
    }:
        raise _fail("contract bundle identity fields do not match v1")
    identity = {
        name: _text(identity_raw[name], f"identity.{name}")
        for name in ("venue", "market_type", "symbol")
    }
    roles_raw = payload["roles"]
    if not isinstance(roles_raw, Mapping) or set(roles_raw) != set(AUX_ROLES):
        raise _fail(
            "contract bundle must contain all required roles", "DATA_ROLE_MISSING"
        )
    normalizers = {
        "MARK_INDEX": _normalize_mark,
        "FUNDING": _normalize_funding,
        "INSTRUMENT_RULES": _normalize_rules,
    }
    normalized_roles: dict[str, object] = {}
    role_hashes: dict[str, str] = {}
    qualities: dict[str, Mapping[str, object]] = {}
    staged_events: list[tuple[int, int, int, str, Mapping[str, object]]] = []
    for role in AUX_ROLES:
        header, rows, quality = normalizers[role](roles_raw[role])
        serialized_rows = [
            {
                key: item
                for key, item in row.items()
                if key != "event_time_ms" or role == "MARK_INDEX"
            }
            for row in rows
        ]
        role_payload = {
            **header,
            **(
                {"cadence_ms": roles_raw[role]["cadence_ms"]}
                if role == "MARK_INDEX"
                else {}
            ),
            **(
                {
                    "period_ms": roles_raw[role]["period_ms"],
                    "settlement_tolerance_ms": header["settlement_tolerance_ms"],
                }
                if role == "FUNDING"
                else {}
            ),
            "records": serialized_rows,
        }
        normalized_roles[role] = role_payload
        role_hashes[role] = f"sha256:{sha256_hex(role_payload)}"
        qualities[role] = {
            **quality,
            "content_hash": role_hashes[role],
            "retention_policy": header["retention_policy"],
            "provenance": header["provenance"],
        }
        for component, row in enumerate(rows, start=1):
            stamp = int(row["event_time_ms"])
            staged_events.append(
                (
                    stamp,
                    ROLE_PHASE[role],
                    component,
                    role,
                    {key: item for key, item in row.items() if key != "event_time_ms"},
                )
            )
    canonical_payload = {
        "schema_version": BUNDLE_SCHEMA,
        "identity": identity,
        "roles": normalized_roles,
    }
    bundle_hash = f"sha256:{sha256_hex(canonical_payload)}"
    ordered = sorted(staged_events, key=lambda item: (item[0], item[1], item[2]))
    events = tuple(
        MarketEvent(index, item[0], item[3], item[4])
        for index, item in enumerate(ordered, start=1)
    )
    manifest = {
        "schema_version": MANIFEST_SCHEMA,
        "bundle_hash": bundle_hash,
        "identity": identity,
        "roles": qualities,
        "same_timestamp_order": [
            "INSTRUMENT_RULES",
            "MARK_INDEX",
            "FUNDING",
            "MARKET_EVENT",
        ],
        "network_required_for_replay": False,
    }
    return ContractHistoryDescriptor(
        canonical_payload,
        bundle_hash,
        role_hashes,
        qualities,
        events,
        identity,
        manifest,
    )


def load_contract_history(path: Path) -> ContractHistoryDescriptor:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _fail("contract bundle is unreadable") from exc
    descriptor = validate_contract_history(payload)
    manifest_path = Path(path).with_name("contract-history.manifest.json")
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise _fail("contract manifest is unreadable") from exc
        if manifest != descriptor.manifest:
            raise _fail(
                "contract manifest checksum or quality changed",
                "DATA_SNAPSHOT_MISMATCH",
            )
    return descriptor


def write_contract_history(
    descriptor: ContractHistoryDescriptor, directory: Path
) -> None:
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "contract-history.json").write_text(
        canonical_json(descriptor.canonical_payload) + "\n", encoding="utf-8"
    )
    (directory / "contract-history.manifest.json").write_text(
        json.dumps(descriptor.manifest, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )


class ContractAuxSnapshotProvider:
    def __init__(self, path: Path | Sequence[Mapping[str, object]]) -> None:
        self._path = path

    def open(
        self,
        ref: DatasetRef,
        *,
        allow_incomplete: bool = False,
    ) -> MarketDatasetSnapshot:
        if not isinstance(self._path, Path):
            events = tuple(
                MarketEvent(
                    index,
                    int(item["event_time_ms"]),
                    str(item["role"]),
                    {
                        key: value
                        for key, value in item.items()
                        if key not in {"event_time_ms", "role"}
                    },
                )
                for index, item in enumerate(self._path, start=1)
                if str(item["role"]) in ref.roles
            )
            digest = f"sha256:{sha256_hex([event.payload for event in events])}"
            return MarketDatasetSnapshot(
                ref_identity={"dataset_id": ref.dataset_id, "roles": ref.roles},
                coverage_start_ms=events[0].event_time_ms,
                coverage_end_ms=events[-1].event_time_ms,
                events=events,
                role_hashes={"AUX": digest},
                quality={"status": "legacy_unversioned"},
                provenance={"source": ref.source},
                fidelity_capabilities=("BAR_APPROX", "TRADE_TAPE"),
                snapshot_hash=digest,
            )
        descriptor = load_contract_history(self._path)
        if (
            descriptor.identity["venue"],
            descriptor.identity["market_type"],
            descriptor.identity["symbol"],
        ) != (ref.venue, ref.market_type, ref.symbol):
            raise _fail("contract bundle identity does not match DatasetRef")
        requested = tuple(ref.roles) or AUX_ROLES
        unknown = [role for role in requested if role not in AUX_ROLES]
        if unknown:
            raise _fail(
                f"contract aux adapter cannot supply {unknown}", "FIDELITY_UNSUPPORTED"
            )
        missing: dict[str, list[dict[str, int]]] = {}
        role_status: dict[str, dict[str, object]] = {}
        for role in requested:
            quality = descriptor.role_quality[role]
            start = int(quality["coverage_start_ms"])
            end = (
                ref.end_time_ms
                if quality["coverage_end_ms"] is None
                else int(quality["coverage_end_ms"])
            )
            uncovered: list[dict[str, int]] = []
            if start > ref.start_time_ms:
                uncovered.append({"start_ms": ref.start_time_ms, "end_ms": start - 1})
            if end < ref.end_time_ms:
                uncovered.append({"start_ms": end + 1, "end_ms": ref.end_time_ms})
            uncovered.extend(
                dict(item)
                for item in quality["gaps"]
                if item["end_ms"] >= ref.start_time_ms
                and item["start_ms"] <= ref.end_time_ms
            )  # type: ignore[index]
            if uncovered:
                missing[role] = uncovered
            role_status[role] = {
                **descriptor.role_quality[role],
                "status": "partial" if uncovered else "complete",
                "missing_intervals": uncovered,
            }
        if missing and not allow_incomplete:
            raise _fail(
                f"contract roles do not cover requested window: {missing}",
                "DATA_ROLE_COVERAGE_MISSING",
            )
        selected_list = [
            event
            for event in descriptor.events
            if event.role in requested
            and ref.start_time_ms <= event.event_time_ms <= ref.end_time_ms
        ]
        if "INSTRUMENT_RULES" in requested and not any(
            event.role == "INSTRUMENT_RULES" for event in selected_list
        ):
            active_rules = [
                event
                for event in descriptor.events
                if event.role == "INSTRUMENT_RULES"
                and event.event_time_ms <= ref.start_time_ms
                and (
                    event.payload.get("effective_to_ms") is None
                    or int(event.payload["effective_to_ms"]) >= ref.start_time_ms
                )
            ]
            if active_rules:
                selected_list.append(active_rules[-1])
        selected_list.sort(
            key=lambda event: (
                event.event_time_ms,
                ROLE_PHASE[event.role],
                event.sequence,
            )
        )
        selected = tuple(
            MarketEvent(index, event.event_time_ms, event.role, event.payload)
            for index, event in enumerate(selected_list, start=1)
        )
        return MarketDatasetSnapshot(
            ref_identity={
                "dataset_id": ref.dataset_id,
                "data_epoch": ref.data_epoch,
                **descriptor.identity,
                "roles": requested,
                "bundle_hash": descriptor.bundle_hash,
            },
            coverage_start_ms=ref.start_time_ms,
            coverage_end_ms=ref.end_time_ms,
            events=selected,
            role_hashes={role: descriptor.role_hashes[role] for role in requested},
            quality={
                "status": "partial" if missing else "complete",
                "roles": role_status,
                "missing_intervals": missing,
            },
            provenance={
                role: descriptor.role_quality[role]["provenance"] for role in requested
            },
            fidelity_capabilities=("HISTORICAL_CONTRACT_V1",),
            snapshot_hash=descriptor.bundle_hash,
        )
