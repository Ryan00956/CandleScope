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
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from app.replay.broker.models import canonical_decimal
from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.models import validate_identifier, validate_timestamp_ms
from app.replay.storage import ReplaySQLiteStore

from .account import MaintenanceTier
from .errors import TrainingRunError
from .hedge_simulation_contract import (
    MODEL_VERSION,
    SIMULATION_MANIFEST_SCHEMA_VERSION,
    contract_hash,
    validate_simulation_manifest,
)
from .historical_book import PreparedHistoricalBookBinding
from .models import TrainingRunCreateRequest


PUBLIC_ARCHIVE_PROTOCOL = "replay.hedge-public-history.archive.v1"
PUBLIC_ARCHIVE_SCHEMA_VERSION = "replay.hedge-public-history.v1"
PUBLIC_EVENT_SCHEMA_VERSION = "replay.hedge-public-history.event.v1"
SIMULATION_EVENT_SCHEMA_VERSION = "replay.hedge-simulation-input.event.v1"
HEDGE_INPUT_PROOF_SCHEMA_VERSION = "replay.hedge-input-binding.v1"
HEDGE_INPUT_AUDIT_SCHEMA_VERSION = "replay.hedge-input-audit.v1"
PUBLIC_INPUT_FIDELITY = "PINNED_HISTORICAL_PUBLIC_INPUT"
SIMULATION_INPUT_FIDELITY = "VERSIONED_DETERMINISTIC_SIMULATION"
_ROOT_HASH = "sha256:" + "0" * 64
_DIGEST_LENGTH = 71

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


def _l2_ref(value: object) -> dict[str, str]:
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
    historical_l2_ref: Mapping[str, object],
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
    historical_l2_ref: Mapping[str, str]
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

    @property
    def stable_track_id(self) -> str:
        return f"hedge-{self.source_kind.lower()}:{self.source_id}"


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


