from __future__ import annotations

from copy import deepcopy
from decimal import Decimal

import pytest

from app.replay.broker.execution import (
    BROKER_STATE_HASH_SCHEMA_VERSION,
    apply_position_fill,
)
from app.replay.broker.ledger import LedgerBook
from app.replay.broker.models import OrderSide, Position
from app.replay.canonical import canonical_sha256
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from tests.fixtures.replay.broker_fakes import CONFIG, bar, make_broker, request


def test_one_way_position_add_reduce_full_close_and_reversal() -> None:
    position = Position.flat(mark_price="100")
    opened = apply_position_fill(position, OrderSide.BUY, "2", "100", "100")
    added = apply_position_fill(opened.position, OrderSide.BUY, "1", "103", "103")
    assert added.position.quantity == "3"
    assert added.position.entry_price == "101"

    reduced = apply_position_fill(added.position, OrderSide.SELL, "1", "104", "104")
    assert reduced.realized_pnl == "3"
    assert reduced.position.quantity == "2"
    assert reduced.position.entry_price == "101"

    reversed_fill = apply_position_fill(
        reduced.position,
        OrderSide.SELL,
        "3",
        "99",
        "99",
    )
    assert reversed_fill.realized_pnl == "-4"
    assert reversed_fill.position.quantity == "-1"
    assert reversed_fill.position.entry_price == "99"


def test_every_ledger_transaction_is_balanced_and_hash_restores_exactly() -> None:
    broker = make_broker()
    broker.place_order(request(client_order_id="entry"), command_id="cmd-entry")
    broker.apply_bar(bar(0, 100))
    broker.close_position(command_id="cmd-close")
    broker.apply_bar(bar(1, 105))

    LedgerBook.assert_entries_balanced(broker.ledger_entries)
    assert (
        sum((Decimal(entry.amount) for entry in broker.ledger_entries), Decimal(0)) == 0
    )
    assert (
        broker.account.cash_balance
        == (
            Decimal(CONFIG.initial_equity)
            + Decimal(broker.account.realized_pnl)
            - Decimal(broker.account.fees_paid)
        )
        .normalize()
        .to_eng_string()
    )

    snapshot = broker.snapshot()
    restored = make_broker()
    restored.restore(snapshot)
    assert restored.snapshot() == snapshot
    assert restored.ledger_entries == broker.ledger_entries
    assert restored.state_hash == broker.state_hash


def test_late_checkpoint_validation_failure_is_atomic_and_fail_closed() -> None:
    broker = make_broker()
    broker.place_order(request(client_order_id="entry"), command_id="cmd-entry")
    broker.apply_bar(bar(0, 100))
    before = broker.snapshot()

    tampered = deepcopy(before)
    tampered["next_order"] = 99
    unhashed = dict(tampered)
    unhashed.pop("state_hash")
    tampered["state_hash"] = canonical_sha256(
        {
            "schema_version": BROKER_STATE_HASH_SCHEMA_VERSION,
            "state": unhashed,
        }
    )

    with pytest.raises(ReplayDomainError) as rejected:
        broker.restore(tampered)
    assert rejected.value.code is ReplayErrorCode.DATASET_MISMATCH
    assert broker.snapshot() == before
