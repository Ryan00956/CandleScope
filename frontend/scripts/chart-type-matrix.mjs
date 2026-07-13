import { MAIN_CHART_TYPES } from "../src/shared/mainChartTypes.js";

const SYNTHETIC_CHART_TYPES = new Set([
  "renko",
  "point-and-figure",
  "kagi",
  "line-break",
]);

function normalizedTypeIds(values) {
  return Array.isArray(values)
    ? values.filter((value) => typeof value === "string" && value.length > 0)
    : [];
}

export function findMissingChartTypes(actualChartTypes, expectedChartTypes = MAIN_CHART_TYPES) {
  const actual = new Set(normalizedTypeIds(actualChartTypes));
  return normalizedTypeIds(expectedChartTypes).filter((chartType) => !actual.has(chartType));
}

export function summarizeChartTypeMatrixAcceptance({
  expectedChartTypes = MAIN_CHART_TYPES,
  menuChartTypes = [],
  steps = [],
  persistence = null,
} = {}) {
  const expected = normalizedTypeIds(expectedChartTypes);
  const menu = normalizedTypeIds(menuChartTypes);
  const stepTypes = steps.map((step) => step?.chartType).filter(Boolean);
  const missingMenuChartTypes = findMissingChartTypes(menu, expected);
  const missingStepChartTypes = findMissingChartTypes(stepTypes, expected);
  const unexpectedMenuChartTypes = menu.filter((chartType) => !expected.includes(chartType));
  const duplicateMenuChartTypes = menu.filter((chartType, index) => menu.indexOf(chartType) !== index);
  const duplicateStepChartTypes = stepTypes.filter(
    (chartType, index) => stepTypes.indexOf(chartType) !== index,
  );
  const variantContractMatches = menu.length === expected.length
    && menu.every((chartType, index) => chartType === expected[index]);
  const stepsPassed = steps.length === expected.length
    && missingStepChartTypes.length === 0
    && duplicateStepChartTypes.length === 0
    && steps.every((step) => step?.passed === true);
  const persistencePassed = persistence?.passed === true;

  return {
    duplicateMenuChartTypes,
    duplicateStepChartTypes,
    missingMenuChartTypes,
    missingStepChartTypes,
    unexpectedMenuChartTypes,
    variantContractMatches,
    stepsPassed,
    persistencePassed,
    passed: variantContractMatches
      && missingMenuChartTypes.length === 0
      && unexpectedMenuChartTypes.length === 0
      && duplicateMenuChartTypes.length === 0
      && stepsPassed
      && persistencePassed,
  };
}

async function readChartTypeSnapshot(cdp, chartType) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const chartType = ${JSON.stringify(chartType)};
      const pane = document.querySelector('[data-pane-id="single-chart"]');
      const button = document.querySelector('.chart-type-tool-btn');
      const canvases = Array.from(pane?.querySelectorAll('canvas') || [])
        .filter((canvas) => canvas.width > 0 && canvas.height > 0);
      const canvasSignatures = canvases.map((canvas) => {
        let encodedLength = 0;
        let signature = 2166136261;
        try {
          const encoded = canvas.toDataURL('image/png');
          encodedLength = encoded.length;
          const stride = Math.max(1, Math.floor(encoded.length / 128));
          for (let index = 0; index < encoded.length; index += stride) {
            signature ^= encoded.charCodeAt(index);
            signature = Math.imul(signature, 16777619) >>> 0;
          }
        } catch {}
        return {
          width: canvas.width,
          height: canvas.height,
          encodedLength,
          signature,
        };
      });
      const events = window.__CANDLESCOPE_PERF__?.report?.()?.events || [];
      const latestSwitch = [...events].reverse().find((event) => (
        event?.name === 'chart.mainSeries.switch' && event.detail?.to === chartType
      ));
      const renderErrors = events.filter((event) => event?.name === 'chart.candleSeries.renderError');
      let settingsChartType = null;
      try {
        settingsChartType = JSON.parse(
          localStorage.getItem('candlescope-settings') || 'null'
        )?.chartType || null;
      } catch {}
      return {
        chartType,
        paneChartType: pane?.dataset?.chartType || null,
        buttonChartType: button?.dataset?.chartType || null,
        settingsChartType,
        canvasCount: canvases.length,
        canvasPixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
        canvasSignatures,
        latestSwitch: latestSwitch || null,
        renderErrorCount: renderErrors.length,
        syntheticNoticeVisible: Boolean(document.querySelector('.synthetic-chart-notice')),
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || null;
}

