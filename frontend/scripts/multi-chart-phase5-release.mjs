import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateCapacityEvidence } from "./multi-chart-capacity.mjs";

export const PHASE5_RELEASE_SCHEMA = "candlescope.multi-chart.phase5-release/1";
export const PHASE5_SCENARIOS = Object.freeze(["S1", "S2", "S3", "S4", "S5", "C1"]);
export const SOAK_REPLACED_GATES = Object.freeze(["hotReadyP95"]);

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function passedCheck(actual, expected, passed) {
  return { actual, expected, passed };
}

export function evaluatePhase5Release({ matrix, hotReady, soak, rollback }) {
  const matrixResults = PHASE5_SCENARIOS.map((scenarioId) => {
    const evidence = matrix[scenarioId];
    const validationErrors = evidence ? validateCapacityEvidence(evidence) : ["missing evidence"];
    return {
      scenarioId,
      result: evidence?.result ?? null,
      databaseState: evidence?.data?.databaseState ?? null,
      initialDatabaseState: evidence?.backend?.before?.database?.state
        ?? evidence?.data?.databaseState
        ?? null,
      validationErrors,
      passed: evidence?.result === "pass" && validationErrors.length === 0,
    };
  });
  const nonReadinessSoakFailures = Object.entries(soak?.gates ?? {})
    .filter(([name, gate]) => !SOAK_REPLACED_GATES.includes(name) && gate?.passed !== true)
    .map(([name]) => name);
  const durationMs = Number(
    soak?.frontend?.measuredWindow?.durationMs ?? soak?.scenario?.durationMs,
  );
  const checks = {
    scenarioMatrix: passedCheck(
      matrixResults,
      "S1-S5 warm plus C1 true-empty capacity evidence all pass",
      matrixResults.every((entry) => entry.passed)
        && matrixResults.find((entry) => entry.scenarioId === "C1")?.initialDatabaseState === "empty",
    ),
    independentHotReadyP95: passedCheck(
      {
        schemaVersion: hotReady?.schemaVersion ?? null,
        runs: hotReady?.scenario?.runs ?? null,
        p95Ms: hotReady?.p95Ms ?? null,
      },
      "20 independent browser processes, p95 <= 3000 ms",
      hotReady?.result === "pass"
        && hotReady?.scenario?.runs === 20
        && (hotReady?.gates?.hotReadyP95 ?? hotReady?.checks?.hotReadyP95)?.passed === true,
    ),
    oneHourSoak: passedCheck(
      { durationMs, nonReadinessSoakFailures },
      "at least 1 hour and every gate except the separately sampled hotReadyP95 passes",
      Number.isFinite(durationMs)
        && durationMs >= 3_600_000
        && nonReadinessSoakFailures.length === 0,
    ),
    flagRollback: passedCheck(
      rollback?.checks ?? null,
      "16 -> 4 projection preserves the v6 document and defaults remain disabled",
      rollback?.result === "pass"
        && rollback?.checks?.visibleCells?.passed === true
        && rollback?.checks?.v6DocumentPreserved?.passed === true
        && rollback?.checks?.defaultFlagsDisabled?.passed === true,
    ),
  };
  return {
    matrixResults,
    nonReadinessSoakFailures,
    durationMs,
    checks,
    result: Object.values(checks).every((check) => check.passed) ? "pass" : "fail",
  };
}

