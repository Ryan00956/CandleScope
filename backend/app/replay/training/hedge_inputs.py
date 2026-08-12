"""Pinned public and materialized simulation inputs for replay.v3 HEDGE runs."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sqlite3
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from pathlib import Path

from app.replay.broker.models import canonical_decimal
from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.models import validate_identifier, validate_timestamp_ms
from app.replay.storage import ReplaySQLiteStore

from .account import MaintenanceTier, instrument_rule_from_broker_config
from .errors import TrainingRunError
from .hedge_simulation_contract import (
    MODEL_VERSION,
    SIMULATION_MANIFEST_SCHEMA_VERSION,
    contract_hash,
    validate_simulation_manifest,
)
from .historical_book import PreparedHistoricalBookBinding
from .models import (
    REPLAY_HEDGE_PUBLIC_HISTORY_REF_SCHEMA_VERSION,
    REPLAY_HEDGE_SIMULATION_MANIFEST_REF_SCHEMA_VERSION,
    TrainingRunCreateRequest,
)


PUBLIC_ARCHIVE_PROTOCOL = "replay.hedge-public-history.archive.v1"
PUBLIC_ARCHIVE_SCHEMA_VERSION = "replay.hedge-public-history.v1"
PUBLIC_EVENT_SCHEMA_VERSION = "replay.hedge-public-history.event.v1"
SIMULATION_EVENT_SCHEMA_VERSION = "replay.hedge-simulation-input.event.v1"
HEDGE_INPUT_PROOF_SCHEMA_VERSION = "replay.hedge-input-binding.v1"
HEDGE_INPUT_AUDIT_SCHEMA_VERSION = "replay.hedge-input-audit.v1"
PUBLIC_INPUT_FIDELITY = "PINNED_HISTORICAL_PUBLIC_INPUT"
HYBRID_PUBLIC_INPUT_FIDELITY = "VERSIONED_HYBRID_PUBLIC_INPUT"
SIMULATION_INPUT_FIDELITY = "VERSIONED_DETERMINISTIC_SIMULATION"
HYBRID_PUBLIC_SOURCE_IDENTITY = "LOCAL_REVEALED_PRICE_PROXY_V1"
HYBRID_MARK_FIDELITY = "REVEALED_BAR_OR_TAPE_PRICE_PROXY"
HYBRID_RULE_FIDELITY = "VERSIONED_APPROXIMATE_INSTRUMENT_RULE"
HYBRID_FEE_FIDELITY = "CONFIGURED_RUN_FEE_POLICY"
_ROOT_HASH = "sha256:" + "0" * 64
_DIGEST_LENGTH = 71
_NO_HISTORICAL_L2_ARCHIVE_ID = "no-historical-l2"

_PUBLIC_PHASES = {
    "RULE": 10,
    "FEE_POLICY": 10,
    "MARK_INDEX": 30,
    "FUNDING": 40,
}
_PUBLIC_KINDS = frozenset(_PUBLIC_PHASES)
_PUBLIC_ROOT_KEYS = frozenset(
    {
        "schema_version",
        "archive_id",
        "exchange",
        "market_type",
        "symbol",
        "settlement_asset",
        "range_start_ms",
        "range_end_ms",
        "max_mark_gap_ms",
        "source_identity",
        "capture_receipt",
        "historical_l2_ref",
        "events",
        "dataset_epoch",
        "event_chain_tail",
        "proof_hash",
    }
)
_RULE_KEYS = frozenset(
    {
        "rule_version",
        "price_tick",
        "quantity_step",
        "min_quantity",
        "max_quantity",
        "min_notional",
        "max_notional",
        "quote_step",
        "contract_size",
        "max_leverage",
        "liquidation_fee_bps",
        "maintenance_tiers",
    }
)
_FEE_KEYS = frozenset(
    {
        "policy_version",
        "account_tier",
        "maker_fee_bps",
        "taker_fee_bps",
        "liquidation_fee_bps",
    }
)


def _digest(value: object, field_name: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != _DIGEST_LENGTH
        or not value.startswith("sha256:")
    ):
        raise ValueError(f"{field_name} must be a sha256 digest")
    try:
        int(value[7:], 16)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a sha256 digest") from exc
    if value != value.lower():
        raise ValueError(f"{field_name} must use lowercase hexadecimal")
    return value


def _digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _counter(value: object, field_name: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    if value < (1 if positive else 0):
        raise ValueError(f"{field_name} is outside its allowed range")
    return value


def _canonical_decimal(
    value: object,
    field_name: str,
    *,
    positive: bool = False,
    nonnegative: bool = False,
) -> str:
    result = canonical_decimal(
        value,
        field_name=field_name,
        positive=positive,
        nonnegative=nonnegative,
    )
    if result != value:
        raise ValueError(f"{field_name} must use canonical Decimal encoding")
    return result


def _identity(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    return value.strip()


def _l2_ref(value: object) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != {
        "archive_id",
        "dataset_epoch",
        "checksum_sha256",
    }:
        raise ValueError("historical_l2_ref fields do not match the v1 contract")
    return {
        "archive_id": validate_identifier(
            value["archive_id"], field_name="historical_l2_ref.archive_id"
        ),
        "dataset_epoch": _digest(
            value["dataset_epoch"], "historical_l2_ref.dataset_epoch"
        ),
        "checksum_sha256": _digest(
            value["checksum_sha256"], "historical_l2_ref.checksum_sha256"
        ),
    }


def _rule_payload(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping) or set(value) != _RULE_KEYS:
        raise ValueError("RULE payload fields do not match the v1 contract")
    tiers = value["maintenance_tiers"]
    if not isinstance(tiers, list) or not tiers:
        raise ValueError("RULE maintenance_tiers must be a non-empty array")
    normalized_tiers = [MaintenanceTier.from_mapping(item).to_dict() for item in tiers]
    if canonical_json(normalized_tiers) != canonical_json(tiers):
        raise ValueError("RULE maintenance_tiers must use canonical values")
    rule_version = validate_identifier(
        value["rule_version"], field_name="rule.rule_version"
    )
    return {
        "rule_version": rule_version,
        "price_tick": _canonical_decimal(
            value["price_tick"], "rule.price_tick", positive=True
        ),
        "quantity_step": _canonical_decimal(
            value["quantity_step"], "rule.quantity_step", positive=True
        ),
        "min_quantity": _canonical_decimal(
            value["min_quantity"], "rule.min_quantity", positive=True
        ),
        "max_quantity": _canonical_decimal(
            value["max_quantity"], "rule.max_quantity", positive=True
        ),
        "min_notional": _canonical_decimal(
            value["min_notional"], "rule.min_notional", positive=True
        ),
        "max_notional": _canonical_decimal(
            value["max_notional"], "rule.max_notional", positive=True
        ),
        "quote_step": _canonical_decimal(
            value["quote_step"], "rule.quote_step", positive=True
        ),
        "contract_size": _canonical_decimal(
            value["contract_size"], "rule.contract_size", positive=True
        ),
        "max_leverage": _canonical_decimal(
            value["max_leverage"], "rule.max_leverage", positive=True
        ),
        "liquidation_fee_bps": _canonical_decimal(
            value["liquidation_fee_bps"],
            "rule.liquidation_fee_bps",
            nonnegative=True,
        ),
        "maintenance_tiers": normalized_tiers,
    }


def _fee_payload(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping) or set(value) != _FEE_KEYS:
        raise ValueError("FEE_POLICY payload fields do not match the v1 contract")
    return {
        "policy_version": validate_identifier(
            value["policy_version"], field_name="fee.policy_version"
        ),
        "account_tier": validate_identifier(
            value["account_tier"], field_name="fee.account_tier"
        ),
        "maker_fee_bps": _canonical_decimal(
            value["maker_fee_bps"], "fee.maker_fee_bps", nonnegative=True
        ),
        "taker_fee_bps": _canonical_decimal(
            value["taker_fee_bps"], "fee.taker_fee_bps", nonnegative=True
        ),
        "liquidation_fee_bps": _canonical_decimal(
            value["liquidation_fee_bps"],
            "fee.liquidation_fee_bps",
            nonnegative=True,
        ),
    }


def _public_component(kind: str, value: object) -> dict[str, object]:
    if kind == "RULE":
        return _rule_payload(value)
    if kind == "FEE_POLICY":
        return _fee_payload(value)
    if kind == "MARK_INDEX":
        if not isinstance(value, Mapping) or set(value) != {
            "mark_price",
            "index_price",
        }:
            raise ValueError("MARK_INDEX payload fields do not match the v1 contract")
        return {
            "mark_price": _canonical_decimal(
                value["mark_price"], "mark.mark_price", positive=True
            ),
            "index_price": _canonical_decimal(
                value["index_price"], "mark.index_price", positive=True
            ),
        }
    if kind == "FUNDING":
        if not isinstance(value, Mapping) or set(value) != {
            "funding_rate",
            "mark_price",
        }:
            raise ValueError("FUNDING payload fields do not match the v1 contract")
        return {
            "funding_rate": _canonical_decimal(
                value["funding_rate"], "funding.funding_rate"
            ),
            "mark_price": _canonical_decimal(
                value["mark_price"], "funding.mark_price", positive=True
            ),
        }
    raise ValueError("public event kind is unsupported")


def _public_dataset_payload(payload: Mapping[str, object]) -> dict[str, object]:
    events = payload["events"]
    if not isinstance(events, list):
        raise TypeError("public events must be an array")
    return {
        "schema_version": PUBLIC_ARCHIVE_SCHEMA_VERSION,
        "archive_id": payload["archive_id"],
        "exchange": payload["exchange"],
        "market_type": payload["market_type"],
        "symbol": payload["symbol"],
        "settlement_asset": payload["settlement_asset"],
        "range_start_ms": payload["range_start_ms"],
        "range_end_ms": payload["range_end_ms"],
        "max_mark_gap_ms": payload["max_mark_gap_ms"],
        "source_identity": payload["source_identity"],
        "capture_receipt": payload["capture_receipt"],
        "historical_l2_ref": payload["historical_l2_ref"],
        "events": [
            {
                "sequence": event["sequence"],
                "event_time_ms": event["event_time_ms"],
                "event_phase": event["event_phase"],
                "event_kind": event["event_kind"],
                "component_sequence": event["component_sequence"],
                "payload": event["payload"],
            }
            for event in events
        ],
    }


def _public_root_hash(*, archive_id: str, dataset_epoch: str) -> str:
    return canonical_sha256(
        {
            "protocol": PUBLIC_ARCHIVE_PROTOCOL,
            "archive_id": archive_id,
            "dataset_epoch": dataset_epoch,
        }
    )


def _public_event_hash(
    *, archive_id: str, dataset_epoch: str, event: Mapping[str, object]
) -> str:
    return canonical_sha256(
        {
            "schema_version": PUBLIC_EVENT_SCHEMA_VERSION,
            "archive_id": archive_id,
            "dataset_epoch": dataset_epoch,
            "sequence": event["sequence"],
            "event_time_ms": event["event_time_ms"],
            "event_phase": event["event_phase"],
            "event_kind": event["event_kind"],
            "component_sequence": event["component_sequence"],
            "payload": event["payload"],
            "previous_hash": event["previous_hash"],
        }
    )


def build_hedge_public_history_archive(
    path: Path,
    *,
    archive_id: str,
    exchange: str,
    market_type: str,
    symbol: str,
    settlement_asset: str,
    range_start_ms: int,
    range_end_ms: int,
    max_mark_gap_ms: int,
    source_identity: str,
    capture_receipt: str,
    historical_l2_ref: Mapping[str, object] | None,
    events: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    """Build a canonical operator-importable public input archive."""

    normalized_events: list[dict[str, object]] = []
    component_sequences = {kind: 0 for kind in _PUBLIC_KINDS}
    for sequence, raw in enumerate(events, start=1):
        if set(raw) != {"event_time_ms", "event_kind", "payload"}:
            raise ValueError("builder event fields do not match the v1 contract")
        kind = str(raw["event_kind"])
        if kind not in _PUBLIC_KINDS:
            raise ValueError("builder event kind is unsupported")
        component_sequences[kind] += 1
        normalized_events.append(
            {
                "sequence": sequence,
                "event_time_ms": validate_timestamp_ms(
                    raw["event_time_ms"], field_name="event_time_ms"
                ),
                "event_phase": _PUBLIC_PHASES[kind],
                "event_kind": kind,
                "component_sequence": component_sequences[kind],
                "payload": _public_component(kind, raw["payload"]),
            }
        )
    payload: dict[str, object] = {
        "schema_version": PUBLIC_ARCHIVE_SCHEMA_VERSION,
        "archive_id": validate_identifier(archive_id, field_name="archive_id"),
        "exchange": _identity(exchange, "exchange"),
        "market_type": _identity(market_type, "market_type"),
        "symbol": _identity(symbol, "symbol"),
        "settlement_asset": _identity(settlement_asset, "settlement_asset"),
        "range_start_ms": _counter(range_start_ms, "range_start_ms"),
        "range_end_ms": _counter(range_end_ms, "range_end_ms"),
        "max_mark_gap_ms": _counter(max_mark_gap_ms, "max_mark_gap_ms", positive=True),
        "source_identity": _identity(source_identity, "source_identity"),
        "capture_receipt": _identity(capture_receipt, "capture_receipt"),
        "historical_l2_ref": _l2_ref(historical_l2_ref),
        "events": normalized_events,
    }
    dataset_epoch = canonical_sha256(_public_dataset_payload(payload))
    previous_hash = _public_root_hash(
        archive_id=str(payload["archive_id"]), dataset_epoch=dataset_epoch
    )
    for event in normalized_events:
        event["previous_hash"] = previous_hash
        event["event_hash"] = _public_event_hash(
            archive_id=str(payload["archive_id"]),
            dataset_epoch=dataset_epoch,
            event=event,
        )
        previous_hash = str(event["event_hash"])
    payload["dataset_epoch"] = dataset_epoch
    payload["event_chain_tail"] = previous_hash
    payload["proof_hash"] = canonical_sha256(
        {
            "schema_version": HEDGE_INPUT_PROOF_SCHEMA_VERSION,
            "kind": "PUBLIC",
            "archive_id": payload["archive_id"],
            "dataset_epoch": dataset_epoch,
            "event_chain_tail": previous_hash,
            "historical_l2_ref": payload["historical_l2_ref"],
            "source_identity": payload["source_identity"],
            "capture_receipt": payload["capture_receipt"],
        }
    )
    validated = validate_hedge_public_history(payload)
    destination = path.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(canonical_json(payload), encoding="utf-8")
    return {
        "archive_id": validated.archive_id,
        "dataset_epoch": validated.dataset_epoch,
        "checksum_sha256": _digest_file(destination),
    }


@dataclass(frozen=True, slots=True)
class HedgePublicArchiveDescriptor:
    archive_id: str
    exchange: str
    market_type: str
    symbol: str
    settlement_asset: str
    range_start_ms: int
    range_end_ms: int
    max_mark_gap_ms: int
    dataset_epoch: str
    checksum_sha256: str
    event_chain_tail: str
    proof_hash: str
    historical_l2_ref: Mapping[str, str] | None
    event_count: int
    byte_size: int
    source_path: str
    metadata: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class HedgeSimulationDescriptor:
    manifest_id: str
    model_version: str
    contract_hash: str
    settlement_asset: str
    required_symbols: tuple[str, ...]
    range_start_ms: int
    range_end_ms: int
    dataset_epoch: str
    checksum_sha256: str
    proof_hash: str
    event_count: int
    byte_size: int
    source_path: str
    metadata: Mapping[str, object]


def public_input_fidelity(public: HedgePublicArchiveDescriptor) -> str:
    return (
        HYBRID_PUBLIC_INPUT_FIDELITY
        if public.metadata.get("source_identity") == HYBRID_PUBLIC_SOURCE_IDENTITY
        else PUBLIC_INPUT_FIDELITY
    )


@dataclass(frozen=True, slots=True)
class HedgeInputEvent:
    source_kind: str
    source_id: str
    event_sequence: int
    event_time_ms: int
    event_phase: int
    event_kind: str
    component_sequence: int
    previous_hash: str
    event_hash: str
    payload: Mapping[str, object]
    track_id: str | None = None

    @property
    def stable_track_id(self) -> str:
        if self.track_id is not None:
            return f"hedge-{self.source_kind.lower()}:{self.source_id}:{self.track_id}"
        return f"hedge-{self.source_kind.lower()}:{self.source_id}"


HedgeInputRuntimeSnapshot = tuple[
    tuple[HedgeInputEvent, ...],
    tuple[HedgeInputEvent, ...],
]


@dataclass(frozen=True, slots=True)
class HedgeInputProjection:
    source_kind: str
    last_event_sequence: int
    as_of_actual_time_ms: int
    as_of_virtual_time_ms: int
    state: Mapping[str, object]
    input_chain_hash: str


@dataclass(frozen=True, slots=True)
class PreparedHedgeInputBinding:
    public: HedgePublicArchiveDescriptor
    simulation: HedgeSimulationDescriptor
    public_generation: int
    simulation_generation: int
    public_projection: HedgeInputProjection
    simulation_projection: HedgeInputProjection
    bound_range_start_ms: int
    bound_range_end_ms: int
    input_proof_hash: str


@dataclass(frozen=True, slots=True)
class PreparedHedgeTrackPublicBinding:
    public: HedgePublicArchiveDescriptor
    public_generation: int
    public_projection: HedgeInputProjection
    bound_range_start_ms: int
    bound_range_end_ms: int
    input_proof_hash: str


def runtime_hedge_rule(
    payload: Mapping[str, object],
    *,
    track_id: str,
    source_kind: str,
    effective_virtual_time_ms: int,
    public_fidelity: str = PUBLIC_INPUT_FIDELITY,
) -> dict[str, object]:
    rule = _rule_payload(payload)
    hybrid = public_fidelity == HYBRID_PUBLIC_INPUT_FIDELITY
    return {
        "track_id": track_id,
        "rule_version": rule["rule_version"],
        "source_kind": source_kind,
        "price_tick": rule["price_tick"],
        "quantity_step": rule["quantity_step"],
        "min_quantity": rule["min_quantity"],
        "max_quantity": rule["max_quantity"],
        "min_notional": rule["min_notional"],
        "max_notional": rule["max_notional"],
        "quote_step": rule["quote_step"],
        "contract_size": rule["contract_size"],
        "max_leverage": rule["max_leverage"],
        "liquidation_fee_bps": rule["liquidation_fee_bps"],
        "maintenance_tiers": rule["maintenance_tiers"],
        "mark_fidelity": (
            HYBRID_MARK_FIDELITY if hybrid else "PINNED_HISTORICAL_MARK_INDEX"
        ),
        "rule_fidelity": (
            HYBRID_RULE_FIDELITY if hybrid else "PINNED_HISTORICAL_EXCHANGE_RULE"
        ),
        "effective_virtual_time_ms": effective_virtual_time_ms,
    }


def hedge_track_public_proof_hash(
    *,
    run_id: str,
    track_id: str,
    public: HedgePublicArchiveDescriptor,
    public_generation: int,
    bound_range_start_ms: int,
    bound_range_end_ms: int,
) -> str:
    return canonical_sha256(
        {
            "schema_version": "replay.hedge-track-public-binding.v1",
            "run_id": run_id,
            "track_id": track_id,
            "public": {
                "archive_id": public.archive_id,
                "generation": public_generation,
                "dataset_epoch": public.dataset_epoch,
                "checksum_sha256": public.checksum_sha256,
                "event_chain_tail": public.event_chain_tail,
                "proof_hash": public.proof_hash,
            },
            "bound_range_start_ms": bound_range_start_ms,
            "bound_range_end_ms": bound_range_end_ms,
        }
    )


def bind_hedge_track_public_input(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    track_id: str,
    source_kind: str,
    binding: PreparedHedgeTrackPublicBinding,
    virtual_time_ms: int,
    now_ms: int,
    verify_account_fee_policy: bool,
) -> None:
    """Bind one symbol's immutable public HEDGE inputs to one real track."""

    public_row = connection.execute(
        "SELECT * FROM replay_hedge_public_archive WHERE archive_id = ?",
        (binding.public.archive_id,),
    ).fetchone()
    if (
        public_row is None
        or public_row["health"] != "READY"
        or int(public_row["generation"]) != binding.public_generation
        or public_row["checksum_sha256"] != binding.public.checksum_sha256
        or public_row["event_chain_tail"] != binding.public.event_chain_tail
    ):
        raise TrainingRunError(
            "HEDGE_TRACK_INPUT_CHANGED_BEFORE_BIND",
            "a track public HEDGE input changed before the atomic bind",
            status_code=409,
            details={"track_id": track_id, "fallback_applied": False},
        )
    expected_proof = hedge_track_public_proof_hash(
        run_id=run_id,
        track_id=track_id,
        public=binding.public,
        public_generation=binding.public_generation,
        bound_range_start_ms=binding.bound_range_start_ms,
        bound_range_end_ms=binding.bound_range_end_ms,
    )
    if binding.input_proof_hash != expected_proof:
        raise TrainingRunError(
            "HEDGE_TRACK_INPUT_PROOF_MISMATCH",
            "the prepared track public proof no longer matches the bind target",
            status_code=409,
            details={"track_id": track_id, "fallback_applied": False},
        )
    state = binding.public_projection.state
    rule = state.get("rule")
    fee = state.get("fee_policy")
    mark = state.get("mark_index")
    if (
        not isinstance(rule, Mapping)
        or not isinstance(fee, Mapping)
        or not isinstance(mark, Mapping)
    ):
        raise TypeError("HEDGE track public start projection is incomplete")
    if verify_account_fee_policy:
        account_fee = connection.execute(
            """
            SELECT policy.maker_fee_bps, policy.taker_fee_bps,
                   extension.liquidation_fee_bps,
                   extension.policy_version, extension.account_tier
            FROM replay_training_fee_policy AS policy
            JOIN replay_training_fee_policy_extension AS extension
              ON extension.run_id = policy.run_id
             AND extension.revision = policy.revision
            WHERE policy.run_id = ?
            ORDER BY policy.effective_virtual_time_ms DESC,
                     policy.revision DESC LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        expected_fee = (
            str(fee["maker_fee_bps"]),
            str(fee["taker_fee_bps"]),
            str(fee["liquidation_fee_bps"]),
            str(fee["policy_version"]),
            str(fee["account_tier"]),
        )
        actual_fee = (
            None
            if account_fee is None
            else (
                str(account_fee["maker_fee_bps"]),
                str(account_fee["taker_fee_bps"]),
                str(account_fee["liquidation_fee_bps"]),
                str(account_fee["policy_version"]),
                str(account_fee["account_tier"]),
            )
        )
        if actual_fee != expected_fee:
            raise TrainingRunError(
                "HEDGE_TRACK_FEE_POLICY_MISMATCH",
                "track public fee policy differs from the account-level policy",
                status_code=409,
                details={"track_id": track_id, "fallback_applied": False},
            )
    connection.execute(
        """
        INSERT INTO replay_hedge_track_public_binding(
            run_id, track_id, public_archive_id, public_generation,
            public_dataset_epoch, public_checksum_sha256,
            public_event_chain_tail, bound_range_start_ms,
            bound_range_end_ms, status, degraded_reason,
            input_proof_hash, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, ?)
        """,
        (
            run_id,
            track_id,
            binding.public.archive_id,
            binding.public_generation,
            binding.public.dataset_epoch,
            binding.public.checksum_sha256,
            binding.public.event_chain_tail,
            binding.bound_range_start_ms,
            binding.bound_range_end_ms,
            binding.input_proof_hash,
            now_ms,
            now_ms,
        ),
    )
    projection_payload = {
        "schema_version": "replay.hedge-track-public-projection.v1",
        "run_id": run_id,
        "track_id": track_id,
        "last_event_sequence": binding.public_projection.last_event_sequence,
        "as_of_actual_time_ms": binding.public_projection.as_of_actual_time_ms,
        "as_of_virtual_time_ms": virtual_time_ms,
        "state": dict(binding.public_projection.state),
        "input_chain_hash": binding.public_projection.input_chain_hash,
    }
    connection.execute(
        """
        INSERT INTO replay_hedge_track_public_projection(
            run_id, track_id, last_event_sequence, as_of_actual_time_ms,
            as_of_virtual_time_ms, state_json, input_chain_hash,
            component_hash, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            track_id,
            binding.public_projection.last_event_sequence,
            binding.public_projection.as_of_actual_time_ms,
            virtual_time_ms,
            canonical_json(binding.public_projection.state),
            binding.public_projection.input_chain_hash,
            canonical_sha256(projection_payload),
            now_ms,
        ),
    )
    bound_public_fidelity = public_input_fidelity(binding.public)
    hybrid_public = bound_public_fidelity == HYBRID_PUBLIC_INPUT_FIDELITY
    rule_fidelity = (
        HYBRID_RULE_FIDELITY if hybrid_public else "PINNED_HISTORICAL_EXCHANGE_RULE"
    )
    runtime_rule = runtime_hedge_rule(
        rule,
        track_id=track_id,
        source_kind=source_kind,
        effective_virtual_time_ms=virtual_time_ms,
        public_fidelity=bound_public_fidelity,
    )
    connection.execute(
        "DELETE FROM replay_training_instrument_rule WHERE run_id = ? AND track_id = ?",
        (run_id, track_id),
    )
    run_policy = connection.execute(
        "SELECT book_mode FROM replay_training_run WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    if run_policy is None:
        raise TypeError("HEDGE track run policy is missing")
    historical_l2_capability = (
        "AVAILABLE_PINNED_CONTINUITY_GATED"
        if str(run_policy["book_mode"]) == "BOOK_ASSISTED_REQUIRED"
        else "OFF_NOT_REQUESTED"
    )
    connection.execute(
        """
        INSERT INTO replay_training_instrument_rule(
            run_id, track_id, revision, effective_virtual_time_ms,
            rule_json, rule_hash, fidelity, created_at_ms
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            track_id,
            virtual_time_ms,
            canonical_json(runtime_rule),
            canonical_sha256(runtime_rule),
            rule_fidelity,
            now_ms,
        ),
    )
    connection.execute(
        """
        UPDATE replay_training_market_track
        SET public_price = ?, capabilities_json = ?, updated_at_ms = ?
        WHERE run_id = ? AND track_id = ?
        """,
        (
            mark["mark_price"],
            canonical_json(
                {
                    "HISTORICAL_MARK_INDEX": (
                        "AVAILABLE_APPROX" if hybrid_public else "AVAILABLE_PINNED"
                    ),
                    "HISTORICAL_INSTRUMENT_RULE": (
                        "AVAILABLE_APPROX" if hybrid_public else "AVAILABLE_PINNED"
                    ),
                    "HISTORICAL_FEE_POLICY": (
                        "AVAILABLE_APPROX"
                        if hybrid_public
                        else "AVAILABLE_PINNED_ACCOUNT_WIDE"
                    ),
                    "HISTORICAL_FUNDING": (
                        "OFF_NOT_REQUESTED" if hybrid_public else "AVAILABLE_PINNED"
                    ),
                    "HISTORICAL_L2": historical_l2_capability,
                    "SIMULATED_INSURANCE_FUND": "AVAILABLE_MATERIALIZED_ACCOUNT_WIDE",
                    "SIMULATED_ADL_COHORT": "AVAILABLE_MATERIALIZED_ACCOUNT_WIDE",
                }
            ),
            now_ms,
            run_id,
            track_id,
        ),
    )
    connection.execute(
        """
        UPDATE replay_hedge_public_archive
        SET last_used_at_ms = ?, updated_at_ms = ? WHERE archive_id = ?
        """,
        (now_ms, now_ms, binding.public.archive_id),
    )


def bind_hedge_inputs(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    track_id: str,
    source_kind: str,
    settlement_asset: str,
    binding: PreparedHedgeInputBinding,
    bound_range_start_ms: int,
    bound_range_end_ms: int,
    virtual_time_ms: int,
    now_ms: int,
) -> None:
    """Atomically bind both immutable HEDGE objects and their T0 projections."""

    public_row = connection.execute(
        "SELECT * FROM replay_hedge_public_archive WHERE archive_id = ?",
        (binding.public.archive_id,),
    ).fetchone()
    simulation_row = connection.execute(
        "SELECT * FROM replay_hedge_simulation_manifest WHERE manifest_id = ?",
        (binding.simulation.manifest_id,),
    ).fetchone()
    if (
        public_row is None
        or simulation_row is None
        or public_row["health"] != "READY"
        or simulation_row["health"] != "READY"
        or int(public_row["generation"]) != binding.public_generation
        or int(simulation_row["generation"]) != binding.simulation_generation
        or public_row["checksum_sha256"] != binding.public.checksum_sha256
        or simulation_row["checksum_sha256"] != binding.simulation.checksum_sha256
    ):
        raise TrainingRunError(
            "HEDGE_INPUT_CHANGED_BEFORE_BIND",
            "a HEDGE input changed before the atomic Run bind",
            status_code=409,
            details={"fallback_applied": False},
        )
    if (
        bound_range_start_ms != binding.bound_range_start_ms
        or bound_range_end_ms != binding.bound_range_end_ms
    ):
        raise TrainingRunError(
            "HEDGE_INPUT_BOUND_RANGE_CHANGED",
            "the HEDGE input range changed after verification",
            status_code=409,
            details={"fallback_applied": False},
        )
    connection.execute(
        """
        INSERT INTO replay_hedge_input_binding(
            run_id, public_archive_id, public_generation,
            public_dataset_epoch, public_checksum_sha256,
            public_event_chain_tail, simulation_manifest_id,
            simulation_generation, simulation_dataset_epoch,
            simulation_checksum_sha256, simulation_contract_hash,
            bound_range_start_ms, bound_range_end_ms, status,
            degraded_reason, input_proof_hash, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, ?)
        """,
        (
            run_id,
            binding.public.archive_id,
            binding.public_generation,
            binding.public.dataset_epoch,
            binding.public.checksum_sha256,
            binding.public.event_chain_tail,
            binding.simulation.manifest_id,
            binding.simulation_generation,
            binding.simulation.dataset_epoch,
            binding.simulation.checksum_sha256,
            binding.simulation.contract_hash,
            bound_range_start_ms,
            bound_range_end_ms,
            binding.input_proof_hash,
            now_ms,
            now_ms,
        ),
    )
    for projection in (
        binding.public_projection,
        binding.simulation_projection,
    ):
        projection_payload = {
            "schema_version": "replay.hedge-input-projection.v1",
            "source_kind": projection.source_kind,
            "last_event_sequence": projection.last_event_sequence,
            "as_of_actual_time_ms": projection.as_of_actual_time_ms,
            "as_of_virtual_time_ms": virtual_time_ms,
            "state": dict(projection.state),
            "input_chain_hash": projection.input_chain_hash,
        }
        connection.execute(
            """
            INSERT INTO replay_hedge_input_projection(
                run_id, source_kind, last_event_sequence,
                as_of_actual_time_ms, as_of_virtual_time_ms, state_json,
                input_chain_hash, component_hash, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                projection.source_kind,
                projection.last_event_sequence,
                projection.as_of_actual_time_ms,
                virtual_time_ms,
                canonical_json(projection.state),
                projection.input_chain_hash,
                canonical_sha256(projection_payload),
                now_ms,
            ),
        )
    track_public_binding = PreparedHedgeTrackPublicBinding(
        public=binding.public,
        public_generation=binding.public_generation,
        public_projection=binding.public_projection,
        bound_range_start_ms=bound_range_start_ms,
        bound_range_end_ms=bound_range_end_ms,
        input_proof_hash=hedge_track_public_proof_hash(
            run_id=run_id,
            track_id=track_id,
            public=binding.public,
            public_generation=binding.public_generation,
            bound_range_start_ms=bound_range_start_ms,
            bound_range_end_ms=bound_range_end_ms,
        ),
    )
    bind_hedge_track_public_input(
        connection,
        run_id=run_id,
        track_id=track_id,
        source_kind=source_kind,
        binding=track_public_binding,
        virtual_time_ms=virtual_time_ms,
        now_ms=now_ms,
        verify_account_fee_policy=False,
    )
    public_state = binding.public_projection.state
    fee = public_state.get("fee_policy")
    if not isinstance(fee, Mapping):
        raise TypeError("HEDGE public start projection is incomplete")
    hybrid_public = (
        public_input_fidelity(binding.public) == HYBRID_PUBLIC_INPUT_FIDELITY
    )
    fee_fidelity = (
        HYBRID_FEE_FIDELITY if hybrid_public else "PINNED_HISTORICAL_FEE_POLICY"
    )
    fee_policy = {
        "schema_version": "replay.training.fee-policy.v1",
        "run_id": run_id,
        "revision": 1,
        "effective_virtual_time_ms": virtual_time_ms,
        "maker_fee_bps": fee["maker_fee_bps"],
        "taker_fee_bps": fee["taker_fee_bps"],
        "liquidation_fee_bps": fee["liquidation_fee_bps"],
        "policy_version": fee["policy_version"],
        "account_tier": fee["account_tier"],
        "fidelity": fee_fidelity,
    }
    connection.execute(
        "DELETE FROM replay_training_fee_policy WHERE run_id = ?",
        (run_id,),
    )
    connection.execute(
        """
        INSERT INTO replay_training_fee_policy(
            run_id, revision, effective_virtual_time_ms, maker_fee_bps,
            taker_fee_bps, policy_hash, fidelity, reason, created_at_ms
        ) VALUES (?, 1, ?, ?, ?, ?, ?, 'HEDGE public input T0', ?)
        """,
        (
            run_id,
            virtual_time_ms,
            fee["maker_fee_bps"],
            fee["taker_fee_bps"],
            canonical_sha256(fee_policy),
            fee_fidelity,
            now_ms,
        ),
    )
    fee_extension = {
        "schema_version": "replay.training.fee-policy-extension.v1",
        "run_id": run_id,
        "revision": 1,
        "policy_version": fee["policy_version"],
        "account_tier": fee["account_tier"],
        "liquidation_fee_bps": fee["liquidation_fee_bps"],
        "source_kind": "PUBLIC",
        "source_id": binding.public.archive_id,
        "source_event_sequence": 0,
    }
    connection.execute(
        """
        INSERT INTO replay_training_fee_policy_extension(
            run_id, revision, policy_version, account_tier,
            liquidation_fee_bps, source_kind, source_id,
            source_event_sequence, component_hash, created_at_ms
        ) VALUES (?, 1, ?, ?, ?, 'PUBLIC', ?, 0, ?, ?)
        """,
        (
            run_id,
            fee["policy_version"],
            fee["account_tier"],
            fee["liquidation_fee_bps"],
            binding.public.archive_id,
            canonical_sha256(fee_extension),
            now_ms,
        ),
    )
    simulation_state = binding.simulation_projection.state
    insurance = simulation_state.get("insurance")
    if not isinstance(insurance, Mapping):
        raise TypeError("HEDGE simulation start projection lacks insurance state")
    opening_balance = str(insurance["balance_after"])
    connection.execute(
        """
        INSERT INTO replay_training_insurance_fund(
            run_id, asset, model_version, opening_balance, current_balance,
            ledger_tail_hash, revision, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        """,
        (
            run_id,
            settlement_asset,
            binding.simulation.model_version,
            opening_balance,
            opening_balance,
            binding.simulation_projection.input_chain_hash,
            now_ms,
        ),
    )
    connection.execute(
        """
        UPDATE replay_training_contract_account
        SET fidelity = ?,
            updated_at_ms = ? WHERE run_id = ?
        """,
        (
            (
                "HYBRID_PUBLIC_INPUT_MODELLED_HEDGE_ACCOUNT"
                if hybrid_public
                else "PINNED_PUBLIC_INPUT_MODELLED_HEDGE_ACCOUNT"
            ),
            now_ms,
            run_id,
        ),
    )
    connection.execute(
        """
        UPDATE replay_hedge_simulation_manifest
        SET last_used_at_ms = ?, updated_at_ms = ? WHERE manifest_id = ?
        """,
        (now_ms, now_ms, binding.simulation.manifest_id),
    )


def validate_hedge_public_history(
    payload: Mapping[str, object],
    *,
    source_path: Path | None = None,
) -> HedgePublicArchiveDescriptor:
    if set(payload) != _PUBLIC_ROOT_KEYS:
        raise ValueError("public archive fields do not match the v1 contract")
    if payload["schema_version"] != PUBLIC_ARCHIVE_SCHEMA_VERSION:
        raise ValueError("public archive schema_version is unsupported")
    archive_id = validate_identifier(payload["archive_id"], field_name="archive_id")
    start = _counter(payload["range_start_ms"], "range_start_ms")
    end = _counter(payload["range_end_ms"], "range_end_ms")
    if end < start:
        raise ValueError("public archive time range is invalid")
    max_gap = _counter(payload["max_mark_gap_ms"], "max_mark_gap_ms", positive=True)
    l2_ref = _l2_ref(payload["historical_l2_ref"])
    events = payload["events"]
    if not isinstance(events, list) or not events:
        raise ValueError("public events must be a non-empty array")
    dataset_epoch = _digest(payload["dataset_epoch"], "dataset_epoch")
    if canonical_sha256(_public_dataset_payload(payload)) != dataset_epoch:
        raise ValueError("public archive dataset_epoch is invalid")
    previous_hash = _public_root_hash(
        archive_id=archive_id, dataset_epoch=dataset_epoch
    )
    previous_order: tuple[int, int, int] | None = None
    component_sequences = {kind: 0 for kind in _PUBLIC_KINDS}
    marks: list[int] = []
    initial_kinds: set[str] = set()
    funding_times: set[int] = set()
    for sequence, raw in enumerate(events, start=1):
        if not isinstance(raw, Mapping) or set(raw) != {
            "sequence",
            "event_time_ms",
            "event_phase",
            "event_kind",
            "component_sequence",
            "payload",
            "previous_hash",
            "event_hash",
        }:
            raise ValueError("public event fields do not match the v1 contract")
        if raw["sequence"] != sequence:
            raise ValueError("public event sequence must be contiguous from one")
        event_time = validate_timestamp_ms(
            raw["event_time_ms"], field_name="event_time_ms"
        )
        kind = str(raw["event_kind"])
        if kind not in _PUBLIC_KINDS or raw["event_phase"] != _PUBLIC_PHASES[kind]:
            raise ValueError("public event phase does not match its kind")
        component_sequences[kind] += 1
        if raw["component_sequence"] != component_sequences[kind]:
            raise ValueError("public component sequence is not contiguous")
        order = (event_time, int(raw["event_phase"]), sequence)
        if previous_order is not None and order <= previous_order:
            raise ValueError("public events are duplicated or move backward")
        previous_order = order
        normalized = _public_component(kind, raw["payload"])
        if canonical_json(normalized) != canonical_json(raw["payload"]):
            raise ValueError("public event payload is not canonical")
        if raw["previous_hash"] != previous_hash:
            raise ValueError("public event hash chain is broken")
        actual_hash = _public_event_hash(
            archive_id=archive_id, dataset_epoch=dataset_epoch, event=raw
        )
        if raw["event_hash"] != actual_hash:
            raise ValueError("public event_hash is invalid")
        previous_hash = actual_hash
        if event_time <= start:
            initial_kinds.add(kind)
        if kind == "MARK_INDEX":
            marks.append(event_time)
        elif kind == "FUNDING":
            if event_time in funding_times:
                raise ValueError("funding settlement time is duplicated")
            funding_times.add(event_time)
    if not {"RULE", "FEE_POLICY", "MARK_INDEX"}.issubset(initial_kinds):
        raise ValueError("public archive lacks an initial rule, fee policy, or mark")
    if not funding_times:
        raise ValueError("public archive funding timeline is empty")
    if not marks or marks[0] > start or marks[-1] < end:
        raise ValueError("public mark timeline does not cover the bound range")
    if any(right - left > max_gap for left, right in zip(marks, marks[1:])):
        raise ValueError("public mark timeline has a continuity gap")
    if payload["event_chain_tail"] != previous_hash:
        raise ValueError("public event_chain_tail is invalid")
    expected_proof = canonical_sha256(
        {
            "schema_version": HEDGE_INPUT_PROOF_SCHEMA_VERSION,
            "kind": "PUBLIC",
            "archive_id": archive_id,
            "dataset_epoch": dataset_epoch,
            "event_chain_tail": previous_hash,
            "historical_l2_ref": l2_ref,
            "source_identity": payload["source_identity"],
            "capture_receipt": payload["capture_receipt"],
        }
    )
    if payload["proof_hash"] != expected_proof:
        raise ValueError("public proof_hash is invalid")
    source = None if source_path is None else source_path.resolve(strict=True)
    checksum = _ROOT_HASH if source is None else _digest_file(source)
    byte_size = 1 if source is None else source.stat().st_size
    return HedgePublicArchiveDescriptor(
        archive_id=archive_id,
        exchange=_identity(payload["exchange"], "exchange"),
        market_type=_identity(payload["market_type"], "market_type"),
        symbol=_identity(payload["symbol"], "symbol"),
        settlement_asset=_identity(payload["settlement_asset"], "settlement_asset"),
        range_start_ms=start,
        range_end_ms=end,
        max_mark_gap_ms=max_gap,
        dataset_epoch=dataset_epoch,
        checksum_sha256=checksum,
        event_chain_tail=previous_hash,
        proof_hash=expected_proof,
        historical_l2_ref=l2_ref,
        event_count=len(events),
        byte_size=byte_size,
        source_path="" if source is None else str(source),
        metadata={
            "source_identity": _identity(payload["source_identity"], "source_identity"),
            "capture_receipt": _identity(payload["capture_receipt"], "capture_receipt"),
            "max_mark_gap_ms": max_gap,
        },
    )


def verify_hedge_public_history(path: Path) -> HedgePublicArchiveDescriptor:
    source = path.expanduser().resolve(strict=True)
    payload = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise TypeError("public archive root must be an object")
    if source.read_text(encoding="utf-8") != canonical_json(payload):
        raise ValueError("public archive must use canonical JSON")
    return validate_hedge_public_history(payload, source_path=source)


def verify_hedge_simulation_manifest(path: Path) -> HedgeSimulationDescriptor:
    source = path.expanduser().resolve(strict=True)
    raw_text = source.read_text(encoding="utf-8")
    payload = json.loads(raw_text)
    if not isinstance(payload, Mapping):
        raise TypeError("simulation manifest root must be an object")
    manifest_hash = validate_simulation_manifest(payload)
    required = payload["required_symbols"]
    insurance = payload["insurance_events"]
    snapshots = payload["adl_snapshots"]
    assert isinstance(required, list)
    assert isinstance(insurance, list)
    assert isinstance(snapshots, list)
    return HedgeSimulationDescriptor(
        manifest_id=validate_identifier(
            payload["manifest_id"], field_name="manifest_id"
        ),
        model_version=str(payload["model_version"]),
        contract_hash=contract_hash(),
        settlement_asset=str(payload["settlement_asset"]),
        required_symbols=tuple(str(item) for item in required),
        range_start_ms=int(payload["range_start_ms"]),
        range_end_ms=int(payload["range_end_ms"]),
        dataset_epoch=_digest(payload["dataset_epoch"], "dataset_epoch"),
        checksum_sha256=_digest_file(source),
        proof_hash=canonical_sha256(
            {
                "schema_version": HEDGE_INPUT_PROOF_SCHEMA_VERSION,
                "kind": "SIMULATION",
                "manifest_hash": manifest_hash,
                "contract_hash": contract_hash(),
                "model_version": MODEL_VERSION,
            }
        ),
        event_count=len(insurance) + len(snapshots),
        byte_size=source.stat().st_size,
        source_path=str(source),
        metadata={"manifest_hash": manifest_hash},
    )


def build_hedge_simulation_manifest(
    path: Path,
    *,
    manifest_id: str,
    range_start_ms: int,
    range_end_ms: int,
    settlement_asset: str,
    required_symbols: Sequence[str],
    insurance_events: Sequence[Mapping[str, object]],
    adl_snapshots: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    """Build a fully materialized deterministic insurance/ADL manifest."""

    normalized_symbols = [
        _identity(symbol, "required_symbols[]") for symbol in required_symbols
    ]
    if not normalized_symbols or len(set(normalized_symbols)) != len(
        normalized_symbols
    ):
        raise ValueError("required_symbols must be unique and non-empty")
    normalized_insurance: list[dict[str, object]] = []
    balance = Decimal(0)
    previous_hash = _ROOT_HASH
    for sequence, raw in enumerate(insurance_events, start=1):
        if set(raw) != {"effective_time_ms", "kind", "amount"}:
            raise ValueError("insurance builder event fields are invalid")
        kind = str(raw["kind"])
        amount = Decimal(
            _canonical_decimal(raw["amount"], "insurance.amount", nonnegative=True)
        )
        if sequence == 1:
            if kind != "OPENING_BALANCE":
                raise ValueError("first insurance event must be OPENING_BALANCE")
            balance = amount
        elif kind == "CREDIT":
            balance += amount
        elif kind == "DEBIT":
            balance -= amount
            if balance < 0:
                raise ValueError("insurance fund cannot overdraft")
        else:
            raise ValueError("insurance event kind is unsupported")
        event = {
            "sequence": sequence,
            "effective_time_ms": validate_timestamp_ms(
                raw["effective_time_ms"], field_name="insurance.effective_time_ms"
            ),
            "kind": kind,
            "amount": str(raw["amount"]),
            "balance_after": canonical_decimal(
                str(balance),
                field_name="insurance.balance_after",
                nonnegative=True,
            ),
            "previous_hash": previous_hash,
        }
        event["event_hash"] = canonical_sha256(
            {
                "schema_version": SIMULATION_MANIFEST_SCHEMA_VERSION,
                "manifest_id": manifest_id,
                "sequence": event["sequence"],
                "effective_time_ms": event["effective_time_ms"],
                "kind": event["kind"],
                "amount": event["amount"],
                "balance_after": event["balance_after"],
                "previous_hash": event["previous_hash"],
            }
        )
        previous_hash = str(event["event_hash"])
        normalized_insurance.append(event)
    normalized_snapshots: list[dict[str, object]] = []
    for sequence, raw in enumerate(adl_snapshots, start=1):
        if set(raw) != {
            "symbol",
            "effective_time_ms",
            "valid_until_ms",
            "candidates",
        }:
            raise ValueError("ADL builder snapshot fields are invalid")
        candidates = raw["candidates"]
        if not isinstance(candidates, list):
            raise TypeError("ADL candidates must be an array")
        snapshot = {
            "sequence": sequence,
            "symbol": str(raw["symbol"]),
            "effective_time_ms": validate_timestamp_ms(
                raw["effective_time_ms"], field_name="adl.effective_time_ms"
            ),
            "valid_until_ms": validate_timestamp_ms(
                raw["valid_until_ms"], field_name="adl.valid_until_ms"
            ),
            "candidates": [dict(candidate) for candidate in candidates],
        }
        snapshot["snapshot_hash"] = canonical_sha256(
            {
                "schema_version": SIMULATION_MANIFEST_SCHEMA_VERSION,
                "manifest_id": manifest_id,
                "sequence": snapshot["sequence"],
                "symbol": snapshot["symbol"],
                "effective_time_ms": snapshot["effective_time_ms"],
                "valid_until_ms": snapshot["valid_until_ms"],
                "candidates": snapshot["candidates"],
            }
        )
        normalized_snapshots.append(snapshot)
    epoch_payload = {
        "schema_version": SIMULATION_MANIFEST_SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "manifest_id": manifest_id,
        "range_start_ms": range_start_ms,
        "range_end_ms": range_end_ms,
        "settlement_asset": settlement_asset,
        "required_symbols": normalized_symbols,
        "insurance_events": normalized_insurance,
        "adl_snapshots": normalized_snapshots,
    }
    payload = {
        "schema_version": SIMULATION_MANIFEST_SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "manifest_id": validate_identifier(manifest_id, field_name="manifest_id"),
        "dataset_epoch": canonical_sha256(epoch_payload),
        "range_start_ms": _counter(range_start_ms, "range_start_ms"),
        "range_end_ms": _counter(range_end_ms, "range_end_ms"),
        "settlement_asset": _identity(settlement_asset, "settlement_asset"),
        "required_symbols": normalized_symbols,
        "insurance_events": normalized_insurance,
        "adl_snapshots": normalized_snapshots,
    }
    validate_simulation_manifest(payload)
    destination = path.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(canonical_json(payload), encoding="utf-8")
    return {
        "manifest_id": payload["manifest_id"],
        "dataset_epoch": payload["dataset_epoch"],
        "checksum_sha256": _digest_file(destination),
        "contract_hash": contract_hash(),
        "model_version": MODEL_VERSION,
    }


def _read_public_events(path: Path) -> tuple[HedgeInputEvent, ...]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    descriptor = validate_hedge_public_history(payload, source_path=path)
    raw_events = payload["events"]
    assert isinstance(raw_events, list)
    return tuple(
        HedgeInputEvent(
            source_kind="PUBLIC",
            source_id=descriptor.archive_id,
            event_sequence=int(event["sequence"]),
            event_time_ms=int(event["event_time_ms"]),
            event_phase=int(event["event_phase"]),
            event_kind=str(event["event_kind"]),
            component_sequence=int(event["component_sequence"]),
            previous_hash=str(event["previous_hash"]),
            event_hash=str(event["event_hash"]),
            payload=dict(event["payload"]),
        )
        for event in raw_events
    )


def _read_simulation_events(path: Path) -> tuple[HedgeInputEvent, ...]:
    descriptor = verify_hedge_simulation_manifest(path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    materialized: list[tuple[int, str, int, str, Mapping[str, object]]] = []
    for event in payload["insurance_events"]:
        materialized.append(
            (
                int(event["effective_time_ms"]),
                "INSURANCE_INPUT",
                int(event["sequence"]),
                str(event["event_hash"]),
                event,
            )
        )
    for snapshot in payload["adl_snapshots"]:
        materialized.append(
            (
                int(snapshot["effective_time_ms"]),
                "ADL_COHORT_INPUT",
                int(snapshot["sequence"]),
                str(snapshot["snapshot_hash"]),
                snapshot,
            )
        )
    materialized.sort(key=lambda item: (item[0], item[1], item[2]))
    previous_hash = canonical_sha256(
        {
            "schema_version": SIMULATION_EVENT_SCHEMA_VERSION,
            "manifest_id": descriptor.manifest_id,
            "dataset_epoch": descriptor.dataset_epoch,
        }
    )
    result: list[HedgeInputEvent] = []
    for sequence, (
        event_time,
        kind,
        component_sequence,
        source_hash,
        body,
    ) in enumerate(materialized, start=1):
        event_hash = canonical_sha256(
            {
                "schema_version": SIMULATION_EVENT_SCHEMA_VERSION,
                "manifest_id": descriptor.manifest_id,
                "sequence": sequence,
                "event_time_ms": event_time,
                "event_phase": 70,
                "event_kind": kind,
                "component_sequence": component_sequence,
                "source_hash": source_hash,
                "payload": dict(body),
                "previous_hash": previous_hash,
            }
        )
        result.append(
            HedgeInputEvent(
                source_kind="SIMULATION",
                source_id=descriptor.manifest_id,
                event_sequence=sequence,
                event_time_ms=event_time,
                event_phase=70,
                event_kind=kind,
                component_sequence=component_sequence,
                previous_hash=previous_hash,
                event_hash=event_hash,
                payload=dict(body),
            )
        )
        previous_hash = event_hash
    return tuple(result)


def _projection(
    events: Sequence[HedgeInputEvent],
    *,
    source_kind: str,
    actual_time_ms: int,
    virtual_time_ms: int,
) -> HedgeInputProjection:
    state: dict[str, object] = {}
    last_sequence = 0
    chain_hash = events[0].previous_hash if events else _ROOT_HASH
    for event in events:
        if event.event_time_ms > actual_time_ms:
            break
        last_sequence = event.event_sequence
        chain_hash = event.event_hash
        if event.event_kind == "RULE":
            state["rule"] = dict(event.payload)
        elif event.event_kind == "FEE_POLICY":
            state["fee_policy"] = dict(event.payload)
        elif event.event_kind == "MARK_INDEX":
            state["mark_index"] = dict(event.payload)
        elif event.event_kind == "FUNDING":
            state["funding"] = dict(event.payload)
        elif event.event_kind == "INSURANCE_INPUT":
            state["insurance"] = dict(event.payload)
        elif event.event_kind == "ADL_COHORT_INPUT":
            snapshots = dict(state.get("adl_snapshots", {}))
            snapshots[str(event.payload["symbol"])] = dict(event.payload)
            state["adl_snapshots"] = snapshots
    return HedgeInputProjection(
        source_kind=source_kind,
        last_event_sequence=last_sequence,
        as_of_actual_time_ms=actual_time_ms,
        as_of_virtual_time_ms=virtual_time_ms,
        state=state,
        input_chain_hash=chain_hash,
    )


class HedgeInputArchiveManager:
    """Own immutable HEDGE input objects and fail closed on every drift."""

    def __init__(self, store: ReplaySQLiteStore, *, root: Path | None = None) -> None:
        self.store = store
        self.root = (
            root
            if root is not None
            else store.path.parent / f"{store.path.stem}-hedge-inputs"
        ).resolve()
        self._lock = asyncio.Lock()
        self._hybrid_provision_lock = asyncio.Lock()
        self._verified_event_cache: dict[
            tuple[str, str, str], tuple[HedgeInputEvent, ...]
        ] = {}

    async def start(self) -> None:
        await asyncio.to_thread(self._ensure_dirs)

    async def ensure_hybrid_inputs(
        self,
        request: TrainingRunCreateRequest,
        seed: Mapping[str, object],
    ) -> dict[str, object]:
        """Build deterministic, pinned HEDGE inputs from revealed local prices.

        These objects are intentionally tagged as hybrid.  They preserve the
        immutable input/audit machinery without claiming historical exchange
        mark, rule, fee, funding, insurance, or ADL fidelity.
        """

        if request.position_mode.value != "HEDGE":
            raise ValueError("hybrid HEDGE inputs require HEDGE position mode")
        if request.book_mode.value != "OFF":
            raise ValueError("hybrid HEDGE inputs cannot satisfy required L2")
        expected_seed_keys = {
            "schema_version",
            "source_kind",
            "source_fingerprint",
            "data_epoch",
            "range_start_ms",
            "range_end_ms",
            "max_mark_gap_ms",
            "marks",
            "broker_config",
        }
        if set(seed) != expected_seed_keys or seed.get("schema_version") != (
            "replay.hedge-hybrid-seed.v1"
        ):
            raise ValueError("hybrid HEDGE seed fields are incompatible")
        start = _counter(seed["range_start_ms"], "hybrid.range_start_ms")
        end = _counter(seed["range_end_ms"], "hybrid.range_end_ms")
        if (
            request.requested_start_ms != start
            or end != start + request.forward_cache_ms
        ):
            raise ValueError("hybrid HEDGE seed range does not match the request")
        raw_marks = seed["marks"]
        if not isinstance(raw_marks, list) or not raw_marks:
            raise ValueError("hybrid HEDGE seed marks must be non-empty")
        marks: list[dict[str, object]] = []
        previous_time: int | None = None
        for raw_mark in raw_marks:
            if not isinstance(raw_mark, Mapping) or set(raw_mark) != {
                "event_time_ms",
                "price",
            }:
                raise ValueError("hybrid HEDGE mark fields are incompatible")
            event_time = validate_timestamp_ms(
                raw_mark["event_time_ms"], field_name="hybrid.mark.event_time_ms"
            )
            if previous_time is not None and event_time <= previous_time:
                raise ValueError("hybrid HEDGE marks must be strictly ordered")
            previous_time = event_time
            marks.append(
                {
                    "event_time_ms": event_time,
                    "price": _canonical_decimal(
                        raw_mark["price"], "hybrid.mark.price", positive=True
                    ),
                }
            )
        if marks[0]["event_time_ms"] != start or marks[-1]["event_time_ms"] != end:
            raise ValueError("hybrid HEDGE marks do not cover the requested range")
        broker_config = seed["broker_config"]
        if not isinstance(broker_config, Mapping):
            raise TypeError("hybrid HEDGE broker_config must be an object")
        source_kind = str(seed["source_kind"])
        rule = instrument_rule_from_broker_config(
            track_id="track-1",
            source_kind=source_kind,
            broker_config=broker_config,
            effective_virtual_time_ms=start,
        ).to_dict()
        rule_payload = {key: rule[key] for key in _RULE_KEYS}
        events: list[dict[str, object]] = [
            {
                "event_time_ms": start,
                "event_kind": "RULE",
                "payload": rule_payload,
            },
            {
                "event_time_ms": start,
                "event_kind": "FEE_POLICY",
                "payload": {
                    "policy_version": "RUN_CONFIGURED_FEE_V1",
                    "account_tier": "RUN_CONFIGURED",
                    "maker_fee_bps": request.maker_fee_bps,
                    "taker_fee_bps": request.taker_fee_bps,
                    "liquidation_fee_bps": rule_payload["liquidation_fee_bps"],
                },
            },
        ]
        events.extend(
            {
                "event_time_ms": int(mark["event_time_ms"]),
                "event_kind": "MARK_INDEX",
                "payload": {
                    "mark_price": mark["price"],
                    "index_price": mark["price"],
                },
            }
            for mark in marks
        )
        # The v1 immutable archive requires a funding component.  A single T0
        # zero event is fully consumed by the initial projection; OFF runs have
        # no future funding event to settle.
        events.append(
            {
                "event_time_ms": start,
                "event_kind": "FUNDING",
                "payload": {
                    "funding_rate": "0",
                    "mark_price": marks[0]["price"],
                },
            }
        )
        events.sort(
            key=lambda item: (
                int(item["event_time_ms"]),
                _PUBLIC_PHASES[str(item["event_kind"])],
                str(item["event_kind"]),
            )
        )
        seed_proof = canonical_sha256(
            {
                "schema_version": "replay.hedge-hybrid-provision.v1",
                "exchange": request.exchange,
                "market_type": request.market_type,
                "symbol": request.symbol,
                "settlement_asset": request.settlement_asset,
                "source_kind": source_kind,
                "source_fingerprint": seed["source_fingerprint"],
                "data_epoch": seed["data_epoch"],
                "range_start_ms": start,
                "range_end_ms": end,
                "rule": rule_payload,
                "maker_fee_bps": request.maker_fee_bps,
                "taker_fee_bps": request.taker_fee_bps,
                "marks": marks,
            }
        )
        token = seed_proof[7:39]
        archive_id = f"hybrid-public-{token}"
        manifest_id = f"hybrid-simulation-{token}"
        first_mark = Decimal(str(marks[0]["price"]))
        leverage = Decimal(request.max_leverage)
        initial_margin = first_mark / max(leverage, Decimal(1))
        insurance_opening = max(
            Decimal(request.initial_equity) * leverage * Decimal(100),
            Decimal("1000000"),
        )
        candidate = {
            "candidate_id": f"hybrid-{request.symbol.lower()}-{token[:12]}",
            "symbol": request.symbol,
            "position_side": "SHORT",
            "quantity": "1",
            "entry_price": canonical_decimal(
                format(first_mark * Decimal("1.1"), "f"),
                field_name="hybrid.adl.entry_price",
                positive=True,
            ),
            "mark_price": canonical_decimal(
                format(first_mark, "f"),
                field_name="hybrid.adl.mark_price",
                positive=True,
            ),
            "initial_margin": canonical_decimal(
                format(initial_margin, "f"),
                field_name="hybrid.adl.initial_margin",
                positive=True,
            ),
            "margin_balance": canonical_decimal(
                format(initial_margin * Decimal(2), "f"),
                field_name="hybrid.adl.margin_balance",
                positive=True,
            ),
        }
        async with self._hybrid_provision_lock:
            self._ensure_dirs()
            public_path = self.root / "generated" / f"{archive_id}.json"
            simulation_path = self.root / "generated" / f"{manifest_id}.json"
            await asyncio.to_thread(
                build_hedge_public_history_archive,
                public_path,
                archive_id=archive_id,
                exchange=request.exchange,
                market_type=request.market_type,
                symbol=request.symbol,
                settlement_asset=request.settlement_asset,
                range_start_ms=start,
                range_end_ms=end,
                max_mark_gap_ms=_counter(
                    seed["max_mark_gap_ms"],
                    "hybrid.max_mark_gap_ms",
                    positive=True,
                ),
                source_identity=HYBRID_PUBLIC_SOURCE_IDENTITY,
                capture_receipt=f"local-seed-{token}",
                historical_l2_ref=None,
                events=events,
            )
            await asyncio.to_thread(
                build_hedge_simulation_manifest,
                simulation_path,
                manifest_id=manifest_id,
                range_start_ms=start,
                range_end_ms=end,
                settlement_asset=request.settlement_asset,
                required_symbols=[request.symbol],
                insurance_events=[
                    {
                        "effective_time_ms": start,
                        "kind": "OPENING_BALANCE",
                        "amount": canonical_decimal(
                            format(insurance_opening, "f"),
                            field_name="hybrid.insurance.opening_balance",
                            positive=True,
                        ),
                    }
                ],
                adl_snapshots=[
                    {
                        "symbol": request.symbol,
                        "effective_time_ms": start,
                        "valid_until_ms": end,
                        "candidates": [candidate],
                    }
                ],
            )
            public_receipt = await self.import_public(public_path)
            simulation_receipt = await self.import_simulation(simulation_path)
        return {
            "public": public_receipt,
            "simulation": simulation_receipt,
            "public_fidelity": HYBRID_PUBLIC_INPUT_FIDELITY,
            "funding_fidelity": "OFF_NOT_REQUESTED",
            "fallback_applied": True,
        }

    async def plan_for_request(
        self,
        request: TrainingRunCreateRequest,
    ) -> dict[str, object]:
        """Resolve the exact immutable refs required by an explicit HEDGE create.

        BOOK_ASSISTED_REQUIRED selects a public archive that points at the same
        historical L2 object as the book manager.  OFF selects only the pinned
        mark/index, rule, fee and funding history and does not require an L2
        object to exist locally.
        """

        base: dict[str, object] = {
            "schema_version": "replay.hedge-input-plan.v1",
            "feature_enabled": True,
            "requested_position_mode": request.position_mode.value,
            "public_fidelity": PUBLIC_INPUT_FIDELITY,
            "private_fidelity": SIMULATION_INPUT_FIDELITY,
            "historical_exchange_private_state": False,
            "fallback_applied": False,
        }
        if request.position_mode.value != "HEDGE":
            return {
                **base,
                "capability_state": "NOT_REQUIRED",
                "reason": "POSITION_MODE_ONE_WAY",
                "coverage": None,
                "historical_l2_ref": None,
                "hedge_public_history_ref": None,
                "simulation_manifest_ref": None,
            }
        requested_start = request.requested_start_ms
        if request.start_mode.value != "MANUAL" or requested_start is None:
            return {
                **base,
                "capability_state": "UNSUPPORTED_SOURCE_MODE",
                "reason": "MANUAL_START_REQUIRED",
                "coverage": None,
                "historical_l2_ref": None,
                "hedge_public_history_ref": None,
                "simulation_manifest_ref": None,
            }
        if request.exchange != "binance" or request.market_type != "futures":
            return {
                **base,
                "capability_state": "UNSUPPORTED_SOURCE_MODE",
                "reason": "BINANCE_USDM_REQUIRED",
                "coverage": None,
                "historical_l2_ref": None,
                "hedge_public_history_ref": None,
                "simulation_manifest_ref": None,
            }
        requested_end = requested_start + request.forward_cache_ms

        def read(
            connection: sqlite3.Connection,
        ) -> tuple[
            sqlite3.Row | None,
            sqlite3.Row | None,
            tuple[sqlite3.Row, ...],
            bool,
        ]:
            book = connection.execute(
                """
                SELECT * FROM replay_historical_book_archive
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND health = 'READY' AND coverage_state = 'EXACT'
                  AND continuity_state = 'CONTIGUOUS'
                  AND range_start_ms <= ? AND range_end_ms >= ?
                ORDER BY byte_size, range_start_ms DESC, archive_id
                LIMIT 1
                """,
                (
                    request.exchange,
                    request.market_type,
                    request.symbol,
                    requested_start,
                    requested_end,
                ),
            ).fetchone()
            public = None
            if request.book_mode.value == "BOOK_ASSISTED_REQUIRED" and book is not None:
                public = connection.execute(
                    """
                    SELECT * FROM replay_hedge_public_archive
                    WHERE exchange = ? AND market_type = ? AND symbol = ?
                      AND settlement_asset = ? AND health = 'READY'
                      AND range_start_ms <= ? AND range_end_ms >= ?
                      AND l2_archive_id = ? AND l2_dataset_epoch = ?
                      AND l2_checksum_sha256 = ?
                    ORDER BY byte_size, range_start_ms DESC, archive_id
                    LIMIT 1
                    """,
                    (
                        request.exchange,
                        request.market_type,
                        request.symbol,
                        request.settlement_asset,
                        requested_start,
                        requested_end,
                        book["archive_id"],
                        book["dataset_epoch"],
                        book["checksum_sha256"],
                    ),
                ).fetchone()
            elif request.book_mode.value == "OFF":
                public = connection.execute(
                    """
                    SELECT * FROM replay_hedge_public_archive
                    WHERE exchange = ? AND market_type = ? AND symbol = ?
                      AND settlement_asset = ? AND health = 'READY'
                      AND range_start_ms <= ? AND range_end_ms >= ?
                      AND (? = 'HISTORICAL_EXACT'
                           OR archive_id LIKE 'hybrid-public-%')
                    ORDER BY
                      CASE
                        WHEN archive_id LIKE 'hybrid-public-%' THEN 1
                        ELSE 0
                      END,
                      byte_size, range_start_ms DESC, archive_id
                    LIMIT 1
                    """,
                    (
                        request.exchange,
                        request.market_type,
                        request.symbol,
                        request.settlement_asset,
                        requested_start,
                        requested_end,
                        request.funding_mode.value,
                    ),
                ).fetchone()
            simulations = tuple(
                connection.execute(
                    """
                    SELECT * FROM replay_hedge_simulation_manifest
                    WHERE settlement_asset = ? AND health = 'READY'
                      AND range_start_ms <= ? AND range_end_ms >= ?
                    ORDER BY byte_size, range_start_ms DESC, manifest_id
                    """,
                    (request.settlement_asset, requested_start, requested_end),
                ).fetchall()
            )
            degraded = (
                connection.execute(
                    """
                    SELECT 1
                    FROM replay_hedge_public_archive
                    WHERE exchange = ? AND market_type = ? AND symbol = ?
                      AND settlement_asset = ? AND health != 'READY'
                    UNION ALL
                    SELECT 1
                    FROM replay_hedge_simulation_manifest
                    WHERE settlement_asset = ? AND health != 'READY'
                    LIMIT 1
                    """,
                    (
                        request.exchange,
                        request.market_type,
                        request.symbol,
                        request.settlement_asset,
                        request.settlement_asset,
                    ),
                ).fetchone()
                is not None
            )
            return book, public, simulations, degraded

        (
            book_row,
            public_row,
            simulation_rows,
            degraded,
        ) = await self.store.run_extension_read(read)

        def covers_requested_symbol(row: sqlite3.Row) -> bool:
            try:
                symbols = json.loads(str(row["required_symbols_json"]))
            except (TypeError, ValueError):
                return False
            return isinstance(symbols, list) and request.symbol in {
                str(symbol) for symbol in symbols
            }

        simulation_row = next(
            (row for row in simulation_rows if covers_requested_symbol(row)),
            None,
        )
        book_required = request.book_mode.value == "BOOK_ASSISTED_REQUIRED"
        if (
            (book_required and book_row is None)
            or public_row is None
            or simulation_row is None
        ):
            return {
                **base,
                "capability_state": (
                    "DEGRADED" if degraded else "UNSUPPORTED_NO_HISTORY"
                ),
                "reason": "NO_COMPLETE_CROSS_VERIFIED_INPUT_SET",
                "coverage": None,
                "historical_l2_ref": None,
                "hedge_public_history_ref": None,
                "simulation_manifest_ref": None,
            }
        try:
            public_path = await self._guard_catalog_row(
                public_row, source_kind="PUBLIC"
            )
            simulation_path = await self._guard_catalog_row(
                simulation_row, source_kind="SIMULATION"
            )
            public = await asyncio.to_thread(verify_hedge_public_history, public_path)
            simulation = await asyncio.to_thread(
                verify_hedge_simulation_manifest, simulation_path
            )
        except (OSError, TypeError, ValueError, TrainingRunError):
            return {
                **base,
                "capability_state": "DEGRADED",
                "reason": "INPUT_OBJECT_VERIFICATION_FAILED",
                "coverage": None,
                "historical_l2_ref": None,
                "hedge_public_history_ref": None,
                "simulation_manifest_ref": None,
            }
        expected_l2 = (
            {
                "archive_id": str(book_row["archive_id"]),
                "dataset_epoch": str(book_row["dataset_epoch"]),
                "checksum_sha256": str(book_row["checksum_sha256"]),
            }
            if book_required and book_row is not None
            else None
        )
        if (
            (book_required and public.historical_l2_ref != expected_l2)
            or public.archive_id != str(public_row["archive_id"])
            or public.dataset_epoch != str(public_row["dataset_epoch"])
            or public.checksum_sha256 != str(public_row["checksum_sha256"])
            or simulation.manifest_id != str(simulation_row["manifest_id"])
            or simulation.dataset_epoch != str(simulation_row["dataset_epoch"])
            or simulation.checksum_sha256 != str(simulation_row["checksum_sha256"])
            or simulation.contract_hash != str(simulation_row["contract_hash"])
            or request.symbol not in simulation.required_symbols
        ):
            return {
                **base,
                "capability_state": "DEGRADED",
                "reason": "INPUT_CATALOG_PROOF_MISMATCH",
                "coverage": None,
                "historical_l2_ref": None,
                "hedge_public_history_ref": None,
                "simulation_manifest_ref": None,
            }
        coverage_start = max(public.range_start_ms, simulation.range_start_ms)
        coverage_end = min(public.range_end_ms, simulation.range_end_ms)
        resolved_public_fidelity = public_input_fidelity(public)
        hybrid_public = resolved_public_fidelity == HYBRID_PUBLIC_INPUT_FIDELITY
        return {
            **base,
            "capability_state": (
                "AVAILABLE_APPROX" if hybrid_public else "AVAILABLE_EXACT"
            ),
            "reason": (
                "PINNED_HYBRID_PUBLIC_AND_SIMULATION_INPUTS"
                if hybrid_public
                else "CROSS_VERIFIED_PINNED_PUBLIC_AND_SIMULATION_INPUTS"
            ),
            "public_fidelity": resolved_public_fidelity,
            "fallback_applied": hybrid_public,
            "coverage": {
                "range_start_ms": coverage_start,
                "range_end_ms": coverage_end,
            },
            "historical_l2_ref": expected_l2,
            "hedge_public_history_ref": {
                "schema_version": REPLAY_HEDGE_PUBLIC_HISTORY_REF_SCHEMA_VERSION,
                "archive_id": public.archive_id,
                "dataset_epoch": public.dataset_epoch,
                "checksum_sha256": public.checksum_sha256,
            },
            "simulation_manifest_ref": {
                "schema_version": (REPLAY_HEDGE_SIMULATION_MANIFEST_REF_SCHEMA_VERSION),
                "manifest_id": simulation.manifest_id,
                "dataset_epoch": simulation.dataset_epoch,
                "checksum_sha256": simulation.checksum_sha256,
                "contract_hash": simulation.contract_hash,
                "model_version": simulation.model_version,
            },
        }

    async def fidelity_for_public_ref(self, ref: object) -> str:
        archive_id = getattr(ref, "archive_id", None)
        dataset_epoch = getattr(ref, "dataset_epoch", None)
        checksum_sha256 = getattr(ref, "checksum_sha256", None)
        if not isinstance(archive_id, str):
            raise TypeError("HEDGE public ref is invalid")
        row = await self.store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT * FROM replay_hedge_public_archive WHERE archive_id = ?",
                (archive_id,),
            ).fetchone()
        )
        if row is None:
            raise TrainingRunError(
                "HEDGE_PUBLIC_INPUT_NOT_FOUND",
                "the selected HEDGE public input is unavailable",
                status_code=409,
                details={"fallback_applied": False},
            )
        path = await self._guard_catalog_row(row, source_kind="PUBLIC")
        public = await asyncio.to_thread(verify_hedge_public_history, path)
        if (
            public.dataset_epoch != dataset_epoch
            or public.checksum_sha256 != checksum_sha256
        ):
            raise TrainingRunError(
                "HEDGE_PUBLIC_INPUT_REF_MISMATCH",
                "the selected HEDGE public input ref no longer matches",
                status_code=409,
                details={"fallback_applied": False},
            )
        return public_input_fidelity(public)

    def _ensure_dirs(self) -> None:
        for name in ("public", "simulation", "generated", ".tmp", ".quarantine"):
            (self.root / name).mkdir(parents=True, exist_ok=True)

    def _owned_path(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if path == self.root or not path.is_relative_to(self.root):
            raise ValueError("hedge input path escapes the owned object store")
        return path

    async def import_public(self, path: Path) -> dict[str, object]:
        return await self._import(path, source_kind="PUBLIC")

    async def import_simulation(self, path: Path) -> dict[str, object]:
        return await self._import(path, source_kind="SIMULATION")

    async def _import(self, path: Path, *, source_kind: str) -> dict[str, object]:
        async with self._lock:
            self._ensure_dirs()
            source = path.expanduser().resolve(strict=True)
            try:
                descriptor = await asyncio.to_thread(
                    verify_hedge_public_history
                    if source_kind == "PUBLIC"
                    else verify_hedge_simulation_manifest,
                    source,
                )
            except BaseException:
                quarantine = self._owned_path(
                    f".quarantine/{source_kind.lower()}-{uuid.uuid4().hex}.bad"
                )
                await asyncio.to_thread(shutil.copyfile, source, quarantine)
                raise
            object_id = (
                descriptor.archive_id
                if isinstance(descriptor, HedgePublicArchiveDescriptor)
                else descriptor.manifest_id
            )
            table = (
                "replay_hedge_public_archive"
                if source_kind == "PUBLIC"
                else "replay_hedge_simulation_manifest"
            )
            id_column = "archive_id" if source_kind == "PUBLIC" else "manifest_id"
            existing = await self.store.run_extension_read(
                lambda connection: connection.execute(
                    f"SELECT * FROM {table} WHERE {id_column} = ?",
                    (object_id,),
                ).fetchone()
            )
            if existing is not None:
                immutable_matches = (
                    str(existing["dataset_epoch"]) == descriptor.dataset_epoch
                    and str(existing["checksum_sha256"]) == descriptor.checksum_sha256
                    and str(existing["proof_hash"]) == descriptor.proof_hash
                    and (
                        not isinstance(descriptor, HedgePublicArchiveDescriptor)
                        or (
                            str(existing["event_chain_tail"])
                            == descriptor.event_chain_tail
                            and str(existing["exchange"]) == descriptor.exchange
                            and str(existing["market_type"]) == descriptor.market_type
                            and str(existing["symbol"]) == descriptor.symbol
                            and str(existing["settlement_asset"])
                            == descriptor.settlement_asset
                        )
                    )
                    and (
                        not isinstance(descriptor, HedgeSimulationDescriptor)
                        or (
                            str(existing["contract_hash"]) == descriptor.contract_hash
                            and str(existing["model_version"])
                            == descriptor.model_version
                            and str(existing["settlement_asset"])
                            == descriptor.settlement_asset
                        )
                    )
                )
                if not immutable_matches:
                    raise TrainingRunError(
                        "HEDGE_INPUT_IMMUTABLE_ID_CONFLICT",
                        "a HEDGE input id is already bound to different immutable content",
                        status_code=409,
                        details={"source_kind": source_kind, "fallback_applied": False},
                    )
                await self._guard_catalog_row(existing, source_kind=source_kind)
                return {
                    "source_kind": source_kind,
                    "object_id": object_id,
                    "dataset_epoch": descriptor.dataset_epoch,
                    "checksum_sha256": descriptor.checksum_sha256,
                    "proof_hash": descriptor.proof_hash,
                    "generation": int(existing["generation"]),
                    "health": "READY",
                    "idempotent": True,
                }
            relative = f"{source_kind.lower()}/{object_id}.json"
            final = self._owned_path(relative)
            temp = self._owned_path(f".tmp/{uuid.uuid4().hex}.part")
            await asyncio.to_thread(shutil.copyfile, source, temp)
            if _digest_file(temp) != descriptor.checksum_sha256:
                temp.unlink(missing_ok=True)
                raise TrainingRunError(
                    "HEDGE_INPUT_COPY_MISMATCH",
                    "hedge input changed while it was imported",
                    status_code=409,
                )
            os.replace(temp, final)
            now_ms = self.store._validated_now_ms()

            def write(connection: sqlite3.Connection) -> None:
                if isinstance(descriptor, HedgePublicArchiveDescriptor):
                    l2 = descriptor.historical_l2_ref
                    connection.execute(
                        """
                        INSERT INTO replay_hedge_public_archive(
                            archive_id, protocol, schema_version, exchange,
                            market_type, symbol, settlement_asset,
                            range_start_ms, range_end_ms, dataset_epoch,
                            checksum_sha256, event_chain_tail, proof_hash,
                            l2_archive_id, l2_dataset_epoch, l2_checksum_sha256,
                            event_count, byte_size, health, local_path,
                            trusted_source_path, trusted_origin, metadata_json,
                            quarantine_reason, generation, last_used_at_ms,
                            created_at_ms, updated_at_ms
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                                  ?, ?, 'READY', ?, ?, 'OPERATOR_VERIFIED_CAPTURE',
                                  ?, NULL, 1, ?, ?, ?)
                        """,
                        (
                            descriptor.archive_id,
                            PUBLIC_ARCHIVE_PROTOCOL,
                            PUBLIC_ARCHIVE_SCHEMA_VERSION,
                            descriptor.exchange,
                            descriptor.market_type,
                            descriptor.symbol,
                            descriptor.settlement_asset,
                            descriptor.range_start_ms,
                            descriptor.range_end_ms,
                            descriptor.dataset_epoch,
                            descriptor.checksum_sha256,
                            descriptor.event_chain_tail,
                            descriptor.proof_hash,
                            (
                                _NO_HISTORICAL_L2_ARCHIVE_ID
                                if l2 is None
                                else l2["archive_id"]
                            ),
                            _ROOT_HASH if l2 is None else l2["dataset_epoch"],
                            _ROOT_HASH if l2 is None else l2["checksum_sha256"],
                            descriptor.event_count,
                            descriptor.byte_size,
                            relative,
                            descriptor.source_path,
                            canonical_json(descriptor.metadata),
                            now_ms,
                            now_ms,
                            now_ms,
                        ),
                    )
                else:
                    assert isinstance(descriptor, HedgeSimulationDescriptor)
                    connection.execute(
                        """
                        INSERT INTO replay_hedge_simulation_manifest(
                            manifest_id, schema_version, model_version,
                            contract_hash, settlement_asset,
                            required_symbols_json, range_start_ms, range_end_ms,
                            dataset_epoch, checksum_sha256, proof_hash,
                            event_count, byte_size, health, local_path,
                            trusted_source_path, trusted_origin, metadata_json,
                            quarantine_reason, generation, last_used_at_ms,
                            created_at_ms, updated_at_ms
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY',
                                  ?, ?, 'OPERATOR_VERIFIED_SIMULATION', ?, NULL,
                                  1, ?, ?, ?)
                        """,
                        (
                            descriptor.manifest_id,
                            SIMULATION_MANIFEST_SCHEMA_VERSION,
                            descriptor.model_version,
                            descriptor.contract_hash,
                            descriptor.settlement_asset,
                            canonical_json(list(descriptor.required_symbols)),
                            descriptor.range_start_ms,
                            descriptor.range_end_ms,
                            descriptor.dataset_epoch,
                            descriptor.checksum_sha256,
                            descriptor.proof_hash,
                            descriptor.event_count,
                            descriptor.byte_size,
                            relative,
                            descriptor.source_path,
                            canonical_json(descriptor.metadata),
                            now_ms,
                            now_ms,
                            now_ms,
                        ),
                    )

            await self.store.run_extension_write(write)
            return {
                "source_kind": source_kind,
                "object_id": object_id,
                "dataset_epoch": descriptor.dataset_epoch,
                "checksum_sha256": descriptor.checksum_sha256,
                "proof_hash": descriptor.proof_hash,
                "health": "READY",
            }

    async def prepare_binding(
        self,
        *,
        request: TrainingRunCreateRequest,
        bound_range_start_ms: int,
        bound_range_end_ms: int,
        virtual_time_ms: int,
        historical_book_binding: PreparedHistoricalBookBinding | None,
    ) -> PreparedHedgeInputBinding:
        public_ref = request.hedge_public_history_ref
        simulation_ref = request.simulation_manifest_ref
        if public_ref is None or simulation_ref is None:
            raise TrainingRunError(
                "HEDGE_INPUT_REF_REQUIRED",
                "HEDGE run requires pinned public and simulation refs",
                status_code=409,
                details={"fallback_applied": False},
            )

        def read(
            connection: sqlite3.Connection,
        ) -> tuple[sqlite3.Row | None, sqlite3.Row | None]:
            return (
                connection.execute(
                    "SELECT * FROM replay_hedge_public_archive WHERE archive_id = ?",
                    (public_ref.archive_id,),
                ).fetchone(),
                connection.execute(
                    "SELECT * FROM replay_hedge_simulation_manifest WHERE manifest_id = ?",
                    (simulation_ref.manifest_id,),
                ).fetchone(),
            )

        public_row, simulation_row = await self.store.run_extension_read(read)
        if public_row is None or simulation_row is None:
            raise TrainingRunError(
                "HEDGE_INPUT_UNAVAILABLE",
                "a pinned HEDGE input object is not imported",
                status_code=409,
                details={"fallback_applied": False},
            )
        public_path = await self._guard_catalog_row(public_row, source_kind="PUBLIC")
        simulation_path = await self._guard_catalog_row(
            simulation_row, source_kind="SIMULATION"
        )
        public = await asyncio.to_thread(verify_hedge_public_history, public_path)
        simulation = await asyncio.to_thread(
            verify_hedge_simulation_manifest, simulation_path
        )
        if (
            public_ref.dataset_epoch != public.dataset_epoch
            or public_ref.checksum_sha256 != public.checksum_sha256
            or simulation_ref.dataset_epoch != simulation.dataset_epoch
            or simulation_ref.checksum_sha256 != simulation.checksum_sha256
            or simulation_ref.contract_hash != simulation.contract_hash
            or simulation_ref.model_version != simulation.model_version
        ):
            raise TrainingRunError(
                "HEDGE_INPUT_REF_MISMATCH",
                "a HEDGE input ref does not match the imported immutable object",
                status_code=409,
                details={"fallback_applied": False},
            )
        if (
            request.exchange != public.exchange
            or request.market_type != public.market_type
            or request.symbol != public.symbol
            or request.settlement_asset != public.settlement_asset
            or request.settlement_asset != simulation.settlement_asset
            or request.symbol not in simulation.required_symbols
            or bound_range_start_ms < public.range_start_ms
            or bound_range_end_ms > public.range_end_ms
            or bound_range_start_ms < simulation.range_start_ms
            or bound_range_end_ms > simulation.range_end_ms
        ):
            raise TrainingRunError(
                "HEDGE_INPUT_COVERAGE_MISMATCH",
                "pinned HEDGE inputs do not cover the requested market and time range",
                status_code=409,
                details={"fallback_applied": False},
            )
        if request.book_mode.value == "BOOK_ASSISTED_REQUIRED":
            if historical_book_binding is None:
                raise TrainingRunError(
                    "HEDGE_HISTORICAL_BOOK_REQUIRED",
                    "BOOK_ASSISTED_REQUIRED HEDGE simulation requires pinned historical L2",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            book = historical_book_binding.descriptor
            if public.historical_l2_ref != {
                "archive_id": book.archive_id,
                "dataset_epoch": book.dataset_epoch,
                "checksum_sha256": book.checksum_sha256,
            }:
                raise TrainingRunError(
                    "HEDGE_L2_REF_MISMATCH",
                    "public archive L2 ref differs from the verified book binding",
                    status_code=409,
                    details={"fallback_applied": False},
                )
        elif historical_book_binding is not None:
            raise TrainingRunError(
                "HEDGE_UNEXPECTED_HISTORICAL_BOOK_BINDING",
                "book_mode OFF cannot carry a historical L2 binding",
                status_code=409,
                details={"fallback_applied": False},
            )
        public_events = await asyncio.to_thread(_read_public_events, public_path)
        simulation_events = await asyncio.to_thread(
            _read_simulation_events, simulation_path
        )
        public_projection = _projection(
            public_events,
            source_kind="PUBLIC",
            actual_time_ms=bound_range_start_ms,
            virtual_time_ms=virtual_time_ms,
        )
        simulation_projection = _projection(
            simulation_events,
            source_kind="SIMULATION",
            actual_time_ms=bound_range_start_ms,
            virtual_time_ms=virtual_time_ms,
        )
        if not {"rule", "fee_policy", "mark_index"}.issubset(
            public_projection.state
        ) or not {"insurance", "adl_snapshots"}.issubset(simulation_projection.state):
            raise TrainingRunError(
                "HEDGE_INPUT_INITIAL_STATE_MISSING",
                "pinned HEDGE inputs lack a complete no-lookahead start projection",
                status_code=409,
                details={"fallback_applied": False},
            )
        proof = canonical_sha256(
            {
                "schema_version": HEDGE_INPUT_PROOF_SCHEMA_VERSION,
                "public": {
                    "archive_id": public.archive_id,
                    "generation": int(public_row["generation"]),
                    "dataset_epoch": public.dataset_epoch,
                    "checksum_sha256": public.checksum_sha256,
                    "event_chain_tail": public.event_chain_tail,
                    "proof_hash": public.proof_hash,
                },
                "simulation": {
                    "manifest_id": simulation.manifest_id,
                    "generation": int(simulation_row["generation"]),
                    "dataset_epoch": simulation.dataset_epoch,
                    "checksum_sha256": simulation.checksum_sha256,
                    "contract_hash": simulation.contract_hash,
                    "proof_hash": simulation.proof_hash,
                },
                "bound_range_start_ms": bound_range_start_ms,
                "bound_range_end_ms": bound_range_end_ms,
            }
        )
        return PreparedHedgeInputBinding(
            public=public,
            simulation=simulation,
            public_generation=int(public_row["generation"]),
            simulation_generation=int(simulation_row["generation"]),
            public_projection=public_projection,
            simulation_projection=simulation_projection,
            bound_range_start_ms=bound_range_start_ms,
            bound_range_end_ms=bound_range_end_ms,
            input_proof_hash=proof,
        )

    async def prepare_track_public_binding(
        self,
        *,
        run_id: str,
        track_id: str,
        exchange: str,
        market_type: str,
        symbol: str,
        settlement_asset: str,
        bound_range_start_ms: int,
        bound_range_end_ms: int,
        actual_time_ms: int,
        virtual_time_ms: int,
        historical_book_binding: PreparedHistoricalBookBinding | None,
    ) -> PreparedHedgeTrackPublicBinding | None:
        """Resolve and pin the exact public archive for one added HEDGE track."""

        def read(connection: sqlite3.Connection) -> dict[str, object]:
            existing = connection.execute(
                """
                SELECT * FROM replay_hedge_track_public_binding
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            run_binding = connection.execute(
                "SELECT * FROM replay_hedge_input_binding WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            simulation = (
                None
                if run_binding is None
                else connection.execute(
                    """
                    SELECT * FROM replay_hedge_simulation_manifest
                    WHERE manifest_id = ?
                    """,
                    (run_binding["simulation_manifest_id"],),
                ).fetchone()
            )
            if historical_book_binding is None:
                candidates = tuple(
                    connection.execute(
                        """
                        SELECT * FROM replay_hedge_public_archive
                        WHERE exchange = ? AND market_type = ? AND symbol = ?
                          AND settlement_asset = ? AND health = 'READY'
                          AND range_start_ms <= ? AND range_end_ms >= ?
                        ORDER BY (range_end_ms - range_start_ms), archive_id
                        """,
                        (
                            exchange,
                            market_type,
                            symbol,
                            settlement_asset,
                            bound_range_start_ms,
                            bound_range_end_ms,
                        ),
                    ).fetchall()
                )
            else:
                candidates = tuple(
                    connection.execute(
                        """
                        SELECT * FROM replay_hedge_public_archive
                        WHERE exchange = ? AND market_type = ? AND symbol = ?
                          AND settlement_asset = ? AND health = 'READY'
                          AND range_start_ms <= ? AND range_end_ms >= ?
                          AND l2_archive_id = ? AND l2_dataset_epoch = ?
                          AND l2_checksum_sha256 = ?
                        ORDER BY (range_end_ms - range_start_ms), archive_id
                        """,
                        (
                            exchange,
                            market_type,
                            symbol,
                            settlement_asset,
                            bound_range_start_ms,
                            bound_range_end_ms,
                            historical_book_binding.descriptor.archive_id,
                            historical_book_binding.descriptor.dataset_epoch,
                            historical_book_binding.descriptor.checksum_sha256,
                        ),
                    ).fetchall()
                )
            return {
                "existing": existing,
                "run_binding": run_binding,
                "simulation": simulation,
                "candidates": candidates,
            }

        rows = await self.store.run_extension_read(read)
        existing = rows["existing"]
        if isinstance(existing, sqlite3.Row):
            if existing["status"] != "ACTIVE":
                raise TrainingRunError(
                    "HEDGE_TRACK_INPUT_PAUSED",
                    "the track public HEDGE input is not active",
                    status_code=409,
                    details={"track_id": track_id, "fallback_applied": False},
                )
            return None
        run_binding = rows["run_binding"]
        simulation_row = rows["simulation"]
        if not isinstance(run_binding, sqlite3.Row) or not isinstance(
            simulation_row, sqlite3.Row
        ):
            raise TrainingRunError(
                "HEDGE_INPUT_BINDING_MISSING",
                "the account-level HEDGE simulation binding is missing",
                status_code=409,
                details={"track_id": track_id, "fallback_applied": False},
            )
        simulation_path = await self._guard_catalog_row(
            simulation_row, source_kind="SIMULATION"
        )
        simulation = await asyncio.to_thread(
            verify_hedge_simulation_manifest, simulation_path
        )
        if (
            simulation.settlement_asset != settlement_asset
            or symbol not in simulation.required_symbols
            or bound_range_start_ms < simulation.range_start_ms
            or bound_range_end_ms > simulation.range_end_ms
        ):
            raise TrainingRunError(
                "HEDGE_TRACK_SIMULATION_COVERAGE_MISMATCH",
                "the pinned simulation manifest does not cover the added symbol",
                status_code=409,
                details={
                    "track_id": track_id,
                    "symbol": symbol,
                    "fallback_applied": False,
                },
            )
        candidates = rows["candidates"]
        if not isinstance(candidates, tuple) or not candidates:
            raise TrainingRunError(
                "HEDGE_TRACK_PUBLIC_INPUT_UNAVAILABLE",
                "no exact public HEDGE archive matches the track input policy",
                status_code=409,
                details={
                    "track_id": track_id,
                    "symbol": symbol,
                    "fallback_applied": False,
                },
            )
        public_row = candidates[0]
        if not isinstance(public_row, sqlite3.Row):
            raise TypeError("HEDGE public catalog row is invalid")
        public_path = await self._guard_catalog_row(public_row, source_kind="PUBLIC")
        public = await asyncio.to_thread(verify_hedge_public_history, public_path)
        if (
            public.exchange != exchange
            or public.market_type != market_type
            or public.symbol != symbol
            or public.settlement_asset != settlement_asset
        ):
            raise TrainingRunError(
                "HEDGE_TRACK_PUBLIC_INPUT_MISMATCH",
                "resolved public HEDGE input differs from the requested track",
                status_code=409,
                details={"track_id": track_id, "fallback_applied": False},
            )
        if historical_book_binding is not None:
            book = historical_book_binding.descriptor
            if public.historical_l2_ref != {
                "archive_id": book.archive_id,
                "dataset_epoch": book.dataset_epoch,
                "checksum_sha256": book.checksum_sha256,
            }:
                raise TrainingRunError(
                    "HEDGE_TRACK_L2_REF_MISMATCH",
                    "resolved public HEDGE input differs from the verified L2 binding",
                    status_code=409,
                    details={"track_id": track_id, "fallback_applied": False},
                )
        public_events = await asyncio.to_thread(_read_public_events, public_path)
        projection = _projection(
            public_events,
            source_kind="PUBLIC",
            actual_time_ms=actual_time_ms,
            virtual_time_ms=virtual_time_ms,
        )
        if not {"rule", "fee_policy", "mark_index"}.issubset(projection.state):
            raise TrainingRunError(
                "HEDGE_TRACK_PUBLIC_INITIAL_STATE_MISSING",
                "track public archive lacks a complete no-lookahead projection",
                status_code=409,
                details={"track_id": track_id, "fallback_applied": False},
            )
        generation = int(public_row["generation"])
        return PreparedHedgeTrackPublicBinding(
            public=public,
            public_generation=generation,
            public_projection=projection,
            bound_range_start_ms=bound_range_start_ms,
            bound_range_end_ms=bound_range_end_ms,
            input_proof_hash=hedge_track_public_proof_hash(
                run_id=run_id,
                track_id=track_id,
                public=public,
                public_generation=generation,
                bound_range_start_ms=bound_range_start_ms,
                bound_range_end_ms=bound_range_end_ms,
            ),
        )

    async def _guard_catalog_row(self, row: sqlite3.Row, *, source_kind: str) -> Path:
        if row["health"] != "READY" or not isinstance(row["local_path"], str):
            raise TrainingRunError(
                "HEDGE_INPUT_QUARANTINED",
                "pinned HEDGE input is not ready",
                status_code=409,
                details={"source_kind": source_kind, "fallback_applied": False},
            )
        path = self._owned_path(str(row["local_path"]))
        if not path.is_file() or _digest_file(path) != row["checksum_sha256"]:
            raise TrainingRunError(
                "HEDGE_INPUT_OBJECT_MISSING_OR_TAMPERED",
                "pinned HEDGE input is missing or changed",
                status_code=409,
                details={"source_kind": source_kind, "fallback_applied": False},
            )
        return path

    async def _cached_verified_events(
        self,
        *,
        source_kind: str,
        path: Path,
        checksum_sha256: str,
    ) -> tuple[HedgeInputEvent, ...]:
        """Reuse parsed immutable events after the runtime checksum guard passes.

        ``_guard_catalog_row`` hashes the owned object on every access, so this
        cache cannot hide a post-start mutation.  The cache only avoids parsing,
        canonical validation, and a second file digest for bytes that just
        matched the checksum pinned in SQLite.
        """

        key = (source_kind, str(path), checksum_sha256)
        cached = self._verified_event_cache.get(key)
        if cached is not None:
            return cached
        reader = (
            _read_public_events if source_kind == "PUBLIC" else _read_simulation_events
        )
        events = await asyncio.to_thread(reader, path)
        if len(self._verified_event_cache) >= 64:
            self._verified_event_cache.pop(next(iter(self._verified_event_cache)))
        self._verified_event_cache[key] = events
        return events

    async def _binding_rows(
        self, run_id: str
    ) -> tuple[sqlite3.Row, sqlite3.Row, sqlite3.Row]:
        def read(
            connection: sqlite3.Connection,
        ) -> tuple[sqlite3.Row | None, sqlite3.Row | None, sqlite3.Row | None]:
            binding = connection.execute(
                "SELECT * FROM replay_hedge_input_binding WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if binding is None:
                return None, None, None
            public = connection.execute(
                "SELECT * FROM replay_hedge_public_archive WHERE archive_id = ?",
                (binding["public_archive_id"],),
            ).fetchone()
            simulation = connection.execute(
                "SELECT * FROM replay_hedge_simulation_manifest WHERE manifest_id = ?",
                (binding["simulation_manifest_id"],),
            ).fetchone()
            return binding, public, simulation

        binding, public, simulation = await self.store.run_extension_read(read)
        if binding is None or public is None or simulation is None:
            raise TrainingRunError(
                "HEDGE_INPUT_BINDING_MISSING",
                "HEDGE input binding is missing",
                status_code=409,
                details={"fallback_applied": False},
            )
        return binding, public, simulation

    async def _runtime_events(self, run_id: str) -> HedgeInputRuntimeSnapshot:
        binding, _primary_public_row, simulation_row = await self._binding_rows(run_id)
        if binding["status"] != "ACTIVE":
            raise TrainingRunError(
                "HEDGE_INPUT_PAUSED",
                "HEDGE input binding is paused",
                status_code=409,
                details={"fallback_applied": False},
            )
        try:
            simulation_path = await self._guard_catalog_row(
                simulation_row, source_kind="SIMULATION"
            )
            if (
                int(binding["simulation_generation"])
                != int(simulation_row["generation"])
                or binding["simulation_checksum_sha256"]
                != simulation_row["checksum_sha256"]
            ):
                raise ValueError("pinned HEDGE input generation changed")
            track_rows, full_track_ids = await self.store.run_extension_read(
                lambda connection: (
                    tuple(
                        connection.execute(
                            """
                            SELECT track_binding.*, archive.*
                            FROM replay_hedge_track_public_binding AS track_binding
                            JOIN replay_training_market_track AS track
                              ON track.run_id = track_binding.run_id
                             AND track.track_id = track_binding.track_id
                            JOIN replay_hedge_public_archive AS archive
                              ON archive.archive_id = track_binding.public_archive_id
                            WHERE track_binding.run_id = ?
                              AND track.subscription_tier = 'FULL'
                            ORDER BY track_binding.track_id
                            """,
                            (run_id,),
                        ).fetchall()
                    ),
                    tuple(
                        str(row["track_id"])
                        for row in connection.execute(
                            """
                            SELECT track_id FROM replay_training_market_track
                            WHERE run_id = ? AND subscription_tier = 'FULL'
                            ORDER BY track_id
                            """,
                            (run_id,),
                        ).fetchall()
                    ),
                )
            )
            bound_ids = tuple(str(row["track_id"]) for row in track_rows)
            if bound_ids != full_track_ids:
                raise ValueError("every HEDGE FULL track must have one public binding")
            public_events: list[HedgeInputEvent] = []
            for row in track_rows:
                if (
                    row["status"] != "ACTIVE"
                    or row["health"] != "READY"
                    or int(row["public_generation"]) != int(row["generation"])
                    or row["public_checksum_sha256"] != row["checksum_sha256"]
                    or row["public_event_chain_tail"] != row["event_chain_tail"]
                ):
                    raise ValueError("pinned track public input changed")
                path = await self._guard_catalog_row(row, source_kind="PUBLIC")
                events = await self._cached_verified_events(
                    source_kind="PUBLIC",
                    path=path,
                    checksum_sha256=str(row["checksum_sha256"]),
                )
                public_events.extend(
                    replace(event, track_id=str(row["track_id"])) for event in events
                )
            return (
                tuple(public_events),
                await self._cached_verified_events(
                    source_kind="SIMULATION",
                    path=simulation_path,
                    checksum_sha256=str(simulation_row["checksum_sha256"]),
                ),
            )
        except BaseException as exc:
            await self.pause_run(run_id, reason=type(exc).__name__)
            if isinstance(exc, TrainingRunError):
                raise
            raise TrainingRunError(
                "HEDGE_INPUT_DEGRADED",
                "pinned HEDGE input failed its runtime guard",
                status_code=409,
                details={"fallback_applied": False},
            ) from exc

    async def runtime_snapshot(self, run_id: str) -> HedgeInputRuntimeSnapshot:
        """Verify every pinned object once for one atomic coordinator command."""

        return await self._runtime_events(run_id)

    async def pause_run(self, run_id: str, *, reason: str) -> None:
        now_ms = self.store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                UPDATE replay_hedge_input_binding
                SET status = 'PAUSED', degraded_reason = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (reason, now_ms, run_id),
            )
            connection.execute(
                """
                UPDATE replay_hedge_track_public_binding
                SET status = 'PAUSED', degraded_reason = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (reason, now_ms, run_id),
            )
            connection.execute(
                """
                UPDATE replay_training_run
                SET state = 'PAUSED', compatibility = 'INPUT_PAUSED',
                    updated_at_ms = ? WHERE run_id = ?
                """,
                (now_ms, run_id),
            )

        await self.store.run_extension_write(write)

    async def next_event_time(
        self,
        *,
        run_id: str,
        target_actual_time_ms: int,
        runtime_snapshot: HedgeInputRuntimeSnapshot | None = None,
    ) -> int | None:
        public, simulation = (
            await self._runtime_events(run_id)
            if runtime_snapshot is None
            else runtime_snapshot
        )

        def read(connection: sqlite3.Connection) -> tuple[dict[str, int], int]:
            public_cursors = {
                str(row["track_id"]): int(row["last_event_sequence"])
                for row in connection.execute(
                    """
                    SELECT track_id, last_event_sequence
                    FROM replay_hedge_track_public_projection WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchall()
            }
            simulation = connection.execute(
                """
                SELECT last_event_sequence FROM replay_hedge_input_projection
                WHERE run_id = ? AND source_kind = 'SIMULATION'
                """,
                (run_id,),
            ).fetchone()
            if simulation is None:
                raise TypeError("HEDGE simulation projection is missing")
            return public_cursors, int(simulation["last_event_sequence"])

        public_cursors, simulation_cursor = await self.store.run_extension_read(read)
        candidates = [
            event.event_time_ms
            for event in public
            if event.track_id is not None
            and event.event_sequence > public_cursors.get(event.track_id, 0)
            and event.event_time_ms <= target_actual_time_ms
        ]
        candidates.extend(
            event.event_time_ms
            for event in simulation
            if event.event_sequence > simulation_cursor
            and event.event_time_ms <= target_actual_time_ms
        )
        return min(candidates) if candidates else None

    async def events_at(
        self,
        *,
        run_id: str,
        actual_time_ms: int,
        runtime_snapshot: HedgeInputRuntimeSnapshot | None = None,
    ) -> tuple[HedgeInputEvent, ...]:
        public, simulation = (
            await self._runtime_events(run_id)
            if runtime_snapshot is None
            else runtime_snapshot
        )

        def read(connection: sqlite3.Connection) -> tuple[dict[str, int], int]:
            public_cursors = {
                str(row["track_id"]): int(row["last_event_sequence"])
                for row in connection.execute(
                    """
                    SELECT track_id, last_event_sequence
                    FROM replay_hedge_track_public_projection WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchall()
            }
            simulation_row = connection.execute(
                """
                SELECT last_event_sequence FROM replay_hedge_input_projection
                WHERE run_id = ? AND source_kind = 'SIMULATION'
                """,
                (run_id,),
            ).fetchone()
            if simulation_row is None:
                raise TypeError("HEDGE simulation projection is missing")
            return public_cursors, int(simulation_row["last_event_sequence"])

        public_cursors, simulation_cursor = await self.store.run_extension_read(read)
        return tuple(
            sorted(
                (
                    event
                    for event in (*public, *simulation)
                    if (
                        event.event_sequence
                        > (
                            public_cursors.get(event.track_id, 0)
                            if event.source_kind == "PUBLIC"
                            and event.track_id is not None
                            else simulation_cursor
                        )
                        and event.event_time_ms == actual_time_ms
                    )
                ),
                key=lambda event: (
                    event.event_time_ms,
                    event.event_phase,
                    event.stable_track_id,
                    event.event_sequence,
                ),
            )
        )

    async def audit_run(self, run_id: str) -> dict[str, object]:
        """Independently rebuild the pinned input proof, cursors, and receipts."""

        initial_binding = await self.store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT 1 FROM replay_hedge_input_binding WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        )
        if initial_binding is None:
            return {
                "schema_version": HEDGE_INPUT_AUDIT_SCHEMA_VERSION,
                "status": "NOT_APPLICABLE",
                "proof_hash": None,
                "differences": [],
            }

        differences: list[dict[str, object]] = []

        def difference(field: str, expected: object, actual: object) -> None:
            differences.append({"field": field, "expected": expected, "actual": actual})

        binding, public_row, simulation_row = await self._binding_rows(run_id)
        sources: dict[str, tuple[HedgeInputEvent, ...]] = {}
        try:
            public_path = await self._guard_catalog_row(
                public_row, source_kind="PUBLIC"
            )
            simulation_path = await self._guard_catalog_row(
                simulation_row, source_kind="SIMULATION"
            )
            sources = {
                "PUBLIC": await asyncio.to_thread(_read_public_events, public_path),
                "SIMULATION": await asyncio.to_thread(
                    _read_simulation_events, simulation_path
                ),
            }
        except (OSError, TypeError, ValueError, TrainingRunError) as exc:
            difference("owned_input_guard", "VALID_PINNED_OBJECTS", type(exc).__name__)

        rows = await self.store.run_extension_read(
            lambda connection: {
                "projections": tuple(
                    connection.execute(
                        """
                        SELECT * FROM replay_hedge_input_projection
                        WHERE run_id = ? ORDER BY source_kind
                        """,
                        (run_id,),
                    ).fetchall()
                ),
                "applied": tuple(
                    connection.execute(
                        """
                        SELECT * FROM replay_hedge_input_applied_event
                        WHERE run_id = ? ORDER BY source_kind, event_sequence
                        """,
                        (run_id,),
                    ).fetchall()
                ),
            }
        )
        expected_proof = canonical_sha256(
            {
                "schema_version": HEDGE_INPUT_PROOF_SCHEMA_VERSION,
                "public": {
                    "archive_id": str(public_row["archive_id"]),
                    "generation": int(public_row["generation"]),
                    "dataset_epoch": str(public_row["dataset_epoch"]),
                    "checksum_sha256": str(public_row["checksum_sha256"]),
                    "event_chain_tail": str(public_row["event_chain_tail"]),
                    "proof_hash": str(public_row["proof_hash"]),
                },
                "simulation": {
                    "manifest_id": str(simulation_row["manifest_id"]),
                    "generation": int(simulation_row["generation"]),
                    "dataset_epoch": str(simulation_row["dataset_epoch"]),
                    "checksum_sha256": str(simulation_row["checksum_sha256"]),
                    "contract_hash": str(simulation_row["contract_hash"]),
                    "proof_hash": str(simulation_row["proof_hash"]),
                },
                "bound_range_start_ms": int(binding["bound_range_start_ms"]),
                "bound_range_end_ms": int(binding["bound_range_end_ms"]),
            }
        )
        binding_checks = {
            "input_proof_hash": expected_proof,
            "public_generation": int(public_row["generation"]),
            "public_dataset_epoch": str(public_row["dataset_epoch"]),
            "public_checksum_sha256": str(public_row["checksum_sha256"]),
            "public_event_chain_tail": str(public_row["event_chain_tail"]),
            "simulation_generation": int(simulation_row["generation"]),
            "simulation_dataset_epoch": str(simulation_row["dataset_epoch"]),
            "simulation_checksum_sha256": str(simulation_row["checksum_sha256"]),
            "simulation_contract_hash": str(simulation_row["contract_hash"]),
        }
        for field, expected in binding_checks.items():
            actual = binding[field]
            if str(actual) != str(expected):
                difference(f"binding.{field}", expected, actual)

        projection_rows = {str(row["source_kind"]): row for row in rows["projections"]}
        applied_rows: dict[str, list[sqlite3.Row]] = {
            "PUBLIC": [],
            "SIMULATION": [],
        }
        for row in rows["applied"]:
            applied_rows.setdefault(str(row["source_kind"]), []).append(row)
        source_ids = {
            "PUBLIC": str(binding["public_archive_id"]),
            "SIMULATION": str(binding["simulation_manifest_id"]),
        }
        projection_snapshot: list[dict[str, object]] = []
        for source_kind in ("PUBLIC", "SIMULATION"):
            projection_row = projection_rows.get(source_kind)
            if projection_row is None:
                difference(f"projection.{source_kind}", "PRESENT", "MISSING")
                continue
            try:
                state = json.loads(str(projection_row["state_json"]))
                payload = {
                    "schema_version": "replay.hedge-input-projection.v1",
                    "source_kind": source_kind,
                    "last_event_sequence": int(projection_row["last_event_sequence"]),
                    "as_of_actual_time_ms": int(projection_row["as_of_actual_time_ms"]),
                    "as_of_virtual_time_ms": int(
                        projection_row["as_of_virtual_time_ms"]
                    ),
                    "state": state,
                    "input_chain_hash": str(projection_row["input_chain_hash"]),
                }
                component_hash = canonical_sha256(payload)
                if component_hash != projection_row["component_hash"]:
                    difference(
                        f"projection.{source_kind}.component_hash",
                        component_hash,
                        projection_row["component_hash"],
                    )
                source_events = sources.get(source_kind)
                if source_events is not None:
                    expected_projection = _projection(
                        source_events,
                        source_kind=source_kind,
                        actual_time_ms=int(projection_row["as_of_actual_time_ms"]),
                        virtual_time_ms=int(projection_row["as_of_virtual_time_ms"]),
                    )
                    for field, expected, actual in (
                        (
                            "last_event_sequence",
                            expected_projection.last_event_sequence,
                            projection_row["last_event_sequence"],
                        ),
                        (
                            "input_chain_hash",
                            expected_projection.input_chain_hash,
                            projection_row["input_chain_hash"],
                        ),
                        ("state", dict(expected_projection.state), state),
                    ):
                        if expected != actual:
                            difference(
                                f"projection.{source_kind}.{field}",
                                expected,
                                actual,
                            )
                    initial_sequence = max(
                        (
                            event.event_sequence
                            for event in source_events
                            if event.event_time_ms
                            <= int(binding["bound_range_start_ms"])
                        ),
                        default=0,
                    )
                    expected_applied = [
                        event
                        for event in source_events
                        if initial_sequence
                        < event.event_sequence
                        <= int(projection_row["last_event_sequence"])
                    ]
                    actual_applied = applied_rows.get(source_kind, [])
                    if [event.event_sequence for event in expected_applied] != [
                        int(row["event_sequence"]) for row in actual_applied
                    ]:
                        difference(
                            f"applied.{source_kind}.sequences",
                            [event.event_sequence for event in expected_applied],
                            [int(row["event_sequence"]) for row in actual_applied],
                        )
                    by_sequence = {
                        event.event_sequence: event for event in source_events
                    }
                    for row in actual_applied:
                        event = by_sequence.get(int(row["event_sequence"]))
                        if event is None:
                            difference(
                                f"applied.{source_kind}.{row['event_sequence']}",
                                "SOURCE_EVENT",
                                "MISSING",
                            )
                            continue
                        stored_payload = json.loads(str(row["payload_json"]))
                        expected_applied_hash = canonical_sha256(
                            {
                                "run_id": run_id,
                                "virtual_time_ms": int(row["applied_virtual_time_ms"]),
                                "source_kind": source_kind,
                                "source_id": source_ids[source_kind],
                                "event_sequence": event.event_sequence,
                                "event_hash": event.event_hash,
                                "payload": dict(event.payload),
                            }
                        )
                        if (
                            int(row["event_time_ms"]) != event.event_time_ms
                            or int(row["event_phase"]) != event.event_phase
                            or str(row["event_kind"]) != event.event_kind
                            or int(row["component_sequence"])
                            != event.component_sequence
                            or str(row["source_event_hash"]) != event.event_hash
                            or stored_payload != dict(event.payload)
                            or str(row["applied_payload_hash"]) != expected_applied_hash
                        ):
                            difference(
                                f"applied.{source_kind}.{event.event_sequence}",
                                "MATCHING_SOURCE_RECEIPT",
                                "MISMATCH",
                            )
                projection_snapshot.append(
                    {
                        "source_kind": source_kind,
                        "last_event_sequence": int(
                            projection_row["last_event_sequence"]
                        ),
                        "as_of_actual_time_ms": int(
                            projection_row["as_of_actual_time_ms"]
                        ),
                        "as_of_virtual_time_ms": int(
                            projection_row["as_of_virtual_time_ms"]
                        ),
                        "input_chain_hash": str(projection_row["input_chain_hash"]),
                        "component_hash": str(projection_row["component_hash"]),
                        "applied_event_count": len(applied_rows.get(source_kind, [])),
                    }
                )
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                difference(
                    f"projection.{source_kind}",
                    "VALID_RECONSTRUCTABLE_PROJECTION",
                    type(exc).__name__,
                )
        track_inputs = await self.store.run_extension_read(
            lambda connection: {
                "full_track_ids": tuple(
                    str(row["track_id"])
                    for row in connection.execute(
                        """
                        SELECT track_id FROM replay_training_market_track
                        WHERE run_id = ? AND subscription_tier = 'FULL'
                        ORDER BY track_id
                        """,
                        (run_id,),
                    ).fetchall()
                ),
                "bindings": tuple(
                    connection.execute(
                        """
                        SELECT track_binding.*, archive.proof_hash,
                               archive.health, archive.local_path,
                               archive.generation, archive.checksum_sha256,
                               archive.event_chain_tail
                        FROM replay_hedge_track_public_binding AS track_binding
                        JOIN replay_training_market_track AS track
                          ON track.run_id = track_binding.run_id
                         AND track.track_id = track_binding.track_id
                        JOIN replay_hedge_public_archive AS archive
                          ON archive.archive_id = track_binding.public_archive_id
                        WHERE track_binding.run_id = ?
                          AND track.subscription_tier = 'FULL'
                        ORDER BY track_binding.track_id
                        """,
                        (run_id,),
                    ).fetchall()
                ),
                "projections": tuple(
                    connection.execute(
                        """
                        SELECT * FROM replay_hedge_track_public_projection
                        WHERE run_id = ? ORDER BY track_id
                        """,
                        (run_id,),
                    ).fetchall()
                ),
                "applied": tuple(
                    connection.execute(
                        """
                        SELECT * FROM replay_hedge_track_public_applied_event
                        WHERE run_id = ? ORDER BY track_id, event_sequence
                        """,
                        (run_id,),
                    ).fetchall()
                ),
            }
        )
        track_bindings = {str(row["track_id"]): row for row in track_inputs["bindings"]}
        if tuple(sorted(track_bindings)) != track_inputs["full_track_ids"]:
            difference(
                "track_public_bindings",
                list(track_inputs["full_track_ids"]),
                sorted(track_bindings),
            )
        track_projections = {
            str(row["track_id"]): row for row in track_inputs["projections"]
        }
        track_applied: dict[str, list[sqlite3.Row]] = {}
        for row in track_inputs["applied"]:
            track_applied.setdefault(str(row["track_id"]), []).append(row)
        track_projection_snapshot: list[dict[str, object]] = []
        for track_id, track_binding in track_bindings.items():
            try:
                path = await self._guard_catalog_row(
                    track_binding, source_kind="PUBLIC"
                )
                descriptor = await asyncio.to_thread(verify_hedge_public_history, path)
                expected_track_proof = hedge_track_public_proof_hash(
                    run_id=run_id,
                    track_id=track_id,
                    public=descriptor,
                    public_generation=int(track_binding["public_generation"]),
                    bound_range_start_ms=int(track_binding["bound_range_start_ms"]),
                    bound_range_end_ms=int(track_binding["bound_range_end_ms"]),
                )
                if str(track_binding["input_proof_hash"]) != expected_track_proof:
                    difference(
                        f"track_binding.{track_id}.input_proof_hash",
                        expected_track_proof,
                        track_binding["input_proof_hash"],
                    )
                for field, expected in (
                    ("public_generation", int(track_binding["generation"])),
                    ("public_checksum_sha256", descriptor.checksum_sha256),
                    ("public_event_chain_tail", descriptor.event_chain_tail),
                ):
                    if str(track_binding[field]) != str(expected):
                        difference(
                            f"track_binding.{track_id}.{field}",
                            expected,
                            track_binding[field],
                        )
                projection_row = track_projections.get(track_id)
                if projection_row is None:
                    difference(f"track_projection.{track_id}", "PRESENT", "MISSING")
                    continue
                state = json.loads(str(projection_row["state_json"]))
                projection_payload = {
                    "schema_version": "replay.hedge-track-public-projection.v1",
                    "run_id": run_id,
                    "track_id": track_id,
                    "last_event_sequence": int(projection_row["last_event_sequence"]),
                    "as_of_actual_time_ms": int(projection_row["as_of_actual_time_ms"]),
                    "as_of_virtual_time_ms": int(
                        projection_row["as_of_virtual_time_ms"]
                    ),
                    "state": state,
                    "input_chain_hash": str(projection_row["input_chain_hash"]),
                }
                expected_component = canonical_sha256(projection_payload)
                if str(projection_row["component_hash"]) != expected_component:
                    difference(
                        f"track_projection.{track_id}.component_hash",
                        expected_component,
                        projection_row["component_hash"],
                    )
                events = await asyncio.to_thread(_read_public_events, path)
                expected_projection = _projection(
                    events,
                    source_kind="PUBLIC",
                    actual_time_ms=int(projection_row["as_of_actual_time_ms"]),
                    virtual_time_ms=int(projection_row["as_of_virtual_time_ms"]),
                )
                for field, expected, actual in (
                    (
                        "last_event_sequence",
                        expected_projection.last_event_sequence,
                        int(projection_row["last_event_sequence"]),
                    ),
                    (
                        "input_chain_hash",
                        expected_projection.input_chain_hash,
                        str(projection_row["input_chain_hash"]),
                    ),
                    ("state", dict(expected_projection.state), state),
                ):
                    if expected != actual:
                        difference(
                            f"track_projection.{track_id}.{field}", expected, actual
                        )
                initial_sequence = max(
                    (
                        event.event_sequence
                        for event in events
                        if event.event_time_ms
                        <= int(track_binding["bound_range_start_ms"])
                    ),
                    default=0,
                )
                expected_events = [
                    event
                    for event in events
                    if initial_sequence
                    < event.event_sequence
                    <= int(projection_row["last_event_sequence"])
                ]
                receipts = track_applied.get(track_id, [])
                if [event.event_sequence for event in expected_events] != [
                    int(row["event_sequence"]) for row in receipts
                ]:
                    difference(
                        f"track_applied.{track_id}.sequences",
                        [event.event_sequence for event in expected_events],
                        [int(row["event_sequence"]) for row in receipts],
                    )
                by_sequence = {event.event_sequence: event for event in events}
                for receipt in receipts:
                    event = by_sequence.get(int(receipt["event_sequence"]))
                    if event is None:
                        difference(
                            f"track_applied.{track_id}.{receipt['event_sequence']}",
                            "SOURCE_EVENT",
                            "MISSING",
                        )
                        continue
                    expected_hash = canonical_sha256(
                        {
                            "run_id": run_id,
                            "track_id": track_id,
                            "virtual_time_ms": int(receipt["applied_virtual_time_ms"]),
                            "source_kind": "PUBLIC",
                            "source_id": descriptor.archive_id,
                            "event_sequence": event.event_sequence,
                            "event_hash": event.event_hash,
                            "payload": dict(event.payload),
                        }
                    )
                    if (
                        int(receipt["event_time_ms"]) != event.event_time_ms
                        or int(receipt["event_phase"]) != event.event_phase
                        or str(receipt["event_kind"]) != event.event_kind
                        or int(receipt["component_sequence"])
                        != event.component_sequence
                        or str(receipt["source_event_hash"]) != event.event_hash
                        or json.loads(str(receipt["payload_json"]))
                        != dict(event.payload)
                        or str(receipt["applied_payload_hash"]) != expected_hash
                    ):
                        difference(
                            f"track_applied.{track_id}.{event.event_sequence}",
                            "MATCHING_SOURCE_RECEIPT",
                            "MISMATCH",
                        )
                track_projection_snapshot.append(
                    {
                        "track_id": track_id,
                        "public_archive_id": descriptor.archive_id,
                        "last_event_sequence": int(
                            projection_row["last_event_sequence"]
                        ),
                        "input_chain_hash": str(projection_row["input_chain_hash"]),
                        "component_hash": str(projection_row["component_hash"]),
                        "applied_event_count": len(receipts),
                    }
                )
            except (
                OSError,
                KeyError,
                TypeError,
                ValueError,
                json.JSONDecodeError,
                TrainingRunError,
            ) as exc:
                difference(
                    f"track_projection.{track_id}",
                    "VALID_RECONSTRUCTABLE_PROJECTION",
                    type(exc).__name__,
                )
        status = "PASS" if not differences else "FAIL"
        snapshot = {
            "schema_version": HEDGE_INPUT_AUDIT_SCHEMA_VERSION,
            "run_id": run_id,
            "input_proof_hash": str(binding["input_proof_hash"]),
            "public_archive_id": str(binding["public_archive_id"]),
            "simulation_manifest_id": str(binding["simulation_manifest_id"]),
            "projections": projection_snapshot,
            "track_public_projections": track_projection_snapshot,
        }
        proof_hash = canonical_sha256(
            {
                "schema_version": HEDGE_INPUT_AUDIT_SCHEMA_VERSION,
                "status": status,
                "snapshot": snapshot,
                "differences": differences,
            }
        )
        now_ms = self.store._validated_now_ms()

        def write_audit(connection: sqlite3.Connection) -> None:
            sequence = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(audit_sequence), 0) + 1
                    FROM replay_hedge_input_audit WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
            connection.execute(
                """
                INSERT INTO replay_hedge_input_audit(
                    run_id, audit_sequence, schema_version, status,
                    proof_hash, differences_json, snapshot_json, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    sequence,
                    HEDGE_INPUT_AUDIT_SCHEMA_VERSION,
                    status,
                    proof_hash,
                    canonical_json(differences),
                    canonical_json(snapshot),
                    now_ms,
                ),
            )

        await self.store.run_extension_write(write_audit)
        if status == "FAIL":
            await self.pause_run(run_id, reason="HEDGE_INPUT_AUDIT_FAILED")
        return {
            "schema_version": HEDGE_INPUT_AUDIT_SCHEMA_VERSION,
            "status": status,
            "proof_hash": proof_hash,
            "differences": differences,
            "snapshot": snapshot,
        }

    async def rehydrate(self, *, source_kind: str, object_id: str) -> dict[str, object]:
        if source_kind not in {"PUBLIC", "SIMULATION"}:
            raise ValueError("source_kind must be PUBLIC or SIMULATION")
        table = (
            "replay_hedge_public_archive"
            if source_kind == "PUBLIC"
            else "replay_hedge_simulation_manifest"
        )
        id_column = "archive_id" if source_kind == "PUBLIC" else "manifest_id"
        row = await self.store.run_extension_read(
            lambda connection: connection.execute(
                f"SELECT * FROM {table} WHERE {id_column} = ?", (object_id,)
            ).fetchone()
        )
        if row is None:
            raise TrainingRunError(
                "HEDGE_INPUT_NOT_FOUND", "HEDGE input does not exist", status_code=404
            )
        trusted = Path(str(row["trusted_source_path"])).resolve(strict=True)
        descriptor = await asyncio.to_thread(
            verify_hedge_public_history
            if source_kind == "PUBLIC"
            else verify_hedge_simulation_manifest,
            trusted,
        )
        if (
            descriptor.checksum_sha256 != row["checksum_sha256"]
            or descriptor.dataset_epoch != row["dataset_epoch"]
        ):
            await self._quarantine_catalog(
                source_kind, object_id, "REHYDRATION_MISMATCH"
            )
            raise TrainingRunError(
                "HEDGE_INPUT_REHYDRATION_MISMATCH",
                "trusted HEDGE input no longer matches its pinned receipt",
                status_code=409,
                details={"fallback_applied": False},
            )
        relative = f"{source_kind.lower()}/{object_id}.json"
        final = self._owned_path(relative)
        temp = self._owned_path(f".tmp/{uuid.uuid4().hex}.part")
        await asyncio.to_thread(shutil.copyfile, trusted, temp)
        os.replace(temp, final)
        now_ms = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                f"""
                UPDATE {table} SET health = 'READY', local_path = ?,
                    quarantine_reason = NULL, updated_at_ms = ?
                WHERE {id_column} = ?
                """,
                (relative, now_ms, object_id),
            )
        )
        return {
            "source_kind": source_kind,
            "object_id": object_id,
            "checksum_sha256": descriptor.checksum_sha256,
            "dataset_epoch": descriptor.dataset_epoch,
            "health": "READY",
        }

    async def _quarantine_catalog(
        self, source_kind: str, object_id: str, reason: str
    ) -> None:
        table = (
            "replay_hedge_public_archive"
            if source_kind == "PUBLIC"
            else "replay_hedge_simulation_manifest"
        )
        id_column = "archive_id" if source_kind == "PUBLIC" else "manifest_id"
        now_ms = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                f"""
                UPDATE {table} SET health = 'QUARANTINED', local_path = NULL,
                    quarantine_reason = ?, updated_at_ms = ?
                WHERE {id_column} = ?
                """,
                (reason, now_ms, object_id),
            )
        )


__all__ = [
    "HEDGE_INPUT_PROOF_SCHEMA_VERSION",
    "HedgeInputArchiveManager",
    "HedgeInputEvent",
    "HedgeInputProjection",
    "HedgePublicArchiveDescriptor",
    "HedgeSimulationDescriptor",
    "PreparedHedgeInputBinding",
    "PUBLIC_ARCHIVE_PROTOCOL",
    "PUBLIC_ARCHIVE_SCHEMA_VERSION",
    "HYBRID_PUBLIC_INPUT_FIDELITY",
    "PUBLIC_INPUT_FIDELITY",
    "SIMULATION_INPUT_FIDELITY",
    "build_hedge_public_history_archive",
    "build_hedge_simulation_manifest",
    "bind_hedge_inputs",
    "runtime_hedge_rule",
    "validate_hedge_public_history",
    "verify_hedge_public_history",
    "verify_hedge_simulation_manifest",
]
