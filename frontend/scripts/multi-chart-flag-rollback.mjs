import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  buildWorkspaceBootstrap,
  connectWebSocket,
  evaluate,
  evaluateAsyncJson,
  findChrome,
} from "./multi-chart-capacity.mjs";

export const FLAG_ROLLBACK_SCHEMA = "candlescope.multi-chart.flag-rollback/1";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error(`${url} timed out`)));
    request.on("error", reject);
  });
}

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await httpJson(url);
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function cellIds(record) {
  return Object.keys(record?.document?.cells ?? {}).sort();
}

function layoutCellIds(node, result = []) {
  if (node?.kind === "cell") result.push(node.cellId);
  else if (node?.kind === "split") {
    layoutCellIds(node.first, result);
    layoutCellIds(node.second, result);
  }
  return result;
}

export function evaluateFlagRollback({ inputRecord, v1Record, v6Record, browser }) {
  const inputIds = cellIds(inputRecord);
  const v6Ids = cellIds(v6Record);
  const inputLayoutIds = layoutCellIds(inputRecord?.document?.windows?.["main-window"]?.layoutTree).sort();
  const v6LayoutIds = layoutCellIds(v6Record?.document?.windows?.["main-window"]?.layoutTree).sort();
  const checks = {
    visibleCells: {
      actual: browser.visibleCellIds,
      expected: "exact four-cell default-off projection",
      passed: browser.visibleCellIds?.length === 4,
    },
    v6DocumentPreserved: {
      actual: { cellIds: v6Ids, layoutCellIds: v6LayoutIds },
      expected: { cellIds: inputIds, layoutCellIds: inputLayoutIds },
      passed: JSON.stringify(v6Ids) === JSON.stringify(inputIds)
        && JSON.stringify(v6LayoutIds) === JSON.stringify(inputLayoutIds),
    },
    v5SourcePreserved: {
      actual: sha256Json(v1Record),
      expected: sha256Json(inputRecord),
      passed: sha256Json(v1Record) === sha256Json(inputRecord),
    },
    defaultFlagsDisabled: {
      actual: browser.layoutOptions,
      expected: "no layout preset above four cells",
      passed: browser.layoutOptions.every((label) => !/六图|八图|九图|十二图|十六图/.test(label)),
    },
    browserErrors: {
      actual: browser.errors,
      expected: [],
      passed: browser.errors.length === 0,
    },
  };
  return {
    checks,
    result: Object.values(checks).every((check) => check.passed) ? "pass" : "fail",
  };
}