function parseArgs(argv) {
  const args = { matrix: {} };
  const next = (index, name) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--matrix") {
      const binding = next(index++, value);
      const separator = binding.indexOf("=");
      if (separator < 1) throw new Error("--matrix must use SCENARIO=path");
      args.matrix[binding.slice(0, separator).toUpperCase()] = binding.slice(separator + 1);
    } else if (value === "--hot-ready") args.hotReady = next(index++, value);
    else if (value === "--soak") args.soak = next(index++, value);
    else if (value === "--rollback") args.rollback = next(index++, value);
    else if (value === "--out") args.out = next(index++, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  for (const scenarioId of PHASE5_SCENARIOS) {
    if (!args.matrix[scenarioId]) throw new Error(`missing --matrix ${scenarioId}=path`);
  }
  for (const name of ["hotReady", "soak", "rollback", "out"]) {
    if (!args[name]) throw new Error(`missing --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return args;
}

function readEvidence(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function source(filePath) {
  const resolved = path.resolve(filePath);
  return { path: resolved, sha256: sha256File(resolved) };
}

function scenarioSummary(evidence) {
  return {
    result: evidence?.result ?? null,
    firstUsableMs: evidence?.frontend?.readiness?.navigationToReadyMs ?? null,
    realtimeSettledMs: evidence?.frontend?.readiness?.realtimeSettledMs ?? null,
    visibleCells: evidence?.frontend?.readiness?.visibleCells ?? null,
    initialDatabase: evidence?.backend?.before?.database ?? null,
    finalDatabase: evidence?.backend?.after?.database ?? evidence?.data?.database ?? null,
    browserPhysicalKlineSockets: evidence?.frontend?.klineWebSockets ?? null,
    backendActiveSeries: evidence?.backend?.activeSeries ?? null,
    backendStreamLeases: evidence?.backend?.streamLeases ?? null,
    upstream: evidence?.upstream ?? null,
    failedGates: Object.entries(evidence?.gates ?? {})
      .filter(([, gate]) => gate?.passed !== true)
      .map(([name]) => name),
  };
}

export function run(argv) {
  const args = parseArgs(argv);
  const matrix = Object.fromEntries(
    Object.entries(args.matrix).map(([scenarioId, filePath]) => [scenarioId, readEvidence(filePath)]),
  );
  const hotReady = readEvidence(args.hotReady);
  const soak = readEvidence(args.soak);
  const rollback = readEvidence(args.rollback);
  const evaluation = evaluatePhase5Release({ matrix, hotReady, soak, rollback });
  const release = {
    schemaVersion: PHASE5_RELEASE_SCHEMA,
    generatedAt: new Date().toISOString(),
    scope: "single-window-16-chart",
    methodology: {
      hotReady: "20 independent Chrome processes against one warm sidecar/database",
      soak: "one continuous 60 minute S4 measured window",
      cold: "C1 starts from a verified zero-row SQLite database",
      rollback: "production build with default-disabled flags projects four cells without rewriting v6",
    },
    sources: {
      matrix: Object.fromEntries(
        Object.entries(args.matrix).map(([scenarioId, filePath]) => [scenarioId, source(filePath)]),
      ),
      hotReady: source(args.hotReady),
      soak: source(args.soak),
      rollback: source(args.rollback),
    },
    evidenceSummary: {
      matrix: Object.fromEntries(
        Object.entries(matrix).map(([scenarioId, evidence]) => [scenarioId, scenarioSummary(evidence)]),
      ),
      hotReady: {
        samplesMs: hotReady.samplesMs,
        p95Ms: hotReady.p95Ms,
        gates: hotReady.gates,
        processes: hotReady.sources?.map((entry) => ({
          run: entry.run,
          readyMs: entry.readyMs,
          realtimeSettledMs: entry.realtimeSettledMs,
          backendDrainMs: entry.backendDrainMs,
          processExitCode: entry.processExitCode,
        })) ?? [],
      },
      soak: {
        durationMs: soak?.frontend?.measuredWindow?.durationMs ?? soak?.scenario?.durationMs ?? null,
        gates: soak?.gates ?? {},
        analysis: soak?.frontend?.measuredWindow?.analysis ?? null,
        reconnects: soak?.frontend?.measuredWindow?.reconnects ?? [],
        actionFailures: soak?.frontend?.measuredWindow?.actionFailures ?? [],
      },
      rollback: {
        build: rollback.build,
        browser: rollback.browser,
        persisted: rollback.persisted,
        checks: rollback.checks,
      },
    },
    ...evaluation,
  };
  const outputPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(release, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out: outputPath, result: release.result })}\n`);
  return release.result === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
