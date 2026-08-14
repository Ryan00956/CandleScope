import process from "node:process";

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
const durationMs = Number(option("--duration-ms", "1"));
const maxCycles = Number(option("--max-cycles", "0"));
const startedAt = Date.now();
let cycles = 0;

async function json(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function runCycle() {
  const capabilities = await json("/capabilities");
  if (!capabilities.flags?.BACKTEST_ENABLED || !capabilities.flags?.BACKTEST_BAR_ENABLED) {
    throw new Error("BAR backtest flags are not enabled on the target runtime");
  }
  const datasets = (await json("/datasets")).datasets ?? [];
  const dataset = datasets.find(
    (item) => item.first_open_ms != null && item.last_close_ms != null,
  );
  if (!dataset) {
    throw new Error("target runtime has no complete immutable local dataset");
  }
  const preview = await json("/datasets/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dataset_id: dataset.dataset_id,
      data_epoch: dataset.data_epoch,
      start_time_ms: dataset.first_open_ms,
      end_time_ms: dataset.last_close_ms,
      interval: dataset.interval,
    }),
  });
  if (!preview.snapshot_hash || preview.row_count < 1) {
    throw new Error("snapshot preview did not return a sealed non-empty snapshot");
  }
  const idempotencyKey = `backtest-smoke-${process.pid}-${startedAt}-${cycles}`;
  const run = await json("/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      strategy_revision_id: "builtin-sma-cross-v1",
      dataset_id: dataset.dataset_id,
      data_epoch: dataset.data_epoch,
      snapshot_hash: preview.snapshot_hash,
      fidelity_mode: "BAR_APPROX",
      start_time_ms: dataset.first_open_ms,
      end_time_ms: dataset.last_close_ms,
      warmup_bars: 5,
      interval: dataset.interval,
      parameters: { fast: 3, slow: 5, qty: "1" },
    }),
  });
  const pollDeadline = Date.now() + 60_000;
  let current = run;
  while (!new Set(["COMPLETED", "FAILED", "CANCELLED"]).has(current.state)) {
    if (Date.now() > pollDeadline) {
      throw new Error(`run ${run.run_id} did not become terminal within 60s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await json(`/runs/${encodeURIComponent(run.run_id)}`);
  }
  if (current.state !== "COMPLETED") {
    throw new Error(`run ${run.run_id} ended in ${current.state}: ${current.failure_code ?? ""}`);
  }
  const report = await json(`/runs/${encodeURIComponent(run.run_id)}/report`);
  const bundle = await json(`/runs/${encodeURIComponent(run.run_id)}/export`);
  if (
    !report.hashes?.report ||
    report.hashes.report !== bundle.manifest?.reportHash ||
    report.hashes.report !== bundle.report?.hashes?.report ||
    !String(bundle.csv ?? "").startsWith(
      "order_id,sequence,event_time_ms,side,action,position_before,position_after,price,qty,fee,reason\n",
    )
  ) {
    throw new Error(`run ${run.run_id} export integrity verification failed`);
  }
  return {
    runId: run.run_id,
    reportHash: report.hashes.report,
    rowCount: preview.row_count,
  };
}

do {
  const result = await runCycle();
  cycles += 1;
  process.stdout.write(`${JSON.stringify({ cycle: cycles, ...result })}\n`);
} while (
  Date.now() - startedAt < durationMs &&
  (maxCycles < 1 || cycles < maxCycles)
);

process.stdout.write(
  `${JSON.stringify({ ok: true, cycles, elapsedMs: Date.now() - startedAt, base })}\n`,
);
