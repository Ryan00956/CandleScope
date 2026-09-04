import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../catalogs/en.js";
import { ru } from "../catalogs/ru.js";
import { zhCN } from "../catalogs/zh-CN.js";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_OPTIONS,
  getDateTimeLocale,
  getLocale,
  getNumberLocale,
  hydrateLocale,
  isLocaleId,
  messageKeys,
  normalizeLocale,
  resolveLocale,
  setLocale,
  t,
  tPlural,
  translateExchangeName,
  translateMarketType,
  translateWsStatus,
} from "../index.js";
import { formatCatalogMessage, formatCatalogPlural } from "../messageFormat.js";
import { localeDefinition } from "../registry.js";

function withLocale<T>(locale: string, run: () => T): T {
  const previous = getLocale();
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale(previous);
  }
}

test("locale normalization keeps the product default and accepts English aliases", () => {
  assert.equal(normalizeLocale(undefined), DEFAULT_LOCALE);
  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("zh"), "zh-CN");
  assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("en-GB"), "en");
  assert.equal(normalizeLocale("ru"), "ru");
  assert.equal(normalizeLocale("ru-RU"), "ru");
  assert.equal(normalizeLocale("fr"), DEFAULT_LOCALE);
});

test("every registered locale exposes all host keys and a language-picker option", () => {
  for (const locale of LOCALES) {
    assert.equal(isLocaleId(locale), true);
    assert.equal(normalizeLocale(locale), locale);
    assert.ok(LOCALE_OPTIONS.some((option) => option.id === locale && option.nativeLabel));
    for (const key of messageKeys()) assert.equal(typeof localeDefinition(locale).messages[key], "string");
  }
  assert.equal(isLocaleId("en-US"), false);
  assert.equal(isLocaleId("ru"), true);
  assert.equal(DEFAULT_LOCALE, "zh-CN");
  assert.equal(LOCALE_OPTIONS.find((option) => option.id === "ru")?.nativeLabel, "Русский");
  assert.deepEqual(messageKeys().slice().sort(), Object.keys(zhCN).sort());
});

test("locale resolution accepts new languages without changing its matching logic", () => {
  const registrations = [
    { id: "en" }, { id: "ja" }, { id: "fr" }, { id: "fr-CA" },
    { id: "zh-CN", aliases: ["zh", "zh-Hans"] }, { id: "zh-Hant" },
  ];
  assert.equal(resolveLocale(" ja-JP ", registrations), "ja");
  assert.equal(resolveLocale("FR-ca-u-nu-latn", registrations), "fr-CA");
  assert.equal(resolveLocale("fr-FR", registrations), "fr");
  assert.equal(resolveLocale("zh-Hant-TW", registrations), "zh-Hant");
  assert.equal(resolveLocale("zh-Hans-SG", registrations), "zh-CN");
  assert.equal(resolveLocale("de-DE", registrations), undefined);
  for (const value of [undefined, "", "en-not-a-locale-!", "../en", "__proto__"]) {
    assert.equal(resolveLocale(value, registrations), undefined);
    assert.equal(normalizeLocale(value), DEFAULT_LOCALE);
  }
});

test("format profiles preserve existing English dates and numbers and follow runtime changes", () => {
  withLocale("en", () => {
    assert.equal(getDateTimeLocale(), "en-GB");
    assert.equal(getNumberLocale(), "en-US");
  });
  withLocale("zh-CN", () => {
    assert.equal(getDateTimeLocale(), "zh-CN");
    assert.equal(getNumberLocale(), "zh-CN");
  });
  withLocale("ru", () => {
    assert.equal(getDateTimeLocale(), "ru-RU");
    assert.equal(getNumberLocale(), "ru-RU");
  });
});

test("catalog formatting exposes missing messages and preserves unresolved placeholders", () => {
  assert.equal(formatCatalogMessage({ saved: "Saved {count}" }, "saved", { count: 0 }), "Saved 0");
  assert.equal(formatCatalogMessage({ saved: "Saved {count}" }, "saved", {}), "Saved {count}");
  assert.equal(formatCatalogMessage({}, "missing"), "missing");
  assert.equal(formatCatalogMessage({}, "toString"), "toString");
});

test("plural selection handles multiple categories and decimal counts in additional languages", () => {
  const russian = {
    bars: "{count} бара", "bars.one": "{count} бар", "bars.few": "{count} бара", "bars.many": "{count} баров",
  };
  assert.equal(formatCatalogPlural(russian, "ru", "bars", 21), "21 бар");
  assert.equal(formatCatalogPlural(russian, "ru", "bars", 2), "2 бара");
  assert.equal(formatCatalogPlural(russian, "ru", "bars", 5), "5 баров");
  assert.equal(formatCatalogPlural(russian, "ru", "bars", 1.5), "1.5 бара");
  const arabic = { bars: "other {count}", "bars.zero": "zero {count}", "bars.two": "two {count}" };
  assert.equal(formatCatalogPlural(arabic, "ar", "bars", 0), "zero 0");
  assert.equal(formatCatalogPlural(arabic, "ar", "bars", 2), "two 2");
  assert.equal(formatCatalogPlural(en, "en", "status.barCount", 1, { count: 99 }), "1 bar");
});

