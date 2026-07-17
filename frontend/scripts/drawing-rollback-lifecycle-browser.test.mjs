import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_PEN_EXPRESSION,
  canonicalDocumentReceipt,
  gestureActivityEvidenceFailures,
  gestureVariantReceipt,
  lifecycleBrowserStateExpression,
  lifecycleInjectionReceipt,
  pointerLedgerBootstrapExpression,
  prepositionPointerAndResetLedger,
  pressAndHandOffHeldPointer,
} from "./drawing-rollback-lifecycle-browser.mjs";

function record({ updatedAt = 10, price = 42_000 } = {}) {
  return {
    documentSchemaVersion: 1,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentRevision: 7,
    updatedAt,
    entities: [{
      id: "freehand-1",
      type: "freehand",
      geometry: { points: [{ time: 1, price }, { time: 2, price: price + 1 }] },
    }],
  };
}

function completed(kind, suffix = kind) {
  const transactionId = `transaction-${suffix}`;
  const gestureId = `gesture-${suffix}`;
  const reason = kind === "chart-type" ? "surface-dispose" : "coordinate-change";
  return {
    kind,
    transactionId,
    gestureId,
    events: [
      {
        type: "pointer-down",
        transactionId,
        gestureId,
        observedAt: "2026-07-17T01:00:00.000Z",
        activeAfter: true,
      },
      {
        type: "boundary-change",
        transactionId,
        gestureId,
        observedAt: "2026-07-17T01:00:00.100Z",
        boundaryKind: kind,
        beforeValue: `${kind}-before`,
        afterValue: `${kind}-after`,
        activeBefore: true,
      },
      {
        type: "gesture-cancel",
        transactionId,
        gestureId,
        observedAt: "2026-07-17T01:00:00.200Z",
        reason,
        activeAfter: false,
      },
    ],
  };
}

const POINTER = Object.freeze({
  start: Object.freeze({ x: 100, y: 200 }),
  end: Object.freeze({ x: 180, y: 160 }),
});

function pointerEvent(type, overrides = {}) {
  const move = type === "pointermove";
  const release = type === "pointerup";
  return {
    type,
    isTrusted: true,
    pointerId: 1,
    pointerType: "mouse",
    button: move ? -1 : 0,
    buttons: release ? 0 : 1,
    clientX: type === "pointerdown" ? POINTER.start.x : POINTER.end.x,
    clientY: type === "pointerdown" ? POINTER.start.y : POINTER.end.y,
    observedAt: release
      ? "2026-07-17T01:00:00.400Z"
      : move
        ? "2026-07-17T01:00:00.010Z"
        : "2026-07-17T01:00:00.000Z",
    ...overrides,
  };
}

function ledger(events) {
  const types = ["pointerdown", "pointermove", "pointerup", "pointercancel"];
  return {
    counts: Object.fromEntries(types.map((type) => [
      type,
      events.filter((event) => event.type === type).length,
    ])),
    trustedCounts: Object.fromEntries(types.map((type) => [
      type,
      events.filter((event) => event.type === type && event.isTrusted).length,
    ])),
    events: structuredClone(events),
  };
}

function activityEvidence(kind, lifecycle = completed(kind)) {
  const activeEvents = [
    pointerEvent("pointerdown"),
    pointerEvent("pointermove"),
  ];
  const heldEvents = [
    ...activeEvents,
    pointerEvent("pointermove", {
      clientX: POINTER.end.x + 8,
      clientY: POINTER.end.y + 4,
      observedAt: "2026-07-17T01:00:00.300Z",
    }),
  ];
  return {
    boundaryRequestedAt: "2026-07-17T01:00:00.050Z",
    liveInk: { before: 0, active: 12, cancelled: 0, heldProbeAfterCancel: 0, afterRelease: 0 },
    pointer: structuredClone(POINTER),
    pointerLedgerAtActive: ledger(activeEvents),
    pointerLedgerAtCancellation: ledger(activeEvents),
    pointerLedgerAfterHeldProbe: ledger(heldEvents),
    pointerLedgerAfterRelease: ledger([
      ...heldEvents,
      pointerEvent("pointerup"),
    ]),
    uiBoundary: {
      beforeValue: `${kind}-before`,
      afterValue: `${kind}-after`,
      changed: true,
    },
    productLifecycle: structuredClone(lifecycle),
  };
}

