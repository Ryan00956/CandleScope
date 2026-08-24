from __future__ import annotations

import copy
import json
from pathlib import Path

from app.backtest.reports import build_report
from app.backtest.trade_explanation import (
    build_explanation,
    fingerprint_multiset_diff,
    jcs_dumps,
    verify_explanation,
)


FIXTURE = (
    Path(__file__).parent / "fixtures" / "backtest" / "trade_explanation_v1_jcs.json"
)


def _trace(*, variable_count: int = 1) -> dict[str, object]:
    return {
        "sequence": 7,
        "eventTimeMs": 1_724_457_600_000,
        "decisionId": "decision-fixture",
        "decisionTraceOrdinal": 7,
        "ordinalAtTime": 1,
        "reasonCode": "sma_cross",
        "reasonLabel": "fast > slow",
        "source": {"line": 8, "column": 4, "conditionId": "condition-8-1"},
        "conditions": [{"id": "condition-8-1", "label": "fast > slow", "result": True}],
        "variables": {
            f"value_{index:03d}": {"kind": "string", "value": "x" * 3_000}
            for index in range(variable_count)
        },
    }


def test_python_jcs_fixture_and_hash_are_frozen() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    payload = dict(fixture["payload"])
    evidence_hash = payload.pop("evidenceHash")
    assert jcs_dumps(payload) == fixture["canonicalWithoutHash"]
    assert (
        build_explanation(
            run_id="bt_fixture",
            strategy_revision_id="rev_fixture",
            trace={
                "sequence": 7,
                "eventTimeMs": 1_724_457_600_000,
                "decisionId": "decision-fixture",
                "decisionTraceOrdinal": 7,
                "reasonCode": "sma_cross",
                "reasonLabel": "fast > slow",
                "source": {"line": 8, "column": 4, "conditionId": "condition-8-1"},
                "conditions": payload["conditions"],
                "variables": payload["variables"],
            },
            action="ENTER",
            trade_id="trade-1",
            order_id="ord-1",
            fill_id="fill-ord-1-1",
            execution_state="FILLED",
            execution_reason="NEXT_BAR_OPEN",
        )["evidenceHash"]
        == evidence_hash
    )
    assert verify_explanation(fixture["payload"]) is True


def test_budget_overflow_is_deterministic_partial_and_hash_mismatch_is_invalid() -> (
    None
):
    first = build_explanation(
        run_id="bt_budget",
        strategy_revision_id="rev_budget",
        trace=_trace(variable_count=160),
        action="ENTER",
        trade_id=None,
        order_id="ord-1",
        fill_id="fill-ord-1-1",
        execution_state="FILLED",
        execution_reason="NEXT_BAR_OPEN",
    )
    second = build_explanation(
        run_id="bt_budget",
        strategy_revision_id="rev_budget",
        trace=_trace(variable_count=160),
        action="ENTER",
        trade_id=None,
        order_id="ord-1",
        fill_id="fill-ord-1-1",
        execution_state="FILLED",
        execution_reason="NEXT_BAR_OPEN",
    )
    assert first == second
    assert first["completeness"] == "PARTIAL"
    assert first["omissions"]["variablesDropped"] == 129
    assert first["omissions"]["valuesTruncated"] == 128
    assert verify_explanation(first) is True
    corrupted = copy.deepcopy(first)
    corrupted["reasonCode"] = "hindsight"
    assert verify_explanation(corrupted) is False


def test_trade_fingerprint_diff_is_an_exact_occurrence_multiset() -> None:
    fingerprint = {"version": "TRADE_FINGERPRINT_V2", "hash": "sha256:" + "a" * 64}
    result = fingerprint_multiset_diff(
        [{"trade_fingerprint": fingerprint}, {"trade_fingerprint": fingerprint}],
        [{"trade_fingerprint": fingerprint}],
    )
    assert result["unchangedCount"] == 1
    assert result["removedCount"] == 1
    assert result["addedCount"] == 0


def test_trace_overflow_is_reported_partial_without_breaking_the_run_report() -> None:
    report = build_report(
        {
            "run_id": "bt_partial_trace",
            "state": "COMPLETED",
            "fidelity_mode": "BAR_APPROX",
            "source_event_kind": "BAR",
            "strategy_revision_id": "rev_partial_trace",
            "config_json": "{}",
        },
        {
            "trade_explanation_enabled": True,
            "trade_explanation_trace": [_trace()],
            "strategy_metadata": {
                "tradeExplanationTraceMeta": {
                    "maxRows": 10_000,
                    "maxBytes": 1_048_576,
                    "captured": 1,
                    "capturedBytes": 512,
                    "dropped": 3,
                    "complete": False,
                }
            },
            "fills": [],
            "orders": [],
            "rejected": [],
            "ledger": {},
            "equity_curve": [],
        },
    )
    assert report["state"] == "COMPLETED"
    assert report["trade_explanation"]["completeness"] == "PARTIAL"
    assert report["trade_explanation"]["trace"]["dropped"] == 3
