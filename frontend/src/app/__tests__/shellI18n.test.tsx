import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ChartAppearancePanel from "../../components/settings/ChartAppearancePanel.js";
import { DEFAULT_SETTINGS } from "../../features/settings/chartAppearanceSettings.js";
import { SETTINGS_CATEGORIES } from "../../features/settings/settingsTabRegistry.js";
import { getLocale, setLocale, t } from "../../i18n/index.js";
import MarketRightRailFrame from "../MarketRightRailFrame.js";
import StatusBar from "../StatusBar.js";
import type { MarketRailViewDescriptor } from "../marketRailTypes.js";

function withLocale<T>(locale: string, run: () => T): T {
  const previous = getLocale();
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale(previous);
  }
}

const sampleViews: MarketRailViewDescriptor[] = [
  {
    id: "watchlist",
    title: t("rail.watchlist"),
    icon: <span data-icon="watchlist" />,
    order: 10,
    sizing: "flex",
  },
  {
    id: "order-book",
    title: t("rail.orderBook"),
    icon: <span data-icon="order-book" />,
    order: 20,
    sizing: "fixed",
    defaultHeight: 320,
  },
];

test("settings category labels follow the active locale", () => {
  withLocale("zh-CN", () => {
    assert.equal(t(SETTINGS_CATEGORIES[0].labelKey), "外观显示");
    assert.equal(t("settings.saveAndClose"), "保存并关闭");
  });
  withLocale("en", () => {
    assert.equal(t(SETTINGS_CATEGORIES[0].labelKey), "Appearance");
    assert.equal(t("settings.saveAndClose"), "Save and close");
  });
  withLocale("ru", () => {
    assert.match(t(SETTINGS_CATEGORIES[0].labelKey), /\p{Script=Cyrillic}/u);
    assert.doesNotMatch(t(SETTINGS_CATEGORIES[0].labelKey), /\p{Script=Han}/u);
    assert.match(t("settings.saveAndClose"), /\p{Script=Cyrillic}/u);
    assert.doesNotMatch(t("settings.saveAndClose"), /\p{Script=Han}/u);
  });
});

test("status bar chrome switches between Chinese and English", () => {
  const status = {
    connectionStatus: "connected" as const,
    dataSource: "live",
    exchangeLabel: "Binance",
    marketLabel: "Spot",
    wsStatus: "live",
    wsStatusLabel: "Live (WebSocket)",
    barCount: 2,
    loadingMoreLeft: false,
    hasMoreLeft: true,
    exchangeCatalogStatus: "ready",
  };

  const zh = withLocale("zh-CN", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(zh, /已连接 Binance/);
  assert.match(zh, /2 根 K 线/);
  assert.match(zh, /实时（WebSocket）/);
  assert.match(zh, /Binance 现货/);
  assert.doesNotMatch(zh, /Connected to/);

  const en = withLocale("en", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(en, /Connected to Binance/);
  assert.match(en, /2 bars/);
  assert.match(en, /Live \(WebSocket\)/);
  assert.match(en, /Binance Spot/);
  assert.doesNotMatch(en, /已连接/);

  const ru = withLocale("ru", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(ru, /Binance/);
  assert.match(ru, /\p{Script=Cyrillic}/u);
  assert.doesNotMatch(ru, /\p{Script=Han}/u);
  assert.doesNotMatch(ru, /Connected to/);
  assert.doesNotMatch(ru, /已连接/);
});

test("right-rail chrome follows the active locale", () => {
  const viewsFor = (locale: string): MarketRailViewDescriptor[] => withLocale(locale, () => [
    { ...sampleViews[0]!, title: t("rail.watchlist") },
    { ...sampleViews[1]!, title: t("rail.orderBook") },
  ]);

  const zh = withLocale("zh-CN", () => renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={viewsFor("zh-CN")}
      openViewIds={[]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  ));
  assert.match(zh, /aria-label="市场侧栏"/);
  assert.match(zh, /显示侧栏/);
  assert.match(zh, /自选/);

  const en = withLocale("en", () => renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={viewsFor("en")}
      openViewIds={[]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  ));
  assert.match(en, /aria-label="Market sidebar"/);
  assert.match(en, /Show sidebar/);
  assert.match(en, /Watchlist/);
  assert.doesNotMatch(en, /市场侧栏/);

  const ru = withLocale("ru", () => renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={viewsFor("ru")}
      openViewIds={[]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  ));
  assert.match(ru, /\p{Script=Cyrillic}/u);
  assert.doesNotMatch(ru, /\p{Script=Han}/u);
  assert.doesNotMatch(ru, /Market sidebar/);
  assert.doesNotMatch(ru, /市场侧栏/);
});

test("appearance panel exposes a language picker that lists both locales", () => {
  const html = withLocale("zh-CN", () => renderToStaticMarkup(
    <ChartAppearancePanel settings={DEFAULT_SETTINGS} onUpdate={() => undefined} />,
  ));
  assert.match(html, /data-settings-locale="true"/);
  assert.match(html, /界面语言/);
  assert.match(html, /简体中文/);
  assert.match(html, /English/);
  assert.match(html, /Русский/);

  const en = withLocale("en", () => renderToStaticMarkup(
    <ChartAppearancePanel
      settings={{ ...DEFAULT_SETTINGS, locale: "en" }}
      onUpdate={() => undefined}
    />,
  ));
  assert.match(en, /Interface language/);
  assert.doesNotMatch(en, /界面语言/);

  withLocale("ru", () => {
    const ru = renderToStaticMarkup(
      <ChartAppearancePanel
        settings={{ ...DEFAULT_SETTINGS, locale: "ru" }}
        onUpdate={() => undefined}
      />,
    );
    assert.match(ru, /data-settings-locale="true"/);
    assert.match(ru, /Русский/);
    assert.match(t("settings.language.title"), /\p{Script=Cyrillic}/u);
    assert.doesNotMatch(t("settings.language.title"), /\p{Script=Han}/u);
    assert.doesNotMatch(ru, /界面语言/);
    assert.match(t("settings.language.description"), /\p{Script=Cyrillic}/u);
    assert.ok(t("settings.language.description").length > t("settings.language.description", undefined, "en").length);
  });
});

test("Russian layout CSS keeps long chrome wrapping and a Cyrillic-capable font stack", () => {
  const css = fs.readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const settingsCss = fs.readFileSync(
    new URL("../../features/settings/SettingsModalStyles.tsx", import.meta.url),
    "utf8",
  );
  assert.match(css, /Segoe UI/);
  assert.match(css, /Noto Sans/);
  assert.match(css, /html\[lang="ru"\] \.market-rail-accordion-trigger strong/);
  const main = fs.readFileSync(new URL("../../main.tsx", import.meta.url), "utf8");
  assert.match(main, /@fontsource\/inter\/cyrillic-400\.css/);
  assert.match(settingsCss, /html\[lang="ru"\] \.st-group-title/);
  assert.match(settingsCss, /overflow-wrap: break-word/);
});
