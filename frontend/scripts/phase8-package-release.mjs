import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PHASE8_PACKAGE_SCHEMA = "candlescope.multi-chart.phase8-package/1";

function fileSha256(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function gate(actual, expected, passed) {
  return { actual, expected, passed };
}

function finalSample(evidence) {
  return evidence?.samples?.at?.(-1) ?? evidence?.samples?.[evidence.samples.length - 1] ?? null;
}

function packagedW3Identity(evidence) {
  const sample = finalSample(evidence);
  return evidence?.result === "pass"
    && evidence?.mode === "W3"
    && evidence?.environment?.packaged === true
    && sample?.windows?.length === 4
    && sample.windows.every((window) => (
      window.renderer?.chartRoots === 16
      && window.renderer?.dataReadyRoots === 16
      && window.renderer?.indicators?.runtimeCount === 16
      && window.renderer?.indicators?.definitionCount === 32
      && window.renderer?.indicators?.issueCount === 0
      && window.renderer?.broker?.klineStream?.physicalStreams === 1
      && window.renderer?.broker?.klineStream?.logicalSubscribers === 16
      && window.renderer?.broker?.klineStream?.activeLogicalSubscriptions === 16
    ))
    && sample?.backend?.klineBatch?.websocket_connections === 4
    && sample?.backend?.klineBatch?.logical_clients === 64
    && sample?.backend?.klineBatch?.logical_subscriptions === 64
    && sample?.backend?.dataManager?.activeSeries === 64
    && sample?.backend?.dataManager?.streamLeases === 64;
}

export function evaluatePhase8Package({ first, second, packageFiles }) {
  const checks = {
    firstFreshProcess: gate(first?.result, "pass with exact packaged W3 identity", packagedW3Identity(first)),
    secondFreshProcess: gate(second?.result, "pass with exact packaged W3 identity", packagedW3Identity(second)),
    independentProcesses: gate(
      {
        sidecarPids: [first?.sidecar?.pid, second?.sidecar?.pid],
        userData: [first?.environment?.userData, second?.environment?.userData],
      },
      "different sidecar PIDs and different non-empty Chromium profiles",
      Number.isSafeInteger(first?.sidecar?.pid)
        && Number.isSafeInteger(second?.sidecar?.pid)
        && first.sidecar.pid !== second.sidecar.pid
        && Boolean(first?.environment?.userData)
        && Boolean(second?.environment?.userData)
        && first.environment.userData !== second.environment.userData,
    ),
    packageContents: gate(
      packageFiles,
      "non-empty executable, app.asar, backend entry point, and plugin SDK source",
      Object.values(packageFiles).every((entry) => entry.exists === true && entry.bytes > 0),
    ),
    zeroRuntimeErrors: gate(
      [finalSample(first)?.runtimeErrors, finalSample(second)?.runtimeErrors],
      [[], []],
      [first, second].every((evidence) => (
        Array.isArray(finalSample(evidence)?.runtimeErrors)
        && finalSample(evidence).runtimeErrors.length === 0
      )),
    ),
  };
  return { checks, result: Object.values(checks).every((entry) => entry.passed) ? "pass" : "fail" };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --first, --second, --package-root, and --out");
    args[key.slice(2)] = value;
  }
  for (const name of ["first", "second", "package-root", "out"]) {
    if (!args[name]) throw new Error(`missing --${name}`);
  }
  return args;
}

function fileEvidence(filePath) {
  const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  return {
    path: filePath,
    exists,
    bytes: exists ? fs.statSync(filePath).size : 0,
    sha256: exists ? fileSha256(filePath) : null,
  };
}

export function run(argv) {
  const args = parseArgs(argv);
  const firstPath = path.resolve(args.first);
  const secondPath = path.resolve(args.second);
  const packageRoot = path.resolve(args["package-root"]);
  const first = JSON.parse(fs.readFileSync(firstPath, "utf8"));
  const second = JSON.parse(fs.readFileSync(secondPath, "utf8"));
  const packageFiles = {
    executable: fileEvidence(path.join(packageRoot, "CandleScope.exe")),
    appAsar: fileEvidence(path.join(packageRoot, "resources", "app.asar")),
    backend: fileEvidence(path.join(packageRoot, "resources", "backend", "app", "main.py")),
    pluginSdk: fileEvidence(path.join(
      packageRoot,
      "resources",
      "packages",
      "candlescope-plugin-sdk",
      "src",
      "candlescope_plugin_sdk",
      "__init__.py",
    )),
  };
  const evaluation = evaluatePhase8Package({ first, second, packageFiles });
  const evidence = {
    schemaVersion: PHASE8_PACKAGE_SCHEMA,
    generatedAt: new Date().toISOString(),
    scope: "unpacked-validation-candidate-two-fresh-processes",
    promotionStatus: "validation-only-independent-release-review-required",
    packageFiles,
    sources: {
      first: { path: firstPath, sha256: fileSha256(firstPath) },
      second: { path: secondPath, sha256: fileSha256(secondPath) },
    },
    processes: [first, second].map((processEvidence, index) => ({
      run: index + 1,
      result: processEvidence.result,
      environment: processEvidence.environment,
      sidecarPid: processEvidence.sidecar?.pid,
      readyMs: processEvidence.setup?.readyMs,
      analysis: processEvidence.analysis,
    })),
    ...evaluation,
  };
  const outputPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out: outputPath, result: evidence.result })}\n`);
  return evidence.result === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
