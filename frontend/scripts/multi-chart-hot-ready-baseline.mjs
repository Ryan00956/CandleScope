import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateCapacityEvidence } from "./multi-chart-capacity.mjs";

export const HOT_READY_BASELINE_SCHEMA = "candlescope.multi-chart.hot-ready-baseline/1";
export const REQUIRED_HOT_BASELINE_GATES = Object.freeze([
  "visibleCells",
  "allCellsReady",
  "realtimeSubscriptionsSettled",
  "documentVisible",
  "consoleErrors",
  "runtimeExceptions",
  "networkFailures",
  "backendSnapshot",
  "expectedBackendSeries",
  "duplicateBackendLease",
  "exactBackendLeaseClaims",
  "canvasRemounts",
  "backgroundSuppression",
  "batchBrowserPhysicalKlineSockets",
  "batchLogicalClients",
  "batchLogicalSubscriptions",
  "batchAuthoritativeTimeouts",
  "linkBoundary",
  "productBoundaryDrill",
]);

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((pct / 100) * (sorted.length - 1))),
  );
  return sorted[index];
}

export function evaluateHotReadySamples(evidences, expectedRuns = 20) {
  const samplesMs = [];
  const invalidRuns = [];
  for (const [index, evidence] of evidences.entries()) {
    const validationErrors = validateCapacityEvidence(evidence);
    const nonReadinessFailures = REQUIRED_HOT_BASELINE_GATES
      .filter((name) => evidence?.gates?.[name]?.passed !== true);
    const readyMs = Number(evidence?.frontend?.readiness?.navigationToReadyMs);
    if (validationErrors.length || nonReadinessFailures.length || !Number.isFinite(readyMs)) {
      invalidRuns.push({
        run: index + 1,
        validationErrors,
        nonReadinessFailures,
        readyMs: Number.isFinite(readyMs) ? readyMs : null,
      });
      continue;
    }
    samplesMs.push(readyMs);
  }
  const p95Ms = percentile(samplesMs, 95);
  const checks = {
    exactIndependentRuns: {
      actual: evidences.length,
      expected: expectedRuns,
      passed: evidences.length === expectedRuns,
    },
    validNonReadinessGates: {
      actual: invalidRuns,
      expected: [],
      passed: invalidRuns.length === 0,
    },
    hotReadyP95: {
      actual: p95Ms,
      expected: "<= 3000 ms",
      passed: samplesMs.length === expectedRuns && p95Ms !== null && p95Ms <= 3_000,
    },
  };
  return {
    samplesMs,
    p95Ms,
    invalidRuns,
    checks,
    result: Object.values(checks).every((check) => check.passed) ? "pass" : "fail",
  };
}

function parseArgs(argv) {
  const args = {
    url: "http://127.0.0.1:15173/",
    backendUrl: "http://127.0.0.1:18080",
    cells: 16,
    scenario: "S4",
    runs: 20,
    readyTimeoutMs: 120_000,
    cooldownMs: 2_000,
    out: "docs/perf-baselines/multi-chart-workspace/phase5-hot-ready-p95.json",
    artifactsDir: "output/playwright/multi-chart-hot-ready",
  };
  const valueAfter = (index, name) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--url") args.url = valueAfter(index++, value);
    else if (value === "--backend-url") args.backendUrl = valueAfter(index++, value);
    else if (value === "--cells") args.cells = Number(valueAfter(index++, value));
    else if (value === "--scenario") args.scenario = valueAfter(index++, value).toUpperCase();
    else if (value === "--runs") args.runs = Number(valueAfter(index++, value));
    else if (value === "--ready-timeout-ms") args.readyTimeoutMs = Number(valueAfter(index++, value));
    else if (value === "--cooldown-ms") args.cooldownMs = Number(valueAfter(index++, value));
    else if (value === "--out") args.out = valueAfter(index++, value);
    else if (value === "--artifacts-dir") args.artifactsDir = valueAfter(index++, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 2 || args.runs > 50) {
    throw new Error("--runs must be an integer from 2 through 50");
  }
  if (!Number.isInteger(args.cooldownMs) || args.cooldownMs < 0 || args.cooldownMs > 30_000) {
    throw new Error("--cooldown-ms must be an integer from 0 through 30000");
  }
  return args;
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function gitSnapshot(cwd) {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : "unknown",
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : true,
  };
}