async function clickChartType(cdp, waitForExpression, chartType) {
  const openResult = await cdp.send("Runtime.evaluate", {
    expression: "(() => { const button = document.querySelector('.chart-type-tool-btn'); if (!button) return false; button.click(); return true; })()",
    returnByValue: true,
  });
  if (!openResult.result?.value) {
    return { ok: false, chartType, reason: "menu-button-not-found" };
  }
  const opened = await waitForExpression(
    cdp,
    "Boolean(document.querySelector('.chart-type-flyout'))",
    2_000,
    25,
  );
  if (!opened) {
    return { ok: false, chartType, reason: "flyout-did-not-open" };
  }

  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const chartType = ${JSON.stringify(chartType)};
      const variants = Array.from(document.querySelectorAll('.chart-type-flyout [data-tool-variant]'));
      const target = variants.find((element) => element.dataset.toolVariant === chartType);
      if (!target) {
        document.querySelector('.chart-type-tool-btn')?.click();
        return {
          ok: false,
          reason: 'variant-not-found',
          variantIds: variants.map((element) => element.dataset.toolVariant),
        };
      }
      const variantIds = variants.map((element) => element.dataset.toolVariant);
      target.click();
      return { ok: true, chartType, variantIds };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, chartType, reason: "evaluation-failed" };
}

