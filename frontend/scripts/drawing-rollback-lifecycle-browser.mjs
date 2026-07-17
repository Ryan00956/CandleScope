import crypto from "node:crypto";

import {
  captureDrillBuildAuthority,
  commonArtifact,
  runtimeCurrent,
  runtimeSignature,
  waitForSample,
} from "./drawing-rollback-worker-browser.mjs";

const DRILL_ID = "active-gesture-chart-boundary";
const VARIANTS = Object.freeze(["chart-type", "interval"]);
const POINTER_LEDGER = "__CANDLESCOPE_ACTIVE_GESTURE_POINTER_LEDGER__";
const POINTER_EVENT_TYPES = Object.freeze([
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
]);
export const ACTIVE_PEN_EXPRESSION =
  "Boolean(document.querySelector('[data-drawing-tool=\"pen\"].active'))";

const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) return Array.from(value, canonicalize);
  if (Array.isArray(value)) return value.map(canonicalize);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const nested = value[key];
    if (nested !== undefined) output[key] = canonicalize(nested);
  }
  return output;
}

function digestJson(value) {
  const bytes = Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function canonicalDocumentReceipt(record) {
  if (!record
    || typeof record !== "object"
    || !nonEmptyString(record.scopeKey)
    || !Number.isSafeInteger(record.documentRevision)
    || record.documentRevision < 0
    || !Array.isArray(record.entities)) {
    throw new TypeError(`active-gesture canonical document is invalid: ${JSON.stringify(record)}`);
  }
  const normalized = { ...record, updatedAt: 0 };
  return Object.freeze({
    scopeKey: record.scopeKey,
    digest: digestJson(normalized),
    documentRevision: record.documentRevision,
    entityCount: record.entities.length,
  });
}

function sameCanonical(left, right) {
  return left?.scopeKey === right?.scopeKey
    && left?.digest === right?.digest
    && left?.documentRevision === right?.documentRevision
    && left?.entityCount === right?.entityCount;
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftObject = objectValue(left);
  const rightObject = objectValue(right);
  if (!leftObject || !rightObject) return false;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && sameJsonValue(leftObject[key], rightObject[key])
    ));
}

function exactPoint(value) {
  return objectValue(value) !== null
    && Number.isFinite(value.x)
    && Number.isFinite(value.y);
}

function ledgerEvents(value) {
  return Array.isArray(value?.events) ? value.events : [];
}

function exactLedgerCounts(ledger) {
  const events = ledgerEvents(ledger);
  return objectValue(ledger) !== null
    && objectValue(ledger.counts) !== null
    && objectValue(ledger.trustedCounts) !== null
    && events.every((event) => (
      objectValue(event) !== null
        && POINTER_EVENT_TYPES.includes(event.type)
        && Number.isFinite(Date.parse(event.observedAt))
    ))
    && POINTER_EVENT_TYPES.every((type) => (
      ledger.counts[type] === events.filter((event) => event.type === type).length
        && ledger.trustedCounts[type]
          === events.filter((event) => event.type === type && event.isTrusted === true).length
    ));
}

function exactTrustedCounts(ledger, { down, move, up, cancel }) {
  return exactLedgerCounts(ledger)
    && trustedCount(ledger, "pointerdown") === down
    && trustedCount(ledger, "pointermove") === move
    && trustedCount(ledger, "pointerup") === up
    && trustedCount(ledger, "pointercancel") === cancel
    && ledgerEvents(ledger).every((event) => event.isTrusted === true);
}

function eventMatchesPointer(event, pointerId, pointerType) {
  return event?.pointerId === pointerId && event?.pointerType === pointerType;
}

function eventMatchesPoint(event, point) {
  return event?.clientX === point?.x && event?.clientY === point?.y;
}

function ledgerExtends(previous, next, addedType) {
  const before = ledgerEvents(previous);
  const after = ledgerEvents(next);
  return after.length === before.length + 1
    && before.every((event, index) => sameJsonValue(event, after[index]))
    && after.at(-1)?.type === addedType;
}

