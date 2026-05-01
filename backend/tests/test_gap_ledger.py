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
