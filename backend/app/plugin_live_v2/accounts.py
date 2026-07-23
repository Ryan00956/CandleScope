"""Internal read-only account connector contract for the Live Broker."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol


OKX_DEMO_SPOT_READONLY_CONNECTOR_ID = "candlescope.okx-demo-spot-readonly"
OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID = "candlescope.okx-demo-spot-execution"
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class ReadOnlyAccountProof:
    connector_id: str
    venue: str
    environment: str
    product_scope: str
    canonical_account_sha256: str
    permission: str
    account_mode: str
    position_mode: str
    asset_count: int
    observed_at: str

    def __post_init__(self) -> None:
        permission_by_connector = {
            OKX_DEMO_SPOT_READONLY_CONNECTOR_ID: "read_only",
            OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID: "read_trade",
        }
        if self.connector_id not in permission_by_connector:
            raise ValueError("read-only account connector identity is invalid")
        if (
            self.venue != "okx"
            or self.environment != "demo"
            or self.product_scope != "spot"
            or self.permission != permission_by_connector[self.connector_id]
            or self.account_mode != "spot"
        ):
            raise ValueError("read-only account scope is invalid")
        if (
            not isinstance(self.canonical_account_sha256, str)
            or _SHA256.fullmatch(self.canonical_account_sha256) is None
        ):
            raise ValueError("canonical account digest is invalid")
        if self.position_mode not in {"net_mode", "long_short_mode"}:
            raise ValueError("position mode is invalid")
        if (
            isinstance(self.asset_count, bool)
            or not isinstance(self.asset_count, int)
            or not 0 <= self.asset_count <= 10_000
        ):
            raise ValueError("asset count is invalid")
        if (
            not isinstance(self.observed_at, str)
            or not self.observed_at
            or len(self.observed_at) > 64
        ):
            raise ValueError("account observation time is invalid")


class ReadOnlyAccountConnector(Protocol):
    connector_id: str
    network_method_count: int

    def discover(self, secret: bytearray) -> ReadOnlyAccountProof: ...
