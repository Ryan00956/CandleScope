from __future__ import annotations

from app.data_engine.data_manager.backfill_coordinator import RepairRequest
from app.data_engine.storage.gap_ledger import GapLedger


def _request() -> RepairRequest:
    return RepairRequest(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=0,
        end_ms=60_000,
        exchange="binance",
        market_type="spot",
        request_id="gap",
    )


def test_gap_ledger_preserves_missing_count_when_resolution_count_unknown(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    request = _request()

    ledger.upsert_detected(request)
    ledger.mark_resolved(request, status="source_empty", missing_count=None)

    status = ledger.get_status(request)
    assert status is not None
    assert status["status"] == "source_empty"
    assert status["missing_count"] == 2
    assert status["next_retry_at"] is not None


def test_gap_ledger_filled_unknown_count_sets_missing_count_zero(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    request = _request()

    ledger.upsert_detected(request)
    ledger.mark_resolved(request, status="filled", missing_count=None)

    status = ledger.get_status(request)
    assert status is not None
    assert status["status"] == "filled"
    assert status["missing_count"] == 0


def test_gap_ledger_closes_legacy_entries_fully_covered_by_verified_repair(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    covered_source_empty = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=86_400_000,
        # Legacy records sometimes used an inclusive bar close instead of the
        # canonical bar open used by current repair requests.
        end_ms=172_799_999,
        exchange="binance",
        market_type="futures",
        request_id="legacy-source-empty",
    )
    covered_failed = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=86_400_000,
        end_ms=86_400_000,
        exchange="binance",
        market_type="futures",
        request_id="legacy-failed",
    )
    outside_failed = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=172_800_000,
        end_ms=172_800_000,
        exchange="binance",
        market_type="futures",
        request_id="outside-failed",
    )
    for request, status in (
        (covered_source_empty, "source_empty"),
        (covered_failed, "failed"),
        (outside_failed, "failed"),
    ):
        ledger.upsert_detected(request)
        ledger.mark_resolved(request, status=status)

    verified_parent = RepairRequest(
        symbol="BTCUSDT",
        interval="1d",
        start_ms=86_400_000,
        end_ms=86_400_000,
        exchange="binance",
        market_type="futures",
        request_id="verified-parent",
    )
    assert ledger.mark_covered_resolved(verified_parent) == 2

    assert ledger.get_status(covered_source_empty)["status"] == "filled"
    assert ledger.get_status(covered_failed)["status"] == "filled"
    assert ledger.get_status(outside_failed)["status"] == "failed"


