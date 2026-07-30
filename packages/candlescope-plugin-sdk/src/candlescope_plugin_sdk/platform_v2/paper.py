"""Dependency-free Paper trading contracts for Plugin Platform v2.

The public contract deliberately carries intents and executor acknowledgements only.
Balances, positions, fills, risk decisions, and quote selection remain Host-owned.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from .errors import contract_error


PAPER_PROTOCOL_V1 = "candlescope.paper/1"
PAPER_ACCOUNT_SNAPSHOT_V1 = "candlescope.paper-account-snapshot/1"
PAPER_EXECUTOR_ACK_V1 = "candlescope.paper-executor-ack/1"

PAPER_ORDER_TYPES = frozenset({"market", "limit"})
PAPER_ORDER_SIDES = frozenset({"buy", "sell"})
PAPER_EXECUTOR_STATUSES = frozenset({"accepted", "rejected", "unknown"})
PAPER_ORDER_STATUSES = frozenset({"pending", "open", "filled", "cancelled", "rejected", "unknown"})
PAPER_RECOVERY_TARGET_OPERATIONS = frozenset({"orders.submit", "orders.cancel"})

_BROKER_ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_MARKET_TYPE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9._:-]{0,63}$")
_ASSET = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,31}$")
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")


def _object(
    value: Any,
    path: str,
    *,
    required: frozenset[str],
    optional: frozenset[str] = frozenset(),
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise contract_error(f"{path} must be an object", path=path)
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required - optional)
    if missing or unknown:
        raise contract_error(
            f"{path} has an invalid shape; missing={missing}, unknown={unknown}",
            path=path,
        )
    return value


def _string(
    value: Any,
    path: str,
    *,
    maximum: int = 128,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or (pattern is not None and pattern.fullmatch(value) is None)
    ):
        raise contract_error(f"{path} must be a bounded canonical string", path=path)
    return value


def _nullable_string(
    value: Any,
    path: str,
    *,
    maximum: int = 128,
    pattern: re.Pattern[str] | None = None,
) -> str | None:
    if value is None:
        return None
    return _string(value, path, maximum=maximum, pattern=pattern)


def _integer(
    value: Any,
    path: str,
    *,
    minimum: int = 0,
    maximum: int = 9_007_199_254_740_991,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise contract_error(f"{path} must be an integer from {minimum} to {maximum}", path=path)
    return value


def canonical_decimal(
    value: Any,
    path: str,
    *,
    minimum: Decimal | None = None,
    allow_negative: bool = False,
) -> str:
    """Validate the cross-language, non-exponent decimal representation."""

    if not isinstance(value, str) or len(value) > 128 or _DECIMAL.fullmatch(value) is None:
        raise contract_error(f"{path} must be a canonical decimal string", path=path)
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise contract_error(f"{path} is not a finite decimal", path=path) from exc
    if not parsed.is_finite() or (not allow_negative and parsed < 0):
        raise contract_error(f"{path} is outside its decimal bounds", path=path)
    normalized = format(parsed, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    if normalized in {"-0", ""}:
        normalized = "0"
    if normalized != value or (minimum is not None and parsed < minimum):
        raise contract_error(f"{path} is not a canonical bounded decimal", path=path)
    return value


@dataclass(frozen=True, slots=True)
class OrderIntent:
    broker_id: str
    account_id: str
    client_order_id: str
    idempotency_key: str
    symbol: str
    market_type: str
    side: str
    order_type: str
    quantity: str
    limit_price: str | None
    quote_id: str
    observed_market_time_ms: int

    def __post_init__(self) -> None:
        broker_id = _string(self.broker_id, "intent.brokerId", maximum=64, pattern=_BROKER_ID)
        account_id = _string(self.account_id, "intent.accountId", pattern=_OPAQUE_ID)
        client_order_id = _string(self.client_order_id, "intent.clientOrderId", pattern=_OPAQUE_ID)
        idempotency_key = _string(self.idempotency_key, "intent.idempotencyKey", pattern=_OPAQUE_ID)
        symbol = _string(self.symbol, "intent.symbol", maximum=64, pattern=_SYMBOL)
        market_type = _string(
            self.market_type, "intent.marketType", maximum=32, pattern=_MARKET_TYPE
        )
        side = _string(self.side, "intent.side", maximum=8)
        order_type = _string(self.order_type, "intent.orderType", maximum=16)
        quantity = canonical_decimal(
            self.quantity, "intent.quantity", minimum=Decimal("0.000000000000000001")
        )
        limit_price = (
            None
            if self.limit_price is None
            else canonical_decimal(
                self.limit_price, "intent.limitPrice", minimum=Decimal("0.000000000000000001")
            )
        )
        quote_id = _string(self.quote_id, "intent.quoteId", pattern=_OPAQUE_ID)
        observed = _integer(self.observed_market_time_ms, "intent.observedMarketTimeMs")
        if side not in PAPER_ORDER_SIDES:
            raise contract_error("intent.side is unsupported", path="intent.side")
        if order_type not in PAPER_ORDER_TYPES:
            raise contract_error("intent.orderType is unsupported", path="intent.orderType")
        if (order_type == "limit") != (limit_price is not None):
            raise contract_error(
                "limit orders require limitPrice and market orders forbid it",
                path="intent.limitPrice",
            )
        for name, value in (
            ("broker_id", broker_id),
            ("account_id", account_id),
            ("client_order_id", client_order_id),
            ("idempotency_key", idempotency_key),
            ("symbol", symbol),
            ("market_type", market_type),
            ("side", side),
            ("order_type", order_type),
            ("quantity", quantity),
            ("limit_price", limit_price),
            ("quote_id", quote_id),
            ("observed_market_time_ms", observed),
        ):
            object.__setattr__(self, name, value)

    def to_wire(self) -> dict[str, Any]:
        return {
            "brokerId": self.broker_id,
            "accountId": self.account_id,
            "clientOrderId": self.client_order_id,
            "idempotencyKey": self.idempotency_key,
            "symbol": self.symbol,
            "marketType": self.market_type,
            "side": self.side,
            "orderType": self.order_type,
            "quantity": self.quantity,
            "limitPrice": self.limit_price,
            "quoteId": self.quote_id,
            "observedMarketTimeMs": self.observed_market_time_ms,
        }

    @classmethod
    def from_wire(cls, value: Any, *, path: str = "intent") -> "OrderIntent":
        data = _object(
            value,
            path,
            required=frozenset(
                {
                    "brokerId",
                    "accountId",
                    "clientOrderId",
                    "idempotencyKey",
                    "symbol",
                    "marketType",
                    "side",
                    "orderType",
                    "quantity",
                    "limitPrice",
                    "quoteId",
                    "observedMarketTimeMs",
                }
            ),
        )
        return cls(
            data["brokerId"],
            data["accountId"],
            data["clientOrderId"],
            data["idempotencyKey"],
            data["symbol"],
            data["marketType"],
            data["side"],
            data["orderType"],
            data["quantity"],
            data["limitPrice"],
            data["quoteId"],
            data["observedMarketTimeMs"],
        )


@dataclass(frozen=True, slots=True)
class PaperAccountSnapshotRequest:
    broker_id: str
    account_id: str

    @classmethod
    def from_invoke(cls, value: Any) -> "PaperAccountSnapshotRequest":
        data = _object(
            value,
            "paper.account.input",
            required=frozenset({"operation", "brokerId", "accountId"}),
        )
        if data["operation"] != "accounts.snapshot":
            raise contract_error("paper account operation is invalid", path="operation")
        return cls(
            _string(data["brokerId"], "brokerId", maximum=64, pattern=_BROKER_ID),
            _string(data["accountId"], "accountId", pattern=_OPAQUE_ID),
        )


@dataclass(frozen=True, slots=True)
class PaperSubmitRequest:
    intent: OrderIntent

    @classmethod
    def from_invoke(cls, value: Any) -> "PaperSubmitRequest":
        data = _object(
            value,
            "paper.submit.input",
            required=frozenset({"operation", "intent"}),
        )
        if data["operation"] != "orders.submit":
            raise contract_error("paper submit operation is invalid", path="operation")
        return cls(OrderIntent.from_wire(data["intent"]))


@dataclass(frozen=True, slots=True)
class PaperCancelRequest:
    broker_id: str
    account_id: str
    order_id: str
    idempotency_key: str

    @classmethod
    def from_invoke(cls, value: Any) -> "PaperCancelRequest":
        data = _object(
            value,
            "paper.cancel.input",
            required=frozenset({"operation", "brokerId", "accountId", "orderId", "idempotencyKey"}),
        )
        if data["operation"] != "orders.cancel":
            raise contract_error("paper cancel operation is invalid", path="operation")
        return cls(
            _string(data["brokerId"], "brokerId", maximum=64, pattern=_BROKER_ID),
            _string(data["accountId"], "accountId", pattern=_OPAQUE_ID),
            _string(data["orderId"], "orderId", pattern=_OPAQUE_ID),
            _string(data["idempotencyKey"], "idempotencyKey", pattern=_OPAQUE_ID),
        )


@dataclass(frozen=True, slots=True)
class PaperRecoverRequest:
    broker_id: str
    account_id: str
    idempotency_key: str
    target_operation: str = "orders.submit"
    order_id: str | None = None

    @classmethod
    def from_invoke(cls, value: Any) -> "PaperRecoverRequest":
        data = _object(
            value,
            "paper.recover.input",
            required=frozenset({"operation", "brokerId", "accountId", "idempotencyKey"}),
            optional=frozenset({"targetOperation", "orderId"}),
        )
        if data["operation"] != "orders.recover":
            raise contract_error("paper recover operation is invalid", path="operation")
        target_operation = _string(
            data.get("targetOperation", "orders.submit"),
            "targetOperation",
            maximum=32,
        )
        if target_operation not in PAPER_RECOVERY_TARGET_OPERATIONS:
            raise contract_error(
                "paper recovery target operation is invalid",
                path="targetOperation",
            )
        order_id = (
            _string(data["orderId"], "orderId", pattern=_OPAQUE_ID)
            if data.get("orderId") is not None
            else None
        )
        if (target_operation == "orders.cancel") != (order_id is not None):
            raise contract_error(
                "cancel recovery requires exactly one orderId",
                path="orderId",
            )
        return cls(
            _string(data["brokerId"], "brokerId", maximum=64, pattern=_BROKER_ID),
            _string(data["accountId"], "accountId", pattern=_OPAQUE_ID),
            _string(data["idempotencyKey"], "idempotencyKey", pattern=_OPAQUE_ID),
            target_operation,
            order_id,
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "operation": "orders.recover",
            "brokerId": self.broker_id,
            "accountId": self.account_id,
            "idempotencyKey": self.idempotency_key,
            **(
                {
                    "targetOperation": self.target_operation,
                    "orderId": self.order_id,
                }
                if self.target_operation == "orders.cancel"
                else {}
            ),
        }


def parse_paper_operation(
    value: Any,
) -> PaperAccountSnapshotRequest | PaperSubmitRequest | PaperCancelRequest | PaperRecoverRequest:
    if not isinstance(value, Mapping):
        raise contract_error("paper input must be an object", path="invoke.input")
    operation = value.get("operation")
    if operation == "accounts.snapshot":
        return PaperAccountSnapshotRequest.from_invoke(value)
    if operation == "orders.submit":
        return PaperSubmitRequest.from_invoke(value)
    if operation == "orders.cancel":
        return PaperCancelRequest.from_invoke(value)
    if operation == "orders.recover":
        return PaperRecoverRequest.from_invoke(value)
    raise contract_error("paper operation is unsupported", path="operation")


def validate_paper_executor_ack(
    value: Any,
    *,
    expected_operation: str,
    expected_broker_id: str,
    expected_account_id: str,
    expected_idempotency_key: str,
) -> dict[str, Any]:
    data = _object(
        value,
        "paperExecutorAck",
        required=frozenset(
            {
                "schemaVersion",
                "operation",
                "status",
                "brokerId",
                "accountId",
                "idempotencyKey",
                "executorOrderId",
                "reasonCode",
            }
        ),
    )
    if data["schemaVersion"] != PAPER_EXECUTOR_ACK_V1 or data["operation"] != expected_operation:
        raise contract_error("paper executor acknowledgement drifted", path="paperExecutorAck")
    broker_id = _string(data["brokerId"], "brokerId", maximum=64, pattern=_BROKER_ID)
    account_id = _string(data["accountId"], "accountId", pattern=_OPAQUE_ID)
    idempotency_key = _string(data["idempotencyKey"], "idempotencyKey", pattern=_OPAQUE_ID)
    status = _string(data["status"], "status", maximum=16)
    executor_order_id = _nullable_string(
        data["executorOrderId"], "executorOrderId", pattern=_OPAQUE_ID
    )
    reason_code = _nullable_string(data["reasonCode"], "reasonCode", maximum=64, pattern=_OPAQUE_ID)
    if (
        broker_id != expected_broker_id
        or account_id != expected_account_id
        or idempotency_key != expected_idempotency_key
        or status not in PAPER_EXECUTOR_STATUSES
        or (status == "accepted") != (executor_order_id is not None)
        or (status == "rejected") != (reason_code is not None)
    ):
        raise contract_error(
            "paper executor acknowledgement is inconsistent", path="paperExecutorAck"
        )
    return {
        "schemaVersion": PAPER_EXECUTOR_ACK_V1,
        "operation": expected_operation,
        "status": status,
        "brokerId": broker_id,
        "accountId": account_id,
        "idempotencyKey": idempotency_key,
        "executorOrderId": executor_order_id,
        "reasonCode": reason_code,
    }


def _sequence(value: Any, path: str, *, maximum: int) -> Sequence[Any]:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes, bytearray))
        or len(value) > maximum
    ):
        raise contract_error(f"{path} must be a bounded array", path=path)
    return value


def validate_paper_account_snapshot(value: Any) -> dict[str, Any]:
    data = _object(
        value,
        "paperAccountSnapshot",
        required=frozenset(
            {
                "schemaVersion",
                "environment",
                "brokerId",
                "accountId",
                "baseCurrency",
                "asOfMs",
                "balances",
                "positions",
                "orders",
            }
        ),
    )
    if data["schemaVersion"] != PAPER_ACCOUNT_SNAPSHOT_V1 or data["environment"] != "paper":
        raise contract_error("paper account snapshot schema is unsupported", path="schemaVersion")
    balances = []
    for index, raw in enumerate(_sequence(data["balances"], "balances", maximum=64)):
        item = _object(
            raw, f"balances[{index}]", required=frozenset({"asset", "available", "locked"})
        )
        balances.append(
            {
                "asset": _string(
                    item["asset"], f"balances[{index}].asset", maximum=32, pattern=_ASSET
                ),
                "available": canonical_decimal(item["available"], f"balances[{index}].available"),
                "locked": canonical_decimal(item["locked"], f"balances[{index}].locked"),
            }
        )
    positions = []
    for index, raw in enumerate(_sequence(data["positions"], "positions", maximum=128)):
        item = _object(
            raw,
            f"positions[{index}]",
            required=frozenset(
                {"symbol", "marketType", "quantity", "averagePrice", "markPrice", "unrealizedPnl"}
            ),
        )
        positions.append(
            {
                "symbol": _string(
                    item["symbol"], f"positions[{index}].symbol", maximum=64, pattern=_SYMBOL
                ),
                "marketType": _string(
                    item["marketType"],
                    f"positions[{index}].marketType",
                    maximum=32,
                    pattern=_MARKET_TYPE,
                ),
                "quantity": canonical_decimal(
                    item["quantity"], f"positions[{index}].quantity", allow_negative=True
                ),
                "averagePrice": canonical_decimal(
                    item["averagePrice"], f"positions[{index}].averagePrice"
                ),
                "markPrice": canonical_decimal(item["markPrice"], f"positions[{index}].markPrice"),
                "unrealizedPnl": canonical_decimal(
                    item["unrealizedPnl"], f"positions[{index}].unrealizedPnl", allow_negative=True
                ),
            }
        )
    orders = []
    order_required = frozenset(
        {
            "orderId",
            "clientOrderId",
            "idempotencyKey",
            "symbol",
            "marketType",
            "side",
            "orderType",
            "quantity",
            "limitPrice",
            "status",
            "filledQuantity",
            "averageFillPrice",
            "createdAtMs",
            "updatedAtMs",
        }
    )
    for index, raw in enumerate(_sequence(data["orders"], "orders", maximum=512)):
        item = _object(raw, f"orders[{index}]", required=order_required)
        status = _string(item["status"], f"orders[{index}].status", maximum=16)
        side = _string(item["side"], f"orders[{index}].side", maximum=8)
        order_type = _string(item["orderType"], f"orders[{index}].orderType", maximum=16)
        if (
            status not in PAPER_ORDER_STATUSES
            or side not in PAPER_ORDER_SIDES
            or order_type not in PAPER_ORDER_TYPES
        ):
            raise contract_error("paper order enum is unsupported", path=f"orders[{index}]")
        orders.append(
            {
                "orderId": _string(item["orderId"], f"orders[{index}].orderId", pattern=_OPAQUE_ID),
                "clientOrderId": _string(
                    item["clientOrderId"], f"orders[{index}].clientOrderId", pattern=_OPAQUE_ID
                ),
                "idempotencyKey": _string(
                    item["idempotencyKey"], f"orders[{index}].idempotencyKey", pattern=_OPAQUE_ID
                ),
                "symbol": _string(
                    item["symbol"], f"orders[{index}].symbol", maximum=64, pattern=_SYMBOL
                ),
                "marketType": _string(
                    item["marketType"],
                    f"orders[{index}].marketType",
                    maximum=32,
                    pattern=_MARKET_TYPE,
                ),
                "side": side,
                "orderType": order_type,
                "quantity": canonical_decimal(item["quantity"], f"orders[{index}].quantity"),
                "limitPrice": None
                if item["limitPrice"] is None
                else canonical_decimal(item["limitPrice"], f"orders[{index}].limitPrice"),
                "status": status,
                "filledQuantity": canonical_decimal(
                    item["filledQuantity"], f"orders[{index}].filledQuantity"
                ),
                "averageFillPrice": None
                if item["averageFillPrice"] is None
                else canonical_decimal(
                    item["averageFillPrice"], f"orders[{index}].averageFillPrice"
                ),
                "createdAtMs": _integer(item["createdAtMs"], f"orders[{index}].createdAtMs"),
                "updatedAtMs": _integer(item["updatedAtMs"], f"orders[{index}].updatedAtMs"),
            }
        )
    if len({item["asset"] for item in balances}) != len(balances):
        raise contract_error("paper balances contain duplicate assets", path="balances")
    return {
        "schemaVersion": PAPER_ACCOUNT_SNAPSHOT_V1,
        "environment": "paper",
        "brokerId": _string(data["brokerId"], "brokerId", maximum=64, pattern=_BROKER_ID),
        "accountId": _string(data["accountId"], "accountId", pattern=_OPAQUE_ID),
        "baseCurrency": _string(data["baseCurrency"], "baseCurrency", maximum=32, pattern=_ASSET),
        "asOfMs": _integer(data["asOfMs"], "asOfMs"),
        "balances": balances,
        "positions": positions,
        "orders": orders,
    }


__all__ = [
    "OrderIntent",
    "PAPER_ACCOUNT_SNAPSHOT_V1",
    "PAPER_EXECUTOR_ACK_V1",
    "PAPER_EXECUTOR_STATUSES",
    "PAPER_ORDER_SIDES",
    "PAPER_ORDER_STATUSES",
    "PAPER_ORDER_TYPES",
    "PAPER_PROTOCOL_V1",
    "PAPER_RECOVERY_TARGET_OPERATIONS",
    "PaperAccountSnapshotRequest",
    "PaperCancelRequest",
    "PaperRecoverRequest",
    "PaperSubmitRequest",
    "canonical_decimal",
    "parse_paper_operation",
    "validate_paper_account_snapshot",
    "validate_paper_executor_ack",
]
