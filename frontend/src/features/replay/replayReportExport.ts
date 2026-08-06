import type { ReplayTrainingReportResponse } from "./replayIntegrityModel.js";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildReplayTrainingReportExport(
  response: ReplayTrainingReportResponse,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: "candlescope-replay-training-report.v2",
    protocol: "replay.v3",
    run_id: response.run_id,
    fidelity: {
      data: response.data_fidelity,
      execution: response.execution_fidelity,
    },
    revealed: response.revealed,
    ...(response.revealed && response.actual_history
      ? { actual_history: response.actual_history }
      : {}),
    report: response.report,
    warnings: response.report.warnings,
    integrity: response.integrity,
    public_time_index: response.public_time_index,
    modelled_account: response.modelled_account,
    account_audit: response.account_audit,
    liquidation_channel_contract: response.liquidation_channel_contract,
  };
}

export function replayTrainingReportToCsv(response: ReplayTrainingReportResponse): string {
  const { report, integrity } = response;
  const publicLabels = new Map(response.public_time_index.items.map((item) => [
    item.input_timeline_ms,
    item.public_time.label,
  ]));
  const withPublicTime = <T extends object>(value: T) => {
    const record = value as Record<string, unknown>;
    const time = Object.entries(record).find(([key, item]) => (
      key.endsWith("_time_ms") && typeof item === "number"
    ))?.[1];
    return {
      ...value,
      ...(typeof time === "number" && publicLabels.has(time)
        ? { public_time_label: publicLabels.get(time) }
        : {}),
      };
  };
  const contractAccount = response.modelled_account.schema_version === "replay.training.portfolio.v2"
    ? response.modelled_account
    : null;
  const rows: unknown[][] = [
    ["section", "key", "value", "detail"],
    ["run", "run_id", response.run_id, ""],
    ["fidelity", "data", response.data_fidelity, ""],
    ["fidelity", "execution", response.execution_fidelity, ""],
    ["integrity", "mode", integrity.integrity_mode, integrity.result_label],
    ["integrity", "strict_eligible", integrity.strict_eligible, ""],
    ["integrity", "start_time_known", integrity.start_time_known, ""],
    ["integrity", "active_rule_revision", integrity.active_rule_revision, integrity.active_rule_hash],
    ["integrity", "report_hash", report.report_hash, ""],
    ["integrity", "state_hash", report.state_hash, ""],
    ["integrity", "ledger_tail_hash", report.ledger_tail_hash, ""],
    ["summary", "initial_equity", report.initial_equity, ""],
    ["summary", "final_equity", report.final_equity, ""],
    ["summary", "realized_pnl", report.realized_pnl, ""],
    ["summary", "fees_paid", report.fees_paid, ""],
    ["summary", "max_drawdown", report.max_drawdown, ""],
    ["summary", "trade_count", report.trade_count, ""],
    ["summary", "win_rate", report.win_rate, ""],
    ["summary", "profit_factor", report.profit_factor, ""],
    ["summary", "ambiguous_bar_count", report.ambiguous_bar_count, ""],
    ...(contractAccount === null ? [] : [
      ["modelled_account", "account_data_mode", contractAccount.account_history.mode, contractAccount.account_history.fidelity],
      ["modelled_account", "history_status", contractAccount.account_history.status, contractAccount.account_history.archive_proof_hash],
      ["modelled_account", "auditor_status", contractAccount.account_history.auditor.status, contractAccount.account_history.auditor.proof_hash],
      ["modelled_account", "funding_cashflow", contractAccount.funding_cashflow, contractAccount.fidelity.funding],
      ["modelled_account", "simulated_account_liquidation", contractAccount.liquidations.length, contractAccount.liquidation_channels.simulated_account],
      ["market_data", "historical_market_liquidation", contractAccount.liquidation_channels.historical_market.fidelity, contractAccount.liquidation_channels.historical_market],
      ...contractAccount.account_history.bindings.map((binding) => [
        "account_history_binding",
        binding.track_id,
        binding.archive_id,
        binding,
      ]),
      ...contractAccount.account_history.auditor.differences.map((difference) => [
        "account_audit_difference",
        String(difference.field ?? "unknown"),
        "FAIL",
        difference,
      ]),
    ]),
    ...(response.account_audit === null ? [] : [
      ["account_audit", "status", response.account_audit.status, response.account_audit.proof_hash],
    ]),
    ...report.warnings.map((warning) => ["warning", warning.code, warning.message, warning.order_ids.join("|")]),
    ...report.orders.map((order) => ["order", order.order_id, order.status, withPublicTime(order)]),
    ...report.fills.map((fill) => ["fill", fill.fill_id, fill.reason, withPublicTime(fill)]),
    ...report.closed_trades.map((trade) => ["closed_trade", trade.trade_id, trade.realized_pnl, trade]),
    ...integrity.mutations.map((mutation) => [
      "mutation",
      mutation.event_id,
      mutation.event_type,
      {
        public_time: mutation.public_time,
        rule_revision: mutation.rule_revision,
        old_value: mutation.old_value,
        new_value: mutation.new_value,
        reason: mutation.reason,
        state_hash_before: mutation.state_hash_before,
        state_hash_after: mutation.state_hash_after,
      },
    ]),
    ...(response.revealed && response.actual_history
      ? Object.entries(response.actual_history).map(([key, value]) => ["actual_history", key, value, ""])
      : []),
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function downloadReplayTrainingReport(
  response: ReplayTrainingReportResponse,
  format: "json" | "csv",
): void {
  const content = format === "json"
    ? `${JSON.stringify(buildReplayTrainingReportExport(response), null, 2)}\n`
    : replayTrainingReportToCsv(response);
  const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `candlescope-replay-run-${response.run_id}.${format}`;
  link.rel = "noopener";
  link.click();
  URL.revokeObjectURL(url);
}
