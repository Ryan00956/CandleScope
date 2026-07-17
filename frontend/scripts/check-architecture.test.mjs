import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runArchitectureCheck, sourceFileKind } from "./check-architecture.mjs";

function runArchitectureFixture(t, files) {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-architecture-"));
  const sourceDirectory = path.join(projectDirectory, "src");
  fs.mkdirSync(sourceDirectory, { recursive: true });
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(projectDirectory, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }

  return runArchitectureCheck({
    sourceDirectory,
    projectDirectory,
    logger: { error() {}, log() {} },
    setExitCode: false,
  });
}

test("architecture source discovery classifies every JavaScript and TypeScript module extension", () => {
  assert.equal(sourceFileKind("feature.ts"), "typescript");
  assert.equal(sourceFileKind("Component.tsx"), "typescript");
  assert.equal(sourceFileKind("legacy.js"), "legacy-javascript");
  assert.equal(sourceFileKind("Legacy.jsx"), "legacy-javascript");
  assert.equal(sourceFileKind("module.mjs"), "legacy-javascript");
  assert.equal(sourceFileKind("config.cjs"), "legacy-javascript");
  assert.equal(sourceFileKind("Legacy.JS"), "legacy-javascript");
  assert.equal(sourceFileKind("Legacy.JSX"), "legacy-javascript");
  assert.equal(sourceFileKind("module.mts"), "unsupported-typescript");
  assert.equal(sourceFileKind("module.cts"), "unsupported-typescript");
  assert.equal(sourceFileKind("Module.TS"), "unsupported-typescript");
  assert.equal(sourceFileKind("Component.TSX"), "unsupported-typescript");
  assert.equal(sourceFileKind("styles.css"), null);
  assert.equal(sourceFileKind("notes.md"), null);
  assert.equal(sourceFileKind("logo.svg"), null);
  assert.equal(sourceFileKind("Component.vue"), "unsupported-source");
  assert.equal(sourceFileKind("script.coffee"), "unsupported-source");
  assert.equal(sourceFileKind("extensionless"), "unsupported-source");
});

