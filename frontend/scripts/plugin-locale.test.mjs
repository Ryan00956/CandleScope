import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL(
  "../../packages/candlescope-plugin-pyne-workbench/src/candlescope_plugin_pyne_workbench/web/app.js",
  import.meta.url,
), "utf8");

test("first-party plugins ship Japanese manifest copy for owned surfaces", () => {
  const scanner = JSON.parse(fs.readFileSync(new URL(
    "../../packages/candlescope-plugin-market-scanner/src/candlescope_plugin_market_scanner/manifest.json",
    import.meta.url,
  ), "utf8"));
  const workbench = JSON.parse(fs.readFileSync(new URL(
    "../../packages/candlescope-plugin-pyne-workbench/src/candlescope_plugin_pyne_workbench/manifest.json",
    import.meta.url,
  ), "utf8"));
  const scannerById = Object.fromEntries(scanner.contributions.map((item) => [item.id, item]));
  const workbenchById = Object.fromEntries(workbench.contributions.map((item) => [item.id, item]));
  assert.equal(scannerById.scan.configuration.localizations.ja.title, "許可済み市場をスキャン");
  assert.deepEqual(
    scannerById.settings.configuration.localizations.ja.schema.properties.interval.enumLabels,
    ["1分", "5分", "1時間"],
  );
  assert.equal(scannerById.results.configuration.localizations.ja.fields.symbol, "銘柄");
  assert.equal(
    scannerById.results.configuration.localizations.ja.emptyState,
    "スキャナーを実行すると結果が表示されます",
  );
  assert.equal(workbenchById.run.configuration.localizations.ja.title, "現在のチャートで Pyne を実行");
  assert.equal(workbenchById["workbench-view"].configuration.localizations.ja.title, "Pyne ワークベンチ");
});

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
    data: { protocol: "candlescope.ui-bridge/1", type: "host.connect", sequence: 1, payload: payload("de") },
  });
  assert.equal(document.documentElement.lang, "en");
  assert.equal(title.textContent, "Pyne Workbench");
  let sequence = 1;
  for (const [requested, expected, label, connected] of [
    ["zh-CN", "zh-CN", "Pyne 工作台"],
    ["zh-TW", "zh-TW", "Pyne 工作台", "已連線 · 命令從外掛面板執行"],
    ["EN-us", "en", "Pyne Workbench"],
    ["es", "es", "Banco de trabajo Pyne"],
    ["es-MX", "es", "Banco de trabajo Pyne"],
    ["es-ES", "es", "Banco de trabajo Pyne"],
    ["fr-CA", "fr", "Atelier Pyne"],
    ["ja-JP", "ja", "Pyne ワークベンチ"],
    ["ko-KR", "ko", "Pyne 작업대"],
    ["ko", "ko", "Pyne 작업대"],
    ["pt-BR", "pt-BR", "Pyne Workbench"],
    ["pt-br", "pt-BR", "Pyne Workbench"],
    ["PT-BR", "pt-BR", "Pyne Workbench"],
    ["pt", "en", "Pyne Workbench"],
    ["pt-PT", "en", "Pyne Workbench"],
    ["ru", "ru", "Верстак Pyne"],
    ["ru-RU", "ru", "Верстак Pyne"],
  ]) {
    channel.onmessage({ data: {
      protocol: "candlescope.ui-bridge/1", type: "host.lifecycle",
      sequence: ++sequence, payload: payload(requested),
    } });
    assert.equal(document.documentElement.lang, expected);
    assert.equal(title.textContent, label);
    if (connected !== undefined) assert.equal(status.textContent, connected);
  }
});
