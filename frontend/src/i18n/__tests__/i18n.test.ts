import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../catalogs/en.js";
import { zhCN } from "../catalogs/zh-CN.js";
import { zhTW } from "../catalogs/zh-TW.js";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_OPTIONS,
  bindDocumentLocale,
  getDateTimeLocale,
  getLocale,
  getNumberLocale,
  hydrateLocale,
  isLocaleId,
  messageKeys,
  normalizeLocale,
  resolveLocale,
  setLocale,
  subscribeLocale,
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
    assert.equal(hydrateLocale("zh-TW"), "zh-TW");
    assert.equal(hydrateLocale("zh-Hant-TW"), "zh-TW");
  } finally {
    setLocale(previous);
  }
});

test("zh-TW is a first-class registered locale with picker, aliases, and format profiles", () => {
  assert.equal(isLocaleId("zh-TW"), true);
  assert.equal(localeDefinition("zh-TW").nativeLabel, "繁體中文");
  assert.deepEqual(localeDefinition("zh-TW").aliases, ["zh-Hant-TW"]);
  assert.equal(localeDefinition("zh-TW").dateTimeLocale, "zh-TW");
  assert.equal(localeDefinition("zh-TW").numberLocale, "zh-TW");
  assert.equal(localeDefinition("zh-TW").direction, "ltr");
  assert.ok(LOCALE_OPTIONS.some((option) => option.id === "zh-TW" && option.nativeLabel === "繁體中文"));
  assert.equal(LOCALES.includes("zh-TW"), true);
  assert.equal(Object.keys(localeDefinition("zh-TW").messages).length, messageKeys().length);
});

test("normalizeLocale accepts zh-TW tags and does not map zh-HK, zh-MO, or bare zh-Hant", () => {
  assert.equal(normalizeLocale("zh-TW"), "zh-TW");
  assert.equal(normalizeLocale("zh-tw"), "zh-TW");
  assert.equal(normalizeLocale("zh-Hant-TW"), "zh-TW");
  assert.equal(normalizeLocale("zh-TW-u-nu-latn"), "zh-TW");
  assert.equal(normalizeLocale("zh-HK"), DEFAULT_LOCALE);
  assert.equal(normalizeLocale("zh-MO"), DEFAULT_LOCALE);
  assert.equal(normalizeLocale("zh-Hant"), DEFAULT_LOCALE);
  assert.equal(normalizeLocale("zh"), "zh-CN");
  assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
  assert.equal(normalizeLocale("not a locale!!!"), DEFAULT_LOCALE);
  assert.equal(normalizeLocale("../zh-TW"), DEFAULT_LOCALE);
});

test("switching into and out of zh-TW notifies once and is a no-op for the same locale", () => {
  const previous = getLocale();
  let notifications = 0;
  const unsubscribe = subscribeLocale(() => {
    notifications += 1;
  });
  try {
    setLocale("zh-CN");
    notifications = 0;
    assert.equal(setLocale("zh-TW"), "zh-TW");
    assert.equal(setLocale("zh-TW"), "zh-TW");
    assert.equal(setLocale("zh-tw"), "zh-TW");
    assert.equal(notifications, 1);
    assert.equal(setLocale("en"), "en");
    assert.equal(setLocale("zh-TW"), "zh-TW");
    assert.equal(setLocale("zh-CN"), "zh-CN");
    assert.equal(notifications, 4);
  } finally {
    unsubscribe();
    setLocale(previous);
  }
});

