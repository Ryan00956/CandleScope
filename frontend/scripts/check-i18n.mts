import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DEFAULT_LOCALE, LOCALES, localeDefinition } from "../src/i18n/registry.js";

const ZH_TW_SIMPLIFIED_HAN = new Set(
  fs.readFileSync(new URL("./zh-tw-simplified-han.txt", import.meta.url), "utf8").trim(),
);
const ZH_TW_ALLOWED_VARIANT_HAN = new Set("准台吃峰干游");
const ZH_TW_REMNANT_PHRASE = /軟件|網絡|默認|信息|加載|視頻|數據|插件|软件|网络|默认|加载|视频|数据|保存(?!期限)|許可權|賬戶|實時|自定義|登入檔/;

function isZhTwLocale(locale: string): boolean {
  try {
    return new Intl.Locale(locale).baseName.toLowerCase() === "zh-tw";
  } catch {
    return locale.toLowerCase() === "zh-tw";
  }
}

function zhTwRemnant(message: string): string | null {
  const phrase = ZH_TW_REMNANT_PHRASE.exec(message);
  if (phrase) return phrase[0]!;
  for (const ch of message) {
    if (ZH_TW_SIMPLIFIED_HAN.has(ch) && !ZH_TW_ALLOWED_VARIANT_HAN.has(ch)) return ch;
  }
  return null;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIPPED_SEGMENTS = new Set(["__tests__", "i18n"]);
const SKIPPED_SUFFIXES = [".test.ts", ".test.tsx"];
const LOCALE_FORMAT_METHODS = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
]);
const USER_TEXT_ATTRIBUTES = new Set(["aria-label", "placeholder", "title"]);
const TECHNICAL_TEXT = new Set([
  "AND", "BAR", "AGG_TRADE", "CALMAR", "CSV", "Candle", "CandleScope",
  "CandleScope v0.2.0", "Calmar", "Ctrl", "Ctrl+Enter", "DB + WAL", "Enter", "Esc", "EXPECTANCY",
  "FULL", "LIVE", "LONG", "MAE", "MFE", "NET_RETURN", "NONE", "NOT",
  "OOS", "OFF", "RANDOM", "SANDBOX_FIXED", "SHARPE", "SHORT", "Scope",
  "Sortino", "Vol", "WARM", "market-data", "null",
  "React + Lightweight Charts", "FastAPI + SQLite (WAL)",
  "Binance REST + WebSocket", "💡 Pyne API:", "💡 Pine v5/v6 closed-bar API:",
]);

export interface I18nProblem {
  file: string;
  line: number;
  message: string;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)]
    .map((match) => match[1]!)
    .sort();
}

export function catalogProblems(
  catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>,
  referenceLocale: string,
): string[] {
  const problems: string[] = [];
  const reference = catalogs[referenceLocale];
  if (!reference) return [`missing reference catalog: ${referenceLocale}`];
  const referenceKeys = Object.keys(reference).sort();
  const pluralBases = new Set(referenceKeys
    .filter((key) => key.endsWith(".one") && Object.hasOwn(reference, key.slice(0, -4)))
    .map((key) => key.slice(0, -4)));
  for (const [locale, messages] of Object.entries(catalogs)) {
    for (const key of referenceKeys) {
      if (!Object.hasOwn(messages, key)) problems.push(`missing ${locale} key: ${key}`);
    }
    for (const [key, message] of Object.entries(messages)) {
      const plural = /^(.*)\.(zero|one|two|few|many|other)$/.exec(key);
      const pluralBase = plural && pluralBases.has(plural[1]!) ? plural[1]! : null;
      const referenceKey = pluralBase ?? key;
      if (!Object.hasOwn(reference, key) && !pluralBase) {
        problems.push(`unknown ${locale} key: ${key}`);
        continue;
      }
      if (!message.trim()) problems.push(`empty ${locale} message: ${key}`);
      if (locale.split("-")[0]!.toLowerCase() === "en" && /\p{Script=Han}/u.test(message)) {
        problems.push(`English message contains Han text: ${key}`);
      }
      if (isZhTwLocale(locale)) {
        const remnant = zhTwRemnant(message);
        if (remnant) problems.push(`zh-TW simplified remnant: ${locale}:${key} (${remnant})`);
      }
      const expected = placeholders(reference[referenceKey]!);
      const actual = placeholders(message);
      if (expected.join("\0") !== actual.join("\0")) {
        problems.push(`placeholder mismatch: ${locale}:${key} (${expected.join(",")} != ${actual.join(",")})`);
      }
    }
    for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
      if (category === "other") continue; // The unsuffixed message is the other form.
      for (const base of pluralBases) {
        const key = `${base}.${category}`;
        if (!Object.hasOwn(messages, key) && !referenceKeys.includes(key)) {
          problems.push(`missing ${locale} plural form: ${key}`);
        }
      }
    }
  }
  return problems;
}