test("t interpolates and switches with the locale store", () => {
  withLocale("zh-CN", () => {
    assert.equal(t("shell.replay"), "K 线回放");
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "已连接 Binance");
    assert.equal(
      t("settings.exchange.verification.events", { count: 3546 }),
      "3546 条事件，零不一致",
    );
  });
  withLocale("en", () => {
    assert.equal(t("shell.replay"), "Replay");
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "Connected to Binance");
    assert.equal(
      t("settings.exchange.verification.durationHours", { hours: 4 }),
      "4 hours continuous",
    );
  });
  withLocale("ru", () => {
    for (const [key, vars] of [
      ["shell.replay", undefined],
      ["shell.settings", undefined],
      ["status.loading", undefined],
      ["settings.language.title", undefined],
      ["status.connectedTo", { exchange: "Binance" }],
    ] as const) {
      const value = t(key, vars);
      assert.match(value, /\p{Script=Cyrillic}/u, key);
      assert.doesNotMatch(value, /\p{Script=Han}/u, key);
    }
    assert.match(t("status.connectedTo", { exchange: "Binance" }), /Binance/);
  });
});

test("plural forms keep Chinese invariant and distinguish English one/other", () => {
  withLocale("zh-CN", () => {
    assert.equal(tPlural("status.barCount", 1), "1 根 K 线");
    assert.equal(tPlural("status.barCount", 2), "2 根 K 线");
  });
  withLocale("en", () => {
    assert.equal(tPlural("status.barCount", 1), "1 bar");
    assert.equal(tPlural("status.barCount", 2), "2 bars");
    assert.equal(tPlural("status.exchangeLimitationCount", 1), "1 exchange limitation");
    assert.equal(tPlural("status.exchangeLimitationCount", 3), "3 exchange limitations");
  });
  withLocale("ru", () => {
    const rules = new Intl.PluralRules("ru");
    const shipped = (key: "status.barCount" | "status.exchangeLimitationCount", count: number) => {
      const category = rules.select(count);
      const catalogKey = category === "other" ? key : `${key}.${category}`;
      const template = ru[catalogKey as keyof typeof ru];
      assert.equal(typeof template, "string", catalogKey);
      return String(template).replace("{count}", String(count));
    };
    for (const count of [1, 2, 5, 21, 22, 25, 1.5, 2.5]) {
      assert.equal(tPlural("status.barCount", count), shipped("status.barCount", count), String(count));
      assert.equal(
        tPlural("status.exchangeLimitationCount", count),
        shipped("status.exchangeLimitationCount", count),
        String(count),
      );
    }
    assert.equal(rules.select(1), "one");
    assert.equal(rules.select(21), "one");
    assert.equal(rules.select(2), "few");
    assert.equal(rules.select(22), "few");
    assert.equal(rules.select(5), "many");
    assert.equal(rules.select(25), "many");
    assert.equal(rules.select(1.5), "other");
    assert.notEqual(tPlural("status.barCount", 1), tPlural("status.barCount", 2));
    assert.notEqual(tPlural("status.barCount", 2), tPlural("status.barCount", 5));
    assert.notEqual(tPlural("status.barCount", 1), tPlural("status.barCount", 1.5));
    assert.match(tPlural("status.barCount", 1), /\p{Script=Cyrillic}/u);
  });
});

test("Russian chrome uses the required trading glossary", () => {
  withLocale("ru", () => {
    assert.match(t("shell.replay"), /Воспроизведение/);
    assert.match(t("rail.orderBook"), /книга ордеров/i);
    assert.match(t("settings.exchange.channel.fundingRate"), /ставка финансирования/i);
    assert.match(t("backtest.title"), /[Бб]эктест/);
    assert.match(t("replay.wb.positions"), /Позици/);
    assert.match(t("replay.wb.im"), /марж/i);
    assert.match(t("replay.shell.ordersFills"), /[Оо]рдер/);
    assert.match(t("replay.liq.fill"), /Исполнение/);
    assert.match(t("replay.wb.pnl"), /прибыль и убыток/i);
    assert.doesNotMatch(t("shell.replay"), /\bReplay\b/);
    assert.doesNotMatch(t("rail.orderBook"), /\bOrder book\b/i);
  });
});

test("Russian number and date profiles use a decimal comma", () => {
  withLocale("ru", () => {
    assert.equal(getNumberLocale(), "ru-RU");
    assert.equal(getDateTimeLocale(), "ru-RU");
    assert.equal((1.5).toLocaleString(getNumberLocale()), "1,5");
    assert.match((1234.5).toLocaleString(getNumberLocale()), /1[\u00a0\u202f ]?234,5/);
    const stamp = new Date(Date.UTC(2026, 8, 4, 12, 0, 0));
    assert.match(stamp.toLocaleDateString(getDateTimeLocale(), { timeZone: "UTC" }), /04\.09\.2026|4\.09\.2026/);
  });
});

