import assert from "node:assert/strict";
import test from "node:test";
import { localizePyneItem, type PyneItem } from "../pyneLanguage.js";

const sample: PyneItem = {
  label: "rsi",
  detail: "RSI 指标模板",
  documentation: "相对强弱指标",
  insertText: 'hline(70, "超买")\nmarker(signal, text="买入")',
  kind: "Snippet",
};

test("Pyne Monaco resources preserve the detailed Chinese source locale", () => {
  assert.equal(localizePyneItem(sample, "snippet: RSI indicator", "zh-CN"), sample);
});

test("Pyne Monaco resources expose English-only docs and snippets in English", () => {
  const localized = localizePyneItem(sample, "snippet: RSI indicator", "en");
  assert.equal(localized.detail, "RSI indicator template");
  assert.match(localized.documentation, /Ready-to-edit Pyne template/);
  assert.match(localized.insertText, /Overbought/);
  assert.match(localized.insertText, /Buy/);
  assert.doesNotMatch(
    `${localized.detail}\n${localized.documentation}\n${localized.insertText}`,
    /[\p{Script=Han}]/u,
  );
});
