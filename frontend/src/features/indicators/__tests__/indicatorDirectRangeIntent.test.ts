import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeferredIndicatorRangeIntentRegistry,
  resolveDirectIndicatorRangeRevision,
} from "../indicatorRangeRequestDedupe.js";

interface Payload {
  kind: "auto-right" | "visible-range" | "ws-fallback";
}

function intent(kind: Payload["kind"], fingerprint = "v1") {
  return {
    fingerprint: `${kind}:${fingerprint}`,
    key: `direct:${kind}`,
    payload: { kind },
    range: { start: 1_000, end: 2_000 },
    revision: { serverEpoch: "boot-1", correctionRevision: 3 },
    seriesKey: "session|binance|spot|BTCUSDT|89m",
  };
}

for (const kind of ["auto-right", "visible-range", "ws-fallback"] as const) {
  test(`${kind} NOT_READY waits for a matching event then runs exactly once more`, () => {
    const registry = createDeferredIndicatorRangeIntentRegistry<Payload>();
    const current = intent(kind);
    const version = registry.remember(current);
    assert.equal(typeof version, "number");

    let physicalRequests = 0;
    const first = registry.begin(current.key, version ?? undefined);
    assert.ok(first);
    physicalRequests += 1;
    assert.equal(registry.defer(current.key, first.version, {
      afterEventId: 10,
      revision: current.revision,
    }), true);

    assert.deepEqual(registry.releaseForEvents(current.seriesKey, [
      { id: 10, start: 1_000, end: 2_000 },
      { id: 11, start: 3_000, end: 4_000 },
    ]), []);
    assert.equal(registry.begin(current.key), null);

    const released = registry.releaseForEvents(current.seriesKey, [
      { id: 11, start: 1_500, end: 1_600 },
    ]);
    assert.equal(released.length, 1);
    const second = registry.begin(current.key, released[0]?.version);
    assert.ok(second);
    physicalRequests += 1;
    assert.equal(registry.complete(current.key, second.version), true);

    assert.equal(physicalRequests, 2);
    assert.equal(registry.has(current.key), false);
    assert.deepEqual(registry.releaseForEvents(current.seriesKey, [
      { id: 12, start: 1_500, end: 1_600 },
    ]), []);
  });
}

test("event arriving during HTTP flight releases the post-response wait exactly once", () => {
  const registry = createDeferredIndicatorRangeIntentRegistry<Payload>();
  const current = intent("auto-right");
  const version = registry.remember(current);
  const first = registry.begin(current.key, version ?? undefined);
  assert.ok(first);

  // Physical request captured event 10, then event 11 arrived before its
  // NOT_READY response. Blocking with the dispatch frontier lets the
  // synchronous post-block check observe that event instead of losing it.
  registry.defer(current.key, first.version, {
    afterEventId: 10,
    revision: current.revision,
  });
  const released = registry.releaseForEvents(current.seriesKey, [
    { id: 11, start: 1_500, end: 1_600 },
  ]);
  assert.equal(released.length, 1);
  assert.deepEqual(registry.releaseForEvents(current.seriesKey, [
    { id: 11, start: 1_500, end: 1_600 },
  ]), []);
  assert.ok(registry.begin(current.key, released[0]?.version));
  assert.equal(registry.begin(current.key), null);
});

test("an already blocked request uses its current frontier and does not spin on an old event", () => {
  const registry = createDeferredIndicatorRangeIntentRegistry<Payload>();
  const current = intent("visible-range");
  const version = registry.remember(current);
  const first = registry.begin(current.key, version ?? undefined);
  assert.ok(first);

  // The lower target wait already existed when this direct attempt began, so
  // its fallback frontier is the current event 11, never zero.
  registry.defer(current.key, first.version, {
    afterEventId: 11,
    revision: current.revision,
  });
  assert.deepEqual(registry.releaseForEvents(current.seriesKey, [
    { id: 11, start: 1_500, end: 1_600 },
  ]), []);
  assert.equal(registry.begin(current.key), null);
  const released = registry.releaseForEvents(current.seriesKey, [
    { id: 12, start: 1_500, end: 1_600 },
  ]);
  assert.equal(released.length, 1);
  assert.ok(registry.begin(current.key, released[0]?.version));
});

test("a newer visible-range intent cannot be completed by the older response", () => {
  const registry = createDeferredIndicatorRangeIntentRegistry<Payload>();
  const oldIntent = intent("visible-range", "old");
  const oldVersion = registry.remember(oldIntent);
  const oldAttempt = registry.begin(oldIntent.key, oldVersion ?? undefined);
  assert.ok(oldAttempt);

  const newIntent = {
    ...intent("visible-range", "new"),
    range: { start: 2_000, end: 3_000 },
  };
  const newVersion = registry.remember(newIntent);
  assert.notEqual(newVersion, oldVersion);
  assert.equal(registry.complete(oldIntent.key, oldAttempt.version), false);
  assert.deepEqual(registry.begin(newIntent.key, newVersion ?? undefined)?.intent.range, {
    start: 2_000,
    end: 3_000,
  });
});

test("ordinary failure remains retryable without an event", () => {
  const registry = createDeferredIndicatorRangeIntentRegistry<Payload>();
  const current = intent("ws-fallback");
  const version = registry.remember(current);
  const first = registry.begin(current.key, version ?? undefined);
  assert.ok(first);
  assert.equal(registry.fail(current.key, first.version), true);
  assert.ok(registry.begin(current.key, first.version));
});

test("held WS fallback is replayable only for its current series and session clear drops it", () => {
  const registry = createDeferredIndicatorRangeIntentRegistry<Payload>();
  const current = intent("ws-fallback");
  const other = {
    ...intent("ws-fallback", "other"),
    key: "direct:ws-fallback:other",
    seriesKey: "session|binance|spot|ETHUSDT|89m",
  };
  const version = registry.remember(current);
  registry.remember(other);

  assert.deepEqual(
    registry.readyForSeries(current.seriesKey).map((attempt) => attempt.intent.key),
    [current.key],
  );
  const attempt = registry.begin(current.key, version ?? undefined);
  assert.ok(attempt);
  assert.deepEqual(registry.readyForSeries(current.seriesKey), []);
  assert.equal(registry.fail(current.key, attempt.version), true);
  assert.equal(registry.readyForSeries(current.seriesKey).length, 1);

  registry.clear();
  assert.deepEqual(registry.readyForSeries(current.seriesKey), []);
  assert.deepEqual(registry.readyForSeries(other.seriesKey), []);
});

test("WS replay uses the current series revision instead of its captured wait revision", () => {
  assert.deepEqual(resolveDirectIndicatorRangeRevision(
    { serverEpoch: "boot-1", correctionRevision: 4, closedThrough: 4_000 },
    { serverEpoch: "boot-1", correctionRevision: 3, closedThrough: 3_000 },
  ), {
    serverEpoch: "boot-1",
    correctionRevision: "4",
    closedThrough: 4_000,
  });
  assert.deepEqual(resolveDirectIndicatorRangeRevision(
    null,
    { serverEpoch: "boot-1", correctionRevision: 3 },
  ), {
    serverEpoch: "boot-1",
    correctionRevision: "3",
  });
  assert.deepEqual(resolveDirectIndicatorRangeRevision(
    { serverEpoch: "boot-1", correctionRevision: 3 },
    { serverEpoch: "boot-1", correctionRevision: 4 },
  )?.correctionRevision, "4");
});
