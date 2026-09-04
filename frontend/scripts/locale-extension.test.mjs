import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("registering an additional catalog enables normalization, switching, formatting and host copy", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-locale-"));
  try {
    fs.cpSync(new URL("../src/i18n/", import.meta.url), path.join(fixtureRoot, "i18n"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, "package.json"), '{"type":"module"}');
    const registryPath = path.join(fixtureRoot, "i18n/registry.ts");
    const registry = fs.readFileSync(registryPath, "utf8");
    const marker = "export const LOCALE_REGISTRY = {";
    assert.ok(registry.includes(marker));
    fs.writeFileSync(registryPath, registry.replace(marker, `${marker}
      id: {
        nativeLabel: "Bahasa Indonesia (fixture)",
        messages: {
          ...en,
          "shell.replay": "Pemutaran uji",
          "status.barCount": "{count} item",
          "workbench.manualHistory.title": "Riwayat uji",
        },
      },
    `));
    fs.writeFileSync(path.join(fixtureRoot, "verify.mjs"), `
      import assert from "node:assert/strict";
      import {
        LOCALE_OPTIONS, getDateTimeLocale, getLocale, getNumberLocale,
        isLocaleId, normalizeLocale, setLocale, subscribeLocale, t, tPlural,
      } from "./i18n/index.ts";
      globalThis.document = { documentElement: {} };
      let notifications = 0;
      const unsubscribe = subscribeLocale(() => { notifications++; });
      assert.equal(isLocaleId("id"), true);
      assert.equal(normalizeLocale("id-ID"), "id");
      assert.ok(LOCALE_OPTIONS.some(option => option.id === "id"));
      setLocale("id-ID");
      assert.equal(getLocale(), "id");
      assert.equal(document.documentElement.lang, "id");
      assert.equal(document.documentElement.dir, "ltr");
      assert.equal(getDateTimeLocale(), "id");
      assert.equal(getNumberLocale(), "id");
      assert.equal(t("shell.replay"), "Pemutaran uji");
      assert.equal(t("workbench.manualHistory.title"), "Riwayat uji");
      assert.equal(tPlural("status.barCount", 1), "1 item");
      setLocale("id");
      assert.equal(notifications, 1);
      setLocale("en");
      assert.equal(t("shell.replay"), "Replay");
      assert.equal(tPlural("status.barCount", 1), "1 bar");
      assert.equal(notifications, 2);
      unsubscribe();
    `);
    execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), path.join(fixtureRoot, "verify.mjs"),
    ], { cwd: fixtureRoot, stdio: "pipe", timeout: 30_000 });
  } finally {
    assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixtureRoot).startsWith("candlescope-locale-"));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
