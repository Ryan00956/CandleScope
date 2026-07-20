import assert from "node:assert/strict";
import test from "node:test";

import { handleReplayShortcut, replayShortcutAction } from "../replayShortcuts.js";
import type { ReplayShortcutEventLike } from "../replayShortcuts.js";

function event(key: string, overrides: Partial<ReplayShortcutEventLike> = {}): ReplayShortcutEventLike & { prevented: boolean } {
  const value = {
    key,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    target: null,
    prevented: false,
    preventDefault() { value.prevented = true; },
    ...overrides,
  };
  return value;
}

test("space, right and shift+right map to replay-only controls", () => {
  assert.equal(replayShortcutAction(event(" ")), "toggle-play");
  assert.equal(replayShortcutAction(event("ArrowRight")), "step");
  assert.equal(replayShortcutAction(event("ArrowRight", { shiftKey: true })), "advance-window");
  assert.equal(replayShortcutAction(event("ArrowLeft")), null);
});

test("modifiers, repeats and editable focus never steal keyboard input", () => {
  assert.equal(replayShortcutAction(event(" ", { ctrlKey: true })), null);
  assert.equal(replayShortcutAction(event("ArrowRight", { repeat: true })), null);
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
  class FakeElement {
    matches() { return true; }
    closest() { return this; }
  }
  Object.defineProperty(globalThis, "Element", { configurable: true, value: FakeElement });
  try {
    assert.equal(replayShortcutAction(event(" ", { target: new FakeElement() as unknown as EventTarget })), null);
  } finally {
    if (previousElement) Object.defineProperty(globalThis, "Element", previousElement);
    else Reflect.deleteProperty(globalThis, "Element");
  }
});

test("buttons, links and their descendants retain native keyboard activation", () => {
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
  class FakeElement {
    constructor(private readonly interactive: boolean) {}
    matches() { return this.interactive; }
    closest() { return this.interactive ? this : null; }
  }
  Object.defineProperty(globalThis, "Element", { configurable: true, value: FakeElement });
  try {
    for (const target of [new FakeElement(true), new FakeElement(true)]) {
      const source = event(" ", { target: target as unknown as EventTarget });
      assert.equal(handleReplayShortcut(source, () => true), false);
      assert.equal(source.prevented, false);
    }
  } finally {
    if (previousElement) Object.defineProperty(globalThis, "Element", previousElement);
    else Reflect.deleteProperty(globalThis, "Element");
  }
});

test("handled shortcuts prevent browser defaults exactly once", () => {
  const source = event("ArrowRight");
  const actions: string[] = [];
  assert.equal(handleReplayShortcut(source, (action) => {
    actions.push(action);
    return true;
  }), true);
  assert.equal(source.prevented, true);
  assert.deepEqual(actions, ["step"]);
});

test("recognized shortcuts do not prevent defaults when runtime state rejects the action", () => {
  const source = event("ArrowRight");
  assert.equal(handleReplayShortcut(source, () => false), false);
  assert.equal(source.prevented, false);
});
