import type { ReplayReportResponse } from "./replayParser.js";
import type { ReplayCommandTimelineEntry, ReplayJournalEntry, ReplaySessionConfig } from "./replayTypes.js";

export interface ReplayReportExportInput {
  readonly sessionId: string;
  readonly config: ReplaySessionConfig;
  readonly response: ReplayReportResponse;
  readonly commandTimeline: readonly ReplayCommandTimelineEntry[];
  readonly journal: readonly ReplayJournalEntry[];
}

export function buildReplayReportExport(input: ReplayReportExportInput): Readonly<Record<string, unknown>> {
  return {
    schema_version: "candlescope-replay-training-report.v1",
    protocol: "replay.v1",
    session_id: input.sessionId,
    config: input.config,
    fidelity: {
      data: input.response.data_fidelity,
      execution: input.response.execution_fidelity,
    },
    revealed: input.response.revealed,
    ...(input.response.revealed && input.response.actual_history
      ? { actual_history: input.response.actual_history }
      : {}),
    report: input.response.report,
    warnings: input.response.report.warnings,
    command_timeline: input.commandTimeline,
    journal: input.journal,
    integrity: {
      state_hash: input.response.report.state_hash,
      ledger_tail_hash: input.response.report.ledger_tail_hash,
      report_hash: input.response.report.report_hash,
      config_hash: input.response.report.config_hash,
    },
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function replayReportToCsv(input: ReplayReportExportInput): string {
  const report = input.response.report;
  const rows: unknown[][] = [
    ["section", "key", "value", "detail"],
    ["session", "session_id", input.sessionId, ""],
    ["fidelity", "data", input.response.data_fidelity, ""],
    ["fidelity", "execution", input.response.execution_fidelity, ""],
    ["integrity", "report_hash", report.report_hash, ""],
    ["integrity", "state_hash", report.state_hash, ""],
    ["summary", "initial_equity", report.initial_equity, ""],
    ["summary", "final_equity", report.final_equity, ""],
    ["summary", "realized_pnl", report.realized_pnl, ""],
    ["summary", "fees_paid", report.fees_paid, ""],
    ["summary", "max_drawdown", report.max_drawdown, ""],
    ["summary", "trade_count", report.trade_count, ""],
    ["summary", "win_rate", report.win_rate, ""],
    ["summary", "profit_factor", report.profit_factor, ""],
    ["summary", "ambiguous_bar_count", report.ambiguous_bar_count, ""],
    ...report.warnings.map((warning) => ["warning", warning.code, warning.message, warning.order_ids.join("|")]),
    ...report.orders.map((order) => ["order", order.order_id, order.status, order]),
    ...report.fills.map((fill) => ["fill", fill.fill_id, fill.reason, fill]),
    ...report.closed_trades.map((trade) => ["closed_trade", trade.trade_id, trade.realized_pnl, trade]),
    ...input.commandTimeline.map((command) => ["command", command.command_id, command.status, command]),
    ...input.journal.map((entry) => ["journal", entry.entry_id, entry.text, entry.virtual_time_ms]),
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function downloadReplayReport(
  input: ReplayReportExportInput,
  format: "json" | "csv",
): void {
  const content = format === "json"
    ? `${JSON.stringify(buildReplayReportExport(input), null, 2)}\n`
    : replayReportToCsv(input);
  const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `candlescope-replay-${input.sessionId}.${format}`;
  link.rel = "noopener";
  link.click();
  URL.revokeObjectURL(url);
}
