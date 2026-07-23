"""Host-owned deterministic Paper broker for Plugin Platform Phase 11A."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    PAPER_ACCOUNT_SNAPSHOT_V1,
    OrderIntent,
    PaperCancelRequest,
    PaperRecoverRequest,
    canonical_sha256,
    validate_paper_account_snapshot,
    validate_paper_executor_ack,
)

from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.grants import EffectiveGrant
from app.plugin_security_v2.storage import atomic_write_json, read_json

from .errors import paper_error


PAPER_STATE_SCHEMA_VERSION = 1
PAPER_STATE_FILE_NAME = "paper-state-v1.json"
MAX_IDEMPOTENCY_RECORDS = 10_000

InvokePaper = Callable[[Any, dict[str, Any], bool, str], Awaitable[dict[str, Any]]]
ClockMs = Callable[[], int]


def _decimal(value: str) -> Decimal:
    return Decimal(value)


def _decimal_wire(value: Decimal) -> str:
    normalized = format(value, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    if normalized in {"", "-0"}:
        return "0"
    return normalized


@dataclass(frozen=True, slots=True)
class PaperQuote:
    quote_id: str
    symbol: str
    market_type: str
    bid: str
    ask: str
    observed_market_time_ms: int

    def __post_init__(self) -> None:
        if (
            not isinstance(self.quote_id, str)
            or not self.quote_id
            or len(self.quote_id) > 128
            or not isinstance(self.symbol, str)
            or not self.symbol
            or len(self.symbol) > 64
            or not isinstance(self.market_type, str)
            or not self.market_type
            or len(self.market_type) > 32
            or not isinstance(self.bid, str)
            or not isinstance(self.ask, str)
            or len(self.bid) > 128
            or len(self.ask) > 128
            or isinstance(self.observed_market_time_ms, bool)
            or not isinstance(self.observed_market_time_ms, int)
            or self.observed_market_time_ms < 0
        ):
            raise paper_error(
                "PLUGIN_PAPER_QUOTE_INVALID", "Host paper quote identity is invalid"
            )
        try:
            bid = _decimal(self.bid)
            ask = _decimal(self.ask)
        except Exception as exc:
            raise paper_error(
                "PLUGIN_PAPER_QUOTE_INVALID", "Host paper quote prices are invalid"
            ) from exc
        if (
            bid <= 0
            or ask <= 0
            or bid > ask
            or _decimal_wire(bid) != self.bid
            or _decimal_wire(ask) != self.ask
        ):
            raise paper_error(
                "PLUGIN_PAPER_QUOTE_INVALID", "Host paper quote spread is invalid"
            )

    def to_wire(self) -> dict[str, Any]:
        return {
            "quoteId": self.quote_id,
            "symbol": self.symbol,
            "marketType": self.market_type,
            "bid": self.bid,
            "ask": self.ask,
            "observedMarketTimeMs": self.observed_market_time_ms,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "PaperQuote":
        expected = {
            "quoteId",
            "symbol",
            "marketType",
            "bid",
            "ask",
            "observedMarketTimeMs",
        }
        if not isinstance(value, dict) or set(value) != expected:
            raise paper_error(
                "PLUGIN_PAPER_STATE_INVALID", "persisted paper quote is invalid"
            )
        return cls(
            value["quoteId"],
            value["symbol"],
            value["marketType"],
            value["bid"],
            value["ask"],
            value["observedMarketTimeMs"],
        )


@dataclass(frozen=True, slots=True)
class _PaperBroker:
    plugin_id: str
    account_contribution: Any
    executor_contribution: Any
    account_ids: frozenset[str]
    order_types: frozenset[str]
    symbol_keys: frozenset[tuple[str, str]]
    limits: dict[str, Any]


class PluginPaperRuntime:
    """Serialize Paper actions through a Host ledger and immutable audit log."""

    def __init__(
        self,
        *,
        root: Path | str,
        audit_log: AuditLog,
        invoke: InvokePaper,
        clock_ms: ClockMs | None = None,
    ) -> None:
        self.root = Path(root).resolve(strict=False)
        self.state_path = self.root / "paper-v1" / PAPER_STATE_FILE_NAME
        self.audit_log = audit_log
        self._invoke = invoke
        self._clock_ms = clock_ms or (lambda: int(time.time() * 1_000))
        self._brokers: dict[str, _PaperBroker] = {}
        self._quotes: dict[tuple[str, str], PaperQuote] = {}
        self._lock = asyncio.Lock()
        self._state = self._load_state()

    @staticmethod
    def _new_state() -> dict[str, Any]:
        return {
            "schemaVersion": PAPER_STATE_SCHEMA_VERSION,
            "killSwitch": False,
            "accounts": {},
            "idempotency": {},
            "cancelIdempotency": {},
        }

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return self._new_state()
        value = read_json(self.state_path, "Paper trading state")
        if (
            not isinstance(value, dict)
            or set(value)
            != {
                "schemaVersion",
                "killSwitch",
                "accounts",
                "idempotency",
                "cancelIdempotency",
            }
            or value["schemaVersion"] != PAPER_STATE_SCHEMA_VERSION
            or not isinstance(value["killSwitch"], bool)
            or not all(
                isinstance(value[key], dict)
                for key in ("accounts", "idempotency", "cancelIdempotency")
            )
            or len(value["idempotency"]) > MAX_IDEMPOTENCY_RECORDS
            or len(value["cancelIdempotency"]) > MAX_IDEMPOTENCY_RECORDS
        ):
            raise paper_error(
                "PLUGIN_PAPER_STATE_INVALID", "Paper trading state is invalid"
            )
        # Recovered in-flight submissions are never retried blindly.
        recovered_pending = False
        for record in value["idempotency"].values():
            if not isinstance(record, dict):
                raise paper_error(
                    "PLUGIN_PAPER_STATE_INVALID", "Paper idempotency record is invalid"
                )
            if record.get("status") == "pending":
                recovered_pending = True
                record["status"] = "unknown"
                result = record.get("result")
                if isinstance(result, dict) and isinstance(result.get("order"), dict):
                    result["order"]["status"] = "unknown"
                intent = record.get("intent")
                if isinstance(intent, dict):
                    account = value["accounts"].get(
                        self._account_key(
                            str(intent.get("brokerId", "")),
                            str(intent.get("accountId", "")),
                        )
                    )
                    order = (
                        account.get("orders", {}).get(record.get("orderId"))
                        if isinstance(account, dict)
                        else None
                    )
                    if isinstance(order, dict):
                        order["status"] = "unknown"
        if recovered_pending:
            atomic_write_json(self.state_path, value)
        return value

    def _persist(self) -> None:
        atomic_write_json(self.state_path, self._state)

    @staticmethod
    def _account_key(broker_id: str, account_id: str) -> str:
        return f"{broker_id}/{account_id}"

    @staticmethod
    def _idempotency_key(broker_id: str, account_id: str, value: str) -> str:
        return f"{broker_id}/{account_id}/{value}"

    @staticmethod
    def _grant_map(grants: Iterable[EffectiveGrant]) -> dict[str, EffectiveGrant]:
        return {item.permission_id: item for item in grants}

    def register_plugin(
        self, contributions: Iterable[Any], grants: Iterable[EffectiveGrant]
    ) -> None:
        values = tuple(contributions)
        accounts = {
            item.configuration["brokerId"]: item
            for item in values
            if item.kind == "account-provider/1"
        }
        executors = {
            item.configuration["brokerId"]: item
            for item in values
            if item.kind == "order-executor/1"
        }
        if not accounts and not executors:
            return
        grant_map = self._grant_map(grants)
        account_grant = grant_map.get("accounts.read")
        trade_grant = grant_map.get("trade.simulate")
        if account_grant is None or trade_grant is None:
            raise paper_error(
                "PLUGIN_PAPER_GRANTS_REQUIRED",
                "Paper contributions require effective accounts.read and trade.simulate grants",
            )
        changed = False
        for broker_id in sorted(accounts):
            account_contribution = accounts[broker_id]
            executor = executors[broker_id]
            if broker_id in self._brokers:
                raise paper_error(
                    "PLUGIN_PAPER_BROKER_CONFLICT",
                    "Paper broker ID is already registered",
                    plugin_id=account_contribution.plugin_id,
                    details={"brokerId": broker_id},
                )
            account_scope = account_grant.scope
            trade_scope = trade_grant.scope
            declared_accounts = {
                item["id"] for item in account_contribution.configuration["accounts"]
            }
            permitted_accounts = (
                declared_accounts
                & set(account_scope["accounts"])
                & set(trade_scope["accounts"])
            )
            configured_symbols = {
                (item["symbol"], item["marketType"])
                for item in executor.configuration["symbols"]
            }
            permitted_symbols = {
                item
                for item in configured_symbols
                if item[0] in trade_scope["symbols"]
                and item[1] in trade_scope["marketTypes"]
            }
            order_types = set(executor.configuration["orderTypes"]) & set(
                trade_scope["orderTypes"]
            )
            if (
                broker_id not in account_scope["brokers"]
                or broker_id not in trade_scope["brokers"]
                or not permitted_accounts
                or not permitted_symbols
                or not order_types
            ):
                raise paper_error(
                    "PLUGIN_PAPER_SCOPE_EMPTY",
                    "Effective Paper permission scope is empty",
                    plugin_id=account_contribution.plugin_id,
                )
            config_limits = executor.configuration["limits"]
            limits = {
                key: _decimal_wire(
                    min(_decimal(config_limits[key]), _decimal(trade_scope[key]))
                )
                for key in (
                    "maxOrderQuantity",
                    "maxOrderNotional",
                    "maxPositionNotional",
                )
            }
            limits.update(
                {
                    "maxOpenOrders": min(
                        config_limits["maxOpenOrders"], trade_scope["maxOpenOrders"]
                    ),
                    "maxOrdersPerMinute": min(
                        config_limits["maxOrdersPerMinute"],
                        trade_scope["maxOrdersPerMinute"],
                    ),
                    "allowShort": bool(
                        config_limits["allowShort"] and trade_scope["allowShort"]
                    ),
                    "maxQuoteAgeMs": executor.configuration["maxQuoteAgeMs"],
                }
            )
            self._brokers[broker_id] = _PaperBroker(
                account_contribution.plugin_id,
                account_contribution,
                executor,
                frozenset(permitted_accounts),
                frozenset(order_types),
                frozenset(permitted_symbols),
                limits,
            )
            for account in account_contribution.configuration["accounts"]:
                if account["id"] not in permitted_accounts:
                    continue
                key = self._account_key(broker_id, account["id"])
                if key in self._state["accounts"]:
                    continue
                self._state["accounts"][key] = {
                    "brokerId": broker_id,
                    "accountId": account["id"],
                    "baseCurrency": account["baseCurrency"],
                    "balances": {
                        item["asset"]: {"available": item["available"], "locked": "0"}
                        for item in account["initialBalances"]
                    },
                    "positions": {},
                    "orders": {},
                    "orderAttemptsMs": [],
                }
                changed = True
        if changed:
            self._persist()

    async def clear_plugin(self, plugin_id: str) -> None:
        async with self._lock:
            self._brokers = {
                broker_id: broker
                for broker_id, broker in self._brokers.items()
                if broker.plugin_id != plugin_id
            }

    async def stop(self) -> None:
        async with self._lock:
            self._brokers.clear()
            self._quotes.clear()

    def _broker(self, broker_id: str) -> _PaperBroker:
        broker = self._brokers.get(broker_id)
        if broker is None:
            raise paper_error(
                "PLUGIN_PAPER_BROKER_UNAVAILABLE",
                "Paper broker is not active or its grants were revoked",
                details={"brokerId": broker_id},
            )
        return broker

    def _account(
        self, broker: _PaperBroker, broker_id: str, account_id: str
    ) -> dict[str, Any]:
        if account_id not in broker.account_ids:
            raise paper_error(
                "PLUGIN_PAPER_ACCOUNT_DENIED",
                "Paper account is outside the effective grant scope",
                plugin_id=broker.plugin_id,
            )
        account = self._state["accounts"].get(self._account_key(broker_id, account_id))
        if not isinstance(account, dict):
            raise paper_error(
                "PLUGIN_PAPER_ACCOUNT_UNAVAILABLE",
                "Paper account state is unavailable",
                plugin_id=broker.plugin_id,
            )
        return account

    @staticmethod
    def _symbol_config(
        broker: _PaperBroker, symbol: str, market_type: str
    ) -> dict[str, Any]:
        if (symbol, market_type) not in broker.symbol_keys:
            raise paper_error(
                "PLUGIN_PAPER_SYMBOL_DENIED",
                "Paper symbol is outside the effective grant scope",
                plugin_id=broker.plugin_id,
            )
        return next(
            item
            for item in broker.executor_contribution.configuration["symbols"]
            if item["symbol"] == symbol and item["marketType"] == market_type
        )

    def _quote_for_intent(
        self, broker: _PaperBroker, intent: OrderIntent
    ) -> PaperQuote:
        quote = self._quotes.get((intent.symbol, intent.market_type))
        now_ms = self._clock_ms()
        if (
            quote is None
            or quote.quote_id != intent.quote_id
            or quote.observed_market_time_ms != intent.observed_market_time_ms
            or quote.observed_market_time_ms > now_ms
            or now_ms - quote.observed_market_time_ms > broker.limits["maxQuoteAgeMs"]
        ):
            raise paper_error(
                "PLUGIN_PAPER_QUOTE_STALE",
                "OrderIntent does not reference the current bounded Host quote",
                plugin_id=broker.plugin_id,
            )
        return quote

    @staticmethod
    def _balance(account: dict[str, Any], asset: str) -> dict[str, str]:
        return account["balances"].setdefault(asset, {"available": "0", "locked": "0"})

    @staticmethod
    def _position_key(symbol: str, market_type: str) -> str:
        return f"{market_type}:{symbol}"

    @staticmethod
    def _public_order(order: dict[str, Any]) -> dict[str, Any]:
        return {
            key: order[key]
            for key in (
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
            )
        }

    def _sync_submission_order(
        self, broker_id: str, account_id: str, order: dict[str, Any]
    ) -> None:
        record_key = self._idempotency_key(
            broker_id, account_id, order["idempotencyKey"]
        )
        record = self._state["idempotency"].get(record_key)
        if record is None or record.get("orderId") != order["orderId"]:
            raise paper_error(
                "PLUGIN_PAPER_STATE_INVALID",
                "Paper order has no matching submission record",
            )
        record["status"] = order["status"]
        result = record.get("result")
        if not isinstance(result, dict):
            raise paper_error(
                "PLUGIN_PAPER_STATE_INVALID",
                "Paper submission result is invalid",
            )
        result["order"] = self._public_order(order)

    def _risk_check(
        self,
        broker: _PaperBroker,
        account: dict[str, Any],
        intent: OrderIntent,
        quote: PaperQuote,
    ) -> dict[str, Any]:
        symbol = self._symbol_config(broker, intent.symbol, intent.market_type)
        if intent.order_type not in broker.order_types:
            raise paper_error(
                "PLUGIN_PAPER_ORDER_TYPE_DENIED",
                "Paper order type is outside the grant",
                plugin_id=broker.plugin_id,
            )
        if any(
            order["clientOrderId"] == intent.client_order_id
            and order["idempotencyKey"] != intent.idempotency_key
            for order in account["orders"].values()
        ):
            raise paper_error(
                "PLUGIN_PAPER_CLIENT_ORDER_CONFLICT",
                "Paper clientOrderId is already bound to another submission",
                plugin_id=broker.plugin_id,
            )
        quantity = _decimal(intent.quantity)
        reference_price = _decimal(
            intent.limit_price
            if intent.limit_price is not None
            else (quote.ask if intent.side == "buy" else quote.bid)
        )
        if quantity % _decimal(symbol["quantityStep"]) != 0:
            raise paper_error(
                "PLUGIN_PAPER_QUANTITY_STEP",
                "Paper quantity does not match quantityStep",
                plugin_id=broker.plugin_id,
            )
        if (
            intent.limit_price is not None
            and _decimal(intent.limit_price) % _decimal(symbol["priceTick"]) != 0
        ):
            raise paper_error(
                "PLUGIN_PAPER_PRICE_TICK",
                "Paper limit price does not match priceTick",
                plugin_id=broker.plugin_id,
            )
        notional = quantity * reference_price
        if (
            quantity < _decimal(symbol["minQuantity"])
            or quantity > _decimal(symbol["maxQuantity"])
            or quantity > _decimal(broker.limits["maxOrderQuantity"])
            or notional < _decimal(symbol["minNotional"])
            or notional > _decimal(symbol["maxNotional"])
            or notional > _decimal(broker.limits["maxOrderNotional"])
        ):
            raise paper_error(
                "PLUGIN_PAPER_RISK_LIMIT",
                "Paper order exceeds quantity or notional limits",
                plugin_id=broker.plugin_id,
            )
        open_orders = sum(
            order["status"] in {"open", "unknown", "pending"}
            for order in account["orders"].values()
        )
        if open_orders >= broker.limits["maxOpenOrders"]:
            raise paper_error(
                "PLUGIN_PAPER_OPEN_ORDER_LIMIT",
                "Paper open-order limit reached",
                plugin_id=broker.plugin_id,
            )
        now_ms = self._clock_ms()
        attempts = [
            value for value in account["orderAttemptsMs"] if value > now_ms - 60_000
        ]
        if len(attempts) >= broker.limits["maxOrdersPerMinute"]:
            raise paper_error(
                "PLUGIN_PAPER_RATE_LIMIT",
                "Paper order rate limit reached",
                plugin_id=broker.plugin_id,
            )
        attempts.append(now_ms)
        account["orderAttemptsMs"] = attempts
        position = account["positions"].get(
            self._position_key(intent.symbol, intent.market_type)
        )
        current_quantity = (
            _decimal(position["quantity"]) if position is not None else Decimal(0)
        )
        active_orders = (
            order
            for order in account["orders"].values()
            if order["status"] in {"open", "unknown", "pending"}
            and order["symbol"] == intent.symbol
            and order["marketType"] == intent.market_type
        )
        pending_buy = Decimal(0)
        pending_sell = Decimal(0)
        for order in active_orders:
            if order["side"] == "buy":
                pending_buy += _decimal(order["quantity"])
            else:
                pending_sell += _decimal(order["quantity"])
        if intent.side == "buy":
            pending_buy += quantity
        else:
            pending_sell += quantity
        maximum_projected = max(
            abs(current_quantity + pending_buy),
            abs(current_quantity - pending_sell),
        )
        if maximum_projected * reference_price > _decimal(
            broker.limits["maxPositionNotional"]
        ):
            raise paper_error(
                "PLUGIN_PAPER_POSITION_LIMIT",
                "Paper position limit would be exceeded",
                plugin_id=broker.plugin_id,
            )
        if intent.side == "buy":
            available = _decimal(
                self._balance(account, symbol["quoteAsset"])["available"]
            )
            if available < notional:
                raise paper_error(
                    "PLUGIN_PAPER_INSUFFICIENT_FUNDS",
                    "Paper quote-asset balance is insufficient",
                    plugin_id=broker.plugin_id,
                )
        elif not broker.limits["allowShort"]:
            available = _decimal(
                self._balance(account, symbol["baseAsset"])["available"]
            )
            if available < quantity:
                raise paper_error(
                    "PLUGIN_PAPER_INSUFFICIENT_FUNDS",
                    "Paper base-asset balance is insufficient",
                    plugin_id=broker.plugin_id,
                )
        return symbol

    def _reserve_order(
        self,
        account: dict[str, Any],
        order: dict[str, Any],
        symbol: dict[str, Any],
        quote: PaperQuote,
    ) -> None:
        reserved_asset = order.get("reservedAsset")
        reserved_amount = order.get("reservedAmount")
        if reserved_asset is not None or reserved_amount is not None:
            if not isinstance(reserved_asset, str) or not isinstance(
                reserved_amount, str
            ):
                raise paper_error(
                    "PLUGIN_PAPER_STATE_INVALID",
                    "Paper order reservation is incomplete",
                )
            return
        quantity = _decimal(order["quantity"])
        if order["side"] == "buy":
            asset = symbol["quoteAsset"]
            price = _decimal(
                order["limitPrice"] if order["limitPrice"] is not None else quote.ask
            )
            amount = quantity * price
        else:
            asset = symbol["baseAsset"]
            amount = quantity
        balance = self._balance(account, asset)
        if _decimal(balance["available"]) < amount:
            raise paper_error(
                "PLUGIN_PAPER_INSUFFICIENT_FUNDS",
                "Paper balance changed before funds could be reserved",
            )
        balance["available"] = _decimal_wire(_decimal(balance["available"]) - amount)
        balance["locked"] = _decimal_wire(_decimal(balance["locked"]) + amount)
        order["reservedAsset"] = asset
        order["reservedAmount"] = _decimal_wire(amount)

    def _release_reservation(
        self, account: dict[str, Any], order: dict[str, Any]
    ) -> None:
        asset = order.pop("reservedAsset", None)
        amount_value = order.pop("reservedAmount", None)
        if asset is None or amount_value is None:
            return
        amount = _decimal(amount_value)
        balance = self._balance(account, asset)
        balance["locked"] = _decimal_wire(_decimal(balance["locked"]) - amount)
        balance["available"] = _decimal_wire(_decimal(balance["available"]) + amount)

    def _fill_order(
        self,
        account: dict[str, Any],
        order: dict[str, Any],
        symbol: dict[str, Any],
        price: Decimal,
        now_ms: int,
    ) -> None:
        quantity = _decimal(order["quantity"])
        reserved_asset = order.get("reservedAsset")
        reserved_amount = (
            _decimal(order["reservedAmount"])
            if "reservedAmount" in order
            else Decimal(0)
        )
        if reserved_asset is not None:
            locked = self._balance(account, reserved_asset)
            locked["locked"] = _decimal_wire(
                _decimal(locked["locked"]) - reserved_amount
            )
            order.pop("reservedAsset", None)
            order.pop("reservedAmount", None)
        if order["side"] == "buy":
            cost = quantity * price
            quote_balance = self._balance(account, symbol["quoteAsset"])
            if reserved_asset == symbol["quoteAsset"]:
                quote_balance["available"] = _decimal_wire(
                    _decimal(quote_balance["available"]) + reserved_amount - cost
                )
            else:
                quote_balance["available"] = _decimal_wire(
                    _decimal(quote_balance["available"]) - cost
                )
            base_balance = self._balance(account, symbol["baseAsset"])
            base_balance["available"] = _decimal_wire(
                _decimal(base_balance["available"]) + quantity
            )
            signed = quantity
        else:
            base_balance = self._balance(account, symbol["baseAsset"])
            if reserved_asset != symbol["baseAsset"]:
                base_balance["available"] = _decimal_wire(
                    _decimal(base_balance["available"]) - quantity
                )
            quote_balance = self._balance(account, symbol["quoteAsset"])
            quote_balance["available"] = _decimal_wire(
                _decimal(quote_balance["available"]) + quantity * price
            )
            signed = -quantity
        position_key = self._position_key(order["symbol"], order["marketType"])
        previous = account["positions"].get(position_key)
        previous_quantity = (
            _decimal(previous["quantity"]) if previous is not None else Decimal(0)
        )
        previous_average = (
            _decimal(previous["averagePrice"]) if previous is not None else Decimal(0)
        )
        next_quantity = previous_quantity + signed
        if next_quantity == 0:
            next_average = Decimal(0)
        elif (
            previous_quantity == 0
            or (previous_quantity > 0 > next_quantity)
            or (previous_quantity < 0 < next_quantity)
        ):
            next_average = price
        elif (previous_quantity > 0 and signed > 0) or (
            previous_quantity < 0 and signed < 0
        ):
            next_average = (
                abs(previous_quantity) * previous_average + abs(signed) * price
            ) / abs(next_quantity)
        else:
            next_average = previous_average
        account["positions"][position_key] = {
            "symbol": order["symbol"],
            "marketType": order["marketType"],
            "quantity": _decimal_wire(next_quantity),
            "averagePrice": _decimal_wire(next_average),
        }
        order["status"] = "filled"
        order["filledQuantity"] = order["quantity"]
        order["averageFillPrice"] = _decimal_wire(price)
        order["updatedAtMs"] = now_ms

    def _accept_order(
        self,
        broker: _PaperBroker,
        account: dict[str, Any],
        order: dict[str, Any],
        quote: PaperQuote,
    ) -> None:
        symbol = self._symbol_config(broker, order["symbol"], order["marketType"])
        marketable = (
            order["orderType"] == "market"
            or (
                order["side"] == "buy"
                and _decimal(order["limitPrice"]) >= _decimal(quote.ask)
            )
            or (
                order["side"] == "sell"
                and _decimal(order["limitPrice"]) <= _decimal(quote.bid)
            )
        )
        now_ms = self._clock_ms()
        if marketable:
            self._fill_order(
                account,
                order,
                symbol,
                _decimal(quote.ask if order["side"] == "buy" else quote.bid),
                now_ms,
            )
        else:
            self._reserve_order(account, order, symbol, quote)
            order["status"] = "open"
            order["updatedAtMs"] = now_ms

    def _audit(
        self,
        *,
        action: str,
        outcome: str,
        trace_id: str,
        plugin_id: str | None,
        data: dict[str, Any],
    ) -> str:
        return self.audit_log.append(
            category="paper-trading",
            action=action,
            outcome=outcome,
            trace_id=trace_id,
            plugin_id=plugin_id,
            data=data,
        ).event_id

    async def publish_quote(
        self, quote: PaperQuote, *, trace_id: str = "paper-host-quote"
    ) -> None:
        async with self._lock:
            if quote.observed_market_time_ms > self._clock_ms():
                raise paper_error(
                    "PLUGIN_PAPER_QUOTE_FUTURE",
                    "Host paper quote cannot come from the future",
                )
            key = (quote.symbol, quote.market_type)
            previous = self._quotes.get(key)
            if (
                previous is not None
                and quote.observed_market_time_ms < previous.observed_market_time_ms
            ):
                raise paper_error(
                    "PLUGIN_PAPER_QUOTE_REWIND",
                    "Host paper quote time cannot move backwards",
                )
            self._quotes[key] = quote
            filled: list[tuple[str, str, str]] = []
            for broker_id, broker in self._brokers.items():
                if key not in broker.symbol_keys:
                    continue
                symbol = self._symbol_config(broker, *key)
                for account_id in broker.account_ids:
                    account = self._account(broker, broker_id, account_id)
                    for order in account["orders"].values():
                        if (
                            order["status"] != "open"
                            or (order["symbol"], order["marketType"]) != key
                        ):
                            continue
                        marketable = (
                            order["side"] == "buy"
                            and _decimal(order["limitPrice"]) >= _decimal(quote.ask)
                        ) or (
                            order["side"] == "sell"
                            and _decimal(order["limitPrice"]) <= _decimal(quote.bid)
                        )
                        if marketable:
                            self._fill_order(
                                account,
                                order,
                                symbol,
                                _decimal(
                                    quote.ask if order["side"] == "buy" else quote.bid
                                ),
                                self._clock_ms(),
                            )
                            self._sync_submission_order(broker_id, account_id, order)
                            filled.append(
                                (broker.plugin_id, broker_id, order["orderId"])
                            )
            if filled:
                self._persist()
                for plugin_id, broker_id, order_id in filled:
                    self._audit(
                        action="fill",
                        outcome="filled",
                        trace_id=trace_id,
                        plugin_id=plugin_id,
                        data={
                            "brokerId": broker_id,
                            "orderId": order_id,
                            "quoteId": quote.quote_id,
                        },
                    )

    async def submit(
        self,
        intent_value: dict[str, Any],
        *,
        trace_id: str,
        user_action: bool = True,
    ) -> dict[str, Any]:
        intent = OrderIntent.from_wire(intent_value)
        async with self._lock:
            broker = self._broker(intent.broker_id)
            account = self._account(broker, intent.broker_id, intent.account_id)
            record_key = self._idempotency_key(
                intent.broker_id, intent.account_id, intent.idempotency_key
            )
            fingerprint = canonical_sha256(intent.to_wire())
            existing = self._state["idempotency"].get(record_key)
            if existing is not None:
                if existing.get("fingerprint") != fingerprint:
                    raise paper_error(
                        "PLUGIN_PAPER_IDEMPOTENCY_CONFLICT",
                        "Paper idempotency key was reused with a different OrderIntent",
                        plugin_id=broker.plugin_id,
                    )
                result = dict(existing["result"])
                result["idempotentReplay"] = True
                return result
            if len(self._state["idempotency"]) >= MAX_IDEMPOTENCY_RECORDS:
                raise paper_error(
                    "PLUGIN_PAPER_IDEMPOTENCY_FULL",
                    "Paper idempotency history reached its fail-closed bound",
                    plugin_id=broker.plugin_id,
                )
            if self._state["killSwitch"]:
                audit_id = self._audit(
                    action="submit",
                    outcome="blocked",
                    trace_id=trace_id,
                    plugin_id=broker.plugin_id,
                    data={
                        "brokerId": intent.broker_id,
                        "accountId": intent.account_id,
                        "idempotencyKey": intent.idempotency_key,
                        "reason": "kill-switch",
                    },
                )
                raise paper_error(
                    "PLUGIN_PAPER_KILL_SWITCH",
                    "Global Paper kill switch is enabled",
                    plugin_id=broker.plugin_id,
                    details={"auditEventId": audit_id},
                )
            quote = self._quote_for_intent(broker, intent)
            symbol = self._risk_check(broker, account, intent, quote)
            now_ms = self._clock_ms()
            order_id = "paper-" + uuid.uuid4().hex
            order = {
                "orderId": order_id,
                "clientOrderId": intent.client_order_id,
                "idempotencyKey": intent.idempotency_key,
                "symbol": intent.symbol,
                "marketType": intent.market_type,
                "side": intent.side,
                "orderType": intent.order_type,
                "quantity": intent.quantity,
                "limitPrice": intent.limit_price,
                "status": "pending",
                "filledQuantity": "0",
                "averageFillPrice": None,
                "createdAtMs": now_ms,
                "updatedAtMs": now_ms,
            }
            account["orders"][order_id] = order
            self._reserve_order(account, order, symbol, quote)
            result = {
                "order": self._public_order(order),
                "idempotentReplay": False,
                "auditEventId": None,
            }
            record = {
                "fingerprint": fingerprint,
                "status": "pending",
                "intent": intent.to_wire(),
                "quote": quote.to_wire(),
                "orderId": order_id,
                "result": result,
            }
            self._state["idempotency"][record_key] = record
            self._persist()
            try:
                raw = await self._invoke(
                    broker.executor_contribution,
                    {"operation": "orders.submit", "intent": intent.to_wire()},
                    user_action,
                    trace_id,
                )
                ack = validate_paper_executor_ack(
                    raw,
                    expected_operation="orders.submit",
                    expected_broker_id=intent.broker_id,
                    expected_account_id=intent.account_id,
                    expected_idempotency_key=intent.idempotency_key,
                )
            except Exception:
                ack = {"status": "unknown", "executorOrderId": None, "reasonCode": None}
            status = ack["status"]
            if status == "accepted":
                self._accept_order(broker, account, order, quote)
                outcome = order["status"]
            elif status == "rejected":
                self._release_reservation(account, order)
                order["status"] = "rejected"
                order["updatedAtMs"] = self._clock_ms()
                order["reasonCode"] = ack["reasonCode"]
                outcome = "rejected"
            else:
                order["status"] = "unknown"
                order["updatedAtMs"] = self._clock_ms()
                outcome = "unknown"
            record["status"] = order["status"]
            result["order"] = self._public_order(order)
            self._persist()
            audit_id = self._audit(
                action="submit",
                outcome=outcome,
                trace_id=trace_id,
                plugin_id=broker.plugin_id,
                data={
                    "brokerId": intent.broker_id,
                    "accountId": intent.account_id,
                    "orderId": order_id,
                    "idempotencyKey": intent.idempotency_key,
                    "intentSha256": fingerprint,
                    "quoteId": quote.quote_id,
                },
            )
            result["auditEventId"] = audit_id
            self._persist()
            return dict(result)

    async def cancel(
        self,
        *,
        broker_id: str,
        account_id: str,
        order_id: str,
        idempotency_key: str,
        trace_id: str,
        user_action: bool = True,
    ) -> dict[str, Any]:
        request = PaperCancelRequest.from_invoke(
            {
                "operation": "orders.cancel",
                "brokerId": broker_id,
                "accountId": account_id,
                "orderId": order_id,
                "idempotencyKey": idempotency_key,
            }
        )
        broker_id = request.broker_id
        account_id = request.account_id
        order_id = request.order_id
        idempotency_key = request.idempotency_key
        async with self._lock:
            broker = self._broker(broker_id)
            account = self._account(broker, broker_id, account_id)
            record_key = self._idempotency_key(broker_id, account_id, idempotency_key)
            fingerprint = canonical_sha256(
                {"brokerId": broker_id, "accountId": account_id, "orderId": order_id}
            )
            existing = self._state["cancelIdempotency"].get(record_key)
            if existing is not None:
                if existing.get("fingerprint") != fingerprint:
                    raise paper_error(
                        "PLUGIN_PAPER_IDEMPOTENCY_CONFLICT",
                        "Paper cancel idempotency key was reused",
                        plugin_id=broker.plugin_id,
                    )
                return {**existing["result"], "idempotentReplay": True}
            if len(self._state["cancelIdempotency"]) >= MAX_IDEMPOTENCY_RECORDS:
                raise paper_error(
                    "PLUGIN_PAPER_IDEMPOTENCY_FULL",
                    "Paper cancel idempotency history reached its fail-closed bound",
                    plugin_id=broker.plugin_id,
                )
            order = account["orders"].get(order_id)
            if order is None:
                raise paper_error(
                    "PLUGIN_PAPER_ORDER_NOT_FOUND",
                    "Paper order is unavailable",
                    plugin_id=broker.plugin_id,
                )
            if order["status"] not in {"open", "unknown"}:
                audit_id = self._audit(
                    action="cancel",
                    outcome="no-op",
                    trace_id=trace_id,
                    plugin_id=broker.plugin_id,
                    data={
                        "brokerId": broker_id,
                        "accountId": account_id,
                        "orderId": order_id,
                        "idempotencyKey": idempotency_key,
                        "orderStatus": order["status"],
                    },
                )
                result = {
                    "order": self._public_order(order),
                    "idempotentReplay": False,
                    "auditEventId": audit_id,
                }
                self._state["cancelIdempotency"][record_key] = {
                    "fingerprint": fingerprint,
                    "result": result,
                }
                self._persist()
                return result
            previous_status = order["status"]
            try:
                raw = await self._invoke(
                    broker.executor_contribution,
                    {
                        "operation": "orders.cancel",
                        "brokerId": broker_id,
                        "accountId": account_id,
                        "orderId": order_id,
                        "idempotencyKey": idempotency_key,
                    },
                    user_action,
                    trace_id,
                )
                ack = validate_paper_executor_ack(
                    raw,
                    expected_operation="orders.cancel",
                    expected_broker_id=broker_id,
                    expected_account_id=account_id,
                    expected_idempotency_key=idempotency_key,
                )
            except Exception:
                ack = {"status": "unknown", "reasonCode": None}
            if ack["status"] == "accepted":
                self._release_reservation(account, order)
                order["status"] = "cancelled"
            elif ack["status"] == "unknown":
                order["status"] = "unknown"
            else:
                order["status"] = previous_status
            order["updatedAtMs"] = self._clock_ms()
            outcome = "rejected" if ack["status"] == "rejected" else order["status"]
            self._sync_submission_order(broker_id, account_id, order)
            self._persist()
            audit_id = self._audit(
                action="cancel",
                outcome=outcome,
                trace_id=trace_id,
                plugin_id=broker.plugin_id,
                data={
                    "brokerId": broker_id,
                    "accountId": account_id,
                    "orderId": order_id,
                    "idempotencyKey": idempotency_key,
                },
            )
            result = {
                "order": self._public_order(order),
                "idempotentReplay": False,
                "auditEventId": audit_id,
            }
            self._state["cancelIdempotency"][record_key] = {
                "fingerprint": fingerprint,
                "result": result,
            }
            self._persist()
            return result

    async def recover(
        self,
        *,
        broker_id: str,
        account_id: str,
        idempotency_key: str,
        trace_id: str,
        user_action: bool = True,
    ) -> dict[str, Any]:
        request = PaperRecoverRequest.from_invoke(
            {
                "operation": "orders.recover",
                "brokerId": broker_id,
                "accountId": account_id,
                "idempotencyKey": idempotency_key,
            }
        )
        broker_id = request.broker_id
        account_id = request.account_id
        idempotency_key = request.idempotency_key
        async with self._lock:
            broker = self._broker(broker_id)
            account = self._account(broker, broker_id, account_id)
            record_key = self._idempotency_key(broker_id, account_id, idempotency_key)
            record = self._state["idempotency"].get(record_key)
            if record is None:
                raise paper_error(
                    "PLUGIN_PAPER_RECOVERY_NOT_FOUND",
                    "Paper submission has no recovery record",
                    plugin_id=broker.plugin_id,
                )
            order = account["orders"].get(record["orderId"])
            if order is None:
                raise paper_error(
                    "PLUGIN_PAPER_STATE_INVALID",
                    "Paper recovery order is missing",
                    plugin_id=broker.plugin_id,
                )
            if order["status"] not in {"pending", "unknown"}:
                return {**record["result"], "idempotentReplay": True}
            try:
                raw = await self._invoke(
                    broker.executor_contribution,
                    {
                        "operation": "orders.recover",
                        "brokerId": broker_id,
                        "accountId": account_id,
                        "idempotencyKey": idempotency_key,
                    },
                    user_action,
                    trace_id,
                )
                ack = validate_paper_executor_ack(
                    raw,
                    expected_operation="orders.recover",
                    expected_broker_id=broker_id,
                    expected_account_id=account_id,
                    expected_idempotency_key=idempotency_key,
                )
            except Exception:
                ack = {"status": "unknown", "reasonCode": None}
            if ack["status"] == "accepted":
                self._accept_order(
                    broker, account, order, PaperQuote.from_wire(record["quote"])
                )
            elif ack["status"] == "rejected":
                self._release_reservation(account, order)
                order["status"] = "rejected"
                order["updatedAtMs"] = self._clock_ms()
            else:
                order["status"] = "unknown"
                order["updatedAtMs"] = self._clock_ms()
            self._sync_submission_order(broker_id, account_id, order)
            self._persist()
            audit_id = self._audit(
                action="recover",
                outcome=order["status"],
                trace_id=trace_id,
                plugin_id=broker.plugin_id,
                data={
                    "brokerId": broker_id,
                    "accountId": account_id,
                    "orderId": order["orderId"],
                    "idempotencyKey": idempotency_key,
                },
            )
            record["result"]["auditEventId"] = audit_id
            self._persist()
            return dict(record["result"])

    async def account_snapshot(self, broker_id: str, account_id: str) -> dict[str, Any]:
        async with self._lock:
            broker = self._broker(broker_id)
            account = self._account(broker, broker_id, account_id)
            positions = []
            for value in account["positions"].values():
                quote = self._quotes.get((value["symbol"], value["marketType"]))
                mark = _decimal(
                    quote.bid if quote is not None else value["averagePrice"]
                )
                quantity = _decimal(value["quantity"])
                average = _decimal(value["averagePrice"])
                positions.append(
                    {
                        **value,
                        "markPrice": _decimal_wire(mark),
                        "unrealizedPnl": _decimal_wire((mark - average) * quantity),
                    }
                )
            snapshot = {
                "schemaVersion": PAPER_ACCOUNT_SNAPSHOT_V1,
                "environment": "paper",
                "brokerId": broker_id,
                "accountId": account_id,
                "baseCurrency": account["baseCurrency"],
                "asOfMs": self._clock_ms(),
                "balances": [
                    {"asset": asset, **value}
                    for asset, value in sorted(account["balances"].items())
                ],
                "positions": sorted(
                    positions, key=lambda item: (item["marketType"], item["symbol"])
                ),
                "orders": [
                    self._public_order(value)
                    for value in sorted(
                        account["orders"].values(), key=lambda item: item["createdAtMs"]
                    )
                ],
            }
            return validate_paper_account_snapshot(snapshot)

    async def set_kill_switch(self, enabled: bool, *, trace_id: str) -> dict[str, Any]:
        if not isinstance(enabled, bool):
            raise paper_error(
                "PLUGIN_PAPER_KILL_SWITCH_INVALID",
                "Paper kill switch value must be boolean",
            )
        async with self._lock:
            changed = self._state["killSwitch"] != enabled
            cancelled = 0
            self._state["killSwitch"] = enabled
            if enabled:
                for account in self._state["accounts"].values():
                    for order in account["orders"].values():
                        if order["status"] in {"open", "unknown", "pending"}:
                            self._release_reservation(account, order)
                            order["status"] = "cancelled"
                            order["updatedAtMs"] = self._clock_ms()
                            self._sync_submission_order(
                                account["brokerId"], account["accountId"], order
                            )
                            cancelled += 1
            self._persist()
            audit_id = self._audit(
                action="kill-switch",
                outcome="enabled" if enabled else "disabled",
                trace_id=trace_id,
                plugin_id=None,
                data={
                    "enabled": enabled,
                    "changed": changed,
                    "cancelledOpenOrders": cancelled,
                },
            )
            return {
                "schemaVersion": "candlescope.paper-status/1",
                "killSwitchEnabled": enabled,
                "changed": changed,
                "cancelledOpenOrders": cancelled,
                "auditEventId": audit_id,
            }

    def status(self) -> dict[str, Any]:
        return {
            "schemaVersion": "candlescope.paper-status/1",
            "killSwitchEnabled": bool(self._state["killSwitch"]),
            "mode": "paper-only",
            "liveTradingAvailable": False,
            "secretsAvailable": False,
            "brokers": [
                {
                    "brokerId": broker_id,
                    "pluginId": broker.plugin_id,
                    "displayName": broker.account_contribution.configuration[
                        "displayName"
                    ],
                    "accounts": sorted(broker.account_ids),
                    "orderTypes": sorted(broker.order_types),
                    "symbols": [
                        {"symbol": symbol, "marketType": market_type}
                        for symbol, market_type in sorted(broker.symbol_keys)
                    ],
                    "limits": dict(broker.limits),
                }
                for broker_id, broker in sorted(self._brokers.items())
            ],
        }


__all__ = [
    "MAX_IDEMPOTENCY_RECORDS",
    "PAPER_STATE_FILE_NAME",
    "PAPER_STATE_SCHEMA_VERSION",
    "PaperQuote",
    "PluginPaperRuntime",
]
