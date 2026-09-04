import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../catalogs/en.js";
import { ja } from "../catalogs/ja.js";
import { ko } from "../catalogs/ko.js";
import { ru } from "../catalogs/ru.js";
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
  assert.equal(normalizeLocale("fr"), "fr");
  assert.equal(normalizeLocale("fr-FR"), "fr");
  assert.equal(normalizeLocale("fr-CA"), "fr");
  assert.equal(normalizeLocale("FR-ca-u-nu-latn"), "fr");
  assert.equal(normalizeLocale("ja"), "ja");
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale("JA-jp"), "ja");
  assert.equal(normalizeLocale("ru"), "ru");
  assert.equal(normalizeLocale("ru-RU"), "ru");
});

test("pt-BR is recognized from BCP 47 case variants and is not aliased from bare pt", () => {
  assert.equal(normalizeLocale("pt-BR"), "pt-BR");
  assert.equal(normalizeLocale("pt-br"), "pt-BR");
  assert.equal(normalizeLocale("PT-BR"), "pt-BR");
  assert.equal(normalizeLocale("pt-BR-u-nu-latn"), "pt-BR");
  assert.equal(normalizeLocale(" pt-BR "), "pt-BR");
  assert.equal(normalizeLocale("pt"), DEFAULT_LOCALE);
  assert.equal(normalizeLocale("pt-PT"), DEFAULT_LOCALE);
  assert.equal(isLocaleId("pt-BR"), true);
  assert.equal(isLocaleId("pt"), false);
  assert.equal(isLocaleId("pt-PT"), false);
  assert.ok(LOCALE_OPTIONS.some((option) => (
    option.id === "pt-BR" && option.nativeLabel === "Português (Brasil)"
  )));
});