export function gestureActivityEvidenceFailures(
  kind,
  completed,
  evidence,
  { phase = "observed" } = {},
) {
  if (!VARIANTS.includes(kind)) {
    throw new TypeError(`active-gesture evidence kind is invalid: ${String(kind)}`);
  }
  if (phase !== "armed" && phase !== "observed") {
    throw new TypeError(`active-gesture evidence phase is invalid: ${String(phase)}`);
  }
  const activity = objectValue(evidence);
  const pointer = objectValue(activity?.pointer);
  const activeLedger = objectValue(activity?.pointerLedgerAtActive);
  const cancellationLedger = objectValue(activity?.pointerLedgerAtCancellation);
  const heldProbeLedger = objectValue(activity?.pointerLedgerAfterHeldProbe);
  const releaseLedger = objectValue(activity?.pointerLedgerAfterRelease);
  const activeEvents = ledgerEvents(activeLedger);
  const cancellationEvents = ledgerEvents(cancellationLedger);
  const heldProbeEvents = ledgerEvents(heldProbeLedger);
  const releaseEvents = ledgerEvents(releaseLedger);
  const down = activeEvents.find((event) => event.type === "pointerdown" && event.isTrusted === true);
  const moves = activeEvents.filter((event) => event.type === "pointermove" && event.isTrusted === true);
  const finalMove = moves.at(-1);
  const pointerId = down?.pointerId;
  const pointerType = down?.pointerType;
  const boundary = completed?.events?.[1];
  const release = releaseEvents.at(-1);
  const heldProbe = heldProbeEvents.at(-1);
  const activeMoveCount = trustedCount(activeLedger, "pointermove");
  const failures = [];
  const addFailure = (accepted, reason) => {
    if (!accepted) failures.push(`${kind}-${reason}`);
  };

  addFailure(activity !== null, "activity-evidence-missing");
  addFailure(
    activity?.liveInk?.before === 0
      && Number.isSafeInteger(activity?.liveInk?.active)
      && activity.liveInk.active > 0
      && (phase === "armed" || (
        activity.liveInk.cancelled === 0
          && activity.liveInk.heldProbeAfterCancel === 0
          && activity.liveInk.afterRelease === 0
      )),
    "live-ink-activity-invalid",
  );
  addFailure(
    exactPoint(pointer?.start)
    && exactPoint(pointer?.end)
    && Number.isSafeInteger(pointerId)
    && pointerId > 0
    && pointerType === "mouse"
    && exactTrustedCounts(activeLedger, {
      down: 1, move: moves.length, up: 0, cancel: 0,
    })
    && activeEvents[0] === down
    && moves.length > 0
    && down?.button === 0
    && down?.buttons === 1
    && eventMatchesPointer(down, pointerId, pointerType)
    && eventMatchesPoint(down, pointer.start)
    && moves.every((event) => (
      event.button === -1
        && event.buttons === 1
        && eventMatchesPointer(event, pointerId, pointerType)
    ))
    && eventMatchesPoint(finalMove, pointer.end)
    && completed?.events?.[0]?.type === "pointer-down"
    && completed.events[0].activeAfter === true,
    "pointer-active-ledger-invalid",
  );

  if (phase === "armed") return Object.freeze(failures);

  addFailure(
    exactTrustedCounts(cancellationLedger, {
      down: 1, move: activeMoveCount, up: 0, cancel: 0,
    })
      && sameJsonValue(activeEvents, cancellationEvents),
    "pointer-cancellation-ledger-invalid",
  );
  addFailure(
    exactTrustedCounts(heldProbeLedger, {
      down: 1, move: activeMoveCount + 1, up: 0, cancel: 0,
    })
    && ledgerExtends(cancellationLedger, heldProbeLedger, "pointermove")
    && heldProbe?.button === -1
    && heldProbe?.buttons === 1
    && eventMatchesPointer(heldProbe, pointerId, pointerType)
    && heldProbe.clientX === pointer?.end?.x + 8
    && heldProbe.clientY === pointer?.end?.y + 4,
    "pointer-held-probe-ledger-invalid",
  );
  addFailure(
    exactTrustedCounts(releaseLedger, {
      down: 1, move: activeMoveCount + 1, up: 1, cancel: 0,
    })
    && ledgerExtends(heldProbeLedger, releaseLedger, "pointerup")
    && release?.button === 0
    && release?.buttons === 0
    && eventMatchesPointer(release, pointerId, pointerType)
    && eventMatchesPoint(release, pointer?.end),
    "pointer-release-ledger-invalid",
  );
  addFailure(
    activity?.uiBoundary?.beforeValue === boundary?.beforeValue
    && activity?.uiBoundary?.afterValue === boundary?.afterValue
    && activity?.uiBoundary?.changed === true,
    "ui-boundary-evidence-mismatch",
  );
  addFailure(
    Number.isFinite(Date.parse(activity?.boundaryRequestedAt))
    && Date.parse(activity?.boundaryRequestedAt) >= Date.parse(completed?.events?.[0]?.observedAt)
    && Date.parse(activity?.boundaryRequestedAt) <= Date.parse(boundary?.observedAt),
    "boundary-request-order-invalid",
  );
  addFailure(
    activity?.productLifecycle?.kind === kind
    && activity?.productLifecycle?.transactionId === completed?.transactionId
    && activity?.productLifecycle?.gestureId === completed?.gestureId
    && sameJsonValue(activity?.productLifecycle?.events, completed?.events),
    "product-lifecycle-evidence-mismatch",
  );
  return Object.freeze(failures);
}