test("zh-TW copy comes from the Traditional catalog and keeps interpolation tokens", () => {
  withLocale("zh-TW", () => {
    assert.equal(t("shell.replay"), zhTW["shell.replay"]);
    assert.equal(t("shell.replay"), "K 線回放");
    assert.notEqual(t("shell.replay"), zhCN["shell.replay"]);
    assert.equal(t("plugin.title"), "外掛中心");
    assert.equal(t("plugin.previewImport"), zhTW["plugin.previewImport"]);
    assert.equal(t("plugin.previewImport"), "預覽登錄檔匯入");
    assert.doesNotMatch(t("plugin.previewImport"), /登入檔/);
    assert.equal(t("plugin.host.v1ImportConfirm"), zhTW["plugin.host.v1ImportConfirm"]);
    assert.match(t("plugin.host.v1ImportConfirm"), /登錄檔/);
    assert.doesNotMatch(t("plugin.host.v1ImportConfirm"), /登入檔/);
    assert.equal(t("plugin.host.v1RollbackConfirm"), zhTW["plugin.host.v1RollbackConfirm"]);
    assert.doesNotMatch(t("plugin.host.v1RollbackConfirm"), /登入檔/);
    assert.equal(t("plugin.notice.v1Imported"), zhTW["plugin.notice.v1Imported"]);
    assert.doesNotMatch(t("plugin.notice.v1Imported"), /登入檔/);
    assert.equal(t("status.loading"), "載入中…");
    assert.equal(t("workspace.name.default"), "預設工作區");
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "已連線 Binance");
    assert.equal(t("status.barCount", { count: 3 }), "3 根 K 線");
    assert.match(t("status.connectedTo"), /\{exchange\}/);
    assert.equal(tPlural("status.barCount", 1), "1 根 K 線");
    assert.equal(tPlural("status.barCount", 2), "2 根 K 線");
    assert.equal(translateWsStatus("fallback"), zhTW["status.ws.fallback"]);
    assert.equal(translateMarketType("spot"), "現貨");
    assert.doesNotMatch(t("shell.documentTitle"), /开源看盘软件/);
    assert.doesNotMatch(t("settings.workbench.name"), /数据工作台/);
  });
});

test("missing catalog keys stay fail-closed as the key itself", () => {
  assert.equal(formatCatalogMessage(zhTW, "not.a.real.key"), "not.a.real.key");
  assert.equal(formatCatalogMessage(zhTW, "status.connectedTo", { exchange: "OKX" }), "已連線 OKX");
});

test("zh-TW Intl profiles format dates, numbers, percents, and plurals", () => {
  withLocale("zh-TW", () => {
    assert.equal(getDateTimeLocale(), "zh-TW");
    assert.equal(getNumberLocale(), "zh-TW");
    const stamp = new Date("2026-09-04T04:00:00Z");
    assert.equal(
      new Intl.DateTimeFormat(getDateTimeLocale(), { dateStyle: "medium", timeZone: "UTC" }).format(stamp),
      "2026年9月4日",
    );
    assert.equal(new Intl.NumberFormat(getNumberLocale()).format(1234567), "1,234,567");
    assert.equal(
      new Intl.NumberFormat(getNumberLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5),
      "1,234.50",
    );
    assert.equal(
      new Intl.NumberFormat(getNumberLocale(), { style: "percent", maximumFractionDigits: 1 }).format(0.123),
      "12.3%",
    );
    assert.equal(new Intl.PluralRules("zh-TW").select(0), "other");
    assert.equal(new Intl.PluralRules("zh-TW").select(1), "other");
    assert.equal(new Intl.PluralRules("zh-TW").select(2), "other");
  });
});

test("bindDocumentLocale writes zh-TW lang, ltr direction, title, meta, and CSS copy", () => {
  const previous = getLocale();
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, "document");
  const previousDocument = hadDocument ? (globalThis as { document: unknown }).document : undefined;
  const styleProps: Record<string, string> = {};
  const meta = {
    content: "",
    setAttribute(name: string, value: string) {
      if (name === "content") this.content = value;
    },
  };
  const mockDocument = {
    title: "",
    documentElement: {
      lang: "",
      dir: "",
      style: {
        setProperty(name: string, value: string) {
          styleProps[name] = value;
        },
      },
    },
    querySelector: () => meta,
  };
  (globalThis as unknown as { document: typeof mockDocument }).document = mockDocument;
  try {
    setLocale("zh-TW");
    const unbind = bindDocumentLocale({
      titleKey: "shell.documentTitle",
      descriptionKey: "shell.documentDescription",
    });
    assert.equal(mockDocument.documentElement.lang, "zh-TW");
    assert.equal(mockDocument.documentElement.dir, "ltr");
    assert.equal(mockDocument.title, zhTW["shell.documentTitle"]);
    assert.notEqual(mockDocument.title, zhCN["shell.documentTitle"]);
    assert.equal(meta.content, zhTW["shell.documentDescription"]);
    assert.equal(JSON.parse(styleProps["--i18n-workspace-loading"]!), zhTW["css.workspaceLoading"]);
    setLocale("zh-CN");
    assert.equal(mockDocument.title, zhCN["shell.documentTitle"]);
    unbind();
  } finally {
    setLocale(previous);
    if (hadDocument) {
      (globalThis as unknown as { document: unknown }).document = previousDocument;
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});
