from __future__ import annotations

from app.data_engine.data_manager.manager import DataManager
from app.data_engine.data_manager.models import MissingRange, QueryResult


def test_data_manager_exposes_terminal_covering_suppression_without_resubmitting() -> None:
    manager = DataManager()
    trigger_calls: list[tuple] = []
    lookup_calls: list[tuple] = []

    def _trigger(*args, **kwargs):
        trigger_calls.append((args, kwargs))
        return "unexpected-request"

    def _lookup(symbol, interval, start_ms, end_ms, exchange, market_type):
        lookup_calls.append((
            symbol,
            interval,
            start_ms,
            end_ms,
            exchange,
            market_type,
        ))
        return {
            "suppressed": True,
            "source": "gap_ledger",
            "ledger_id": 7,
            "ledger_status": "source_empty",
            "start_ms": 0,
            "end_ms": 180_000,
            "reason": "provider range empty",
            "retry_at_ms": 86_401_000,
            "retryable": False,
            "terminal": True,
        }

    manager.set_backfill_trigger(_trigger)
    manager.set_backfill_suppression_lookup(_lookup)
    result = QueryResult(
        symbol="BTCUSDT",
        interval="1m",
        has_more=True,
        has_tail_gap=True,
        missing_ranges=[MissingRange(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=60_000,
            end_ms=60_000,
        )],
        history_state="pending",
        retryable=True,
    )

    returned = manager._submit_missing_ranges(result)

    assert returned is result
    assert trigger_calls == []
    assert lookup_calls == [(
        "BTCUSDT",
        "1m",
        60_000,
        60_000,
        "binance",
        "spot",
    )]
    assert result.missing_ranges == []
    assert result.backfill_triggered is False
    assert result.history_state == "ready"
    assert result.complete is True
    assert result.retryable is False
    assert result.has_more is True
    assert result.has_tail_gap is False
    assert result.terminal_reason == "gap_ledger_source_empty"
    assert result.metadata["backfill_retry_at_ms"] == 86_401_000
    assert result.metadata["backfill_suppressions"][0]["ledger_id"] == 7
    assert result.excluded_ranges == [{
        "start_ms": 60_000,
        "end_ms": 60_000,
        "disposition": "terminal",
        "reason": "gap_ledger_source_empty",
        "ledger_status": "source_empty",
        "retry_at_ms": 86_401_000,
    }]

    assert manager.request_backfill(
        "BTCUSDT",
        "1m",
        60_000,
        60_000,
    ) is False
    assert trigger_calls == []


def test_data_manager_only_removes_suppressed_ranges_from_mixed_result() -> None:
    manager = DataManager()
    trigger_calls: list[tuple] = []

    def _trigger(*args, **kwargs):
        trigger_calls.append((args, kwargs))
        return "repair-unsuppressed"

    def _lookup(symbol, interval, start_ms, end_ms, exchange, market_type):
        if start_ms != 60_000:
            return None
        return {
            "suppressed": True,
            "source": "gap_ledger",
            "ledger_id": 7,
            "ledger_status": "failed",
            "start_ms": 0,
            "end_ms": 120_000,
            "reason": "provider failed",
            "retry_at_ms": 901_000,
            "retryable": False,
            "terminal": True,
        }

    manager.set_backfill_trigger(_trigger)
    manager.set_backfill_suppression_lookup(_lookup)
    actionable = MissingRange(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=180_000,
        end_ms=180_000,
        reason="query_tail_gap",
    )
    result = QueryResult(
        symbol="BTCUSDT",
        interval="1m",
        has_more=True,
        has_tail_gap=True,
        missing_ranges=[
            MissingRange(
                symbol="BTCUSDT",
                interval="1m",
                start_ms=60_000,
                end_ms=60_000,
            ),
            actionable,
        ],
        history_state="pending",
        retryable=True,
    )

    manager._submit_missing_ranges(result)

    assert result.missing_ranges == [actionable]
    assert result.history_state == "pending"
    assert result.complete is False
    assert result.retryable is True
    assert result.has_more is True
    assert result.has_tail_gap is True
    assert result.backfill_triggered is True
    assert len(trigger_calls) == 1
    assert trigger_calls[0][0][2:4] == (180_000, 180_000)
    assert result.metadata["backfill_request_ids"] == ["repair-unsuppressed"]
    assert result.excluded_ranges[0]["start_ms"] == 60_000


def test_data_manager_preserves_genuine_exhausted_state_under_suppression() -> None:
    manager = DataManager()
    manager.set_backfill_suppression_lookup(
        lambda *args: {
            "suppressed": True,
            "ledger_status": "source_empty",
            "start_ms": 0,
            "end_ms": 60_000,
            "retry_at_ms": 86_400_000,
        }
    )
    result = QueryResult(
        symbol="BTCUSDT",
        interval="1m",
        missing_ranges=[MissingRange(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=0,
            end_ms=60_000,
        )],
        history_state="exhausted",
        complete=True,
        retryable=False,
        has_more=False,
    )

    manager._submit_missing_ranges(result)

    assert result.missing_ranges == []
    assert result.history_state == "exhausted"
    assert result.complete is True
    assert result.retryable is False
    assert result.has_more is False


def test_data_manager_resolves_suppression_when_submission_is_disabled() -> None:
    manager = DataManager()
    trigger_calls: list[tuple] = []
    manager.set_backfill_trigger(
        lambda *args, **kwargs: trigger_calls.append((args, kwargs))
    )
    manager.set_backfill_suppression_lookup(
        lambda *args: {
            "suppressed": True,
            "ledger_status": "unavailable",
            "start_ms": 0,
            "end_ms": 120_000,
            "retry_at_ms": 900_000,
        }
    )
    result = QueryResult(
        symbol="BTCUSDT",
        interval="1m",
        missing_ranges=[MissingRange(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=60_000,
            end_ms=60_000,
        )],
        history_state="pending",
        retryable=True,
        has_more=True,
    )

    manager._submit_missing_ranges(result, submit=False)

    assert trigger_calls == []
    assert result.missing_ranges == []
    assert result.history_state == "ready"
    assert result.complete is True
    assert result.retryable is False
    assert result.has_more is True
    assert result.terminal_reason == "gap_ledger_unavailable"
    assert result.metadata["backfill_retry_at_ms"] == 900_000
    assert result.excluded_ranges[0]["reason"] == "gap_ledger_unavailable"
