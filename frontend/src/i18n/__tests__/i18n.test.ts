import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../catalogs/en.js";
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
  assert.equal(normalizeLocale("fr"), DEFAULT_LOCALE);
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
  withLocale("pt-BR", () => {
    assert.equal(getDateTimeLocale(), "pt-BR");
    assert.equal(getNumberLocale(), "pt-BR");
    assert.match(new Intl.NumberFormat(getNumberLocale()).format(1234567.89), /1\.234\.567,89/);
    assert.equal(new Intl.NumberFormat(getNumberLocale()).format(1.5).includes(","), true);
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
  withLocale("pt-BR", () => {
    assert.equal(t("shell.replay"), "Replay");
    assert.equal(t("status.connectedTo", { exchange: "Binance" }), "Conectado a Binance");
    assert.match(
      t("settings.exchange.verification.durationHours", { hours: 4 }),
      /4 horas/,
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
  "train", "test", "high", "low", "close", "open", "time", "percentage",
  "uvicorn", "aggtrade", "pro", "reverse", "windows", "bollinger",
  "socks5", "ta4j",
]);

/** Spellings that are valid Brazilian Portuguese, not leftover English. */
const PT_BR_IDENTICAL_SPELLINGS = new Set([
  "local", "software", "visual", "manual", "volume", "interface", "layout",
  "zoom", "editor", "python", "desktop", "web", "total", "normal", "original",
  "capital", "auto", "error", "item", "status", "type", "mode", "model",
  "regular", "final", "terminal", "stack", "proxy", "amplitude", "ticker",
  "backend", "frontend", "runtime", "script", "offline", "loopback", "fallback",
  "polling", "footprint", "strategy", "use", "universal", "chip", "flag",
  "multi", "candles", "decimal", "event", "parameter", "value", "window", "hash",
  "coverage", "dataset", "pending", "empty", "rollback", "preset", "state",
  "language", "archive", "draft", "fidelity", "overview", "dates", "baseline",
  "resume", "compare", "smoke", "publisher", "checksum", "regime", "benchmark",
  "split", "viewer", "viewport", "insurance", "bundle", "handoff", "copy",
  "kind", "refs", "hold", "ledger", "rank", "diff", "params", "sample",
  "slippage", "turnover", "momentum", "group", "index", "version", "schema",
  "token", "cache", "buffer", "cluster", "yang", "yin", "york", "horizontal",
  "vertical", "digital", "global", "social", "real", "formal", "material",
  "general", "personal", "central", "principal",
  "cursor", "download", "bytes", "job", "jobs", "snap", "shift", "studio",
  "kernel", "ids", "ack", "toast", "hub", "candle", "checkpoint", "stream",
  "snapshots", "range", "source", "line", "area", "tabs", "research", "recent",
  "problems", "isolated", "rows", "count", "delta", "folds", "holdout",
  "funding", "datasets", "hashes", "fills", "prefix", "auditor", "epoch",
  "venue", "kill", "protection", "configuration", "comparison", "authority",
  "revisions", "bundles", "deltas", "resize", "tester", "explanation",
  "runtimes", "server", "drawdown", "oversold", "overbought", "embargo",
  "sampler", "lease", "budget", "timeline", "projection", "cap", "socks",
  "soak", "shadow", "streaming", "apis", "scripts", "bps", "dry",
  "virtual", "dock", "proxies", "touch", "historical", "year", "month",
  "combine", "letter", "drawings", "export", "exact", "closed", "display",
  "way", "runs", "full", "report", "try", "zero", "complete", "untitled",
  "top", "base", "off", "pause", "created", "read", "only", "fail", "smaller",
  "follow", "dead", "awaiting", "min", "mib", "debug", "canvas", "blob",
  "unix", "zip", "null", "sharpe", "qty", "liq", "sim", "fee", "max",
  "stop", "limit", "target", "batch", "flags", "inputs", "fold",
  "studies", "switch", "marketplace", "decide", "prepare", "spread",
  "ms", "px", "id", "vs",
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
    if (
      !portugueseLower.has(lower)
      || PT_BR_IDENTICAL_SPELLINGS.has(lower)
      || PT_BR_PRODUCT_TOKENS.has(lower)
    ) continue;
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
  } finally {
    setLocale(previous);
  }
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
