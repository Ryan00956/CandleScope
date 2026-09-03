import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL(
  "../../packages/candlescope-plugin-pyne-workbench/src/candlescope_plugin_pyne_workbench/web/app.js",
  import.meta.url,
), "utf8");

test("Pyne sandbox follows locale lifecycle updates and falls back to its own English catalog", () => {
  const title = { dataset: { i18n: "title" }, textContent: "" };
  const status = { dataset: { i18n: "statusWaiting" }, textContent: "" };
  const elements = { "#status": status, "#market": {}, "#theme": {} };
  const document = {
    title: "Pyne Workbench",
    documentElement: { lang: "zh-CN", dataset: {} },
    querySelector: (selector) => elements[selector],
    querySelectorAll: () => [title, status],
  };
  const parent = {};
  let connect;
  const channel = { start() {}, close() {}, postMessage() {}, onmessage: null };
  vm.runInNewContext(source, {
    document,
    parent,
    window: { addEventListener: (_type, listener) => { connect = listener; } },
  });
  const payload = (locale) => ({
    locale, theme: "dark", state: "active",
    market: { exchange: "binance", marketType: "spot", symbol: "BTCUSDT", interval: "1m" },
  });
  connect({
    source: parent,
    ports: [channel],
    data: { protocol: "candlescope.ui-bridge/1", type: "host.connect", sequence: 1, payload: payload("ja") },
  });
  assert.equal(document.documentElement.lang, "en");
  assert.equal(title.textContent, "Pyne Workbench");
  let sequence = 1;
  for (const [requested, expected, label] of [
    ["zh-CN", "zh-CN", "Pyne 工作台"],
    ["EN-us", "en", "Pyne Workbench"],
    ["fr-CA", "en", "Pyne Workbench"],
  ]) {
    channel.onmessage({ data: {
      protocol: "candlescope.ui-bridge/1", type: "host.lifecycle",
      sequence: ++sequence, payload: payload(requested),
    } });
    assert.equal(document.documentElement.lang, expected);
    assert.equal(title.textContent, label);
  }
});