function validArmedGestureEvidence(kind, completed, evidence) {
  return gestureActivityEvidenceFailures(kind, completed, evidence, { phase: "armed" }).length === 0;
}

function validObservedGestureEvidence(kind, completed, evidence) {
  return gestureActivityEvidenceFailures(kind, completed, evidence).length === 0;
}

function exactGestureEvents(kind, completed) {
  const expectedReason = kind === "chart-type" ? "surface-dispose" : "coordinate-change";
  const events = Array.isArray(completed?.events) ? completed.events : [];
  const pointerDown = objectValue(events[0]);
  const boundary = objectValue(events[1]);
  const cancellation = objectValue(events[2]);
  return nonEmptyString(completed?.transactionId)
    && nonEmptyString(completed?.gestureId)
    && completed?.kind === kind
    && events.length === 3
    && events.every((event) => (
      event?.transactionId === completed.transactionId
        && event?.gestureId === completed.gestureId
        && Number.isFinite(Date.parse(event?.observedAt))
    ))
    && pointerDown?.type === "pointer-down"
    && pointerDown.activeAfter === true
    && boundary?.type === "boundary-change"
    && boundary.boundaryKind === kind
    && nonEmptyString(boundary.beforeValue)
    && nonEmptyString(boundary.afterValue)
    && boundary.beforeValue !== boundary.afterValue
    && boundary.activeBefore === true
    && cancellation?.type === "gesture-cancel"
    && cancellation.reason === expectedReason
    && cancellation.activeAfter === false
    && events.every((event, index) => (
      index === 0 || Date.parse(event.observedAt) >= Date.parse(events[index - 1].observedAt)
    ));
}

export function gestureVariantReceipt(kind, completed, canonicalBefore, canonicalAfter, activityEvidence) {
  if (!VARIANTS.includes(kind) || !exactGestureEvents(kind, completed)) {
    throw new TypeError(`${kind} product-authored gesture lifecycle receipt is invalid`);
  }
  if (!sameCanonical(canonicalBefore, canonicalAfter)) {
    throw new Error(`${kind} active gesture changed the canonical drawing document`);
  }
  const evidenceFailures = gestureActivityEvidenceFailures(kind, completed, activityEvidence);
  if (evidenceFailures.length > 0) {
    throw new TypeError(
      `${kind} active gesture activity evidence is invalid: ${evidenceFailures.join(",")}`,
    );
  }
  return Object.freeze({
    kind,
    transactionId: completed.transactionId,
    gestureId: completed.gestureId,
    events: Object.freeze(completed.events.map((event) => Object.freeze({ ...event }))),
    canonical: Object.freeze({
      before: Object.freeze({
        scopeKey: canonicalBefore.scopeKey,
        digest: canonicalBefore.digest,
        documentRevision: canonicalBefore.documentRevision,
      }),
      after: Object.freeze({
        scopeKey: canonicalAfter.scopeKey,
        digest: canonicalAfter.digest,
        documentRevision: canonicalAfter.documentRevision,
      }),
    }),
    activityEvidence: Object.freeze(activityEvidence),
  });
}

function trustedCount(ledger, type) {
  return ledger?.trustedCounts?.[type] ?? -1;
}

export function lifecycleInjectionReceipt(variants, navigation, buildAuthorityCurrent) {
  const values = Array.isArray(variants) ? variants : [];
  const exactVariants = values.length === VARIANTS.length
    && VARIANTS.every((kind) => values.filter((variant) => variant?.kind === kind).length === 1);
  const navigationAccepted = navigation?.kind === "controlled-rollback-drill-navigation"
    && navigation.drillId === DRILL_ID
    && navigation.variant === null
    && navigation.bootstrap?.authorityAccepted === true
    && navigation.bootstrap?.tokenRemoved === true;
  const armed = exactVariants && navigationAccepted && values.every((variant) => {
    return exactGestureEvents(variant?.kind, variant)
      && validArmedGestureEvidence(variant?.kind, variant, variant?.activityEvidence);
  });
  const observed = armed && buildAuthorityCurrent === true && values.every((variant) => {
    return validObservedGestureEvidence(variant.kind, variant, variant.activityEvidence);
  });
  return Object.freeze({
    kind: DRILL_ID,
    variants: VARIANTS,
    armed,
    observed,
    buildAuthorityCurrent: buildAuthorityCurrent === true,
    navigation: Object.freeze({
      runId: navigation?.runId ?? null,
      faultId: navigation?.faultId ?? null,
      sequence: navigation?.sequence ?? null,
      authorityTokenSha256: nonEmptyString(navigation?.authorityTokenSha256)
        ? `sha256:${navigation.authorityTokenSha256}`
        : null,
    }),
  });
}

