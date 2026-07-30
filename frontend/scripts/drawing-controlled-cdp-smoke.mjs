#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startControlledProductionCdp } from "./drawing-controlled-cdp.mjs";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "phase9-controlled-smoke");
const FIXED_CONFIGURATION = Object.freeze({
  dpr: 1,
  engineMode: "scene-canary",
  interactionSurfaceMode: "overlay",
  rasterBackend: "worker",
  viewport: Object.freeze({ width: 1440, height: 900 }),
});
const DRAWING_RENDER_STAMP_KEYS = Object.freeze([
  "scopeKey",
  "documentRevision",
  "surfaceGeneration",
  "dataRevision",
  "projectionRevision",
  "lineageIndexRevision",
  "viewportRevision",
  "themeRevision",
  "widthCssPx",
  "heightCssPx",
  "dpr",
]);
const DRAWING_RENDER_REVISION_KEYS = Object.freeze([
  "documentRevision",
  "surfaceGeneration",
  "dataRevision",
  "projectionRevision",
  "lineageIndexRevision",
  "viewportRevision",
  "themeRevision",
]);

function usage() {
  return [
    "Phase 9 controlled production/headed CDP smoke",
    "",
    "Usage: powershell.exe -NoProfile -File scripts/drawing-controlled-cdp-smoke.ps1 [options]",
    "",
    "Options:",
    "  --chrome <path>       Chrome/Edge executable (auto-detected by default)",
    "  --timeout-ms <n>      Per-stage timeout, 1000..600000 (default 45000)",
    "  --out-dir <path>      Parent directory for the unique smoke receipt",
    "  --help                Show this help",
    "",
    "The smoke always owns its production build, servers, visible browser, CDP session,",
    "temporary profile, and cleanup proof. It accepts no external server/CDP/transport,",
    "headless mode, scenario module, fixture, artifact, or allow-incomplete override.",
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

function parseArgs(argv) {
  const parsed = { chromePath: "", timeoutMs: 45_000, outputRoot: DEFAULT_OUTPUT_ROOT, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = optionName(argument);
    if (name === "--help" || name === "-h") {
      parsed.help = true;
      continue;
    }
    if (!["--chrome", "--timeout-ms", "--out-dir"].includes(name)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (seen.has(name)) throw new Error(`duplicate option: ${name}`);
    seen.add(name);
    const resolved = optionValue(argv, index, name);
    index = resolved.index;
    if (name === "--chrome") parsed.chromePath = path.resolve(resolved.value);
    else if (name === "--out-dir") parsed.outputRoot = path.resolve(resolved.value);
    else {
      const timeoutMs = Number(resolved.value);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
        throw new TypeError("--timeout-ms must be an integer between 1000 and 600000");
      }
      parsed.timeoutMs = timeoutMs;
    }
  }
  return Object.freeze(parsed);
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
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

function validDrawingRenderStamp(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.scopeKey !== "string" || !value.scopeKey) return false;
  return DRAWING_RENDER_REVISION_KEYS.every((key) => (
    Number.isSafeInteger(value[key]) && value[key] >= 0
  ))
    && ["widthCssPx", "heightCssPx", "dpr"].every((key) => (
      Number.isFinite(value[key]) && value[key] > 0
    ));
}

function sameDrawingRenderStamp(left, right) {
  return validDrawingRenderStamp(left)
    && validDrawingRenderStamp(right)
    && DRAWING_RENDER_STAMP_KEYS.every((key) => left[key] === right[key]);
}

function validWorkerIdentity(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Number.isSafeInteger(value.schemaVersion)
    && value.schemaVersion > 0
    && Number.isSafeInteger(value.jobId)
    && value.jobId > 0
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && validDrawingRenderStamp(value.stamp);
}

function sameWorkerIdentity(left, right) {
  return validWorkerIdentity(left)
    && validWorkerIdentity(right)
    && left.schemaVersion === right.schemaVersion
    && left.jobId === right.jobId
    && left.generation === right.generation
    && sameDrawingRenderStamp(left.stamp, right.stamp);
}

export function assessDrawingWorkerRuntimeEvidence(runtime) {
  const failures = [];
  const require = (condition, failure) => {
    if (!condition) failures.push(failure);
  };
  const workerJobs = runtime?.workerJobDelta;
  const workerResults = runtime?.workerResultDelta;
  const latestSubmitted = runtime?.latestSubmittedWorkerIdentity ?? null;
  const accepted = runtime?.acceptedWorkerIdentity ?? null;
  const published = runtime?.publishedWorkerIdentity ?? null;
  const submitted = runtime?.submittedWorkerHeaders;

  require(runtime && typeof runtime === "object" && !Array.isArray(runtime), "runtime-missing");
  require(runtime?.engineMode === "scene-canary", "engine-mode-not-scene-canary");
  require(runtime?.scenePublicationReady === true, "scene-publication-not-ready");
  require(runtime?.attachedPrimitiveCount === 1, "composite-primitive-count-invalid");
  require(runtime?.backend === "worker", "worker-backend-not-active");
  require(runtime?.offscreenSupported === true, "offscreen-canvas-not-active");
  require(Number.isSafeInteger(workerJobs) && workerJobs > 0, "worker-job-not-observed");
  require(
    Number.isSafeInteger(workerResults)
      && workerResults > 0
      && Number.isSafeInteger(workerJobs)
      && workerResults <= workerJobs,
    "worker-result-not-observed",
  );
  require(runtime?.queueDepthCurrent === 0, "worker-queue-not-drained");
  require(runtime?.inFlightCurrent === 0, "worker-job-still-in-flight");
  require(runtime?.stalePublishCount === 0, "stale-worker-result-published");
  require(runtime?.sceneFallbackCount === 0, "scene-fallback-observed");
  require(runtime?.sceneRuntimeFaultCount === 0, "scene-runtime-fault-observed");
  require(runtime?.legacyFallbackSucceededCount === 0, "legacy-fallback-observed");
  require(runtime?.sceneFallbackLastReason === null, "scene-fallback-reason-present");
  require(validWorkerIdentity(latestSubmitted), "latest-worker-job-identity-invalid");
  require(Array.isArray(submitted) && submitted.some((identity) => (
    sameWorkerIdentity(identity, latestSubmitted)
  )), "latest-worker-job-not-in-submitted-history");
  require(sameWorkerIdentity(accepted, latestSubmitted), "accepted-worker-identity-not-latest");
  require(sameWorkerIdentity(published, latestSubmitted), "published-worker-identity-not-latest");
  require(
    sameDrawingRenderStamp(runtime?.lastRequestedStamp, latestSubmitted?.stamp),
    "requested-stamp-not-latest-worker-job",
  );
  require(
    sameDrawingRenderStamp(runtime?.lastPublishedStamp, latestSubmitted?.stamp),
    "published-stamp-not-latest-worker-job",
  );
  require(
    sameDrawingRenderStamp(runtime?.lastPaintedStamp, latestSubmitted?.stamp),
    "painted-stamp-not-latest-worker-job",
  );
  require(
    runtime?.paintReceipt?.kind === "drawing-scene-bridge-paint-ack"
      && Number.isSafeInteger(runtime.paintReceipt.attachmentRevision)
      && runtime.paintReceipt.attachmentRevision > 0
      && Number.isSafeInteger(runtime.paintReceipt.paintSequence)
      && runtime.paintReceipt.paintSequence > 0
      && typeof runtime.paintReceipt.observedAt === "string"
      && Number.isFinite(Date.parse(runtime.paintReceipt.observedAt))
      && sameDrawingRenderStamp(runtime.paintReceipt.stamp, latestSubmitted?.stamp),
    "paint-receipt-not-latest-worker-job",
  );

  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

async function waitForDrawingWorkerRuntime(session) {
  const startedAt = Date.now();
  const timeoutMs = session.configuration.timeoutMs;
  let runtime = null;
  let assessment = assessDrawingWorkerRuntimeEvidence(runtime);
  let attempts = 0;
  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    runtime = await session.cdp.evaluateJson(`(() => {
      const handle = window.__CANDLESCOPE_DRAWING_PERF__;
      return handle && typeof handle.readPhase6Runtime === 'function'
        ? handle.readPhase6Runtime()
        : null;
    })()`);
    assessment = assessDrawingWorkerRuntimeEvidence(runtime);
    if (assessment.passed) {
      return Object.freeze({
        passed: true,
        attempts,
        elapsedMs: Date.now() - startedAt,
        observedAt: new Date().toISOString(),
        assessment,
        runtime,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Controlled smoke did not observe a completed drawing worker publication: ${JSON.stringify({
    attempts,
    elapsedMs: Date.now() - startedAt,
    assessment,
    runtime,
  })}`);
}

export async function waitForDrawingExerciseSurface(probe, {
  timeoutMs,
  pollMs = 50,
  now = Date.now,
  waitForInterval = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  const startedAt = now();
  let attempts = 0;
  let latest = null;
  let lastEvaluationError = null;
  while (now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      latest = await probe();
      lastEvaluationError = null;
    } catch (error) {
      latest = null;
      lastEvaluationError = error;
    }
    const elapsedMs = now() - startedAt;
    const diagnostic = {
      attempts,
      elapsedMs,
      latest,
      lastEvaluationError: lastEvaluationError instanceof Error
        ? lastEvaluationError.message
        : lastEvaluationError === null
          ? null
          : String(lastEvaluationError),
    };
    if (latest?.errorText) {
      throw new Error(`Controlled smoke chart entered an error state: ${JSON.stringify(diagnostic)}`);
    }
    if (latest?.ready === true && latest?.rect) {
      return Object.freeze({
        ...latest,
        attempts,
        waitedMs: elapsedMs,
      });
    }
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Controlled smoke timed out waiting for the drawing surface: ${JSON.stringify(diagnostic)}`,
      );
    }
    await waitForInterval(pollMs);
  }
  throw new Error("Controlled smoke drawing surface wait exited without a terminal result");
}

async function exerciseDrawingWorker(session) {
  const setup = await waitForDrawingExerciseSurface(
    () => session.cdp.evaluateJson(`(() => {
      const toolbar = document.querySelector('.drawing-toolbar');
      const button = document.querySelector('[data-drawing-tool="pen"]');
      const chart = document.querySelector(
        '.chart-pane[data-pane-id="main"] .chart-pane-container, .chart-pane[data-pane-id="single-chart"]'
      );
      const errorOverlay = document.querySelector('.error-overlay');
      const buttonFound = button instanceof HTMLButtonElement;
      const chartFound = chart instanceof HTMLElement;
      const rect = chartFound ? chart.getBoundingClientRect() : null;
      const toolbarState = toolbar instanceof HTMLElement
        ? toolbar.dataset.drawingToolbarState || null
        : null;
      const buttonDisabled = buttonFound ? button.disabled : null;
      const sized = Boolean(rect && rect.width > 200 && rect.height > 160);
      return {
        ready: toolbarState === 'ready' && buttonFound && !buttonDisabled && chartFound && sized,
        readyState: document.readyState,
        toolbarState,
        buttonFound,
        buttonDisabled,
        chartFound,
        chartReadyMark: Boolean(window.__CANDLESCOPE_PERF__?.report?.()?.marks?.['chart.ready']),
        errorText: errorOverlay instanceof HTMLElement
          ? errorOverlay.innerText.trim().slice(0, 1000)
          : null,
        rect: rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null
      };
    })()`),
    { timeoutMs: session.configuration.timeoutMs },
  );
  const clicked = await session.cdp.evaluate(`(() => {
    const button = document.querySelector('[data-drawing-tool="pen"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error("Controlled smoke could not click the freehand tool");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const armed = await session.cdp.evaluate(
    `Boolean(document.querySelector('[data-drawing-tool="pen"].active'))`,
  );
  if (armed !== true) throw new Error("Controlled smoke freehand tool did not become active");
  const start = {
    x: Math.round(setup.rect.x + setup.rect.width * 0.35),
    y: Math.round(setup.rect.y + setup.rect.height * 0.45),
  };
  const end = {
    x: Math.round(setup.rect.x + setup.rect.width * 0.58),
    y: Math.round(setup.rect.y + setup.rect.height * 0.38),
  };
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 8; step += 1) {
    await session.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(start.x + ((end.x - start.x) * step) / 8),
      y: Math.round(start.y + ((end.y - start.y) * step) / 8),
      button: "none",
      buttons: 1,
    });
  }
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  const runtimeEvidence = await waitForDrawingWorkerRuntime(session);
  const build = await session.readBrowserBuildEvidence();
  const drawingTargets = build.networkAssets?.workerTargets?.filter((target) => (
    target.type === "worker" && target.path === build.networkAssets.expectedDrawingWorkerPaths?.[0]
  )) ?? [];
  const passed = build.authoritative === true
    && runtimeEvidence.passed === true
    && build.networkAssets?.drawingWorkerTargetCount >= 1
    && drawingTargets.every((target) => (
      target.active === true
      && target.constructorProvenanceAccepted === true
      && target.networkProvenanceAccepted === true
      && target.assetAccepted === true
    ));
  if (!passed) {
    throw new Error(`Controlled smoke did not prove the drawing worker path: ${JSON.stringify({
      setup,
      runtimeEvidence,
      networkAssets: build.networkAssets,
    })}`);
  }
  return Object.freeze({
    setup,
    armed,
    start,
    end,
    drawingTargets: Object.freeze(drawingTargets),
    runtimeEvidence,
    build,
  });
}

async function runSmoke(args) {
  const receiptId = `controlled-smoke-${Date.now()}-${crypto.randomUUID()}`;
  const receiptPath = path.join(args.outputRoot, receiptId, "receipt.json");
  const startedAt = new Date().toISOString();
  let session = null;
  let cleanup = null;
  let evidence = null;
  let failure = null;
  try {
    session = await startControlledProductionCdp({
      ...FIXED_CONFIGURATION,
      chromePath: args.chromePath,
      timeoutMs: args.timeoutMs,
    });
    const window = await session.verifyWindow();
    const workerExercise = await exerciseDrawingWorker(session);
    const authoritativeState = await session.settleAuthoritativeState();
    const build = workerExercise.build;
    const diagnostics = session.diagnostics();
    const lifecycle = session.lifecycle();
    const failures = diagnosticFailures(diagnostics);
    if (build.authoritative !== true) failures.push("production-build-not-authoritative");
    if (window.headed !== true || window.windowState !== "normal"
      || window.visibilityState !== "visible" || window.hasFocus !== true) {
      failures.push("headed-window-evidence-invalid");
    }
    if (failures.length > 0) throw new Error(`Controlled smoke evidence failed: ${failures.join(",")}`);
    evidence = Object.freeze({
      window,
      workerExercise,
      authoritativeState,
      build,
      diagnostics,
      lifecycle,
      failures: Object.freeze(failures),
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    cleanup = error?.cleanup ?? null;
  } finally {
    if (session) {
      try { cleanup = await session.close(); } catch (error) {
        failure = `${failure ? `${failure}; ` : ""}close:${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const finalDiagnosticFailures = diagnosticFailures({
    pageAndWorker: cleanup?.finalDiagnostics ?? null,
    workers: cleanup?.finalWorkerDiagnostics ?? null,
    originGuard: cleanup?.finalOriginGuard ?? null,
    cdpHandlers: cleanup?.browser?.handlerSettlementAfterClose ?? null,
  });
  const passed = failure === null
    && evidence !== null
    && cleanup?.summary?.complete === true
    && finalDiagnosticFailures.length === 0;
  const receipt = Object.freeze({
    schemaVersion: "candlescope-controlled-cdp-smoke/v1",
    receiptId,
    runId: session?.runId ?? cleanup?.runId ?? null,
    startedAt,
    completedAt: new Date().toISOString(),
    passed,
    fixedConfiguration: FIXED_CONFIGURATION,
    sourceRevision: session?.buildReceipt?.git?.commit ?? null,
    buildFingerprint: session?.buildReceipt?.buildFingerprint ?? null,
    toolchain: session?.buildReceipt?.toolchain ?? null,
    evidence,
    cleanup,
    finalDiagnosticFailures: Object.freeze(finalDiagnosticFailures),
    failure,
  });
  atomicWriteJson(receiptPath, receipt);
  return Object.freeze({ receiptPath, receipt });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runSmoke(args);
  process.stdout.write(`${JSON.stringify({
    receipt: result.receiptPath,
    runId: result.receipt.runId,
    passed: result.receipt.passed,
    failure: result.receipt.failure,
    cleanupComplete: result.receipt.cleanup?.summary?.complete === true,
  }, null, 2)}\n`);
  if (!result.receipt.passed) process.exitCode = 1;
}

const DIRECT_ENTRYPOINT = process.argv[1] ? path.resolve(process.argv[1]) : null;
const THIS_ENTRYPOINT = fileURLToPath(import.meta.url);
const DIRECT_EXECUTION = DIRECT_ENTRYPOINT !== null && (
  process.platform === "win32"
    ? DIRECT_ENTRYPOINT.toLowerCase() === THIS_ENTRYPOINT.toLowerCase()
    : DIRECT_ENTRYPOINT === THIS_ENTRYPOINT
);
if (DIRECT_EXECUTION) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
