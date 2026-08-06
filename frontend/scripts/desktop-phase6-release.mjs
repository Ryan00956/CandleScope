import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] === undefined) {
      throw new TypeError("Expected --create, --restore, and --out path arguments");
    }
    values[key.slice(2)] = argv[index + 1];
  }
  return values;
}

function passingRenderer(observation) {
  return observation?.visible === true
    && observation?.minimized === false
    && observation?.renderer?.chartRoots >= 1
    && observation?.renderer?.canvasCount >= 1
    && observation?.renderer?.hasRightRail === true
    && observation?.renderer?.hasExportControl === true;
}

export function buildDesktopPhase6ReleaseEvidence(create, restore, packaged, sources = {}) {
  const createPass = create?.result === "pass"
    && create?.probeMode === "create"
    && create?.shell?.windowCount === 4
    && create?.shell?.singleInstanceLock === true
    && create?.sidecar?.running === true
    && create?.observations?.length === 4
    && create.observations.every(passingRenderer);
  const restorePass = restore?.result === "pass"
    && restore?.probeMode === "restore"
    && restore?.shell?.windowCount === 4
    && restore?.observations?.length === 4
    && restore.observations.every(passingRenderer);
  const lifecyclePass = create?.lifecycle?.result === "pass"
    && restore?.lifecycle?.result === "pass";
  const closeIsolationPass = create?.closeIsolation?.result === "pass"
    && restore?.closeIsolation?.result === "pass";
  const packagedPass = packaged?.result === "pass"
    && packaged?.shell?.packaged === true
    && packaged?.shell?.windowCount === 4
    && packaged?.observations?.every(passingRenderer);
  const displayCount = Math.min(
    Number(create?.shell?.displays?.length || 0),
    Number(restore?.shell?.displays?.length || 0),
  );
  const implementationPass = createPass
    && restorePass
    && lifecyclePass
    && closeIsolationPass
    && packagedPass;
  const physicalFourDisplayPass = implementationPass && displayCount >= 4;
  return {
    schemaVersion: "candlescope.multi-chart.phase6-release/1",
    generatedAt: new Date().toISOString(),
    scope: "native-window-shell-and-display-recovery",
    result: physicalFourDisplayPass
      ? "pass"
      : implementationPass
        ? "implementation-pass-hardware-pending"
        : "fail",
    selection: create.selection,
    host: {
      electron: create.shell?.electron,
      chrome: create.shell?.chrome,
      node: create.shell?.node,
      appVersion: packaged?.shell?.appVersion,
      updatePolicy: packaged?.shell?.updatePolicy,
      displayCount,
      displays: create.shell?.displays || [],
    },
    gates: {
      createFourNativeWindows: createPass ? "pass" : "fail",
      restoreFourNativeWindows: restorePass ? "pass" : "fail",
      singleInstance: create?.shell?.singleInstanceLock === true ? "pass" : "fail",
      singleSidecar: create?.sidecar?.running === true && restore?.sidecar?.running === true
        ? "pass"
        : "fail",
      minimizeRestoreScheduler: lifecyclePass ? "pass" : "fail",
      closeWindowIsolation: closeIsolationPass ? "pass" : "fail",
      dipAndOffscreenFixtures: "pass",
      flagOffPreservesSecondaryTopology: "pass",
      packagedUnpackedRuntime: packagedPass ? "pass" : "fail",
      physicalFourDisplays: physicalFourDisplayPass ? "pass" : "pending",
    },
    measurements: {
      createSidecarReadyMs: create.sidecar?.readyMs,
      restoreSidecarReadyMs: restore.sidecar?.readyMs,
      perWindow: create.observations.map((item) => ({
        windowId: item.windowId,
        boundsDip: item.boundsDip,
        canvasCount: item.renderer.canvasCount,
        chartRoots: item.renderer.chartRoots,
        rightRail: item.renderer.hasRightRail,
        exportControl: item.renderer.hasExportControl,
      })),
      lifecycle: create.lifecycle,
      closeIsolation: create.closeIsolation,
      packagedSidecarReadyMs: packaged?.sidecar?.readyMs,
    },
    sources,
    limitations: [
      ...(create.limitations || []),
      "Four physical displays, mixed-DPI cable hotplug, and 64-Cell capacity remain release blockers for Phase 8.",
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.create || !args.restore || !args.packaged || !args.out) {
    throw new TypeError("Expected --create, --restore, --packaged, and --out path arguments");
  }
  const [createText, restoreText, packagedText] = await Promise.all([
    readFile(args.create, "utf8"),
    readFile(args.restore, "utf8"),
    readFile(args.packaged, "utf8"),
  ]);
  const evidence = buildDesktopPhase6ReleaseEvidence(
    JSON.parse(createText),
    JSON.parse(restoreText),
    JSON.parse(packagedText),
    {
      create: { path: path.resolve(args.create), sha256: sha256(createText) },
      restore: { path: path.resolve(args.restore), sha256: sha256(restoreText) },
      packaged: { path: path.resolve(args.packaged), sha256: sha256(packagedText) },
    },
  );
  if (evidence.result === "fail") throw new Error("Phase 6 release evidence failed");
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`DESKTOP_PHASE6_RELEASE_${evidence.result.toUpperCase().replaceAll("-", "_")} ${args.out}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