test("browser lifecycle expressions remain valid standalone JavaScript", () => {
  assert.doesNotThrow(() => new Function(`return (${ACTIVE_PEN_EXPRESSION});`));
  assert.doesNotThrow(() => new Function(`return (${pointerLedgerBootstrapExpression()});`));
  assert.doesNotThrow(() => new Function(`return (${lifecycleBrowserStateExpression()});`));
});

test("active-gesture canonical receipt is ordered, timestamp-neutral, and geometry-sensitive", () => {
  const first = canonicalDocumentReceipt(record({ updatedAt: 10 }));
  const reordered = canonicalDocumentReceipt({
    entities: record().entities,
    updatedAt: 999,
    documentRevision: 7,
    scopeKey: "binance:spot:BTCUSDT__main",
    documentSchemaVersion: 1,
  });
  assert.deepEqual(first, reordered);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(first.digest, canonicalDocumentReceipt(record({ price: 42_001 })).digest);
  assert.throws(() => canonicalDocumentReceipt({ scopeKey: "scope", entities: [] }), /invalid/);
});

test("gesture variant preserves the product-authored exact three-event lifecycle", () => {
  const canonical = canonicalDocumentReceipt(record());
  for (const kind of ["chart-type", "interval"]) {
    const lifecycle = completed(kind);
    const variant = gestureVariantReceipt(
      kind,
      lifecycle,
      canonical,
      canonical,
      activityEvidence(kind, lifecycle),
    );
    assert.equal(variant.kind, kind);
    assert.equal(variant.transactionId, lifecycle.transactionId);
    assert.equal(variant.gestureId, lifecycle.gestureId);
    assert.deepEqual(variant.events, lifecycle.events);
    assert.deepEqual(variant.canonical.before, variant.canonical.after);
  }
});

test("gesture variant fails closed on identity, reason, boundary, ordering, and canonical drift", () => {
  const canonical = canonicalDocumentReceipt(record());
  const mutations = [
    (value) => { value.events.pop(); },
    (value) => { value.events[1].gestureId = "other"; },
    (value) => { value.events[1].beforeValue = value.events[1].afterValue; },
    (value) => { value.events[2].reason = "coordinate-change"; },
    (value) => { value.events[2].observedAt = "2026-07-16T00:00:00.000Z"; },
  ];
  for (const mutate of mutations) {
    const lifecycle = structuredClone(completed("chart-type"));
    mutate(lifecycle);
    assert.throws(
      () => gestureVariantReceipt(
        "chart-type",
        lifecycle,
        canonical,
        canonical,
        activityEvidence("chart-type", lifecycle),
      ),
      /receipt is invalid/,
    );
  }
  assert.throws(
    () => gestureVariantReceipt(
      "chart-type",
      completed("chart-type"),
      canonical,
      canonicalDocumentReceipt(record({ price: 45_000 })),
      activityEvidence("chart-type", completed("chart-type")),
    ),
    /changed the canonical drawing document/,
  );
});

test("gesture variant rejects detached or incomplete physical activity evidence", () => {
  const canonical = canonicalDocumentReceipt(record());
  const cases = [
    (evidence) => { delete evidence.pointerLedgerAfterHeldProbe; },
    (evidence) => { evidence.liveInk.cancelled = 1; },
    (evidence) => { evidence.pointerLedgerAtCancellation.events.push(pointerEvent("pointerup")); },
    (evidence) => { evidence.pointerLedgerAfterRelease.events.at(-1).pointerId = 2; },
    (evidence) => { evidence.uiBoundary.afterValue = "detached-ui-value"; },
    (evidence) => { evidence.productLifecycle.events[2].reason = "detached-reason"; },
  ];
  for (const mutate of cases) {
    const lifecycle = completed("chart-type");
    const evidence = activityEvidence("chart-type", lifecycle);
    mutate(evidence);
    assert.throws(
      () => gestureVariantReceipt("chart-type", lifecycle, canonical, canonical, evidence),
      /activity evidence is invalid/,
    );
  }
});

