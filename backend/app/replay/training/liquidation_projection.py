"""Public, future-safe projection for modelled-account liquidation timelines."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping


def _public_step_reason(value: object) -> str:
    """Reduce internal execution plans to a bounded public cause label."""

    raw = str(value)
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        decoded = None
    if isinstance(decoded, Mapping):
        cause = decoded.get("cause")
        if isinstance(cause, str) and 0 < len(cause) <= 128:
            return cause
    if 0 < len(raw) <= 512:
        return raw
    return "INTERNAL_EXECUTION_PLAN_REDACTED"


def _book_execution(row: sqlite3.Row) -> dict[str, object]:
    return {
        "case_id": str(row["case_id"]),
        "step_sequence": int(row["step_sequence"]),
        "track_id": str(row["track_id"]),
        "as_of_virtual_time_ms": int(row["as_of_virtual_time_ms"]),
        "last_update_id": int(row["last_update_id"]),
        "side": str(row["side"]),
        "requested_quantity": str(row["requested_quantity"]),
        "visible_quantity": str(row["visible_quantity"]),
        "levels": json.loads(str(row["levels_json"])),
        "book_hash": str(row["book_hash"]),
        "execution_fidelity": str(row["execution_fidelity"]),
        "queue_exact": bool(row["queue_exact"]),
        "execution_plan_hash": str(row["execution_plan_hash"]),
    }


def _book_snapshot(row: sqlite3.Row) -> dict[str, object]:
    return {
        "case_id": str(row["case_id"]),
        "track_id": str(row["track_id"]),
        "as_of_virtual_time_ms": int(row["as_of_virtual_time_ms"]),
        "last_update_id": int(row["last_update_id"]),
        "book_hash": str(row["book_hash"]),
        "execution_fidelity": str(row["execution_fidelity"]),
        "queue_exact": bool(row["queue_exact"]),
        "snapshot_hash": str(row["snapshot_hash"]),
    }


def _fill(row: sqlite3.Row) -> dict[str, object]:
    return {
        "fill_id": str(row["fill_id"]),
        "fill_sequence": int(row["fill_sequence"]),
        "price": str(row["price"]),
        "quantity": str(row["quantity"]),
        "notional": str(row["notional"]),
        "trading_fee": str(row["trading_fee"]),
        "liquidation_fee": str(row["liquidation_fee"]),
        "book_level": None if row["book_level"] is None else int(row["book_level"]),
        "virtual_time_ms": int(row["virtual_time_ms"]),
        "source_sequence": int(row["source_sequence"]),
        "fill_hash": str(row["fill_hash"]),
    }


def _order(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    case_id: str,
    row: sqlite3.Row,
) -> dict[str, object]:
    return {
        "order_id": str(row["order_id"]),
        "liquidation_leg_id": str(row["liquidation_leg_id"]),
        "order_sequence": int(row["order_sequence"]),
        "side": str(row["side"]),
        "order_type": str(row["order_type"]),
        "requested_quantity": str(row["requested_quantity"]),
        "filled_quantity": str(row["filled_quantity"]),
        "remaining_quantity": str(row["remaining_quantity"]),
        "average_price": None
        if row["average_price"] is None
        else str(row["average_price"]),
        "state": str(row["state"]),
        "order_hash": str(row["order_hash"]),
        "fills": [
            _fill(fill_row)
            for fill_row in connection.execute(
                """
                SELECT * FROM replay_training_liquidation_fill
                WHERE run_id = ? AND case_id = ? AND order_id = ?
                ORDER BY fill_sequence
                """,
                (run_id, case_id, row["order_id"]),
            ).fetchall()
        ],
    }


def _insurance_posting(row: sqlite3.Row) -> dict[str, object]:
    return {
        "asset": str(row["asset"]),
        "posting_sequence": int(row["posting_sequence"]),
        "posting_id": str(row["posting_id"]),
        "cash_delta": str(row["cash_delta"]),
        "balance_after": str(row["balance_after"]),
        "reason": str(row["reason"]),
        "posting_hash": str(row["posting_hash"]),
    }


def _adl_event(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    row: sqlite3.Row,
) -> dict[str, object]:
    event_id = str(row["adl_event_id"])
    return {
        "adl_event_id": event_id,
        "snapshot_id": str(row["snapshot_id"]),
        "required_notional": str(row["required_notional"]),
        "completed_notional": str(row["completed_notional"]),
        "state": str(row["state"]),
        "event_hash": str(row["event_hash"]),
        "selections": [
            {
                "selection_sequence": int(selection["selection_sequence"]),
                "candidate_id": str(selection["candidate_id"]),
                "snapshot_id": str(selection["snapshot_id"]),
                "quantity": str(selection["quantity"]),
                "price": str(selection["price"]),
                "notional": str(selection["notional"]),
                "cash_delta": str(selection["cash_delta"]),
                "selection_hash": str(selection["selection_hash"]),
            }
            for selection in connection.execute(
                """
                SELECT * FROM replay_training_adl_selection
                WHERE run_id = ? AND adl_event_id = ?
                ORDER BY selection_sequence
                """,
                (run_id, event_id),
            ).fetchall()
        ],
        "counterparty_ledger": [
            {
                "ledger_sequence": int(entry["ledger_sequence"]),
                "candidate_id": str(entry["candidate_id"]),
                "snapshot_id": str(entry["snapshot_id"]),
                "position_side": str(entry["position_side"]),
                "quantity_before": str(entry["quantity_before"]),
                "quantity_delta": str(entry["quantity_delta"]),
                "quantity_after": str(entry["quantity_after"]),
                "takeover_price": str(entry["takeover_price"]),
                "cash_delta": str(entry["cash_delta"]),
                "entry_hash": str(entry["entry_hash"]),
            }
            for entry in connection.execute(
                """
                SELECT * FROM replay_training_adl_counterparty_ledger
                WHERE run_id = ? AND adl_event_id = ?
                ORDER BY ledger_sequence
                """,
                (run_id, event_id),
            ).fetchall()
        ],
    }


def _leg(row: sqlite3.Row) -> dict[str, object]:
    return {
        "liquidation_leg_id": str(row["liquidation_leg_id"]),
        "leg_sequence": int(row["leg_sequence"]),
        "track_id": str(row["track_id"]),
        "position_side": str(row["position_side"]),
        "trigger_quantity": str(row["trigger_quantity"]),
        "trigger_notional": str(row["trigger_notional"]),
        "maintenance_margin": str(row["maintenance_margin"]),
        "liquidation_price": None
        if row["liquidation_price"] is None
        else str(row["liquidation_price"]),
        "bankruptcy_price": None
        if row["bankruptcy_price"] is None
        else str(row["bankruptcy_price"]),
        "takeover_price": None
        if row["takeover_price"] is None
        else str(row["takeover_price"]),
        "liquidation_fee": str(row["liquidation_fee"]),
        "target_quantity": str(row["target_quantity"]),
        "completed_quantity": str(row["completed_quantity"]),
        "state": str(row["state"]),
        "component_hash": str(row["component_hash"]),
    }


def load_public_liquidation_cases(
    connection: sqlite3.Connection,
    *,
    run_id: str,
) -> list[dict[str, object]]:
    """Return one canonical liquidation shape for portfolio, report and ReviewMode.

    Actual exchange timestamps, archive identifiers and local filesystem fields are
    intentionally absent. All exposed timeline timestamps are replay virtual time.
    """

    cases: list[dict[str, object]] = []
    for case_row in connection.execute(
        """
        SELECT * FROM replay_training_liquidation_case
        WHERE run_id = ? ORDER BY case_sequence
        """,
        (run_id,),
    ).fetchall():
        case_id = str(case_row["case_id"])
        steps: list[dict[str, object]] = []
        for step_row in connection.execute(
            """
            SELECT * FROM replay_training_liquidation_step
            WHERE run_id = ? AND case_id = ? ORDER BY step_sequence
            """,
            (run_id, case_id),
        ).fetchall():
            step_sequence = int(step_row["step_sequence"])
            book_row = connection.execute(
                """
                SELECT * FROM replay_training_liquidation_book_execution
                WHERE run_id = ? AND case_id = ? AND step_sequence = ?
                """,
                (run_id, case_id, step_sequence),
            ).fetchone()
            steps.append(
                {
                    "step_sequence": step_sequence,
                    "step_type": str(step_row["step_type"]),
                    "state": str(step_row["state"]),
                    "before_snapshot_id": str(step_row["before_snapshot_id"]),
                    "after_snapshot_id": (
                        None
                        if step_row["after_snapshot_id"] is None
                        else str(step_row["after_snapshot_id"])
                    ),
                    "reason": _public_step_reason(step_row["reason"]),
                    "step_hash": str(step_row["step_hash"]),
                    "book_execution": None
                    if book_row is None
                    else _book_execution(book_row),
                    "orders": [
                        _order(
                            connection,
                            run_id=run_id,
                            case_id=case_id,
                            row=order_row,
                        )
                        for order_row in connection.execute(
                            """
                            SELECT * FROM replay_training_liquidation_order
                            WHERE run_id = ? AND case_id = ? AND step_sequence = ?
                            ORDER BY order_sequence
                            """,
                            (run_id, case_id, step_sequence),
                        ).fetchall()
                    ],
                    "insurance_postings": [
                        _insurance_posting(posting)
                        for posting in connection.execute(
                            """
                            SELECT * FROM replay_training_insurance_posting
                            WHERE run_id = ? AND case_id = ? AND step_sequence = ?
                            ORDER BY posting_sequence
                            """,
                            (run_id, case_id, step_sequence),
                        ).fetchall()
                    ],
                    "adl_events": [
                        _adl_event(connection, run_id=run_id, row=event)
                        for event in connection.execute(
                            """
                            SELECT * FROM replay_training_adl_event
                            WHERE run_id = ? AND case_id = ? AND step_sequence = ?
                            ORDER BY adl_event_id
                            """,
                            (run_id, case_id, step_sequence),
                        ).fetchall()
                    ],
                }
            )
        cases.append(
            {
                "run_id": run_id,
                "case_id": case_id,
                "case_sequence": int(case_row["case_sequence"]),
                "state": str(case_row["state"]),
                "trigger_snapshot_id": str(case_row["trigger_snapshot_id"]),
                "final_snapshot_id": (
                    None
                    if case_row["final_snapshot_id"] is None
                    else str(case_row["final_snapshot_id"])
                ),
                "trigger_virtual_time_ms": int(case_row["trigger_virtual_time_ms"]),
                "trigger_source_sequence": int(case_row["trigger_source_sequence"]),
                "reason": str(case_row["reason"]),
                "fidelity": str(case_row["fidelity"]),
                "component_hash": str(case_row["component_hash"]),
                "legs": [
                    _leg(row)
                    for row in connection.execute(
                        """
                        SELECT * FROM replay_training_liquidation_leg
                        WHERE run_id = ? AND case_id = ? ORDER BY leg_sequence
                        """,
                        (run_id, case_id),
                    ).fetchall()
                ],
                "book_snapshots": [
                    _book_snapshot(row)
                    for row in connection.execute(
                        """
                        SELECT * FROM replay_training_liquidation_book_snapshot
                        WHERE run_id = ? AND case_id = ? ORDER BY track_id
                        """,
                        (run_id, case_id),
                    ).fetchall()
                ],
                "steps": steps,
            }
        )
    return cases


__all__ = ["load_public_liquidation_cases"]
