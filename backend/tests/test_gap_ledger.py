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
