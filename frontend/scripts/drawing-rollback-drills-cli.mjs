import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  DRAWING_ROLLBACK_DRILL_IDS,
  DRAWING_ROLLBACK_DRILL_MANIFEST,
  appendNodeTestTapTail,
  assessDrawingRollbackDrills,
  parseNodeTestTapPassCount,
} from "./drawing-rollback-drills.mjs";

const DEFAULT_OUTPUT_LIMIT = 4_000;
const TAP_SUMMARY_TAIL_LIMIT = 16_000;

function usage() {
  return [
    "Usage: node scripts/drawing-rollback-drills-cli.mjs [options]",
    "",
    "Options:",
    "  --artifact <drill-id>=<json>  Supply a dedicated browser drill artifact (repeatable)",
    "  --phase6-report <json>         Supply the formal Phase 6 stale-generation report",
    "  --run-component-tests          Execute mapped component tests as partial evidence",
    "  --allow-incomplete             Exit zero for missing browser artifacts only",
    "  --out <json>                   Write the aggregate report",
    "  --help                         Show this help",
    "",
    "Strict default: all eight browser drills must pass. Component tests never close a drill.",
    "With npm run, use --phase6-report=<path> and --out=<path>; npm forwards them as config env.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    artifacts: new Map(),
    runComponentTests: false,
    allowIncomplete: false,
    out: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact" || argument.startsWith("--artifact=")) {
      const assignment = argument === "--artifact"
        ? argv[++index]
        : argument.slice("--artifact=".length);
      const separator = assignment?.indexOf("=") ?? -1;
      if (separator <= 0 || separator === assignment.length - 1) {
        throw new Error("--artifact must be <drill-id>=<json-path>");
      }
      const drillId = assignment.slice(0, separator);
      const artifactPath = assignment.slice(separator + 1);
      if (!DRAWING_ROLLBACK_DRILL_IDS.includes(drillId)) {
        throw new Error(`unknown rollback drill id: ${drillId}`);
      }
      if (args.artifacts.has(drillId)) throw new Error(`duplicate artifact for ${drillId}`);
      args.artifacts.set(drillId, artifactPath);
    } else if (argument === "--phase6-report" || argument.startsWith("--phase6-report=")) {
      const artifactPath = argument === "--phase6-report"
        ? argv[++index]
        : argument.slice("--phase6-report=".length);
      if (!artifactPath) throw new Error("--phase6-report requires a JSON path");
      if (args.artifacts.has("worker-stale-generation")) {
        throw new Error("duplicate artifact for worker-stale-generation");
      }
      args.artifacts.set("worker-stale-generation", artifactPath);
    } else if (argument === "--run-component-tests") {
      args.runComponentTests = true;
    } else if (argument === "--allow-incomplete") {
      args.allowIncomplete = true;
    } else if (argument === "--out" || argument.startsWith("--out=")) {
      args.out = argument === "--out" ? (argv[++index] ?? null) : argument.slice("--out=".length);
      if (!args.out) throw new Error("--out requires a JSON path");
    } else if (argument === "--help" || argument === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const npmPhase6Report = process.env.DRAWING_ROLLBACK_PHASE6_REPORT
    || process.env.npm_config_phase6_report;
  if (npmPhase6Report && !args.artifacts.has("worker-stale-generation")) {
    args.artifacts.set("worker-stale-generation", npmPhase6Report);
  }
  if (!args.out) args.out = process.env.DRAWING_ROLLBACK_OUT || process.env.npm_config_out || null;

  return args;
}

function readArtifact(filePath) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const source = fs.readFileSync(resolvedPath, "utf8");
  return {
    path: resolvedPath,
    artifact: JSON.parse(source),
  };
}

function appendLimited(chunks, value) {
  const currentLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (currentLength >= DEFAULT_OUTPUT_LIMIT) return;
  chunks.push(String(value).slice(0, DEFAULT_OUTPUT_LIMIT - currentLength));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const stdout = [];
    const stderr = [];
    let stdoutTail = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      appendLimited(stdout, chunk);
      stdoutTail = appendNodeTestTapTail(stdoutTail, chunk, TAP_SUMMARY_TAIL_LIMIT);
    });
    child.stderr.on("data", (chunk) => appendLimited(stderr, chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({
        exitCode: code,
        signal,
        durationMs: Date.now() - startedAt,
        stdout: stdout.join(""),
        stdoutTail,
        stderr: stderr.join(""),
      });
    });
  });
}

async function collectComponentEvidence() {
  const frontendRoot = path.resolve(process.cwd());
  const tsxCli = path.join(frontendRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    throw new Error(`tsx CLI not found: ${tsxCli}`);
  }

  const evidence = {};
  for (const drill of DRAWING_ROLLBACK_DRILL_MANIFEST) {
    const files = drill.componentTest.files.map((file) => path.resolve(frontendRoot, file));
    const processArgs = [
      tsxCli,
      "--test",
      "--test-name-pattern",
      drill.componentTest.pattern,
      ...files,
    ];
    const command = [process.execPath, ...processArgs].join(" ");
    const result = await runProcess(process.execPath, processArgs, { cwd: frontendRoot });
    const passCount = parseNodeTestTapPassCount(result.stdoutTail);
    evidence[drill.id] = {
      passed: result.exitCode === 0
        && result.signal === null
        && passCount !== null
        && passCount >= drill.componentTest.minimumPassCount,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      command,
      passCount,
      minimumPassCount: drill.componentTest.minimumPassCount,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return evidence;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const artifacts = {};
  const artifactPaths = {};
  const artifactReadErrors = [];
  for (const [drillId, artifactPath] of args.artifacts) {
    try {
      const loaded = readArtifact(artifactPath);
      artifacts[drillId] = loaded.artifact;
      artifactPaths[drillId] = loaded.path;
    } catch (error) {
      artifactReadErrors.push({
        drillId,
        path: path.resolve(process.cwd(), artifactPath),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const componentEvidence = args.runComponentTests
    ? await collectComponentEvidence()
    : {};
  const assessment = assessDrawingRollbackDrills({ artifacts, componentEvidence });
  const componentFailureCount = Object.values(componentEvidence).filter(
    (evidence) => evidence.passed !== true,
  ).length;
  const harnessPassed = artifactReadErrors.length === 0
    && componentFailureCount === 0
    && assessment.invalidArtifactCount === 0;
  const report = {
    schemaVersion: "drawing-rollback-drill-run/v1",
    generatedAt: new Date().toISOString(),
    configuration: {
      runComponentTests: args.runComponentTests,
      allowIncomplete: args.allowIncomplete,
      strictBrowserClosure: true,
    },
    artifactPaths,
    artifactReadErrors,
    componentEvidence,
    assessment,
    harnessPassed,
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  console.log(serialized.trimEnd());
  if (args.out) {
    const outputPath = path.resolve(process.cwd(), args.out);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized, "utf8");
  }

  const incompleteAllowed = args.allowIncomplete
    && assessment.invalidArtifactCount === 0
    && harnessPassed;
  if (!assessment.phase9RollbackDrillsPassed && !incompleteAllowed) process.exitCode = 1;
  if (!harnessPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
