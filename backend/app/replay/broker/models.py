"""Immutable Decimal domain models for conservative replay execution."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, localcontext
from enum import Enum
from typing import Mapping, TypeVar

from ..models import normalize_decimal_string, validate_counter, validate_identifier


BAR_BROKER_MODEL_VERSION = "BAR_CONSERVATIVE_V1"
AGG_TRADE_TAPE_MODEL_VERSION = "AGG_TRADE_TAPE_V1"
BAR_TOUCH_OR_TAPE_MODEL_VERSION = "BAR_TOUCH_OR_TAPE_V2"
AGG_TRADE_TOUCH_OR_TAPE_MODEL_VERSION = "AGG_TRADE_TOUCH_OR_TAPE_V2"
PAPER_LINEAR_EXECUTION_MODE = "paper_linear_v1"
TOUCH_OR_TAPE_EXECUTION_MODE = "touch_or_tape_v2"
SUPPORTED_BROKER_MODEL_VERSIONS = frozenset(
    {
        BAR_BROKER_MODEL_VERSION,
        AGG_TRADE_TAPE_MODEL_VERSION,
        BAR_TOUCH_OR_TAPE_MODEL_VERSION,
        AGG_TRADE_TOUCH_OR_TAPE_MODEL_VERSION,
    }
)
# Backward-compatible public name for the original BAR model.
BROKER_MODEL_VERSION = BAR_BROKER_MODEL_VERSION

_EnumT = TypeVar("_EnumT", bound=Enum)


class _StringEnum(str, Enum):
    def __str__(self) -> str:
        return self.value


class OrderSide(_StringEnum):
    BUY = "BUY"
    SELL = "SELL"

    @property
    def sign(self) -> Decimal:
        return Decimal(1) if self is OrderSide.BUY else Decimal(-1)

    @property
    def opposite(self) -> "OrderSide":
        return OrderSide.SELL if self is OrderSide.BUY else OrderSide.BUY


class OrderType(_StringEnum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"
    STOP_MARKET = "STOP_MARKET"
    TAKE_PROFIT_MARKET = "TAKE_PROFIT_MARKET"


class OrderStatus(_StringEnum):
    NEW = "NEW"
    OPEN = "OPEN"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    CANCELED = "CANCELED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"

    @property
    def terminal(self) -> bool:
        return self in {
            OrderStatus.FILLED,
            OrderStatus.CANCELED,
            OrderStatus.REJECTED,
            OrderStatus.EXPIRED,
        }


class LiquidityRole(_StringEnum):
    MAKER = "MAKER"
    TAKER = "TAKER"
    SYNTHETIC = "SYNTHETIC"


class FillReason(_StringEnum):
    MARKET_NEXT_OPEN = "MARKET_NEXT_OPEN"
    LIMIT_TOUCH = "LIMIT_TOUCH"
    LIMIT_GAP = "LIMIT_GAP"
    STOP_TRIGGER = "STOP_TRIGGER"
    TAKE_PROFIT_TRIGGER = "TAKE_PROFIT_TRIGGER"
    SESSION_END_MARK_CLOSE = "SESSION_END_MARK_CLOSE"
    MARKET_TAPE = "MARKET_TAPE"
    LIMIT_STRICT_CROSS = "LIMIT_STRICT_CROSS"
    STOP_TAPE_TRIGGER = "STOP_TAPE_TRIGGER"
    TAKE_PROFIT_TAPE_TRIGGER = "TAKE_PROFIT_TAPE_TRIGGER"
    MARKET_REVEALED_REFERENCE = "MARKET_REVEALED_REFERENCE"
    LIMIT_MARKETABLE_REVEALED = "LIMIT_MARKETABLE_REVEALED"
    STOP_REVEALED_TRIGGER = "STOP_REVEALED_TRIGGER"
    TAKE_PROFIT_REVEALED_TRIGGER = "TAKE_PROFIT_REVEALED_TRIGGER"


class WarningCode(_StringEnum):
    AMBIGUOUS_INTRABAR_WORST_CASE = "AMBIGUOUS_INTRABAR_WORST_CASE"
    ENTRY_EXIT_SAME_BAR_WORST_CASE = "ENTRY_EXIT_SAME_BAR_WORST_CASE"
    MARGIN_BREACH_NO_LIQUIDATION = "MARGIN_BREACH_NO_LIQUIDATION"


class LedgerAccount(_StringEnum):
    CASH = "CASH"
    INITIAL_CAPITAL = "INITIAL_CAPITAL"
    REALIZED_PNL = "REALIZED_PNL"
    FEE_EXPENSE = "FEE_EXPENSE"
    AVAILABLE_MARGIN = "AVAILABLE_MARGIN"
    RESERVED_MARGIN = "RESERVED_MARGIN"
    EXTERNAL_CAPITAL = "EXTERNAL_CAPITAL"


class LedgerKind(_StringEnum):
    INITIAL_CAPITAL = "INITIAL_CAPITAL"
    RESERVE_MARGIN = "RESERVE_MARGIN"
    RELEASE_MARGIN = "RELEASE_MARGIN"
    REALIZED_PNL = "REALIZED_PNL"
    FEE = "FEE"
    DEPOSIT = "DEPOSIT"
    WITHDRAW = "WITHDRAW"


_ORDER_TRANSITIONS: dict[OrderStatus, frozenset[OrderStatus]] = {
    OrderStatus.NEW: frozenset({OrderStatus.OPEN, OrderStatus.REJECTED}),
    OrderStatus.OPEN: frozenset(
        {
            OrderStatus.PARTIALLY_FILLED,
            OrderStatus.FILLED,
            OrderStatus.CANCELED,
            OrderStatus.REJECTED,
            OrderStatus.EXPIRED,
        }
    ),
    OrderStatus.PARTIALLY_FILLED: frozenset(
        {
            OrderStatus.PARTIALLY_FILLED,
            OrderStatus.FILLED,
            OrderStatus.CANCELED,
            OrderStatus.EXPIRED,
        }
    ),
    OrderStatus.FILLED: frozenset(),
    OrderStatus.CANCELED: frozenset(),
    OrderStatus.REJECTED: frozenset(),
    OrderStatus.EXPIRED: frozenset(),
}


def validate_order_transition(current: OrderStatus, target: OrderStatus) -> None:
    if target not in _ORDER_TRANSITIONS[current]:
        raise ValueError(f"invalid order transition {current.value}->{target.value}")


def canonical_decimal(
    value: object,
    *,
    field_name: str,
    positive: bool = False,
    nonnegative: bool = False,
) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a Decimal string")
    normalized = normalize_decimal_string(value, field_name=field_name)
    number = Decimal(normalized)
    if positive and number <= 0:
        raise ValueError(f"{field_name} must be positive")
    if nonnegative and number < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return normalized


def decimal_to_string(value: Decimal, *, field_name: str = "decimal") -> str:
    return normalize_decimal_string(format(value, "f"), field_name=field_name)


def optional_decimal(
    value: object,
    *,
    field_name: str,
    positive: bool = False,
    nonnegative: bool = False,
) -> str | None:
    if value is None:
        return None
    return canonical_decimal(
        value,
        field_name=field_name,
        positive=positive,
        nonnegative=nonnegative,
    )


def coerce_enum(enum_type: type[_EnumT], value: object, field_name: str) -> _EnumT:
    if isinstance(value, enum_type):
        return value
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ValueError(f"unsupported {field_name}: {value}") from exc


def exact_keys(payload: Mapping[str, object], expected: set[str]) -> None:
    if set(payload) != expected:
        raise ValueError("object fields do not match the domain schema")


@dataclass(frozen=True, slots=True)
class InstrumentFilters:
    price_tick: str
    quantity_step: str
    min_quantity: str
    max_quantity: str
    min_notional: str
    max_notional: str
    quote_step: str

    def __post_init__(self) -> None:
        for field_name in (
            "price_tick",
            "quantity_step",
            "min_quantity",
            "max_quantity",
            "min_notional",
            "max_notional",
            "quote_step",
        ):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"instrument.{field_name}",
                    positive=True,
                ),
            )
        if Decimal(self.min_quantity) > Decimal(self.max_quantity):
            raise ValueError("instrument quantity bounds are inverted")
        if Decimal(self.min_notional) > Decimal(self.max_notional):
            raise ValueError("instrument notional bounds are inverted")

    def to_dict(self) -> dict[str, str]:
        return {
            "price_tick": self.price_tick,
            "quantity_step": self.quantity_step,
            "min_quantity": self.min_quantity,
            "max_quantity": self.max_quantity,
            "min_notional": self.min_notional,
            "max_notional": self.max_notional,
            "quote_step": self.quote_step,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "InstrumentFilters":
        exact_keys(
            payload,
            {
                "price_tick",
                "quantity_step",
                "min_quantity",
                "max_quantity",
                "min_notional",
                "max_notional",
                "quote_step",
            },
        )
        return cls(**payload)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class BrokerLimits:
    max_leverage: str
    max_position_notional: str
    max_order_quantity: str
    max_open_orders: int
    max_orders: int
    max_fills: int
    max_ledger_entries: int
    max_warnings: int

    def __post_init__(self) -> None:
        for field_name in (
            "max_leverage",
            "max_position_notional",
            "max_order_quantity",
        ):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"limits.{field_name}",
                    positive=True,
                ),
            )
        for field_name in (
            "max_open_orders",
            "max_orders",
            "max_fills",
            "max_ledger_entries",
            "max_warnings",
        ):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"limits.{field_name} must be a positive integer")
        if self.max_open_orders > self.max_orders:
            raise ValueError("max_open_orders cannot exceed max_orders")

    def to_dict(self) -> dict[str, object]:
        return {
            "max_leverage": self.max_leverage,
            "max_position_notional": self.max_position_notional,
            "max_order_quantity": self.max_order_quantity,
            "max_open_orders": self.max_open_orders,
            "max_orders": self.max_orders,
            "max_fills": self.max_fills,
            "max_ledger_entries": self.max_ledger_entries,
            "max_warnings": self.max_warnings,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "BrokerLimits":
        exact_keys(
            payload,
            {
                "max_leverage",
                "max_position_notional",
                "max_order_quantity",
                "max_open_orders",
                "max_orders",
                "max_fills",
                "max_ledger_entries",
                "max_warnings",
            },
        )
        return cls(**payload)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class BrokerConfig:
    initial_equity: str
    quote_asset: str
    maker_bps: str
    taker_bps: str
    market_slippage_bps: str
    initial_mark_price: str
    instrument: InstrumentFilters
    limits: BrokerLimits

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "initial_equity",
            canonical_decimal(
                self.initial_equity,
                field_name="broker.initial_equity",
                positive=True,
            ),
        )
        object.__setattr__(
            self,
            "quote_asset",
            validate_identifier(self.quote_asset, field_name="broker.quote_asset"),
        )
        for field_name in ("maker_bps", "taker_bps", "market_slippage_bps"):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"broker.{field_name}",
                    nonnegative=True,
                ),
            )
        object.__setattr__(
            self,
            "initial_mark_price",
            canonical_decimal(
                self.initial_mark_price,
                field_name="broker.initial_mark_price",
                positive=True,
            ),
        )
        if not isinstance(self.instrument, InstrumentFilters):
            raise TypeError("instrument must be InstrumentFilters")
        if not isinstance(self.limits, BrokerLimits):
            raise TypeError("limits must be BrokerLimits")

    def to_dict(self) -> dict[str, object]:
        return {
            "initial_equity": self.initial_equity,
            "quote_asset": self.quote_asset,
            "maker_bps": self.maker_bps,
            "taker_bps": self.taker_bps,
            "market_slippage_bps": self.market_slippage_bps,
            "initial_mark_price": self.initial_mark_price,
            "instrument": self.instrument.to_dict(),
            "limits": self.limits.to_dict(),
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "BrokerConfig":
        exact_keys(
            payload,
            {
                "initial_equity",
                "quote_asset",
                "maker_bps",
                "taker_bps",
                "market_slippage_bps",
                "initial_mark_price",
                "instrument",
                "limits",
            },
        )
        instrument = payload["instrument"]
        limits = payload["limits"]
        if not isinstance(instrument, Mapping) or not isinstance(limits, Mapping):
            raise TypeError("broker instrument and limits must be objects")
        return cls(
            initial_equity=payload["initial_equity"],  # type: ignore[arg-type]
            quote_asset=payload["quote_asset"],  # type: ignore[arg-type]
            maker_bps=payload["maker_bps"],  # type: ignore[arg-type]
            taker_bps=payload["taker_bps"],  # type: ignore[arg-type]
            market_slippage_bps=payload["market_slippage_bps"],  # type: ignore[arg-type]
            initial_mark_price=payload["initial_mark_price"],  # type: ignore[arg-type]
            instrument=InstrumentFilters.from_dict(instrument),
            limits=BrokerLimits.from_dict(limits),
        )


@dataclass(frozen=True, slots=True)
class OrderRequest:
    client_order_id: str
    side: OrderSide
    order_type: OrderType
    quantity: str
    reduce_only: bool
    limit_price: str | None = None
    stop_price: str | None = None
    # Optional effective leverage for this order; None => broker max_leverage.
    leverage: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "client_order_id",
            validate_identifier(
                self.client_order_id,
                field_name="client_order_id",
            ),
        )
        object.__setattr__(
            self,
            "side",
            coerce_enum(OrderSide, self.side, "side"),
        )
        object.__setattr__(
            self,
            "order_type",
            coerce_enum(OrderType, self.order_type, "order_type"),
        )
        object.__setattr__(
            self,
            "quantity",
            canonical_decimal(
                self.quantity,
                field_name="quantity",
                positive=True,
            ),
        )
        if not isinstance(self.reduce_only, bool):
            raise TypeError("reduce_only must be a boolean")
        object.__setattr__(
            self,
            "limit_price",
            optional_decimal(
                self.limit_price,
                field_name="limit_price",
                positive=True,
            ),
        )
        object.__setattr__(
            self,
            "stop_price",
            optional_decimal(
                self.stop_price,
                field_name="stop_price",
                positive=True,
            ),
        )
        object.__setattr__(
            self,
            "leverage",
            optional_decimal(
                self.leverage,
                field_name="leverage",
                positive=True,
            ),
        )
        if self.order_type is OrderType.MARKET:
            valid = self.limit_price is None and self.stop_price is None
        elif self.order_type is OrderType.LIMIT:
            valid = self.limit_price is not None and self.stop_price is None
        else:
            valid = self.limit_price is None and self.stop_price is not None
        if not valid:
            raise ValueError("order price fields do not match order_type")

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "client_order_id": self.client_order_id,
            "side": self.side.value,
            "order_type": self.order_type.value,
            "quantity": self.quantity,
            "reduce_only": self.reduce_only,
            "limit_price": self.limit_price,
            "stop_price": self.stop_price,
        }
        # Keep legacy consumers exact-key compatible when leverage is omitted.
        if self.leverage is not None:
            payload["leverage"] = self.leverage
        return payload

    @classmethod
    def from_mapping(cls, payload: Mapping[str, object]) -> "OrderRequest":
        data = dict(payload)
        leverage = data.pop("leverage", None)
        exact_keys(
            data,
            {
                "client_order_id",
                "side",
                "order_type",
                "quantity",
                "reduce_only",
                "limit_price",
                "stop_price",
            },
        )
        return cls(**data, leverage=leverage)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class OrderCapacityRequest:
    """Quantity-independent order context used to calculate a safe maximum."""

    side: OrderSide
    order_type: OrderType
    reduce_only: bool
    limit_price: str | None = None
    stop_price: str | None = None
    leverage: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "side", coerce_enum(OrderSide, self.side, "side"))
        object.__setattr__(
            self,
            "order_type",
            coerce_enum(OrderType, self.order_type, "order_type"),
        )
        if not isinstance(self.reduce_only, bool):
            raise TypeError("reduce_only must be a boolean")
        object.__setattr__(
            self,
            "limit_price",
            optional_decimal(self.limit_price, field_name="limit_price", positive=True),
        )
        object.__setattr__(
            self,
            "stop_price",
            optional_decimal(self.stop_price, field_name="stop_price", positive=True),
        )
        object.__setattr__(
            self,
            "leverage",
            optional_decimal(self.leverage, field_name="leverage", positive=True),
        )
        if self.order_type is OrderType.MARKET:
            valid = self.limit_price is None and self.stop_price is None
        elif self.order_type is OrderType.LIMIT:
            valid = self.limit_price is not None and self.stop_price is None
        else:
            valid = self.limit_price is None and self.stop_price is not None
        if not valid:
            raise ValueError("order price fields do not match order_type")

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "side": self.side.value,
            "order_type": self.order_type.value,
            "reduce_only": self.reduce_only,
            "limit_price": self.limit_price,
            "stop_price": self.stop_price,
        }
        if self.leverage is not None:
            payload["leverage"] = self.leverage
        return payload

    @classmethod
    def from_mapping(cls, payload: Mapping[str, object]) -> "OrderCapacityRequest":
        data = dict(payload)
        leverage = data.pop("leverage", None)
        exact_keys(
            data,
            {"side", "order_type", "reduce_only", "limit_price", "stop_price"},
        )
        return cls(**data, leverage=leverage)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class ReplayOrder:
    order_id: str
    client_order_id: str
    side: OrderSide
    order_type: OrderType
    quantity: str
    reduce_only: bool
    limit_price: str | None
    stop_price: str | None
    status: OrderStatus
    filled_quantity: str
    remaining_quantity: str
    average_fill_price: str | None
    accepted_source_sequence: int
    created_time_ms: int
    ordinal: int
    reserved_margin: str
    status_reason: str | None
    status_history: tuple[OrderStatus, ...]
    model_version: str = BROKER_MODEL_VERSION

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "order_id",
            validate_identifier(self.order_id, field_name="order_id"),
        )
        object.__setattr__(
            self,
            "client_order_id",
            validate_identifier(self.client_order_id, field_name="client_order_id"),
        )
        object.__setattr__(self, "side", coerce_enum(OrderSide, self.side, "side"))
        object.__setattr__(
            self,
            "order_type",
            coerce_enum(OrderType, self.order_type, "order_type"),
        )
        object.__setattr__(
            self,
            "status",
            coerce_enum(OrderStatus, self.status, "status"),
        )
        object.__setattr__(
            self,
            "status_history",
            tuple(
                coerce_enum(OrderStatus, value, "status_history")
                for value in self.status_history
            ),
        )
        if (
            not self.status_history
            or self.status_history[0] is not OrderStatus.NEW
            or self.status_history[-1] is not self.status
        ):
            raise ValueError("order status history endpoints are inconsistent")
        for current, target in zip(self.status_history, self.status_history[1:]):
            validate_order_transition(current, target)
        object.__setattr__(
            self,
            "quantity",
            canonical_decimal(
                self.quantity, field_name="order.quantity", positive=True
            ),
        )
        object.__setattr__(
            self,
            "limit_price",
            optional_decimal(
                self.limit_price,
                field_name="order.limit_price",
                positive=True,
            ),
        )
        object.__setattr__(
            self,
            "stop_price",
            optional_decimal(
                self.stop_price,
                field_name="order.stop_price",
                positive=True,
            ),
        )
        if self.order_type is OrderType.MARKET:
            valid_prices = self.limit_price is None and self.stop_price is None
        elif self.order_type is OrderType.LIMIT:
            valid_prices = self.limit_price is not None and self.stop_price is None
        else:
            valid_prices = self.limit_price is None and self.stop_price is not None
        if not valid_prices:
            raise ValueError("order price fields do not match order_type")
        for field_name in ("filled_quantity", "remaining_quantity", "reserved_margin"):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"order.{field_name}",
                    nonnegative=True,
                ),
            )
        if Decimal(self.filled_quantity) + Decimal(self.remaining_quantity) != Decimal(
            self.quantity
        ):
            raise ValueError(
                "filled and remaining quantities do not sum to order quantity"
            )
        object.__setattr__(
            self,
            "average_fill_price",
            optional_decimal(
                self.average_fill_price,
                field_name="order.average_fill_price",
                positive=True,
            ),
        )
        filled = Decimal(self.filled_quantity)
        remaining = Decimal(self.remaining_quantity)
        if (filled == 0) != (self.average_fill_price is None):
            raise ValueError("average fill price disagrees with filled quantity")
        if self.status is OrderStatus.NEW and (filled != 0 or remaining == 0):
            raise ValueError("NEW order quantities are inconsistent")
        if self.status is OrderStatus.OPEN and filled != 0:
            raise ValueError("OPEN order cannot already contain fills")
        if self.status is OrderStatus.PARTIALLY_FILLED and (
            filled == 0 or remaining == 0
        ):
            raise ValueError("PARTIALLY_FILLED order quantities are inconsistent")
        if self.status is OrderStatus.FILLED and remaining != 0:
            raise ValueError("FILLED order must have no remaining quantity")
        if self.status is OrderStatus.REJECTED and filled != 0:
            raise ValueError("REJECTED order cannot contain fills")
        if self.status.terminal and Decimal(self.reserved_margin) != 0:
            raise ValueError("terminal order cannot retain reserved margin")
        object.__setattr__(
            self,
            "accepted_source_sequence",
            validate_counter(
                self.accepted_source_sequence,
                field_name="accepted_source_sequence",
            ),
        )
        object.__setattr__(
            self,
            "created_time_ms",
            validate_counter(self.created_time_ms, field_name="created_time_ms"),
        )
        if (
            isinstance(self.ordinal, bool)
            or not isinstance(self.ordinal, int)
            or self.ordinal < 1
        ):
            raise ValueError("order ordinal must be a positive integer")
        if not isinstance(self.reduce_only, bool):
            raise TypeError("reduce_only must be a boolean")
        if self.status_reason is not None and not isinstance(self.status_reason, str):
            raise TypeError("status_reason must be a string or null")
        if self.model_version not in SUPPORTED_BROKER_MODEL_VERSIONS:
            raise ValueError("order model_version is incompatible")

    def to_dict(self) -> dict[str, object]:
        return {
            "order_id": self.order_id,
            "client_order_id": self.client_order_id,
            "side": self.side.value,
            "order_type": self.order_type.value,
            "quantity": self.quantity,
            "reduce_only": self.reduce_only,
            "limit_price": self.limit_price,
            "stop_price": self.stop_price,
            "status": self.status.value,
            "filled_quantity": self.filled_quantity,
            "remaining_quantity": self.remaining_quantity,
            "average_fill_price": self.average_fill_price,
            "accepted_source_sequence": self.accepted_source_sequence,
            "created_time_ms": self.created_time_ms,
            "ordinal": self.ordinal,
            "reserved_margin": self.reserved_margin,
            "status_reason": self.status_reason,
            "status_history": [value.value for value in self.status_history],
            "model_version": self.model_version,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayOrder":
        exact_keys(
            payload,
            {
                "order_id",
                "client_order_id",
                "side",
                "order_type",
                "quantity",
                "reduce_only",
                "limit_price",
                "stop_price",
                "status",
                "filled_quantity",
                "remaining_quantity",
                "average_fill_price",
                "accepted_source_sequence",
                "created_time_ms",
                "ordinal",
                "reserved_margin",
                "status_reason",
                "status_history",
                "model_version",
            },
        )
        if not isinstance(payload["status_history"], list):
            raise TypeError("order status_history must be a list")
        return cls(
            **{
                **payload,
                "status_history": tuple(payload["status_history"]),
            }
        )  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class ReplayFill:
    fill_id: str
    order_id: str
    side: OrderSide
    quantity: str
    price: str
    notional: str
    fee: str
    fee_asset: str
    liquidity: LiquidityRole
    reason: FillReason
    source_sequence: int
    event_time_ms: int
    synthetic: bool
    historical_execution: bool
    model_version: str = BROKER_MODEL_VERSION

    def __post_init__(self) -> None:
        for field_name in ("fill_id", "order_id", "fee_asset"):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )
        object.__setattr__(self, "side", coerce_enum(OrderSide, self.side, "side"))
        object.__setattr__(
            self,
            "liquidity",
            coerce_enum(LiquidityRole, self.liquidity, "liquidity"),
        )
        object.__setattr__(
            self,
            "reason",
            coerce_enum(FillReason, self.reason, "reason"),
        )
        for field_name in ("quantity", "price", "notional"):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"fill.{field_name}",
                    positive=True,
                ),
            )
        object.__setattr__(
            self,
            "fee",
            canonical_decimal(self.fee, field_name="fill.fee", nonnegative=True),
        )
        with localcontext() as context:
            context.prec = 60
            expected_notional = Decimal(self.quantity) * Decimal(self.price)
        if Decimal(self.notional) != expected_notional:
            raise ValueError("fill notional does not match quantity and price")
        object.__setattr__(
            self,
            "source_sequence",
            validate_counter(self.source_sequence, field_name="source_sequence"),
        )
        object.__setattr__(
            self,
            "event_time_ms",
            validate_counter(self.event_time_ms, field_name="event_time_ms"),
        )
        if not isinstance(self.synthetic, bool) or not isinstance(
            self.historical_execution, bool
        ):
            raise TypeError("fill execution flags must be booleans")
        if self.model_version not in SUPPORTED_BROKER_MODEL_VERSIONS:
            raise ValueError("fill model_version is incompatible")

    def to_dict(self) -> dict[str, object]:
        return {
            "fill_id": self.fill_id,
            "order_id": self.order_id,
            "side": self.side.value,
            "quantity": self.quantity,
            "price": self.price,
            "notional": self.notional,
            "fee": self.fee,
            "fee_asset": self.fee_asset,
            "liquidity": self.liquidity.value,
            "reason": self.reason.value,
            "source_sequence": self.source_sequence,
            "event_time_ms": self.event_time_ms,
            "synthetic": self.synthetic,
            "historical_execution": self.historical_execution,
            "model_version": self.model_version,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayFill":
        exact_keys(
            payload,
            {
                "fill_id",
                "order_id",
                "side",
                "quantity",
                "price",
                "notional",
                "fee",
                "fee_asset",
                "liquidity",
                "reason",
                "source_sequence",
                "event_time_ms",
                "synthetic",
                "historical_execution",
                "model_version",
            },
        )
        return cls(**payload)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class Position:
    quantity: str
    entry_price: str | None
    mark_price: str
    notional: str
    realized_pnl: str
    unrealized_pnl: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "quantity",
            canonical_decimal(self.quantity, field_name="position.quantity"),
        )
        object.__setattr__(
            self,
            "entry_price",
            optional_decimal(
                self.entry_price,
                field_name="position.entry_price",
                positive=True,
            ),
        )
        object.__setattr__(
            self,
            "mark_price",
            canonical_decimal(
                self.mark_price,
                field_name="position.mark_price",
                positive=True,
            ),
        )
        object.__setattr__(
            self,
            "notional",
            canonical_decimal(
                self.notional,
                field_name="position.notional",
                nonnegative=True,
            ),
        )
        for field_name in ("realized_pnl", "unrealized_pnl"):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"position.{field_name}",
                ),
            )
        if (Decimal(self.quantity) == 0) != (self.entry_price is None):
            raise ValueError("position quantity and entry price disagree")
        quantity = Decimal(self.quantity)
        with localcontext() as context:
            context.prec = 60
            expected_notional = abs(quantity) * Decimal(self.mark_price)
            expected_unrealized = (
                Decimal(0)
                if quantity == 0
                else (Decimal(self.mark_price) - Decimal(self.entry_price)) * quantity
            )
        if Decimal(self.notional) != expected_notional:
            raise ValueError("position notional does not match quantity and mark")
        if Decimal(self.unrealized_pnl) != expected_unrealized:
            raise ValueError("position unrealized PnL does not reconcile")

    @classmethod
    def flat(cls, *, mark_price: str) -> "Position":
        mark = canonical_decimal(mark_price, field_name="mark_price", positive=True)
        return cls("0", None, mark, "0", "0", "0")

    def to_dict(self) -> dict[str, object]:
        return {
            "quantity": self.quantity,
            "entry_price": self.entry_price,
            "mark_price": self.mark_price,
            "notional": self.notional,
            "realized_pnl": self.realized_pnl,
            "unrealized_pnl": self.unrealized_pnl,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "Position":
        exact_keys(
            payload,
            {
                "quantity",
                "entry_price",
                "mark_price",
                "notional",
                "realized_pnl",
                "unrealized_pnl",
            },
        )
        return cls(**payload)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class Account:
    cash_balance: str
    equity: str
    available_equity: str
    margin_used: str
    reserved_margin: str
    realized_pnl: str
    unrealized_pnl: str
    fees_paid: str
    quote_asset: str

    def __post_init__(self) -> None:
        for field_name in (
            "cash_balance",
            "equity",
            "available_equity",
            "realized_pnl",
            "unrealized_pnl",
        ):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"account.{field_name}",
                ),
            )
        for field_name in ("margin_used", "reserved_margin", "fees_paid"):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"account.{field_name}",
                    nonnegative=True,
                ),
            )
        object.__setattr__(
            self,
            "quote_asset",
            validate_identifier(self.quote_asset, field_name="quote_asset"),
        )
        with localcontext() as context:
            context.prec = 60
            expected_equity = Decimal(self.cash_balance) + Decimal(self.unrealized_pnl)
            expected_available = (
                Decimal(self.equity)
                - Decimal(self.margin_used)
                - Decimal(self.reserved_margin)
            )
        if Decimal(self.equity) != expected_equity:
            raise ValueError("account equity does not reconcile")
        if Decimal(self.available_equity) != expected_available:
            raise ValueError("account available equity does not reconcile")

    def to_dict(self) -> dict[str, str]:
        return {
            "cash_balance": self.cash_balance,
            "equity": self.equity,
            "available_equity": self.available_equity,
            "margin_used": self.margin_used,
            "reserved_margin": self.reserved_margin,
            "realized_pnl": self.realized_pnl,
            "unrealized_pnl": self.unrealized_pnl,
            "fees_paid": self.fees_paid,
            "quote_asset": self.quote_asset,
        }


@dataclass(frozen=True, slots=True)
class ClosedTrade:
    trade_id: str
    order_id: str
    fill_id: str
    side: OrderSide
    quantity: str
    entry_price: str
    exit_price: str
    realized_pnl: str
    source_sequence: int

    def __post_init__(self) -> None:
        for field_name in ("trade_id", "order_id", "fill_id"):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )
        object.__setattr__(self, "side", coerce_enum(OrderSide, self.side, "side"))
        for field_name in ("quantity", "entry_price", "exit_price"):
            object.__setattr__(
                self,
                field_name,
                canonical_decimal(
                    getattr(self, field_name),
                    field_name=f"closed_trade.{field_name}",
                    positive=True,
                ),
            )
        object.__setattr__(
            self,
            "realized_pnl",
            canonical_decimal(
                self.realized_pnl,
                field_name="closed_trade.realized_pnl",
            ),
        )
        object.__setattr__(
            self,
            "source_sequence",
            validate_counter(self.source_sequence, field_name="source_sequence"),
        )
        with localcontext() as context:
            context.prec = 60
            expected_realized = (
                (Decimal(self.exit_price) - Decimal(self.entry_price))
                * Decimal(self.quantity)
                * -self.side.sign
            )
        if Decimal(self.realized_pnl) != expected_realized:
            raise ValueError("closed trade realized PnL does not reconcile")

    def to_dict(self) -> dict[str, object]:
        return {
            "trade_id": self.trade_id,
            "order_id": self.order_id,
            "fill_id": self.fill_id,
            "side": self.side.value,
            "quantity": self.quantity,
            "entry_price": self.entry_price,
            "exit_price": self.exit_price,
            "realized_pnl": self.realized_pnl,
            "source_sequence": self.source_sequence,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ClosedTrade":
        exact_keys(
            payload,
            {
                "trade_id",
                "order_id",
                "fill_id",
                "side",
                "quantity",
                "entry_price",
                "exit_price",
                "realized_pnl",
                "source_sequence",
            },
        )
        return cls(**payload)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class BrokerWarning:
    warning_id: str
    code: WarningCode
    source_sequence: int
    order_ids: tuple[str, ...]
    message: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "warning_id",
            validate_identifier(self.warning_id, field_name="warning_id"),
        )
        object.__setattr__(
            self,
            "code",
            coerce_enum(WarningCode, self.code, "warning code"),
        )
        object.__setattr__(
            self,
            "source_sequence",
            validate_counter(self.source_sequence, field_name="source_sequence"),
        )
        if not isinstance(self.order_ids, (list, tuple)):
            raise TypeError("warning order_ids must be a list or tuple")
        object.__setattr__(
            self,
            "order_ids",
            tuple(
                validate_identifier(order_id, field_name="warning order_id")
                for order_id in self.order_ids
            ),
        )
        if not self.order_ids:
            raise ValueError("warning must identify at least one order")
        if not isinstance(self.message, str) or not self.message.strip():
            raise ValueError("warning message must be non-empty")

    def to_dict(self) -> dict[str, object]:
        return {
            "warning_id": self.warning_id,
            "code": self.code.value,
            "source_sequence": self.source_sequence,
            "order_ids": list(self.order_ids),
            "message": self.message,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "BrokerWarning":
        exact_keys(
            payload,
            {"warning_id", "code", "source_sequence", "order_ids", "message"},
        )
        if not isinstance(payload["order_ids"], list):
            raise TypeError("warning order_ids must be a list")
        return cls(
            warning_id=payload["warning_id"],  # type: ignore[arg-type]
            code=payload["code"],  # type: ignore[arg-type]
            source_sequence=payload["source_sequence"],  # type: ignore[arg-type]
            order_ids=tuple(payload["order_ids"]),  # type: ignore[arg-type]
            message=payload["message"],  # type: ignore[arg-type]
        )


@dataclass(frozen=True, slots=True)
class PositionFillResult:
    position: Position
    realized_pnl: str
    closed_quantity: str
    closed_entry_price: str | None


@dataclass(frozen=True, slots=True)
class BrokerEventResult:
    bar_update: Mapping[str, object] | None
    orders: tuple[ReplayOrder, ...]
    fills: tuple[ReplayFill, ...]
    warnings: tuple[BrokerWarning, ...]
    position: Position
    account: Account

    def to_dict(self) -> dict[str, object]:
        return {
            "bar_update": None if self.bar_update is None else dict(self.bar_update),
            "orders": [order.to_dict() for order in self.orders],
            "fills": [fill.to_dict() for fill in self.fills],
            "warnings": [warning.to_dict() for warning in self.warnings],
            "position": self.position.to_dict(),
            "account": self.account.to_dict(),
        }
