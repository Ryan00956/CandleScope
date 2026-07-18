"""Immutable balanced postings and hash-chain verification for replay accounts."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, localcontext
from itertools import groupby
from typing import Iterable, Mapping

from ..canonical import canonical_sha256
from ..errors import ReplayDomainError, ReplayErrorCode
from ..models import validate_counter, validate_identifier
from .models import (
    LedgerAccount,
    LedgerKind,
    canonical_decimal,
    coerce_enum,
    decimal_to_string,
    exact_keys,
)


LEDGER_STATE_SCHEMA_VERSION = "replay-ledger-state.v1"
LEDGER_CHAIN_SCHEMA_VERSION = "replay-ledger-chain.v1"


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    entry_id: str
    transaction_id: str
    account: LedgerAccount
    amount: str
    currency: str
    kind: LedgerKind
    source_sequence: int
    event_time_ms: int
    order_id: str | None
    fill_id: str | None

    def __post_init__(self) -> None:
        for field_name in ("entry_id", "transaction_id", "currency"):
            object.__setattr__(
                self,
                field_name,
                validate_identifier(getattr(self, field_name), field_name=field_name),
            )
        for field_name in ("order_id", "fill_id"):
            value = getattr(self, field_name)
            if value is not None:
                object.__setattr__(
                    self,
                    field_name,
                    validate_identifier(value, field_name=field_name),
                )
        object.__setattr__(
            self,
            "account",
            coerce_enum(LedgerAccount, self.account, "ledger account"),
        )
        object.__setattr__(
            self,
            "kind",
            coerce_enum(LedgerKind, self.kind, "ledger kind"),
        )
        object.__setattr__(
            self,
            "amount",
            canonical_decimal(self.amount, field_name="ledger amount"),
        )
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

    def to_dict(self) -> dict[str, object]:
        return {
            "entry_id": self.entry_id,
            "transaction_id": self.transaction_id,
            "account": self.account.value,
            "amount": self.amount,
            "currency": self.currency,
            "kind": self.kind.value,
            "source_sequence": self.source_sequence,
            "event_time_ms": self.event_time_ms,
            "order_id": self.order_id,
            "fill_id": self.fill_id,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "LedgerEntry":
        exact_keys(
            payload,
            {
                "entry_id",
                "transaction_id",
                "account",
                "amount",
                "currency",
                "kind",
                "source_sequence",
                "event_time_ms",
                "order_id",
                "fill_id",
            },
        )
        return cls(**payload)  # type: ignore[arg-type]


class LedgerBook:
    def __init__(
        self,
        *,
        initial_equity: str,
        currency: str,
        max_entries: int,
    ) -> None:
        self._initial_equity = canonical_decimal(
            initial_equity,
            field_name="initial_equity",
            positive=True,
        )
        self._currency = validate_identifier(currency, field_name="ledger currency")
        if (
            isinstance(max_entries, bool)
            or not isinstance(max_entries, int)
            or max_entries < 2
        ):
            raise ValueError("ledger max_entries must be an integer of at least two")
        self._max_entries = max_entries
        self._entries: list[LedgerEntry] = []
        self._next_transaction = 1
        self._next_entry = 1
        self._tail_hash = self._initial_hash()
        self.post(
            kind=LedgerKind.INITIAL_CAPITAL,
            source_sequence=0,
            event_time_ms=0,
            postings=(
                (LedgerAccount.CASH, self._initial_equity),
                (LedgerAccount.INITIAL_CAPITAL, f"-{self._initial_equity}"),
            ),
        )

    @property
    def entries(self) -> tuple[LedgerEntry, ...]:
        return tuple(self._entries)

    @property
    def tail_hash(self) -> str:
        return self._tail_hash

    def clone(self) -> "LedgerBook":
        clone = object.__new__(LedgerBook)
        clone._initial_equity = self._initial_equity
        clone._currency = self._currency
        clone._max_entries = self._max_entries
        clone._entries = list(self._entries)
        clone._next_transaction = self._next_transaction
        clone._next_entry = self._next_entry
        clone._tail_hash = self._tail_hash
        return clone

    def post(
        self,
        *,
        kind: LedgerKind,
        source_sequence: int,
        event_time_ms: int,
        postings: Iterable[tuple[LedgerAccount, str]],
        order_id: str | None = None,
        fill_id: str | None = None,
    ) -> tuple[LedgerEntry, ...]:
        normalized = tuple(
            (
                coerce_enum(LedgerAccount, account, "ledger account"),
                canonical_decimal(amount, field_name="ledger amount"),
            )
            for account, amount in postings
        )
        if len(normalized) < 2:
            raise ValueError("ledger transaction requires at least two postings")
        with localcontext() as context:
            context.prec = 60
            posting_total = sum(
                (Decimal(amount) for _, amount in normalized),
                Decimal(0),
            )
        if posting_total != 0:
            raise ValueError("ledger transaction postings are not balanced")
        if len(self._entries) + len(normalized) > self._max_entries:
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "ledger entry capacity exceeded",
                details={"max_entries": self._max_entries},
            )
        transaction_id = f"txn-{self._next_transaction:010d}"
        entries: list[LedgerEntry] = []
        for account, amount in normalized:
            entry = LedgerEntry(
                entry_id=f"led-{self._next_entry:010d}",
                transaction_id=transaction_id,
                account=account,
                amount=amount,
                currency=self._currency,
                kind=kind,
                source_sequence=source_sequence,
                event_time_ms=event_time_ms,
                order_id=order_id,
                fill_id=fill_id,
            )
            self._tail_hash = canonical_sha256(
                {
                    "schema_version": LEDGER_CHAIN_SCHEMA_VERSION,
                    "previous_hash": self._tail_hash,
                    "ordinal": self._next_entry,
                    "entry": entry.to_dict(),
                }
            )
            self._entries.append(entry)
            entries.append(entry)
            self._next_entry += 1
        self._next_transaction += 1
        return tuple(entries)

    def account_total(self, account: LedgerAccount) -> str:
        with localcontext() as context:
            context.prec = 60
            total = sum(
                (
                    Decimal(entry.amount)
                    for entry in self._entries
                    if entry.account is account
                ),
                Decimal(0),
            )
        return decimal_to_string(total, field_name="ledger account total")

    def snapshot(self) -> dict[str, object]:
        payload = {
            "schema_version": LEDGER_STATE_SCHEMA_VERSION,
            "initial_equity": self._initial_equity,
            "currency": self._currency,
            "max_entries": self._max_entries,
            "next_transaction": self._next_transaction,
            "next_entry": self._next_entry,
            "tail_hash": self._tail_hash,
            "entries": [entry.to_dict() for entry in self._entries],
        }
        payload["state_hash"] = canonical_sha256(payload)
        return payload

    def restore(self, payload: Mapping[str, object]) -> None:
        state = dict(payload)
        state_hash = state.pop("state_hash", None)
        if state_hash != canonical_sha256(state):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "ledger state hash does not match",
            )
        exact_keys(
            state,
            {
                "schema_version",
                "initial_equity",
                "currency",
                "max_entries",
                "next_transaction",
                "next_entry",
                "tail_hash",
                "entries",
            },
        )
        if (
            state.get("schema_version") != LEDGER_STATE_SCHEMA_VERSION
            or state.get("initial_equity") != self._initial_equity
            or state.get("currency") != self._currency
            or state.get("max_entries") != self._max_entries
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "ledger state belongs to a different configuration",
            )
        raw_entries = state["entries"]
        if not isinstance(raw_entries, list):
            raise TypeError("ledger entries must be a list")
        entries = [LedgerEntry.from_dict(entry) for entry in raw_entries]
        if len(entries) > self._max_entries:
            raise ValueError("ledger entries exceed configured capacity")
        self.assert_entries_balanced(entries)
        expected_hash = self._initial_hash()
        expected_transaction = 0
        active_transaction_id: str | None = None
        for ordinal, entry in enumerate(entries, start=1):
            expected_entry_id = f"led-{ordinal:010d}"
            if entry.entry_id != expected_entry_id:
                raise ValueError("ledger entry identifiers are not contiguous")
            if entry.currency != self._currency:
                raise ValueError("ledger entry currency does not match configuration")
            if entry.transaction_id != active_transaction_id:
                expected_transaction += 1
                active_transaction_id = f"txn-{expected_transaction:010d}"
                if entry.transaction_id != active_transaction_id:
                    raise ValueError(
                        "ledger transaction identifiers are not contiguous"
                    )
            expected_hash = canonical_sha256(
                {
                    "schema_version": LEDGER_CHAIN_SCHEMA_VERSION,
                    "previous_hash": expected_hash,
                    "ordinal": ordinal,
                    "entry": entry.to_dict(),
                }
            )
        if expected_hash != state["tail_hash"]:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "ledger chain hash does not match entries",
            )
        next_entry = validate_counter(state["next_entry"], field_name="next_entry")
        next_transaction = validate_counter(
            state["next_transaction"],
            field_name="next_transaction",
        )
        if next_entry != len(entries) + 1:
            raise ValueError("ledger next_entry is inconsistent")
        if next_transaction != expected_transaction + 1:
            raise ValueError("ledger next_transaction is inconsistent")
        self._entries = entries
        self._next_entry = next_entry
        self._next_transaction = next_transaction
        self._tail_hash = expected_hash

    @staticmethod
    def assert_entries_balanced(entries: Iterable[LedgerEntry]) -> None:
        ordered = sorted(
            entries, key=lambda entry: (entry.transaction_id, entry.entry_id)
        )
        for _, transaction in groupby(ordered, key=lambda entry: entry.transaction_id):
            postings = tuple(transaction)
            if len(postings) < 2:
                raise AssertionError("ledger transaction has fewer than two postings")
            with localcontext() as context:
                context.prec = 60
                transaction_total = sum(
                    (Decimal(entry.amount) for entry in postings),
                    Decimal(0),
                )
            if transaction_total != 0:
                raise AssertionError("ledger transaction is not balanced")

    def _initial_hash(self) -> str:
        return canonical_sha256(
            {
                "schema_version": LEDGER_CHAIN_SCHEMA_VERSION,
                "initial_equity": self._initial_equity,
                "currency": self._currency,
                "max_entries": self._max_entries,
            }
        )
