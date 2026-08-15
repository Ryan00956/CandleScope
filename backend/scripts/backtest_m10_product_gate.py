"""Run M10 performance workloads strictly through the public HTTP API."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

SCHEMA = "candlescope.backtest-m10-product-gate/1"
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}


class Client:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: dict[str, object] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        headers = {"accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode()
            headers["content-type"] = "application/json"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(
            f"{self.base}{path}", data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {path} failed {exc.code}: {payload}") from exc


def _git(*args: str) -> str:
    return subprocess.check_output(
        ["git", *args], text=True, encoding="utf-8"
    ).strip()


def _preview(
    client: Client,
    *,
    manifest: dict[str, Any],
    start_ms: int,
    end_ms: int,
    fidelity: str,
    market_type: str = "futures",
) -> dict[str, Any]:
    return client.request(
        "/datasets/snapshot",
        method="POST",
        body={
            "dataset_id": manifest["dataset_id"],
            "data_epoch": manifest["data_epoch"],
            "start_time_ms": start_ms,
            "end_time_ms": end_ms,
            "interval": manifest["interval"],
            "fidelity_mode": fidelity,
            "exchange": "binance",
            "market_type": market_type,
        },
    )


def _memory(pid: int | None) -> tuple[int | None, int | None]:
    if pid is None:
        return None, None
    try:
        import psutil

        info = psutil.Process(pid).memory_info()
        return int(info.rss), int(getattr(info, "private", info.rss))
    except (ImportError, OSError):
        return None, None


def _wait_run(
    client: Client, run_id: str, timeout_s: int, monitor_pid: int | None
) -> tuple[dict[str, Any], int, int | None, int | None]:
    started = time.monotonic()
    polls = 0
    peak_rss: int | None = None
    peak_private: int | None = None
    while True:
        record = client.request(f"/runs/{run_id}")
        polls += 1
        rss, private = _memory(monitor_pid)
        if rss is not None:
            peak_rss = max(peak_rss or 0, rss)
        if private is not None:
            peak_private = max(peak_private or 0, private)
        if record["state"] in TERMINAL:
            if record["state"] != "COMPLETED":
                raise RuntimeError(
                    f"run {run_id} ended {record['state']}: {record.get('failure_code')}"
                )
            return record, polls, peak_rss, peak_private
        if time.monotonic() - started > timeout_s:
            raise RuntimeError(f"run {run_id} exceeded {timeout_s}s public-path timeout")
        time.sleep(0.25)


def _run(
    client: Client,
    *,
    scenario: str,
    payload: dict[str, object],
    timeout_s: int,
    monitor_pid: int | None,
) -> dict[str, object]:
    started = time.monotonic()
    created = client.request(
        "/runs",
        method="POST",
        body=payload,
        idempotency_key=f"m10-{scenario}-{time.time_ns()}",
    )
    record, polls, peak_rss, peak_private = _wait_run(
        client, str(created["run_id"]), timeout_s, monitor_pid
    )
    report_started = time.monotonic()
    report = client.request(f"/runs/{created['run_id']}/report")
    report_seconds = time.monotonic() - report_started
    export_started = time.monotonic()
    export = client.request(f"/runs/{created['run_id']}/export")
    export_seconds = time.monotonic() - export_started
    chart_started = time.monotonic()
    chart = client.request(f"/runs/{created['run_id']}/chart")
    chart_seconds = time.monotonic() - chart_started
    report_hash = str(report["hashes"]["report"])
    if report_hash != export["manifest"]["reportHash"]:
        raise RuntimeError("public report/export hash mismatch")
    encoded = json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
    return {
        "scenario": scenario,
        "runId": created["run_id"],
        "durationSeconds": round(time.monotonic() - started, 6),
        "polls": polls,
        "peakRssBytes": peak_rss,
        "peakPrivateBytes": peak_private,
        "reportFetchSeconds": round(report_seconds, 6),
        "exportFetchSeconds": round(export_seconds, 6),
        "chartFetchSeconds": round(chart_seconds, 6),
        "state": record["state"],
        "reportBytes": len(encoded),
        "reportSha256": hashlib.sha256(encoded).hexdigest(),
        "decisionHash": report["hashes"].get("decision"),
        "fillHash": report["hashes"].get("fill"),
        "ledgerHash": report["hashes"].get("ledger"),
        "reportHash": report_hash,
        "fillCount": report["metrics"]["fill_count"],
        "tradeCount": report["metrics"].get("trade_count"),
        "equityPoints": len(report.get("equity_curve") or []),
        "chartBars": len(chart.get("bars") or []),
        "chartFills": len(chart.get("fills") or []),
        "chartTruncated": chart.get("truncated"),
        "sourceEventKind": report.get("source_event_kind"),
        "reportLabel": report.get("report_label"),
    }


def _rsi_payload(
    *,
    manifest: dict[str, Any],
    preview: dict[str, Any],
    start_ms: int,
    end_ms: int,
    fidelity: str,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "strategy_revision_id": "builtin-rsi-wilder-long-short-v1",
        "dataset_id": manifest["dataset_id"],
        "data_epoch": preview["data_epoch"],
        "snapshot_hash": preview["snapshot_hash"],
        "fidelity_mode": fidelity,
        "start_time_ms": start_ms,
        "end_time_ms": end_ms,
        "interval": "1m",
        "warmup_bars": 24,
        "parameters": {
            "length": 24,
            "oversold": 30,
            "overbought": 70,
            "trigger_mode": "LEVEL_TARGET_V1",
        },
        "output_mode": "SIGNAL",
        "initial_balance": "100000",
        "taker_fee_bps": "4",
        "maker_fee_bps": "2",
        "slippage_bps": "1",
        "execution_model_revision": "EXECUTION_REALISM_V2",
        "participation_rate": "0.1",
        "bar_path_scenario": "OHLC_WORST_CASE_STOP_FIRST_V1",
        "order_end_policy": "CANCEL_AT_END",
        "exchange": "binance",
        "market_type": "futures",
    }
    if fidelity == "AGG_TRADE_EXECUTION":
        payload.update(
            {
                "source_event_kind": "AGG_TRADE",
                "signal_clock": "DERIVED_BAR_CLOSE",
                "signal_interval": "1m",
                "execution_clock": "NEXT_AGG_TRADE",
                "bar_builder": "TRADE_DERIVED_COMPLETE_BUCKETS_V1",
                "timezone": "UTC",
            }
        )
    return payload


def _command_payload(
    *,
    manifest: dict[str, Any],
    preview: dict[str, Any],
    start_ms: int,
    end_ms: int,
) -> dict[str, object]:
    return {
        "strategy_revision_id": "builtin-order-command-v1",
        "dataset_id": manifest["dataset_id"],
        "data_epoch": preview["data_epoch"],
        "snapshot_hash": preview["snapshot_hash"],
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": start_ms,
        "end_time_ms": end_ms,
        "interval": "1m",
        "strategy_source": json.dumps(
            {
                "commands": [
                    {"sequence": 2, "action": "OPEN_LONG", "qty": "1"},
                    {"sequence": 9_000, "action": "CLOSE_LONG", "qty": "1"},
                ]
            },
            separators=(",", ":"),
        ),
        "output_mode": "ORDER_INTENT",
        "initial_balance": "100000",
        "execution_model_revision": "EXECUTION_REALISM_V2",
        "participation_rate": "0.1",
        "bar_path_scenario": "OHLC_WORST_CASE_STOP_FIRST_V1",
        "order_end_policy": "CANCEL_AT_END",
        "taker_fee_bps": "4",
        "slippage_bps": "1",
    }


def _concurrent4(
    client: Client,
    *,
    manifest: dict[str, Any],
    start_ms: int,
    timeout_s: int,
    monitor_pid: int | None,
) -> dict[str, object]:
    end_ms = start_ms + 10_000 * 60_000 - 1
    preview = _preview(
        client,
        manifest=manifest,
        start_ms=start_ms,
        end_ms=end_ms,
        fidelity="BAR_APPROX",
    )
    payload = _command_payload(
        manifest=manifest,
        preview=preview,
        start_ms=start_ms,
        end_ms=end_ms,
    )
    started = time.monotonic()
    nonce = time.time_ns()
    with ThreadPoolExecutor(max_workers=4) as pool:
        runs = list(
            pool.map(
                lambda index: client.request(
                    "/runs",
                    method="POST",
                    body=payload,
                    idempotency_key=f"m10-concurrent4-{nonce}-{index}",
                ),
                range(4),
            )
        )
    pending = {str(item["run_id"]) for item in runs}
    max_active = 0
    peak_rss: int | None = None
    peak_private: int | None = None
    final: dict[str, dict[str, Any]] = {}
    while pending:
        active = 0
        for run_id in tuple(pending):
            record = client.request(f"/runs/{run_id}")
            if record["state"] in {"PREPARING", "RUNNING", "COMPLETING"}:
                active += 1
            if record["state"] in TERMINAL:
                if record["state"] != "COMPLETED":
                    raise RuntimeError(
                        f"concurrent run {run_id} failed: {record.get('failure_code')}"
                    )
                pending.remove(run_id)
                final[run_id] = record
        max_active = max(max_active, active)
        rss, private = _memory(monitor_pid)
        if rss is not None:
            peak_rss = max(peak_rss or 0, rss)
        if private is not None:
            peak_private = max(peak_private or 0, private)
        if time.monotonic() - started > timeout_s:
            raise RuntimeError("4 concurrent public Runs exceeded timeout")
        if pending:
            time.sleep(0.25)
    hashes = []
    for run_id in sorted(final):
        report = client.request(f"/runs/{run_id}/report")
        hashes.append(
            {
                "runId": run_id,
                "decisionHash": report["hashes"]["decision"],
                "fillHash": report["hashes"]["fill"],
                "ledgerHash": report["hashes"]["ledger"],
                "reportHash": report["hashes"]["report"],
            }
        )
    if max_active != 4:
        raise RuntimeError(f"public path never observed 4 active Runs (max={max_active})")
    return {
        "scenario": "concurrent4",
        "durationSeconds": round(time.monotonic() - started, 6),
        "runCount": 4,
        "maxSimultaneousActive": max_active,
        "peakRssBytes": peak_rss,
        "peakPrivateBytes": peak_private,
        "runs": hashes,
    }


def _study64(
    client: Client,
    *,
    manifest: dict[str, Any],
    start_ms: int,
    bar_duration_ms: int,
    timeout_s: int,
    monitor_pid: int | None,
) -> dict[str, object]:
    end_ms = start_ms + 800 * bar_duration_ms
    preview = _preview(
        client,
        manifest=manifest,
        start_ms=start_ms,
        end_ms=end_ms - 1,
        fidelity="BAR_APPROX",
    )
    payload = {
        "name": "M10 public 64-run Study V2",
        "hypothesis": "RSI length remains deterministic across two OOS folds",
        "study_protocol_revision": "BACKTEST_WALK_FORWARD_V2",
        "selection_protocol_revision": "TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2",
        "strategy_revision_id": "builtin-rsi-wilder-long-short-v1",
        "dataset_id": manifest["dataset_id"],
        "data_epoch": manifest["data_epoch"],
        "dataset_snapshot_hash": preview["snapshot_hash"],
        "interval": manifest["interval"],
        "start_ms": start_ms,
        "end_ms": end_ms,
        "train_ms": 300 * bar_duration_ms,
        "test_ms": 100 * bar_duration_ms,
        "step_ms": 400 * bar_duration_ms,
        "purge_ms": 0,
        "embargo_ms": 0,
        "holdout_ms": 0,
        "parameter_space": {
            "length": list(range(2, 33)),
            "oversold": [30],
            "overbought": [70],
        },
        "parameters": {"trigger_mode": "LEVEL_TARGET_V1"},
        "sampler": "grid",
        "seed": 10,
        "candidate_budget": 31,
        "total_run_budget": 64,
        "objective": "NET_RETURN",
        "constraints": {
            "min_closed_trades": 1,
            "max_drawdown": "1",
            "min_data_coverage": "1",
            "max_ambiguity_ratio": "0",
            "max_rejected_ratio": "0",
            "cost_plus_25_must_be_positive": False,
        },
        "warmup_bars": 33,
    }
    started = time.monotonic()
    created = client.request("/studies", method="POST", body=payload)
    study_id = str(created["study_id"])
    client.request(f"/studies/{study_id}/start", method="POST")
    peak_rss: int | None = None
    peak_private: int | None = None
    while True:
        study = client.request(f"/studies/{study_id}")
        rss, private = _memory(monitor_pid)
        if rss is not None:
            peak_rss = max(peak_rss or 0, rss)
        if private is not None:
            peak_private = max(peak_private or 0, private)
        if study["state"] in {"COMPLETED", "FAILED", "CANCELLED"}:
            break
        if time.monotonic() - started > timeout_s:
            raise RuntimeError("64-run Study V2 exceeded public-path timeout")
        time.sleep(0.25)
    if study["state"] != "COMPLETED":
        raise RuntimeError(f"Study V2 ended {study['state']}")
    folds = study.get("folds") or []
    train_trials = sum(len(fold.get("train_trials") or []) for fold in folds)
    test_runs = sum(1 for fold in folds if fold.get("test_run_id"))
    if train_trials + test_runs != 64:
        raise RuntimeError(
            f"Study V2 did not execute exact 64-run budget ({train_trials}+{test_runs})"
        )
    comparison = client.request(f"/studies/{study_id}/compare")
    oos_report_hash = ((study.get("oos_report") or {}).get("hashes") or {}).get(
        "report"
    )
    if not isinstance(oos_report_hash, str) or not oos_report_hash.startswith(
        "sha256:"
    ):
        raise RuntimeError("Study V2 completed without an authoritative OOS report hash")
    return {
        "scenario": "study64",
        "studyId": study_id,
        "durationSeconds": round(time.monotonic() - started, 6),
        "peakRssBytes": peak_rss,
        "peakPrivateBytes": peak_private,
        "foldCount": len(folds),
        "trainTrialCount": train_trials,
        "testRunCount": test_runs,
        "totalRunCount": train_trials + test_runs,
        "oosReportHash": oos_report_hash,
        "comparisonHash": hashlib.sha256(
            json.dumps(comparison, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
    }


def _assert_thresholds(
    result: dict[str, object], thresholds: dict[str, Any]
) -> dict[str, object]:
    scenario = str(result["scenario"])
    frozen = thresholds.get("scenarios", {}).get(scenario)
    if not isinstance(frozen, dict):
        raise RuntimeError(f"no frozen threshold exists for {scenario}")
    checks = {
        "maxDurationSeconds": ("durationSeconds", "max"),
        "maxPeakRssBytes": ("peakRssBytes", "max"),
        "minReportBytes": ("reportBytes", "min"),
        "maxReportBytes": ("reportBytes", "max"),
        "maxChartFetchSeconds": ("chartFetchSeconds", "max"),
        "exactInputRows": ("inputRows", "exact"),
        "minFillCount": ("fillCount", "min"),
        "exactFillCount": ("fillCount", "exact"),
        "exactMaxSimultaneousActive": ("maxSimultaneousActive", "exact"),
        "exactRunCount": ("runCount", "exact"),
        "exactTotalRunCount": ("totalRunCount", "exact"),
    }
    evidence: list[dict[str, object]] = []
    for threshold_name, expected in frozen.items():
        mapping = checks.get(threshold_name)
        if mapping is None:
            raise RuntimeError(f"unknown frozen threshold {threshold_name}")
        field, operator = mapping
        actual = result.get(field)
        if actual is None:
            raise RuntimeError(f"{scenario} did not record required metric {field}")
        passed = (
            float(actual) <= float(expected)
            if operator == "max"
            else float(actual) >= float(expected)
            if operator == "min"
            else float(actual) == float(expected)
        )
        evidence.append(
            {
                "metric": field,
                "operator": operator,
                "actual": actual,
                "threshold": expected,
                "passed": passed,
            }
        )
        if not passed:
            raise RuntimeError(
                f"{scenario} failed frozen {threshold_name}: {actual} vs {expected}"
            )
    result["thresholdChecks"] = evidence
    result["thresholdStatus"] = "PASS"
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:18082/api/v1/backtests")
    parser.add_argument("--bar-receipt", required=True, type=Path)
    parser.add_argument("--real-receipt", required=True, type=Path)
    parser.add_argument("--thresholds", required=True, type=Path)
    parser.add_argument("--scenarios", default="bar200k,agg1m,agg2m,partial")
    parser.add_argument("--timeout-seconds", type=int, default=14_400)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--server-pid", type=int)
    parser.add_argument("--partial-fills", type=int, default=18_000)
    args = parser.parse_args()
    client = Client(args.base_url)
    capabilities = client.request("/capabilities")
    bar_receipt = json.loads(args.bar_receipt.read_text(encoding="utf-8"))
    real_receipt = json.loads(args.real_receipt.read_text(encoding="utf-8"))
    thresholds = json.loads(args.thresholds.read_text(encoding="utf-8"))
    if thresholds.get("schemaVersion") != "candlescope.backtest-m10-thresholds/1":
        raise RuntimeError("unknown M10 threshold schema")
    manifest = bar_receipt["manifest"]
    scenarios = [item.strip() for item in args.scenarios.split(",") if item.strip()]
    results: list[dict[str, object]] = []
    start_ms = int(bar_receipt["startTimeMs"])
    bar_end = int(bar_receipt["endTimeMs"]) - 1

    for scenario in scenarios:
        if scenario == "concurrent4":
            result = _concurrent4(
                client,
                manifest=manifest,
                start_ms=start_ms,
                timeout_s=args.timeout_seconds,
                monitor_pid=args.server_pid,
            )
            result = _assert_thresholds(result, thresholds)
            results.append(result)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
            continue
        if scenario == "study64":
            study_fixture = bar_receipt.get("study")
            if not isinstance(study_fixture, dict):
                raise RuntimeError(
                    "bar receipt does not contain the contract-complete Study V2 fixture"
                )
            result = _study64(
                client,
                manifest=study_fixture["manifest"],
                start_ms=int(study_fixture["startTimeMs"]),
                bar_duration_ms=int(study_fixture["barDurationMs"]),
                timeout_s=args.timeout_seconds,
                monitor_pid=args.server_pid,
            )
            result = _assert_thresholds(result, thresholds)
            results.append(result)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
            continue
        if scenario == "bar200k":
            preview = _preview(
                client,
                manifest=manifest,
                start_ms=start_ms,
                end_ms=bar_end,
                fidelity="BAR_APPROX",
            )
            if int(preview["row_count"]) != 200_000:
                raise RuntimeError("BAR public preview is not exactly 200k rows")
            payload = _rsi_payload(
                manifest=manifest,
                preview=preview,
                start_ms=start_ms,
                end_ms=bar_end,
                fidelity="BAR_APPROX",
            )
            payload.update(
                {
                    "strategy_revision_id": "builtin-order-command-v1",
                    "strategy_source": json.dumps(
                        {
                            "commands": [
                                {"sequence": 2, "action": "OPEN_LONG", "qty": "1"},
                                {
                                    "sequence": 199_000,
                                    "action": "CLOSE_LONG",
                                    "qty": "1",
                                },
                            ]
                        },
                        separators=(",", ":"),
                    ),
                    "output_mode": "ORDER_INTENT",
                    "parameters": {},
                    "warmup_bars": 0,
                }
            )
        elif scenario in {"agg1m", "agg2m"}:
            target = 1_000_000 if scenario == "agg1m" else 2_000_000
            workload = next(
                item for item in real_receipt["workloads"] if item["targetRows"] == target
            )
            dataset = workload["dataset"]
            preview = _preview(
                client,
                manifest=manifest,
                start_ms=int(dataset["start_time_ms"]),
                end_ms=int(dataset["end_time_ms"]),
                fidelity="AGG_TRADE_EXECUTION",
            )
            if int(preview["row_count"]) != int(workload["actualRows"]):
                raise RuntimeError("aggTrade public preview row count drifted")
            payload = _rsi_payload(
                manifest=manifest,
                preview=preview,
                start_ms=int(dataset["start_time_ms"]),
                end_ms=int(dataset["end_time_ms"]),
                fidelity="AGG_TRADE_EXECUTION",
            )
        elif scenario == "partial":
            if args.partial_fills < 10_000 or args.partial_fills > 30_000:
                raise RuntimeError("partial-fill workload must stay within 10k..30k")
            end_ms = start_ms + (args.partial_fills + 5_000) * 60_000 - 1
            preview = _preview(
                client,
                manifest=manifest,
                start_ms=start_ms,
                end_ms=end_ms,
                fidelity="BAR_APPROX",
            )
            payload = {
                "strategy_revision_id": "builtin-order-command-v1",
                "dataset_id": manifest["dataset_id"],
                "data_epoch": preview["data_epoch"],
                "snapshot_hash": preview["snapshot_hash"],
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": start_ms,
                "end_time_ms": end_ms,
                "interval": "1m",
                "strategy_source": json.dumps(
                    {
                        "commands": [
                            {
                                "sequence": 1,
                                "action": "OPEN_LONG",
                                "qty": str(args.partial_fills),
                            }
                        ]
                    },
                    separators=(",", ":"),
                ),
                "output_mode": "ORDER_INTENT",
                "initial_balance": "10000000",
                "execution_model_revision": "EXECUTION_REALISM_V2",
                "participation_rate": "0.01",
                "bar_path_scenario": "OHLC_WORST_CASE_STOP_FIRST_V1",
                "order_end_policy": "CANCEL_AT_END",
                "taker_fee_bps": "4",
                "slippage_bps": "1",
            }
        else:
            raise RuntimeError(f"unknown scenario {scenario}")
        result = _run(
            client,
            scenario=scenario,
            payload=payload,
            timeout_s=args.timeout_seconds,
            monitor_pid=args.server_pid,
        )
        if scenario.startswith("agg") and int(result["fillCount"]) < 1:
            raise RuntimeError(f"{scenario} did not create an actual position")
        if scenario == "partial" and int(result["fillCount"]) != args.partial_fills:
            raise RuntimeError("partial-fill workload did not produce the exact target")
        if scenario == "bar200k":
            result["inputRows"] = int(preview["row_count"])
        elif scenario.startswith("agg"):
            result["inputRows"] = int(preview["row_count"])
        result = _assert_thresholds(result, thresholds)
        results.append(result)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)

    receipt = {
        "schemaVersion": SCHEMA,
        "gitSha": _git("rev-parse", "HEAD"),
        "gitDirty": bool(_git("status", "--porcelain")),
        "branch": _git("branch", "--show-current"),
        "baseUrl": args.base_url,
        "effectiveFlags": capabilities.get("flags"),
        "barDataEpoch": manifest["data_epoch"],
        "realDataReceiptSha256": hashlib.sha256(args.real_receipt.read_bytes()).hexdigest(),
        "thresholdsSha256": hashlib.sha256(args.thresholds.read_bytes()).hexdigest(),
        "results": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


def _write_failure_receipt(exc: BaseException) -> None:
    try:
        output_index = sys.argv.index("--output") + 1
        output = Path(sys.argv[output_index])
    except (ValueError, IndexError):
        return
    receipt = {
        "schemaVersion": SCHEMA,
        "status": "FAILED",
        "gitSha": _git("rev-parse", "HEAD"),
        "gitDirty": bool(_git("status", "--porcelain")),
        "branch": _git("branch", "--show-current"),
        "command": [sys.executable, *sys.argv],
        "exitCode": 1,
        "errorType": type(exc).__name__,
        "error": str(exc),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        _write_failure_receipt(error)
        raise