export function pointerLedgerBootstrapExpression() {
  return `(() => {
    const name = ${JSON.stringify(POINTER_LEDGER)};
    const existing = window[name];
    if (existing && typeof existing.reset === 'function' && typeof existing.snapshot === 'function') {
      existing.reset();
      return { installed: true, reused: true };
    }
    const events = [];
    const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];
    const listener = (event) => {
      if (events.length >= 256) events.shift();
      events.push({
        type: event.type,
        isTrusted: event.isTrusted === true,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        buttons: event.buttons,
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        observedAt: new Date().toISOString()
      });
    };
    for (const type of types) document.addEventListener(type, listener, true);
    const snapshot = () => {
      const counts = Object.fromEntries(types.map((type) => [
        type,
        events.filter((event) => event.type === type).length
      ]));
      const trustedCounts = Object.fromEntries(types.map((type) => [
        type,
        events.filter((event) => event.type === type && event.isTrusted).length
      ]));
      return { counts, trustedCounts, events: events.map((event) => ({ ...event })) };
    };
    Object.defineProperty(window, name, {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        reset() { events.length = 0; },
        snapshot
      })
    });
    return { installed: true, reused: false };
  })()`;
}

async function installPointerLedger(session) {
  const installed = await session.cdp.evaluateJson(pointerLedgerBootstrapExpression());
  if (installed?.installed !== true) throw new Error("active-gesture pointer ledger was not installed");
}

async function resetPointerLedger(session) {
  const reset = await session.cdp.evaluate(
    `window[${JSON.stringify(POINTER_LEDGER)}]?.reset?.(); true`,
  );
  if (reset !== true) throw new Error("active-gesture pointer ledger could not reset");
}

function liveInkSnapshotSource() {
  return `(() => {
    const canvas = document.querySelector('[data-drawing-overlay="live-ink"]');
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0) {
      return { readable: false, alphaPixels: -1, width: 0, height: 0 };
    }
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return { readable: false, alphaPixels: -1, width: canvas.width, height: canvas.height };
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let alphaPixels = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) {
          alphaPixels += 1;
          if (alphaPixels >= 4096) break;
        }
      }
      return { readable: true, alphaPixels, width: canvas.width, height: canvas.height };
    } catch (error) {
      return {
        readable: false,
        alphaPixels: -1,
        width: canvas.width,
        height: canvas.height,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  })()`;
}

export function lifecycleBrowserStateExpression() {
  return `(() => {
    const handle = window.__CANDLESCOPE_DRAWING_PERF__;
    const ledger = window[${JSON.stringify(POINTER_LEDGER)}];
    const pane = document.querySelector('[data-pane-id="single-chart"]');
    const activeInterval = document.querySelector('button.interval-btn.active');
    return {
      lifecycle: handle && typeof handle.readInteractionLifecycle === 'function'
        ? handle.readInteractionLifecycle()
        : null,
      record: handle && typeof handle.readActivePersistenceDocumentRecord === 'function'
        ? handle.readActivePersistenceDocumentRecord()
        : null,
      runtime: handle && typeof handle.readPhase6Runtime === 'function'
        ? handle.readPhase6Runtime()
        : null,
      summary: handle && typeof handle.readRuntimeSummary === 'function'
        ? handle.readRuntimeSummary()
        : null,
      liveInk: (${liveInkSnapshotSource()}),
      pointerLedger: ledger && typeof ledger.snapshot === 'function' ? ledger.snapshot() : null,
      chartType: pane?.dataset?.chartType || null,
      interval: activeInterval instanceof HTMLButtonElement
        ? activeInterval.id.replace(/^interval-/, '')
        : null,
      penActive: document.querySelector('[data-drawing-tool="pen"]')?.classList.contains('active') === true
    };
  })()`;
}

async function readBrowserState(session) {
  return session.cdp.evaluateJson(lifecycleBrowserStateExpression());
}

function stateCanonical(state) {
  try {
    return canonicalDocumentReceipt(state?.record);
  } catch {
    return null;
  }
}

function sameBaseline(state, baseline) {
  return sameCanonical(stateCanonical(state), baseline);
}

function baselineMatchesInput(receipt, beforeDocument) {
  return receipt?.scopeKey === beforeDocument?.scopeKey
    && receipt?.documentRevision === beforeDocument?.documentRevision
    && receipt?.entityCount === beforeDocument?.entityCount;
}

