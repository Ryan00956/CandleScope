import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PluginPlatformSurfaces from "../PluginPlatformSurfaces.js";
import PluginPlatformToolbar from "../PluginPlatformToolbar.js";
import type {
  PluginCatalog,
  PluginPlatformRuntime,
} from "../pluginPlatformTypes.js";

function catalog(platformEnabled: boolean): PluginCatalog {
  return {
    schemaVersion: "candlescope.plugin-catalog/2",
    platform: {
      enabled: platformEnabled,
      started: platformEnabled,
      status: platformEnabled ? "ok" : "disabled",
      registryRevision: 0,
    },
    plugins: [],
    compatibility: {
      schemaVersion: "candlescope.v1-script-runtime-compatibility/1",
      status: "ready",
      kind: "script-runtime/1",
      protocol: "candlescope.script-runtime/1",
      renderProtocol: "candlescope.render/1",
      import: {
        status: "not-imported",
        stateRevision: 0,
        activeSnapshotRevision: null,
        sourceSha256: `sha256:${"a".repeat(64)}`,
        importedSourceSha256: null,
        historyDepth: 0,
        rollbackAvailable: false,
      },
      contributions: [{
        id: "compat.v1.candlescope.pyne",
        kind: "script-runtime/1",
        runtimeId: "candlescope.pyne",
        title: "Pyne Runtime",
        version: "1.0.0",
        package: "candlescope-plugin-pyne",
        available: true,
        protocol: "candlescope.script-runtime/1",
        renderProtocol: "candlescope.render/1",
        languages: [{
          id: "pyne",
          name: "Pyne",
          extensions: [],
          aliases: [],
          routeMode: "sidecar",
          available: true,
        }],
        features: ["batch-execution/1", "render.line-series/1"],
        routeModes: ["sidecar"],
        release: {
          managed: true,
          bundleSha256: `sha256:${"b".repeat(64)}`,
        },
        imported: false,
      }],
    },
  };
}

function runtime(platformEnabled: boolean): PluginPlatformRuntime {
  const emptyRegistries = {
    commandPalette: [],
    topToolbar: [],
    chartContextMenu: [],
    settings: [],
    sidePanel: [],
    bottomPanel: [],
    statusArea: [],
  };
  return {
    view: {
      catalog: catalog(platformEnabled),
      marketplaceCatalog: null,
      snapshot: null,
      registries: emptyRegistries,
      loading: false,
      error: null,
      managementAvailable: true,
      managerOpen: true,
      paletteOpen: false,
      openViewId: null,
      openSettingsId: null,
      notice: null,
      liveControl: {
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
      },
      liveControlOpen: false,
      markerSource: {},
      marketIdentity: {
        exchange: "binance",
        interval: "1m",
        marketType: "spot",
        symbol: "BTCUSDT",
      },
    },
    actions: {
      closeManager() {},
      openManager() {},
      clearNotice() {},
      closePalette() {},
      closeSettings() {},
      closeView() {},
    },
  } as unknown as PluginPlatformRuntime;
}

test("v1-only mode keeps one product directory without exposing v2 mutations", () => {
  const value = runtime(false);
  const toolbar = renderToStaticMarkup(<PluginPlatformToolbar runtime={value} />);
  assert.match(toolbar, /data-plugin-manager/);
  assert.doesNotMatch(toolbar, /data-plugin-command-palette/);

  const manager = renderToStaticMarkup(<PluginPlatformSurfaces runtime={value} />);
  assert.match(manager, /Script runtimes \(v1 compatibility\)/);
  assert.match(manager, /data-v1-runtime="candlescope.pyne"/);
  assert.match(manager, /candlescope\.script-runtime\/1/);
  assert.match(manager, /Enable Plugin Platform v2 to persist/);
  assert.doesNotMatch(manager, /data-plugin-install-input/);
  assert.doesNotMatch(manager, /<iframe/);
});

test("enabled platform exposes separate import and rollback previews", () => {
  const manager = renderToStaticMarkup(
    <PluginPlatformSurfaces runtime={runtime(true)} />,
  );
  assert.match(manager, /data-v1-compatibility-preview="import"/);
  assert.match(manager, /data-v1-compatibility-preview="rollback"/);
  assert.match(manager, /Preview registry import/);
  assert.match(manager, /Preview compatibility rollback/);
  assert.match(manager, /data-plugin-install-input/);
  assert.doesNotMatch(manager, /Apply exact import preview/);
});
