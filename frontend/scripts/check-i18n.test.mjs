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

test("zh-TW catalog gate names locale and key for missing, extra, empty, placeholder, plural, and remnant copy", () => {
  const chinese = { saved: "已保存 {count}", "saved.one": "已保存 {count}" };
  assert.deepEqual(catalogProblems({
    "zh-CN": chinese,
    "zh-TW": { extra: "多餘" },
  }, "zh-CN"), [
    "missing zh-TW key: saved",
    "missing zh-TW key: saved.one",
    "unknown zh-TW key: extra",
  ]);
  assert.deepEqual(catalogProblems({
    "zh-CN": chinese,
    "zh-TW": { saved: "  ", "saved.one": "已儲存 {total}" },
  }, "zh-CN"), [
    "empty zh-TW message: saved",
    "placeholder mismatch: zh-TW:saved (count != )",
    "placeholder mismatch: zh-TW:saved.one (count != total)",
  ]);
  assert.deepEqual(catalogProblems({
    "zh-CN": { ok: "已保存" },
    "zh-TW": { ok: "已保存" },
  }, "zh-CN"), [
    "zh-TW simplified remnant: zh-TW:ok (保存)",
  ]);
  assert.deepEqual(catalogProblems({
    "zh-CN": { ok: "加载中" },
    "zh-TW": { ok: "加载中" },
  }, "zh-CN"), [
    "zh-TW simplified remnant: zh-TW:ok (加载)",
  ]);
  assert.deepEqual(catalogProblems({
    "zh-CN": { ok: "软件" },
    "zh-TW": { ok: "軟件" },
  }, "zh-CN"), [
    "zh-TW simplified remnant: zh-TW:ok (軟件)",
  ]);
  assert.deepEqual(catalogProblems({
    "zh-CN": { ok: "已保存 {count}" },
    "zh-TW": { ok: "已儲存 {count}" },
  }, "zh-CN"), []);
  assert.deepEqual(catalogProblems({
    "zh-CN": { preview: "预览注册表导入" },
    "zh-TW": { preview: "預覽登入檔匯入" },
  }, "zh-CN"), [
    "zh-TW simplified remnant: zh-TW:preview (登入檔)",
  ]);
  assert.deepEqual(catalogProblems({
    "zh-CN": { preview: "预览注册表导入" },
    "zh-TW": { preview: "預覽登錄檔匯入" },
  }, "zh-CN"), []);
});

test("zh-TW plural categories follow Intl.PluralRules and do not invent English one/other", () => {
  const chinese = { bars: "{count} 根", "bars.one": "{count} 根" };
  assert.deepEqual(
    new Intl.PluralRules("zh-TW").resolvedOptions().pluralCategories,
    ["other"],
  );
  assert.deepEqual(catalogProblems({
    "zh-CN": chinese,
    "zh-TW": { bars: "{count} 根", "bars.one": "{count} 根" },
  }, "zh-CN"), []);
  const russian = {
    bars: "{count} бара", "bars.one": "{count} бар", "bars.few": "{count} бара",
  };
  assert.deepEqual(catalogProblems({ "zh-CN": chinese, ru: russian }, "zh-CN"), [
    "missing ru plural form: bars.many",
  ]);
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
