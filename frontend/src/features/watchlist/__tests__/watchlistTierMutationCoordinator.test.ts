import assert from "node:assert/strict";
import test from "node:test";

import { WatchlistTierMutationCoordinator } from "../watchlistTierMutationCoordinator.js";

test("only the newest same-symbol mutation can commit or roll back", () => {
  const coordinator = new WatchlistTierMutationCoordinator();
  const toPrice = coordinator.beginMutation("BTC", "none", "price");
  const toFull = coordinator.beginMutation("BTC", "price", "full");

  assert.equal(coordinator.resolveSuccess(toPrice, "price"), null);
  assert.equal(coordinator.resolveFailure(toPrice), null);
  assert.deepEqual(coordinator.resolveSuccess(toFull, "full"), {
    symbol: "BTC",
    tier: "full",
  });
});

test("the newest failure rolls back to the optimistic tier it actually observed", () => {
  const coordinator = new WatchlistTierMutationCoordinator();
  const toPrice = coordinator.beginMutation("BTC", "none", "price");
  const toFull = coordinator.beginMutation("BTC", "price", "full");

  assert.equal(coordinator.resolveFailure(toPrice), null);
  assert.deepEqual(coordinator.resolveFailure(toFull), {
    symbol: "BTC",
    tier: "price",
  });
});

test("a late refresh preserves mutations that started after its request", () => {
  const coordinator = new WatchlistTierMutationCoordinator();
  const refresh = coordinator.beginRefresh();
  const mutation = coordinator.beginMutation("BTC", "none", "full");
  assert.deepEqual(coordinator.resolveSuccess(mutation, "full"), {
    symbol: "BTC",
    tier: "full",
  });

  assert.deepEqual(coordinator.mergeRefresh(
    refresh,
    { BTC: "full", ETH: "price" },
    { BTC: "none", ETH: "full" },
  ), { BTC: "full", ETH: "full" });
});

test("a refresh started during a pending mutation cannot overwrite it after settlement", () => {
  const coordinator = new WatchlistTierMutationCoordinator();
  const mutation = coordinator.beginMutation("BTC", "price", "full");
  const refresh = coordinator.beginRefresh();
  coordinator.resolveSuccess(mutation, "full");

  assert.deepEqual(coordinator.mergeRefresh(
    refresh,
    { BTC: "full" },
    { BTC: "price" },
  ), { BTC: "full" });
});

test("an unprotected refresh remains authoritative for additions and removals", () => {
  const coordinator = new WatchlistTierMutationCoordinator();
  const refresh = coordinator.beginRefresh();
  const server = { ETH: "full" as const };

  assert.strictEqual(coordinator.mergeRefresh(refresh, server, server), server);
  assert.deepEqual(coordinator.mergeRefresh(
    refresh,
    { BTC: "price" },
    server,
  ), server);
});

test("an older whole-list refresh cannot overwrite a newer refresh", () => {
  const coordinator = new WatchlistTierMutationCoordinator();
  const older = coordinator.beginRefresh();
  const newer = coordinator.beginRefresh();
  const current = { BTC: "full" as const };

  assert.strictEqual(coordinator.mergeRefresh(
    older,
    current,
    { BTC: "price" },
  ), current);
  assert.deepEqual(coordinator.mergeRefresh(
    newer,
    current,
    { BTC: "none" },
  ), { BTC: "none" });
});

test("lifecycle cancellation makes every outstanding mutation stale", () => {
  const coordinator = new WatchlistTierMutationCoordinator();
  const mutation = coordinator.beginMutation("BTC", "none", "price");
  coordinator.cancelPending();

  assert.equal(coordinator.resolveSuccess(mutation, "price"), null);
  assert.equal(coordinator.resolveFailure(mutation), null);
});
