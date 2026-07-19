import assert from "node:assert/strict";
import test from "node:test";

import { createWatchlistPriceSocketSession } from "../watchlistPriceSocketSession.js";

test("a stopped StrictMode generation rejects late frames while the replay accepts its socket", () => {
  const oldSocket = {};
  const nextSocket = {};
  const firstSetup = createWatchlistPriceSocketSession<object>();
  assert.equal(firstSetup.activate(oldSocket), true);
  assert.equal(firstSetup.accepts(oldSocket), true);
  assert.equal(firstSetup.stop(), oldSocket);
  assert.equal(firstSetup.accepts(oldSocket), false);

  const replaySetup = createWatchlistPriceSocketSession<object>();
  assert.equal(replaySetup.activate(nextSocket), true);
  assert.equal(replaySetup.accepts(oldSocket), false);
  assert.equal(replaySetup.accepts(nextSocket), true);
});

test("a released reconnect generation cannot publish after its successor activates", () => {
  const firstSocket = {};
  const secondSocket = {};
  const session = createWatchlistPriceSocketSession<object>();
  assert.equal(session.activate(firstSocket), true);
  assert.equal(session.release(firstSocket), true);
  assert.equal(session.activate(secondSocket), true);
  assert.equal(session.accepts(firstSocket), false);
  assert.equal(session.accepts(secondSocket), true);
  assert.equal(session.release(firstSocket), false);
  assert.equal(session.accepts(secondSocket), true);
});

test("stop is terminal and returns the active socket only once", () => {
  const socket = {};
  const session = createWatchlistPriceSocketSession<object>();
  assert.equal(session.activate(socket), true);
  assert.equal(session.stop(), socket);
  assert.equal(session.stop(), null);
  assert.equal(session.activate({}), false);
  assert.equal(session.isStopped(), true);
});
