"""Deterministic Decimal rules for replay.v2 contract-account projections."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, localcontext
from typing import Mapping

from app.replay.broker.models import canonical_decimal, decimal_to_string
from app.replay.canonical import canonical_sha256
from app.replay.models import validate_identifier, validate_timestamp_ms


CONTRACT_ACCOUNT_MODEL = "TOUCH_OR_TAPE_V2"
CONTRACT_ACCOUNT_SCHEMA_VERSION = "replay.training.portfolio.v2"
CONTRACT_RULE_VERSION = "CANDLESCOPE_LINEAR_CONTRACT_V1"
CONTRACT_LEDGER_CHAIN_VERSION = "replay.training.contract-ledger.v1"
APPROXIMATE_RULE_FIDELITY = "AVAILABLE_APPROX_SIMULATION_RULES"
CONFIGURED_FEE_FIDELITY = "CONFIGURED_POLICY_EXACT"
SANDBOX_FUNDING_FIDELITY = "AVAILABLE_APPROX_SANDBOX_FIXED"


def _mapping(value: object, *, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field_name} must be an object")
    return value


def _canonical_non_negative(value: object, *, field_name: str) -> str:
    return canonical_decimal(
        value,
        field_name=field_name,
        nonnegative=True,
    )


def _canonical_positive(value: object, *, field_name: str) -> str:
    return canonical_decimal(
        value,
        field_name=field_name,
        positive=True,
    )


def round_to_step(value: Decimal, step: Decimal, *, upward: bool) -> Decimal:
    if not value.is_finite() or value < 0:
        raise ValueError("value must be finite and non-negative")
    if not step.is_finite() or step <= 0:
        raise ValueError("step must be finite and positive")
    with localcontext() as context:
        context.prec = 60
        units = (value / step).to_integral_value(
            rounding=ROUND_CEILING if upward else ROUND_FLOOR
        )
        return units * step


@dataclass(frozen=True, slots=True)
class MaintenanceTier:
    notional_cap: str
    maintenance_rate: str
    maintenance_deduction: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "notional_cap",
            _canonical_positive(self.notional_cap, field_name="notional_cap"),
        )
        object.__setattr__(
            self,
            "maintenance_rate",
            _canonical_non_negative(
                self.maintenance_rate,
                field_name="maintenance_rate",
            ),
        )
        object.__setattr__(
            self,
            "maintenance_deduction",
            _canonical_non_negative(
                self.maintenance_deduction,
                field_name="maintenance_deduction",
            ),
        )
        if Decimal(self.maintenance_rate) >= 1:
            raise ValueError("maintenance_rate must be less than one")

    def to_dict(self) -> dict[str, str]:
        return {
            "notional_cap": self.notional_cap,
            "maintenance_rate": self.maintenance_rate,
            "maintenance_deduction": self.maintenance_deduction,
        }

    @classmethod
    def from_mapping(cls, value: object) -> "MaintenanceTier":
        payload = _mapping(value, field_name="maintenance tier")
        if set(payload) != {
            "notional_cap",
            "maintenance_rate",
            "maintenance_deduction",
        }:
            raise ValueError("maintenance tier fields do not match the contract")
        return cls(**payload)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class InstrumentRule:
    track_id: str
    rule_version: str
    source_kind: str
    price_tick: str
    quantity_step: str
    min_quantity: str
    max_quantity: str
    min_notional: str
    max_notional: str
    quote_step: str
    contract_size: str
    max_leverage: str
    liquidation_fee_bps: str
    maintenance_tiers: tuple[MaintenanceTier, ...]
    mark_fidelity: str
    rule_fidelity: str
    effective_virtual_time_ms: int

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "track_id",
            validate_identifier(self.track_id, field_name="track_id"),
        )
        object.__setattr__(
            self,
            "rule_version",
            validate_identifier(self.rule_version, field_name="rule_version"),
        )
        if self.source_kind not in {"BAR", "AGG_TRADE"}:
            raise ValueError("source_kind is unsupported")
        for field_name in (
            "price_tick",
            "quantity_step",
            "min_quantity",
            "max_quantity",
            "min_notional",
            "max_notional",
            "quote_step",
            "contract_size",
            "max_leverage",
        ):
            object.__setattr__(
                self,
                field_name,
                _canonical_positive(
                    getattr(self, field_name),
                    field_name=field_name,
                ),
            )
        object.__setattr__(
            self,
            "liquidation_fee_bps",
            _canonical_non_negative(
                self.liquidation_fee_bps,
                field_name="liquidation_fee_bps",
            ),
        )
        if Decimal(self.min_quantity) > Decimal(self.max_quantity):
            raise ValueError("instrument quantity bounds are inverted")
        if Decimal(self.min_notional) > Decimal(self.max_notional):
            raise ValueError("instrument notional bounds are inverted")
        raw_tiers = self.maintenance_tiers
        if not isinstance(raw_tiers, (tuple, list)) or not raw_tiers:
            raise ValueError("maintenance_tiers must be non-empty")
        tiers = tuple(
            tier
            if isinstance(tier, MaintenanceTier)
            else MaintenanceTier.from_mapping(tier)
            for tier in raw_tiers
        )
        previous = Decimal(0)
        for tier in tiers:
            cap = Decimal(tier.notional_cap)
            if cap <= previous:
                raise ValueError("maintenance tier caps must strictly increase")
            previous = cap
        if previous < Decimal(self.max_notional):
            raise ValueError("maintenance tiers do not cover max_notional")
        object.__setattr__(self, "maintenance_tiers", tiers)
        for field_name in ("mark_fidelity", "rule_fidelity"):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )
        object.__setattr__(
            self,
            "effective_virtual_time_ms",
            validate_timestamp_ms(
                self.effective_virtual_time_ms,
                field_name="effective_virtual_time_ms",
            ),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "track_id": self.track_id,
            "rule_version": self.rule_version,
            "source_kind": self.source_kind,
            "price_tick": self.price_tick,
            "quantity_step": self.quantity_step,
            "min_quantity": self.min_quantity,
            "max_quantity": self.max_quantity,
            "min_notional": self.min_notional,
            "max_notional": self.max_notional,
            "quote_step": self.quote_step,
            "contract_size": self.contract_size,
            "max_leverage": self.max_leverage,
            "liquidation_fee_bps": self.liquidation_fee_bps,
            "maintenance_tiers": [tier.to_dict() for tier in self.maintenance_tiers],
            "mark_fidelity": self.mark_fidelity,
            "rule_fidelity": self.rule_fidelity,
            "effective_virtual_time_ms": self.effective_virtual_time_ms,
        }

    @property
    def rule_hash(self) -> str:
        return canonical_sha256(self.to_dict())

    @classmethod
    def from_mapping(cls, value: object) -> "InstrumentRule":
        payload = dict(_mapping(value, field_name="instrument rule"))
        expected = {
            "track_id",
            "rule_version",
            "source_kind",
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
            "mark_fidelity",
            "rule_fidelity",
            "effective_virtual_time_ms",
        }
        if set(payload) != expected:
            raise ValueError("instrument rule fields do not match the contract")
        raw_tiers = payload["maintenance_tiers"]
        if not isinstance(raw_tiers, list):
            raise TypeError("maintenance_tiers must be an array")
        payload["maintenance_tiers"] = tuple(
            MaintenanceTier.from_mapping(tier) for tier in raw_tiers
        )
        return cls(**payload)  # type: ignore[arg-type]

    def maintenance_margin(self, notional: Decimal) -> Decimal:
        if not notional.is_finite() or notional < 0:
            raise ValueError("notional must be finite and non-negative")
        tier = next(
            (
                candidate
                for candidate in self.maintenance_tiers
                if notional <= Decimal(candidate.notional_cap)
            ),
            None,
        )
        if tier is None:
            raise ValueError("notional exceeds the versioned maintenance tiers")
        with localcontext() as context:
            context.prec = 60
            maintenance = (
                notional * Decimal(tier.maintenance_rate)
                - Decimal(tier.maintenance_deduction)
            )
        return max(Decimal(0), maintenance)

    def liquidation_fee(self, notional: Decimal) -> Decimal:
        with localcontext() as context:
            context.prec = 60
            raw = notional * Decimal(self.liquidation_fee_bps) / Decimal(10_000)
        return round_to_step(raw, Decimal(self.quote_step), upward=True)


def instrument_rule_from_broker_config(
    *,
    track_id: str,
    source_kind: str,
    broker_config: Mapping[str, object],
    effective_virtual_time_ms: int,
) -> InstrumentRule:
    instrument = _mapping(
        broker_config.get("instrument"),
        field_name="broker instrument",
    )
    limits = _mapping(broker_config.get("limits"), field_name="broker limits")
    maximum = Decimal(str(instrument["max_notional"]))
    first_cap = min(maximum, Decimal("50000"))
    tiers = [MaintenanceTier(decimal_to_string(first_cap, field_name="tier cap"), "0.005", "0")]
    if maximum > first_cap:
        tiers.append(
            MaintenanceTier(
                decimal_to_string(maximum, field_name="tier cap"),
                "0.01",
                decimal_to_string(
                    first_cap * Decimal("0.005"),
                    field_name="tier deduction",
                ),
            )
        )
    return InstrumentRule(
        track_id=track_id,
        rule_version=CONTRACT_RULE_VERSION,
        source_kind=source_kind,
        price_tick=str(instrument["price_tick"]),
        quantity_step=str(instrument["quantity_step"]),
        min_quantity=str(instrument["min_quantity"]),
        max_quantity=str(instrument["max_quantity"]),
        min_notional=str(instrument["min_notional"]),
        max_notional=str(instrument["max_notional"]),
        quote_step=str(instrument["quote_step"]),
        contract_size="1",
        max_leverage=str(limits["max_leverage"]),
        liquidation_fee_bps="50",
        maintenance_tiers=tuple(tiers),
        mark_fidelity=(
            "REVEALED_BAR_CLOSE_PROXY"
            if source_kind == "BAR"
            else "REVEALED_AGG_TRADE_PROXY"
        ),
        rule_fidelity=APPROXIMATE_RULE_FIDELITY,
        effective_virtual_time_ms=effective_virtual_time_ms,
    )


def fee_for_notional(
    *,
    notional: Decimal,
    liquidity: str,
    maker_bps: object,
    taker_bps: object,
    quote_step: object,
) -> Decimal:
    if notional < 0 or not notional.is_finite():
        raise ValueError("notional must be finite and non-negative")
    if liquidity not in {"MAKER", "TAKER", "SYNTHETIC"}:
        raise ValueError("liquidity is unsupported")
    maker = Decimal(_canonical_non_negative(maker_bps, field_name="maker_bps"))
    taker = Decimal(_canonical_non_negative(taker_bps, field_name="taker_bps"))
    step = Decimal(_canonical_positive(quote_step, field_name="quote_step"))
    bps = maker if liquidity == "MAKER" else taker
    with localcontext() as context:
        context.prec = 60
        raw = notional * bps / Decimal(10_000)
    return round_to_step(raw, step, upward=True)


def ledger_chain_hash(
    *,
    previous_hash: str,
    ledger_sequence: int,
    posting: Mapping[str, object],
) -> str:
    if not isinstance(previous_hash, str) or not previous_hash.startswith("sha256:"):
        raise ValueError("previous_hash must be a sha256 digest")
    if isinstance(ledger_sequence, bool) or ledger_sequence < 1:
        raise ValueError("ledger_sequence must be positive")
    return canonical_sha256(
        {
            "schema_version": CONTRACT_LEDGER_CHAIN_VERSION,
            "previous_hash": previous_hash,
            "ledger_sequence": ledger_sequence,
            "posting": dict(posting),
        }
    )


def initial_ledger_hash(*, run_id: str, initial_equity: str, asset: str) -> str:
    return canonical_sha256(
        {
            "schema_version": CONTRACT_LEDGER_CHAIN_VERSION,
            "run_id": validate_identifier(run_id, field_name="run_id"),
            "initial_equity": _canonical_positive(
                initial_equity,
                field_name="initial_equity",
            ),
            "asset": validate_identifier(asset, field_name="asset"),
        }
    )


__all__ = [
    "APPROXIMATE_RULE_FIDELITY",
    "CONFIGURED_FEE_FIDELITY",
    "CONTRACT_ACCOUNT_MODEL",
    "CONTRACT_ACCOUNT_SCHEMA_VERSION",
    "CONTRACT_LEDGER_CHAIN_VERSION",
    "CONTRACT_RULE_VERSION",
    "InstrumentRule",
    "MaintenanceTier",
    "SANDBOX_FUNDING_FIDELITY",
    "fee_for_notional",
    "initial_ledger_hash",
    "instrument_rule_from_broker_config",
    "ledger_chain_hash",
    "round_to_step",
]
