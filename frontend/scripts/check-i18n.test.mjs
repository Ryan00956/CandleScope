import assert from "node:assert/strict";
import test from "node:test";
import { catalogProblems, lintSourceText } from "./check-i18n.mts";

test("i18n catalog gate catches key, placeholder, and English-locale leaks", () => {
  assert.deepEqual(catalogProblems(
    { ok: "Saved {count}", leak: "中文" },
    { ok: "已保存 {total}", extra: "多余" },
  ), [
    "missing zh-CN key: leak",
    "missing en key: extra",
    "placeholder mismatch: ok (count != total)",
  ]);
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
