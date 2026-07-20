from __future__ import annotations

import asyncio
import random
from dataclasses import replace
from decimal import Decimal
from functools import wraps

import pytest

from app.replay.actor import ReplaySessionActor
from app.replay.broker.execution import apply_position_fill
from app.replay.broker.ledger import LedgerBook
from app.replay.broker.models import OrderSide, Position
from app.replay.constants import (
    REPLAY_PROTOCOL,
    CommandType,
    ReplayEventType,
    SessionState,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand
from app.replay.sources.bar_source import BarReplaySource
from tests.fixtures.replay.actor_fakes import session_config
from tests.fixtures.replay.bar_builder_fakes import make_bar_snapshot
from tests.fixtures.replay.broker_fakes import CONFIG, bar, make_broker, request


def _run_stream(*, restore_after: int | None = None):
    broker = make_broker(display_interval="5m")
    broker.place_order(request(client_order_id="entry"), command_id="cmd-entry")
    for index, value in enumerate((100, 101, 102, 103, 104, 105, 106)):
        broker.apply_bar(bar(index, value))
        if index == 1:
            broker.close_position(command_id="cmd-close")
        if restore_after == index:
            snapshot = broker.snapshot()
            restored = make_broker(display_interval="5m")
            restored.restore(snapshot)
            broker = restored
    return broker


def test_restore_and_continuous_broker_streams_have_identical_state_and_report_hashes() -> (
    None
):
    continuous = _run_stream()
    restored = _run_stream(restore_after=3)
    assert restored.snapshot() == continuous.snapshot()
    assert restored.state_hash == continuous.state_hash
    assert restored.build_report().report_hash == continuous.build_report().report_hash


def test_ten_thousand_random_position_sequences_preserve_one_way_invariants() -> None:
    rng = random.Random(20260718)
    for _ in range(10_000):
        position = Position.flat(mark_price="100")
        realized = Decimal(0)
        for _ in range(rng.randint(1, 8)):
            side = OrderSide.BUY if rng.getrandbits(1) else OrderSide.SELL
            quantity = str(rng.randint(1, 5))
            price = str(rng.randint(50, 150))
            result = apply_position_fill(position, side, quantity, price, price)
            position = result.position
            realized += Decimal(result.realized_pnl)
            if position.quantity == "0":
                assert position.entry_price is None
                assert position.unrealized_pnl == "0"
            else:
                assert position.entry_price is not None
                assert Decimal(position.notional) >= 0
        assert realized.is_finite()


def test_ten_thousand_random_command_bar_sequences_preserve_ledger_conservation() -> (
    None
):
    rng = random.Random(2026071801)
    broker = make_broker()
    for case in range(10_000):
        broker.reset()
        entry_side = OrderSide.BUY if rng.getrandbits(1) else OrderSide.SELL
        broker.place_order(
            request(
                client_order_id=f"entry-{case}",
                side=entry_side,
                quantity=str(rng.randint(1, 5)),
            ),
            command_id=f"entry-command-{case}",
        )
        broker.apply_bar(bar(0, rng.randint(50, 150)))
        bar_index = 1

        if rng.getrandbits(1):
            second_side = OrderSide.BUY if rng.getrandbits(1) else OrderSide.SELL
            broker.place_order(
                request(
                    client_order_id=f"second-{case}",
                    side=second_side,
                    quantity=str(rng.randint(1, 5)),
                ),
                command_id=f"second-command-{case}",
            )
            broker.apply_bar(bar(bar_index, rng.randint(50, 150)))
            bar_index += 1

        if broker.position.quantity != "0":
            broker.close_position(command_id=f"close-command-{case}")
            broker.apply_bar(bar(bar_index, rng.randint(50, 150)))

        assert broker.position.quantity == "0"
        assert broker.open_orders == ()
        LedgerBook.assert_entries_balanced(broker.ledger_entries)
        assert (
            sum(
                (Decimal(entry.amount) for entry in broker.ledger_entries),
                Decimal(0),
            )
            == 0
        )
        assert Decimal(broker.account.cash_balance) == (
            Decimal(broker.config.initial_equity)
            + Decimal(broker.account.realized_pnl)
            - Decimal(broker.account.fees_paid)
        )
        for fill in broker.fills:
            order = broker.order(fill.order_id)
            assert fill.source_sequence > order.accepted_source_sequence


def _async_test(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return wrapped


def _actor_command(
    command_id: str,
    command_type: CommandType,
    revision: int,
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="broker-tab",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


def _broker_actor(*, restore_checkpoint: bytes | None = None, reducer=None):
    dataset = make_bar_snapshot(warmup_count=0, replay_count=5)
    reducer = reducer or make_broker(display_interval="5m")
    actor = ReplaySessionActor(
        session_id="broker-actor",
        config=session_config(),
        source_factory=lambda: BarReplaySource(dataset),
        initial_virtual_time_ms=dataset.replay_start_ms,
        command_queue_size=16,
        event_buffer_size=128,
        max_emit_fps=30,
        controller_ttl_seconds=10,
        checkpoint_event_interval=1,
        checkpoint_virtual_ms=60_000,
        reducer=reducer,
        restore_checkpoint=restore_checkpoint,
    )
    return actor, reducer, dataset


def _market_payload(client_order_id: str) -> dict[str, object]:
    return {
        "client_order_id": client_order_id,
        "side": "BUY",
        "order_type": "MARKET",
        "quantity": "1",
        "reduce_only": False,
        "limit_price": None,
        "stop_price": None,
    }


def test_broker_commands_use_the_complete_projection_contract() -> None:
    broker = make_broker(display_interval="1m")
    place = broker.apply_command(
        CommandType.PLACE_ORDER,
        _market_payload("projection-entry"),
        command_id="projection-place",
        source_sequence=0,
        virtual_time_ms=0,
    )
    broker.apply_bar(bar(0, 100))
    close = broker.apply_command(
        CommandType.CLOSE_POSITION,
        {"quantity": None},
        command_id="projection-close",
        source_sequence=1,
        virtual_time_ms=1,
    )
    resting = broker.apply_command(
        CommandType.PLACE_ORDER,
        {
            **_market_payload("projection-resting"),
            "order_type": "LIMIT",
            "limit_price": "90",
        },
        command_id="projection-limit",
        source_sequence=1,
        virtual_time_ms=1,
    )
    resting_order_id = str(resting["orders"][0]["order_id"])
    cancel = broker.apply_command(
        CommandType.CANCEL_ORDER,
        {"order_id": resting_order_id},
        command_id="projection-cancel",
        source_sequence=1,
        virtual_time_ms=1,
    )

    for projection in (place, close, resting, cancel):
        assert set(projection) == {
            "bar_update",
            "orders",
            "fills",
            "warnings",
            "position",
            "account",
        }
        assert projection["bar_update"] is None
        assert len(projection["orders"]) == 1
        assert projection["fills"] == []
        assert projection["warnings"] == []


@_async_test
async def test_backward_seek_streams_an_atomic_bar_reset_snapshot() -> None:
    actor, _, dataset = _broker_actor(
        reducer=make_broker(display_interval="1m")
    )
    await actor.start()
    await actor.submit(
        _actor_command("seek-acquire", CommandType.ACQUIRE_CONTROLLER, 0)
    )
    await actor.submit(
        _actor_command("seek-step-four", CommandType.STEP, 1, {"count": 4})
    )
    before = await actor.public_snapshot()
    before_builder = before["components"]["bar_builder"]
    assert before["cursor"]["source_sequence"] == 4
    assert len(before_builder["closed_bars"]) == 4

    subscription = await actor.subscribe(
        after_sequence=int(before["sequence"]),
        max_pending=8,
    )
    assert subscription.reset is True
    assert subscription.initial_events[0].sequence == before["sequence"]

    target = dataset.replay_rows[1].close_time_ms
    sought = await actor.submit(
        _actor_command(
            "seek-back-two",
            CommandType.SEEK_TO,
            2,
            {"virtual_time_ms": target},
        )
    )
    reset_batch = await asyncio.wait_for(subscription.next_event(), timeout=0.2)
    reset_event = reset_batch.latest_event
    assert reset_batch.mandatory is True
    assert reset_batch.sequence_from == reset_batch.sequence_to == sought.sequence
    assert reset_event.type is ReplayEventType.SNAPSHOT
    assert reset_event.sequence == int(before["sequence"]) + 1
    assert reset_event.revision == int(before["revision"]) + 1
    assert reset_event.data["reset"] is True

    snapshot = reset_event.data["snapshot"]
    assert snapshot["sequence"] == reset_event.sequence
    assert snapshot["revision"] == reset_event.revision
    assert snapshot["state"] == SessionState.PAUSED.value
    assert snapshot["status_reason"] == "seek_complete"
    assert snapshot["cursor"]["source_sequence"] == 2
    assert snapshot["cursor"]["virtual_time_ms"] == target
    builder = snapshot["components"]["bar_builder"]
    assert len(builder["closed_bars"]) == 2
    assert builder["last_base_open_ms"] == dataset.replay_rows[1].open_time_ms

    stepped = await actor.submit(
        _actor_command("seek-step-next", CommandType.STEP, 3, {"count": 1})
    )
    assert stepped.cursor.source_sequence == 3
    await actor.unsubscribe(subscription.token)
    await actor.shutdown()


async def _wait_ended(actor: ReplaySessionActor) -> None:
    async def wait() -> None:
        while (await actor.snapshot()).state is not SessionState.ENDED:
            await asyncio.sleep(0.001)

    await asyncio.wait_for(wait(), timeout=0.5)


@_async_test
async def test_failed_broker_command_is_audited_idempotently_without_domain_mutation() -> (
    None
):
    actor, reducer, _ = _broker_actor()
    await actor.start()
    await actor.submit(
        _actor_command("acquire-reject", CommandType.ACQUIRE_CONTROLLER, 0)
    )
    before = reducer.snapshot()
    rejected_command = _actor_command(
        "reject-order",
        CommandType.PLACE_ORDER,
        1,
        {
            **_market_payload("invalid-step"),
            "quantity": "0.0005",
        },
    )

    for _ in range(2):
        with pytest.raises(ReplayDomainError) as rejected:
            await actor.submit(rejected_command)
        assert rejected.value.code is ReplayErrorCode.ORDER_REJECTED

    snapshot = await actor.snapshot()
    assert snapshot.state is SessionState.PAUSED
    assert snapshot.revision == 1
    assert snapshot.cursor.source_sequence == 0
    assert reducer.snapshot() == before
    await actor.shutdown()


@_async_test
async def test_failed_session_finalization_does_not_commit_actor_or_broker_state() -> (
    None
):
    limited = replace(
        CONFIG,
        limits=replace(CONFIG.limits, max_ledger_entries=4),
    )
    reducer = make_broker(config=limited, display_interval="5m")
    actor, _, _ = _broker_actor(reducer=reducer)
    await actor.start()
    await actor.submit(_actor_command("acquire-end", CommandType.ACQUIRE_CONTROLLER, 0))
    await actor.submit(
        _actor_command(
            "place-end",
            CommandType.PLACE_ORDER,
            1,
            {
                **_market_payload("end-reserved"),
                "order_type": "LIMIT",
                "limit_price": "95",
            },
        )
    )
    before = reducer.snapshot()
    end = _actor_command("fail-end", CommandType.END_SESSION, 2)

    for _ in range(2):
        with pytest.raises(ReplayDomainError) as failed:
            await actor.submit(end)
        assert failed.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED

    snapshot = await actor.snapshot()
    assert snapshot.state is SessionState.PAUSED
    assert snapshot.revision == 2
    assert snapshot.cursor.source_sequence == 0
    assert reducer.snapshot() == before
    await actor.shutdown()


@_async_test
async def test_actor_domain_commands_are_idempotent_and_checkpoint_broker_state() -> (
    None
):
    actor, reducer, _ = _broker_actor()
    await actor.start()
    await actor.submit(_actor_command("acquire", CommandType.ACQUIRE_CONTROLLER, 0))
    place = _actor_command(
        "place",
        CommandType.PLACE_ORDER,
        1,
        _market_payload("actor-entry"),
    )
    accepted = await actor.submit(place)
    replayed = await actor.submit(place)
    assert replayed == accepted
    assert len(reducer.orders) == 1

    await actor.submit(_actor_command("step-entry", CommandType.STEP, 2, {"count": 1}))
    await actor.submit(_actor_command("close", CommandType.CLOSE_POSITION, 3))
    await actor.shutdown()
    checkpoint = actor.latest_checkpoint_blob()
    assert checkpoint is not None

    restored_actor, restored_reducer, _ = _broker_actor(restore_checkpoint=checkpoint)
    await restored_actor.start()
    await restored_actor.submit(
        _actor_command("reacquire", CommandType.ACQUIRE_CONTROLLER, 4)
    )
    await restored_actor.submit(
        _actor_command("step-close", CommandType.STEP, 5, {"count": 1})
    )
    assert restored_reducer.position.quantity == "0"
    assert len(restored_reducer.fills) == 2
    assert restored_reducer.has_trading_state()
    await restored_actor.shutdown()


@_async_test
async def test_actor_step_and_advance_execute_identical_internal_broker_events() -> (
    None
):
    async def run(mode: str):
        actor, reducer, dataset = _broker_actor()
        await actor.start()
        await actor.submit(
            _actor_command(f"acquire-{mode}", CommandType.ACQUIRE_CONTROLLER, 0)
        )
        await actor.submit(
            _actor_command(
                f"place-{mode}",
                CommandType.PLACE_ORDER,
                1,
                _market_payload("entry-equivalent"),
            )
        )
        if mode == "step":
            result = await actor.submit(
                _actor_command("progress-step", CommandType.STEP, 2, {"count": 3})
            )
        else:
            target = dataset.replay_rows[2].close_time_ms
            result = await actor.submit(
                _actor_command(
                    "progress-advance",
                    CommandType.ADVANCE_BY,
                    2,
                    {"ms": target - dataset.replay_start_ms},
                )
            )
        snapshot = await actor.snapshot()
        broker_snapshot = reducer.snapshot()
        await actor.shutdown()
        return result, snapshot, broker_snapshot

    _, stepped, stepped_broker = await run("step")
    _, advanced, advanced_broker = await run("advance")
    assert stepped.cursor == advanced.cursor
    assert stepped.state_hash == advanced.state_hash
    assert stepped_broker == advanced_broker


@_async_test
async def test_actor_step_play_advance_and_restore_have_identical_fills_and_ledger() -> (
    None
):
    async def result(actor: ReplaySessionActor, reducer) -> dict[str, object]:
        snapshot = await actor.snapshot()
        return {
            "actor_state_hash": snapshot.state_hash,
            "cursor": (
                snapshot.cursor.virtual_time_ms,
                snapshot.cursor.source_sequence,
                snapshot.cursor.last_base_bar_open_ms,
                snapshot.cursor.at_end,
            ),
            "broker_state_hash": reducer.state_hash,
            "fills": [fill.to_dict() for fill in reducer.fills],
            "ledger": [entry.to_dict() for entry in reducer.ledger_entries],
            "report_hash": reducer.build_report().report_hash,
        }

    async def run(path: str) -> dict[str, object]:
        actor, reducer, dataset = _broker_actor()
        await actor.start()
        await actor.submit(
            _actor_command(f"acquire-{path}", CommandType.ACQUIRE_CONTROLLER, 0)
        )
        await actor.submit(
            _actor_command(
                f"place-{path}",
                CommandType.PLACE_ORDER,
                1,
                _market_payload("equivalent-entry"),
            )
        )
        if path == "step":
            await actor.submit(
                _actor_command(
                    "all-step",
                    CommandType.STEP,
                    2,
                    {"count": len(dataset.replay_rows)},
                )
            )
        elif path == "advance":
            await actor.submit(
                _actor_command(
                    "all-advance",
                    CommandType.ADVANCE_BY,
                    2,
                    {
                        "ms": dataset.replay_rows[-1].close_time_ms
                        - dataset.replay_start_ms
                    },
                )
            )
        elif path == "play":
            await actor.submit(
                _actor_command("max-speed", CommandType.SET_SPEED, 2, {"speed": "MAX"})
            )
            await actor.submit(_actor_command("all-play", CommandType.PLAY, 3))
            await _wait_ended(actor)
        else:
            raise AssertionError(path)
        value = await result(actor, reducer)
        await actor.shutdown()
        return value

    results = {path: await run(path) for path in ("step", "play", "advance")}

    prefix, _, _ = _broker_actor()
    await prefix.start()
    await prefix.submit(
        _actor_command("prefix-acquire", CommandType.ACQUIRE_CONTROLLER, 0)
    )
    await prefix.submit(
        _actor_command(
            "prefix-place",
            CommandType.PLACE_ORDER,
            1,
            _market_payload("equivalent-entry"),
        )
    )
    await prefix.submit(
        _actor_command("prefix-step", CommandType.STEP, 2, {"count": 2})
    )
    checkpoint = prefix.latest_checkpoint_blob()
    assert checkpoint is not None
    await prefix.shutdown()

    restored, restored_reducer, _ = _broker_actor(restore_checkpoint=checkpoint)
    await restored.start()
    revision = (await restored.snapshot()).revision
    await restored.submit(
        _actor_command("restore-acquire", CommandType.ACQUIRE_CONTROLLER, revision)
    )
    await restored.submit(
        _actor_command(
            "restore-max-speed",
            CommandType.SET_SPEED,
            revision + 1,
            {"speed": "MAX"},
        )
    )
    await restored.submit(
        _actor_command("restore-play", CommandType.PLAY, revision + 2)
    )
    await _wait_ended(restored)
    results["restore"] = await result(restored, restored_reducer)
    await restored.shutdown()

    baseline = results["step"]
    assert all(value == baseline for value in results.values()), results