test("websocket status keys stay stable across locales", () => {
  withLocale("zh-CN", () => {
    assert.equal(translateWsStatus("fallback"), "轮询回退");
    assert.equal(translateWsStatus("not-a-status"), "未知");
  });
  withLocale("en", () => {
    assert.equal(translateWsStatus("fallback"), "Polling fallback");
    assert.equal(translateWsStatus("live"), "Live (WebSocket)");
  });
});

test("market and exchange labels follow the active locale", () => {
  withLocale("zh-CN", () => {
    assert.equal(translateMarketType("spot"), "现货");
    assert.equal(translateMarketType("futures"), "合约");
    assert.equal(translateMarketType("swap"), "永续");
    assert.equal(translateExchangeName("binance"), "币安");
  });
  withLocale("en", () => {
    assert.equal(translateMarketType("spot"), "Spot");
    assert.equal(translateMarketType("futures"), "Futures");
    assert.equal(translateMarketType("swap"), "Perp");
    assert.equal(translateExchangeName("binance"), "Binance");
    assert.equal(t("interval.tab.common"), "Common");
    assert.equal(t("watchlist.title"), "Watchlist");
    assert.equal(t("orderBook.title"), "Order book");
    assert.equal(t("workspace.title"), "Chart workspace");
  });
});

test("runtime leftover keys stay Chinese by default and switch with the store", () => {
  withLocale("zh-CN", () => {
    assert.equal(t("countdown.days", { days: 1, clock: "01:01:01" }), "1天 01:01:01");
    assert.match(t("replay.init.hedgeHybrid"), /HEDGE_HYBRID/);
    assert.match(t("replay.init.hedgeHybrid"), /资金费.*OFF/);
    assert.equal(t("settings.workbench.name"), "数据工作台");
    assert.equal(t("scale.auto"), "自动缩放");
    assert.match(t("python.hostOwns"), /成交/);
    assert.match(t("local.err.isoNeedTz"), /时区/);
    assert.equal(t("market.cap.futuresOnly"), "仅合约市场支持");
    assert.equal(t("pane.funding.next"), "下次结算");
    assert.equal(t("orderBook.rt.seqGap"), "检测到序列缺口，正在重新同步");
    assert.equal(t("plugin.title"), "插件中心");
    assert.match(t("plugin.previewImport"), /预览注册表导入/);
    assert.match(
      t("interval.cannotComposeSession", { exchange: "binance", marketType: "spot", interval: "3h" }),
      /binance\/spot/,
    );
  });
  withLocale("en", () => {
    assert.equal(t("countdown.days", { days: 1, clock: "01:01:01" }), "1d 01:01:01");
    assert.equal(t("css.workspaceLoading"), "Loading chart workspace…");
    assert.doesNotMatch(t("replay.init.hedgeHybrid"), /资金费/);
    assert.equal(t("settings.workbench.name"), "Data workbench");
    assert.equal(t("scale.auto"), "Auto scale");
    assert.doesNotMatch(t("workbench.filterTitle"), /库存/);
    assert.doesNotMatch(t("python.hostOwns"), /成交/);
    assert.doesNotMatch(t("local.err.isoNeedTz"), /时区/);
    assert.equal(t("pane.funding.next"), "Next settlement");
    assert.doesNotMatch(t("orderBook.rt.seqGap"), /序列缺口/);
    assert.equal(t("plugin.title"), "Plugin center");
    assert.doesNotMatch(t("plugin.previewImport"), /预览/);
    assert.doesNotMatch(t("replay.hub.accountData.deterministicSimulation"), /精确|模拟私有/);
    assert.doesNotMatch(t("replay.hub.accountData.approxProxy"), /已揭示|模拟账户/);
    assert.doesNotMatch(t("replay.hub.accountData.historicalExact"), /固定历史|规则/);
    assert.doesNotMatch(t("replay.hub.fundingMode.sandboxFixed"), /近似练习/);
    assert.doesNotMatch(t("replay.hub.fundingMode.historicalExact"), /归档结算/);
    assert.doesNotMatch(t("replay.hub.bookMode.assistedRequired"), /连续历史/);
  });
});

test("hydrateLocale updates the store and is idempotent for the same value", () => {
  const previous = getLocale();
  try {
    assert.equal(hydrateLocale("en"), "en");
    assert.equal(getLocale(), "en");
    assert.equal(hydrateLocale("en-US"), "en");
    assert.equal(hydrateLocale("zh-CN"), "zh-CN");
    assert.equal(hydrateLocale("ru-RU"), "ru");
    assert.equal(getLocale(), "ru");
  } finally {
    setLocale(previous);
  }
});

test("setLocale writes Russian document lang and ltr direction", () => {
  const previousDocument = globalThis.document;
  const documentElement = { lang: "", dir: "" };
  globalThis.document = { documentElement } as unknown as Document;
  const previous = getLocale();
  try {
    assert.equal(setLocale("ru-RU"), "ru");
    assert.equal(documentElement.lang, "ru");
    assert.equal(documentElement.dir, "ltr");
  } finally {
    setLocale(previous);
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      globalThis.document = previousDocument;
    }
  }
});
