from __future__ import annotations

import asyncio
from functools import wraps
from typing import Any

import pytest

from candlescope_plugin_sdk.platform_v2 import PAPER_EXECUTOR_ACK_V1
from candlescope_plugin_sdk.platform_v2.examples.paper_broker import (
    paper_broker_manifest,
)

from app.plugin_core_v2.contracts import core_contributions
from app.plugin_paper_v2 import PaperQuote, PaperTradingError, PluginPaperRuntime
from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.grants import EffectiveGrant
from app.plugin_security_v2.storage import atomic_write_json, read_json


def _async_test(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return wrapped


def _grants() -> tuple[EffectiveGrant, ...]:
    manifest = paper_broker_manifest()
    return tuple(
        EffectiveGrant(
            manifest.plugin.id,
            request.id,
            "required",
            request.scope,
            1,
            "sha256:" + "1" * 64,
            "manifest:candlescope",
            1,
        )
        for request in manifest.permissions.required
    )


def _ack(payload: dict[str, Any], status: str) -> dict[str, Any]:
    intent = payload.get("intent", {})
    broker_id = payload.get("brokerId", intent.get("brokerId"))
    account_id = payload.get("accountId", intent.get("accountId"))
    idempotency_key = payload.get("idempotencyKey", intent.get("idempotencyKey"))
    return {
        "schemaVersion": PAPER_EXECUTOR_ACK_V1,
        "operation": payload["operation"],
        "status": status,
        "brokerId": broker_id,
        "accountId": account_id,
        "idempotencyKey": idempotency_key,
        "executorOrderId": "executor-order" if status == "accepted" else None,
        "reasonCode": "FIXTURE_REJECTED" if status == "rejected" else None,
    }


def _runtime(
    tmp_path,
    *,
    now_ms: list[int],
    unknown: bool = False,
    unknown_cancel: bool = False,
):
    calls: list[dict[str, Any]] = []

    async def invoke(contribution, payload, user_action, trace_id):
        calls.append(payload)
        if payload["operation"] == "orders.submit" and (
            unknown or payload["intent"]["idempotencyKey"].startswith("unknown-")
        ):
            return _ack(payload, "unknown")
        if payload["operation"] == "orders.cancel" and unknown_cancel:
            return _ack(payload, "unknown")
        return _ack(payload, "accepted")

    runtime = PluginPaperRuntime(
        root=tmp_path,
        audit_log=AuditLog(tmp_path / "audit"),
        invoke=invoke,
        clock_ms=lambda: now_ms[0],
    )
    runtime.register_plugin(core_contributions(paper_broker_manifest()), _grants())
    return runtime, calls


def _intent(
    key: str,
    *,
    order_type: str = "market",
    limit_price: str | None = None,
    quote_id: str = "quote-1",
    observed_ms: int = 1_700_000_000_000,
    quantity: str = "0.1",
) -> dict[str, Any]:
    return {
        "brokerId": "fixture-paper",
        "accountId": "paper-main",
        "clientOrderId": "client-" + key,
        "idempotencyKey": key,
        "symbol": "BTCUSDT",
        "marketType": "spot",
        "side": "buy",
        "orderType": order_type,
        "quantity": quantity,
        "limitPrice": limit_price,
        "quoteId": quote_id,
        "observedMarketTimeMs": observed_ms,
    }


@_async_test
async def test_host_owns_fill_balances_audit_and_submit_idempotency(tmp_path) -> None:
    now_ms = [1_700_000_000_000]
    runtime, calls = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "100.5", now_ms[0])
    )

    first = await runtime.submit(_intent("submit-1"), trace_id="submit-1")
    repeated = await runtime.submit(_intent("submit-1"), trace_id="submit-repeat")

    assert first["order"]["status"] == "filled"
    assert first["order"]["averageFillPrice"] == "100.5"
    assert repeated["idempotentReplay"] is True
    assert len([item for item in calls if item["operation"] == "orders.submit"]) == 1
    snapshot = await runtime.account_snapshot("fixture-paper", "paper-main")
    balances = {item["asset"]: item for item in snapshot["balances"]}
    assert balances["BTC"]["available"] == "2.1"
    assert balances["USDT"]["available"] == "99989.95"
    events = AuditLog(tmp_path / "audit").read_all()
    assert [(item.action, item.outcome) for item in events] == [("submit", "filled")]


