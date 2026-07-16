#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DRAWING_ROLLBACK_DRILL_IDS } from "./drawing-rollback-drills.mjs";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "phase9-rollback-drills");
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

const CONTROLLED_DRILL_PLAN = Object.freeze([
  Object.freeze({ id: "worker-init-failure", producer: "worker" }),
  Object.freeze({ id: "offscreen-canvas-unsupported", producer: "worker" }),
  Object.freeze({ id: "indexeddb-quota-blocked", producer: "storage" }),
  Object.freeze({ id: "worker-stale-generation", producer: "worker" }),
  Object.freeze({ id: "active-gesture-chart-boundary", producer: "lifecycle" }),
  Object.freeze({ id: "series-rebuild-before-export", producer: "lifecycle" }),
  Object.freeze({ id: "continuous-dpr-resize", producer: "lifecycle" }),
  Object.freeze({ id: "canary-to-legacy-snapshot", producer: "storage" }),
]);

function usage() {
  return [
    "Phase 9 controlled headed-browser rollback drills",
    "",
    "Usage: powershell.exe -NoProfile -File scripts/drawing-rollback-drills-browser.ps1 [options]",
    "",
    "Options:",
    "  --chrome <path>       Chrome/Edge executable (auto-detected by default)",
    "  --timeout-ms <n>      Per-stage timeout (default 45000)",
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
  if (typeof value !== "string" || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return { value, index: inline ? index : index + 1 };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

function parseArgs(argv) {
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
    if (name !== "--chrome" && name !== "--timeout-ms" && name !== "--out-dir") {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (seen.has(name)) throw new Error(`duplicate option: ${name}`);
    seen.add(name);
    const resolved = optionValue(argv, index, name);
    index = resolved.index;
    if (!resolved.value) throw new Error(`${name} requires a value`);
    if (name === "--chrome") args.chromePath = path.resolve(resolved.value);
    else if (name === "--timeout-ms") {
      args.timeoutMs = positiveInteger(resolved.value, name);
    } else {
      args.outputRoot = path.resolve(resolved.value);
    }
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

function writeNotImplementedPartial(args) {
  const startedAt = new Date().toISOString();
  const runId = `phase9-${Date.now()}-${crypto.randomUUID()}`;
  const runDirectory = path.join(args.outputRoot, runId);
  const reportPath = path.join(runDirectory, "controlled-run.partial.json");
  const planValid = validateFixedPlan();
  const report = {
    schemaVersion: "drawing-rollback-controlled-run-partial/v1",
    status: "partial",
    phase9RollbackDrillsPassed: false,
    harnessPassed: false,
    runId,
    sourceRevision: gitRevision(),
    startedAt,
    updatedAt: new Date().toISOString(),
    configuration: {
      headed: true,
      externalArtifactsAccepted: false,
      externalCdpAccepted: false,
      allowIncomplete: false,
      timeoutMs: args.timeoutMs,
      chromePathConfigured: args.chromePath.length > 0,
    },
    lifecycle: {
      buildStarted: false,
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
    failureReasons: [
      ...(!planValid ? ["controlled-browser-drill-plan-invalid"] : []),
      "controlled-browser-drill-producers-not-implemented",
    ],
  };
  atomicWriteJson(reportPath, report);
  return Object.freeze({ reportPath, report });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { reportPath, report } = writeNotImplementedPartial(args);
  process.stdout.write(`${JSON.stringify({
    report: reportPath,
    status: report.status,
    phase9RollbackDrillsPassed: false,
    failureReasons: report.failureReasons,
  }, null, 2)}\n`);
  process.exitCode = 1;
}

main();
