import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeferredAbortableTask,
  PLUGIN_LIVE_ACTIVE_POLL_MS,
  PLUGIN_LIVE_IDLE_REVALIDATE_MS,
  pluginCatalogNeedsChartContextSync,
  pluginCatalogNeedsUiPolling,
  pluginLivePollIntervalMs,
} from "../pluginRefreshRuntime.js";
import type {
  PluginCatalog,
  PluginCatalogPlugin,
  PluginLiveControlStatus,
  PluginUiSnapshot,
} from "../pluginPlatformTypes.js";

function plugin(
  overrides: Partial<PluginCatalogPlugin> = {},
): PluginCatalogPlugin {
  return {
    enabled: true,
    available: true,
    state: "active",
    contributions: [],
    permissions: { permissions: [] },
    ...overrides,
  } as unknown as PluginCatalogPlugin;
}

function catalog(plugins: PluginCatalogPlugin[] = []): PluginCatalog {
  return {
    platform: { enabled: true, started: true, registryRevision: 1 },
    plugins,
  } as unknown as PluginCatalog;
}

function snapshot(
  views = 0,
  chartLayers = 0,
): PluginUiSnapshot {
  return {
    schemaVersion: "candlescope.plugin-ui/1",
    registryRevision: 1,
    views: Array.from({ length: views }, () => ({})),
    chartLayers: Array.from({ length: chartLayers }, () => ({})),
  } as unknown as PluginUiSnapshot;
}

function liveStatus(
  overrides: Partial<PluginLiveControlStatus> = {},
): PluginLiveControlStatus {
  return {
    schemaVersion: "candlescope.live-control-status/1",
    available: false,
    mode: "disabled",
    generation: 0,
    policyEpoch: 0,
    updatedAt: null,
    outstandingConfirmationCount: 0,
    confirmationCounts: { consumed: 0, expired: 0, issued: 0, revoked: 0 },
    eventSequence: 0,
    eventSha256: null,
    liveSubmitAvailable: false,
    liveCancelAvailable: false,
    liveTransferAvailable: false,
    ...overrides,
  };
}

test("empty or inactive plugin platforms do not enable high-frequency UI polling", () => {
  assert.equal(pluginCatalogNeedsUiPolling(null, null), false);
  assert.equal(pluginCatalogNeedsUiPolling(catalog(), snapshot()), false);
  assert.equal(pluginCatalogNeedsChartContextSync(catalog()), false);
  assert.equal(
    pluginCatalogNeedsUiPolling(
      catalog([plugin({ enabled: false, available: false })]),
      snapshot(),
    ),
    false,
  );
});

test("only active declarative views and granted chart layers enable UI polling", () => {
  const declarativeView = {
    available: true,
    kind: "view/1",
    configuration: { renderer: "table" },
  } as unknown as PluginCatalogPlugin["contributions"][number];
  const sandboxView = {
    available: true,
    kind: "view/1",
    configuration: { renderer: "sandbox" },
  } as unknown as PluginCatalogPlugin["contributions"][number];
  const chartLayerGrant = {
    permissionId: "chart.layer.publish",
    decision: "granted",
  } as PluginCatalogPlugin["permissions"]["permissions"][number];

  assert.equal(
    pluginCatalogNeedsUiPolling(
      catalog([plugin({ contributions: [declarativeView] })]),
      snapshot(),
    ),
    true,
  );
  assert.equal(
    pluginCatalogNeedsUiPolling(
      catalog([plugin({ contributions: [sandboxView] })]),
      snapshot(),
    ),
    false,
  );
  const chartPlugin = plugin({
    permissions: { permissions: [chartLayerGrant] },
  } as Partial<PluginCatalogPlugin>);
  assert.equal(
    pluginCatalogNeedsUiPolling(catalog([chartPlugin]), snapshot()),
    true,
  );
  assert.equal(pluginCatalogNeedsChartContextSync(catalog([chartPlugin])), true);
});

test("visible snapshot content keeps polling until the Host publishes its removal", () => {
  assert.equal(pluginCatalogNeedsUiPolling(catalog(), snapshot(1, 0)), true);
  assert.equal(pluginCatalogNeedsUiPolling(catalog(), snapshot(0, 1)), true);
});

test("Live control uses fast polling only for active or recovering authority", () => {
  assert.equal(
    pluginLivePollIntervalMs(liveStatus()),
    PLUGIN_LIVE_IDLE_REVALIDATE_MS,
  );
  assert.equal(
    pluginLivePollIntervalMs(liveStatus({
      available: true,
      mode: "armed",
      generation: 2,
      updatedAt: "2026-07-30T01:02:03Z",
    })),
    PLUGIN_LIVE_ACTIVE_POLL_MS,
  );
  assert.equal(
    pluginLivePollIntervalMs(liveStatus({
      mode: "unavailable",
      generation: 2,
      updatedAt: "2026-07-30T01:02:03Z",
    })),
    PLUGIN_LIVE_ACTIVE_POLL_MS,
  );
});

test("deferred bootstrap cancels the StrictMode rehearsal before it starts HTTP", async () => {
  let scheduled: (() => void) | null = null;
  let calls = 0;
  let clears = 0;
  const timers = {
    setTimeout(callback: () => void) {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout() {
      clears += 1;
      scheduled = null;
    },
  };

  const rehearsal = createDeferredAbortableTask(async () => {
    calls += 1;
  }, { timers });
  rehearsal.start();
  rehearsal.stop();
  assert.equal(calls, 0);
  assert.equal(clears, 1);
  assert.equal(scheduled, null);

  const committed = createDeferredAbortableTask(async () => {
    calls += 1;
  }, { timers });
  committed.start();
  assert.equal(typeof scheduled, "function");
  const run = scheduled as unknown as () => void;
  scheduled = null;
  run();
  await Promise.resolve();
  assert.equal(calls, 1);
  committed.stop();
});

test("deferred bootstrap aborts an in-flight request group on cleanup", async () => {
  let scheduled: (() => void) | null = null;
  const observed: { signal?: AbortSignal } = {};
  let release!: () => void;
  const timers = {
    setTimeout(callback: () => void) {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout() {
      scheduled = null;
    },
  };
  const task = createDeferredAbortableTask(
    (signal) => new Promise<void>((resolve) => {
      observed.signal = signal;
      release = resolve;
    }),
    { timers },
  );

  task.start();
  const run = scheduled as unknown as () => void;
  scheduled = null;
  run();
  await Promise.resolve();
  const observedSignal = observed.signal;
  assert.ok(observedSignal);
  task.stop();
  assert.equal(observedSignal.aborted, true);
  release();
  await Promise.resolve();
});
