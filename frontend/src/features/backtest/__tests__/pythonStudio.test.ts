import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  PYTHON_STUDIO_STORAGE_KEY,
  PYTHON_TEMPLATES,
  trustedLocalConfirmLabel,
  trustedLocalFacts,
  assertRequiredBundleFiles,
  assessCoverage,
  canStartTrustedLocal,
  composePythonExport,
  emptyReportIsHidden,
  encodeZipStore,
  filesFromInput,
  hostOwnsOrdersCopy,
  isPythonRevision,
  mapStudioFailure,
  persistPythonStudioState,
  pythonStudyParameterSpace,
  restorePythonStudioState,
  unzipStore,
  warmupRowsFromSchema,
  zipFilesToBase64,
} from "../pythonStudio.js";

const app = readFileSync(new URL("../BacktestApp.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../backtestApi.ts", import.meta.url), "utf8");
const studio = readFileSync(new URL("../PythonStudioPanel.tsx", import.meta.url), "utf8");

describe("python studio mapping and state", () => {
  it("templates generate the three required files without user JSON", () => {
    for (const template of PYTHON_TEMPLATES) {
      assert.deepEqual(assertRequiredBundleFiles(template.files), []);
      assert.match(String(template.files["strategy.json"]), /schemaVersion/);
      assert.match(String(template.files["strategy.py"]), /class Strategy/);
      assert.doesNotMatch(String(template.files["strategy.py"]), /\r/);
    }
  });

  it("round-trips a stored zip used by inspect/create", () => {
    const sma = PYTHON_TEMPLATES[0];
    assert.ok(sma);
    const files = sma.files;
    const encoded = encodeZipStore(files);
    assert.equal(encoded[0], 0x50);
    assert.equal(encoded[1], 0x4b);
    assert.deepEqual(unzipStore(encoded), files);
    assert.ok(zipFilesToBase64(files).length > 32);
  });

  it("imports zip and directory-style files through the same collector", async () => {
    const rsi = PYTHON_TEMPLATES[1];
    const breakout = PYTHON_TEMPLATES[2];
    assert.ok(rsi && breakout);
    const zipBytes = Uint8Array.from(encodeZipStore(rsi.files));
    const zip = new File([zipBytes], "rsi.zip", {
      type: "application/zip",
    });
    const fromZip = await filesFromInput([zip]);
    assert.equal(fromZip["strategy.py"], rsi.files["strategy.py"]);

    const directory = [
      new File([String(breakout.files["strategy.json"])], "strategy.json"),
      new File([String(breakout.files["strategy.py"])], "strategy.py"),
      new File([String(breakout.files["requirements.lock"])], "requirements.lock"),
    ];
    Object.defineProperty(directory[0], "webkitRelativePath", { value: "breakout/strategy.json" });
    const fromDir = await filesFromInput(directory);
    assert.deepEqual(assertRequiredBundleFiles(fromDir), []);
    assert.match(String(fromDir["strategy.json"]), /Donchian Breakout/);
  });

  it("maps smoke/inspect failures to source location and next step", () => {
    const located = mapStudioFailure(
      new Error('BUNDLE_STATIC_DIAGNOSTIC: [{"severity":"ERROR","line":4,"column":9,"message":"missing lifecycle methods: close"}]'),
    );
    assert.equal(located.code, "BUNDLE_STATIC_DIAGNOSTIC");
    assert.equal(located.line, 4);
    assert.equal(located.column, 9);
    assert.match(located.nextStep, /close/);

    const sandbox = mapStudioFailure(new Error("SANDBOX_UNAVAILABLE: AppContainer missing"));
    assert.match(sandbox.nextStep, /TRUSTED_LOCAL/);
    assert.doesNotMatch(sandbox.nextStep, /继续/);
  });

  it("blocks first run when coverage or warmup is insufficient", () => {
    const short = assessCoverage({
      snapshotRows: 3,
      startTimeMs: 1,
      endTimeMs: 2,
      warmupRows: 21,
    });
    assert.equal(short.ready, false);
    const ready = assessCoverage({
      snapshotRows: 200,
      startTimeMs: 1,
      endTimeMs: 2,
      warmupRows: 21,
    });
    assert.equal(ready.ready, true);
    assert.equal(
      warmupRowsFromSchema(
        [{ name: "fast", default: 20 }, { name: "slow", default: 50 }],
        { fast: 8, slow: 21 },
      ),
      22,
    );
  });

  it("requires explicit TRUSTED_LOCAL facts instead of a continue button", () => {
    assert.equal(canStartTrustedLocal({ trustedFlagEnabled: false, confirmed: true }), false);
    assert.equal(canStartTrustedLocal({ trustedFlagEnabled: true, confirmed: false }), false);
    assert.equal(canStartTrustedLocal({ trustedFlagEnabled: true, confirmed: true }), true);
    assert.match(trustedLocalConfirmLabel(), /权限事实/);
    assert.ok(trustedLocalFacts().some((fact) => fact.includes("AppContainer")));
    assert.doesNotMatch(studio, />继续</);
    assert.match(studio, /trustedLocalConfirmLabel/);
    assert.match(studio, /python-trusted-facts/);
  });

  it("persists and restores revision/run/study only when the flag is on", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    };
    persistPythonStudioState(false, {
      revisionId: "srv2_hidden",
      runId: "bt_hidden",
      studyId: "st_hidden",
      bundleId: "psb_hidden",
      bundleIdentity: null,
      smokePassed: true,
      runtimeMode: "SANDBOXED_LOCAL",
      trustedConfirmed: false,
    }, storage);
    assert.equal(memory.has(PYTHON_STUDIO_STORAGE_KEY), false);
    persistPythonStudioState(true, {
      revisionId: "srv2_py",
      runId: "bt_1",
      studyId: "st_1",
      bundleId: "psb_1",
      bundleIdentity: {
        bundle_hash: "sha256:b",
        manifest_hash: "sha256:m",
        source_hash: "sha256:s",
      },
      smokePassed: true,
      runtimeMode: "TRUSTED_LOCAL",
      trustedConfirmed: true,
    }, storage);
    const restored = restorePythonStudioState(true, storage);
    assert.equal(restored?.revisionId, "srv2_py");
    assert.equal(restored?.runId, "bt_1");
    assert.equal(restored?.studyId, "st_1");
    assert.equal(restorePythonStudioState(false, storage), null);
  });

  it("export binds bundle identity, run manifest and report hash", () => {
    const exported = composePythonExport({
      bundleIdentity: {
        bundle_id: "psb_1",
        bundle_hash: "sha256:bundle",
        manifest_hash: "sha256:man",
        source_hash: "sha256:src",
      },
      runExport: {
        manifest: { reportHash: "sha256:report", runId: "bt_1" },
        report: { runId: "bt_1" },
        csv: "order_id\n",
      },
    });
    assert.equal((exported.bundleIdentity as { bundle_hash: string }).bundle_hash, "sha256:bundle");
    assert.equal(exported.reportHash, "sha256:report");
    assert.equal((exported.manifest as { runId: string }).runId, "bt_1");
  });

  it("does not invent an empty report after a connection failure", () => {
    assert.equal(emptyReportIsHidden({ error: "backtest API 500", report: null }), true);
    assert.equal(emptyReportIsHidden({ error: null, report: { runId: "bt_1" } }), false);
  });

  it("identifies PYTHON_SOURCE revisions and Host-owned orders copy", () => {
    assert.equal(isPythonRevision({ provider_kind: "PYTHON_SOURCE" }), true);
    assert.equal(isPythonRevision({ provider_kind: "BUILTIN" }), false);
    assert.match(hostOwnsOrdersCopy(), /Host/);
    assert.equal(pythonStudyParameterSpace([{ name: "fast", default: 20 }]), '{"fast":[20]}');
  });
});

describe("python studio shipped surface", () => {
  it("wires template, import, smoke, persist and Host-owned result copy", () => {
    for (const token of [
      "<PythonStudioPanel",
      "python-host-owns-report",
      "backtest.createPythonStudy",
      "composePythonExport",
      "restorePythonStudioState",
    ]) {
      assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    for (const token of [
      "python-strategy-studio",
      "python-template-create",
      "python-import-zip",
      "python-import-directory",
      "python-trusted-facts",
      "python-coverage",
    ]) {
      assert.match(studio, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    for (const path of [
      "/strategy-bundles/inspect",
      "/strategy-bundles",
      "/strategy-revisions/python",
      "/runtime-receipt",
    ]) {
      assert.ok(api.includes(path));
    }
  });
});
