import assert from "node:assert/strict";
import test from "node:test";

import {
  subscribeDrawingFontMetricRevision,
  type DrawingFontMetricSource,
} from "../drawingFontMetricRevision.js";

type FontMetricEvent = Parameters<DrawingFontMetricSource["addEventListener"]>[0];
type FontMetricListener = Parameters<DrawingFontMetricSource["addEventListener"]>[1];

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function fontMetricSource(ready: PromiseLike<unknown>): Readonly<{
  source: DrawingFontMetricSource;
  emit(event: FontMetricEvent): void;
  listenerCount(): number;
}> {
  const listeners = new Map<FontMetricEvent, Set<FontMetricListener>>();
  const listenersFor = (event: FontMetricEvent) => {
    let eventListeners = listeners.get(event);
    if (!eventListeners) {
      eventListeners = new Set();
      listeners.set(event, eventListeners);
    }
    return eventListeners;
  };
  return {
    source: {
      ready,
      addEventListener: (event, listener) => listenersFor(event).add(listener),
      removeEventListener: (event, listener) => listenersFor(event).delete(listener),
    },
    emit: (event) => {
      for (const listener of listenersFor(event)) listener();
    },
    listenerCount: () => [...listeners.values()]
      .reduce((count, eventListeners) => count + eventListeners.size, 0),
  };
}

test("font loading events only advance the revision callback", () => {
  const pendingReady = deferred();
  const fonts = fontMetricSource(pendingReady.promise);
  let revision = 0;
  const cleanup = subscribeDrawingFontMetricRevision(fonts.source, () => { revision += 1; });

  assert.equal(fonts.listenerCount(), 2);
  fonts.emit("loadingdone");
  assert.equal(revision, 1);
  fonts.emit("loadingerror");
  assert.equal(revision, 2);

  cleanup();
});

test("initial fonts.ready advances once when the subscription remains current", async () => {
  const initialReady = deferred();
  const fonts = fontMetricSource(initialReady.promise);
  let revision = 0;
  const cleanup = subscribeDrawingFontMetricRevision(fonts.source, () => { revision += 1; });

  initialReady.resolve();
  await initialReady.promise;
  await Promise.resolve();
  assert.equal(revision, 1);

  cleanup();
});

test("cleanup ignores a stale ready promise and removes event listeners", async () => {
  const staleReady = deferred();
  const fonts = fontMetricSource(staleReady.promise);
  let revision = 0;
  const cleanup = subscribeDrawingFontMetricRevision(fonts.source, () => { revision += 1; });

  cleanup();
  cleanup();
  assert.equal(fonts.listenerCount(), 0);
  fonts.emit("loadingdone");
  staleReady.resolve();
  await staleReady.promise;
  await Promise.resolve();
  assert.equal(revision, 0);
});

test("unsupported font sources are a safe no-op", () => {
  let revision = 0;
  const cleanup = subscribeDrawingFontMetricRevision(null, () => { revision += 1; });
  assert.doesNotThrow(cleanup);
  assert.equal(revision, 0);
});
