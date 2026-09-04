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
  withLocale("fr", () => {
    assert.equal(t(SETTINGS_CATEGORIES[0].labelKey), "Apparence");
    assert.equal(t("settings.saveAndClose"), "Enregistrer et fermer");
  });
  withLocale("ja", () => {
    assert.equal(t(SETTINGS_CATEGORIES[0].labelKey), "外観");
    assert.equal(t("settings.saveAndClose"), "保存して閉じる");
    assert.equal(t("settings.language.title"), "表示言語");
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

  const fr = withLocale("fr", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(fr, /Connecté à Binance/);
  assert.match(fr, /2 barres/);
  assert.match(fr, /Direct \(WebSocket\)/);
  assert.doesNotMatch(fr, /Connected to/);
  assert.doesNotMatch(fr, /已连接/);
  const ja = withLocale("ja", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(ja, /Binance に接続済み/);
  assert.match(ja, /2 本/);
  assert.match(ja, /リアルタイム（WebSocket）/);
  assert.match(ja, /Binance 現物/);
  assert.doesNotMatch(ja, /已连接|Connected to/);
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

  const fr = withLocale("fr", () => renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={viewsFor("fr")}
      openViewIds={[]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  ));
  const ja = withLocale("ja", () => renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={viewsFor("ja")}
      openViewIds={[]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  ));
  assert.match(fr, /aria-label="Barre latérale du marché"/);
  assert.match(fr, /Afficher la barre latérale/);
  assert.match(fr, /Liste de suivi/);
  assert.doesNotMatch(fr, /Market sidebar/);
  assert.match(ja, /aria-label="市場サイドバー"/);
  assert.match(ja, /サイドバーを表示/);
  assert.match(ja, /ウォッチリスト/);
  assert.doesNotMatch(ja, /市场侧栏|Market sidebar/);
});

test("appearance panel exposes a language picker that lists both locales", () => {
  const html = withLocale("zh-CN", () => renderToStaticMarkup(
    <ChartAppearancePanel settings={DEFAULT_SETTINGS} onUpdate={() => undefined} />,
  ));
  assert.match(html, /data-settings-locale="true"/);
  assert.match(html, /界面语言/);
  assert.match(html, /简体中文/);
  assert.match(html, /English/);
  assert.match(html, /Español/);
  assert.match(html, /Français/);
  assert.match(html, /日本語/);

  const en = withLocale("en", () => renderToStaticMarkup(
    <ChartAppearancePanel
      settings={{ ...DEFAULT_SETTINGS, locale: "en" }}
      onUpdate={() => undefined}
    />,
  ));
  assert.match(en, /Interface language/);
  assert.doesNotMatch(en, /界面语言/);
  assert.match(en, /Español/);
  assert.match(en, /Français/);

  const fr = withLocale("fr", () => renderToStaticMarkup(
    <ChartAppearancePanel
      settings={{ ...DEFAULT_SETTINGS, locale: "fr" }}
      onUpdate={() => undefined}
    />,
  ));
  assert.match(fr, /Langue/);
  assert.match(fr, /Français/);
  assert.doesNotMatch(fr, /界面语言/);
  assert.doesNotMatch(fr, /Interface language/);
});

test("status bar, right rail, and appearance chrome switch to Spanish", () => {
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

  const esStatus = withLocale("es", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(esStatus, /Conectado a Binance/);
  assert.match(esStatus, /2 barras/);
  assert.match(esStatus, /Binance Contado/);
  assert.doesNotMatch(esStatus, /Connected to/);
  assert.doesNotMatch(esStatus, /已连接/);
  assert.doesNotMatch(esStatus, /\p{Script=Han}/u);

  const esRail = withLocale("es", () => renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={[
        { id: "watchlist", title: t("rail.watchlist"), icon: <span data-icon="watchlist" />, order: 10, sizing: "flex" },
        { id: "order-book", title: t("rail.orderBook"), icon: <span data-icon="order-book" />, order: 20, sizing: "fixed", defaultHeight: 320 },
      ]}
      openViewIds={[]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  ));
  assert.match(esRail, /libro de [oó]rdenes/i);
  assert.match(esRail, /Lista de seguimiento|seguimiento/i);
  assert.doesNotMatch(esRail, /市场侧栏/);

  const esPanel = withLocale("es", () => renderToStaticMarkup(
    <ChartAppearancePanel
      settings={{ ...DEFAULT_SETTINGS, locale: "es" }}
      onUpdate={() => undefined}
    />,
  ));
  assert.match(esPanel, /Español/);
  assert.match(esPanel, /Idioma de la interfaz/);
  assert.doesNotMatch(esPanel, /Interface language/);
  assert.doesNotMatch(esPanel, /界面语言/);
});
