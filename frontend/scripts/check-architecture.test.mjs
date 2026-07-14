import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runArchitectureCheck, sourceFileKind } from "./check-architecture.mjs";

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
