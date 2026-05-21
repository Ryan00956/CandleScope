/**
 * IndicatorEditor — Pyne code editor for writing custom indicators.
 *
 * Uses Monaco Editor with:
 *   - Python syntax highlighting (base language)
 *   - Pyne autocompletion (ta.*, input.*, color.*, plot, etc.)
 *   - Pyne hover documentation
 *   - Custom dark theme optimized for trading scripts
 *   - Code snippet templates for common indicators
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { registerPyneLanguageSupport } from "../editor/pyneLanguage";
import { registerPyneTheme, getPyneEditorOptions } from "../editor/pyneTheme";
import { usePyneSecurityPolicy } from "../features/indicators/usePyneSecurityPolicy";

/** Track whether Pyne providers have been registered globally */
let pyneRegistered = false;

export default function IndicatorEditor({
  indicator,
  onSave,
  onBack,
  onPreview,
  onForkBuiltin,
  readOnly = false,
  previewState, // { id: string | null, error: string | null, visible: boolean, isComputing: boolean }
  onToggleVisibility
}) {
  const [name, setName] = useState(indicator?.name || "My Indicator");
  const [script, setScript] = useState(indicator?.script || "");
  const [securityMode, setSecurityMode] = useState(indicator?.securityMode || "safe");
  const securityPolicy = usePyneSecurityPolicy();
  const editorRef = useRef(null);

  const handlePreview = useCallback(() => {
    if (readOnly) return;
    onPreview({
      id: indicator?.id || previewState?.id || null,
      name,
      script,
      params: indicator?.params || {},
      description: indicator?.description || "",
      securityMode,
      isPreset: indicator?.isPreset || false,
    });
  }, [name, script, securityMode, indicator, onPreview, previewState, readOnly]);

  const handleSave = useCallback(() => {
    if (readOnly) return;
    onSave({
      id: indicator?.id || previewState?.id || null,
      name,
      script,
      params: indicator?.params || {},
      description: indicator?.description || "",
      securityMode,
      isPreset: indicator?.isPreset || false,
    });
  }, [name, script, securityMode, indicator, onSave, previewState, readOnly]);

  const handleSecurityModeChange = useCallback((event) => {
    const nextMode = event.target.value;
    if (
      nextMode === "unsafe" &&
      !window.confirm("不安全模式允许脚本执行任意 Python 代码，包括访问文件、网络和交易 API。仅在本机运行完全信任的脚本时启用。")
    ) {
      return;
    }
    setSecurityMode(nextMode);
  }, []);

  /**
   * Called before Monaco mounts — register theme so it's available
   * for the first render.
   */
  const handleBeforeMount = useCallback((monaco) => {
    registerPyneTheme(monaco);
  }, []);

  /**
   * Called when Monaco editor mounts — register Pyne language
   * providers (completion, hover) once globally.
   */
  const handleEditorMount = useCallback((editor, monaco) => {
    editorRef.current = editor;

    // Register Pyne providers once (they're global to the Monaco instance)
    if (!pyneRegistered) {
      registerPyneLanguageSupport(monaco);
      pyneRegistered = true;
    }

    if (!readOnly) {
      // Add Ctrl+Enter shortcut to run
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        // Trigger preview via DOM click (simplest way to use latest state)
        document.querySelector(".indicator-editor-run")?.click();
      });
    }

    // Focus the editor
    editor.focus();
  }, [readOnly]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Don't dispose global providers — they persist across editor instances
      editorRef.current = null;
    };
  }, []);

  return (
    <div className="indicator-editor" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div className="indicator-editor-toolbar" style={{ padding: '12px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span className="indicator-editor-title" style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '0.5px' }}>
            {readOnly ? "内置指标参考实现" : "Pyne 指标编辑器"}
          </span>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{name}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {previewState?.id && !readOnly && (
            <button
              onClick={() => onToggleVisibility(previewState.id)}
              style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', transition: 'all 0.15s' }}
              title={previewState.visible ? "隐藏图表指标" : "显示图表指标"}
            >
              {previewState.visible ? "👁" : "👁‍🗨"}
            </button>
          )}
          {readOnly ? (
            <button
              className="indicator-editor-save"
              onClick={() => onForkBuiltin?.({ ...indicator, name, script, securityMode })}
              style={{ background: 'var(--accent-blue)', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', fontSize: '13px', boxShadow: '0 2px 8px rgba(59, 130, 246, 0.3)', transition: 'all 0.2s ease', marginLeft: '8px' }}
            >
              复制为自定义
            </button>
          ) : (
            <>
              <button
                className="indicator-editor-run"
                onClick={handlePreview}
                style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)', border: '1px solid var(--accent-blue)', padding: '6px 16px', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', fontSize: '13px', transition: 'all 0.2s ease', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                {previewState?.isComputing ? "⏳ 计算中..." : "▶ 运行到图表"}
              </button>
              <button
                className="indicator-editor-save"
                onClick={handleSave}
                style={{ background: 'var(--accent-blue)', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', fontSize: '13px', boxShadow: '0 2px 8px rgba(59, 130, 246, 0.3)', transition: 'all 0.2s ease', marginLeft: '8px' }}
              >
                💾 保存并关闭
              </button>
            </>
          )}
          <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 8px' }}></div>
          <button
            className="indicator-editor-back"
            onClick={onBack}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '4px', lineHeight: 1 }}
            title="关闭编辑器"
          >
            ×
          </button>
        </div>
      </div>

      <div style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {/* Name input */}
        <div className="indicator-editor-field" style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 500 }}>指标名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              if (!readOnly) setName(e.target.value);
            }}
            readOnly={readOnly}
            className="indicator-editor-name-input"
            style={{ width: '100%', padding: '12px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '15px', outline: 'none', transition: 'all 0.2s', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)' }}
          />
        </div>

        {/* Code editor */}
        <div className="indicator-editor-code-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '8px', marginTop: '-8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500 }}>Pyne 脚本</span>
            {!readOnly && <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
              模式
              <select
                value={securityMode}
                onChange={handleSecurityModeChange}
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '4px 8px', fontSize: '12px' }}
              >
                <option value="safe">safe</option>
                <option value="research">research</option>
                <option value="unsafe">unsafe</option>
              </select>
            </label>}
            {securityPolicy && (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                默认 {securityPolicy.mode} · 超时 {securityPolicy.timeoutSeconds}s
              </span>
            )}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>输入 <code style={{ background: 'var(--bg-tertiary)', padding: '1px 4px', borderRadius: '3px', fontSize: '11px' }}>ta.</code> <code style={{ background: 'var(--bg-tertiary)', padding: '1px 4px', borderRadius: '3px', fontSize: '11px' }}>input.</code> <code style={{ background: 'var(--bg-tertiary)', padding: '1px 4px', borderRadius: '3px', fontSize: '11px' }}>color.</code> 触发自动补全 · <kbd style={{ background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: '3px', fontSize: '10px', border: '1px solid var(--border-color)' }}>Ctrl+Enter</kbd> 运行</span>
        </div>
        {securityMode === "unsafe" && (
          <div style={{ marginBottom: '8px', padding: '8px 10px', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: '6px', color: 'var(--candle-down)', background: 'rgba(239, 68, 68, 0.08)', fontSize: '12px' }}>
            unsafe mode 会允许脚本访问完整 Python 能力，包括文件、网络和交易 API。只运行完全信任的本机脚本。
          </div>
        )}
        <div className="indicator-editor-monaco" style={{ flex: 1, minHeight: 0, border: "1px solid rgba(255, 255, 255, 0.1)", borderRadius: "10px", overflow: "hidden", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.2), inset 0 2px 4px rgba(0, 0, 0, 0.2)" }}>
          <Editor
            height="100%"
            defaultLanguage="python"
            theme="pyne-dark"
            value={script}
            onChange={(value) => {
              if (!readOnly) setScript(value || "");
            }}
            beforeMount={handleBeforeMount}
            onMount={handleEditorMount}
            options={getPyneEditorOptions(readOnly ? {
              readOnly: true,
              domReadOnly: true,
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              cursorStyle: "line-thin",
            } : {})}
          />
        </div>

      </div>

      {/* Error Console */}
      <div className="indicator-editor-console" style={{ padding: '8px 24px', background: 'var(--bg-primary)', borderTop: '1px solid var(--border-color)', minHeight: '40px', flexShrink: 0, display: 'flex', alignItems: 'center', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', overflowY: 'auto' }}>
        {readOnly ? (
          <span style={{ color: 'var(--text-muted)' }}>内置指标由 IndicatorEngine 计算；这里仅展示参考实现，修改代码不会影响图表。需要改代码时请先复制为自定义指标。</span>
        ) : previewState?.error ? (
          <span style={{ color: 'var(--candle-down)', whiteSpace: 'pre-wrap' }}>❌ {previewState.error}</span>
        ) : previewState?.isComputing ? (
          <span style={{ color: 'var(--accent-blue)' }}>⏳ 正在计算指标数据...</span>
        ) : previewState?.id ? (
          <span style={{ color: 'var(--candle-up)' }}>✅ 运行成功，已应用至图表</span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>💡 Pyne API: <code>ta.sma()</code> <code>ta.ema()</code> <code>ta.rsi()</code> <code>ta.macd()</code> <code>ta.bb()</code> <code>plot()</code> <code>input.int()</code> · 输入 <code>snippet</code> 查看模板</span>
        )}
      </div>
    </div>
  );
}