async function waitForSettledDocument(session, beforeDocument, timeoutMs, description) {
  return waitForSample(
    () => readBrowserState(session),
    (state) => {
      const receipt = stateCanonical(state);
      return baselineMatchesInput(receipt, beforeDocument)
        && state?.summary?.entityCount === receipt.entityCount
        && state.liveInk?.readable === true
        && state.liveInk.alphaPixels === 0
        && state.lifecycle?.active == null
        && runtimeCurrent(state.runtime);
    },
    {
      timeoutMs,
      description,
      stableMs: 120,
      signature: (state) => `${runtimeSignature(state)}:${stateCanonical(state)?.digest}`,
    },
  );
}

async function waitNextAnimationFrame(session) {
  const arrived = await session.cdp.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))",
  );
  if (arrived !== true) throw new Error("active-gesture drill missed animation frame");
}

export async function prepositionPointerAndResetLedger(session, start) {
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: start.x, y: start.y, button: "none", buttons: 0,
  });
  await waitNextAnimationFrame(session);
  await resetPointerLedger(session);
}

async function activatePen(session, timeoutMs) {
  const clicked = await session.cdp.evaluateJson(`(() => {
    const button = document.querySelector('[data-drawing-tool="pen"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return { ready: false };
    const alreadyActive = button.classList.contains('active');
    if (!alreadyActive) button.click();
    return { ready: true, alreadyActive, clicked: !alreadyActive };
  })()`);
  if (clicked?.ready !== true) throw new Error("active-gesture drill could not activate pen");
  await waitForSample(
    () => session.cdp.evaluate(
      ACTIVE_PEN_EXPRESSION,
    ),
    (active) => active === true,
    { timeoutMs: Math.min(timeoutMs, 5_000), description: "active-gesture pen activation" },
  );
  await wait(120);
}

async function readPlotRect(session) {
  return session.cdp.evaluateJson(`(() => {
    const chart = document.querySelector('[data-pane-id="single-chart"]');
    if (!(chart instanceof HTMLElement)) return null;
    const rect = chart.getBoundingClientRect();
    return rect.width > 200 && rect.height > 160
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null;
  })()`);
}

export async function pressAndHandOffHeldPointer(session, pointer, armHeldPointer) {
  if (typeof armHeldPointer !== "function") {
    throw new TypeError("active-gesture held-pointer arming callback is required");
  }
  let pressed = false;
  let handedOff = false;
  try {
    await session.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pointer.start.x,
      y: pointer.start.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    pressed = true;
    const value = await armHeldPointer();
    handedOff = true;
    return value;
  } finally {
    if (pressed && !handedOff) {
      try {
        await releaseHeldPointer(session, pointer);
      } catch { /* preserve the authoritative arming failure */ }
    }
  }
}

async function beginHeldFreehand(session, baseline, timeoutMs) {
  await activatePen(session, timeoutMs);
  const rect = await readPlotRect(session);
  if (!rect) throw new Error("active-gesture drill could not resolve the main chart plot");
  const start = {
    x: Math.round(rect.x + rect.width * 0.34),
    y: Math.round(rect.y + rect.height * 0.45),
  };
  const end = {
    x: Math.round(rect.x + rect.width * 0.57),
    y: Math.round(rect.y + rect.height * 0.37),
  };
  await prepositionPointerAndResetLedger(session, start);
  const pointer = Object.freeze({ start, end });
  const active = await pressAndHandOffHeldPointer(session, pointer, async () => {
    for (let step = 1; step <= 8; step += 1) {
      await session.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(start.x + ((end.x - start.x) * step) / 8),
        y: Math.round(start.y + ((end.y - start.y) * step) / 8),
        button: "none",
        buttons: 1,
      });
    }
    return waitForSample(
      () => readBrowserState(session),
      (state) => {
        const gesture = state?.lifecycle?.active;
        const pointerDown = gesture?.events?.[0];
        return nonEmptyString(gesture?.transactionId)
          && nonEmptyString(gesture?.gestureId)
          && pointerDown?.type === "pointer-down"
          && pointerDown.activeAfter === true
          && state.liveInk?.readable === true
          && state.liveInk.alphaPixels > 0
          && trustedCount(state.pointerLedger, "pointerdown") === 1
          && trustedCount(state.pointerLedger, "pointerup") === 0
          && trustedCount(state.pointerLedger, "pointercancel") === 0
          && sameBaseline(state, baseline);
      },
      {
        timeoutMs,
        description: "product-authored active freehand gesture",
        stableMs: 80,
        signature: (state) => JSON.stringify({
          gestureId: state?.lifecycle?.active?.gestureId,
          liveInk: state?.liveInk?.alphaPixels,
          pointer: state?.pointerLedger?.trustedCounts,
        }),
      },
    );
  });
  return Object.freeze({ start, end, active: active.value });
}