@_async_test
async def test_open_limit_cancel_and_fill_are_serialized_and_release_reservations(
    tmp_path,
) -> None:
    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "101", now_ms[0])
    )

    opened = await runtime.submit(
        _intent("limit-cancel", order_type="limit", limit_price="100"),
        trace_id="limit-open",
    )
    assert opened["order"]["status"] == "open"
    locked = await runtime.account_snapshot("fixture-paper", "paper-main")
    assert {item["asset"]: item for item in locked["balances"]}["USDT"][
        "locked"
    ] == "10"
    cancelled = await runtime.cancel(
        broker_id="fixture-paper",
        account_id="paper-main",
        order_id=opened["order"]["orderId"],
        idempotency_key="cancel-1",
        trace_id="cancel",
    )
    assert cancelled["order"]["status"] == "cancelled"
    released = await runtime.account_snapshot("fixture-paper", "paper-main")
    assert {item["asset"]: item for item in released["balances"]}["USDT"][
        "locked"
    ] == "0"

    second = await runtime.submit(
        _intent("limit-fill", order_type="limit", limit_price="100"),
        trace_id="limit-open-2",
    )
    now_ms[0] += 1_000
    await runtime.publish_quote(
        PaperQuote("quote-2", "BTCUSDT", "spot", "88", "89", now_ms[0])
    )
    snapshot = await runtime.account_snapshot("fixture-paper", "paper-main")
    order = next(
        item
        for item in snapshot["orders"]
        if item["orderId"] == second["order"]["orderId"]
    )
    assert order["status"] == "filled"
    assert order["averageFillPrice"] == "89"
    replayed = await runtime.submit(
        _intent("limit-fill", order_type="limit", limit_price="100"),
        trace_id="limit-filled-replay",
    )
    assert replayed["idempotentReplay"] is True
    assert replayed["order"]["status"] == "filled"


@_async_test
async def test_unknown_cancel_retains_one_reservation_until_explicit_recovery(
    tmp_path,
) -> None:
    now_ms = [1_700_000_000_000]
    runtime, calls = _runtime(tmp_path, now_ms=now_ms, unknown_cancel=True)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "101", now_ms[0])
    )
    opened = await runtime.submit(
        _intent("cancel-unknown", order_type="limit", limit_price="100"),
        trace_id="cancel-unknown-open",
    )
    cancelled = await runtime.cancel(
        broker_id="fixture-paper",
        account_id="paper-main",
        order_id=opened["order"]["orderId"],
        idempotency_key="cancel-unknown-1",
        trace_id="cancel-unknown",
    )
    assert cancelled["order"]["status"] == "unknown"
    replayed = await runtime.submit(
        _intent("cancel-unknown", order_type="limit", limit_price="100"),
        trace_id="cancel-unknown-submit-replay",
    )
    assert replayed["order"]["status"] == "unknown"
    snapshot = await runtime.account_snapshot("fixture-paper", "paper-main")
    assert {item["asset"]: item for item in snapshot["balances"]}["USDT"][
        "locked"
    ] == "10"

    with pytest.raises(
        PaperTradingError,
        match="cancellation must be recovered before submission recovery",
    ):
        await runtime.recover(
            broker_id="fixture-paper",
            account_id="paper-main",
            idempotency_key="cancel-unknown",
            trace_id="cancel-unknown-submit-recover",
        )
    recovered = await runtime.recover(
        broker_id="fixture-paper",
        account_id="paper-main",
        idempotency_key="cancel-unknown-1",
        target_operation="orders.cancel",
        order_id=opened["order"]["orderId"],
        trace_id="cancel-unknown-recover",
    )
    assert recovered["order"]["status"] == "cancelled"
    snapshot = await runtime.account_snapshot("fixture-paper", "paper-main")
    assert {item["asset"]: item for item in snapshot["balances"]}["USDT"][
        "locked"
    ] == "0"
    assert [item["operation"] for item in calls].count("orders.cancel") == 1
    assert [item["operation"] for item in calls].count("orders.recover") == 1
    assert calls[-1]["targetOperation"] == "orders.cancel"
    assert calls[-1]["orderId"] == opened["order"]["orderId"]