test("architecture check fails closed for unsupported source extensions in nested src paths", (t) => {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-architecture-"));
  const sourceDirectory = path.join(projectDirectory, "src");
  const nestedDirectory = path.join(sourceDirectory, "nested");
  fs.mkdirSync(nestedDirectory, { recursive: true });
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  const invalidFiles = [
    "legacy.mjs",
    "legacy.cjs",
    "Legacy.JS",
    "Legacy.JSX",
    "module.mts",
    "module.cts",
    "Module.TS",
    "Component.TSX",
    "Component.vue",
    "script.coffee",
    "extensionless",
  ];
  for (const fileName of invalidFiles) {
    fs.writeFileSync(path.join(nestedDirectory, fileName), "export {};\n");
  }
  fs.writeFileSync(path.join(sourceDirectory, "valid.ts"), "export {};\n");
  fs.writeFileSync(path.join(sourceDirectory, "styles.css"), ".fixture {}\n");
  fs.writeFileSync(path.join(sourceDirectory, "logo.svg"), "<svg />\n");

  const result = runArchitectureCheck({
    sourceDirectory,
    projectDirectory,
    logger: { error() {}, log() {} },
    setExitCode: false,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map(({ rule, filePath }) => ({ rule, filePath })).sort((left, right) =>
      left.filePath.localeCompare(right.filePath),
    ),
    invalidFiles
      .map((fileName) => ({ rule: "source-typescript-only", filePath: `src/nested/${fileName}` }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath)),
  );
});

test("architecture check accepts lowercase TypeScript source and ignores non-source assets", (t) => {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-architecture-"));
  const sourceDirectory = path.join(projectDirectory, "src");
  fs.mkdirSync(sourceDirectory, { recursive: true });
  t.after(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));

  fs.writeFileSync(path.join(sourceDirectory, "feature.ts"), "export {};\n");
  fs.writeFileSync(path.join(sourceDirectory, "Component.tsx"), "export {};\n");
  fs.writeFileSync(path.join(sourceDirectory, "styles.css"), ".fixture {}\n");
  fs.writeFileSync(path.join(sourceDirectory, "notes.md"), "# fixture\n");
  fs.writeFileSync(path.join(sourceDirectory, "logo.svg"), "<svg />\n");

  const result = runArchitectureCheck({
    sourceDirectory,
    projectDirectory,
    logger: { error() {}, log() {} },
    setExitCode: false,
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("drawing production workers reject chart-adapter and Lightweight Charts imports", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/worker/chartAdapterWorker.ts": `
      import { captureDrawingFrame } from "../../../chart-adapter/drawingFrameSnapshot.js";
      export const capture = captureDrawingFrame;
    `,
    "src/features/drawings/worker/lightweightWorker.ts": `
      import type { IChartApi } from "lightweight-charts";
      export type RawChart = IChartApi;
    `,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map(({ rule, filePath }) => ({ rule, filePath })),
    [
      {
        rule: "drawing-worker-no-chart-runtime-import",
        filePath: "src/features/drawings/worker/chartAdapterWorker.ts",
      },
      {
        rule: "drawing-worker-no-chart-runtime-import",
        filePath: "src/features/drawings/worker/lightweightWorker.ts",
      },
    ],
  );
});

test("drawing production workers accept pure protocol and geometry imports", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/worker/drawing.worker.ts": `
      import { processDrawing } from "./drawingWorkerProcessor.js";
      export const process = processDrawing;
    `,
    "src/features/drawings/worker/drawingWorkerProcessor.ts": `
      import type { DrawingKind } from "../drawingTypes.js";
      export function processDrawing(kind: DrawingKind): DrawingKind { return kind; }
    `,
    "src/features/drawings/drawingTypes.ts": `
      export type DrawingKind = "line";
    `,
    "src/chart-adapter/allowedChartRuntime.ts": `
      import type { IChartApi } from "lightweight-charts";
      export type AllowedInsideAdapter = IChartApi;
    `,
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("drawing worker import graph rejects chart runtime hidden behind a helper", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/worker/drawing.worker.ts": `
      import { project } from "../workerSupport.js";
      export const run = project;
    `,
    "src/features/drawings/workerSupport.ts": `
      import { captureDrawingFrame } from "../../chart-adapter/drawingFrameSnapshot.js";
      export const project = captureDrawingFrame;
    `,
    "src/chart-adapter/drawingFrameSnapshot.ts": "export const captureDrawingFrame = 1;\n",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map(({ rule, filePath }) => ({ rule, filePath })), [{
    rule: "drawing-worker-no-chart-runtime-import",
    filePath: "src/features/drawings/worker/drawing.worker.ts",
  }]);
});

test("drawing worker runtime graph does not follow erased type-only edges", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/worker/drawing.worker.ts": `
      import type { HelperShape } from "../workerSupport.js";
      export type WorkerShape = HelperShape;
    `,
    "src/features/drawings/workerSupport.ts": `
      import { captureDrawingFrame } from "../../chart-adapter/drawingFrameSnapshot.js";
      export type HelperShape = typeof captureDrawingFrame;
    `,
    "src/chart-adapter/drawingFrameSnapshot.ts": "export const captureDrawingFrame = 1;\n",
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("drawing interaction hot paths reject direct localStorage writes", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/drawingInteractionController.ts": `
      export function move(): void {
        localStorage.setItem("drawing", "hot-path");
      }
    `,
    "src/features/drawings/interaction/liveInkController.ts": `
      export function append(): void {
        globalThis.localStorage?.setItem("drawing", "live-ink");
      }
    `,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map(({ rule, filePath }) => ({ rule, filePath })),
    [
      {
        rule: "drawing-interaction-no-local-storage-write",
        filePath: "src/features/drawings/drawingInteractionController.ts",
      },
      {
        rule: "drawing-interaction-no-local-storage-write",
        filePath: "src/features/drawings/interaction/liveInkController.ts",
      },
    ],
  );
});

test("drawing interaction hot paths reject writes through a localStorage alias", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/interaction/liveInkController.ts": `
      const storage = globalThis.localStorage;
      export function append(): void { storage.setItem("drawing", "live-ink"); }
    `,
  });

  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.rule, "drawing-interaction-no-local-storage-write");
});

test("drawing interaction import graph rejects localStorage writes hidden behind a helper", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/interaction/liveInkController.ts": `
      import { syncPreference } from "../syncPreference.js";
      export function append(): void { syncPreference(); }
    `,
    "src/features/drawings/syncPreference.ts": `
      export function syncPreference(): void { localStorage.setItem("drawing", "live"); }
    `,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map(({ rule, filePath }) => ({ rule, filePath })), [{
    rule: "drawing-interaction-no-local-storage-write",
    filePath: "src/features/drawings/interaction/liveInkController.ts",
  }]);
});

test("drawing interaction graph stops at the explicit persistence boundary", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/interaction/liveInkController.ts": `
      import { enqueue } from "../persistence/drawingQueue.js";
      export function append(): void { enqueue(); }
    `,
    "src/features/drawings/persistence/drawingQueue.ts": `
      export function enqueue(): void { localStorage.setItem("drawing", "queued"); }
    `,
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("drawing persistence may write localStorage outside interaction hot paths", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/drawingPersistence.ts": `
      export function persist(): void {
        localStorage.setItem("drawing", "persisted");
      }
    `,
    "src/features/drawings/drawingToolState.ts": `
      export function savePreference(): void {
        localStorage.setItem("drawing-tool", "line");
      }
    `,
    "src/features/drawings/interaction/liveInkController.ts": `
      const diagnostic = "localStorage.setItem(ignored)";
      // localStorage.setItem("ignored", "comment");
      export function append(storage: Storage): void { storage.setItem(diagnostic, "value"); }
    `,
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("public drawing runtime contracts reject raw chart and series capabilities", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/useDrawingRuntime.ts": `
      export type DrawingRuntimeActions = {
        getRawSeries(): unknown;
      };
      export interface DrawingRuntime {
        view: Record<string, never>;
        actions: DrawingRuntimeActions;
        status: Record<string, never>;
        adapter: DrawingChartAdapter;
      }
    `,
    "src/features/drawings/drawingToolState.ts": `
      export interface DrawingToolStateRuntime {
        view: { chart: unknown };
        actions: Record<string, never>;
      }
    `,
    "src/features/drawings/DrawingEngineHost.tsx": `
      export interface DrawingEngineApi {
        rawSeries: unknown;
      }
      export interface DrawingEngineHostProps {
        chartAdapter: DrawingChartAdapter;
      }
    `,
  });

  assert.equal(result.ok, false);
  const violations = result.violations.filter(({ rule }) => (
    rule === "drawing-public-runtime-no-raw-chart-series"
  ));
  assert.equal(violations.length, 4);
  assert.deepEqual(
    new Set(violations.map(({ message }) => (
      /contract\s+(\w+)/.exec(message)?.[1]
    ))),
    new Set([
      "DrawingRuntimeActions",
      "DrawingRuntime",
      "DrawingToolStateRuntime",
      "DrawingEngineApi",
    ]),
  );
  assert.equal(result.violations.length, violations.length);
});

test("public drawing runtime guard allows facade actions and internal host adapter props", (t) => {
  const result = runArchitectureFixture(t, {
    "src/features/drawings/useDrawingRuntime.ts": `
      export type DrawingRuntimeActions = {
        prepareChartExport(): Promise<void>;
      };
      export interface DrawingRuntime {
        view: { chartLabel: string; seriesReady: number };
        actions: DrawingRuntimeActions;
        status: Record<string, never>;
      }
    `,
    "src/features/drawings/drawingToolState.ts": `
      export interface DrawingToolStateRuntime {
        view: { seriesReady: number };
        actions: { setDrawingTool(tool: string): void };
      }
    `,
    "src/features/drawings/DrawingEngineHost.tsx": `
      export interface DrawingEngineApi {
        invalidateSurfaceCredentialsForSeriesReplacement(): void;
        prepareExport(): Promise<void>;
      }
      export interface DrawingEngineHostProps {
        chartAdapter: DrawingChartAdapter;
      }
    `,
  });

  assert.deepEqual(result, { ok: true, violations: [] });
});
