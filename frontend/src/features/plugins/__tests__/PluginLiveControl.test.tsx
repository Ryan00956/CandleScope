import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PluginLiveControl, { IntentFacts } from "../PluginLiveControl.js";
import type {
  PluginLiveControlStatus,
  PluginPlatformRuntime,
} from "../pluginPlatformTypes.js";

function status(
  mode: PluginLiveControlStatus["mode"],
  execution = false,
): PluginLiveControlStatus {
  const available = ["disarmed", "armed", "killed"].includes(mode);
  return {
    schemaVersion: "candlescope.live-control-status/1",
    available,
    mode,
    generation: available ? 2 : 0,
    policyEpoch: available ? 1 : 0,
    updatedAt: available ? "2026-07-23T01:02:03Z" : null,
    outstandingConfirmationCount: 0,
    confirmationCounts: { consumed: 0, expired: 0, issued: 0, revoked: 0 },
    eventSequence: available ? 3 : 0,
    eventSha256: available ? `sha256:${"a".repeat(64)}` : null,
    liveSubmitAvailable: execution,
    liveCancelAvailable: execution,
    liveTransferAvailable: false,
  };
}

function runtime(
  mode: PluginLiveControlStatus["mode"],
  open: boolean,
  execution = false,
): PluginPlatformRuntime {
  return {
    view: {
      liveControl: status(mode, execution),
      liveControlOpen: open,
      managementAvailable: true,
    },
    actions: {
      openLiveControl() {},
      closeLiveControl() {},
      async setLiveControlMode() {},
      async killLiveControl() {},
      async revokeLiveAuthority() {},
      async previewLiveConfirmation() {
        throw new Error("not called during server render");
      },
      async issueLiveConfirmation() {
        throw new Error("not called during server render");
      },
      async revokeLiveConfirmation() {},
      async submitLiveExecution() {
        throw new Error("not called during server render");
      },
      async cancelLiveExecution() {
        throw new Error("not called during server render");
      },
      async reconcileLiveExecution() {
        throw new Error("not called during server render");
      },
      async downloadLiveAudit() {},
    },
  } as unknown as PluginPlatformRuntime;
}

test("persistent Host banner distinguishes armed and fail-closed unavailable states", () => {
  const armed = renderToStaticMarkup(<PluginLiveControl runtime={runtime("armed", false)} />);
  assert.match(armed, /data-live-control-banner/);
  assert.match(armed, /data-live-control-mode="armed"/);
  assert.match(armed, /Receipt control armed; execution unavailable/);

  const demo = renderToStaticMarkup(
    <PluginLiveControl runtime={runtime("armed", false, true)} />,
  );
  assert.match(demo, /Pinned OKX Demo execution armed/);

  const unavailable = renderToStaticMarkup(
    <PluginLiveControl runtime={runtime("unavailable", false)} />,
  );
  assert.match(unavailable, /Control status unavailable — fail closed/);
  assert.equal(
    renderToStaticMarkup(<PluginLiveControl runtime={runtime("disabled", false)} />),
    "",
  );
});

test("Host control panel exposes kill, revoke, preview, and audit without an execution action", () => {
  const html = renderToStaticMarkup(<PluginLiveControl runtime={runtime("armed", true)} />);
  assert.match(html, /data-testid="live-control-panel"/);
  assert.match(html, /data-live-global-kill/);
  assert.match(html, /Download redacted audit/);
  assert.match(html, /data-preview-live-confirmation/);
  assert.match(html, /Emergency authority revoke/);
  assert.match(html, /Live submit, cancel, transfer, and withdrawal remain unavailable/);
  assert.doesNotMatch(html, /data-live-submit/);
  assert.doesNotMatch(html, /<iframe/);
});

test("WP-F Host surface names the fixed Demo boundary without production actions", () => {
  const html = renderToStaticMarkup(
    <PluginLiveControl runtime={runtime("armed", true, true)} />,
  );
  assert.match(html, /OKX Demo Spot limit submit\/cancel is enabled/);
  assert.match(html, /Production, transfer, withdrawal, market, margin, amend, and batch actions remain unavailable/);
  assert.doesNotMatch(html, /production execution is enabled/i);
  assert.doesNotMatch(html, /<iframe/);
});

test("Host intent review renders every receipt binding fact", () => {
  const html = renderToStaticMarkup(<IntentFacts preview={{
    schemaVersion: "candlescope.live-confirmation-preview/1",
    intentSha256: `sha256:${"b".repeat(64)}`,
    pluginId: "candlescope.okx-demo",
    connectorId: "candlescope.okx-demo-readonly",
    publisherIdentity: "publisher:test",
    version: "1.0.0",
    clientOrderId: "C".repeat(32),
    instrumentId: "BTC-USDT",
    side: "buy",
    orderType: "limit",
    quantity: "1",
    limitPrice: "42000",
    policyEpoch: 2,
    controlGeneration: 4,
    liveSubmitAvailable: false,
    liveCancelAvailable: false,
  }} />);
  for (const value of [
    "BTC-USDT",
    "BUY",
    "limit",
    "42000",
    "C".repeat(32),
    "candlescope.okx-demo",
    "publisher:test",
    `sha256:${"b".repeat(64)}`,
    "epoch 2 · generation 4",
  ]) assert.match(html, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Host execution intent review renders action, Demo environment, notional, and both digests", () => {
  const html = renderToStaticMarkup(<IntentFacts preview={{
    schemaVersion: "candlescope.live-confirmation-preview/2",
    intentSha256: `sha256:${"c".repeat(64)}`,
    orderIntentSha256: `sha256:${"d".repeat(64)}`,
    pluginId: "candlescope.okx-demo",
    connectorId: "candlescope.okx-demo-spot-execution",
    publisherIdentity: "publisher:test",
    version: "1.0.0",
    clientOrderId: "E".repeat(32),
    instrumentId: "BTC-USDT",
    side: "buy",
    orderType: "limit",
    quantity: "0.001",
    limitPrice: "42000",
    notional: "42",
    policyEpoch: 2,
    controlGeneration: 4,
    action: "submit",
    executionState: "not-started",
    riskDecisionSha256: `sha256:${"e".repeat(64)}`,
    hardLimits: {
      instrumentId: "BTC-USDT",
      maxOrderNotional: "100",
      maxUnresolvedOrders: 2,
      maxUnresolvedNotional: "200",
    },
    liveSubmitAvailable: true,
    liveCancelAvailable: false,
  }} />);
  for (const value of [
    "OKX Demo · Spot cash",
    "SUBMIT",
    "42 USDT",
    `sha256:${"c".repeat(64)}`,
    `sha256:${"d".repeat(64)}`,
  ]) assert.match(html, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
