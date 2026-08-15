import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

const SCHEMA = "candlescope.backtest-m10-api-soak/1";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const base = String(
  option(
    "--base-url",
    process.env.BACKTEST_BASE_URL ?? "http://127.0.0.1:8000/api/v1/backtests",
  ),
).replace(/\/$/, "");
const durationMs = Number(option("--duration-ms", "3600000"));
const cycleDelayMs = Number(option("--cycle-delay-ms", "5000"));
const datasetId = option("--dataset-id", "");
const output = option("--output", "");
const serverPid = Number(option("--server-pid", "0"));
if (!output || !Number.isFinite(durationMs) || durationMs < 1) {
  throw new Error("--output and a positive --duration-ms are required");
}
mkdirSync(dirname(output), { recursive: true });

const startedAtMs = Date.now();
const cycles = [];
let capabilities = null;
let selectedDataset = null;
let lastSnapshotHash = null;
let soakEndTimeMs = null;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function serverAlive() {
  if (!serverPid) return null;
  try {
    process.kill(serverPid, 0);
    return true;
  } catch {
    return false;
  }
}

function fixedIntervalMs(interval) {
  const match = /^(\d+)(s|m|h|d)$/.exec(String(interval));
  if (!match) throw new Error(`unsupported soak interval ${interval}`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number(match[1]) * unit;
}

async function json(path, init) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }
  return { payload, latencyMs: performance.now() - started };
}

async function runCycle(ordinal) {
  if (serverAlive() === false) throw new Error(`server PID ${serverPid} exited`);
  const preview = await json("/datasets/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dataset_id: selectedDataset.dataset_id,
      data_epoch: selectedDataset.data_epoch,
      start_time_ms: selectedDataset.first_open_ms,
      end_time_ms: soakEndTimeMs,
      interval: selectedDataset.interval,
    }),
  });
  if (!preview.payload.snapshot_hash || preview.payload.row_count < 1) {
    throw new Error("snapshot preview is empty or unsealed");
  }
  if (lastSnapshotHash && preview.payload.snapshot_hash !== lastSnapshotHash) {
    throw new Error("immutable snapshot hash changed during soak");
  }
  lastSnapshotHash = preview.payload.snapshot_hash;
  const created = await json("/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": `m10-api-soak-${startedAtMs}-${ordinal}`,
    },
    body: JSON.stringify({
      strategy_revision_id: "builtin-order-command-v1",
      dataset_id: selectedDataset.dataset_id,
      data_epoch: selectedDataset.data_epoch,
      snapshot_hash: preview.payload.snapshot_hash,
      fidelity_mode: "BAR_APPROX",
      start_time_ms: selectedDataset.first_open_ms,
      end_time_ms: soakEndTimeMs,
      interval: selectedDataset.interval,
      strategy_source: JSON.stringify({
        commands: [
          { sequence: 2, action: "OPEN_LONG", qty: "1" },
          { sequence: 10, action: "CLOSE_LONG", qty: "1" },
        ],
      }),
      output_mode: "ORDER_INTENT",
      execution_model_revision: "EXECUTION_REALISM_V2",
      participation_rate: "0.1",
      bar_path_scenario: "OHLC_WORST_CASE_STOP_FIRST_V1",
      order_end_policy: "CANCEL_AT_END",
    }),
  });
  const runId = created.payload.run_id;
  const deadline = Date.now() + 120_000;
  let record = created.payload;
  let polls = 0;
  while (!new Set(["COMPLETED", "FAILED", "CANCELLED"]).has(record.state)) {
    if (Date.now() > deadline) throw new Error(`run ${runId} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    record = (await json(`/runs/${encodeURIComponent(runId)}`)).payload;
    polls += 1;
  }
  if (record.state !== "COMPLETED") {
    throw new Error(`run ${runId} ended ${record.state}: ${record.failure_code ?? ""}`);
  }
  const report = await json(`/runs/${encodeURIComponent(runId)}/report`);
  const bundle = await json(`/runs/${encodeURIComponent(runId)}/export`);
  const chart = await json(`/runs/${encodeURIComponent(runId)}/chart`);
  const reportHash = report.payload.hashes?.report;
  if (
    !reportHash ||
    reportHash !== bundle.payload.manifest?.reportHash ||
    reportHash !== bundle.payload.report?.hashes?.report ||
    chart.payload.fills?.length !== 2 ||
    chart.payload.bars?.length < 10
  ) {
    throw new Error(`run ${runId} public artifact integrity failed`);
  }
  return {
    ordinal,
    runId,
    reportHash,
    snapshotHash: lastSnapshotHash,
    polls,
    latenciesMs: {
      preview: Number(preview.latencyMs.toFixed(3)),
      create: Number(created.latencyMs.toFixed(3)),
      report: Number(report.latencyMs.toFixed(3)),
      export: Number(bundle.latencyMs.toFixed(3)),
      chart: Number(chart.latencyMs.toFixed(3)),
    },
  };
}

function receipt(status, error = null) {
  const endedAtMs = Date.now();
  return {
    schemaVersion: SCHEMA,
    status,
    gitSha: git("rev-parse", "HEAD"),
    gitDirty: Boolean(git("status", "--porcelain")),
    branch: git("branch", "--show-current"),
    baseUrl: base,
    requestedDurationMs: durationMs,
    startedAtMs,
    endedAtMs,
    elapsedMs: endedAtMs - startedAtMs,
    cycleDelayMs,
    cycleCount: cycles.length,
    serverPid: serverPid || null,
    serverAliveAtEnd: serverAlive(),
    effectiveFlags: capabilities?.flags ?? null,
    dataset: selectedDataset,
    window: selectedDataset
      ? { startTimeMs: selectedDataset.first_open_ms, endTimeMs: soakEndTimeMs }
      : null,
    snapshotHash: lastSnapshotHash,
    cycles,
    error,
  };
}

try {
  capabilities = (await json("/capabilities")).payload;
  if (!capabilities.flags?.BACKTEST_ENABLED || !capabilities.flags?.BACKTEST_BAR_ENABLED) {
    throw new Error("BAR backtest flags are not enabled on the target runtime");
  }
  const datasets = (await json("/datasets")).payload.datasets ?? [];
  selectedDataset = datasets.find((item) =>
    datasetId ? item.dataset_id === datasetId : item.rows >= 10 && item.rows <= 5000,
  );
  if (!selectedDataset) throw new Error("requested bounded immutable dataset not found");
  soakEndTimeMs = Math.min(
    selectedDataset.last_close_ms,
    selectedDataset.first_open_ms + 120 * fixedIntervalMs(selectedDataset.interval) - 1,
  );
  do {
    cycles.push(await runCycle(cycles.length + 1));
    if (Date.now() - startedAtMs < durationMs) {
      await new Promise((resolve) => setTimeout(resolve, cycleDelayMs));
    }
  } while (Date.now() - startedAtMs < durationMs);
  const result = receipt("PASS");
  if (result.elapsedMs < durationMs || result.cycleCount < 1) {
    throw new Error("soak did not satisfy its requested wall-clock duration");
  }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "PASS", output, cycles: cycles.length })}\n`);
} catch (error) {
  const result = receipt("FAILED", {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  throw error;
}
