from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from app.replay.actor import ReplaySessionActor
from app.replay.bars.trade_builder import TradeReplayBarBuilder
from app.replay.broker.execution import ConservativeBarBroker
from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.models import FeeModel, ReplayCommand, ReplaySessionConfig, SlippageModel
from app.replay.sources.trade_reader import PagedReplayTradeReader
from app.replay.sources.trade_source import TradeReplaySource
from tests.fixtures.replay.broker_fakes import CONFIG
from tests.fixtures.replay.trade_fakes import (
    START_MS,
    FakeRawAggTradeArchive,
    make_trade_dataset,
    make_trade_row,
)


pytestmark = pytest.mark.anyio

BASE_START_MS = START_MS - START_MS % 60_000
TERMINAL_MS = BASE_START_MS + 60_000 - 1
ROWS = [
    make_trade_row(index, trade_time_ms=START_MS + index * 1_000)
    for index in range(6)
]
DATASET = replace(
    make_trade_dataset(len(ROWS)),
    start_time_ms=BASE_START_MS,
    end_time_ms=TERMINAL_MS,
)


def _config() -> ReplaySessionConfig:
    return ReplaySessionConfig(
        protocol=REPLAY_PROTOCOL,
        source_kind="agg_trade",  # type: ignore[arg-type]
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        base_interval="1m",
        display_interval="1m",
        start_policy="manual",  # type: ignore[arg-type]
        requested_start_ms=BASE_START_MS,
        warmup_bars=0,
        horizon_ms=60_000,
        random_seed=1,
        quality_mode="exact",  # type: ignore[arg-type]
        blind_mode=False,
        initial_equity="10000",
        quote_asset="USDT",
        execution_model="paper_linear_v1",  # type: ignore[arg-type]
        fee_model=FeeModel("2", "4"),
        slippage_model=SlippageModel("fixed_bps", "1"),  # type: ignore[arg-type]
        max_leverage="5",
        pause_on_controller_loss=True,
    )


def _actor(
    *,
    restore_checkpoint: bytes | None = None,
) -> tuple[ReplaySessionActor, ConservativeBarBroker]:
    def source_factory() -> TradeReplaySource:
        return TradeReplaySource(
            PagedReplayTradeReader(
                FakeRawAggTradeArchive(ROWS),  # type: ignore[arg-type]
                DATASET,
                page_rows=2,
                validate_generation=False,
            )
        )

    reducer = ConservativeBarBroker(
        config=CONFIG,
        bar_builder=TradeReplayBarBuilder(
            base_interval="1m",
            display_interval="1m",
            replay_start_ms=BASE_START_MS,
            replay_end_time_ms=TERMINAL_MS,
        ),
    )
    actor = ReplaySessionActor(
        session_id="trade-determinism",
        config=_config(),
        source_factory=source_factory,
        initial_virtual_time_ms=BASE_START_MS,
        command_queue_size=16,
        event_buffer_size=128,
        max_emit_fps=30,
        controller_ttl_seconds=10,
        checkpoint_event_interval=1,
        checkpoint_virtual_ms=1_000,
        reducer=reducer,
        restore_checkpoint=restore_checkpoint,
    )
    return actor, reducer


def _command(
    command_id: str,
    command_type: CommandType,
    revision: int,
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="trade-determinism-client",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


def _market_payload() -> dict[str, object]:
    return {
        "client_order_id": "deterministic-market",
        "side": "BUY",
        "order_type": "MARKET",
        "quantity": "2",
        "reduce_only": False,
        "limit_price": None,
        "stop_price": None,
    }


async def _wait_ended(actor: ReplaySessionActor) -> None:
    async def wait() -> None:
        while (await actor.snapshot()).state is not SessionState.ENDED:
            await asyncio.sleep(0.001)

    await asyncio.wait_for(wait(), timeout=1)


async def _result(
    actor: ReplaySessionActor,
    broker: ConservativeBarBroker,
) -> dict[str, object]:
    snapshot = await actor.snapshot()
    return {
        "actor_hash": snapshot.state_hash,
        "cursor": snapshot.cursor,
        "broker_hash": broker.state_hash,
        "fills": [fill.to_dict() for fill in broker.fills],
        "ledger": [entry.to_dict() for entry in broker.ledger_entries],
        "bars": broker.bar_builder.replace_projection(),
        "report_hash": broker.build_report().report_hash,
    }


async def _run(path: str) -> dict[str, object]:
    actor, broker = _actor()
    await actor.start()
    await actor.submit(
        _command(f"{path}-acquire", CommandType.ACQUIRE_CONTROLLER, 0)
    )
    await actor.submit(
        _command(f"{path}-order", CommandType.PLACE_ORDER, 1, _market_payload())
    )
    if path == "step":
        await actor.submit(
            _command("step-all", CommandType.STEP, 2, {"count": len(ROWS)})
        )
    elif path == "advance":
        await actor.submit(
            _command(
                "advance-all",
                CommandType.ADVANCE_BY,
                2,
                {"ms": TERMINAL_MS - BASE_START_MS},
            )
        )
    elif path in {"play", "MAX"}:
        speed: int | str = "MAX" if path == "MAX" else 60
        await actor.submit(
            _command(f"{path}-speed", CommandType.SET_SPEED, 2, {"speed": speed})
        )
        await actor.submit(_command(f"{path}-play", CommandType.PLAY, 3))
        await _wait_ended(actor)
    else:
        raise AssertionError(path)
    result = await _result(actor, broker)
    await actor.shutdown()
    return result


async def test_trade_step_play_advance_max_and_restore_are_identical() -> None:
    results = {
        path: await _run(path)
        for path in ("step", "advance", "play", "MAX")
    }

    prefix, _ = _actor()
    await prefix.start()
    await prefix.submit(
        _command("restore-acquire-prefix", CommandType.ACQUIRE_CONTROLLER, 0)
    )
    await prefix.submit(
        _command("restore-order-prefix", CommandType.PLACE_ORDER, 1, _market_payload())
    )
    await prefix.submit(
        _command("restore-step-prefix", CommandType.STEP, 2, {"count": 3})
    )
    checkpoint = prefix.latest_checkpoint_blob()
    assert checkpoint is not None
    await prefix.shutdown()

    restored, restored_broker = _actor(restore_checkpoint=checkpoint)
    await restored.start()
    revision = (await restored.snapshot()).revision
    await restored.submit(
        _command("restore-acquire", CommandType.ACQUIRE_CONTROLLER, revision)
    )
    await restored.submit(
        _command(
            "restore-speed",
            CommandType.SET_SPEED,
            revision + 1,
            {"speed": "MAX"},
        )
    )
    await restored.submit(
        _command("restore-play", CommandType.PLAY, revision + 2)
    )
    await _wait_ended(restored)
    results["restore"] = await _result(restored, restored_broker)
    await restored.shutdown()

    baseline = results["step"]
    assert all(value == baseline for value in results.values()), results
    cursor = baseline["cursor"]
    assert cursor.last_agg_trade_id == 105
    assert cursor.last_trade_time_ms == START_MS + 5_000
    assert cursor.at_end
