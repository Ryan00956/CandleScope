"""Credibility-aware BAR report builder. Never hides approximate labels."""

from __future__ import annotations

import copy
import json
from decimal import Decimal
from typing import Any, Mapping

from app.backtest.identity import sha256_hex

REPORT_SCHEMA = "candlescope.backtest-report/1"

UNMODELED = (
    "intrabar path",
    "queue position",
    "liquidation",
    "funding",
    "volume participation",
)
TRADE_UNMODELED = (
    "queue position",
    "book depth",
    "hidden liquidity",
    "liquidation",
    "funding",
)
LABELS = {
    "BAR_APPROX": "APPROXIMATE",
    "TRADE_TAPE": "TRADE_SEQUENCE",
    "AGG_TRADE_TAPE": "AGGREGATED_TRADE_SEQUENCE",
    "AGG_TRADE_EXECUTION": "AGGREGATED_TRADE_SEQUENCE",
    "BOOK_ASSISTED": "BOOK_ASSISTED",
    "QUEUE_EXACT": "ORDER_LEVEL_REQUIRED",
}


def build_report(
    run: Mapping[str, Any], result: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    fidelity = str(run.get("fidelity_mode") or "BAR_APPROX")
    source_kind = str(run.get("source_event_kind") or "BAR")
    payload = result or run.get("result") or {}
    fills = list(payload.get("fills") or [])
    trades = build_round_trip_trades(fills)
    winning = sum(Decimal(str(item["net_pnl"])) > 0 for item in trades)
    net_pnl = sum((Decimal(str(item["net_pnl"])) for item in trades), Decimal("0"))
    label = LABELS.get(fidelity) or str(payload.get("report_label") or "")
    try:
        config = json.loads(str(run.get("config_json") or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        config = {}
    account_model = str(
        run.get("account_model")
        or config.get("account_model")
        or "LINEAR_PERP_ONE_WAY_V1"
    )
    report = {
        "schemaVersion": REPORT_SCHEMA,
        "runId": run.get("run_id"),
        "state": run.get("state"),
        "fidelity_mode": fidelity,
        "source_event_kind": source_kind,
        "report_label": label,
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
            "report": None,
        },
        "metrics": {
            "fill_count": len(fills),
            "ambiguity_count": int(payload.get("ambiguity_count") or 0),
            "rejected_order_count": len(payload.get("rejected") or []),
            "trade_count": len(trades),
            "winning_trade_count": winning,
            "win_rate": (
                "0" if not trades else str(Decimal(winning) / Decimal(len(trades)))
            ),
            "realized_net_pnl": str(net_pnl),
        },
        "data_quality": payload.get("data_quality") or {},
        "fill_model": payload.get("fill_model") or {},
        "account": (payload.get("ledger") or {}).get("account") or {},
        "ledger": payload.get("ledger") or {},
        "equity_curve": list(payload.get("equity_curve") or []),
        "orders": list(payload.get("orders") or []),
        "rejected_orders": list(payload.get("rejected") or []),
        "unmodeled": list(UNMODELED if fidelity == "BAR_APPROX" else TRADE_UNMODELED),
        "suitable_for": (
            ["bar-close strategy comparison", "parameter smoke tests"]
            if fidelity == "BAR_APPROX"
            else (
                ["completed-bar signals", "aggregate-trade next-print execution"]
                if fidelity == "AGG_TRADE_EXECUTION"
                else ["print-sequence execution", "next-print market fills"]
            )
        ),
        "not_suitable_for": [
            "claiming unique intrabar order",
            "queue-exact fills",
            "perfect market replay",
            "live trading approval",
        ],
        "fills": fills,
        "trades": trades,
        "contract_coverage": payload.get("contract_coverage") or {},
    }
    if account_model == "LINEAR_PERP_ONE_WAY_V2":
        report["identity"]["account_model"] = account_model
        report["unmodeled"] = [
            item
            for item in report["unmodeled"]
            if item not in {"liquidation", "funding"}
        ] + ["insurance fund", "auto-deleveraging"]
        report["account_model"] = "LINEAR_PERP_ONE_WAY_V2"
        report["funding_mode"] = config.get("funding_mode", "OFF")
        report["liquidation_model"] = "MARK_IMMEDIATE_NO_LIQUIDATION_FEE_V1"
    if config.get("host_policy_revision"):
        report["identity"].update(
            {
                "host_policy_revision": config.get("host_policy_revision"),
                "sizing_policy": config.get("sizing_policy"),
                "risk_policy": config.get("risk_policy"),
            }
        )
        report["risk_policy"] = copy.deepcopy(payload.get("risk_policy") or {})
        report["metrics"]["risk_rejection_count"] = sum(
            item.get("reason") == "ORDER_REJECTED_RISK"
            for item in payload.get("rejected") or []
        )
    if config.get("execution_model_revision"):
        report["order_events"] = list(
            (payload.get("ledger") or {}).get("order_events") or []
        )
        report["cost_sensitivity"] = copy.deepcopy(
            payload.get("cost_sensitivity") or {}
        )
        report["identity"].update(
            {
                "execution_model_revision": config.get("execution_model_revision"),
                "fill_policy": config.get("fill_policy"),
                "bar_path_scenario": config.get("bar_path_scenario"),
                "order_end_policy": config.get("order_end_policy"),
            }
        )
        report["execution_assumptions"] = {
            "participation_rate": config.get("participation_rate"),
            "latency_ms": int(config.get("latency_ms") or 0),
            "latency_events": int(config.get("latency_events") or 0),
            "bar_path_scenario": config.get("bar_path_scenario"),
            "ohlc_path_is_historical_fact": False,
            "agg_trade_is_raw_trade": False,
            "queue_exact": False,
        }
        if fidelity == "BAR_APPROX":
            report["unmodeled"] = [
                item for item in report["unmodeled"] if item != "volume participation"
            ]
        traced = sum(bool(item.get("source_event_hash")) for item in fills)
        report["fill_trace"] = {
            "fill_count": len(fills),
            "authoritative_event_trace_count": traced,
            "complete": traced == len(fills),
        }
    strategy_metadata = payload.get("strategy_metadata")
    if fidelity == "AGG_TRADE_EXECUTION":
        report["identity"].update(
            {
                "signal_clock": config.get("signal_clock"),
                "signal_interval": config.get("signal_interval"),
                "execution_clock": config.get("execution_clock"),
                "bar_builder": config.get("bar_builder"),
                "timezone": config.get("timezone"),
            }
        )
        report["metrics"].update(
            {
                "signal_event_count": int(payload.get("signal_event_count") or 0),
                "execution_event_count": int(payload.get("execution_event_count") or 0),
            }
        )
    if isinstance(strategy_metadata, Mapping) and strategy_metadata:
        report["strategy"] = copy.deepcopy(dict(strategy_metadata))
    return seal_report(report)


def seal_report(report: Mapping[str, Any]) -> dict[str, Any]:
    sealed = copy.deepcopy(dict(report))
    hashes = dict(sealed.get("hashes") or {})
    hashes["report"] = None
    sealed["hashes"] = hashes
    hash_payload = copy.deepcopy(sealed)
    # A report hash is a reproducibility hash: rerunning the same immutable
    # inputs must produce it even though the control-plane run id is different.
    # The export manifest binds the concrete run id to this stable result hash.
    hash_payload.pop("runId", None)
    hashes["report"] = "sha256:" + sha256_hex(hash_payload)
    return sealed


def verify_report_hash(report: Mapping[str, Any]) -> bool:
    expected = str((report.get("hashes") or {}).get("report") or "")
    return bool(expected) and seal_report(report)["hashes"]["report"] == expected


def export_bundle(
    run: Mapping[str, Any], result: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    if result is not None and result.get("schemaVersion") == REPORT_SCHEMA:
        report = copy.deepcopy(dict(result))
        if not verify_report_hash(report):
            raise ValueError("stored backtest report hash is invalid")
    else:
        report = build_report(run, result)
    if report.get("runId") != run.get("run_id"):
        raise ValueError("backtest report is not bound to the requested run")
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
    traced = any(fill.get("source_event_hash") for fill in fills)
    if not traced:
        lines = [
            "order_id,sequence,event_time_ms,side,action,position_before,"
            "position_after,price,qty,fee,reason"
        ]
        for fill in fills:
            lines.append(
                ",".join(
                    [
                        str(fill.get("order_id") or ""),
                        str(fill.get("sequence") or ""),
                        str(fill.get("event_time_ms") or ""),
                        str(fill.get("side") or ""),
                        str(fill.get("action") or ""),
                        str(fill.get("position_before") or "0"),
                        str(fill.get("position_after") or "0"),
                        str(fill.get("price") or ""),
                        str(fill.get("qty") or ""),
                        str(fill.get("fee") or "0"),
                        str(fill.get("reason") or ""),
                    ]
                )
            )
        return "\n".join(lines) + "\n"
    lines = [
        "order_id,sequence,event_time_ms,side,action,position_before,"
        "position_after,price,qty,fee,reason,source_event_kind,source_sequence,"
        "source_event_time_ms,source_event_hash"
    ]
    for fill in fills:
        lines.append(
            ",".join(
                [
                    str(fill.get("order_id") or ""),
                    str(fill.get("sequence") or ""),
                    str(fill.get("event_time_ms") or ""),
                    str(fill.get("side") or ""),
                    str(fill.get("action") or ""),
                    str(fill.get("position_before") or "0"),
                    str(fill.get("position_after") or "0"),
                    str(fill.get("price") or ""),
                    str(fill.get("qty") or ""),
                    str(fill.get("fee") or "0"),
                    str(fill.get("reason") or ""),
                    str(fill.get("source_event_kind") or ""),
                    str(fill.get("source_sequence") or ""),
                    str(fill.get("source_event_time_ms") or ""),
                    str(fill.get("source_event_hash") or ""),
                ]
            )
        )
    return "\n".join(lines) + "\n"


def build_round_trip_trades(fills: list[Mapping[str, Any]]) -> list[dict[str, str]]:
    """FIFO-close fills into auditable round trips without inventing executions."""

    lots: list[dict[str, Any]] = []
    trades: list[dict[str, str]] = []
    ordered = sorted(
        fills,
        key=lambda item: (
            int(item.get("sequence") or 0),
            str(item.get("order_id") or ""),
        ),
    )
    for fill in ordered:
        side = str(fill.get("side") or "").upper()
        if side not in {"BUY", "SELL"}:
            continue
        sign = Decimal("1") if side == "BUY" else Decimal("-1")
        qty = Decimal(str(fill.get("qty") or "0"))
        price = Decimal(str(fill.get("price") or "0"))
        fee = abs(Decimal(str(fill.get("fee") or "0")))
        if qty <= 0 or price <= 0:
            continue
        original_qty = qty
        while qty > 0 and lots and Decimal(str(lots[0]["sign"])) != sign:
            lot = lots[0]
            lot_qty = Decimal(str(lot["qty"]))
            closed = min(qty, lot_qty)
            entry_fee = Decimal(str(lot["fee"])) * closed / lot_qty
            exit_fee = fee * closed / original_qty
            gross = (
                (price - Decimal(str(lot["price"])))
                * closed
                * Decimal(str(lot["sign"]))
            )
            total_fee = entry_fee + exit_fee
            trades.append(
                {
                    "trade_id": f"trade-{len(trades) + 1}",
                    "side": "LONG" if Decimal(str(lot["sign"])) > 0 else "SHORT",
                    "qty": str(closed),
                    "entry_order_id": str(lot["order_id"]),
                    "exit_order_id": str(fill.get("order_id") or ""),
                    "entry_sequence": str(lot["sequence"]),
                    "exit_sequence": str(fill.get("sequence") or "0"),
                    "entry_time_ms": str(lot["event_time_ms"]),
                    "exit_time_ms": str(fill.get("event_time_ms") or "0"),
                    "entry_price": str(lot["price"]),
                    "exit_price": str(price),
                    "gross_pnl": str(gross),
                    "fees": str(total_fee),
                    "net_pnl": str(gross - total_fee),
                    "duration_ms": str(
                        max(
                            0,
                            int(fill.get("event_time_ms") or 0)
                            - int(lot["event_time_ms"]),
                        )
                    ),
                }
            )
            qty -= closed
            lot["qty"] = lot_qty - closed
            lot["fee"] = Decimal(str(lot["fee"])) - entry_fee
            if Decimal(str(lot["qty"])) == 0:
                lots.pop(0)
        if qty > 0:
            residual_fee = fee * qty / original_qty
            lots.append(
                {
                    "sign": sign,
                    "qty": qty,
                    "price": price,
                    "fee": residual_fee,
                    "order_id": str(fill.get("order_id") or ""),
                    "sequence": int(fill.get("sequence") or 0),
                    "event_time_ms": int(fill.get("event_time_ms") or 0),
                }
            )
    return trades