async function releaseHeldPointer(session, pointer) {
  await session.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: pointer?.end?.x ?? pointer?.start?.x ?? 0,
    y: pointer?.end?.y ?? pointer?.start?.y ?? 0,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function switchChartType(session, desired, timeoutMs) {
  const before = await session.cdp.evaluate(
    "document.querySelector('[data-pane-id=\"single-chart\"]')?.dataset?.chartType || null",
  );
  if (!nonEmptyString(before)) throw new Error("active-gesture chart type is unavailable");
  if (before === desired) return Object.freeze({ beforeValue: before, afterValue: before, changed: false });
  const opened = await session.cdp.evaluate(`(() => {
    const button = document.querySelector('.chart-type-tool-btn');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (opened !== true) throw new Error("active-gesture chart-type menu could not open");
  await waitForSample(
    () => session.cdp.evaluate("Boolean(document.querySelector('.chart-type-flyout'))"),
    (value) => value === true,
    { timeoutMs: Math.min(timeoutMs, 5_000), description: "active-gesture chart-type flyout" },
  );
  const clicked = await session.cdp.evaluate(`(() => {
    const target = document.querySelector('.chart-type-flyout [data-tool-variant=${JSON.stringify(desired)}]');
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error(`active-gesture chart type ${desired} is unavailable`);
  const changed = await waitForSample(
    () => session.cdp.evaluateJson(`(() => ({
      pane: document.querySelector('[data-pane-id="single-chart"]')?.dataset?.chartType || null,
      button: document.querySelector('.chart-type-tool-btn')?.dataset?.chartType || null
    }))()`),
    (value) => value?.pane === desired && value.button === desired,
    { timeoutMs, description: `active-gesture chart type ${before} to ${desired}`, stableMs: 80, signature: JSON.stringify },
  );
  return Object.freeze({
    beforeValue: before,
    afterValue: changed.value.pane,
    changed: before !== changed.value.pane,
  });
}

async function chooseIntervalTarget(session) {
  return session.cdp.evaluateJson(`(() => {
    const buttons = Array.from(document.querySelectorAll('button.interval-btn'))
      .filter((button) => button instanceof HTMLButtonElement && !button.disabled && button.getClientRects().length > 0)
      .map((button) => ({
        value: button.id.replace(/^interval-/, ''),
        active: button.classList.contains('active')
      }));
    const current = buttons.find((button) => button.active)?.value || null;
    const preferred = ['5m', '15m', '1h', '4h', '1m'];
    const target = preferred.find((value) => value !== current && buttons.some((button) => button.value === value))
      || buttons.find((button) => button.value !== current)?.value
      || null;
    return { current, target, buttons };
  })()`);
}

async function switchInterval(session, desired, timeoutMs) {
  const current = await session.cdp.evaluate(
    "document.querySelector('button.interval-btn.active')?.id?.replace(/^interval-/, '') || null",
  );
  if (!nonEmptyString(current)) throw new Error("active-gesture interval is unavailable");
  if (current === desired) return Object.freeze({ beforeValue: current, afterValue: current, changed: false });
  const clicked = await session.cdp.evaluate(`(() => {
    const button = document.getElementById(${JSON.stringify(`interval-${desired}`)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error(`active-gesture interval ${desired} is unavailable`);
  const changed = await waitForSample(
    () => session.cdp.evaluate(
      "document.querySelector('button.interval-btn.active')?.id?.replace(/^interval-/, '') || null",
    ),
    (value) => value === desired,
    { timeoutMs, description: `active-gesture interval ${current} to ${desired}`, stableMs: 80 },
  );
  return Object.freeze({ beforeValue: current, afterValue: changed.value, changed: current !== changed.value });
}

function runtimeBoundaryReceipt(runtime) {
  return Object.freeze({
    backend: runtime?.backend ?? null,
    workerAvailability: runtime?.workerAvailability ?? null,
    queueDepthCurrent: runtime?.queueDepthCurrent ?? null,
    inFlightCurrent: runtime?.inFlightCurrent ?? null,
    lastRequestedStamp: runtime?.lastRequestedStamp ?? null,
    lastPublishedStamp: runtime?.lastPublishedStamp ?? null,
    lastPaintedStamp: runtime?.lastPaintedStamp ?? null,
    paintReceipt: runtime?.paintReceipt ?? null,
  });
}

async function runVariant(session, kind, beforeDocument, timeoutMs) {
  let stage = "canonical-baseline";
  let baseline = null;
  let liveInkBefore = null;
  let pointer = null;
  let released = false;
  try {
    const settled = await waitForSettledDocument(
      session,
      beforeDocument,
      timeoutMs,
      `${kind} active-gesture canonical baseline`,
    );
    baseline = canonicalDocumentReceipt(settled.value.record);
    liveInkBefore = settled.value.liveInk.alphaPixels;
    stage = "begin-held-freehand";
    pointer = await beginHeldFreehand(session, baseline, timeoutMs);
    const activeGesture = pointer.active.lifecycle.active;
    stage = "capture-boundary-request";
    const boundaryRequestedAt = await session.cdp.evaluate("new Date().toISOString()");
    if (!nonEmptyString(boundaryRequestedAt)
      || !Number.isFinite(Date.parse(boundaryRequestedAt))) {
      throw new Error(`active-gesture browser boundary timestamp is invalid: ${String(boundaryRequestedAt)}`);
    }
    let uiBoundary;
    stage = "switch-boundary";
    if (kind === "chart-type") {
      const target = pointer.active.chartType === "line" ? "candlestick" : "line";
      uiBoundary = await switchChartType(session, target, timeoutMs);
    } else {
      const target = await chooseIntervalTarget(session);
      if (!nonEmptyString(target?.target) || target.target === target.current) {
        throw new Error(`active-gesture interval target is invalid: ${JSON.stringify(target)}`);
      }
      uiBoundary = await switchInterval(session, target.target, timeoutMs);
    }
    if (!uiBoundary.changed) throw new Error(`${kind} active-gesture UI boundary did not change`);

    stage = "await-boundary-cancellation";
    const cancelled = await waitForSample(
      () => readBrowserState(session),
      (state) => {
        const completed = state?.lifecycle?.lastCompleted;
        return state?.lifecycle?.active == null
          && completed?.kind === kind
          && completed?.gestureId === activeGesture.gestureId
          && completed?.transactionId === activeGesture.transactionId
          && exactGestureEvents(kind, completed)
          && state.liveInk?.readable === true
          && state.liveInk.alphaPixels === 0
          && trustedCount(state.pointerLedger, "pointerup") === 0
          && trustedCount(state.pointerLedger, "pointercancel") === 0
          && sameBaseline(state, baseline)
          && runtimeCurrent(state.runtime);
      },
      {
        timeoutMs,
        description: `${kind} product-authored boundary cancellation`,
        stableMs: 120,
        signature: (state) => JSON.stringify({
          lifecycle: state?.lifecycle,
          liveInk: state?.liveInk?.alphaPixels,
          runtime: runtimeSignature(state),
        }),
      },
    );

    stage = "held-pointer-probe";
    await session.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pointer.end.x + 8,
      y: pointer.end.y + 4,
      button: "none",
      buttons: 1,
    });
    await waitNextAnimationFrame(session);
    const heldProbe = await waitForSample(
      () => readBrowserState(session),
      (state) => state?.liveInk?.readable === true
        && state.liveInk.alphaPixels === 0
        && state.lifecycle?.active == null
        && state.lifecycle?.lastCompleted?.gestureId === activeGesture.gestureId
        && trustedCount(state.pointerLedger, "pointerup") === 0
        && trustedCount(state.pointerLedger, "pointercancel") === 0
        && sameBaseline(state, baseline),
      {
        timeoutMs: Math.min(timeoutMs, 8_000),
        description: `${kind} held-pointer post-cancel probe`,
        stableMs: 100,
        signature: (state) => JSON.stringify({
          liveInk: state?.liveInk?.alphaPixels,
          pointer: state?.pointerLedger?.trustedCounts,
        }),
      },
    );

    stage = "physical-release";
    await releaseHeldPointer(session, pointer);
    released = true;
    const afterRelease = await waitForSample(
      () => readBrowserState(session),
      (state) => state?.liveInk?.readable === true
        && state.liveInk.alphaPixels === 0
        && state.lifecycle?.active == null
        && state.lifecycle?.lastCompleted?.gestureId === activeGesture.gestureId
        && trustedCount(state.pointerLedger, "pointerup") === 1
        && trustedCount(state.pointerLedger, "pointercancel") === 0
        && sameBaseline(state, baseline)
        && runtimeCurrent(state.runtime),
      {
        timeoutMs,
        description: `${kind} physical release cleanup`,
        stableMs: 120,
        signature: (state) => JSON.stringify({
          pointer: state?.pointerLedger?.trustedCounts,
          runtime: runtimeSignature(state),
        }),
      },
    );
    const canonicalAfter = canonicalDocumentReceipt(afterRelease.value.record);
    stage = "assemble-variant-receipt";
    const variant = gestureVariantReceipt(
      kind,
      cancelled.value.lifecycle.lastCompleted,
      baseline,
      canonicalAfter,
      {
        boundaryRequestedAt,
        uiBoundary: Object.freeze({ ...uiBoundary }),
        liveInk: Object.freeze({
          before: liveInkBefore,
          active: pointer.active.liveInk.alphaPixels,
          cancelled: cancelled.value.liveInk.alphaPixels,
          heldProbeAfterCancel: heldProbe.value.liveInk.alphaPixels,
          afterRelease: afterRelease.value.liveInk.alphaPixels,
        }),
        pointer: Object.freeze({ start: pointer.start, end: pointer.end }),
        pointerLedgerAtActive: Object.freeze(pointer.active.pointerLedger),
        pointerLedgerAtCancellation: Object.freeze(cancelled.value.pointerLedger),
        pointerLedgerAfterHeldProbe: Object.freeze(heldProbe.value.pointerLedger),
        pointerLedgerAfterRelease: Object.freeze(afterRelease.value.pointerLedger),
        runtimeAfterCancellation: runtimeBoundaryReceipt(cancelled.value.runtime),
        runtimeAfterRelease: runtimeBoundaryReceipt(afterRelease.value.runtime),
        productLifecycle: Object.freeze(cancelled.value.lifecycle.lastCompleted),
      },
    );

    stage = "restore-boundary";
    if (kind === "chart-type") {
      await switchChartType(session, uiBoundary.beforeValue, timeoutMs);
    } else {
      await switchInterval(session, uiBoundary.beforeValue, timeoutMs);
    }
    await waitForSettledDocument(
      session,
      beforeDocument,
      timeoutMs,
      `${kind} active-gesture restoration`,
    );
    return variant;
  } catch (error) {
    throw new Error(
      `active-gesture ${kind} stage ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (pointer && !released) {
      try { await releaseHeldPointer(session, pointer); } catch { /* close() remains authoritative */ }
    }
  }
}

export async function runControlledLifecycleRollbackDrills(
  session,
  { timeoutMs = 45_000, beforeDocument } = {},
) {
  if (!beforeDocument
    || !nonEmptyString(beforeDocument.scopeKey)
    || !Number.isSafeInteger(beforeDocument.documentRevision)
    || beforeDocument.documentRevision < 0
    || !Number.isSafeInteger(beforeDocument.entityCount)
    || beforeDocument.entityCount < 0) {
    throw new TypeError("controlled lifecycle rollback requires an authoritative beforeDocument");
  }
  const startedAt = new Date().toISOString();
  let stage = "navigate";
  try {
    const navigation = await session.navigateRollbackDrill(DRILL_ID);
    stage = "install-pointer-ledger";
    await installPointerLedger(session);
    stage = "navigation-baseline";
    const initial = await waitForSettledDocument(
      session,
      beforeDocument,
      timeoutMs,
      "active-gesture lifecycle navigation baseline",
    );
    if (initial.value.chartType !== "candlestick") {
      stage = "normalize-chart-type";
      await switchChartType(session, "candlestick", timeoutMs);
      await waitForSettledDocument(
        session,
        beforeDocument,
        timeoutMs,
        "active-gesture candlestick normalization",
      );
    }
    const variants = [];
    for (const kind of VARIANTS) {
      stage = `variant-${kind}`;
      variants.push(await runVariant(session, kind, beforeDocument, timeoutMs));
    }
    stage = "final-document";
    const final = await waitForSettledDocument(
      session,
      beforeDocument,
      timeoutMs,
      "active-gesture lifecycle final document",
    );
    const finalDocumentReceipt = canonicalDocumentReceipt(final.value.record);
    stage = "build-authority";
    const windowEvidence = await session.verifyWindow();
    const buildAuthority = await captureDrillBuildAuthority(session, DRILL_ID);
    const artifact = commonArtifact(
      session,
      DRILL_ID,
      startedAt,
      windowEvidence,
      buildAuthority,
      lifecycleInjectionReceipt(variants, navigation, buildAuthority.authoritative),
      { variants: Object.freeze(variants) },
    );
    return Object.freeze({
      drills: Object.freeze([artifact]),
      finalDocument: Object.freeze({
        scopeKey: finalDocumentReceipt.scopeKey,
        documentRevision: finalDocumentReceipt.documentRevision,
        entityCount: finalDocumentReceipt.entityCount,
        digest: finalDocumentReceipt.digest,
      }),
    });
  } catch (error) {
    throw new Error(
      `active-gesture lifecycle stage ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
