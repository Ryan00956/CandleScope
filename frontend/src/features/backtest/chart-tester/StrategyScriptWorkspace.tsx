import { useCallback, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";

import { registerPineLanguageSupport } from "../../../editor/pineLanguage.js";
import { registerPyneLanguageSupport } from "../../../editor/pyneLanguage.js";
import { getPyneEditorOptions, registerPyneTheme } from "../../../editor/pyneTheme.js";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import type { LocaleId } from "../../../i18n/locale.js";
import type { StrategyDraftCursor, StrategyDraftLanguage } from "./StrategyDraftStore.js";
import type { ChartStrategyDraftIssue } from "./chartStrategyTesterUiModel.js";

export interface StrategyScriptWorkspaceProps {
  source: string;
  language: StrategyDraftLanguage;
  cursor: StrategyDraftCursor | null;
  issues: readonly ChartStrategyDraftIssue[];
  focusIssue: ChartStrategyDraftIssue | null;
  focusOnMount: boolean;
  onSourceChange(source: string): void;
  onCursorChange(cursor: StrategyDraftCursor): void;
  onRun(): void;
}

function markerMessage(issue: ChartStrategyDraftIssue, locale: LocaleId): string {
  if (issue.code === "EMPTY_SOURCE") return t("chartTester.issue.emptyDetail", {}, locale);
  if (issue.code === "UNDECLARED_TARGET") {
    return t("chartTester.issue.unknownVariable", { variable: issue.variable ?? "target" }, locale);
  }
  return t("chartTester.issue.delimiter", { delimiter: issue.variable ?? "?" }, locale);
}

export default function StrategyScriptWorkspace({
  source,
  language,
  cursor,
  issues,
  focusIssue,
  focusOnMount,
  onSourceChange,
  onCursorChange,
  onRun,
}: StrategyScriptWorkspaceProps) {
  const locale = useLocale();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const pyneCleanupRef = useRef<(() => void) | null>(null);
  const runActionCleanupRef = useRef<Monaco.IDisposable | null>(null);
  const onRunRef = useRef(onRun);

  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  const publishMarkers = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    monaco.editor.setModelMarkers(model, "chart-strategy-tester", issues.map((issue) => ({
      severity: monaco.MarkerSeverity.Error,
      message: markerMessage(issue, locale),
      startLineNumber: issue.line,
      startColumn: issue.column,
      endLineNumber: issue.line,
      endColumn: Math.max(issue.column + 1, issue.endColumn),
    })));
  }, [issues, locale]);

  useEffect(() => {
    publishMarkers();
  }, [publishMarkers]);

  useEffect(() => {
    if (!focusIssue || !editorRef.current) return;
    editorRef.current.setPosition({ lineNumber: focusIssue.line, column: focusIssue.column });
    editorRef.current.revealLineInCenter(focusIssue.line);
    editorRef.current.focus();
  }, [focusIssue]);

  useEffect(() => () => {
    runActionCleanupRef.current?.dispose();
    runActionCleanupRef.current = null;
    pyneCleanupRef.current?.();
    pyneCleanupRef.current = null;
  }, []);

  const handleBeforeMount = useCallback((monaco: typeof Monaco) => {
    registerPyneTheme(monaco);
    if (language === "pine") registerPineLanguageSupport(monaco);
    else if (!pyneCleanupRef.current) {
      pyneCleanupRef.current = registerPyneLanguageSupport(monaco);
    }
  }, [language]);

  const handleMount = useCallback((
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
  ) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    runActionCleanupRef.current?.dispose();
    runActionCleanupRef.current = editor.addAction({
      id: "chart-strategy-tester.run",
      label: "Run chart strategy",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRunRef.current(),
    });
    if (cursor) editor.setPosition({ lineNumber: cursor.line, column: cursor.column });
    editor.onDidChangeCursorPosition((event) => {
      onCursorChange({ line: event.position.lineNumber, column: event.position.column });
    });
    publishMarkers();
    if (focusOnMount) editor.focus();
  }, [cursor, focusOnMount, onCursorChange, publishMarkers]);

  return (
    <div
      className="chart-strategy-editor"
      data-chart-strategy-editor={language}
    >
      <Editor
        height="100%"
        language={language === "pine" ? "pine" : "python"}
        value={source}
        theme="pyne-dark"
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        onChange={(value) => onSourceChange(value ?? "")}
        onValidate={publishMarkers}
        options={getPyneEditorOptions({
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 12,
          lineHeight: 20,
          padding: { top: 10, bottom: 10 },
          scrollBeyondLastLine: false,
          renderValidationDecorations: "on",
        })}
      />
    </div>
  );
}
