import assert from "node:assert/strict";
import test from "node:test";
import { catalogProblems, lintSourceText } from "./check-i18n.mts";

test("i18n catalog gate catches key, placeholder, and English-locale leaks", () => {
  assert.deepEqual(catalogProblems(
    {
      "zh-CN": { ok: "已保存 {count}", extra: "多余" },
      en: { ok: "Saved {total}", leak: "中文", extra: "中文" },
    },
    "zh-CN",
  ), [
    "placeholder mismatch: en:ok (count != total)",
    "unknown en key: leak",
    "English message contains Han text: extra",
  ]);
});

test("catalog validation includes every language and permits Han text outside English", () => {
  assert.deepEqual(catalogProblems({
    "zh-CN": { saved: "已保存 {count}" },
    en: { saved: "Saved {count}" },
    ja: { saved: "{count} 件を保存" },
    fr: {},
  }, "zh-CN"), ["missing fr key: saved"]);
});

test("catalog validation requires language-specific plural forms and checks their placeholders", () => {
  const chinese = { bars: "{count} 根", "bars.one": "{count} 根" };
  const russian = {
    bars: "{count} бара", "bars.one": "{count} бар", "bars.few": "{total} бара",
  };
  assert.deepEqual(catalogProblems({ "zh-CN": chinese, ru: russian }, "zh-CN"), [
    "placeholder mismatch: ru:bars.few (count != total)",
    "missing ru plural form: bars.many",
  ]);
  assert.deepEqual(catalogProblems({
    "zh-CN": chinese,
    ru: { ...russian, "bars.few": "{count} бара", "bars.many": "{count} баров" },
  }, "zh-CN"), []);
});

test("i18n source gate catches literal UI copy and implicit locale formatting", () => {
  const problems = lintSourceText("Demo.tsx", `
    export function Demo() {
      return <button title="Save now">Save now {new Date().toLocaleString()}</button>;
    }
  `);
  assert.deepEqual(problems.map((item) => item.message), [
    "user-facing title must use i18n: \"Save now\"",
    "user-facing JSX text must use i18n: \"Save now\"",
    "toLocaleString() must receive the active locale",
  ]);
});

test("i18n source gate permits protocol and product identifiers", () => {
  assert.deepEqual(lintSourceText("Demo.tsx", `
    export function Demo() {
      return <><span>CandleScope</span><code>AGG_TRADE</code><kbd>Ctrl</kbd></>;
    }
  `), []);
});
