import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_GATES = Object.freeze([
  "fourWindowsSixteenCells",
  "uniqueSixtyFourCellIds",
  "oneWorkspaceRevision",
  "crossWindowLink",
  "scenarioIdentityAccounting",
  "minimizedWorkZero",
  "crashLeaseCleanup",
  "sameWindowIdRecovery",
  "appBudgetBounded",
]);

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] === undefined) {
      throw new TypeError("Expected --w1, --w2, and --out path arguments");
    }
    values[key.slice(2)] = argv[index + 1];
  }
  return values;
}

function itemFailures(evidence) {
  return (evidence?.backendCapacity?.klineBatch?.connections || [])
    .reduce((sum, connection) => sum + Number(connection?.item_failures || 0), 0);
}

function summarizeScenario(evidence) {
  const backend = evidence.backendCapacity;
  return {
    scenario: evidence.environment.scenario,
    windows: evidence.beforeLink.length,
    cells: evidence.beforeLink.reduce((sum, item) => sum + item.renderer.chartRoots, 0),
    browserPhysicalKlineWebSockets: evidence.beforeLink.reduce(
      (sum, item) => sum + Number(item.renderer.broker?.klineStream?.physicalStreams || 0),
      0,
    ),
    frontendLogicalKlineClients: evidence.beforeLink.reduce(
      (sum, item) => sum + Number(item.renderer.broker?.klineStream?.logicalSubscribers || 0),
      0,
    ),
    backendBatchConnections: backend.klineBatch.websocket_connections,
    backendLogicalClients: backend.klineBatch.logical_clients,
    backendLogicalSubscriptions: backend.klineBatch.logical_subscriptions,
    backendActiveSeries: backend.dataManager.activeSeries,
    backendLeasedSeries: backend.dataManager.leasedSeries,
    backendStreamLeases: backend.dataManager.streamLeases,
    backendUniqueLeaseConsumers: backend.dataManager.uniqueLeaseConsumers,
    itemFailures: itemFailures(evidence),
    outboxDepth: backend.klineBatch.outbox_depth,
    authoritativeTimeouts: backend.klineBatch.outbox_authoritative_timeouts,
    dataReadyRootsAtRecoveryGate: evidence.dataReadiness.windows.map((item) => ({
      windowId: item.windowId,
      ready: item.readyCount,
    })),
    sharedSeries: {
      entriesAtRecoveryGate: evidence.dataReadiness.hub.entries,
      barsAtRecoveryGate: evidence.dataReadiness.hub.bars,
      publishes: evidence.dataReadiness.hub.counts.publishes,
      rejects: evidence.dataReadiness.hub.counts.rejects,
      restoredHydrations: evidence.crash.restored.renderer.broker.sharedSeries.hydrations,
      restoredBars: evidence.crash.restored.renderer.broker.sharedSeries.hydratedBars,
    },
    workspaceBus: evidence.finalBudget.workspaceBus.counts,
    appWork: {
      maxConcurrent: evidence.finalBudget.appWork.maxConcurrent,
      maxPerWindow: evidence.finalBudget.appWork.maxPerWindow,
      maxPreviewLanes: evidence.finalBudget.appWork.maxPreviewLanes,
      rejectedPreview: evidence.finalBudget.appWork.counts.rejectedPreview,
      reclaimed: evidence.finalBudget.appWork.counts.reclaimed,
    },
    minimized: evidence.minimized.activity,
    crashRecovery: {
      sameWindowId: evidence.crash.windowId === evidence.crash.restored.windowId,
      ready: evidence.crash.restored.renderer.workspace.ready,
      revision: evidence.crash.restored.renderer.workspace.document.revision,
      chartRoots: evidence.crash.restored.renderer.chartRoots,
      dataReadyRoots: evidence.crash.restored.renderer.dataReadyRoots,
      canvasCount: evidence.crash.restored.renderer.canvasCount,
      windowState: evidence.crash.restored.renderer.workspace.document.windows[
        evidence.crash.windowId
      ].windowState,
    },
  };
}