@_async_test
async def test_rejected_cancel_recovery_restores_the_pre_cancel_order(tmp_path) -> None:
    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms, unknown_cancel=True)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "101", now_ms[0])
    )
    opened = await runtime.submit(
        _intent("cancel-rejected", order_type="limit", limit_price="100"),
        trace_id="cancel-rejected-open",
    )
    unknown = await runtime.cancel(
        broker_id="fixture-paper",
        account_id="paper-main",
        order_id=opened["order"]["orderId"],
        idempotency_key="cancel-rejected-1",
        trace_id="cancel-rejected",
    )
    assert unknown["order"]["status"] == "unknown"

    async def reject_recovery(contribution, payload, user_action, trace_id):
        return _ack(payload, "rejected")

    runtime._invoke = reject_recovery
    recovered = await runtime.recover(
        broker_id="fixture-paper",
        account_id="paper-main",
        idempotency_key="cancel-rejected-1",
        target_operation="orders.cancel",
        order_id=opened["order"]["orderId"],
        trace_id="cancel-rejected-recover",
    )
    assert recovered["order"]["status"] == "open"
    snapshot = await runtime.account_snapshot("fixture-paper", "paper-main")
    assert {item["asset"]: item for item in snapshot["balances"]}["USDT"][
        "locked"
    ] == "10"


@_async_test
async def test_cancelled_cancel_is_persisted_unknown_and_never_replayed(
    tmp_path,
) -> None:
    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "101", now_ms[0])
    )
    opened = await runtime.submit(
        _intent("cancel-task", order_type="limit", limit_price="100"),
        trace_id="cancel-task-open",
    )
    cancel_entered = asyncio.Event()
    cancel_calls: list[dict[str, Any]] = []

    async def wait_during_cancel(contribution, payload, user_action, trace_id):
        cancel_calls.append(payload)
        cancel_entered.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    runtime._invoke = wait_during_cancel
    task = asyncio.create_task(
        runtime.cancel(
            broker_id="fixture-paper",
            account_id="paper-main",
            order_id=opened["order"]["orderId"],
            idempotency_key="cancel-task-1",
            trace_id="cancel-task",
        )
    )
    await asyncio.wait_for(cancel_entered.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    state = read_json(runtime.state_path, "Paper test state")
    cancel_record = next(iter(state["cancelIdempotency"].values()))
    assert cancel_record["status"] == "unknown"
    assert cancel_record["result"]["order"]["status"] == "unknown"
    account = next(iter(state["accounts"].values()))
    assert account["orders"][opened["order"]["orderId"]]["status"] == "unknown"
    submission = next(iter(state["idempotency"].values()))
    assert submission["status"] == "unknown"
    assert len(cancel_calls) == 1

    restarted, replay_calls = _runtime(tmp_path, now_ms=now_ms)
    replayed = await restarted.cancel(
        broker_id="fixture-paper",
        account_id="paper-main",
        order_id=opened["order"]["orderId"],
        idempotency_key="cancel-task-1",
        trace_id="cancel-task-replay",
    )
    assert replayed["idempotentReplay"] is True
    assert replayed["order"]["status"] == "unknown"
    assert replay_calls == []


@_async_test
async def test_pending_cancel_becomes_unknown_after_restart_and_requires_recovery(
    tmp_path,
) -> None:
    class SimulatedProcessCrash(BaseException):
        pass

    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "101", now_ms[0])
    )
    opened = await runtime.submit(
        _intent("cancel-crash", order_type="limit", limit_price="100"),
        trace_id="cancel-crash-open",
    )
    crash_calls: list[dict[str, Any]] = []

    async def crash_after_cancel(contribution, payload, user_action, trace_id):
        crash_calls.append(payload)
        raise SimulatedProcessCrash

    runtime._invoke = crash_after_cancel
    with pytest.raises(SimulatedProcessCrash):
        await runtime.cancel(
            broker_id="fixture-paper",
            account_id="paper-main",
            order_id=opened["order"]["orderId"],
            idempotency_key="cancel-crash-1",
            trace_id="cancel-crash",
        )
    pending_state = read_json(runtime.state_path, "Paper test state")
    assert next(iter(pending_state["cancelIdempotency"].values()))["status"] == (
        "pending"
    )
    assert len(crash_calls) == 1

    restarted, recovery_calls = _runtime(tmp_path, now_ms=now_ms)
    recovered_state = read_json(restarted.state_path, "Paper test state")
    cancel_record = next(iter(recovered_state["cancelIdempotency"].values()))
    assert cancel_record["status"] == "unknown"
    assert cancel_record["result"]["order"]["status"] == "unknown"
    account = next(iter(recovered_state["accounts"].values()))
    assert account["orders"][opened["order"]["orderId"]]["status"] == "unknown"
    submission = next(iter(recovered_state["idempotency"].values()))
    assert submission["status"] == "unknown"

    replayed = await restarted.cancel(
        broker_id="fixture-paper",
        account_id="paper-main",
        order_id=opened["order"]["orderId"],
        idempotency_key="cancel-crash-1",
        trace_id="cancel-crash-replay",
    )
    assert replayed["idempotentReplay"] is True
    assert replayed["order"]["status"] == "unknown"
    assert recovery_calls == []

    with pytest.raises(PaperTradingError, match="cancellation must be recovered"):
        await restarted.recover(
            broker_id="fixture-paper",
            account_id="paper-main",
            idempotency_key="cancel-crash",
            trace_id="cancel-crash-submit-recover",
        )
    recovered = await restarted.recover(
        broker_id="fixture-paper",
        account_id="paper-main",
        idempotency_key="cancel-crash-1",
        target_operation="orders.cancel",
        order_id=opened["order"]["orderId"],
        trace_id="cancel-crash-recover",
    )
    assert recovered["order"]["status"] == "cancelled"
    assert [item["operation"] for item in recovery_calls] == ["orders.recover"]
    assert recovery_calls[0]["targetOperation"] == "orders.cancel"


