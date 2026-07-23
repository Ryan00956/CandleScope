"""Strict DTOs for WP-D query-only reconciliation shadow."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol


_IDEMPOTENCY_KEY = re.compile(r"^intent_[A-Za-z0-9_-]{43}$")
_INSTRUMENT_ID = re.compile(r"^[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$")
_CLIENT_ORDER_ID = re.compile(r"^[A-Za-z0-9]{1,32}$")
_VENUE_ORDER_ID = re.compile(r"^[0-9]{1,32}$")
_DECIMAL = re.compile(r"^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$")
ORDER_QUERY_STATES = frozenset(
    {"live", "partially_filled", "filled", "canceled", "mmp_canceled"}
)
TERMINAL_ORDER_STATES = frozenset({"filled", "canceled", "mmp_canceled"})


def canonical_positive_decimal(value: Any, label: str) -> str:
    if not isinstance(value, str) or _DECIMAL.fullmatch(value) is None:
        raise ValueError(f"{label} must be a canonical positive decimal")
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"{label} must be a canonical positive decimal") from exc
    canonical = format(parsed, "f")
    if "." in canonical:
        canonical = canonical.rstrip("0").rstrip(".")
    if parsed <= 0 or canonical != value:
        raise ValueError(f"{label} must be a canonical positive decimal")
    return value


@dataclass(frozen=True, slots=True)
class ShadowOrderIntent:
    idempotency_key: str
    instrument_id: str
    side: str
    order_type: str
    quantity: str
    limit_price: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.idempotency_key, str)
            or _IDEMPOTENCY_KEY.fullmatch(self.idempotency_key) is None
        ):
            raise ValueError("shadow idempotency key is invalid")
        if (
            not isinstance(self.instrument_id, str)
            or _INSTRUMENT_ID.fullmatch(self.instrument_id) is None
        ):
            raise ValueError("shadow instrument identity is invalid")
        if self.side not in {"buy", "sell"}:
            raise ValueError("shadow side is invalid")
        if self.order_type != "limit":
            raise ValueError("shadow order type is invalid")
        canonical_positive_decimal(self.quantity, "shadow quantity")
        canonical_positive_decimal(self.limit_price, "shadow limit price")

    @classmethod
    def from_wire(cls, value: Any) -> "ShadowOrderIntent":
        expected = {
            "idempotencyKey",
            "instrumentId",
            "side",
            "orderType",
            "quantity",
            "limitPrice",
        }
        if not isinstance(value, dict) or set(value) != expected:
            raise ValueError("shadow intent fields do not match the contract")
        return cls(
            idempotency_key=value["idempotencyKey"],
            instrument_id=value["instrumentId"],
            side=value["side"],
            order_type=value["orderType"],
            quantity=value["quantity"],
            limit_price=value["limitPrice"],
        )

    def canonical_wire(self) -> dict[str, str]:
        return {
            "instrumentId": self.instrument_id,
            "side": self.side,
            "orderType": self.order_type,
            "quantity": self.quantity,
            "limitPrice": self.limit_price,
        }


@dataclass(frozen=True, slots=True)
class OrderQueryProof:
    connector_id: str
    instrument_id: str
    client_order_id: str
    venue_order_id: str
    state: str
    accumulated_fill_size: str
    average_price: str | None
    observed_at: str

    def __post_init__(self) -> None:
        from .accounts import (
            OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
            OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
        )

        if self.connector_id not in {
            OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
            OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID,
        }:
            raise ValueError("order query connector identity is invalid")
        if (
            not isinstance(self.instrument_id, str)
            or _INSTRUMENT_ID.fullmatch(self.instrument_id) is None
            or not isinstance(self.client_order_id, str)
            or _CLIENT_ORDER_ID.fullmatch(self.client_order_id) is None
            or not isinstance(self.venue_order_id, str)
            or _VENUE_ORDER_ID.fullmatch(self.venue_order_id) is None
            or self.state not in ORDER_QUERY_STATES
        ):
            raise ValueError("order query identity or state is invalid")
        if self.accumulated_fill_size == "0":
            accumulated = Decimal(0)
        else:
            canonical_positive_decimal(
                self.accumulated_fill_size,
                "accumulated fill size",
            )
            accumulated = Decimal(self.accumulated_fill_size)
        if self.average_price is not None:
            canonical_positive_decimal(self.average_price, "average price")
        if (
            (self.state == "live" and accumulated != 0)
            or (
                self.state in {"partially_filled", "filled"}
                and accumulated == 0
            )
            or (accumulated == 0 and self.average_price is not None)
            or (accumulated > 0 and self.average_price is None)
        ):
            raise ValueError("order query fill metadata is inconsistent")
        if (
            not isinstance(self.observed_at, str)
            or not self.observed_at
            or len(self.observed_at) > 64
        ):
            raise ValueError("order query observation time is invalid")


class ReadOnlyOrderQueryConnector(Protocol):
    connector_id: str
    network_method_count: int

    def query_order(
        self,
        secret: bytearray,
        *,
        instrument_id: str,
        client_order_id: str,
    ) -> OrderQueryProof: ...
