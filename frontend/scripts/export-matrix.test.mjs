import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExpectedImageMagic,
  runExportMatrix,
  summarizeExportMatrixAcceptance,
  summarizeHiddenSceneRuntimeRetirement,
  waitForStableHiddenSceneRuntimeRetirement,
} from "./export-matrix.mjs";

test("hasExpectedImageMagic recognizes PNG, JPEG, and WebP headers", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
  const webp = Buffer.from("RIFF0000WEBP", "ascii");

  assert.equal(hasExpectedImageMagic(png, "png"), true);
  assert.equal(hasExpectedImageMagic(jpeg, "jpeg"), true);
  assert.equal(hasExpectedImageMagic(webp, "webp"), true);
});

test("hasExpectedImageMagic rejects truncated, mismatched, and unknown formats", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
  const webp = Buffer.from("RIFF0000NOPE", "ascii");

  assert.equal(hasExpectedImageMagic(png, "png"), false);
  assert.equal(hasExpectedImageMagic(jpeg, "png"), false);
  assert.equal(hasExpectedImageMagic(webp, "webp"), false);
  assert.equal(hasExpectedImageMagic(Buffer.alloc(16), "avif"), false);
});

test("summarizeExportMatrixAcceptance passes a complete successful matrix", () => {
  const acceptance = summarizeExportMatrixAcceptance({
    cases: [
      { scope: "chart", format: "png", passed: true },
      { scope: "main-pane", format: "jpeg", passed: true },
      { scope: "page", format: "webp", passed: true },
    ],
    scopeDimensions: {
      mainPaneShorterThanChart: true,
      pageLargerThanChart: true,
    },
    panelClosed: true,
    error: "",
  });

  assert.deepEqual(acceptance, {
    caseCount: 3,
    passedCaseCount: 3,
    failedCases: [],
    scopeDimensionsPassed: true,
    panelClosed: true,
    error: "",
    passed: true,
  });
});

test("summarizeExportMatrixAcceptance reports failed cases and acceptance gates", () => {
  const acceptance = summarizeExportMatrixAcceptance({
    cases: [
      { scope: "chart", format: "png", passed: true },
      { scope: "main-pane", format: "jpeg", passed: false },
    ],
    scopeDimensions: {
      mainPaneShorterThanChart: false,
      pageLargerThanChart: true,
    },
    panelClosed: false,
    error: "preview failed",
  });

  assert.equal(acceptance.passed, false);
  assert.equal(acceptance.passedCaseCount, 1);
  assert.deepEqual(acceptance.failedCases, ["main-pane:jpeg"]);
  assert.equal(acceptance.scopeDimensionsPassed, false);
  assert.equal(acceptance.panelClosed, false);
  assert.equal(acceptance.error, "preview failed");
});

test("hidden-scene runtime retirement is mandatory when the performance handle exists", () => {
  const retired = summarizeHiddenSceneRuntimeRetirement({
    handleAvailable: true,
    readerAvailable: true,
    runtime: {
      scenePublicationReady: false,
      queueDepthCurrent: 0,
      inFlightCurrent: 0,
      lastRequestedStamp: null,
      lastPublishedStamp: null,
    },
  });
  assert.equal(retired.passed, true);

  for (const runtime of [
    { ...retired.runtime, scenePublicationReady: true },
    { ...retired.runtime, queueDepthCurrent: 1 },
    { ...retired.runtime, inFlightCurrent: 1 },
    { ...retired.runtime, lastRequestedStamp: { documentRevision: 1 } },
    { ...retired.runtime, lastPublishedStamp: { documentRevision: 1 } },
  ]) {
    assert.equal(summarizeHiddenSceneRuntimeRetirement({
      handleAvailable: true,
      readerAvailable: true,
      runtime,
    }).passed, false);
  }
  assert.equal(summarizeHiddenSceneRuntimeRetirement({
    handleAvailable: true,
    readerAvailable: false,
  }).passed, false);
  assert.equal(summarizeHiddenSceneRuntimeRetirement().passed, true);
});

test("hidden-scene retirement waits for pending previews and consecutive stable samples", async () => {
  const samples = [
    { passed: false, previewIdle: false, runtime: { scenePublicationReady: true } },
    { passed: true, previewIdle: true, runtime: { scenePublicationReady: false } },
    { passed: false, previewIdle: false, runtime: { scenePublicationReady: true } },
    { passed: true, previewIdle: true, runtime: { scenePublicationReady: false } },
    { passed: true, previewIdle: true, runtime: { scenePublicationReady: false } },
  ];
  let clock = 0;
  const result = await waitForStableHiddenSceneRuntimeRetirement({
    readSample: async () => samples.shift(),
    wait: async (durationMs) => { clock += durationMs; },
    now: () => clock,
    timeoutMs: 1_000,
    sampleIntervalMs: 10,
    requiredStableSamples: 2,
  });

  assert.equal(result.passed, true);
  assert.equal(result.previewIdle, true);
  assert.equal(result.stableSampleCount, 2);
  assert.equal(result.sampleCount, 5);
});

test("runExportMatrix enforces injected browser helpers", async () => {
  await assert.rejects(
    runExportMatrix({ cdp: { send() {} } }),
    /requires clickSelector/,
  );
});
