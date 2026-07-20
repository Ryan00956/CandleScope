import test from "node:test";
import assert from "node:assert/strict";
import {
  createCursorOverlayGeometryCache,
  resolveCursorOverlayPoint,
  resolvePaneCaptureSize,
  subscribeCursorOverlayGeometryRefresh,
  type CursorOverlayGeometrySource,
} from "../singleChartPaneGeometry.js";

test("cursor overlay hot-path projection never reads container geometry", () => {
  let rect = { left: 100, top: 200 };
  let rectReads = 0;
  const source: CursorOverlayGeometrySource = {
    getBoundingClientRect() {
      rectReads += 1;
      return rect;
    },
  };
  const cache = createCursorOverlayGeometryCache();
  const plotRect = { x: 20, y: 10, width: 300, height: 180 };
  const point = { x: 0, y: 0 };

  cache.capture(source);
  assert.equal(rectReads, 1);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(resolveCursorOverlayPoint(cache, 150, 240, plotRect, point), true);
    assert.deepEqual(point, { x: 50, y: 40 });
  }
  assert.equal(rectReads, 1, "pointermove-style projections must consume only the cached rect");

  rect = { left: 120, top: 220 };
  cache.invalidate();
  assert.equal(resolveCursorOverlayPoint(cache, 150, 240, plotRect, point), false);
  assert.equal(rectReads, 1, "a cache miss must fail closed instead of reading layout");

  cache.capture(source);
  assert.equal(resolveCursorOverlayPoint(cache, 170, 260, plotRect, point), true);
  assert.deepEqual(point, { x: 50, y: 40 });
  assert.equal(rectReads, 2);
});

test("resize, captured scroll, and ResizeObserver refresh geometry outside pointermove", () => {
  let rect = { left: 10, top: 20 };
  let rectReads = 0;
  const listeners = new Map<string, { listener: EventListener; capture: boolean }>();
  const removed: string[] = [];
  const eventTarget = {
    addEventListener(type: "resize" | "scroll", listener: EventListener, options?: boolean | AddEventListenerOptions) {
      listeners.set(type, { listener, capture: options === true });
    },
    removeEventListener(type: "resize" | "scroll", listener: EventListener, options?: boolean | EventListenerOptions) {
      const registered = listeners.get(type);
      assert.strictEqual(registered?.listener, listener);
      assert.equal(registered?.capture, options === true);
      listeners.delete(type);
      removed.push(type);
    },
  };
  const documentTarget = { defaultView: eventTarget } as unknown as Document;
  const container = {
    ownerDocument: documentTarget,
    getBoundingClientRect() {
      rectReads += 1;
      return rect;
    },
  } as HTMLElement;
  const resizeObserverState: { callback: ResizeObserverCallback | null } = { callback: null };
  let observed: Element | null = null;
  let disconnects = 0;
  const cache = createCursorOverlayGeometryCache();
  const cleanup = subscribeCursorOverlayGeometryRefresh({
    cache,
    container,
    eventTarget,
    createResizeObserver(callback) {
      resizeObserverState.callback = callback;
      return {
        observe(target) {
          observed = target;
        },
        disconnect() {
          disconnects += 1;
        },
      };
    },
  });

  assert.strictEqual(observed, container);
  assert.equal(rectReads, 1, "subscription setup provides the first cached sample");
  assert.equal(listeners.get("scroll")?.capture, true);

  rect = { left: 30, top: 40 };
  listeners.get("resize")?.listener(new Event("resize"));
  assert.equal(cache.peek()?.left, 30);
  assert.equal(rectReads, 2);

  const fireScroll = (target: EventTarget) => {
    const event = new Event("scroll");
    Object.defineProperty(event, "target", { value: target });
    listeners.get("scroll")?.listener(event);
  };
  const descendant = { contains: () => false } as unknown as EventTarget;
  const unrelatedSidebar = { contains: () => false } as unknown as EventTarget;
  const scrollingAncestor = {
    contains: (target: Node) => target === container,
  } as unknown as EventTarget;

  fireScroll(container);
  fireScroll(descendant);
  fireScroll(unrelatedSidebar);
  assert.equal(rectReads, 2, "container, descendant, and unrelated scrolls must stay cold");

  rect = { left: 50, top: 60 };
  fireScroll(scrollingAncestor);
  assert.equal(cache.peek()?.top, 60);
  assert.equal(rectReads, 3);

  rect = { left: 70, top: 80 };
  fireScroll(eventTarget as unknown as EventTarget);
  assert.equal(cache.peek()?.left, 70);
  assert.equal(rectReads, 4);

  rect = { left: 90, top: 100 };
  fireScroll(documentTarget);
  assert.equal(cache.peek()?.top, 100);
  assert.equal(rectReads, 5);

  rect = { left: 110, top: 120 };
  assert.ok(resizeObserverState.callback);
  resizeObserverState.callback([], {} as ResizeObserver);
  assert.equal(cache.peek()?.left, 110);
  assert.equal(rectReads, 6);

  cleanup();
  assert.equal(disconnects, 1);
  assert.deepEqual(removed.sort(), ["resize", "scroll"]);
  assert.equal(cache.peek(), null);
  cleanup();
  assert.equal(disconnects, 1, "cleanup remains idempotent under effect replay");
});

test("pane capture uses chart paneSize without touching DOM fallbacks", () => {
  let heightReads = 0;
  let widthReads = 0;
  const fallback = {
    get clientHeight() {
      heightReads += 1;
      return 720;
    },
    get clientWidth() {
      widthReads += 1;
      return 1280;
    },
  };

  assert.deepEqual(resolvePaneCaptureSize({ height: 400, width: 900 }, fallback), {
    heightCssPx: 400,
    widthCssPx: 900,
  });
  assert.equal(heightReads, 0);
  assert.equal(widthReads, 0);

  assert.deepEqual(resolvePaneCaptureSize({ height: Number.NaN, width: 900 }, fallback), {
    heightCssPx: 720,
    widthCssPx: 900,
  });
  assert.equal(heightReads, 1);
  assert.equal(widthReads, 0);
});
