import fs from "node:fs";
import path from "node:path";

function requireDependency(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`runExportMatrix requires ${name}`);
  }
  return value;
}

export function hasExpectedImageMagic(buffer, format) {
  if (!buffer) return false;
  if (format === "png") {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (format === "jpeg") {
    return buffer.length >= 3
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff;
  }
  if (format === "webp") {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

export function summarizeExportMatrixAcceptance({
  cases = [],
  scopeDimensions = {},
  panelClosed = false,
  error = "",
} = {}) {
  const failedCases = cases
    .filter((item) => !item?.passed)
    .map((item) => `${item?.scope || "unknown"}:${item?.format || "unknown"}`);
  const scopeDimensionsPassed = Boolean(
    scopeDimensions.mainPaneShorterThanChart
    && scopeDimensions.pageLargerThanChart
  );
  const passed = cases.length > 0
    && failedCases.length === 0
    && scopeDimensionsPassed
    && panelClosed
    && !error;
  return {
    caseCount: cases.length,
    passedCaseCount: cases.length - failedCases.length,
    failedCases,
    scopeDimensionsPassed,
    panelClosed: Boolean(panelClosed),
    error: error || "",
    passed,
  };
}

export function summarizeHiddenSceneRuntimeRetirement({
  handleAvailable = false,
  readerAvailable = false,
  runtime = null,
  error = "",
} = {}) {
  const runtimeRetired = Boolean(
    runtime
    && runtime.scenePublicationReady === false
    && runtime.queueDepthCurrent === 0
    && runtime.inFlightCurrent === 0
    && runtime.lastRequestedStamp === null
    && runtime.lastPublishedStamp === null
  );
  return {
    handleAvailable: Boolean(handleAvailable),
    readerAvailable: Boolean(readerAvailable),
    runtime: runtime || null,
    error: error || "",
    // Performance instrumentation is optional in production builds. Once the
    // handle exists, however, retirement evidence is mandatory and fail-closed.
    passed: !handleAvailable || (readerAvailable && !error && runtimeRetired),
  };
}

export async function waitForStableHiddenSceneRuntimeRetirement({
  readSample,
  wait,
  timeoutMs = 10_000,
  sampleIntervalMs = 100,
  requiredStableSamples = 2,
  now = Date.now,
} = {}) {
  if (typeof readSample !== "function") {
    throw new TypeError("waitForStableHiddenSceneRuntimeRetirement requires readSample");
  }
  if (typeof wait !== "function") {
    throw new TypeError("waitForStableHiddenSceneRuntimeRetirement requires wait");
  }
  const required = Math.max(2, Math.floor(Number(requiredStableSamples) || 2));
  const timeout = Math.max(1, Number(timeoutMs) || 10_000);
  const interval = Math.max(0, Number(sampleIntervalMs) || 0);
  const started = now();
  let stableSampleCount = 0;
  let sampleCount = 0;
  let lastSample = null;

  while (now() - started < timeout) {
    lastSample = await readSample();
    sampleCount += 1;
    if (lastSample?.passed === true && lastSample?.previewIdle === true) {
      stableSampleCount += 1;
      if (stableSampleCount >= required) {
        return {
          ...lastSample,
          stableSampleCount,
          requiredStableSamples: required,
          sampleCount,
          elapsedMs: now() - started,
          passed: true,
        };
      }
    } else {
      stableSampleCount = 0;
    }
    await wait(interval);
  }

  return {
    ...(lastSample || summarizeHiddenSceneRuntimeRetirement()),
    previewIdle: lastSample?.previewIdle === true,
    stableSampleCount,
    requiredStableSamples: required,
    sampleCount,
    elapsedMs: now() - started,
    passed: false,
  };
}

export async function runExportMatrix({
  cdp,
  args,
  downloadDir,
  clickSelector,
  wait,
  waitForExpression,
  waitForSelector,
  getRuntimeIssueCount = () => 0,
} = {}) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new TypeError("runExportMatrix requires cdp");
  }
  const click = requireDependency("clickSelector", clickSelector);
  const delay = requireDependency("wait", wait);
  const waitExpression = requireDependency("waitForExpression", waitForExpression);
  const waitSelector = requireDependency("waitForSelector", waitForSelector);
  const timeoutMs = Number(args?.timeoutMs) || 45_000;

  async function setExportChoice(attribute, value) {
    const selector = `[${attribute}=${JSON.stringify(value)}]`;
    const clicked = await click(cdp, selector);
    if (!clicked) return false;
    return waitExpression(
      cdp,
      `document.querySelector(${JSON.stringify(selector)})?.classList.contains('active') === true`,
      2_000,
      25,
    );
  }

  async function setExportCheckbox(option, checked) {
    const selector = `[data-export-option=${JSON.stringify(option)}]`;
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        if (input.checked !== ${checked ? "true" : "false"}) input.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (!result.result?.value) return false;
    return waitExpression(
      cdp,
      `document.querySelector(${JSON.stringify(selector)})?.checked === ${checked ? "true" : "false"}`,
      2_000,
      25,
    );
  }

  async function setExportText(option, value) {
    const selector = `[data-export-option=${JSON.stringify(option)}]`;
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input),
          'value'
        )?.set;
        setter?.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    });
    if (!result.result?.value) return false;
    return waitExpression(
      cdp,
      `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
      2_000,
      25,
    );
  }

  async function readHiddenSceneRuntimeRetirement() {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const frame = document.querySelector('.export-preview-frame');
        const save = document.querySelector('[data-export-action="save"]');
        const previewError = document.querySelector('.export-preview-error')?.textContent?.trim() || '';
        const panelError = document.querySelector('.export-panel-message.error')?.textContent?.trim() || '';
        const previewIdle = Boolean(
          frame
          && save
          && !frame.classList.contains('loading')
          && !frame.classList.contains('stale')
          && !save.disabled
          && !previewError
          && !panelError
        );
        const handle = window.__CANDLESCOPE_DRAWING_PERF__;
        if (!handle) {
          return { handleAvailable: false, readerAvailable: false, runtime: null, error: '', previewIdle };
        }
        const reader = handle.readPhase6Runtime;
        if (typeof reader !== 'function') {
          return { handleAvailable: true, readerAvailable: false, runtime: null, error: '', previewIdle };
        }
        try {
          const runtime = reader.call(handle);
          return {
            handleAvailable: true,
            readerAvailable: true,
            runtime: runtime ? {
              scenePublicationReady: runtime.scenePublicationReady,
              queueDepthCurrent: runtime.queueDepthCurrent,
              inFlightCurrent: runtime.inFlightCurrent,
              lastRequestedStamp: runtime.lastRequestedStamp,
              lastPublishedStamp: runtime.lastPublishedStamp,
            } : null,
            error: '',
            previewIdle,
          };
        } catch (error) {
          return {
            handleAvailable: true,
            readerAvailable: true,
            runtime: null,
            error: error?.message || String(error),
            previewIdle,
          };
        }
      })()`,
      returnByValue: true,
    });
    const sample = result.result?.value || {};
    return {
      ...summarizeHiddenSceneRuntimeRetirement(sample),
      previewIdle: sample.previewIdle === true,
    };
  }

  async function waitForHiddenSceneRuntimeRetirement() {
    return waitForStableHiddenSceneRuntimeRetirement({
      readSample: readHiddenSceneRuntimeRetirement,
      wait: delay,
      timeoutMs: Math.min(timeoutMs, 15_000),
      sampleIntervalMs: 100,
      requiredStableSamples: 2,
    });
  }

  async function readExportPreview() {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const image = document.querySelector('.export-preview-image');
        const save = document.querySelector('[data-export-action="save"]');
        const panelError = document.querySelector('.export-panel-message.error')?.textContent?.trim() || '';
        const previewError = document.querySelector('.export-preview-error')?.textContent?.trim() || '';
        if (!image?.src) {
          return {
            ready: false,
            saveDisabled: save?.disabled ?? true,
            loading: Boolean(document.querySelector('.export-preview-frame.loading')),
            error: panelError || previewError,
          };
        }
        try {
          const response = await fetch(image.src);
          const blob = await response.blob();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let signature = 2166136261;
          for (let index = 0; index < bytes.length; index += 1) {
            signature ^= bytes[index];
            signature = Math.imul(signature, 16777619) >>> 0;
          }
          return {
            ready: !save?.disabled && !panelError && !previewError,
            saveDisabled: save?.disabled ?? true,
            loading: Boolean(document.querySelector('.export-preview-frame.loading')),
          error: panelError || previewError,
          filename: document.querySelector('.export-preview-filename')?.textContent?.trim() || '',
          activeFormat: document.querySelector('[data-export-format].active')?.dataset?.exportFormat || '',
          activeScope: document.querySelector('[data-export-scope].active')?.dataset?.exportScope || '',
          mimeType: blob.type,
            size: blob.size,
            signature,
            width: image.naturalWidth,
            height: image.naturalHeight,
          };
        } catch (error) {
          return { ready: false, error: error?.message || String(error) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return result.result?.value || null;
  }

  async function waitForExportPreview({
    format,
    scope,
    previousSignature = null,
    timeout: previewTimeoutMs = 15_000,
  } = {}) {
    const started = Date.now();
    let preview = null;
    const expectedMimeType = {
      png: "image/png",
      jpeg: "image/jpeg",
      webp: "image/webp",
    }[format];
    while (Date.now() - started < previewTimeoutMs) {
      preview = await readExportPreview();
      if (
        preview?.ready
        && preview.size > 0
        && preview.width > 0
        && preview.height > 0
        && (!expectedMimeType || preview.mimeType === expectedMimeType)
        && (!format || preview.activeFormat === format)
        && (!scope || preview.activeScope === scope)
        && (previousSignature == null || preview.signature !== previousSignature)
      ) {
        return { ...preview, elapsedMs: Date.now() - started };
      }
      await delay(100);
    }
    return { ...(preview || {}), ready: false, elapsedMs: Date.now() - started };
  }

  async function waitForDownload(filename, format, downloadTimeoutMs = 10_000) {
    const target = path.join(downloadDir, filename);
    const started = Date.now();
    while (Date.now() - started < downloadTimeoutMs) {
      try {
        const stats = fs.statSync(target);
        if (stats.isFile() && stats.size > 0) {
          const buffer = fs.readFileSync(target);
          return {
            path: target,
            size: stats.size,
            magicValid: hasExpectedImageMagic(buffer, format),
            elapsedMs: Date.now() - started,
          };
        }
      } catch {
        // The download may still be moving from its temporary browser filename.
      }
      await delay(100);
    }
    return { path: target, size: 0, magicValid: false, elapsedMs: Date.now() - started };
  }

  async function saveExportPreview(format, preview) {
    const clicked = await click(cdp, '[data-export-action="save"]');
    const download = clicked && preview?.filename
      ? await waitForDownload(preview.filename, format)
      : null;
    return {
      clicked,
      filename: preview?.filename || "",
      download,
      passed: Boolean(clicked && download?.size > 0 && download?.magicValid),
    };
  }

  async function observeExportPreviewInvalidation() {
    return waitExpression(
      cdp,
      `(() => {
        const save = document.querySelector('[data-export-action="save"]');
        const frame = document.querySelector('.export-preview-frame');
        return Boolean(save?.disabled || frame?.classList.contains('loading') || frame?.classList.contains('stale'));
      })()`,
      2_000,
      25,
    );
  }

  async function configureExportCase({ scope, format, hideDrawings, watermarkEnabled, watermarkText }) {
    const scopeSelected = await setExportChoice("data-export-scope", scope);
    const formatSelected = await setExportChoice("data-export-format", format);
    const hideDrawingsSelected = await setExportCheckbox("hide-drawings", hideDrawings);
    const watermarkSelected = await setExportCheckbox("watermark-enabled", watermarkEnabled);
    const watermarkTextSet = watermarkEnabled && watermarkText != null
      ? await setExportText("watermark-text", watermarkText)
      : true;
    return {
      scopeSelected,
      formatSelected,
      hideDrawingsSelected,
      watermarkSelected,
      watermarkTextSet,
      passed: scopeSelected
        && formatSelected
        && hideDrawingsSelected
        && watermarkSelected
        && watermarkTextSet,
    };
  }

  const panelButtonClicked = await click(cdp, '[data-drawing-action="export"]');
  const panelOpened = panelButtonClicked && await waitSelector(cdp, ".export-workspace", 10_000);
  if (!panelOpened) {
    return {
      panelButtonClicked,
      panelOpened: false,
      cases: [],
      acceptance: summarizeExportMatrixAcceptance(),
      passed: false,
    };
  }

  const cases = [];
  let runtimeIssueCount = getRuntimeIssueCount();
  const pngConfig = await configureExportCase({
    scope: "chart",
    format: "png",
    hideDrawings: false,
    watermarkEnabled: false,
  });
  const pngPreview = await waitForExportPreview({
    format: "png",
    scope: "chart",
    timeout: Math.min(timeoutMs, 20_000),
  });
  const pngDownload = await saveExportPreview("png", pngPreview);
  const pngRuntimeIssueCount = getRuntimeIssueCount();
  cases.push({
    scope: "chart",
    format: "png",
    config: pngConfig,
    preview: pngPreview,
    save: pngDownload,
    runtimeIssues: pngRuntimeIssueCount - runtimeIssueCount,
    passed: pngConfig.passed && pngPreview.mimeType === "image/png" && pngDownload.passed,
  });
  runtimeIssueCount = pngRuntimeIssueCount;

  const jpegScopeSelected = await setExportChoice("data-export-scope", "main-pane");
  const jpegInvalidated = await observeExportPreviewInvalidation();
  const jpegFormatSelected = await setExportChoice("data-export-format", "jpeg");
  const jpegTransparentDisabled = await waitExpression(
    cdp,
    `document.querySelector('[data-export-option="background"] option[value="transparent"]')?.disabled === true`,
    2_000,
    25,
  );
  const jpegPreview = await waitForExportPreview({
    format: "jpeg",
    scope: "main-pane",
    previousSignature: pngPreview.signature,
    timeout: Math.min(timeoutMs, 20_000),
  });
  const jpegDownload = await saveExportPreview("jpeg", jpegPreview);
  const jpegRuntimeIssueCount = getRuntimeIssueCount();
  cases.push({
    scope: "main-pane",
    format: "jpeg",
    config: { scopeSelected: jpegScopeSelected, formatSelected: jpegFormatSelected },
    previewInvalidated: jpegInvalidated,
    transparentDisabled: jpegTransparentDisabled,
    preview: jpegPreview,
    save: jpegDownload,
    runtimeIssues: jpegRuntimeIssueCount - runtimeIssueCount,
    passed: jpegScopeSelected
      && jpegFormatSelected
      && jpegInvalidated
      && jpegTransparentDisabled
      && jpegPreview.mimeType === "image/jpeg"
      && jpegDownload.passed,
  });
  runtimeIssueCount = jpegRuntimeIssueCount;

  const webpBaseConfig = await configureExportCase({
    scope: "page",
    format: "webp",
    hideDrawings: false,
    watermarkEnabled: false,
  });
  const webpBasePreview = await waitForExportPreview({
    format: "webp",
    scope: "page",
    previousSignature: jpegPreview.signature,
    timeout: Math.min(timeoutMs, 20_000),
  });
  const webpFinalConfig = await configureExportCase({
    scope: "page",
    format: "webp",
    hideDrawings: true,
    watermarkEnabled: true,
    watermarkText: "CandleScope release acceptance",
  });
  const webpInvalidated = await observeExportPreviewInvalidation();
  const webpPreview = await waitForExportPreview({
    format: "webp",
    scope: "page",
    previousSignature: webpBasePreview.signature,
    timeout: Math.min(timeoutMs, 20_000),
  });
  const drawingsRestored = await waitExpression(
    cdp,
    `!document.querySelector('[data-drawing-action="toggle-hidden"]')?.classList.contains('active')`,
    2_000,
    25,
  );
  const webpDownload = await saveExportPreview("webp", webpPreview);

  // A globally hidden scene normally owns no active exact-paint runtime. Both
  // export option states must temporarily publish an exact empty scene, then
  // restore the ordinary globally-hidden lifecycle after each preview lease.
  const globalHideClicked = await click(cdp, '[data-drawing-action="toggle-hidden"]');
  const globalHideActive = globalHideClicked && await waitExpression(
    cdp,
    `document.querySelector('[data-drawing-action="toggle-hidden"]')?.classList.contains('active') === true`,
    2_000,
    25,
  );
  const globalHiddenBaseConfig = await configureExportCase({
    scope: "page",
    format: "webp",
    hideDrawings: false,
    watermarkEnabled: false,
  });
  const globalHiddenBasePreview = await waitForExportPreview({
    format: "webp",
    scope: "page",
    previousSignature: webpPreview.signature,
    timeout: Math.min(timeoutMs, 20_000),
  });
  const globalHiddenBaseRuntimeRetirement = globalHiddenBasePreview.ready
    ? await waitForHiddenSceneRuntimeRetirement()
    : summarizeHiddenSceneRuntimeRetirement();
  const globalHiddenAfterBase = await waitExpression(
    cdp,
    `document.querySelector('[data-drawing-action="toggle-hidden"]')?.classList.contains('active') === true`,
    2_000,
    25,
  );
  const globalHiddenForcedConfig = await configureExportCase({
    scope: "page",
    format: "webp",
    hideDrawings: true,
    watermarkEnabled: false,
  });
  const globalHiddenForcedInvalidated = await observeExportPreviewInvalidation();
  const globalHiddenForcedPreview = await waitForExportPreview({
    format: "webp",
    scope: "page",
    timeout: Math.min(timeoutMs, 20_000),
  });
  const globalHiddenForcedRuntimeRetirement = globalHiddenForcedPreview.ready
    ? await waitForHiddenSceneRuntimeRetirement()
    : summarizeHiddenSceneRuntimeRetirement();
  const globalHiddenAfterForced = await waitExpression(
    cdp,
    `document.querySelector('[data-drawing-action="toggle-hidden"]')?.classList.contains('active') === true`,
    2_000,
    25,
  );
  const globalShowClicked = await click(cdp, '[data-drawing-action="toggle-hidden"]');
  const globalVisibilityRestored = globalShowClicked && await waitExpression(
    cdp,
    `!document.querySelector('[data-drawing-action="toggle-hidden"]')?.classList.contains('active')`,
    2_000,
    25,
  );
  const globalHiddenContract = {
    globalHideClicked,
    globalHideActive,
    baseConfig: globalHiddenBaseConfig,
    basePreview: globalHiddenBasePreview,
    baseRuntimeRetirement: globalHiddenBaseRuntimeRetirement,
    hiddenAfterBase: globalHiddenAfterBase,
    forcedConfig: globalHiddenForcedConfig,
    forcedInvalidated: globalHiddenForcedInvalidated,
    forcedPreview: globalHiddenForcedPreview,
    forcedRuntimeRetirement: globalHiddenForcedRuntimeRetirement,
    hiddenAfterForced: globalHiddenAfterForced,
    globalShowClicked,
    globalVisibilityRestored,
    passed: Boolean(
      globalHideActive
      && globalHiddenBaseConfig.passed
      && globalHiddenBasePreview.ready
      && globalHiddenBaseRuntimeRetirement.passed
      && globalHiddenAfterBase
      && globalHiddenForcedConfig.passed
      && globalHiddenForcedInvalidated
      && globalHiddenForcedPreview.ready
      && globalHiddenForcedRuntimeRetirement.passed
      && globalHiddenAfterForced
      && globalVisibilityRestored
    ),
  };
  const webpRuntimeIssueCount = getRuntimeIssueCount();
  cases.push({
    scope: "page",
    format: "webp",
    config: webpFinalConfig,
    baseConfig: webpBaseConfig,
    previewInvalidated: webpInvalidated,
    basePreview: webpBasePreview,
    preview: webpPreview,
    pixelSignatureChanged: webpBasePreview.signature !== webpPreview.signature,
    drawingsRestored,
    globalHiddenContract,
    save: webpDownload,
    runtimeIssues: webpRuntimeIssueCount - runtimeIssueCount,
    passed: webpBaseConfig.passed
      && webpFinalConfig.passed
      && webpInvalidated
      && webpBasePreview.ready
      && webpPreview.mimeType === "image/webp"
      && webpBasePreview.signature !== webpPreview.signature
      && drawingsRestored
      && globalHiddenContract.passed
      && webpDownload.passed,
  });

  const chartPreview = cases.find((item) => item.scope === "chart")?.preview;
  const mainPanePreview = cases.find((item) => item.scope === "main-pane")?.preview;
  const pagePreview = cases.find((item) => item.scope === "page")?.preview;
  const scopeDimensions = {
    mainPaneShorterThanChart: Number(mainPanePreview?.height) < Number(chartPreview?.height),
    pageLargerThanChart: Number(pagePreview?.width) * Number(pagePreview?.height)
      > Number(chartPreview?.width) * Number(chartPreview?.height),
  };
  const panelError = await cdp.send("Runtime.evaluate", {
    expression: "document.querySelector('.export-panel-message.error')?.textContent?.trim() || ''",
    returnByValue: true,
  });
  const error = panelError.result?.value || "";
  const panelCloseClicked = await click(cdp, ".export-panel-close");
  const panelClosed = panelCloseClicked && await waitExpression(
    cdp,
    "!document.querySelector('.export-workspace')",
    2_000,
    25,
  );
  const acceptance = summarizeExportMatrixAcceptance({
    cases,
    scopeDimensions,
    panelClosed,
    error,
  });

  return {
    panelButtonClicked,
    panelOpened,
    cases,
    scopeDimensions,
    error,
    panelClosed,
    acceptance,
    passed: acceptance.passed,
  };
}
