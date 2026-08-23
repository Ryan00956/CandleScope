import type { BacktestApiClient } from "./backtestApi.js";
import { pollBacktestRunToTerminal } from "./backtestRunClient.js";
import { createBacktestStore } from "./backtestStore.js";
import type { BacktestReport, BacktestRunRecord } from "./backtestTypes.js";

export async function runCreateMonitorExport(options: {
  api: BacktestApiClient;
  body: Record<string, unknown>;
  idempotencyKey: string;
  store?: ReturnType<typeof createBacktestStore>;
}): Promise<{
  run: BacktestRunRecord;
  report: BacktestReport;
  exported: Record<string, unknown>;
  cancelled: boolean;
}> {
  const store = options.store ?? createBacktestStore();
  await options.api.validate(options.body);
  const created = await options.api.createRun(options.body, options.idempotencyKey);
  store.applyRuns([created]);
  store.selectRun(created.run_id);
  store.applyStream({ type: "PROGRESS", sequence: 1 });
  const run = await pollBacktestRunToTerminal({
    api: options.api,
    runId: created.run_id,
  });
  store.applyRuns([run]);
  const report = await options.api.getReport(created.run_id);
  store.applyReport(report);
  const exported = await options.api.exportRun(created.run_id);
  return { run, report, exported, cancelled: run.state === "CANCELLED" };
}
