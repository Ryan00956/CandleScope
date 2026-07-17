#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { startControlledProductionCdp } from "./drawing-controlled-cdp.mjs";
import {
  assessDrawingRollbackDrillArtifact,
  DRAWING_ROLLBACK_DRILL_IDS,
} from "./drawing-rollback-drills.mjs";
import {
  canonicalArtifactSha256,
  runControlledWorkerRollbackDrills,
} from "./drawing-rollback-worker-browser.mjs";
import { runControlledLifecycleRollbackDrills } from "./drawing-rollback-lifecycle-browser.mjs";
import { runControlledExportRollbackDrills } from "./drawing-rollback-export-browser.mjs";
import { runControlledStorageRollbackDrills } from "./drawing-rollback-storage-browser.mjs";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "phase9-rollback-drills");
const FIXED_CONFIGURATION = Object.freeze({
  dpr: 1,
  engineMode: "scene-canary",
  interactionSurfaceMode: "overlay",
  rasterBackend: "worker",
  viewport: Object.freeze({ width: 1440, height: 900 }),
});
const FORBIDDEN_OPTIONS = Object.freeze([
  "--allow-incomplete",
  "--artifact",
  "--cdp-url",
  "--fake-transport",
  "--fixture",
  "--headless",
  "--phase6-report",
  "--scenario-module",
]);

export const CONTROLLED_DRILL_PLAN = Object.freeze([
  Object.freeze({ id: "worker-init-failure", producer: "worker" }),
  Object.freeze({ id: "offscreen-canvas-unsupported", producer: "worker" }),
  Object.freeze({ id: "indexeddb-quota-blocked", producer: "storage" }),
  Object.freeze({ id: "worker-stale-generation", producer: "worker" }),
  Object.freeze({ id: "active-gesture-chart-boundary", producer: "lifecycle" }),
  Object.freeze({ id: "series-rebuild-before-export", producer: "lifecycle" }),
  Object.freeze({ id: "continuous-dpr-resize", producer: "lifecycle" }),
  Object.freeze({ id: "canary-to-legacy-snapshot", producer: "storage" }),
]);

const IMPLEMENTED_WORKER_DRILL_IDS = new Set([
  "worker-init-failure",
  "offscreen-canvas-unsupported",
  "worker-stale-generation",
]);
const IMPLEMENTED_STORAGE_DRILL_IDS = new Set(["indexeddb-quota-blocked"]);
const IMPLEMENTED_LIFECYCLE_DRILL_IDS = new Set([
  "active-gesture-chart-boundary",
  "series-rebuild-before-export",
]);
const IMPLEMENTED_DRILL_IDS = new Set([
  ...IMPLEMENTED_WORKER_DRILL_IDS,
  ...IMPLEMENTED_STORAGE_DRILL_IDS,
  ...IMPLEMENTED_LIFECYCLE_DRILL_IDS,
]);

function usage() {
  return [
    "Phase 9 controlled headed-browser rollback drills",
    "",
    "Usage: powershell.exe -NoProfile -File scripts/drawing-rollback-drills-browser.ps1 [options]",
    "",
    "Options:",
    "  --chrome <path>       Chrome/Edge executable (auto-detected by default)",
    "  --timeout-ms <n>      Per-stage timeout, 1000..600000 (default 45000)",
    "  --out-dir <path>      Parent directory for the unique controlled run",
    "  --help                Show this help",
    "",
    "This authority starts its own production servers, visible browser, and CDP session.",
    "It never accepts external artifacts, an external CDP URL, headless mode, fixtures,",
    "scenario modules, fake transports, Phase 6 reports, or allow-incomplete overrides.",
  ].join("\n");
}

function optionName(argument) {
  const separator = argument.indexOf("=");
  return separator < 0 ? argument : argument.slice(0, separator);
}

function optionValue(argv, index, name) {
  const argument = argv[index];
  const inline = argument.startsWith(`${name}=`);
  const value = inline ? argument.slice(name.length + 1) : argv[index + 1];
  if (typeof value !== "string" || !value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return { value, index: inline ? index : index + 1 };
}

function boundedTimeout(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1_000 || number > 600_000) {
    throw new TypeError("--timeout-ms must be an integer between 1000 and 600000");
  }
  return number;
}