test("every registered locale exposes all host keys and a language-picker option", () => {
  for (const locale of LOCALES) {
    assert.equal(isLocaleId(locale), true);
    assert.equal(normalizeLocale(locale), locale);
    assert.ok(LOCALE_OPTIONS.some((option) => option.id === locale && option.nativeLabel));
    for (const key of messageKeys()) assert.equal(typeof localeDefinition(locale).messages[key], "string");
  }
  assert.equal(isLocaleId("en-US"), false);
  assert.equal(isLocaleId("fr"), true);
  assert.equal(isLocaleId("fr-FR"), false);
  assert.ok(LOCALE_OPTIONS.some((option) => option.id === "fr" && option.nativeLabel === "Français"));
  assert.equal(isLocaleId("ja-JP"), false);
  assert.equal(isLocaleId("ru"), true);
  assert.equal(DEFAULT_LOCALE, "zh-CN");
  assert.equal(LOCALE_OPTIONS.find((option) => option.id === "ru")?.nativeLabel, "Русский");
  assert.deepEqual(messageKeys().slice().sort(), Object.keys(zhCN).sort());
  const japanese = LOCALE_OPTIONS.find((option) => option.id === "ja");
  assert.equal(japanese?.nativeLabel, "日本語");
  assert.equal(localeDefinition("ja").dateTimeLocale, "ja-JP");
  assert.equal(localeDefinition("ja").numberLocale, "ja-JP");
  assert.equal(localeDefinition("ja").direction, "ltr");
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
  withLocale("fr", () => {
    assert.equal(getDateTimeLocale(), "fr-FR");
    assert.equal(getNumberLocale(), "fr-FR");
    assert.equal(
      (1234.5).toLocaleString(getNumberLocale()),
      (1234.5).toLocaleString("fr-FR"),
    );
    assert.doesNotMatch((1234.5).toLocaleString(getNumberLocale()), /1,234\.5/);
    const stamp = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
    assert.equal(
      stamp.toLocaleDateString(getDateTimeLocale(), { timeZone: "UTC" }),
      stamp.toLocaleDateString("fr-FR", { timeZone: "UTC" }),
    );
  });
  withLocale("ja", () => {
    assert.equal(getDateTimeLocale(), "ja-JP");
    assert.equal(getNumberLocale(), "ja-JP");
  });
  withLocale("pt-BR", () => {
    assert.equal(getDateTimeLocale(), "pt-BR");
    assert.equal(getNumberLocale(), "pt-BR");
    assert.match(new Intl.NumberFormat(getNumberLocale()).format(1234567.89), /1\.234\.567,89/);
    assert.equal(new Intl.NumberFormat(getNumberLocale()).format(1.5).includes(","), true);
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
  withLocale("fr", () => {
    assert.equal(t("shell.replay"), "Relecture");
    assert.notEqual(t("shell.replay"), en["shell.replay"]);
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "Connecté à Binance");
    assert.equal(t("settings.saveAndClose"), "Enregistrer et fermer");
    assert.equal(t("rail.watchlist"), "Liste de suivi");
    assert.equal(t("orderBook.title"), "Carnet d’\u2060ordres");
    assert.match(t("settings.language.title"), /Langue/);
  });
  withLocale("ja", () => {
    assert.equal(t("shell.replay"), "リプレイ");
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "Binance に接続済み");
    assert.equal(
      t("settings.exchange.verification.events", { count: 3546 }),
      "3546 件のイベント、不一致なし",
    );
  });
  withLocale("pt-BR", () => {
    assert.equal(t("shell.replay"), "Replay");
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "Conectado a Binance");
    assert.match(
      t("settings.exchange.verification.durationHours", { hours: 4 }),
      /4 horas/,
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
  withLocale("fr", () => {
    assert.equal(tPlural("status.barCount", 1), "1 barre");
    assert.equal(tPlural("status.barCount", 2), "2 barres");
    assert.equal(tPlural("status.barCount", 1_000_000), "1000000 de barres");
  });
  withLocale("ja", () => {
    assert.equal(tPlural("status.barCount", 1), "1 本");
    assert.equal(tPlural("status.barCount", 2), "2 本");
    assert.equal(new Intl.PluralRules("ja").select(1), "other");
    assert.equal(new Intl.PluralRules("ja").select(2), "other");
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

const PT_BR_PLURAL_BASES = [
  "status.barCount",
  "status.exchangeLimitationCount",
  "workbench.intervalCount",
  "pane.flow.missing",
  "pane.flow.gaps",
] as const;

test("pt-BR catalog covers every Intl.PluralRules category and selects them at runtime", () => {
  const categories = new Intl.PluralRules("pt-BR").resolvedOptions().pluralCategories;
  assert.deepEqual([...categories].sort(), ["many", "one", "other"]);
  const samples: Record<string, number> = { one: 1, many: 1_000_000, other: 2 };
  assert.equal(new Intl.PluralRules("pt-BR").select(0), "one");
  assert.equal(new Intl.PluralRules("pt-BR").select(1.5), "one");
  assert.equal(new Intl.PluralRules("pt-BR").select(1_000_000), "many");
  withLocale("pt-BR", () => {
    const messages = localeDefinition("pt-BR").messages as Readonly<Record<string, string | undefined>>;
    for (const base of PT_BR_PLURAL_BASES) {
      for (const category of categories) {
        const key = category === "other" ? base : `${base}.${category}`;
        const message = messages[key];
        assert.equal(typeof message, "string", `missing pt-BR plural form ${key}`);
        if (typeof message !== "string") continue;
        assert.match(message, /\{count\}/);
        assert.doesNotMatch(message, /ecrã|ficheiro|utilizador|percentagem/);
      }
      for (const [category, count] of Object.entries(samples)) {
        const rendered = tPlural(base, count);
        assert.match(rendered, new RegExp(String(count)));
        assert.doesNotMatch(rendered, /ecrã|ficheiro|utilizador|percentagem/);
        if (category === "one") assert.notEqual(rendered, tPlural(base, samples.other!));
      }
    }
  });
});

/** Product/protocol identifiers that may stay English in pt-BR. */
const PT_BR_TECHNICAL_IDENTIFIERS = new Set([
  "Replay", "Backtest", "Challenge", "Sandbox", "Practice", "Spot", "Perp",
  "Binance", "OKX", "CandleScope", "WebSocket", "JSON", "CSV", "VACUUM",
  "AND", "OR", "NOT", "LONG", "SHORT", "FULL", "NONE", "WARM", "OFF", "ON",
  "Host", "Pyne", "Pine", "Mark", "Basis", "Demo", "Tape", "Delta", "Cross",
  "Hedge", "Run", "Study", "Kline", "SMA", "EMA", "RSI", "MACD", "ATR",
  "CVD", "MAE", "MFE", "UTC", "HTTP", "REST", "DB", "WAL", "OHLC", "OHLCV",
  "SHA-256", "PNG", "JPEG", "WebP", "Ctrl", "Esc", "Enter", "Alt",
  "Snapshot", "Live", "Plugin", "Plugins", "Exchanges", "Exchange",
  "Point & Figure", "Kagi", "Line Break", "Hong Kong", "Volume", "Momentum",
  "Webhook", "R:R", "Take profit", "Stop loss", "Base", "Status", "CCXT",
  "fail closed", "CandleScope Replay · REPLAY", "CandleScope Strategy",
  "SQLite", "Maker", "Taker", "Bids", "Asks", "Paper", "Heikin Ashi", "Renko",
  "Review", "Fork", "GC", "BAR", "L2", "TP", "SL", "OI", "ADL",
  "Ampl.", "Total", "Chg", "Vol", "Stack", "Frontend", "Backend", "Proxy",
  "Ticker", "Mini ticker", "Local", "Normal", "Candles", "Warm", "Hold",
  "Refs", "Ledger", "Stop", "Maker / Taker bps", "Full", "Rank", "Diff",
  "Params", "Python Studio", "In-sample", "Out-of-sample", "Slippage bps",
  "Slippage / turnover", "Regular", "Runtime", "runtime", "final", "unchanged",
  "changed", "same", "Publisher", "terminal", "Runs", "Studies", "Checksum",
  "Fold", "TestRun", "Regime", "Benchmark", "Split", "Viewer", "Viewport",
  "Original", "Insurance", "Bundle", "Handoff", "Average True Range", "Script",
  "Overview", "Capital", "Dates", "Fidelity", "Draft", "Copy", "Archive",
  "Language", "Preset", "State", "Parameter", "Value", "Baseline", "Window",
  "Hash", "Coverage", "Dataset", "Smoke", "Resume", "Compare", "pending",
  "empty", "refs", "status", "Rollback", "kind/id", "Cumulative", "Amplitude",
  "Used", "Watermark", "BAR", "WARM", "FULL", "Proof",
]);

/** Closed leftover allowlist: product/protocol tokens and true PT cognates only.
 * If a key flags, rewrite the catalog string; never add the token. */
const PT_BR_PRODUCT_TOKENS = new Set([
  "replay", "backtest", "challenge", "sandbox", "practice", "spot", "perp",
  "binance", "okx", "candlescope", "websocket", "json", "csv", "vacuum",
  "host", "pyne", "pine", "mark", "basis", "demo", "tape", "delta", "cross",
  "hedge", "run", "study", "kline", "sma", "ema", "rsi", "macd", "atr",
  "cvd", "mae", "mfe", "utc", "http", "rest", "wal", "ohlc", "ohlcv",
  "png", "jpeg", "webp", "ctrl", "esc", "enter", "alt", "snapshot", "live",
  "plugin", "plugins", "exchanges", "exchange", "webhook", "ccxt", "sqlite",
  "maker", "taker", "bids", "asks", "paper", "renko", "kagi", "review", "fork",
  "heikin", "ashi", "long", "short", "platform", "fibonacci", "donchian",
  "train", "test", "high", "low", "close", "open", "percentage",
  "uvicorn", "aggtrade", "pro", "reverse", "windows", "bollinger",
  "socks5", "ta4j", "frontend", "backend", "python", "candle", "candles",
  "runtime", "strategy", "local", "volume", "status", "software", "visual",
  "manual", "interface", "layout", "zoom", "editor", "desktop", "web", "total",
  "normal", "original", "capital", "auto", "error", "item", "type", "mode",
  "model", "regular", "final", "terminal", "stack", "proxy", "ticker", "script",
  "offline", "loopback", "fallback", "polling", "decimal", "event", "parameter",
  "value", "window", "hash", "coverage", "dataset", "pending", "empty",
  "rollback", "preset", "language", "archive", "draft", "fidelity", "overview",
  "checksum", "regime", "benchmark", "split", "viewer", "viewport", "insurance",
  "bundle", "copy", "kind", "ledger", "rank", "cache", "token", "schema",
  "version", "index", "group", "momentum", "sample", "cursor", "download",
  "bytes", "job", "jobs", "studio", "kernel", "stream", "checkpoint",
  "amplitude", "use", "decide", "prepare", "ms", "px", "id", "vs",
]);

function isAllowedEnglishClone(message: string): boolean {
  const stripped = message
    .replace(/\{\{?[A-Za-z0-9_]+\}?\}/g, " ")
    .replace(/[·…|/\-—,.:;()[\]#!?%*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return true;
  if (PT_BR_TECHNICAL_IDENTIFIERS.has(message.trim()) || PT_BR_TECHNICAL_IDENTIFIERS.has(stripped)) {
    return true;
  }
  const tokens = stripped.split(" ");
  return tokens.every((token) => (
    PT_BR_TECHNICAL_IDENTIFIERS.has(token)
    || /^[A-Z][A-Z0-9_./+]{1,48}$/.test(token)
    || /^\d/.test(token)
    || token.length <= 3
  ));
}

function stripProtocol(text: string): string {
  return text
    .replace(/\{\{?[A-Za-z0-9_]+\}?\}/g, " ")
    .replace(/\bfail closed\b/gi, " ")
    .replace(/\bOne Step Back\b/g, " ")
    .replace(/\bPoint & Figure\b/g, " ")
    .replace(/\bTake profit\b/gi, " ")
    .replace(/\btake-profit\b/gi, " ")
    .replace(/\bJob Object\b/g, " ")
    .replace(/\bStop loss\b/gi, " ")
    .replace(/\bLine Break\b/g, " ")
    .replace(/\bHong Kong\b/g, " ")
    .replace(/\bHeikin Ashi\b/g, " ")
    .replace(/\bmark-to-market\b/gi, " ")
    .replace(/\buvicorn\b[^\n]*/gi, " ")
    .replace(/\b[A-Z][A-Z0-9_]{1,64}\b/g, " ")
    .replace(/\b[A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, " ")
    .replace(/\b[a-z]+[A-Z][a-zA-Z0-9]*\b/g, " ")
    .replace(/\.[A-Za-z0-9]+/g, " ")
    .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, " ");
}

function rawTokens(text: string): string[] {
  return stripProtocol(text).split(/[^A-Za-zÀ-ÿ0-9]+/u).filter((token) => !/^\d+$/.test(token));
}

const PT_TWO_LETTER = new Set([
  "de", "do", "da", "em", "no", "na", "os", "as", "um", "se", "ao", "ou",
  "eu", "tu", "me", "te", "há", "já", "só", "à",
]);

function leftoverSourceTokens(english: string, portuguese: string): string[] {
  const portugueseTokens = rawTokens(portuguese);
  const portugueseLower = new Set(portugueseTokens.map((token) => token.toLowerCase()));
  const leftover = new Set<string>();
  for (const token of rawTokens(english)) {
    const lower = token.toLowerCase();
    if (lower.length < 2) continue;
    if (lower.length === 2 && PT_TWO_LETTER.has(lower)) continue;
    if (/^\d+[smhdwmy]$/i.test(lower) || /^v\d+$/i.test(lower)) continue;
    if (!portugueseLower.has(lower) || PT_BR_PRODUCT_TOKENS.has(lower)) continue;
    leftover.add(lower);
  }
  return [...leftover].sort();
}

test("pt-BR host chrome uses Brazilian trading copy rather than English clones or European Portuguese", () => {
  withLocale("pt-BR", () => {
    assert.equal(t("shell.replay"), "Replay");
    assert.equal(t("orderBook.title"), "Livro de ofertas");
    assert.equal(t("settings.saveAndClose"), "Salvar e fechar");
    assert.equal(t("settings.language.title"), "Idioma da interface");
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "Conectado a Binance");
    assert.equal(t("settings.exchange.channel.fundingRate"), "Taxa de financiamento");
    assert.match(t("replay.wb.noPosHint"), /posição|lucro e prejuízo|margem/i);
    assert.match(t("backtest.title"), /backtest/i);
    assert.equal(translateMarketType("spot"), "Spot");
    assert.equal(translateWsStatus("live"), "Ao vivo (WebSocket)");
    assert.equal(t("alert.stepSymbol"), "Escolha um ativo");
    assert.equal(t("alert.ruleName"), "Nome da regra");
    assert.equal(t("alert.saving"), "Salvando...");
    assert.equal(t("alert.empty"), "Ainda não há regras de alerta");
    assert.equal(t("export.close"), "Fechar painel de exportação");
    assert.equal(t("export.chartLoading"), "O gráfico ainda está carregando dados.");
    assert.equal(t("plugin.live.reviewTitle"), "Revisar uma intenção preparada exata");
    assert.equal(t("core.error.exchangeList"), "Falha ao carregar a lista de exchanges");
    const clones: string[] = [];
    const mashups: string[] = [];
    for (const key of messageKeys()) {
      const message = t(key);
      const english = en[key];
      assert.doesNotMatch(message, /ecrã|ficheiro|utilizador|percentagem/i, key);
      assert.doesNotMatch(message, /\p{Script=Han}/u, key);
      if (typeof english !== "string") continue;
      if (message === english && !isAllowedEnglishClone(message)) clones.push(key);
      if (message !== english && leftoverSourceTokens(english, message).length > 0) {
        mashups.push(key);
      }
    }
    assert.equal(clones.length, 0, `English clones: ${clones.slice(0, 40).join(", ")}`);
    assert.equal(mashups.length, 0, `EN/PT mashups: ${mashups.slice(0, 40).join(", ")}`);
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
  withLocale("ja", () => {
    assert.equal(translateWsStatus("fallback"), "ポーリングにフォールバック");
    assert.equal(translateMarketType("spot"), "現物");
    assert.equal(translateMarketType("futures"), "先物");
    assert.equal(translateMarketType("swap"), "無期限");
    assert.equal(translateExchangeName("binance"), "Binance");
    assert.equal(t("orderBook.title"), "板情報");
    assert.equal(t("watchlist.title"), "ウォッチリスト");
    assert.equal(t("pane.funding.next"), "次回決済");
    assert.equal(t("settings.workbench.name"), "データワークベンチ");
    assert.equal(t("plugin.title"), "プラグインセンター");
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
  withLocale("fr", () => {
    assert.equal(t("countdown.days", { days: 1, clock: "01:01:01" }), "1j 01:01:01");
    assert.match(t("replay.init.hedgeHybrid"), /HEDGE_HYBRID/);
    assert.match(t("replay.init.hedgeHybrid"), /OFF/);
    assert.doesNotMatch(t("replay.init.hedgeHybrid"), /资金费/);
    assert.equal(t("settings.workbench.name"), "Atelier de données");
    assert.equal(t("scale.auto"), "Échelle auto");
    assert.match(t("python.hostOwns"), /exécution/);
    assert.match(t("local.err.isoNeedTz"), /fuseau horaire/);
    assert.equal(t("market.cap.futuresOnly"), "Pris en charge uniquement sur les marchés futures");
    assert.equal(t("pane.funding.next"), "Prochain règlement");
    assert.match(t("orderBook.rt.seqGap"), /séquence/);
    assert.equal(t("plugin.title"), "Centre de plugins");
    assert.doesNotMatch(t("plugin.previewImport"), /预览/);
    assert.doesNotMatch(t("css.workspaceLoading"), /Loading chart workspace/);
  });
});

test("hydrateLocale updates the store and is idempotent for the same value", () => {
  const previous = getLocale();
  const documentElement = { lang: "", dir: "" };
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement },
  });
  let notifications = 0;
  const unsubscribe = subscribeLocale(() => {
    notifications += 1;
  });
  try {
    assert.equal(hydrateLocale("en"), "en");
    assert.equal(getLocale(), "en");
    assert.equal(hydrateLocale("en-US"), "en");
    assert.equal(hydrateLocale("zh-CN"), "zh-CN");
    assert.equal(hydrateLocale("es-MX"), "es");
    assert.equal(getLocale(), "es");
    assert.equal(hydrateLocale("es"), "es");
    assert.equal(hydrateLocale("fr"), "fr");
    assert.equal(documentElement.lang, "fr");
    assert.equal(documentElement.dir, "ltr");
    notifications = 0;
    assert.equal(setLocale("fr-FR"), "fr");
    assert.equal(notifications, 0);
    assert.equal(setLocale("en"), "en");
    assert.equal(notifications, 1);
    assert.equal(documentElement.lang, "en");
    assert.equal(hydrateLocale("ru-RU"), "ru");
    assert.equal(getLocale(), "ru");
  } finally {
    unsubscribe();
    setLocale(previous);
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  }
});

test("Spanish regional tags normalize to es and remain a registered locale", () => {
  assert.equal(isLocaleId("es"), true);
  assert.equal(isLocaleId("es-ES"), false);
  assert.equal(isLocaleId("es-MX"), false);
  assert.equal(normalizeLocale("es"), "es");
  assert.equal(normalizeLocale("es-ES"), "es");
  assert.equal(normalizeLocale("es-MX"), "es");
  assert.equal(normalizeLocale("ES-es"), "es");
  assert.equal(normalizeLocale("es-419"), "es");
  assert.ok(LOCALE_OPTIONS.some((option) => option.id === "es" && option.nativeLabel === "Español"));
  assert.equal(localeDefinition("es").dateTimeLocale, "es-ES");
  assert.equal(localeDefinition("es").numberLocale, "es-ES");
  assert.equal(localeDefinition("es").direction ?? "ltr", "ltr");
});

test("Spanish host copy is translated, keeps placeholders, and uses the trading glossary", () => {
  const han = /\p{Script=Han}/u;
  withLocale("es", () => {
    assert.equal(t("shell.replay"), "Reproducción");
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "Conectado a Binance");
    assert.equal(t("orderBook.title"), "Libro de órdenes");
    assert.equal(t("watchlist.title"), "Lista de seguimiento");
    assert.match(t("pane.funding.percent"), /tasa de financiaci[oó]n/i);
    assert.match(t("replay.hub.marginMode"), /margen/i);
    assert.match(t("backtest.title"), /prueba retrospectiva/i);
    assert.match(t("replay.shell.position"), /posici[oó]n/i);
    assert.match(t("replay.shell.unrealized"), /p[eé]rdidas y ganancias/i);
    assert.match(t("replay.shell.ordersFills"), /[oó]rdenes/i);
    assert.match(t("replay.shell.ordersFills"), /ejecuci/i);
    assert.match(t("shell.replay"), /reproducci[oó]n/i);
    assert.match(t("replay.init.hedgeHybrid"), /HEDGE_HYBRID/);
    assert.doesNotMatch(t("replay.init.hedgeHybrid"), han);
    assert.doesNotMatch(t("shell.replay"), /Replay/);
    assert.doesNotMatch(t("orderBook.title"), /Order book/i);
    assert.doesNotMatch(t("status.connectedTo", { exchange: "Binance" }), han);
    assert.equal(
      [...t("status.connectedTo").matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).join(","),
      "exchange",
    );
  });
  assert.equal(t("shell.replay", {}, "es"), "Reproducción");
  assert.notEqual(t("shell.replay", {}, "es"), t("shell.replay", {}, "en"));
  assert.notEqual(t("orderBook.title", {}, "es"), t("orderBook.title", {}, "zh-CN"));
});

test("Spanish plurals distinguish one, other, and many and format numbers with a decimal comma", () => {
  withLocale("es", () => {
    assert.equal(getDateTimeLocale(), "es-ES");
    assert.equal(getNumberLocale(), "es-ES");
    assert.equal(new Intl.NumberFormat(getNumberLocale()).format(1234.56).includes(","), true);
    assert.match(new Intl.NumberFormat(getNumberLocale()).format(1234.56), /1.?234,56/);
    assert.equal(tPlural("status.barCount", 1), "1 barra");
    assert.equal(tPlural("status.barCount", 2), "2 barras");
    assert.equal(tPlural("status.barCount", 1_000_000), "1000000 barras");
    assert.equal(tPlural("status.exchangeLimitationCount", 1), "1 limitación del exchange");
    assert.equal(tPlural("status.exchangeLimitationCount", 3), "3 limitaciones del exchange");
    assert.equal(tPlural("workbench.intervalCount", 1), "1 intervalo");
    assert.equal(tPlural("workbench.intervalCount", 4), "4 intervalos");
    assert.match(tPlural("pane.flow.missing", 1), /1 barra/);
    assert.match(tPlural("pane.flow.missing", 2), /2 barras/);
    assert.match(tPlural("pane.flow.gaps", 1), /1 /);
    assert.match(tPlural("pane.flow.gaps", 2), /2 /);
    const categories = new Intl.PluralRules("es").resolvedOptions().pluralCategories;
    assert.ok(categories.includes("one"));
    assert.ok(categories.includes("other"));
    assert.ok(categories.includes("many"));
    assert.equal(typeof localeDefinition("es").messages["status.barCount.many"], "string");
  });
});

test("Spanish hydrateLocale writes document lang and ltr direction", () => {
  const previous = getLocale();
  const previousDocument = globalThis.document;
  const documentElement: { lang?: string; dir?: string } = {};
  try {
    (globalThis as { document?: { documentElement: { lang?: string; dir?: string } } }).document = {
      documentElement,
    };
    assert.equal(hydrateLocale("es-ES"), "es");
    assert.equal(documentElement.lang, "es");
    assert.equal(documentElement.dir, "ltr");
    hydrateLocale("es-MX");
    assert.equal(documentElement.lang, "es");
    assert.equal(documentElement.dir, "ltr");
  } finally {
    setLocale(previous);
    if (previousDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document: typeof previousDocument }).document = previousDocument;
    }
  }
});

function placeholders(value: string): string {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort().join(",");
}

function sharedHanCore(message: string): string {
  return message
    .replace(/\{[A-Za-z0-9_]+\}/g, "")
    .replace(/[A-Za-z0-9._+/-]+/g, "")
    .replace(/[\s{}.…・：:：、。()（）[\]【】「」『』<>《》/\\'"‘’“”·•※*~^|!?？！,，;；@#$%&_=<>+\-—–−≈〜～]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "");
}

function isIdentifierLike(message: string): boolean {
  const core = sharedHanCore(message.trim());
  return core.length === 0 || (core.length <= 8 && /^[\p{Script=Han}\p{Number}]+$/u.test(core));
}

test("Japanese catalog translates every host key without English or Chinese fillers", () => {
  const keys = Object.keys(zhCN) as Array<keyof typeof zhCN>;
  assert.equal(Object.keys(ja).length, keys.length);
  let translated = 0;
  for (const key of keys) {
    const message = ja[key];
    assert.equal(typeof message, "string");
    assert.ok(message.trim().length > 0, key);
    assert.equal(placeholders(message), placeholders(zhCN[key]), key);
    if (message === zhCN[key] || message === en[key]) {
      assert.ok(isIdentifierLike(message), `non-identifier ja copy matches another locale: ${key} = ${JSON.stringify(message)}`);
    } else {
      translated += 1;
    }
  }
  assert.ok(translated > keys.length * 0.9);
});

test("Japanese dates, numbers, and document lang follow the shipped ja locale", () => {
  const previous = getLocale();
  const previousDocument = globalThis.document;
  const documentElement: { lang?: string; dir?: string } = {};
  globalThis.document = { documentElement } as unknown as Document;
  try {
    setLocale("ja-JP");
    assert.equal(getLocale(), "ja");
    assert.equal(documentElement.lang, "ja");
    assert.equal(documentElement.dir, "ltr");
    const date = new Date(2024, 0, 15, 13, 4, 5);
    assert.match(date.toLocaleDateString(getDateTimeLocale()), /2024/);
    assert.match(date.toLocaleDateString(getDateTimeLocale()), /1/);
    assert.equal((1234.5).toLocaleString(getNumberLocale()), "1,234.5");
    setLocale("en");
    assert.equal(documentElement.lang, "en");
    setLocale("ja");
    assert.equal(t("css.workspaceLoading"), "チャートワークスペースを読み込み中…");
    assert.equal(t("scale.auto"), "自動スケール");
    assert.match(t("replay.init.hedgeHybrid"), /HEDGE_HYBRID/);
    assert.doesNotMatch(t("replay.init.hedgeHybrid"), /资金费|資金費/);
  } finally {
    if (previousDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document: typeof previousDocument }).document = previousDocument;
    }
    setLocale(previous);
  }
});

function placeholderKeys(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!).sort();
}

function stripKnownTokens(value: string): string {
  return value
    .replace(/\{[A-Za-z0-9_]+\}/g, " ")
    .replace(/CandleScope|TradingView|Binance|OKX|WebSocket|REST|CSV|JSON|Pyne|Pine|ATR|UTC|SQLite|FastAPI|React/gi, " ")
    .replace(/[A-Z][A-Z0-9_]{2,}/g, " ");
}

test("Korean locale registers, normalizes ko-KR, and applies document lang", () => {
  assert.equal(isLocaleId("ko"), true);
  assert.equal(isLocaleId("ko-KR"), false);
  assert.equal(normalizeLocale("ko"), "ko");
  assert.equal(normalizeLocale("ko-KR"), "ko");
  assert.equal(normalizeLocale("KO-kr"), "ko");
  assert.ok(LOCALE_OPTIONS.some((option) => option.id === "ko" && option.nativeLabel === "한국어"));
  assert.equal(DEFAULT_LOCALE, "zh-CN");
  assert.equal(localeDefinition("ko").direction, "ltr");

  const previousDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document: { documentElement: { lang?: string; dir?: string } } }).document = {
    documentElement: {},
  };
  try {
    withLocale("ko-KR", () => {
      assert.equal(getLocale(), "ko");
      assert.equal(document.documentElement.lang, "ko");
      assert.equal(document.documentElement.dir, "ltr");
      assert.equal(getDateTimeLocale(), "ko-KR");
      assert.equal(getNumberLocale(), "ko-KR");
    });
  } finally {
    if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document: unknown }).document = previousDocument;
  }
});