@_async_test
async def test_active_order_exposure_is_included_in_position_limit(tmp_path) -> None:
    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    runtime._brokers["fixture-paper"].limits["maxPositionNotional"] = "15"
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "101", now_ms[0])
    )
    await runtime.submit(
        _intent("exposure-1", order_type="limit", limit_price="100"),
        trace_id="exposure-1",
    )
    with pytest.raises(PaperTradingError, match="position limit"):
        await runtime.submit(
            _intent("exposure-2", order_type="limit", limit_price="100"),
            trace_id="exposure-2",
        )


@_async_test
async def test_position_average_is_weighted_across_host_fills(tmp_path) -> None:
    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "100.5", now_ms[0])
    )
    await runtime.submit(_intent("average-1"), trace_id="average-1")
    now_ms[0] += 1_000
    await runtime.publish_quote(
        PaperQuote("quote-2", "BTCUSDT", "spot", "200", "200.5", now_ms[0])
    )
    await runtime.submit(
        _intent("average-2", quote_id="quote-2", observed_ms=now_ms[0]),
        trace_id="average-2",
    )
    snapshot = await runtime.account_snapshot("fixture-paper", "paper-main")
    assert snapshot["positions"] == [
        {
            "symbol": "BTCUSDT",
            "marketType": "spot",
            "quantity": "0.2",
            "averagePrice": "150.5",
            "markPrice": "200",
            "unrealizedPnl": "9.9",
        }
    ]


@_async_test
async def test_unknown_submit_never_replays_and_explicit_recovery_executes_once(
    tmp_path,
) -> None:
    now_ms = [1_700_000_000_000]
    runtime, calls = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "100.5", now_ms[0])
    )
    unknown = await runtime.submit(_intent("unknown-1"), trace_id="unknown-submit")
    assert unknown["order"]["status"] == "unknown"
    assert (await runtime.submit(_intent("unknown-1"), trace_id="no-replay"))["order"][
        "status"
    ] == "unknown"
    assert len([item for item in calls if item["operation"] == "orders.submit"]) == 1

    state = read_json(runtime.state_path, "Paper test state")
    record = next(iter(state["idempotency"].values()))
    record["status"] = "pending"
    record["result"]["order"]["status"] = "pending"
    account = next(iter(state["accounts"].values()))
    account["orders"][record["orderId"]]["status"] = "pending"
    atomic_write_json(runtime.state_path, state)
    runtime, recovery_calls = _runtime(tmp_path, now_ms=now_ms)
    recovered_replay = await runtime.submit(
        _intent("unknown-1"), trace_id="restart-no-replay"
    )
    assert recovered_replay["order"]["status"] == "unknown"
    assert recovery_calls == []

    recovered = await runtime.recover(
        broker_id="fixture-paper",
        account_id="paper-main",
        idempotency_key="unknown-1",
        trace_id="recover",
    )
    assert recovered["order"]["status"] == "filled"
    assert (
        len([item for item in recovery_calls if item["operation"] == "orders.recover"])
        == 1
    )


