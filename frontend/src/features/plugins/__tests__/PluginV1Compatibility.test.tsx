import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginSettingsPanel } from "../PluginPlatformSurfaces.js";
import PluginPlatformToolbar from "../PluginPlatformToolbar.js";
import { SETTINGS_CATEGORIES } from "../../settings/settingsTabRegistry.js";
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
    ...(platformEnabled ? {
      runtimeRegistry: {
        schemaVersion: "candlescope.runtime-registry-status/1",
        enabled: true,
        networkUpdatesEnabled: false,
        automaticUpdates: false,
        active: {
          registryId: "candlescope.reference-runtime",
          revision: 1,
          registrySha256: `sha256:${"c".repeat(64)}`,
          issuedAt: "2026-08-03T00:00:00Z",
          rollbackAvailable: false,
          revokedArtifactCount: 0,
        },
        runtimes: [{
          runtimeId: "temurin-21.0.12.8",
          kind: "java" as const,
          version: "21.0.12+8-LTS",
          os: "windows",
          arch: "x86_64",
          sourceUrl: "https://github.com/adoptium/temurin21-binaries/releases/download/runtime.zip",
          sha256: `sha256:${"a".repeat(64)}`,
          size: 48_993_215,
          license: "GPL-2.0 WITH Classpath-exception-2.0",
          upstreamReleaseUrl: "https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12%2B8",
          source: "host-managed" as const,
          registryId: "candlescope.reference-runtime",
          registryRevision: 1,
          registrySha256: `sha256:${"c".repeat(64)}`,
          verificationStatus: "verified" as const,
          cached: true,
          probeSha256: `sha256:${"b".repeat(64)}`,
          referenceCount: 0,
          reproducible: true as const,
        }],
        systemRuntimes: [],
      },
    } : {}),
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
  assert.equal(toolbar, "");
  assert.equal(
    SETTINGS_CATEGORIES.some((category) => category.key === "plugins"),
    true,
  );

  const manager = renderToStaticMarkup(<PluginSettingsPanel runtime={value} />);
  assert.match(manager, /脚本运行时/);
  assert.match(manager, /data-v1-runtime="candlescope.pyne"/);
  assert.match(manager, /candlescope\.script-runtime\/1/);
  assert.match(manager, /启用插件平台后/);
  assert.doesNotMatch(manager, /data-plugin-install-input/);
  assert.doesNotMatch(manager, /<iframe/);
});

test("enabled platform exposes separate import and rollback previews", () => {
  const manager = renderToStaticMarkup(
    <PluginSettingsPanel runtime={runtime(true)} />,
  );
  assert.match(manager, /data-v1-compatibility-preview="import"/);
  assert.match(manager, /data-v1-compatibility-preview="rollback"/);
  assert.match(manager, /预览注册表导入/);
  assert.match(manager, /预览兼容层回滚/);
  assert.match(manager, /data-plugin-install-input/);
  assert.match(manager, /data-runtime-registry-revision="1"/);
  assert.match(manager, /宿主管理的运行时/);
  assert.match(manager, /temurin-21\.0\.12\.8/);
  assert.match(manager, /自动网络更新已关闭/);
  assert.doesNotMatch(manager, /Apply exact import preview/);
});

test("Phase 6 trust UX replaces direct install with an explicit double-confirmation surface", () => {
  const value = runtime(true);
  if (!value.view.catalog) assert.fail("catalog missing");
  value.view.catalog.trustUx = {
    schemaVersion: "candlescope.plugin-trust-ux/1",
    enabled: true,
    localInstallFlow: "itemized-double-confirmation",
    actor: "local-desktop-user",
    profiles: [{
      profileId: "restricted-python-v1",
      runtimeKind: "python-module",
      sandboxMode: "windows-appcontainer",
      sandboxSupported: true,
      trustedLocalOnly: false,
      networkDefault: "denied",
      subprocessDeclared: false,
      limits: { maxProcesses: 1 },
    }],
    highRiskAuthorityIndependent: true,
  };
  const manager = renderToStaticMarkup(<PluginSettingsPanel runtime={value} />);
  assert.match(manager, /data-plugin-trust-flow="itemized-double-confirmation"/);
  assert.match(manager, /完成两次独立确认后才首次执行插件代码/);
  assert.match(manager, /准备阶段不会运行语义探针或插件进程/);
  assert.match(manager, /选择 \.cspkg 并生成审阅单/);
  assert.doesNotMatch(manager, /经过摘要校验的本地插件包/);
});
