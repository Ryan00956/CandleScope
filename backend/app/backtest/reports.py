"""Credibility-aware BAR report builder. Never hides approximate labels."""

from __future__ import annotations

from typing import Any, Mapping

REPORT_SCHEMA = "candlescope.backtest-report/1"

UNMODELED = (
    "intrabar path",
    "queue position",
    "liquidation",
    "funding",
    "volume participation",
)


def build_report(run: Mapping[str, Any], result: Mapping[str, Any] | None = None) -> dict[str, Any]:
    fidelity = str(run.get("fidelity_mode") or "BAR_APPROX")
    source_kind = str(run.get("source_event_kind") or "BAR")
    payload = result or run.get("result") or {}
    fills = list(payload.get("fills") or [])
    return {
        "schemaVersion": REPORT_SCHEMA,
        "runId": run.get("run_id"),
        "state": run.get("state"),
        "fidelity_mode": fidelity,
        "source_event_kind": source_kind,
        "report_label": "APPROXIMATE" if fidelity == "BAR_APPROX" else str(payload.get("report_label") or ""),
        "identity": {
            "strategy_revision_id": run.get("strategy_revision_id"),
            "dataset_id": run.get("dataset_id"),
            "data_epoch": run.get("data_epoch"),
            "snapshot_hash": run.get("snapshot_hash"),
            "config_hash": run.get("config_hash"),
            "engine_version": run.get("engine_version"),
        },
        "hashes": {
            "decision": payload.get("decision_hash"),
            "fill": payload.get("fill_hash"),
            "ledger": payload.get("ledger_hash"),
            "report": payload.get("report_hash"),
        },
        "metrics": {
            "fill_count": len(fills),
            "ambiguity_count": int(payload.get("ambiguity_count") or 0),
        },
        "unmodeled": list(UNMODELED) if fidelity == "BAR_APPROX" else [],
        "suitable_for": ["bar-close strategy comparison", "parameter smoke tests"],
        "not_suitable_for": [
            "claiming unique intrabar order",
            "queue-exact fills",
            "live trading approval",
        ],
        "fills": fills,
    }


def export_bundle(run: Mapping[str, Any], result: Mapping[str, Any] | None = None) -> dict[str, Any]:
    report = build_report(run, result)
    return {
        "manifest": {
            "schemaVersion": "candlescope.backtest-export/1",
            "runId": report["runId"],
            "reportSchema": REPORT_SCHEMA,
            "reportHash": report["hashes"]["report"],
            "reportLabel": report["report_label"],
        },
        "report": report,
        "csv": _fills_csv(report["fills"]),
    }


def _fills_csv(fills: list[Mapping[str, Any]]) -> str:
    lines = ["order_id,sequence,price,qty,reason"]
    for fill in fills:
        lines.append(
            ",".join(
                [
                    str(fill.get("order_id") or ""),
                    str(fill.get("sequence") or ""),
                    str(fill.get("price") or ""),
                    str(fill.get("qty") or ""),
                    str(fill.get("reason") or ""),
                ]
            )
        )
    return "\n".join(lines) + "\n"