test("Korean catalog translates host copy, preserves placeholders, and uses required terms", () => {
  const hangul = /\p{Script=Hangul}/u;
  const han = /\p{Script=Han}/u;
  assert.equal(Object.keys(ko).length, Object.keys(zhCN).length);
  for (const key of messageKeys()) {
    const korean = ko[key];
    const english = en[key];
    const chinese = zhCN[key];
    assert.equal(typeof korean, "string", key);
    assert.ok(korean.trim(), key);
    assert.deepEqual(placeholderKeys(korean), placeholderKeys(chinese), key);
    const remainder = stripKnownTokens(english);
    const translatable = han.test(chinese) || /[A-Za-z]{4,}/.test(remainder);
    if (!translatable) continue;
    assert.notEqual(korean, english, key);
    assert.notEqual(korean, chinese, key);
    assert.match(korean, hangul, key);
  }

  withLocale("ko", () => {
    assert.equal(t("orderBook.title"), "호가창");
    assert.equal(t("rail.orderBook"), "호가창");
    assert.match(t("shell.replay"), /리플레이/);
    assert.match(t("replay.hub.funding"), /펀딩비/);
    assert.match(t("replay.control.positions"), /포지션/);
    assert.match(t("replay.hub.marginMode"), /증거금/);
    assert.match(t("drawing.position.rr"), /손익/);
    assert.match(t("trade.tape"), /체결/);
    assert.match(t("backtest.title"), /백테스트/);
    assert.match(t("status.connectedTo", { exchange: "Binance" }), /Binance/);
    assert.doesNotMatch(t("status.connectedTo", { exchange: "Binance" }), /\{exchange\}/);
    assert.match(t("settings.exchange.verification.events", { count: 3546 }), /3546/);
    assert.doesNotMatch(t("settings.exchange.verification.events", { count: 3546 }), /\{count\}/);
    assert.equal(tPlural("status.barCount", 1), t("status.barCount", { count: 1 }));
    assert.equal(tPlural("status.barCount", 2), t("status.barCount", { count: 2 }));
    assert.match(tPlural("status.barCount", 2), /2/);
    assert.doesNotMatch(tPlural("status.barCount", 2), /\{count\}/);
    assert.match(tPlural("status.barCount", 1), hangul);
    assert.doesNotMatch(t("replay.init.hedgeHybrid"), /资金费/);
    assert.match(t("replay.init.hedgeHybrid"), /HEDGE_HYBRID/);
  });
});

