import assert from "node:assert/strict";
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
  withLocale("ko", () => {
    assert.match(t(SETTINGS_CATEGORIES[0].labelKey), /\p{Script=Hangul}/u);
    assert.match(t("settings.saveAndClose"), /\p{Script=Hangul}/u);
    assert.notEqual(t("settings.saveAndClose"), "Save and close");
    assert.notEqual(t("settings.saveAndClose"), "保存并关闭");
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

  const korean = withLocale("ko", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(korean, /\p{Script=Hangul}/u);
  assert.match(korean, /Binance/);
  assert.doesNotMatch(korean, /已连接/);
  assert.doesNotMatch(korean, /Connected to/);
  assert.doesNotMatch(korean, /\{count\}|\{exchange\}/);
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

  const korean = withLocale("ko", () => renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={viewsFor("ko")}
      openViewIds={[]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  ));
  assert.match(korean, /호가창/);
  assert.match(korean, /관심종목/);
  assert.doesNotMatch(korean, /市场侧栏/);
  assert.doesNotMatch(korean, /Market sidebar/);
});

test("appearance panel exposes a language picker that lists both locales", () => {
  const html = withLocale("zh-CN", () => renderToStaticMarkup(
    <ChartAppearancePanel settings={DEFAULT_SETTINGS} onUpdate={() => undefined} />,
  ));
  assert.match(html, /data-settings-locale="true"/);
  assert.match(html, /界面语言/);
  assert.match(html, /简体中文/);
  assert.match(html, /English/);
  assert.match(html, /한국어/);

  const en = withLocale("en", () => renderToStaticMarkup(
    <ChartAppearancePanel
      settings={{ ...DEFAULT_SETTINGS, locale: "en" }}
      onUpdate={() => undefined}
    />,
  ));
  assert.match(en, /Interface language/);
  assert.doesNotMatch(en, /界面语言/);
  assert.match(en, /한국어/);

  const korean = withLocale("ko", () => renderToStaticMarkup(
    <ChartAppearancePanel
      settings={{ ...DEFAULT_SETTINGS, locale: "ko" }}
      onUpdate={() => undefined}
    />,
  ));
  assert.match(korean, /한국어/);
  assert.match(korean, /\p{Script=Hangul}/u);
  assert.doesNotMatch(korean, /界面语言/);
  assert.doesNotMatch(korean, /Interface language/);
});
