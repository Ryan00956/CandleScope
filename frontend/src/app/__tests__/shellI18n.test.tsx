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
  withLocale("fr", () => {
    assert.equal(t(SETTINGS_CATEGORIES[0].labelKey), "Apparence");
    assert.equal(t("settings.saveAndClose"), "Enregistrer et fermer");
  });
  withLocale("ja", () => {
    assert.equal(t(SETTINGS_CATEGORIES[0].labelKey), "外観");
    assert.equal(t("settings.saveAndClose"), "保存して閉じる");
    assert.equal(t("settings.language.title"), "表示言語");
  });
  withLocale("ko", () => {
    assert.match(t(SETTINGS_CATEGORIES[0].labelKey), /\p{Script=Hangul}/u);
    assert.match(t("settings.saveAndClose"), /\p{Script=Hangul}/u);
    assert.notEqual(t("settings.saveAndClose"), "Save and close");
    assert.notEqual(t("settings.saveAndClose"), "保存并关闭");
  });
  withLocale("pt-BR", () => {
    assert.equal(t(SETTINGS_CATEGORIES[0].labelKey), "Aparência");
    assert.equal(t("settings.saveAndClose"), "Salvar e fechar");
    assert.doesNotMatch(t("settings.saveAndClose"), /ecrã|ficheiro|utilizador|percentagem/);
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
  const korean = withLocale("ko", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(korean, /\p{Script=Hangul}/u);
  assert.match(korean, /Binance/);
  assert.doesNotMatch(korean, /已连接/);
  assert.doesNotMatch(korean, /Connected to/);
  assert.doesNotMatch(korean, /\{count\}|\{exchange\}/);
  const pt = withLocale("pt-BR", () => renderToStaticMarkup(<StatusBar status={status} />));
  assert.match(pt, /Conectado a Binance/);
  assert.match(pt, /2 barras/);
  assert.match(pt, /Ao vivo \(WebSocket\)/);
  assert.match(pt, /Binance Spot/);
  assert.doesNotMatch(pt, /Connected to|已连接|ecrã|ficheiro|utilizador|percentagem/);
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
  const pt = withLocale("pt-BR", () => renderToStaticMarkup(
    <MarketRightRailFrame
      source="live"
      views={viewsFor("pt-BR")}
      openViewIds={[]}
      panelCollapsed
      onToggleView={() => undefined}
      onTogglePanelCollapsed={() => undefined}
      renderView={() => null}
      layout={{ width: 360 }}
    />,
  ));
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
  assert.match(korean, /호가창/);
  assert.match(korean, /관심종목/);
  assert.doesNotMatch(korean, /市场侧栏/);
  assert.doesNotMatch(korean, /Market sidebar/);
  assert.match(pt, /aria-label="Barra lateral do mercado"/);
  assert.match(pt, /Mostrar barra lateral/);
  assert.match(pt, /Lista de observação/);
  assert.doesNotMatch(pt, /Market sidebar|市场侧栏|ecrã|ficheiro|Watchlist/);
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
  assert.match(html, /Español/);
  assert.match(html, /Français/);
  assert.match(html, /日本語/);
  assert.match(html, /한국어/);
  assert.match(html, /Português \(Brasil\)/);
  assert.match(html, /Русский/);

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
  assert.match(en, /한국어/);

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

  const pt = withLocale("pt-BR", () => renderToStaticMarkup(
    <ChartAppearancePanel
      settings={{ ...DEFAULT_SETTINGS, locale: "pt-BR" }}
      onUpdate={() => undefined}
    />,
  ));
  assert.match(pt, /Idioma da interface/);
  assert.match(pt, /Português \(Brasil\)/);
  assert.match(pt, /value="pt-BR"/);
  assert.doesNotMatch(pt, /界面语言|Interface language|ecrã|ficheiro|utilizador|percentagem/);

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