export function parseArgs(argv) {
  const args = {
    chromePath: "",
    timeoutMs: 45_000,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = optionName(argument);
    if (FORBIDDEN_OPTIONS.includes(name)) {
      throw new Error(`${name} is forbidden for the controlled browser authority`);
    }
    if (name === "--help" || name === "-h") {
      args.help = true;
      continue;
    }
    if (!["--chrome", "--timeout-ms", "--out-dir"].includes(name)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (seen.has(name)) throw new Error(`duplicate option: ${name}`);
    seen.add(name);
    const resolved = optionValue(argv, index, name);
    index = resolved.index;
    if (name === "--chrome") args.chromePath = path.resolve(resolved.value);
    else if (name === "--timeout-ms") args.timeoutMs = boundedTimeout(resolved.value);
    else args.outputRoot = path.resolve(resolved.value);
  }
  return Object.freeze(args);
}

function gitRevision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: FRONTEND_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const revision = result.stdout.trim();
  return /^[a-f0-9]{40}$/.test(revision) ? revision : null;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function validateFixedPlan() {
  const ids = CONTROLLED_DRILL_PLAN.map((entry) => entry.id);
  return ids.length === DRAWING_ROLLBACK_DRILL_IDS.length
    && new Set(ids).size === ids.length
    && ids.every((id, index) => id === DRAWING_ROLLBACK_DRILL_IDS[index]);
}

function diagnosticFailures(snapshot) {
  if (!snapshot) return ["diagnostics-missing"];
  const page = snapshot.pageAndWorker || snapshot;
  const failures = [];
  for (const key of [
    "crashes",
    "unexpectedConsoleErrors",
    "runtimeExceptions",
    "unhandledRejections",
    "windowErrors",
    "networkFailures",
    "commandErrors",
    "protocolErrors",
    "handlerErrors",
  ]) {
    if (!Array.isArray(page?.[key]) || page[key].length > 0) {
      failures.push(`${key}:${Array.isArray(page?.[key]) ? page[key].length : "missing"}`);
    }
  }
  if (snapshot.workers && snapshot.workers.passed !== true) failures.push("worker-diagnostics-invalid");
  if (snapshot.originGuard && snapshot.originGuard.passed !== true) failures.push("origin-guard-invalid");
  if (snapshot.cdpHandlers && snapshot.cdpHandlers.passed !== true) failures.push("cdp-handlers-invalid");
  return failures;
}

export function buildInitialControlledRunReport(args, {
  runId = `phase9-${Date.now()}-${crypto.randomUUID()}`,
  startedAt = new Date().toISOString(),
} = {}) {
  const planValid = validateFixedPlan();
  return {
    schemaVersion: "drawing-rollback-controlled-run-partial/v2",
    status: "partial",
    phase9RollbackDrillsPassed: false,
    harnessPassed: false,
    workerHarnessPassed: false,
    storageHarnessPassed: false,
    lifecycleHarnessPassed: false,
    runId,
    sourceRevision: gitRevision(),
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    configuration: {
      ...FIXED_CONFIGURATION,
      headed: true,
      externalArtifactsAccepted: false,
      externalCdpAccepted: false,
      allowIncomplete: false,
      timeoutMs: args.timeoutMs,
      chromePathConfigured: args.chromePath.length > 0,
    },
    lifecycle: {
      buildStarted: false,
      buildCompleted: false,
      serverStarted: false,
      browserStarted: false,
      diagnosticsClosed: false,
      browserClosed: false,
      serverClosed: false,
      runClosed: false,
    },
    planValid,
    drills: CONTROLLED_DRILL_PLAN.map((entry) => ({
      ...entry,
      status: "not-run",
      contractPassed: false,
      trustedRunnerAccepted: false,
    })),
    evidence: null,
    cleanup: null,
    failureReasons: [...(!planValid ? ["controlled-browser-drill-plan-invalid"] : [])],
  };
}

function prefixedSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? `sha256:${value}` : null;
}

