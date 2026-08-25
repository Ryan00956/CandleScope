import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assembleFrozenResearchContext,
  frozenContextCanonicalJson,
  isCapabilityAvailable,
  ordinarySourceLabel,
  ordinaryTermsContainInternalIdentity,
  parseResearchSourceRef,
  parseFrozenResearchContext,
  projectResearchCapabilities,
  researchCanonicalJson,
  sha256HexUtf8,
  ResearchDataError,
} from "../researchDataSourceModel.js";
import {
  FORBIDDEN_ORDINARY_UI_TERMS,
  type ResearchSourceRefV1,
} from "../researchDataTypes.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../backend/tests/fixtures/research_data/canonical-v1.json",
);

function loadFixture(): {
  sourceRefs: Record<string, unknown>;
  freezeInputs: Record<string, Record<string, unknown>>;
  invalid: Array<{ name: string; code: string; source: unknown }>;
} {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function importedFreezeInput(): Record<string, unknown> {
  const input = loadFixture().freezeInputs.importedDataset;
  if (input == null) throw new Error("canonical fixture missing importedDataset freeze input");
  return input;
}

test("canonical fixture parses every source kind identically after wire", () => {
  const fixture = loadFixture();
  for (const payload of Object.values(fixture.sourceRefs)) {
    const parsed = parseResearchSourceRef(payload);
    assert.equal(researchCanonicalJson(parsed), researchCanonicalJson(payload));
  }
});

test("imported dataset without dataset or epoch is rejected", () => {
  const fixture = loadFixture();
  for (const name of ["imported-missing-dataset", "imported-missing-epoch"]) {
    const caseRow = fixture.invalid.find((item) => item.name === name);
    assert.ok(caseRow);
    assert.throws(
      () => parseResearchSourceRef(caseRow.source),
      (error: unknown) => error instanceof ResearchDataError && error.code === "MISSING_DATASET_IDENTITY",
    );
  }
});

test("completed run without snapshot hash is rejected", () => {
  const caseRow = loadFixture().invalid.find((item) => item.name === "completed-missing-snapshot");
  assert.ok(caseRow);
  assert.throws(
    () => parseResearchSourceRef(caseRow.source),
    (error: unknown) => error instanceof ResearchDataError && error.code === "MISSING_SNAPSHOT_HASH",
  );
});

test("unknown source kind is rejected", () => {
  const caseRow = loadFixture().invalid.find((item) => item.name === "unknown-kind");
  assert.ok(caseRow);
  assert.throws(
    () => parseResearchSourceRef(caseRow.source),
    (error: unknown) => error instanceof ResearchDataError && error.code === "UNKNOWN_SOURCE_KIND",
  );
});

test("frozen context hash is computed from backend snapshot, not invented", async () => {
  const freezeInput = importedFreezeInput();
  const capabilities = projectResearchCapabilities({
    sourceKind: "IMPORTED_DATASET",
    quality: {
      status: "ok",
      rows: 96,
      excludedRangeCount: 0,
      volumeAvailable: false,
    },
  });
  const frozen = await assembleFrozenResearchContext(freezeInput, capabilities, String(freezeInput.snapshotHash));
  const canonical = frozenContextCanonicalJson({
    schemaVersion: "candlescope.frozen-research-context/1",
    sourceKind: "IMPORTED_DATASET",
    datasetId: String(freezeInput.datasetId),
    dataEpoch: String(freezeInput.dataEpoch),
    snapshotHash: String(freezeInput.snapshotHash),
    interval: String(freezeInput.interval),
    startTimeMs: Number(freezeInput.startTimeMs),
    endTimeMs: Number(freezeInput.endTimeMs),
    symbol: String(freezeInput.symbol),
    qualitySummary: {
      status: "ok",
      rows: 96,
      excludedRangeCount: 0,
      volumeAvailable: false,
    },
  });
  const expectedHash = `sha256:${await sha256HexUtf8(canonical)}`;
  assert.equal(frozen.contextHash, expectedHash);
  assert.equal(frozen.snapshotHash, freezeInput.snapshotHash);
  const parsed = await parseFrozenResearchContext(frozen);
  assert.equal(parsed.contextHash, frozen.contextHash);
});

test("frontend cannot assemble a frozen context without a backend snapshot hash", async () => {
  const freezeInput = { ...importedFreezeInput() };
  delete freezeInput.snapshotHash;
  await assert.rejects(
    () => assembleFrozenResearchContext(freezeInput, projectResearchCapabilities({ sourceKind: "IMPORTED_DATASET" })),
    (error: unknown) => error instanceof ResearchDataError && error.code === "FRONTEND_MUST_NOT_INVENT_SNAPSHOT",
  );
});

test("missing capability is unavailable and never guessed true", () => {
  const summary = projectResearchCapabilities({ sourceKind: "IMPORTED_DATASET" });
  assert.equal(isCapabilityAvailable(summary, "barApprox"), true);
  assert.equal(isCapabilityAvailable(summary, "tradeTape"), false);
  assert.equal(summary.fidelityCeiling, "BAR_APPROX");
  assert.equal(isCapabilityAvailable({ capabilities: {} }, "barApprox"), false);
  assert.equal(isCapabilityAvailable({}, "viewKlines"), false);
  const stripped = { ...summary, capabilities: { ...summary.capabilities } };
  delete stripped.capabilities.barApprox;
  assert.equal(isCapabilityAvailable(stripped, "barApprox"), false);
});

test("LOCAL_OFFLINE hides runnable current chart with a reason", () => {
  const summary = projectResearchCapabilities({ sourceKind: "CURRENT_CHART", runtimeMode: "LOCAL_OFFLINE" });
  assert.equal(isCapabilityAvailable(summary, "barApprox"), false);
  assert.equal(summary.capabilities.barApprox?.reasonCode, "OFFLINE_LIVE_SOURCE_UNAVAILABLE");
});

test("ordinary UI copy never includes internal identity terms", () => {
  assert.deepEqual(ordinaryTermsContainInternalIdentity(), []);
  assert.equal(ordinarySourceLabel("CURRENT_CHART"), "当前图表");
  assert.equal(ordinarySourceLabel("IMPORTED_DATASET"), "本地资料库");
  assert.equal(ordinarySourceLabel("COMPLETED_RUN"), "完成结果");
  const joined = [
    ordinarySourceLabel("CURRENT_CHART", "en"),
    ordinarySourceLabel("IMPORTED_DATASET", "en"),
    ordinarySourceLabel("COMPLETED_RUN", "en"),
  ].join(" ").toLowerCase();
  for (const term of FORBIDDEN_ORDINARY_UI_TERMS) {
    assert.equal(joined.includes(term.toLowerCase()), false);
  }
});

test("parsed source refs keep discriminated kind for later freeze", () => {
  const fixture = loadFixture();
  const imported = parseResearchSourceRef(fixture.sourceRefs.importedDataset) as ResearchSourceRefV1;
  assert.equal(imported.kind, "IMPORTED_DATASET");
  if (imported.kind === "IMPORTED_DATASET") {
    assert.ok(imported.datasetId);
    assert.ok(imported.dataEpoch);
    assert.equal("snapshotHash" in imported, false);
  }
});