async function verifyChartTypeMenuSelection(cdp, waitForExpression, chartType) {
  const openResult = await cdp.send("Runtime.evaluate", {
    expression: "(() => { const button = document.querySelector('.chart-type-tool-btn'); if (!button) return false; button.click(); return true; })()",
    returnByValue: true,
  });
  if (!openResult.result?.value) return false;
  const opened = await waitForExpression(
    cdp,
    "Boolean(document.querySelector('.chart-type-flyout'))",
    2_000,
    25,
  );
  if (!opened) return false;

  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const chartType = ${JSON.stringify(chartType)};
      const menuButton = document.querySelector('.chart-type-tool-btn');
      if (!menuButton) return false;
      const target = document.querySelector(
        '.chart-type-flyout [data-tool-variant="' + chartType + '"]'
      );
      const selected = Boolean(target?.classList.contains('selected'));
      menuButton.click();
      return selected;
    })()`,
    returnByValue: true,
  });
  return Boolean(result.result?.value);
}

export async function runChartTypeMatrix({
  args,
  cdp,
  consoleMessages = [],
  wait,
  waitForChartReady,
  waitForExpression,
}) {
  const steps = [];
  let menuChartTypes = null;
  const initialStateResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      chartType: document.querySelector('[data-pane-id="single-chart"]')?.dataset?.chartType || 'candlestick',
      visibleRanges: localStorage.getItem('candlescope-visible-ranges'),
    }))()`,
    returnByValue: true,
  });
  const initialState = initialStateResult.result?.value || {
    chartType: "candlestick",
    visibleRanges: null,
  };

  for (const chartType of MAIN_CHART_TYPES) {
    const startedAtMs = Date.now();
    const consoleStart = consoleMessages.length;
    const click = await clickChartType(cdp, waitForExpression, chartType);
    if (!menuChartTypes && click.variantIds) menuChartTypes = click.variantIds;

    const active = click.ok && await waitForExpression(
      cdp,
      `(() => {
        const type = ${JSON.stringify(chartType)};
        const pane = document.querySelector('[data-pane-id="single-chart"]');
        const button = document.querySelector('.chart-type-tool-btn');
        const canvases = Array.from(pane?.querySelectorAll('canvas') || []);
        return pane?.dataset?.chartType === type
          && button?.dataset?.chartType === type
          && canvases.some((canvas) => canvas.width > 0 && canvas.height > 0);
      })()`,
      Math.min(args.timeoutMs, 15_000),
      50,
    );
    await wait(250);
    const snapshot = await readChartTypeSnapshot(cdp, chartType);
    const menuSelected = active
      ? await verifyChartTypeMenuSelection(cdp, waitForExpression, chartType)
      : false;
    const consoleIssues = consoleMessages.slice(consoleStart).filter((message) => (
      message.type === "error"
      || /failed to switch main chart type|rendererror/i.test(message.text || "")
    ));
    const expectsSyntheticNotice = SYNTHETIC_CHART_TYPES.has(chartType);
    const passed = Boolean(
      click.ok
      && active
      && menuSelected
      && snapshot?.canvasCount > 0
      && snapshot?.canvasPixels > 0
      && snapshot?.canvasSignatures?.every((item) => item.encodedLength > 0)
      && snapshot?.settingsChartType === chartType
      && snapshot?.renderErrorCount === 0
      && snapshot?.syntheticNoticeVisible === expectsSyntheticNotice
      && consoleIssues.length === 0
    );
    steps.push({
      chartType,
      elapsedMs: Date.now() - startedAtMs,
      click,
      active,
      menuSelected,
      snapshot,
      consoleIssues,
      passed,
    });
  }

  await cdp.send("Page.reload", { ignoreCache: true });
  const reloadReady = await waitForChartReady(cdp, args.timeoutMs);
  const expectedPersistedType = MAIN_CHART_TYPES.at(-1);
  const persistedChartType = await readChartTypeSnapshot(cdp, expectedPersistedType);
  const persisted = reloadReady.loadedAt != null
    && persistedChartType?.paneChartType === expectedPersistedType
    && persistedChartType?.buttonChartType === expectedPersistedType
    && persistedChartType?.canvasCount > 0;
  const persistence = {
    expected: expectedPersistedType,
    actual: persistedChartType?.paneChartType || null,
    loadedAtMs: reloadReady.loadedAt,
    passed: persisted,
  };
  const acceptance = summarizeChartTypeMatrixAcceptance({
    expectedChartTypes: MAIN_CHART_TYPES,
    menuChartTypes,
    steps,
    persistence,
  });
  const restoredType = MAIN_CHART_TYPES.includes(initialState.chartType)
    ? initialState.chartType
    : MAIN_CHART_TYPES[0];
  const restoreClick = await clickChartType(cdp, waitForExpression, restoredType);
  const restoreActive = restoreClick.ok && await waitForExpression(
    cdp,
    `(() => {
      const type = ${JSON.stringify(restoredType)};
      return document.querySelector('[data-pane-id="single-chart"]')?.dataset?.chartType === type
        && document.querySelector('.chart-type-tool-btn')?.dataset?.chartType === type;
    })()`,
    Math.min(args.timeoutMs, 15_000),
    50,
  );
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const value = ${JSON.stringify(initialState.visibleRanges)};
      if (value == null) localStorage.removeItem('candlescope-visible-ranges');
      else localStorage.setItem('candlescope-visible-ranges', value);
      return true;
    })()`,
    returnByValue: true,
  });
  await cdp.send("Page.reload", { ignoreCache: true });
  const restorationReload = await waitForChartReady(cdp, args.timeoutMs);
  const restoredSnapshot = await readChartTypeSnapshot(cdp, restoredType);
  const restoration = {
    expected: restoredType,
    actual: restoredSnapshot?.paneChartType || null,
    loadedAtMs: restorationReload.loadedAt,
    passed: Boolean(
      restoreActive
      && restorationReload.loadedAt != null
      && restoredSnapshot?.settingsChartType === restoredType
      && restoredSnapshot?.canvasCount > 0
      && restoredSnapshot?.renderErrorCount === 0
    ),
  };

  return {
    expectedChartTypes: MAIN_CHART_TYPES,
    menuChartTypes,
    variantContractMatches: acceptance.variantContractMatches,
    steps,
    persistence,
    restoration,
    acceptance,
    passed: acceptance.passed && restoration.passed,
  };
}
