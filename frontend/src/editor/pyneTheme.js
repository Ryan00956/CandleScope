/**
 * Pyne Editor Theme — custom dark theme for the CandleScope indicator editor.
 *
 * Highlights Pyne-specific keywords (ta, input, color, plot, etc.)
 * with distinctive colors to make scripts more readable.
 */

/**
 * Define and register the Pyne dark theme on a Monaco instance.
 *
 * @param {import('monaco-editor')} monaco
 */
export function registerPyneTheme(monaco) {
  monaco.editor.defineTheme("pyne-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      // Python keywords
      { token: "keyword", foreground: "c586c0" },       // purple-pink
      { token: "keyword.control", foreground: "c586c0" },

      // Strings
      { token: "string", foreground: "ce9178" },        // warm orange
      { token: "string.escape", foreground: "d7ba7d" },

      // Numbers
      { token: "number", foreground: "b5cea8" },        // soft green

      // Comments
      { token: "comment", foreground: "6a9955", fontStyle: "italic" },

      // Functions / methods
      { token: "identifier", foreground: "9cdcfe" },    // light blue
      { token: "type", foreground: "4ec9b0" },          // teal

      // Operators
      { token: "operator", foreground: "d4d4d4" },
      { token: "delimiter", foreground: "d4d4d4" },

      // Decorators
      { token: "tag", foreground: "569cd6" },            // blue
    ],
    colors: {
      // Editor background
      "editor.background": "#0d1117",
      "editor.foreground": "#c9d1d9",

      // Selection
      "editor.selectionBackground": "#264f7833",
      "editor.inactiveSelectionBackground": "#264f7822",

      // Current line
      "editor.lineHighlightBackground": "#161b2233",
      "editor.lineHighlightBorder": "#00000000",

      // Line numbers
      "editorLineNumber.foreground": "#484f5866",
      "editorLineNumber.activeForeground": "#8b949e",

      // Cursor
      "editorCursor.foreground": "#58a6ff",

      // Gutter
      "editorGutter.background": "#0d1117",

      // Indent guides
      "editorIndentGuide.background": "#21262d",
      "editorIndentGuide.activeBackground": "#30363d",

      // Bracket matching
      "editorBracketMatch.background": "#3fb95033",
      "editorBracketMatch.border": "#3fb95066",

      // Widget (autocomplete dropdown)
      "editorWidget.background": "#161b22",
      "editorWidget.border": "#30363d",
      "editorWidget.foreground": "#c9d1d9",

      // Suggest widget (autocomplete)
      "editorSuggestWidget.background": "#161b22",
      "editorSuggestWidget.border": "#30363d",
      "editorSuggestWidget.foreground": "#c9d1d9",
      "editorSuggestWidget.highlightForeground": "#58a6ff",
      "editorSuggestWidget.selectedBackground": "#1f6feb33",

      // Hover widget
      "editorHoverWidget.background": "#161b22",
      "editorHoverWidget.border": "#30363d",
      "editorHoverWidget.foreground": "#c9d1d9",

      // Scrollbar
      "scrollbarSlider.background": "#484f5833",
      "scrollbarSlider.hoverBackground": "#484f5866",
      "scrollbarSlider.activeBackground": "#484f58aa",

      // Minimap (disabled but just in case)
      "minimap.background": "#0d1117",
    },
  });
}

/**
 * Get the Monaco editor options optimized for Pyne scripts.
 * Merges with any user-provided options.
 *
 * @param {object} [overrides] — Additional Monaco editor options
 * @returns {object} Monaco IStandaloneEditorConstructionOptions
 */
export function getPyneEditorOptions(overrides = {}) {
  return {
    // Typography
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
    fontLigatures: true,
    lineHeight: 24,
    letterSpacing: 0.3,

    // Layout
    minimap: { enabled: false },
    wordWrap: "on",
    scrollBeyondLastLine: false,
    padding: { top: 16, bottom: 16 },
    glyphMargin: false,
    folding: true,
    foldingHighlight: true,

    // Behavior
    smoothScrolling: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
    formatOnPaste: true,
    autoClosingBrackets: "always",
    autoClosingQuotes: "always",
    autoSurround: "languageDefined",
    tabSize: 4,
    insertSpaces: true,

    // Suggestions
    quickSuggestions: {
      other: true,
      comments: false,
      strings: false,
    },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnCommitCharacter: true,
    snippetSuggestions: "bottom",
    suggest: {
      showSnippets: true,
      showWords: false,       // Don't suggest random words from file
      showKeywords: true,
      preview: true,
      shareSuggestSelections: true,
    },

    // Rendering
    renderWhitespace: "none",
    renderLineHighlight: "line",
    bracketPairColorization: {
      enabled: true,
      independentColorPoolPerBracketType: true,
    },
    guides: {
      bracketPairs: true,
      indentation: true,
    },

    // Overrides
    ...overrides,
  };
}

export default registerPyneTheme;
