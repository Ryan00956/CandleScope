import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REPO_ROOT, SUITES, changedFiles, createSteps, executeSteps, inventory, parseArgs, pythonExecutable, selectTests } from "./run-tests.mjs";

const files = inventory();
const select = (argv, changes) => selectTests(parseArgs(argv), files, changes);

test("full and fast plus deferred integration cover every backend file exactly once", () => {
  const full = select(["full"]);
  const fast = select(["check"]);
  const integration = select(["integration"]);
  assert.deepEqual(full.backend, files.backend);
  assert.deepEqual(full.frontend, files.frontend);
  assert.deepEqual(full.desktop, files.desktop);
  assert.deepEqual([...fast.backend, ...integration.backend].sort(), full.backend);
  assert.deepEqual(fast.deferred, integration.backend);
  assert.equal(new Set([...full.parallelBackend, ...full.serialBackend]).size, full.backend.length);
  assert.equal(full.parallelBackend.length + full.serialBackend.length, full.backend.length);
  for (const name of Object.keys(SUITES.integrationBackend)) assert.ok(files.backend.includes(`backend/tests/${name}`), name);
  for (const name of Object.keys(SUITES.serialBackend)) assert.ok(files.backend.includes(`backend/tests/${name}`), name);
});

test("manual history includes API, planning, persistence and frontend coverage without installing plugins", () => {
  const selected = select(["dev", "manual-history"]);
  for (const part of ["api", "planner", "repository", "runtime", "service", "gc_protection"]) {
    assert.ok(selected.backend.includes(`backend/tests/test_manual_history_${part}.py`), part);
  }
  assert.ok(selected.frontend.some((file) => file.endsWith("manualHistoryForm.test.ts")));
  assert.equal(selected.deferred.length, 0);
  assert.ok(selected.backend.length < files.backend.length);
  const changed = select(["dev", "--changed"], ["backend/app/data_engine/manual_history/service.py"]);
  assert.deepEqual(changed.backend, selected.backend);
  assert.equal(changed.frontend.length, 0);
});

test("frontend-only edits do not silently request the backend or omit colocated tests", () => {
  const selected = select(["dev", "--changed"], ["frontend/src/features/local-data/localDataApi.ts"]);
  assert.equal(selected.backend.length, 0);
  assert.ok(selected.frontend.includes("frontend/src/features/local-data/localDataApi.test.ts"));
  assert.ok(selected.frontend.some((file) => file.includes("/strategy-research/")));
});

test("installer edits include actual integration while shared or unmapped inputs broaden to full", () => {
  const installer = select(["dev", "--changed"], ["backend/app/plugin_installer_v2/installer.py"]);
  assert.ok(installer.backend.includes("backend/tests/test_plugin_installer_v2.py"));
  assert.ok(installer.serialBackend.includes("backend/tests/test_plugin_platform_multi_runtime_phase9_gate.py"));
  assert.equal(installer.deferred.length, 0);
  const fastBacktest = select(["dev", "backtest"]);
  assert.ok(fastBacktest.backend.includes("backend/tests/test_python_million_bar.py"));
  assert.ok(fastBacktest.deferred.includes("backend/tests/test_python_million_bar_reference.py"));
  const capacity = select(["dev", "--changed"], ["backend/app/backtest/python_scale_run.py"]);
  assert.ok(capacity.backend.includes("backend/tests/test_python_million_bar_reference.py"));
  for (const changed of ["backend/app/core/config.py", "packages/candlescope-plugin-sdk/src/new.py", "backend/app/brand_new_module.py", "backend/tests/conftest.py"]) {
    const selected = select(["dev", "--changed"], [changed]);
    assert.deepEqual(selected.backend, files.backend, changed);
    assert.deepEqual(selected.frontend, files.frontend, changed);
    assert.deepEqual(selected.desktop, files.desktop, changed);
  }
});

test("new tests enter discovery and full automatically, including contract subdirectories", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-test-inventory-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const added = ["backend/tests/new_contract/test_unmapped.py", "frontend/src/new/New.test.tsx", "frontend/src/new/__tests__/Nested.test.ts", "frontend/desktop/new.test.mjs"];
  for (const file of added) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  const found = inventory(root);
  const selected = selectTests(parseArgs(["full"]), found);
  assert.deepEqual([...selected.backend, ...selected.frontend, ...selected.desktop].sort(), added.sort());
});

test("typos and invalid selections fail rather than reporting a passing empty suite", () => {
  for (const args of [["dev", "manul-history"], ["dev"], ["full", "manual-history"], ["dev", "--changed", "--workers", "0"], ["profile", "--frontend"], ["dev", "manual-history", "--frontend", "--backend"]]) {
    assert.throws(() => parseArgs(args), undefined, args.join(" "));
  }
  const empty = spawnSync(process.execPath, [path.join(REPO_ROOT, "frontend/scripts/run-tests.mjs"), "dev", "drawings", "--backend"], { encoding: "utf8", windowsHide: true });
  assert.equal(empty.status, 2);
  assert.match(empty.stdout, /No tests selected/);
});

test("changed selection includes staged, unstaged, deleted and untracked files and rejects bad refs", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-test-diff-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  git("init", "-q");
  for (const file of ["staged.py", "unstaged.py", "deleted.py"]) fs.writeFileSync(path.join(root, file), "before");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  fs.writeFileSync(path.join(root, "staged.py"), "after");
  git("add", "staged.py");
  fs.writeFileSync(path.join(root, "unstaged.py"), "after");
  fs.unlinkSync(path.join(root, "deleted.py"));
  fs.writeFileSync(path.join(root, "new file.py"), "new");
  assert.deepEqual(changedFiles(root).sort(), ["deleted.py", "new file.py", "staged.py", "unstaged.py"]);
  assert.throws(() => changedFiles(root, "missing-ref"), /Cannot determine changes/);
});

test("profile preserves serial backend execution and file batches fit Windows process limits", () => {
  assert.equal(pythonExecutable(REPO_ROOT, "custom-python"), "custom-python");
  assert.equal(pythonExecutable(REPO_ROOT, "../.venv/Scripts/python.exe"), path.resolve("../.venv/Scripts/python.exe"));
  const options = parseArgs(["profile"]);
  const plan = selectTests(options, files);
  const steps = createSteps(options, plan, files, REPO_ROOT, "out");
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, "backend");
  assert.equal(steps[0].args.includes("-n"), false);
  assert.ok(steps[0].args.includes("tests/backtest_contract/test_no_lookahead.py"));
  const full = parseArgs(["full"]);
  for (const step of createSteps(full, selectTests(full, files), files, REPO_ROOT, "out")) assert.ok(step.args.join(" ").length < 24_000, step.id);
});

test("runner preserves failing child status, logs and subsequent independent results", async (context) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-test-execution-"));
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const results = await executeSteps([
    { id: "failure", command: process.execPath, args: ["-e", "console.error('expected failure'); process.exitCode=7"], cwd: output },
    { id: "success", command: process.execPath, args: ["-e", "console.log('ran next step')"], cwd: output },
    { id: "missing", command: path.join(output, "nonexistent-executable"), args: [], cwd: output },
  ], output, { echo: false });
  assert.deepEqual(results.map((result) => result.exitCode), [7, 0, 1]);
  assert.match(fs.readFileSync(path.join(output, "failure.log"), "utf8"), /expected failure/);
  assert.match(fs.readFileSync(path.join(output, "success.log"), "utf8"), /ran next step/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "results.json"), "utf8"))[0].exitCode, 7);
});