export function isBackendDrained(capacity) {
  return Number(capacity?.dataManager?.streamLeases ?? -1) === 0
    && Number(capacity?.klineBatch?.logical_clients ?? -1) === 0
    && Number(capacity?.klineBatch?.logical_subscriptions ?? -1) === 0;
}

async function waitForBackendDrain(backendUrl, timeoutMs) {
  const startedAt = Date.now();
  let latest = null;
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${backendUrl}/debug/capacity?detail_limit=0`, {
        signal: AbortSignal.timeout(Math.min(5_000, timeoutMs)),
      });
      if (!response.ok) throw new Error(`capacity snapshot returned HTTP ${response.status}`);
      latest = await response.json();
      if (isBackendDrained(latest)) {
        return { durationMs: Date.now() - startedAt, snapshot: latest };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not drain between independent browser runs: ${JSON.stringify({
    lastError: lastError instanceof Error ? lastError.message : null,
    streamLeases: latest?.dataManager?.streamLeases ?? null,
    logicalClients: latest?.klineBatch?.logical_clients ?? null,
    logicalSubscriptions: latest?.klineBatch?.logical_subscriptions ?? null,
  })}`);
}

async function run(argv) {
  const args = parseArgs(argv);
  const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const capacityScript = path.resolve(frontendRoot, "scripts/multi-chart-capacity.mjs");
  const artifactsRoot = path.resolve(frontendRoot, args.artifactsDir);
  fs.mkdirSync(artifactsRoot, { recursive: true });
  const evidences = [];
  const sources = [];

  for (let index = 0; index < args.runs; index += 1) {
    const runId = String(index + 1).padStart(2, "0");
    const evidencePath = path.join(artifactsRoot, `run-${runId}.json`);
    const runArtifacts = path.join(artifactsRoot, `run-${runId}-artifacts`);
    const hardwarePath = path.join(artifactsRoot, `run-${runId}-hardware.json`);
    const child = spawnSync(process.execPath, [
      capacityScript,
      "--url", args.url,
      "--backend-url", args.backendUrl,
      "--cells", String(args.cells),
      "--scenario", args.scenario,
      "--duration-ms", "1000",
      "--ready-timeout-ms", String(args.readyTimeoutMs),
      "--require-database-state", "warm",
      "--workload", "observe",
      "--out", evidencePath,
      "--artifacts-dir", runArtifacts,
      "--hardware-out", hardwarePath,
    ], {
      cwd: frontendRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: false,
    });
    if (!fs.existsSync(evidencePath)) {
      throw new Error(`Hot readiness run ${runId} produced no evidence: ${child.stderr || child.stdout}`);
    }
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    const drain = await waitForBackendDrain(args.backendUrl, Math.max(30_000, args.readyTimeoutMs));
    evidences.push(evidence);
    sources.push({
      run: index + 1,
      path: evidencePath,
      sha256: sha256File(evidencePath),
      processExitCode: child.status,
      readyMs: evidence?.frontend?.readiness?.navigationToReadyMs ?? null,
      realtimeSettledMs: evidence?.frontend?.readiness?.realtimeSettledMs ?? null,
      backendDrainMs: drain.durationMs,
      result: evidence?.result ?? null,
    });
    if (index + 1 < args.runs && args.cooldownMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.cooldownMs));
    }
  }

  const evaluated = evaluateHotReadySamples(evidences, args.runs);
  const aggregate = {
    schemaVersion: HOT_READY_BASELINE_SCHEMA,
    generatedAt: new Date().toISOString(),
    git: gitSnapshot(path.resolve(frontendRoot, "..")),
    scenario: { id: args.scenario, cells: args.cells, runs: args.runs },
    methodology: {
      browserProcesses: "independent",
      databaseState: "warm",
      durationPerRunMs: 1_000,
      percentile: 95,
      thresholdMs: 3_000,
      cooldownMs: args.cooldownMs,
      realtimeContract: "all subscriptions settle to live or explicit fallback outside first-usable timing",
      isolationContract: "backend stream leases and batch logical subscriptions drain to zero between processes",
    },
    sources,
    samplesMs: evaluated.samplesMs,
    p95Ms: evaluated.p95Ms,
    gates: evaluated.checks,
    result: evaluated.result,
  };
  const outputPath = path.resolve(frontendRoot, args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out: outputPath, result: aggregate.result, p95Ms: aggregate.p95Ms, samplesMs: aggregate.samplesMs }, null, 2)}\n`);
  if (aggregate.result !== "pass") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