@_async_test
async def test_cancelled_submit_becomes_unknown_without_replaying_sidecar(
    tmp_path,
) -> None:
    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "100.5", now_ms[0])
    )
    submit_entered = asyncio.Event()
    submit_calls: list[dict[str, Any]] = []

    async def wait_during_submit(contribution, payload, user_action, trace_id):
        submit_calls.append(payload)
        submit_entered.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    runtime._invoke = wait_during_submit
    task = asyncio.create_task(
        runtime.submit(_intent("submit-task"), trace_id="submit-task")
    )
    await asyncio.wait_for(submit_entered.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    state = read_json(runtime.state_path, "Paper test state")
    record = next(iter(state["idempotency"].values()))
    assert record["status"] == "unknown"
    assert record["result"]["order"]["status"] == "unknown"
    replayed = await runtime.submit(
        _intent("submit-task"),
        trace_id="submit-task-replay",
    )
    assert replayed["idempotentReplay"] is True
    assert replayed["order"]["status"] == "unknown"
    assert len(submit_calls) == 1


@_async_test
async def test_cancelled_recovery_persists_unknown_attempt_until_explicit_retry(
    tmp_path,
) -> None:
    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "100.5", now_ms[0])
    )
    await runtime.submit(
        _intent("unknown-recover-task"),
        trace_id="recover-task-submit",
    )
    recover_entered = asyncio.Event()
    recover_calls: list[dict[str, Any]] = []

    async def wait_during_recover(contribution, payload, user_action, trace_id):
        recover_calls.append(payload)
        recover_entered.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    runtime._invoke = wait_during_recover
    task = asyncio.create_task(
        runtime.recover(
            broker_id="fixture-paper",
            account_id="paper-main",
            idempotency_key="unknown-recover-task",
            trace_id="recover-task",
        )
    )
    await asyncio.wait_for(recover_entered.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    state = read_json(runtime.state_path, "Paper test state")
    record = next(iter(state["idempotency"].values()))
    assert record["status"] == "unknown"
    assert record["recovery"] == {"status": "unknown", "attempt": 1}
    assert record["result"]["order"]["status"] == "unknown"
    assert len(recover_calls) == 1

    restarted, retry_calls = _runtime(tmp_path, now_ms=now_ms)
    replayed = await restarted.submit(
        _intent("unknown-recover-task"),
        trace_id="recover-task-no-auto-retry",
    )
    assert replayed["order"]["status"] == "unknown"
    assert retry_calls == []
    recovered = await restarted.recover(
        broker_id="fixture-paper",
        account_id="paper-main",
        idempotency_key="unknown-recover-task",
        trace_id="recover-task-explicit-retry",
    )
    assert recovered["order"]["status"] == "filled"
    repeated = await restarted.recover(
        broker_id="fixture-paper",
        account_id="paper-main",
        idempotency_key="unknown-recover-task",
        trace_id="recover-task-terminal-replay",
    )
    assert repeated["idempotentReplay"] is True
    assert [item["operation"] for item in retry_calls] == ["orders.recover"]
    final_state = read_json(restarted.state_path, "Paper test state")
    final_record = next(iter(final_state["idempotency"].values()))
    assert final_record["recovery"] == {"status": "completed", "attempt": 2}


@_async_test
async def test_pending_recovery_becomes_unknown_after_process_restart(
    tmp_path,
) -> None:
    class SimulatedProcessCrash(BaseException):
        pass

    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "100.5", now_ms[0])
    )
    await runtime.submit(
        _intent("unknown-recover-crash"),
        trace_id="recover-crash-submit",
    )
    crash_calls: list[dict[str, Any]] = []

    async def crash_during_recover(contribution, payload, user_action, trace_id):
        crash_calls.append(payload)
        raise SimulatedProcessCrash

    runtime._invoke = crash_during_recover
    with pytest.raises(SimulatedProcessCrash):
        await runtime.recover(
            broker_id="fixture-paper",
            account_id="paper-main",
            idempotency_key="unknown-recover-crash",
            trace_id="recover-crash",
        )
    pending_state = read_json(runtime.state_path, "Paper test state")
    pending_record = next(iter(pending_state["idempotency"].values()))
    assert pending_record["recovery"] == {"status": "pending", "attempt": 1}
    assert len(crash_calls) == 1

    restarted, retry_calls = _runtime(tmp_path, now_ms=now_ms)
    recovered_state = read_json(restarted.state_path, "Paper test state")
    recovered_record = next(iter(recovered_state["idempotency"].values()))
    assert recovered_record["status"] == "unknown"
    assert recovered_record["recovery"] == {"status": "unknown", "attempt": 1}
    assert retry_calls == []
    await restarted.submit(
        _intent("unknown-recover-crash"),
        trace_id="recover-crash-no-auto-retry",
    )
    assert retry_calls == []
    recovered = await restarted.recover(
        broker_id="fixture-paper",
        account_id="paper-main",
        idempotency_key="unknown-recover-crash",
        trace_id="recover-crash-explicit-retry",
    )
    assert recovered["order"]["status"] == "filled"
    assert [item["operation"] for item in retry_calls] == ["orders.recover"]


