/**
 * IndicatorEditor — Python code editor for writing custom indicators.
 * Uses CodeMirror 6 with Python syntax highlighting.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState } from "@codemirror/state";

export default function IndicatorEditor({ indicator, onSave, onBack }) {
  const editorContainerRef = useRef(null);
  const editorViewRef = useRef(null);
  const [name, setName] = useState(indicator?.name || "My Indicator");
  const [paramsJson, setParamsJson] = useState(
    JSON.stringify(indicator?.params || {}, null, 2)
  );
  const [paramsError, setParamsError] = useState(null);

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorContainerRef.current) return;

    const state = EditorState.create({
      doc: indicator?.script || "",
      extensions: [
        basicSetup,
        python(),
        oneDark,
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { fontFamily: "'Fira Code', 'Consolas', monospace" },
          ".cm-gutters": {
            backgroundColor: "#1e1e2e",
            borderRight: "1px solid #313244",
          },
        }),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    });

    editorViewRef.current = view;

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, []);

  const handleSave = useCallback(() => {
    // Validate params JSON
    let params = {};
    try {
      params = JSON.parse(paramsJson);
      setParamsError(null);
    } catch (e) {
      setParamsError("JSON 格式错误: " + e.message);
      return;
    }

    const script = editorViewRef.current
      ? editorViewRef.current.state.doc.toString()
      : indicator?.script || "";

    onSave({
      id: indicator?.id || null,
      name,
      script,
      params,
      description: indicator?.description || "",
      isPreset: indicator?.isPreset || false,
    });
  }, [name, paramsJson, indicator, onSave]);

  return (
    <div className="indicator-editor">
      {/* Toolbar */}
      <div className="indicator-editor-toolbar">
        <button className="indicator-editor-back" onClick={onBack}>
          ← 返回
        </button>
        <span className="indicator-editor-title">代码编辑器</span>
        <button className="indicator-editor-save" onClick={handleSave}>
          💾 保存并应用
        </button>
      </div>

      {/* Name input */}
      <div className="indicator-editor-field">
        <label>指标名称</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="indicator-editor-name-input"
        />
      </div>

      {/* Code editor */}
      <div className="indicator-editor-code-label">
        <span>Python 脚本</span>
        <span className="indicator-editor-hint">
          可用变量: open, high, low, close, volume, time | 函数: add_line(data, color, title, overlay)
        </span>
      </div>
      <div className="indicator-editor-codemirror" ref={editorContainerRef} />

      {/* Params editor */}
      <div className="indicator-editor-field">
        <label>
          参数 (JSON)
          {paramsError && <span className="indicator-editor-params-error">{paramsError}</span>}
        </label>
        <textarea
          className="indicator-editor-params"
          value={paramsJson}
          onChange={(e) => {
            setParamsJson(e.target.value);
            setParamsError(null);
          }}
          rows={3}
          spellCheck={false}
        />
      </div>

      {/* Help section */}
      <details className="indicator-editor-help">
        <summary>📖 编写指南</summary>
        <div className="indicator-editor-help-content">
          <p><strong>可用变量（numpy 数组）:</strong></p>
          <ul>
            <li><code>open</code>, <code>high</code>, <code>low</code>, <code>close</code>, <code>volume</code> — OHLCV 数据</li>
            <li><code>time</code> — 时间戳数组</li>
            <li><code>params</code> — 参数字典，对应上方 JSON</li>
          </ul>
          <p><strong>输出函数:</strong></p>
          <ul>
            <li><code>add_line(data, color="#f59e0b", title="", line_width=2, overlay=True)</code></li>
          </ul>
          <p><strong>可用库:</strong> <code>numpy</code> (as <code>np</code>), <code>math</code></p>
          <p><strong>示例 — EMA:</strong></p>
          <pre>{`period = params.get("period", 12)
ema = np.full(len(close), np.nan)
ema[period-1] = np.mean(close[:period])
k = 2 / (period + 1)
for i in range(period, len(close)):
    ema[i] = close[i] * k + ema[i-1] * (1-k)
add_line(ema, color="#22d3ee", title=f"EMA({period})")`}</pre>
        </div>
      </details>
    </div>
  );
}