function scenarioPass(evidence, scenario) {
  const expectedSubscriptions = scenario === "W1" ? 128 : 64;
  const expectedSeries = scenario === "W1" ? 5 : 64;
  const backend = evidence?.backendCapacity;
  const minimumSharedEntries = scenario === "W1" ? 4 : 16;
  return evidence?.result === "pass"
    && evidence?.environment?.scenario === scenario
    && evidence?.beforeLink?.length === 4
    && evidence.beforeLink.every((item) => (
      item.renderer?.chartRoots === 16
      && item.renderer?.canvasCount > 0
      && item.renderer?.broker?.klineStream?.open === true
      && item.renderer?.broker?.klineStream?.physicalStreams === 1
      && item.renderer?.broker?.klineStream?.logicalSubscribers === 16
    ))
    && REQUIRED_GATES.every((gate) => evidence.gates?.[gate] === "pass")
    && backend?.ok === true
    && backend?.limits?.klineBatchEnabled === true
    && backend?.klineBatch?.websocket_connections === 4
    && backend?.klineBatch?.logical_clients === 64
    && backend?.klineBatch?.logical_series === 64
    && backend?.klineBatch?.logical_subscriptions === expectedSubscriptions
    && backend?.klineBatch?.outbox_depth === 0
    && backend?.klineBatch?.outbox_authoritative_timeouts === 0
    && itemFailures(evidence) === 0
    && backend?.dataManager?.activeSeries === expectedSeries
    && backend?.dataManager?.leasedSeries === expectedSeries
    && evidence?.finalBudget?.workspaceBus?.participantCount === 4
    && evidence?.finalBudget?.workspaceBus?.counts?.conflicts === 0
    && evidence?.minimized?.activity?.previewLanePresent === false
    && evidence?.minimized?.activity?.replaceableCommitsBefore
      === evidence?.minimized?.activity?.replaceableCommitsAfter
    && evidence?.crash?.restored?.renderer?.workspace?.ready === true
    && evidence?.crash?.restored?.windowId === evidence?.crash?.windowId
    && evidence?.crash?.restored?.renderer?.dataReadyRoots === 16
    && evidence?.crash?.restored?.renderer?.broker?.sharedSeries?.hydrations >= 1
    && evidence?.crash?.restored?.renderer?.broker?.sharedSeries?.hydratedBars > 0
    && evidence?.dataReadiness?.hub?.entries >= minimumSharedEntries
    && evidence?.dataReadiness?.hub?.counts?.rejects === 0;
}

export function buildDesktopPhase7ReleaseEvidence(w1, w2, sources = {}) {
  const w1Pass = scenarioPass(w1, "W1");
  const w2Pass = scenarioPass(w2, "W2");
  const implementationPass = w1Pass && w2Pass;
  return {
    schemaVersion: "candlescope.multi-chart.phase7-release/1",
    generatedAt: new Date().toISOString(),
    scope: "workspace-bus-cross-window-link-and-64-cell-app-budget",
    result: implementationPass ? "pass" : "fail",
    host: {
      electron: w1?.environment?.electron ?? null,
      chrome: w1?.environment?.chrome ?? null,
      node: w1?.environment?.node ?? null,
      displayCount: Math.min(
        Number(w1?.environment?.displayCount || 0),
        Number(w2?.environment?.displayCount || 0),
      ),
    },
    gates: {
      w1RepeatedIdentity: w1Pass ? "pass" : "fail",
      w2SixtyFourUniqueSeries: w2Pass ? "pass" : "fail",
      fourWindowsSixtyFourUniqueCells: implementationPass ? "pass" : "fail",
      oneAuthoritativeWorkspaceRevision: implementationPass ? "pass" : "fail",
      crossWindowRoleLinkWithoutLoop: implementationPass ? "pass" : "fail",
      noSilentWorkspaceOverwrite: implementationPass ? "pass" : "fail",
      minimizedCanvasAndPreviewIdle: implementationPass ? "pass" : "fail",
      boundedAppWindowCellWork: implementationPass ? "pass" : "fail",
      crashLeaseCleanupAndSameIdRecovery: implementationPass ? "pass" : "fail",
      explicitSixtyFourCellLimit: implementationPass ? "pass" : "fail",
    },
    measurements: {
      W1: summarizeScenario(w1),
      W2: summarizeScenario(w2),
    },
    sources,
    limitations: [
      "The validation host exposes one logical display; Phase 7 validates four native windows, while physical four-display placement remains a Phase 6/8 hardware gate.",
      "W3 indicators, fault drills, four-hour soak, installation artifact, and release-default review remain Phase 8 gates.",
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.w1 || !args.w2 || !args.out) {
    throw new TypeError("Expected --w1, --w2, and --out path arguments");
  }
  const [w1Text, w2Text] = await Promise.all([
    readFile(args.w1, "utf8"),
    readFile(args.w2, "utf8"),
  ]);
  const evidence = buildDesktopPhase7ReleaseEvidence(
    JSON.parse(w1Text),
    JSON.parse(w2Text),
    {
      W1: { path: path.resolve(args.w1), sha256: sha256(w1Text) },
      W2: { path: path.resolve(args.w2), sha256: sha256(w2Text) },
    },
  );
  if (evidence.result !== "pass") throw new Error("Phase 7 release evidence failed");
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`DESKTOP_PHASE7_RELEASE_PASS ${args.out}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