@pytest.mark.parametrize(
    "recovery",
    [
        {},
        {"status": "pending"},
        {"status": "invalid", "attempt": 1},
        {"status": "unknown", "attempt": 0},
        {"status": "completed", "attempt": True},
        {"status": "completed", "attempt": 1, "extra": "field"},
    ],
)
@_async_test
async def test_recovery_state_requires_exact_valid_attempt_shape(
    tmp_path,
    recovery,
) -> None:
    now_ms = [1_700_000_000_000]
    runtime, _ = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("quote-1", "BTCUSDT", "spot", "100", "100.5", now_ms[0])
    )
    await runtime.submit(
        _intent("unknown-invalid-recovery"),
        trace_id="invalid-recovery-submit",
    )
    state = read_json(runtime.state_path, "Paper test state")
    next(iter(state["idempotency"].values()))["recovery"] = recovery
    atomic_write_json(runtime.state_path, state)

    with pytest.raises(PaperTradingError, match="recovery attempt is invalid"):
        _runtime(tmp_path, now_ms=now_ms)


@_async_test
async def test_quote_time_kill_switch_and_revocation_fail_closed(tmp_path) -> None:
    now_ms = [1_700_000_010_001]
    runtime, calls = _runtime(tmp_path, now_ms=now_ms)
    await runtime.publish_quote(
        PaperQuote("stale", "BTCUSDT", "spot", "100", "101", 1_700_000_000_000)
    )
    with pytest.raises(PaperTradingError, match="current bounded Host quote"):
        await runtime.submit(
            _intent("stale-1", quote_id="stale", observed_ms=1_700_000_000_000),
            trace_id="stale",
        )
    assert calls == []

    await runtime.publish_quote(
        PaperQuote("quote-2", "BTCUSDT", "spot", "100", "101", now_ms[0])
    )
    opened = await runtime.submit(
        _intent(
            "kill-open",
            order_type="limit",
            limit_price="100",
            quote_id="quote-2",
            observed_ms=now_ms[0],
        ),
        trace_id="kill-open",
    )
    assert opened["order"]["status"] == "open"
    status = await runtime.set_kill_switch(True, trace_id="kill")
    assert status["killSwitchEnabled"] is True
    killed_replay = await runtime.submit(
        _intent(
            "kill-open",
            order_type="limit",
            limit_price="100",
            quote_id="quote-2",
            observed_ms=now_ms[0],
        ),
        trace_id="kill-open-replay",
    )
    assert killed_replay["idempotentReplay"] is True
    assert killed_replay["order"]["status"] == "cancelled"
    with pytest.raises(PaperTradingError, match="kill switch"):
        await runtime.submit(
            _intent("blocked", quote_id="quote-2", observed_ms=now_ms[0]),
            trace_id="blocked",
        )
    await runtime.set_kill_switch(False, trace_id="resume")
    await runtime.clear_plugin("candlescope.paper-broker")
    with pytest.raises(PaperTradingError, match="not active"):
        await runtime.submit(
            _intent("revoked", quote_id="quote-2", observed_ms=now_ms[0]),
            trace_id="revoked",
        )
