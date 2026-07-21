import type * as Monaco from "monaco-editor";

const PINE_LANGUAGE_ID = "pine";

const KEYWORDS = [
  "and", "as", "bool", "break", "by", "color", "const", "continue",
  "else", "enum", "export", "false", "float", "for", "if", "import",
  "in", "indicator", "int", "library", "map", "matrix", "method", "na",
  "not", "or", "series", "simple", "strategy", "string", "switch", "true",
  "type", "var", "varip", "while",
];
const HOST_COMPLETION_KEYWORDS = KEYWORDS.filter(
  (keyword) => !["import", "library", "strategy"].includes(keyword),
);

const BUILTINS = [
  "open", "high", "low", "close", "volume", "time", "bar_index",
  "plot", "plotshape", "hline", "fill", "bgcolor",
  "barcolor", "alert", "alertcondition", "input", "ta", "math", "color",
];

let hostedContextFeatures = new Set<string>();

export function configurePineHostCapabilities(
  capabilities: Record<string, unknown> | null | undefined,
): void {
  const chartContext = capabilities?.chartContext;
  if (!chartContext || typeof chartContext !== "object" || Array.isArray(chartContext)) {
    hostedContextFeatures = new Set();
    return;
  }
  const record = chartContext as Record<string, unknown>;
  const features: string[] = [];
  for (const value of [record.symbolFeatures, record.timeframeFeatures]) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") features.push(item);
    }
  }
  hostedContextFeatures = new Set(features);
}

export function registerPineLanguageSupport(monaco: typeof Monaco): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === PINE_LANGUAGE_ID)) {
    monaco.languages.register({
      id: PINE_LANGUAGE_ID,
      aliases: ["Pine", "Pine Script"],
      extensions: [".pine"],
    });
  }

  monaco.languages.setLanguageConfiguration(PINE_LANGUAGE_ID, {
    comments: { lineComment: "//" },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(PINE_LANGUAGE_ID, {
    keywords: KEYWORDS,
    builtins: BUILTINS,
    tokenizer: {
      root: [
        // Monarch expands @name inside regexes; @@ represents a literal @.
        [/^\s*\/\/@@version=\d+/, "metatag"],
        [/\/\/.*$/, "comment"],
        [/[a-zA-Z_]\w*/, {
          cases: {
            "@keywords": "keyword",
            "@builtins": "type.identifier",
            "@default": "identifier",
          },
        }],
        [/\d+\.\d+([eE][-+]?\d+)?/, "number.float"],
        [/\d+/, "number"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
        [/[{}()[\]]/, "@brackets"],
        [/[=><!~?:&|+*/%^-]+/, "operator"],
        [/[;,.]/, "delimiter"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape.invalid"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(PINE_LANGUAGE_ID, {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const range = model.getWordUntilPosition(position);
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const contextMatch = /\b(syminfo|timeframe)\.\w*$/.exec(linePrefix);
      const contextSuggestions = contextMatch
        ? [...hostedContextFeatures]
            .filter((feature) => feature.startsWith(`${contextMatch[1]}.`))
            .map((feature) => feature.slice(feature.indexOf(".") + 1))
        : [];
      const rootContextSuggestions = contextMatch
        ? []
        : [...new Set(
            [...hostedContextFeatures]
              .map((feature) => feature.split(".", 1)[0])
              .filter((value): value is string => typeof value === "string"),
          )];
      const labels = contextMatch
        ? contextSuggestions
        : [...HOST_COMPLETION_KEYWORDS, ...BUILTINS, ...rootContextSuggestions];
      const suggestions = labels.map((label) => ({
        label,
        kind: contextMatch
          ? monaco.languages.CompletionItemKind.Property
          : monaco.languages.CompletionItemKind.Keyword,
        insertText: label,
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
        },
      }));
      return { suggestions };
    },
  });
}