export function drillBuildAuthorityPassed(result, buildReceipt, expectedDrillIds) {
  const expected = expectedDrillIds instanceof Set
    ? expectedDrillIds
    : new Set(expectedDrillIds ?? []);
  const artifacts = Array.isArray(result?.drills) ? result.drills : [];
  if (expected.size === 0 || artifacts.length !== expected.size || !buildReceipt) return false;
  const seen = new Set();
  const expectedBuildFingerprint = prefixedSha256(buildReceipt.buildFingerprint?.sha256);
  const expectedAssetDigest = prefixedSha256(buildReceipt.assetFingerprint?.sha256);
  const expectedBuildInputDigest = prefixedSha256(buildReceipt.inputFingerprint?.sha256);
  return artifacts.every((artifact) => {
    const drillId = artifact?.drillId;
    const authority = artifact?.buildAuthority;
    if (!expected.has(drillId) || seen.has(drillId)) return false;
    seen.add(drillId);
    return authority?.kind === "controlled-browser-build-authority"
      && authority.drillId === drillId
      && authority.authoritative === true
      && authority.buildId === buildReceipt.buildId
      && authority.buildFingerprint === expectedBuildFingerprint
      && authority.assetDigest === expectedAssetDigest
      && authority.currentAssetDigest === expectedAssetDigest
      && authority.buildInputDigest === expectedBuildInputDigest
      && authority.currentBuildInputDigest === expectedBuildInputDigest
      && authority.gitRevision === buildReceipt.git?.commit
      && authority.assetBuildAuthoritative === true
      && authority.matchesManagedOrigin === true
      && authority.matchesManagedDocument === true
      && authority.entryAssetsLoaded === true
      && authority.networkAssetAuthorityPassed === true
      && authority.networkQuiescencePassed === true
      && authority.browserLoadedAssetsAccepted === true
      && authority.domLoadedAssetsAccepted === true
      && authority.expectedEntriesPresentInDom === true
      && authority.distMatchesBuild === true
      && authority.buildInputsMatch === true
      && authority.gitMatchesBuild === true
      && authority.managedOriginGuardPassed === true
      && authority.workerDiagnosticsPassed === true
      && authority.handlerSettlementsPassed === true
      && authority.workerLifecycle?.accepted === true
      && authority.workerLifecycle?.assetAuthorityAccepted === true;
  }) && seen.size === expected.size;
}

export function workerDrillBuildAuthorityPassed(workerResult, buildReceipt) {
  return drillBuildAuthorityPassed(
    workerResult,
    buildReceipt,
    IMPLEMENTED_WORKER_DRILL_IDS,
  );
}

export function storageDrillBuildAuthorityPassed(storageResult, buildReceipt) {
  return drillBuildAuthorityPassed(
    storageResult,
    buildReceipt,
    IMPLEMENTED_STORAGE_DRILL_IDS,
  );
}

export function lifecycleDrillBuildAuthorityPassed(lifecycleResult, buildReceipt) {
  return drillBuildAuthorityPassed(
    lifecycleResult,
    buildReceipt,
    IMPLEMENTED_LIFECYCLE_DRILL_IDS,
  );
}

function currentFailureReasons(report, executionFailure, finalDiagnosticFailures) {
  const reasons = [];
  if (!report.planValid) reasons.push("controlled-browser-drill-plan-invalid");
  if (executionFailure) reasons.push(`controlled-drill-execution-failed:${executionFailure}`);
  reasons.push(...finalDiagnosticFailures.map((reason) => `controlled-final-diagnostics:${reason}`));
  const incomplete = CONTROLLED_DRILL_PLAN
    .filter((entry) => !IMPLEMENTED_DRILL_IDS.has(entry.id))
    .map((entry) => entry.id);
  if (incomplete.length > 0) {
    reasons.push(`controlled-browser-drill-producers-incomplete:${incomplete.join(",")}`);
  }
  return reasons;
}

