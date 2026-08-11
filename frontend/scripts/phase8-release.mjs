import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PHASE8_RELEASE_SCHEMA = "candlescope.multi-chart.phase8-release/1";

function sha256(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function allBooleanLeavesTrue(value) {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return false;
  const leaves = Object.values(value);
  return leaves.length > 0 && leaves.every(allBooleanLeavesTrue);
}

function finalW3Identity(evidence) {
  const sample = evidence?.samples?.at?.(-1);
  return evidence?.result === "pass"
    && evidence?.mode === "W3"
    && evidence?.analysis?.result === "pass"
    && sample?.windows?.length === 4
    && sample.windows.every((window) => (
      window.renderer?.chartRoots === 16
      && window.renderer?.dataReadyRoots === 16
      && window.renderer?.indicators?.runtimeCount === 16
      && window.renderer?.indicators?.definitionCount === 32
    ));
}

export function evaluatePhase8Release(inputs) {
  const checks = {
    phase7W1W2: inputs.phase7?.result === "pass",
    w3: finalW3Identity(inputs.w3),
    soak4h: inputs.soak?.result === "pass"
      && inputs.soak?.analysis?.result === "pass"
      && Number(inputs.soak?.analysis?.measurements?.durationMs) >= 14_400_000,
    f1: inputs.f1?.result === "pass" && allBooleanLeavesTrue(inputs.f1?.gates),
    f2: inputs.f2?.result === "pass" && allBooleanLeavesTrue(inputs.f2?.gates),
    f3Implementation: allBooleanLeavesTrue(inputs.f3?.gates?.implementation),
    f3Physical: inputs.f3?.result === "pass" && allBooleanLeavesTrue(inputs.f3?.gates?.physical),
    rollback: inputs.rollback?.result === "pass",
    package: inputs.package?.result === "pass",
    fullValidation: inputs.validation?.result === "pass",
    independentReleaseReview: inputs.independentReleaseReview === true,
  };
  const implementationChecks = Object.entries(checks)
    .filter(([name]) => !["f3Physical", "independentReleaseReview"].includes(name));
  const implementationPass = implementationChecks.every(([, passed]) => passed);
  const releaseReady = Object.values(checks).every(Boolean);
  return {
    checks,
    implementationPass,
    releaseReady,
    result: releaseReady
      ? "pass"
      : implementationPass
        ? "implementation-pass-hardware-and-review-pending"
        : "fail",
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new TypeError("Expected paired --name path arguments");
    args[name.slice(2)] = value;
  }
  const required = ["phase7", "w3", "soak", "f1", "f2", "f3", "rollback", "package", "validation", "out"];
  for (const name of required) if (!args[name]) throw new TypeError(`Missing --${name}`);
  return args;
}

export function run(argv) {
  const args = parseArgs(argv);
  const names = ["phase7", "w3", "soak", "f1", "f2", "f3", "rollback", "package", "validation"];
  const paths = Object.fromEntries(names.map((name) => [name, path.resolve(args[name])]));
  const inputs = Object.fromEntries(names.map((name) => [name, JSON.parse(fs.readFileSync(paths[name], "utf8"))]));
  inputs.independentReleaseReview = process.env.CANDLESCOPE_PHASE8_RELEASE_REVIEWED === "1";
  const evaluation = evaluatePhase8Release(inputs);
  const evidence = {
    schemaVersion: PHASE8_RELEASE_SCHEMA,
    generatedAt: new Date().toISOString(),
    scope: "four-native-windows-sixteen-charts-each",
    promotionStatus: evaluation.releaseReady ? "eligible" : "blocked",
    defaultFlags: {
      multiChart16: "off",
      multiWindow: "off",
      multiChart64: "off",
      chartWindowBroker: "off",
      klineBatch: "off",
    },
    host: {
      displayCount: inputs.f3?.environment?.displayCount ?? null,
      electron: inputs.w3?.environment?.electron ?? null,
      chrome: inputs.w3?.environment?.chrome ?? null,
      node: inputs.w3?.environment?.node ?? null,
    },
    sources: Object.fromEntries(names.map((name) => [name, { path: paths[name], sha256: sha256(paths[name]) }])),
    ...evaluation,
    blockers: [
      ...(evaluation.checks.f3Physical ? [] : ["physical-four-display-unplug-and-mixed-dpi-gate"]),
      ...(evaluation.checks.independentReleaseReview ? [] : ["independent-release-review"]),
    ],
    limitations: [
      "Validated capacity scope is Binance Spot USDT 1m with local builtin MA20 and RSI14.",
      "Hosted, community, and Pyne indicators are not covered by the 64-chart capacity claim.",
      "The current host exposes one logical display; four physical displays remain unvalidated.",
      "The unpacked Windows validation candidate is not an installer or published signed release.",
    ],
  };
  const out = path.resolve(args.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`PHASE8_RELEASE_${evidence.result.toUpperCase().replaceAll("-", "_")} ${out}\n`);
  return evidence.result === "fail" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