test("Korean format profiles and runtime switch stay on the shipped locale store", () => {
  const hangul = /\p{Script=Hangul}/u;
  withLocale("ko", () => {
    assert.equal(getDateTimeLocale(), "ko-KR");
    assert.equal(getNumberLocale(), "ko-KR");
    assert.equal(translateWsStatus("fallback"), t("status.ws.fallback"));
    assert.match(translateWsStatus("fallback"), hangul);
    assert.equal(translateMarketType("spot"), t("market.spot"));
    assert.match(translateMarketType("spot"), hangul);
    assert.equal(translateMarketType("futures"), t("market.futures"));
    assert.equal(translateMarketType("swap"), t("market.swap"));
    assert.match(t("settings.workbench.name"), hangul);
    assert.match(t("plugin.title"), hangul);
    assert.doesNotMatch(t("plugin.title"), /插件|Plugin center/);
  });
  withLocale("en", () => {
    assert.equal(t("shell.replay"), "Replay");
    assert.equal(getDateTimeLocale(), "en-GB");
  });
});
test("hydrateLocale writes pt-BR document lang and ltr direction for case variants", () => {
  const previousDocument = (globalThis as { document?: { documentElement: { lang: string; dir: string } } }).document;
  const documentElement = { lang: "", dir: "" };
  (globalThis as { document: { documentElement: { lang: string; dir: string } } }).document = { documentElement };
  const previous = getLocale();
  try {
    assert.equal(hydrateLocale("pt-br"), "pt-BR");
    assert.equal(getLocale(), "pt-BR");
    assert.equal(documentElement.lang, "pt-BR");
    assert.equal(documentElement.dir, "ltr");
    assert.equal(hydrateLocale("PT-BR"), "pt-BR");
    assert.equal(documentElement.lang, "pt-BR");
    assert.equal(setLocale("pt-PT"), DEFAULT_LOCALE);
    assert.equal(documentElement.lang, DEFAULT_LOCALE);
  } finally {
    setLocale(previous);
    if (previousDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document: unknown }).document = previousDocument;
    }
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

test("hydrateLocale writes canonical zh-TW document metadata for its explicit alias", () => {
  const previousDocument = globalThis.document;
  const documentElement = { lang: "", dir: "" };
  globalThis.document = { documentElement } as unknown as Document;
  const previous = getLocale();
  try {
    assert.equal(hydrateLocale("zh-Hant-TW"), "zh-TW");
    assert.equal(documentElement.lang, "zh-TW");
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
