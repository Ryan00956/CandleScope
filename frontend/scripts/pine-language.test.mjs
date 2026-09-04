import assert from "node:assert/strict";
import test from "node:test";

import {
  configurePineHostCapabilities,
  registerPineLanguageSupport,
} from "../src/editor/pineLanguage.ts";

function compile(languageId, definition) {
  if (typeof languageId !== "string" || !definition || typeof definition !== "object") {
    throw new Error("invalid monarch definition");
  }
  if (!definition.tokenizer || !Array.isArray(definition.tokenizer.root)) {
    throw new Error("monarch tokenizer.root is required");
  }
}

test("Pine language registration compiles its Monarch tokenizer", () => {
  const registeredLanguages = [];
  const monaco = {
    languages: {
      getLanguages: () => registeredLanguages,
      register: (language) => registeredLanguages.push(language),
      setLanguageConfiguration: () => {},
      setMonarchTokensProvider: (languageId, definition) => {
        compile(languageId, definition);
      },
      registerCompletionItemProvider: () => {},
    },
  };

  assert.doesNotThrow(() => registerPineLanguageSupport(monaco));
  assert.deepEqual(registeredLanguages.map(({ id }) => id), ["pine"]);
});

test("Pine completions expose only host-declared chart context fields", () => {
  let provider;
  const monaco = {
    languages: {
      CompletionItemKind: { Keyword: 1, Property: 2 },
      getLanguages: () => [{ id: "pine" }],
      register: () => {},
      setLanguageConfiguration: () => {},
      setMonarchTokensProvider: () => {},
      registerCompletionItemProvider: (_languageId, value) => { provider = value; },
    },
  };
  configurePineHostCapabilities({
    chartContext: {
      symbolFeatures: ["syminfo.tickerid"],
      timeframeFeatures: ["timeframe.period", "timeframe.multiplier"],
    },
  });
  registerPineLanguageSupport(monaco);
  const model = {
    getLineContent: () => "plot(timeframe.per",
    getWordUntilPosition: () => ({ startColumn: 16, endColumn: 19 }),
  };

  const result = provider.provideCompletionItems(model, { lineNumber: 1, column: 19 });
  const labels = result.suggestions.map(({ label }) => label);

  assert.deepEqual(labels.sort(), ["multiplier", "period"]);
  assert.equal(labels.includes("in_seconds"), false);
  const rootResult = provider.provideCompletionItems({
    getLineContent: () => "plo",
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 4 }),
  }, { lineNumber: 1, column: 4 });
  const rootLabels = rootResult.suggestions.map(({ label }) => label);
  assert.equal(rootLabels.includes("plot"), true);
  assert.equal(rootLabels.includes("plotarrow"), false);
  assert.equal(rootLabels.includes("strategy"), false);
});