function parseArgs(argv) {
  const args = {
    url: "http://127.0.0.1:15173/",
    out: "docs/perf-baselines/multi-chart-workspace/phase5-flag-rollback.json",
    screenshot: "output/playwright/multi-chart-flag-rollback.png",
    timeoutMs: 60_000,
    chromePath: "",
  };
  const next = (index, name) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--url") args.url = next(index++, value);
    else if (value === "--out") args.out = next(index++, value);
    else if (value === "--screenshot") args.screenshot = next(index++, value);
    else if (value === "--timeout-ms") args.timeoutMs = Number(next(index++, value));
    else if (value === "--chrome") args.chromePath = next(index++, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null) return;
  chrome.kill();
  await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), wait(3_000)]);
  if (chrome.exitCode === null && process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

export async function run(argv) {
  const args = parseArgs(argv);
  const chromePath = findChrome(args.chromePath);
  if (!chromePath) throw new Error("Chrome or Edge not found; pass --chrome");
  const bootstrap = buildWorkspaceBootstrap({ cells: 16, scenario: "S1" });
  const debugPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "candlescope-flag-rollback-"));
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-size=1920,1080",
    "about:blank",
  ], { stdio: "ignore", windowsHide: false });
  let cdp;
  const errors = [];
  try {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json`, args.timeoutMs);
    const page = targets.find((target) => target.type === "page") ?? targets[0];
    cdp = await connectWebSocket(page.webSocketDebuggerUrl);
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error") errors.push({ type: "console", args: event.args?.map((arg) => arg.value ?? arg.description) });
    });
    cdp.on("Runtime.exceptionThrown", (event) => errors.push({
      type: "exception",
      text: event.exceptionDetails?.text ?? null,
      description: event.exceptionDetails?.exception?.description ?? null,
    }));
    await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable")]);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const record = ${JSON.stringify(bootstrap.record)};
        const library = ${JSON.stringify(bootstrap.library)};
        localStorage.setItem('candlescope-active-workspace-id-v1', record.id);
        localStorage.setItem('candlescope-active-workspace-bootstrap-v1', JSON.stringify(record));
        localStorage.setItem('candlescope-workspace-library-fallback-v1', JSON.stringify(library));
      })();`,
    });
    await cdp.send("Page.navigate", { url: args.url });
    const startedAt = Date.now();
    let visibleCellCount = 0;
    while (Date.now() - startedAt < args.timeoutMs) {
      visibleCellCount = Number(await evaluate(cdp, "document.querySelectorAll('.multi-chart-cell').length"));
      if (visibleCellCount === 4) break;
      await wait(100);
    }
    if (visibleCellCount !== 4) throw new Error(`default-off projection exposed ${visibleCellCount} cells`);
    await wait(4_000);
    const browser = await evaluateAsyncJson(cdp, `async () => {
      const open = (name) => new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const requestValue = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const database = await open('candlescope-chart-workspaces-v6');
      const transaction = database.transaction('workspaces-v6', 'readonly');
      const records = await requestValue(transaction.objectStore('workspaces-v6').getAll());
      database.close();
      return {
        visibleCellIds: Array.from(document.querySelectorAll('.multi-chart-cell')).map((node) => node.getAttribute('data-chart-cell-id')),
        layoutOptions: Array.from(document.querySelectorAll('.workspace-layout-controls button')).map((node) => node.textContent?.trim() || ''),
        v1Record: JSON.parse(localStorage.getItem('candlescope-active-workspace-bootstrap-v1') || 'null'),
        v6Record: records.find((record) => record.id === 'workspace-capacity-phase0') || null,
      };
    }`);
    browser.errors = errors;
    const evaluation = evaluateFlagRollback({
      inputRecord: bootstrap.record,
      v1Record: browser.v1Record,
      v6Record: browser.v6Record,
      browser,
    });
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const screenshotPath = path.resolve(args.screenshot);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    const evidence = {
      schemaVersion: FLAG_ROLLBACK_SCHEMA,
      generatedAt: new Date().toISOString(),
      build: { multiChart16Enabled: false, chartWindowBrokerEnabled: false, klineBatchEnabled: false },
      source: {
        inputDocumentSha256: sha256Json(bootstrap.record.document),
        inputCellCount: cellIds(bootstrap.record).length,
        inputLayoutCellCount: layoutCellIds(bootstrap.record.document.windows["main-window"].layoutTree).length,
      },
      browser: {
        visibleCellIds: browser.visibleCellIds,
        layoutOptions: browser.layoutOptions,
        errors,
      },
      persisted: {
        v1RecordSha256: sha256Json(browser.v1Record),
        v6DocumentSha256: sha256Json(browser.v6Record?.document),
        v6CellCount: cellIds(browser.v6Record).length,
        v6LayoutCellCount: layoutCellIds(browser.v6Record?.document?.windows?.["main-window"]?.layoutTree).length,
      },
      artifacts: { screenshot: screenshotPath },
      ...evaluation,
    };
    const outputPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ out: outputPath, result: evidence.result })}\n`);
    return evidence.result === "pass" ? 0 : 1;
  } finally {
    cdp?.close();
    await stopChrome(chrome);
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => { console.error(error); process.exitCode = 1; },
  );
}