test("gesture evidence rejects a pre-position hover move instead of weakening the held-pointer contract", () => {
  const lifecycle = completed("chart-type");
  const evidence = activityEvidence("chart-type", lifecycle);
  const hover = pointerEvent("pointermove", {
    buttons: 0,
    clientX: POINTER.start.x,
    clientY: POINTER.start.y,
    observedAt: "2026-07-17T00:59:59.999Z",
  });
  for (const key of [
    "pointerLedgerAtActive",
    "pointerLedgerAtCancellation",
    "pointerLedgerAfterHeldProbe",
    "pointerLedgerAfterRelease",
  ]) {
    evidence[key] = ledger([hover, ...evidence[key].events]);
  }
  assert.deepEqual(
    gestureActivityEvidenceFailures("chart-type", lifecycle, evidence, { phase: "armed" }),
    ["chart-type-pointer-active-ledger-invalid"],
  );
  const canonical = canonicalDocumentReceipt(record());
  assert.throws(
    () => gestureVariantReceipt("chart-type", lifecycle, canonical, canonical, evidence),
    /chart-type-pointer-active-ledger-invalid/,
  );
});

test("pointer pre-positioning resets the trusted ledger only after the hover frame", async () => {
  const operations = [];
  const session = {
    cdp: {
      async send(method, payload) {
        assert.equal(method, "Input.dispatchMouseEvent");
        assert.equal(payload.type, "mouseMoved");
        assert.equal(payload.buttons, 0);
        operations.push("hover");
      },
      async evaluate(expression) {
        if (expression.includes("requestAnimationFrame")) {
          operations.push("frame");
          return true;
        }
        assert.match(expression, /\.reset\?\.\(\)/);
        operations.push("reset");
        return true;
      },
    },
  };
  await prepositionPointerAndResetLedger(session, POINTER.start);
  assert.deepEqual(operations, ["hover", "frame", "reset"]);
});

test("pressed mouse lease releases exactly once on arming failure and hands success to the caller", async () => {
  const dispatched = [];
  const session = {
    cdp: {
      async send(method, payload) {
        assert.equal(method, "Input.dispatchMouseEvent");
        dispatched.push(payload.type);
      },
    },
  };
  const armingError = new Error("arming wait failed");
  await assert.rejects(
    pressAndHandOffHeldPointer(session, POINTER, async () => { throw armingError; }),
    (error) => error === armingError,
  );
  assert.deepEqual(dispatched, ["mousePressed", "mouseReleased"]);

  dispatched.length = 0;
  assert.equal(
    await pressAndHandOffHeldPointer(session, POINTER, async () => "armed"),
    "armed",
  );
  assert.deepEqual(dispatched, ["mousePressed"]);
  await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased" });
  assert.deepEqual(dispatched, ["mousePressed", "mouseReleased"]);
});

test("lifecycle injection is derived from both trusted active/cancel/release evidence chains", () => {
  const canonical = canonicalDocumentReceipt(record());
  const variants = ["chart-type", "interval"].map((kind) => gestureVariantReceipt(
    kind,
    completed(kind),
    canonical,
    canonical,
    activityEvidence(kind, completed(kind)),
  ));
  const navigation = {
    kind: "controlled-rollback-drill-navigation",
    drillId: "active-gesture-chart-boundary",
    variant: null,
    runId: "run",
    faultId: "fault",
    sequence: 1,
    authorityTokenSha256: "a".repeat(64),
    bootstrap: { authorityAccepted: true, tokenRemoved: true },
  };
  assert.deepEqual(
    lifecycleInjectionReceipt(variants, navigation, true),
    {
      kind: "active-gesture-chart-boundary",
      variants: ["chart-type", "interval"],
      armed: true,
      observed: true,
      buildAuthorityCurrent: true,
      navigation: {
        runId: "run",
        faultId: "fault",
        sequence: 1,
        authorityTokenSha256: `sha256:${"a".repeat(64)}`,
      },
    },
  );
  const untrusted = structuredClone(variants);
  untrusted[1].activityEvidence.pointerLedgerAtActive.trustedCounts.pointerdown = 0;
  assert.equal(lifecycleInjectionReceipt(untrusted, navigation, true).armed, false);
  const detachedProductLifecycle = structuredClone(variants);
  detachedProductLifecycle[0].activityEvidence.productLifecycle.gestureId = "other-gesture";
  assert.equal(lifecycleInjectionReceipt(detachedProductLifecycle, navigation, true).observed, false);
  const earlyRelease = structuredClone(variants);
  earlyRelease[0].activityEvidence.pointerLedgerAtCancellation.trustedCounts.pointerup = 1;
  assert.equal(lifecycleInjectionReceipt(earlyRelease, navigation, true).observed, false);
  assert.equal(lifecycleInjectionReceipt(variants, navigation, false).observed, false);
});