def test_gap_ledger_keeps_forming_not_expected_rows_out_of_open_repairs(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    request = _request()
    ledger.upsert_detected(request)
    ledger.mark_deferred(request, status="not_expected", reason="forming_bar")

    status = ledger.get_status(request)
    assert status is not None
    assert status["status"] == "not_expected"
    assert ledger.list_open() == []


def test_gap_ledger_pending_merge_supersedes_old_natural_key(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    original = _request()
    widened = RepairRequest(
        symbol=original.symbol,
        interval=original.interval,
        start_ms=0,
        end_ms=180_000,
        exchange=original.exchange,
        market_type=original.market_type,
        request_id=original.request_id,
    )

    ledger.upsert_detected(original)
    ledger.upsert_detected(widened)

    assert ledger.get_status(original)["status"] == "superseded"
    current = ledger.get_status(widened)
    assert current is not None
    assert current["status"] == "queued"
    assert ledger.health_summary()["open_total"] == 1


def test_gap_ledger_reopen_clears_terminal_fields_and_bounds_reason(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    request = _request()
    request.reason = "+".join(["query_gap"] * 20 + [f"reason_{i}" for i in range(20)])

    ledger.upsert_detected(request)
    ledger.mark_started(request, attempt=4)
    ledger.mark_resolved(request, status="failed", error="x" * 4_000)
    ledger.upsert_detected(request)

    status = ledger.get_status(request)
    assert status is not None
    assert status["status"] == "queued"
    assert status["attempts"] == 0
    assert status["last_error"] is None
    assert status["resolved_at"] is None
    assert status["next_retry_at"] is None
    assert len(status["reason"].split("+")) <= 8
    assert len(status["reason"]) <= 256


def test_old_owned_lifecycle_updates_cannot_overwrite_successor_ticket(
    tmp_path,
) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    operations = (
        (
            "started",
            lambda request: ledger.mark_started(request, attempt=3),
        ),
        (
            "verifying",
            lambda request: ledger.mark_verifying(request),
        ),
        (
            "retry_wait",
            lambda request: ledger.mark_retry_wait(
                request,
                attempt=4,
                error="stale ordinary retry",
                next_retry_at=9_999_999_999_999,
            ),
        ),
    )

    for index, (operation_name, operation) in enumerate(operations):
        predecessor = RepairRequest(
            symbol=("BTCUSDT", "ETHUSDT", "SOLUSDT")[index],
            interval="1m",
            start_ms=0,
            end_ms=60_000,
            exchange="binance",
            market_type="spot",
            request_id=f"ordinary-{operation_name}",
        )
        successor = RepairRequest(
            symbol=predecessor.symbol,
            interval=predecessor.interval,
            start_ms=predecessor.start_ms,
            end_ms=predecessor.end_ms,
            exchange=predecessor.exchange,
            market_type=predecessor.market_type,
            reason="query_untrusted_finality",
            metadata={"requires_trusted_finality": True},
            request_id=f"trusted-{operation_name}",
        )

        ledger.upsert_detected(predecessor)
        ledger.upsert_detected(successor)
        operation(predecessor)

        current = ledger.get_status(successor)
        assert current is not None
        assert current["status"] == "queued"
        assert current["attempts"] == 0
        assert current["last_error"] is None
        assert current["last_checked_at"] is None
        assert current["next_retry_at"] is None
        covering = ledger.get_covering_status(
            exchange=successor.exchange,
            market_type=successor.market_type,
            symbol=successor.symbol,
            interval=successor.interval,
            start_ms=successor.start_ms,
            end_ms=successor.end_ms,
        )
        assert covering is not None
        assert covering["repair_ticket"] == successor.request_id


def test_gap_ledger_compacts_confirmed_widening_source_empty_ranges(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    narrow = _request()
    wide = RepairRequest(
        symbol=narrow.symbol,
        interval=narrow.interval,
        start_ms=narrow.start_ms,
        end_ms=180_000,
        exchange=narrow.exchange,
        market_type=narrow.market_type,
        reason=narrow.reason,
        request_id="wide-gap",
    )

    ledger.upsert_detected(narrow)
    ledger.mark_resolved(narrow, status="source_empty")
    ledger.upsert_detected(wide)
    ledger.mark_resolved(wide, status="source_empty")

    assert ledger.get_status(narrow)["status"] == "superseded"
    assert ledger.get_status(wide)["status"] == "source_empty"
    assert ledger.health_summary()["source_empty_total"] == 1


def test_gap_ledger_compacts_legacy_source_empty_drift_regardless_insert_order(
    tmp_path,
) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    wide = RepairRequest(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=0,
        end_ms=180_000,
        request_id="legacy-wide",
    )
    narrow = RepairRequest(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=0,
        end_ms=60_000,
        request_id="legacy-narrow",
    )
    for request in (wide, narrow):
        ledger.upsert_detected(request)
        ledger.mark_resolved(request, status="source_empty")

    assert ledger.health_summary()["source_empty_total"] == 2
    assert ledger.compact_source_empty_drift() == 1
    assert ledger.get_status(wide)["status"] == "source_empty"
    assert ledger.get_status(narrow)["status"] == "superseded"


def test_gap_ledger_reconciliation_default_excludes_fresh_active_work(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    ledger.upsert_detected(_request())

    assert ledger.list_reconcilable() == []


def test_gap_ledger_health_counts_all_open_rows_beyond_sample_limit(tmp_path) -> None:
    ledger = GapLedger(tmp_path / "klines.sqlite")
    for index in range(75):
        request = RepairRequest(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=index * 120_000,
            end_ms=index * 120_000,
            exchange="binance",
            market_type="spot",
            request_id=f"health-{index}",
        )
        ledger.upsert_detected(request)

    health = ledger.health_summary(sample_limit=50)
    assert len(ledger.list_open(limit=50)) == 50
    assert health["open_total"] == 75
    assert health["by_status"] == {"queued": 75}
    assert sum(health["age_buckets"].values()) == 75


def test_gap_ledger_reconciliation_only_returns_due_inactive_rows(
    tmp_path,
    monkeypatch,
) -> None:
    clock = {"now": 1_000}
    monkeypatch.setattr(
        "app.data_engine.storage.gap_ledger._now_ms",
        lambda: clock["now"],
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    request = _request()
    ledger.upsert_detected(request)
    ledger.mark_resolved(request, status="source_empty")
    retry_at = ledger.get_status(request)["next_retry_at"]

    assert ledger.list_reconcilable(due_before_ms=retry_at - 1) == []
    assert [row["id"] for row in ledger.list_reconcilable(
        due_before_ms=retry_at,
    )]


def test_failed_ledger_rows_back_off_and_recovery_count_extends_deadline(
    tmp_path,
    monkeypatch,
) -> None:
    clock = {"now": 1_000}
    monkeypatch.setattr(
        "app.data_engine.storage.gap_ledger._now_ms",
        lambda: clock["now"],
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    request = _request()
    ledger.upsert_detected(request)
    ledger.mark_resolved(request, status="failed", error="failed")
    first_retry_at = ledger.get_status(request)["next_retry_at"]

    assert first_retry_at == clock["now"] + 15 * 60 * 1_000
    assert ledger.list_reconcilable(
        due_before_ms=first_retry_at - 1,
    ) == []
    assert ledger.list_reconcilable(
        due_before_ms=first_retry_at,
    )

    clock["now"] = first_retry_at
    recovery = RepairRequest(
        symbol=request.symbol,
        interval=request.interval,
        start_ms=request.start_ms,
        end_ms=request.end_ms,
        exchange=request.exchange,
        market_type=request.market_type,
        request_id="recovery-failed",
        metadata={"ledger_recovery_count": 1},
    )
    ledger.upsert_detected(recovery)
    ledger.mark_resolved(recovery, status="failed", error="failed-again")
    second_retry_at = ledger.get_status(recovery)["next_retry_at"]

    assert second_retry_at == clock["now"] + 30 * 60 * 1_000
    assert ledger.list_reconcilable(
        due_before_ms=second_retry_at - 1,
    ) == []


def test_covering_suppression_applies_parent_deadline_to_narrow_child(
    tmp_path,
    monkeypatch,
) -> None:
    clock = {"now": 1_000}
    monkeypatch.setattr(
        "app.data_engine.storage.gap_ledger._now_ms",
        lambda: clock["now"],
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    parent = RepairRequest(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=0,
        end_ms=180_000,
        request_id="covering-parent",
    )
    ledger.upsert_detected(parent)
    ledger.mark_resolved(parent, status="failed", error="failed")
    retry_at = ledger.get_status(parent)["next_retry_at"]

    covering = ledger.get_covering_status(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        start_ms=60_000,
        end_ms=60_000,
        now_ms=clock["now"],
    )
    suppression = ledger.get_covering_suppression(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        start_ms=60_000,
        end_ms=60_000,
        now_ms=clock["now"],
    )

    assert covering["repair_ticket"] == "covering-parent"
    assert suppression["repair_ticket"] == "covering-parent"
    assert suppression["next_retry_at"] == retry_at
    assert [row["repair_ticket"] for row in ledger.list_suppressions(
        now_ms=clock["now"],
    )] == ["covering-parent"]

    clock["now"] = retry_at
    assert ledger.get_covering_suppression(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        start_ms=60_000,
        end_ms=60_000,
        now_ms=clock["now"],
    ) is None


def test_gap_ledger_deferred_recheck_rotates_past_oldest_due_row(
    tmp_path,
    monkeypatch,
) -> None:
    clock = {"now": 0}
    monkeypatch.setattr(
        "app.data_engine.storage.gap_ledger._now_ms",
        lambda: clock["now"],
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    requests: list[RepairRequest] = []
    for index in range(3):
        request = RepairRequest(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=index * 120_000,
            end_ms=index * 120_000,
            request_id=f"rotate-{index}",
        )
        requests.append(request)
        ledger.upsert_detected(request)
        ledger.mark_resolved(request, status="source_empty")

    clock["now"] = 2 * 86_400_000
    first = ledger.list_reconcilable(limit=1, due_before_ms=clock["now"])[0]
    ledger.mark_reconciled_checked(
        requests[0],
        next_retry_at=clock["now"] + 86_400_000,
    )
    second = ledger.list_reconcilable(limit=1, due_before_ms=clock["now"])[0]

    assert first["repair_ticket"] == "rotate-0"
    assert second["repair_ticket"] == "rotate-1"


def test_gap_ledger_backlog_age_uses_first_seen_not_recent_recheck(
    tmp_path,
    monkeypatch,
) -> None:
    clock = {"now": 0}
    monkeypatch.setattr(
        "app.data_engine.storage.gap_ledger._now_ms",
        lambda: clock["now"],
    )
    ledger = GapLedger(tmp_path / "klines.sqlite")
    request = _request()
    ledger.upsert_detected(request)

    clock["now"] = 2 * 86_400_000
    ledger.upsert_detected(request)
    ledger.mark_reconciled_checked(
        request,
        next_retry_at=clock["now"] + 60_000,
    )
    health = ledger.health_summary()

    assert health["age_buckets"]["gte_1d"] == 1
    assert health["age_buckets"]["lt_5m"] == 0
    assert health["last_checked_age_buckets"]["lt_5m"] == 1
    assert health["oldest_open_at"] == 0
