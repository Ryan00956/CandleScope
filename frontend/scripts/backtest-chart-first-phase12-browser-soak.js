/**
 * Playwright CLI function for the chart-first Phase 12 browser soak.
 *
 * Run with:
 * playwright-cli -s=<session> run-code --filename=<this-file>
 */
async (page) => {
  const control = await page.evaluate(() => ({
    origin: location.origin,
    params: Object.fromEntries(new URL(location.href).searchParams.entries()),
  }));
  const durationMs = Number(control.params.soakDurationMs ?? "3600000");
  const sampleMs = Number(control.params.soakSampleMs ?? "60000");
  const reloadEvery = Number(control.params.soakReloadEvery ?? "10");
  const baseUrl = control.origin;
  const contextId =
    control.params.context ?? "brc_ed558ba3b32242b2beea774b8168c7ee";
  const runId =
    control.params.soakRun ?? "bt_e1b30fd8dead421eb55419362dfe5493";
  const screenshots = {
    start: "output/playwright/phase12/soak-start.png",
    middle: "output/playwright/phase12/soak-middle.png",
    end: "output/playwright/phase12/soak-end.png",
  };
  const tabs = ["SUMMARY", "TRADES", "TRACE", "COMPARE", "QUALITY"];
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const samples = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      failure: request.failure()?.errorText ?? "unknown",
    });
  });

  const selectCompletedRun = async () => {
    const runButton = page
      .locator("button")
      .filter({ hasText: runId })
      .first();
    await runButton.waitFor({ state: "visible", timeout: 30_000 });
    await runButton.click();
    await page.waitForFunction(
      (selectedRunId) =>
        document.body.innerText.includes(selectedRunId) &&
        document.querySelectorAll("canvas").length > 0,
      runId,
      { timeout: 30_000 },
    );
  };

  const loadResearch = async () => {
    await page.goto(`${baseUrl}/backtest.html?context=${contextId}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await selectCompletedRun();
  };

  await page.setViewportSize({ width: 1366, height: 768 });
  await loadResearch();
  await page.screenshot({ path: screenshots.start, type: "png" });

  const startedAtMs = Date.now();
  const expectedSamples = Math.floor(durationMs / sampleMs) + 1;
  for (let ordinal = 0; ordinal < expectedSamples; ordinal += 1) {
    const targetElapsedMs = ordinal * sampleMs;
    const waitMs = targetElapsedMs - (Date.now() - startedAtMs);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    if (ordinal > 0 && ordinal % reloadEvery === 0) await loadResearch();

    const tab = tabs[ordinal % tabs.length];
    const tabButton = page.getByRole("button", { name: tab, exact: true });
    if ((await tabButton.count()) > 0) await tabButton.click();

    const [capabilities, run] = await Promise.all([
      page.request.get(`${baseUrl}/api/v1/backtests/capabilities`),
      page.request.get(`${baseUrl}/api/v1/backtests/runs/${runId}`),
    ]);
    const state = await page.evaluate((selectedRunId) => {
      const memory = performance.memory;
      const buttonTexts = [...document.querySelectorAll("button")].map((element) =>
        (element.textContent ?? "").trim(),
      );
      return {
        readyState: document.readyState,
        title: document.title,
        runSelected: document.body.innerText.includes(selectedRunId),
        completedVisible: document.body.innerText.includes("COMPLETED"),
        canvasCount: document.querySelectorAll("canvas").length,
        svgCount: document.querySelectorAll("svg").length,
        buttonCount: buttonTexts.length,
        resultTabs: buttonTexts.filter((text) =>
          ["SUMMARY", "TRADES", "TRACE", "COMPARE", "QUALITY"].includes(text),
        ),
        heap: memory
          ? {
              usedJSHeapSize: memory.usedJSHeapSize,
              totalJSHeapSize: memory.totalJSHeapSize,
            }
          : null,
      };
    }, runId);
    samples.push({
      ordinal,
      elapsedMs: Date.now() - startedAtMs,
      tab,
      capabilitiesStatus: capabilities.status(),
      runStatus: run.status(),
      ...state,
    });

    if (ordinal === Math.floor(expectedSamples / 2)) {
      await page.screenshot({ path: screenshots.middle, type: "png" });
    }
  }

  await selectCompletedRun();
  await page.screenshot({ path: screenshots.end, type: "png" });
  const elapsedMs = Date.now() - startedAtMs;
  const heaps = samples
    .map((sample) => sample.heap?.usedJSHeapSize)
    .filter((value) => Number.isFinite(value));
  const firstHeap = heaps[0] ?? null;
  const lastHeap = heaps.at(-1) ?? null;
  const maxHeap = heaps.length > 0 ? Math.max(...heaps) : null;
  const heapGrowthBytes =
    firstHeap !== null && lastHeap !== null ? lastHeap - firstHeap : null;
  const sampleFailures = samples.filter(
    (sample) =>
      sample.readyState !== "complete" ||
      !sample.runSelected ||
      !sample.completedVisible ||
      sample.canvasCount < 1 ||
      sample.resultTabs.length !== tabs.length ||
      sample.capabilitiesStatus !== 200 ||
      sample.runStatus !== 200,
  );
  const heapBoundBytes =
    firstHeap === null ? null : Math.max(firstHeap * 2, firstHeap + 128 * 1024 * 1024);
  const heapBounded =
    lastHeap === null || heapBoundBytes === null ? true : lastHeap <= heapBoundBytes;

  return {
    schemaVersion: "candlescope.backtest-chart-first-browser-soak/1",
    durationTargetMs: durationMs,
    elapsedMs,
    completed: elapsedMs >= durationMs,
    ok:
      elapsedMs >= durationMs &&
      samples.length === expectedSamples &&
      sampleFailures.length === 0 &&
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      requestFailures.length === 0 &&
      heapBounded,
    contextId,
    runId,
    sampleCount: samples.length,
    reloadCount: Math.floor((samples.length - 1) / reloadEvery),
    firstHeap,
    lastHeap,
    maxHeap,
    heapGrowthBytes,
    heapBoundBytes,
    heapBounded,
    sampleFailures,
    consoleErrors,
    pageErrors,
    requestFailures,
    screenshots,
    samples,
  };
}