function isTechnicalText(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return true;
  if (TECHNICAL_TEXT.has(text)) return true;
  if (/^[A-Za-z]{1,3}[−-]?$/.test(text)) return true;
  if (/^\d+(?:\.\d+)?[smhdwM]$/.test(text)) return true;
  if (/^[a-z][a-z0-9_]*(?:\(\)|\.)$/.test(text)) return true;
  if (/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+(?:\(\))?\.?$/.test(text)) return true;
  if (/^· [a-z][a-z0-9_]* #$/.test(text)) return true;
  if (/^(?:v?\d+(?:\.\d+){1,3}|Ctrl(?: \+ (?:Shift \+ )?[A-Z])?|[A-Z][A-Z0-9_./+ -]{1,32})$/.test(text)) return true;
  if (/^(?:https?:\/\/|[A-Z]{2,10}USDT$)/.test(text)) return true;
  return false;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function lintSourceText(file: string, source: string): I18nProblem[] {
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const problems: I18nProblem[] = [];
  const report = (node: ts.Node, message: string) => {
    problems.push({ file, line: lineOf(sourceFile, node), message });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 0
      && ts.isPropertyAccessExpression(node.expression)
      && LOCALE_FORMAT_METHODS.has(node.expression.name.text)
    ) {
      report(node, `${node.expression.name.text}() must receive the active locale`);
    }
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
      if (/[A-Za-z\p{Script=Han}]/u.test(text) && !isTechnicalText(text)) {
        report(node, `user-facing JSX text must use i18n: ${JSON.stringify(text)}`);
      }
    }
    if (
      ts.isJsxAttribute(node)
      && USER_TEXT_ATTRIBUTES.has(node.name.getText(sourceFile))
      && node.initializer
      && ts.isStringLiteral(node.initializer)
    ) {
      const text = node.initializer.text.trim();
      if (/[A-Za-z\p{Script=Han}]/u.test(text) && !isTechnicalText(text)) {
        report(node, `user-facing ${node.name.getText(sourceFile)} must use i18n: ${JSON.stringify(text)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return problems;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_SEGMENTS.has(entry.name)) walk(path.join(directory, entry.name));
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
        && !SKIPPED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
      ) files.push(absolute);
    }
  };
  walk(root);
  return files.sort();
}

export function sourceProblems(root: string): I18nProblem[] {
  return sourceFiles(root).flatMap((file) => lintSourceText(
    path.relative(path.dirname(root), file).replaceAll("\\", "/"),
    fs.readFileSync(file, "utf8"),
  ));
}

function main(): void {
  const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const catalogs = Object.fromEntries(LOCALES.map((locale) => [locale, localeDefinition(locale).messages]));
  const catalog = catalogProblems(catalogs, DEFAULT_LOCALE);
  const sources = sourceProblems(path.join(frontendRoot, "src"));
  const lines = [
    ...catalog.map((message) => `catalog: ${message}`),
    ...sources.map((problem) => `${problem.file}:${problem.line}: ${problem.message}`),
  ];
  if (lines.length > 0) {
    console.error(lines.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`i18n check passed (${LOCALES.length} locales, ${Object.keys(catalogs[DEFAULT_LOCALE]!).length} catalog keys, ${sourceFiles(path.join(frontendRoot, "src")).length} source files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
