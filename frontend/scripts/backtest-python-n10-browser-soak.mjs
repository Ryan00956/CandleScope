#!/usr/bin/env node
/** 4h Python backtest browser/lifecycle soak. Flags are process-only, not source defaults. */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const durationMs = Number(option("--duration-ms", "14400000"));
const sampleMs = Number(option("--sample-ms", "60000"));
const port = Number(option("--port", "15183"));
const output = option(
  "--output",
  resolve("output", "backtest-python-n10-browser-soak-4h.json"),
);
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolvePlaywright() {
  const require = createRequire(import.meta.url);
  const extra = option("--playwright-module", process.env.N10_PLAYWRIGHT_MODULE ?? "");
  const candidates = [
    extra,
    "playwright",
    "playwright-core",
    resolve(frontendRoot, "node_modules", "playwright"),
    resolve(frontendRoot, "node_modules", "playwright-core"),
  ].filter(Boolean);
  for (const name of candidates) {
    try {
      return require.resolve(name);
    } catch {
      /* continue */
    }
  }
  throw new Error("playwright module is not importable");
}

function chromePath() {
  return (
    option("--chrome-path", process.env.N10_CHROME_PATH ?? "") ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  );
}

async function waitHttp(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch {
      /* retry */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main() {
  if (!Number.isFinite(durationMs) || durationMs < 1) {
    throw new Error("--duration-ms must be positive");
  }
  mkdirSync(dirname(output), { recursive: true });
  const playwrightPath = resolvePlaywright();
  const require = createRequire(import.meta.url);
  const playwright = require(playwrightPath);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) {
    throw new Error(`playwright chromium export missing from ${playwrightPath}`);
  }
  const vite = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: frontendRoot,
      env: {
        ...process.env,
        VITE_BACKTEST_ENTRY_ENABLED: "1",
        VITE_BACKTEST_PYTHON_STRATEGY_ENABLED: "1",
        VITE_DEV_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );
  const viteLogs = [];
  vite.stdout.on("data", (chunk) => viteLogs.push(String(chunk)));
  vite.stderr.on("data", (chunk) => viteLogs.push(String(chunk)));
  const samples = [];
  const consoleErrors = [];
  let browser;
  try {
    await waitHttp(`http://127.0.0.1:${port}/backtest.html`);
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath(),
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const started = Date.now();
    let cycle = 0;
    while (Date.now() - started < durationMs) {
      cycle += 1;
      await page.goto(`http://127.0.0.1:${port}/backtest.html`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.waitForSelector("[data-testid='python-strategy-studio'], .backtest-app", {
        timeout: 30_000,
      });
      const studio = await page.locator("[data-testid='python-strategy-studio']").count();
      const disabled = await page.locator(".backtest-disabled").count();
      const heap = await page.evaluate(() => {
        const memory = performance.memory;
        return memory
          ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize }
          : null;
      });
      samples.push({
        cycle,
        elapsedMs: Date.now() - started,
        studio,
        disabled,
        heap,
        consoleErrors: consoleErrors.length,
        url: page.url(),
      });
      writeFileSync(
        output,
        `${JSON.stringify(
          {
            schemaVersion: "candlescope.python-first-browser-soak/1",
            durationMs,
            completed: false,
            cycles: cycle,
            consoleErrors: consoleErrors.length,
            samples,
          },
          null,
          2,
        )}\n`,
      );
      const remaining = durationMs - (Date.now() - started);
      if (remaining <= 0) break;
      await page.waitForTimeout(Math.min(sampleMs, remaining));
    }
    writeFileSync(
      output,
      `${JSON.stringify(
        {
          schemaVersion: "candlescope.python-first-browser-soak/1",
          durationMs,
          elapsedMs: Date.now() - started,
          completed: true,
          ok: consoleErrors.length === 0 && samples.every((item) => item.studio > 0),
          cycles: samples.length,
          consoleErrors: consoleErrors.length,
          samples,
          viteLogs: viteLogs.join("").slice(-4000),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (browser) await browser.close();
    vite.kill();
  }
}

main().catch((error) => {
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        schemaVersion: "candlescope.python-first-browser-soak/1",
        ok: false,
        error: String(error),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
