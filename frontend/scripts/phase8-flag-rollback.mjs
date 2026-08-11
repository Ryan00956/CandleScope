import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PHASE8_FLAG_ROLLBACK_SCHEMA = "candlescope.multi-chart.phase8-flag-rollback/1";
export const PHASE8_ROLLBACK_STAGES = Object.freeze(["64", "16", "4"]);

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function check(actual, expected, passed) {
  return { actual, expected, passed };
}

export function evaluatePhase8FlagRollback(stages) {
  const stage64 = stages["64"];
  const stage16 = stages["16"];
  const stage4 = stages["4"];
  const ordered = [stage64, stage16, stage4];
  const v6Hashes = ordered.map((stage) => stage?.storage?.v6?.documentSha256 ?? null);
  const v6ContentHashes = ordered.map(
    (stage) => stage?.storage?.v6?.documentContentSha256 ?? null,
  );
  const v5Hashes = ordered.map((stage) => stage?.storage?.v5?.sentinelSha256 ?? null);
  const v5LocalHashes = ordered.map((stage) => stage?.storage?.v5?.localSentinelSha256 ?? null);
  const userDataPaths = ordered.map((stage) => stage?.userData ?? null);
  const checks = {
    stageResults: check(
      ordered.map((stage) => stage?.result ?? null),
      ["pass", "pass", "pass"],
      ordered.every((stage) => stage?.result === "pass"),
    ),
    exactProjections: check(
      ordered.map((stage) => ({
        stage: stage?.stage,
        nativeWindows: stage?.windows?.length,
        visibleCells: stage?.windows?.map((window) => window.renderer?.chartRoots),
      })),
      [
        { stage: "64", nativeWindows: 4, visibleCells: [16, 16, 16, 16] },
        { stage: "16", nativeWindows: 1, visibleCells: [16] },
        { stage: "4", nativeWindows: 1, visibleCells: [4] },
      ],
      stage64?.windows?.length === 4
        && stage64.windows.every((window) => window.renderer?.chartRoots === 16)
        && stage16?.windows?.length === 1
        && stage16.windows[0]?.renderer?.chartRoots === 16
        && stage4?.windows?.length === 1
        && stage4.windows[0]?.renderer?.chartRoots === 4,
    ),
    exactBuildLayers: check(
      ordered.map((stage) => stage?.build),
      "64 has all flags, 16 retains only multi-chart/broker/batch, 4 disables all capacity flags",
      stage64?.build?.multiChart16Enabled === true
        && stage64?.build?.multiWindowEnabled === true
        && stage64?.build?.multiChart64Enabled === true
        && stage16?.build?.multiChart16Enabled === true
        && stage16?.build?.multiWindowEnabled === false
        && stage16?.build?.multiChart64Enabled === false
        && stage4?.build?.multiChart16Enabled === false
        && stage4?.build?.multiWindowEnabled === false
        && stage4?.build?.multiChart64Enabled === false
        && stage4?.build?.chartWindowBrokerEnabled === false
        && stage4?.build?.klineBatchEnabled === false,
    ),
    sameChromiumProfile: check(
      userDataPaths,
      "one non-empty user-data path reused by all three production builds",
      userDataPaths[0] && new Set(userDataPaths).size === 1,
    ),
    v6DocumentPreserved: check(
      ordered.map((stage) => ({
        sha256: stage?.storage?.v6?.documentSha256,
        contentSha256: stage?.storage?.v6?.documentContentSha256,
        cells: stage?.storage?.v6?.cellCount,
        windows: stage?.storage?.v6?.windowCount,
        revision: stage?.storage?.v6?.revision,
      })),
      "identical v6 content SHA-256 with 64 cells/4 windows; lower layers have exact raw SHA and shutdown recovery advances revision by at most one",
      Boolean(v6ContentHashes[0])
        && new Set(v6ContentHashes).size === 1
        && Boolean(v6Hashes[1])
        && v6Hashes[1] === v6Hashes[2]
        && Number.isSafeInteger(stage64?.storage?.v6?.revision)
        && Number.isSafeInteger(stage16?.storage?.v6?.revision)
        && stage16.storage.v6.revision >= stage64.storage.v6.revision
        && stage16.storage.v6.revision <= stage64.storage.v6.revision + 1
        && stage4?.storage?.v6?.revision === stage16.storage.v6.revision
        && ordered.every((stage) => (
          stage?.storage?.v6?.cellCount === 64 && stage?.storage?.v6?.windowCount === 4
        )),
    ),
    v5SentinelPreserved: check(
      { indexedDb: v5Hashes, localStorage: v5LocalHashes },
      "identical non-null v5 sentinel SHA-256 in IndexedDB and localStorage",
      Boolean(v5Hashes[0])
        && Boolean(v5LocalHashes[0])
        && new Set(v5Hashes).size === 1
        && new Set(v5LocalHashes).size === 1,
    ),
    zeroRuntimeErrors: check(
      ordered.map((stage) => stage?.runtimeErrors ?? null),
      [[], [], []],
      ordered.every((stage) => Array.isArray(stage?.runtimeErrors) && stage.runtimeErrors.length === 0),
    ),
  };
  return { checks, result: Object.values(checks).every((entry) => entry.passed) ? "pass" : "fail" };
}

function parseArgs(argv) {
  const args = {};
  const next = (index, name) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--stage64") args.stage64 = next(index++, value);
    else if (value === "--stage16") args.stage16 = next(index++, value);
    else if (value === "--stage4") args.stage4 = next(index++, value);
    else if (value === "--out") args.out = next(index++, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  for (const name of ["stage64", "stage16", "stage4", "out"]) {
    if (!args[name]) throw new Error(`missing --${name}`);
  }
  return args;
}

export function run(argv) {
  const args = parseArgs(argv);
  const sources = Object.fromEntries(PHASE8_ROLLBACK_STAGES.map((stage) => {
    const key = `stage${stage}`;
    const resolved = path.resolve(args[key]);
    return [stage, { path: resolved, sha256: sha256File(resolved) }];
  }));
  const stages = Object.fromEntries(Object.entries(sources).map(([stage, source]) => [
    stage,
    JSON.parse(fs.readFileSync(source.path, "utf8")),
  ]));
  const evaluation = evaluatePhase8FlagRollback(stages);
  const evidence = {
    schemaVersion: PHASE8_FLAG_ROLLBACK_SCHEMA,
    generatedAt: new Date().toISOString(),
    sequence: PHASE8_ROLLBACK_STAGES,
    methodology: "Three production builds reuse one Electron Chromium profile and origin; no profile reset is allowed between stages.",
    sources,
    stages: Object.fromEntries(Object.entries(stages).map(([stage, evidence]) => [stage, {
      result: evidence.result,
      build: evidence.build,
      userData: evidence.userData,
      nativeWindows: evidence.windows?.length,
      visibleCells: evidence.windows?.map((window) => window.renderer?.chartRoots),
      storage: evidence.storage,
      runtimeErrors: evidence.runtimeErrors,
    }])),
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