def runtime_hedge_rule(
    payload: Mapping[str, object],
    *,
    track_id: str,
    source_kind: str,
    effective_virtual_time_ms: int,
) -> dict[str, object]:
    rule = _rule_payload(payload)
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
        "mark_fidelity": "PINNED_HISTORICAL_MARK_INDEX",
        "rule_fidelity": "PINNED_HISTORICAL_EXCHANGE_RULE",
        "effective_virtual_time_ms": effective_virtual_time_ms,
    }


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
    public_state = binding.public_projection.state
    rule = public_state.get("rule")
    fee = public_state.get("fee_policy")
    mark = public_state.get("mark_index")
    if (
        not isinstance(rule, Mapping)
        or not isinstance(fee, Mapping)
        or not isinstance(mark, Mapping)
    ):
        raise TypeError("HEDGE public start projection is incomplete")
    runtime_rule = runtime_hedge_rule(
        rule,
        track_id=track_id,
        source_kind=source_kind,
        effective_virtual_time_ms=virtual_time_ms,
    )
    connection.execute(
        "DELETE FROM replay_training_instrument_rule WHERE run_id = ? AND track_id = ?",
        (run_id, track_id),
    )
    connection.execute(
        """
        INSERT INTO replay_training_instrument_rule(
            run_id, track_id, revision, effective_virtual_time_ms,
            rule_json, rule_hash, fidelity, created_at_ms
        ) VALUES (?, ?, 1, ?, ?, ?, 'PINNED_HISTORICAL_EXCHANGE_RULE', ?)
        """,
        (
            run_id,
            track_id,
            virtual_time_ms,
            canonical_json(runtime_rule),
            canonical_sha256(runtime_rule),
            now_ms,
        ),
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
        "fidelity": "PINNED_HISTORICAL_FEE_POLICY",
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
        ) VALUES (?, 1, ?, ?, ?, ?, 'PINNED_HISTORICAL_FEE_POLICY',
                  'HEDGE public input T0', ?)
        """,
        (
            run_id,
            virtual_time_ms,
            fee["maker_fee_bps"],
            fee["taker_fee_bps"],
            canonical_sha256(fee_policy),
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
        SET fidelity = 'PINNED_PUBLIC_INPUT_MODELLED_HEDGE_ACCOUNT',
            updated_at_ms = ? WHERE run_id = ?
        """,
        (now_ms, run_id),
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
                    "HISTORICAL_MARK_INDEX": "AVAILABLE_PINNED",
                    "HISTORICAL_INSTRUMENT_RULE": "AVAILABLE_PINNED",
                    "HISTORICAL_FEE_POLICY": "AVAILABLE_PINNED",
                    "HISTORICAL_FUNDING": "AVAILABLE_PINNED",
                    "HISTORICAL_L2": "AVAILABLE_PINNED_CONTINUITY_GATED",
                    "SIMULATED_INSURANCE_FUND": "AVAILABLE_MATERIALIZED",
                    "SIMULATED_ADL_COHORT": "AVAILABLE_MATERIALIZED",
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

    async def start(self) -> None:
        await asyncio.to_thread(self._ensure_dirs)

    def _ensure_dirs(self) -> None:
        for name in ("public", "simulation", ".tmp", ".quarantine"):
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
                            l2["archive_id"],
                            l2["dataset_epoch"],
                            l2["checksum_sha256"],
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
        if historical_book_binding is None:
            raise TrainingRunError(
                "HEDGE_HISTORICAL_BOOK_REQUIRED",
                "HEDGE deterministic simulation requires pinned historical L2",
                status_code=409,
                details={"fallback_applied": False},
            )
        book = historical_book_binding.descriptor
        if dict(public.historical_l2_ref) != {
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

    async def _runtime_events(
        self, run_id: str
    ) -> tuple[tuple[HedgeInputEvent, ...], tuple[HedgeInputEvent, ...]]:
        binding, public_row, simulation_row = await self._binding_rows(run_id)
        if binding["status"] != "ACTIVE":
            raise TrainingRunError(
                "HEDGE_INPUT_PAUSED",
                "HEDGE input binding is paused",
                status_code=409,
                details={"fallback_applied": False},
            )
        try:
            public_path = await self._guard_catalog_row(
                public_row, source_kind="PUBLIC"
            )
            simulation_path = await self._guard_catalog_row(
                simulation_row, source_kind="SIMULATION"
            )
            if (
                int(binding["public_generation"]) != int(public_row["generation"])
                or int(binding["simulation_generation"])
                != int(simulation_row["generation"])
                or binding["public_checksum_sha256"] != public_row["checksum_sha256"]
                or binding["simulation_checksum_sha256"]
                != simulation_row["checksum_sha256"]
            ):
                raise ValueError("pinned HEDGE input generation changed")
            return (
                await asyncio.to_thread(_read_public_events, public_path),
                await asyncio.to_thread(_read_simulation_events, simulation_path),
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
                UPDATE replay_training_run
                SET state = 'PAUSED', compatibility = 'INPUT_PAUSED',
                    updated_at_ms = ? WHERE run_id = ?
                """,
                (now_ms, run_id),
            )

        await self.store.run_extension_write(write)

    async def next_event_time(
        self, *, run_id: str, target_actual_time_ms: int
    ) -> int | None:
        public, simulation = await self._runtime_events(run_id)

        def read(connection: sqlite3.Connection) -> dict[str, int]:
            return {
                str(row["source_kind"]): int(row["last_event_sequence"])
                for row in connection.execute(
                    """
                    SELECT source_kind, last_event_sequence
                    FROM replay_hedge_input_projection WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchall()
            }

        cursors = await self.store.run_extension_read(read)
        candidates = [
            event.event_time_ms
            for events in (public, simulation)
            for event in events
            if event.event_sequence > cursors.get(event.source_kind, 0)
            and event.event_time_ms <= target_actual_time_ms
        ]
        return min(candidates) if candidates else None

    async def events_at(
        self, *, run_id: str, actual_time_ms: int
    ) -> tuple[HedgeInputEvent, ...]:
        public, simulation = await self._runtime_events(run_id)

        def read(connection: sqlite3.Connection) -> dict[str, int]:
            return {
                str(row["source_kind"]): int(row["last_event_sequence"])
                for row in connection.execute(
                    """
                    SELECT source_kind, last_event_sequence
                    FROM replay_hedge_input_projection WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchall()
            }

        cursors = await self.store.run_extension_read(read)
        return tuple(
            sorted(
                (
                    event
                    for events in (public, simulation)
                    for event in events
                    if event.event_sequence > cursors.get(event.source_kind, 0)
                    and event.event_time_ms == actual_time_ms
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
        status = "PASS" if not differences else "FAIL"
        snapshot = {
            "schema_version": HEDGE_INPUT_AUDIT_SCHEMA_VERSION,
            "run_id": run_id,
            "input_proof_hash": str(binding["input_proof_hash"]),
            "public_archive_id": str(binding["public_archive_id"]),
            "simulation_manifest_id": str(binding["simulation_manifest_id"]),
            "projections": projection_snapshot,
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