async function runControlledRollbackDrills(args) {
  const report = buildInitialControlledRunReport(args);
  const runDirectory = path.join(args.outputRoot, report.runId);
  const reportPath = path.join(runDirectory, "controlled-run.partial.json");
  atomicWriteJson(reportPath, report);
  let session = null;
  let cleanup = null;
  let executionFailure = null;
  let workerResult = null;
  let storageResult = null;
  let lifecycleResult = null;
  let authoritativeState = null;
  let liveDiagnostics = null;
  try {
    report.lifecycle.buildStarted = true;
    atomicWriteJson(reportPath, report);
    session = await startControlledProductionCdp({
      ...FIXED_CONFIGURATION,
      chromePath: args.chromePath,
      timeoutMs: args.timeoutMs,
    });
    report.lifecycle.buildCompleted = true;
    report.lifecycle.serverStarted = true;
    report.lifecycle.browserStarted = true;
    report.sourceRevision = session.buildReceipt.git.commit;
    workerResult = await runControlledWorkerRollbackDrills(session, { timeoutMs: args.timeoutMs });
    storageResult = await runControlledStorageRollbackDrills(session, {
      timeoutMs: args.timeoutMs,
      beforeDocument: workerResult.finalDocument,
    });
    const gestureLifecycleResult = await runControlledLifecycleRollbackDrills(session, {
      timeoutMs: args.timeoutMs,
      beforeDocument: storageResult.finalDocument,
    });
    const exportLifecycleResult = await runControlledExportRollbackDrills(session, {
      timeoutMs: args.timeoutMs,
      beforeDocument: gestureLifecycleResult.finalDocument,
    });
    lifecycleResult = Object.freeze({
      drills: Object.freeze([
        ...gestureLifecycleResult.drills,
        ...exportLifecycleResult.drills,
      ]),
      finalDocument: exportLifecycleResult.finalDocument,
    });
    authoritativeState = await session.settleAuthoritativeState();
    liveDiagnostics = session.diagnostics();
  } catch (error) {
    executionFailure = error instanceof Error ? error.message : String(error);
    cleanup = error?.cleanup ?? null;
  } finally {
    if (session) {
      try {
        cleanup = await session.close();
      } catch (error) {
        executionFailure = `${executionFailure ? `${executionFailure}; ` : ""}close:${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }

  const finalDiagnostics = {
    pageAndWorker: cleanup?.finalDiagnostics ?? null,
    workers: cleanup?.finalWorkerDiagnostics ?? null,
    originGuard: cleanup?.finalOriginGuard ?? null,
    cdpHandlers: cleanup?.browser?.handlerSettlementAfterClose ?? null,
  };
  const finalDiagnosticFailures = diagnosticFailures(finalDiagnostics);
  const storageFaultCleanupComplete = cleanup?.browser?.storageFaultCleanup?.complete === true
    && cleanup?.browser?.storageFaultCleanup?.forced === false;
  const cleanupComplete = cleanup?.summary?.complete === true && storageFaultCleanupComplete;
  const workerBuildAuthorityPassed = workerDrillBuildAuthorityPassed(
    workerResult,
    session?.buildReceipt,
  );
  const storageBuildAuthorityPassed = storageDrillBuildAuthorityPassed(
    storageResult,
    session?.buildReceipt,
  );
  const lifecycleBuildAuthorityPassed = lifecycleDrillBuildAuthorityPassed(
    lifecycleResult,
    session?.buildReceipt,
  );
  const perDrillBuildAuthorityPassed = workerBuildAuthorityPassed
    && storageBuildAuthorityPassed
    && lifecycleBuildAuthorityPassed;
  const runAuthorityPassed = executionFailure === null
    && session?.initialBuildEvidence?.authoritative === true
    && perDrillBuildAuthorityPassed
    && authoritativeState !== null
    && diagnosticFailures(liveDiagnostics).length === 0
    && finalDiagnosticFailures.length === 0
    && cleanupComplete;

  const producedArtifacts = [
    ...(workerResult?.drills ?? []),
    ...(storageResult?.drills ?? []),
    ...(lifecycleResult?.drills ?? []),
  ];
  const artifacts = new Map(producedArtifacts.map((artifact) => [artifact.drillId, artifact]));
  report.drills = CONTROLLED_DRILL_PLAN.map((entry) => {
    const artifact = artifacts.get(entry.id) ?? null;
    if (!artifact) return {
      ...entry,
      status: "not-run",
      contractPassed: false,
      trustedRunnerAccepted: false,
    };
    const artifactPath = path.join(runDirectory, `${entry.id}.json`);
    atomicWriteJson(artifactPath, artifact);
    const assessment = assessDrawingRollbackDrillArtifact(entry.id, artifact);
    const contractPassed = assessment.contractPassed === true;
    const trustedRunnerAccepted = contractPassed && runAuthorityPassed;
    return {
      ...entry,
      status: trustedRunnerAccepted ? "passed" : "failed",
      contractPassed,
      trustedRunnerAccepted,
      artifactPath,
      artifactSha256: canonicalArtifactSha256(artifact),
      evidenceKind: assessment.evidenceKind,
      assessmentFailures: assessment.failures,
    };
  });
  report.workerHarnessPassed = [...IMPLEMENTED_WORKER_DRILL_IDS].every((drillId) => (
    report.drills.find((drill) => drill.id === drillId)?.trustedRunnerAccepted === true
  ));
  report.storageHarnessPassed = [...IMPLEMENTED_STORAGE_DRILL_IDS].every((drillId) => (
    report.drills.find((drill) => drill.id === drillId)?.trustedRunnerAccepted === true
  ));
  report.lifecycleHarnessPassed = [...IMPLEMENTED_LIFECYCLE_DRILL_IDS].every((drillId) => (
    report.drills.find((drill) => drill.id === drillId)?.trustedRunnerAccepted === true
  ));
  report.harnessPassed = report.workerHarnessPassed
    && report.storageHarnessPassed
    && report.lifecycleHarnessPassed
    && cleanupComplete
    && finalDiagnosticFailures.length === 0;
  report.phase9RollbackDrillsPassed = report.drills.every((drill) => (
    drill.trustedRunnerAccepted === true
  ));
  report.status = report.phase9RollbackDrillsPassed
    ? "passed"
    : executionFailure
        || !report.workerHarnessPassed
        || !report.storageHarnessPassed
        || !report.lifecycleHarnessPassed
      ? "failed"
      : "partial";
  report.lifecycle = {
    ...report.lifecycle,
    diagnosticsClosed: cleanup?.diagnosticsClosed === true,
    browserClosed: cleanup?.browser?.exited === true,
    serverClosed: cleanup?.servers?.preview?.exited === true && cleanup?.servers?.api?.exited === true,
    runClosed: cleanupComplete,
  };
  report.evidence = {
    buildFingerprint: session?.buildReceipt?.buildFingerprint ?? null,
    initialBuildAuthoritative: session?.initialBuildEvidence?.authoritative === true,
    perDrillBuildAuthorityPassed,
    workerBuildAuthorityPassed,
    storageBuildAuthorityPassed,
    lifecycleBuildAuthorityPassed,
    storageFaultCleanupComplete,
    drillBuildAuthorities: Object.freeze(producedArtifacts.map((artifact) => (
      artifact.buildAuthority ?? null
    ))),
    rollbackAuthority: session?.rollbackAuthority ?? null,
    authoritativeState,
    liveDiagnostics,
    finalDiagnosticFailures,
    baseline: workerResult?.baseline ?? null,
    finalDocument: lifecycleResult?.finalDocument
      ?? storageResult?.finalDocument
      ?? workerResult?.finalDocument
      ?? null,
  };
  report.cleanup = cleanup;
  report.failureReasons = currentFailureReasons(report, executionFailure, finalDiagnosticFailures);
  report.updatedAt = new Date().toISOString();
  report.completedAt = report.updatedAt;
  atomicWriteJson(reportPath, report);
  return Object.freeze({ reportPath, report });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runControlledRollbackDrills(args);
  process.stdout.write(`${JSON.stringify({
    report: result.reportPath,
    runId: result.report.runId,
    status: result.report.status,
    workerHarnessPassed: result.report.workerHarnessPassed,
    storageHarnessPassed: result.report.storageHarnessPassed,
    lifecycleHarnessPassed: result.report.lifecycleHarnessPassed,
    harnessPassed: result.report.harnessPassed,
    phase9RollbackDrillsPassed: result.report.phase9RollbackDrillsPassed,
    cleanupComplete: result.report.cleanup?.summary?.complete === true,
    failureReasons: result.report.failureReasons,
  }, null, 2)}\n`);
  if (!result.report.phase9RollbackDrillsPassed) process.exitCode = 1;
}

const DIRECT_ENTRYPOINT = process.argv[1] ? path.resolve(process.argv[1]) : null;
const THIS_ENTRYPOINT = fileURLToPath(import.meta.url);
const DIRECT_EXECUTION = DIRECT_ENTRYPOINT !== null && (
  process.platform === "win32"
    ? DIRECT_ENTRYPOINT.toLowerCase() === THIS_ENTRYPOINT.toLowerCase()
    : DIRECT_ENTRYPOINT === THIS_ENTRYPOINT
);

if (DIRECT_EXECUTION) await main();
