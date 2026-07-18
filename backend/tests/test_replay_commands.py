from __future__ import annotations

import pytest

from app.replay.commands import (
    CommandHistory,
    CommandResult,
    parse_command,
)
from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand, ReplayCursor


DIGEST = "sha256:" + ("a" * 64)


def _command(
    command_id: str,
    command_type: CommandType,
    payload: dict[str, object],
    *,
    revision: int = 0,
    client: str = "tab-a",
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id=client,
        expected_revision=revision,
        type=command_type,
        payload=payload,
    )


def _result(command_id: str) -> CommandResult:
    return CommandResult(
        command_id=command_id,
        revision=1,
        sequence=2,
        state=SessionState.PAUSED,
        state_hash=DIGEST,
        cursor=ReplayCursor(virtual_time_ms=100, source_sequence=0),
        data={"consumed": 0},
    )


def test_command_payloads_are_exact_and_normalized_before_actor_mutation() -> None:
    assert parse_command(_command("play-1", CommandType.PLAY, {})).values == {}
    assert parse_command(
        _command("speed-1", CommandType.SET_SPEED, {"speed": "MAX"})
    ).values == {"speed": "MAX"}
    assert parse_command(_command("step-1", CommandType.STEP, {"count": 3})).values == {
        "count": 3
    }
    assert parse_command(
        _command("advance-1", CommandType.ADVANCE_BY, {"ms": 60_000})
    ).values == {"ms": 60_000}
    assert parse_command(
        _command(
            "seek-1",
            CommandType.SEEK_TO,
            {"virtual_time_ms": 1_710_000_000_000},
        )
    ).values == {"virtual_time_ms": 1_710_000_000_000}
    assert parse_command(
        _command("acquire-1", CommandType.ACQUIRE_CONTROLLER, {})
    ).values == {"takeover": False}
    assert parse_command(
        _command(
            "order-1",
            CommandType.PLACE_ORDER,
            {
                "client_order_id": "client-order-1",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "1.25",
                "reduce_only": False,
                "limit_price": "100.1",
                "stop_price": None,
            },
        )
    ).values == {
        "client_order_id": "client-order-1",
        "side": "BUY",
        "order_type": "LIMIT",
        "quantity": "1.25",
        "reduce_only": False,
        "limit_price": "100.1",
        "stop_price": None,
    }
    assert parse_command(
        _command("cancel-1", CommandType.CANCEL_ORDER, {"order_id": "ord-1"})
    ).values == {"order_id": "ord-1"}
    assert parse_command(
        _command("close-1", CommandType.CLOSE_POSITION, {})
    ).values == {"quantity": None}
    assert parse_command(
        _command(
            "end-1",
            CommandType.END_SESSION,
            {
                "open_order_disposition": "cancel",
                "position_disposition": "mark_close",
            },
        )
    ).values == {
        "open_order_disposition": "cancel",
        "position_disposition": "mark_close",
    }

    invalid = [
        _command("play-extra", CommandType.PLAY, {"extra": True}),
        _command("step-zero", CommandType.STEP, {"count": 0}),
        _command("step-bool", CommandType.STEP, {"count": True}),
        _command("speed-bad", CommandType.SET_SPEED, {"speed": 2}),
        _command("advance-neg", CommandType.ADVANCE_BY, {"ms": -1}),
        _command("takeover-bad", CommandType.ACQUIRE_CONTROLLER, {"takeover": 1}),
        _command("order-early", CommandType.PLACE_ORDER, {}),
        _command(
            "order-extra",
            CommandType.PLACE_ORDER,
            {
                "client_order_id": "client-order-1",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
                "extra": True,
            },
        ),
        _command("cancel-bad", CommandType.CANCEL_ORDER, {"order_id": 1}),
        _command("close-bad", CommandType.CLOSE_POSITION, {"quantity": 1}),
    ]
    for command in invalid:
        with pytest.raises(ReplayDomainError):
            parse_command(command)


def test_command_history_replays_success_and_rejected_result_by_canonical_identity() -> (
    None
):
    history = CommandHistory(max_records=3)
    command = _command("step-id", CommandType.STEP, {"count": 1})
    result = _result(command.command_id)
    assert history.replay(command) is None
    history.record_success(command, result)
    assert history.replay(command) == result

    reused = _command("step-id", CommandType.STEP, {"count": 2})
    with pytest.raises(ReplayDomainError) as conflict:
        history.replay(reused)
    assert conflict.value.code is ReplayErrorCode.COMMAND_ID_REUSED

    rejected = _command("stale-id", CommandType.PAUSE, {}, revision=99)
    error = ReplayDomainError(
        ReplayErrorCode.REVISION_CONFLICT,
        "revision mismatch",
        details={"latest_revision": 1},
    )
    history.record_failure(rejected, error)
    for _ in range(2):
        with pytest.raises(ReplayDomainError) as replayed:
            history.replay(rejected)
        assert replayed.value.code is ReplayErrorCode.REVISION_CONFLICT
        assert replayed.value.details == {"latest_revision": 1}


def test_command_history_is_bounded_and_fails_closed_instead_of_evicting_ids() -> None:
    history = CommandHistory(max_records=1)
    first = _command("first", CommandType.PLAY, {})
    history.record_success(first, _result(first.command_id))

    second = _command("second", CommandType.PAUSE, {})
    with pytest.raises(ReplayDomainError) as full:
        history.record_success(second, _result(second.command_id))
    assert full.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
    assert history.replay(first) == _result(first.command_id)
    assert history.diagnostics()["records"] == 1
    assert history.diagnostics()["capacity_rejections"] == 1
