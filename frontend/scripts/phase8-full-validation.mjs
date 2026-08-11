import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PHASE8_VALIDATION_SCHEMA = "candlescope.multi-chart.phase8-full-validation/1";

export function evaluateValidationSteps(steps) {
  const required = [
    "architecture",
    "plugins",
    "typecheck",
    "lint",
    "frontend-tests",
    "desktop-tests",
    "frontend-build",
    "backend-tests",
  ];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const passed = (step) => step?.exitCode === 0 || step?.acceptedBaseline === true;
  return {
    required,
    passed: required.every((id) => passed(byId.get(id))),
    missing: required.filter((id) => !byId.has(id)),
    failed: required.filter((id) => byId.has(id) && !passed(byId.get(id))),
  };
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function xmlAttribute(source, name) {
  const match = source.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXmlAttribute(match[1]) : null;
}

export function analyzeBackendJUnit(xml, baseline) {
  const suite = xml.match(/<testsuite\b([^>]*)>/);
  if (!suite) {
    throw new TypeError("pytest JUnit report has no testsuite");
  }
  const summary = Object.fromEntries(
    ["tests", "failures", "errors", "skipped"].map((key) => [
      key,
      Number(xmlAttribute(suite[1], key) ?? Number.NaN),
    ]),
  );
  if (Object.values(summary).some((value) => !Number.isInteger(value) || value < 0)) {
    throw new TypeError("pytest JUnit report has invalid summary counts");
  }

  const nonPassing = [];
  // Pytest emits passing cases as self-closing <testcase ... /> elements.
  // Exclude those here; otherwise a regex can start at a passing element and
  // consume through the next failing case, assigning the failure to the wrong
  // node id.
  const testcases = xml.matchAll(
    /<testcase\b([^>]*?)(?<!\/)>([\s\S]*?)<\/testcase>/g,
  );
  for (const match of testcases) {
    const body = match[2];
    const kind = /<error\b/.test(body) ? "error" : /<failure\b/.test(body) ? "failure" : null;
    if (!kind) continue;
    const classname = xmlAttribute(match[1], "classname");
    const name = xmlAttribute(match[1], "name");
    if (!classname || !name) {
      throw new TypeError("non-passing pytest testcase has no identity");
    }
    nonPassing.push({
      kind,
      nodeId: `${classname.replaceAll(".", "/")}.py::${name}`,
    });
  }

  const allowed = new Set(baseline.nodeIds);
  const actual = [...new Set(nonPassing.map((item) => item.nodeId))].sort();
  const unexpected = actual.filter((nodeId) => !allowed.has(nodeId));
  const resolved = baseline.nodeIds.filter((nodeId) => !actual.includes(nodeId));
  const accepted =
    summary.tests >= baseline.minimumCollected
    && summary.failures <= baseline.expected.failures
    && summary.errors <= baseline.expected.errors
    && summary.failures + summary.errors === nonPassing.length
    && unexpected.length === 0;
  return {
    accepted,
    summary,
    actualNodeIds: actual,
    unexpectedNodeIds: unexpected,
    resolvedNodeIds: resolved,
    baseline: {
      capturedFrom: baseline.capturedFrom,
      sourceEvidence: baseline.sourceEvidence,
      minimumCollected: baseline.minimumCollected,
      expected: baseline.expected,
      nodeCount: baseline.nodeIds.length,
    },
  };
}

function commandForPlatform(command) {
  return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

function runStep({ id, command, args, cwd }) {
  const startedAt = new Date();
  const started = performance.now();
  const result = spawnSync(commandForPlatform(command), args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    // Node cannot execute npm.cmd directly with shell:false on the supported
    // Windows packaging host (spawnSync returns EINVAL before npm starts).
    // Every command/argument here is a fixed release-gate definition.
    shell: process.platform === "win32" && command === "npm",
  });
  return {
    id,
    command: [command, ...args],
    cwd,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    signal: result.signal ?? null,
    spawnError: result.error?.message ?? null,
  };
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--out" || !argv[1]) {
    throw new TypeError("Expected --out path");
  }
  return { out: path.resolve(argv[1]) };
}

export function run(argv) {
  const { out } = parseArgs(argv);
  const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = path.resolve(frontendRoot, "..");
  const backendBaseline = JSON.parse(
    fs.readFileSync(
      path.resolve(
        repoRoot,
        "docs/perf-baselines/multi-chart-workspace/phase8-backend-known-failures-20260807.json",
      ),
      "utf8",
    ),
  );
  const backendJUnitPath = path.resolve(path.dirname(out), "phase8-backend-full-junit-20260807.xml");
  fs.rmSync(backendJUnitPath, { force: true });
  const definitions = [
    { id: "architecture", command: "npm", args: ["run", "check:architecture"], cwd: frontendRoot },
    { id: "plugins", command: "npm", args: ["run", "check:plugins"], cwd: frontendRoot },
    { id: "typecheck", command: "npm", args: ["run", "typecheck"], cwd: frontendRoot },
    { id: "lint", command: "npm", args: ["run", "lint"], cwd: frontendRoot },
    { id: "frontend-tests", command: "npm", args: ["test"], cwd: frontendRoot },
    { id: "desktop-tests", command: "npm", args: ["run", "test:desktop"], cwd: frontendRoot },
    { id: "frontend-build", command: "npm", args: ["run", "build"], cwd: frontendRoot },
    {
      id: "backend-tests",
      command: "python",
      args: ["-m", "pytest", "backend/tests", "-q", `--junitxml=${backendJUnitPath}`],
      cwd: repoRoot,
    },
  ];
  const steps = definitions.map(runStep);
  const backendStep = steps.find((step) => step.id === "backend-tests");
  if (backendStep && fs.existsSync(backendJUnitPath)) {
    const junit = fs.readFileSync(backendJUnitPath, "utf8");
    const baselineComparison = analyzeBackendJUnit(junit, backendBaseline);
    backendStep.acceptedBaseline = baselineComparison.accepted;
    backendStep.baselineComparison = baselineComparison;
    backendStep.junit = {
      path: path.relative(repoRoot, backendJUnitPath).replaceAll(path.sep, "/"),
      sha256: createHash("sha256").update(junit).digest("hex"),
    };
  } else if (backendStep) {
    backendStep.acceptedBaseline = false;
    backendStep.baselineComparison = { accepted: false, error: "pytest JUnit report missing" };
  }
  const evaluation = evaluateValidationSteps(steps);
  const evidence = {
    schemaVersion: PHASE8_VALIDATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    scope: "frontend-backend-architecture-plugin-desktop-build",
    steps,
    evaluation,
    result: evaluation.passed ? "pass" : "fail",
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`PHASE8_FULL_VALIDATION_${evidence.result.toUpperCase()} ${out}\n`);
  return evidence.result === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
