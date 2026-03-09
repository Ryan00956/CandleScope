/**
 * IndicatorEditor — Python code editor for writing custom indicators.
 * Uses Monaco Editor with Python syntax highlighting.
 */
import { useCallback, useState } from "react";
import Editor from "@monaco-editor/react";

export default function IndicatorEditor({ indicator, onSave, onBack }) {
  const [name, setName] = useState(indicator?.name || "My Indicator");
  const [script, setScript] = useState(indicator?.script || "");
  const [paramsJson, setParamsJson] = useState(
    JSON.stringify(indicator?.params || {}, null, 2)
  );
  const [paramsError, setParamsError] = useState(null);

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

    onSave({
      id: indicator?.id || null,
      name,
      script,
      params,
      description: indicator?.description || "",
      isPreset: indicator?.isPreset || false,
    });
  }, [name, script, paramsJson, indicator, onSave]);

  return (
    <div className="indicator-editor" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div className="indicator-editor-toolbar" style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <button
          className="indicator-editor-back"
          onClick={onBack}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <span style={{ fontSize: '18px' }}>←</span> 返回列表
        </button>
        <span className="indicator-editor-title" style={{ fontWeight: 600, fontSize: '16px', color: 'var(--text-primary)', letterSpacing: '0.5px' }}>✨ 自定义指标编辑器</span>
        <button
          className="indicator-editor-save"
          onClick={handleSave}
          style={{ background: 'var(--accent-blue)', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)', transition: 'all 0.2s ease' }}
        >
          💾 保存并应用
        </button>
      </div>

      <div style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {/* Name input */}
        <div className="indicator-editor-field" style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 500 }}>指标名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="indicator-editor-name-input"
            style={{ width: '100%', padding: '12px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '15px', outline: 'none', transition: 'all 0.2s', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)' }}
          />
        </div>

        {/* Code editor */}
        <div className="indicator-editor-code-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '8px' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500 }}>Python 算法脚本</span>
          <span className="indicator-editor-hint" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            可用变量: <code style={{ color: 'var(--accent-purple)' }}>open, high, low, close, volume, time</code>
          </span>
        </div>
        <div className="indicator-editor-monaco" style={{ height: "500px", border: "1px solid rgba(255, 255, 255, 0.1)", borderRadius: "10px", overflow: "hidden", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.2), inset 0 2px 4px rgba(0, 0, 0, 0.2)", flexShrink: 0 }}>
          <Editor
            height="100%"
            defaultLanguage="python"
            theme="vs-dark"
            value={script}
            onChange={(value) => setScript(value || "")}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
              wordWrap: "on",
              scrollBeyondLastLine: false,
              padding: { top: 16, bottom: 16 },
              lineHeight: 24,
              smoothScrolling: true,
              cursorBlinking: "smooth",
              cursorSmoothCaretAnimation: "on",
              formatOnPaste: true,
            }}
          />
        </div>

        {/* Params editor */}
        <div className="indicator-editor-field" style={{ marginTop: "24px" }}>
          <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 500 }}>
            <span>参数配置 (JSON)</span>
            {paramsError && <span className="indicator-editor-params-error" style={{ color: 'var(--candle-down)' }}>{paramsError}</span>}
          </label>
          <textarea
            className="indicator-editor-params"
            value={paramsJson}
            onChange={(e) => {
              setParamsJson(e.target.value);
              setParamsError(null);
            }}
            rows={4}
            spellCheck={false}
            style={{ width: '100%', padding: '12px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '14px', fontFamily: "'JetBrains Mono', 'Fira Code', monospace", outline: 'none', resize: 'vertical', minHeight: '100px', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)' }}
          />
        </div>

        {/* Help section */}
        <details className="indicator-editor-help" style={{ marginTop: "24px", padding: "16px", background: "rgba(59, 130, 246, 0.05)", border: "1px solid rgba(59, 130, 246, 0.2)", borderRadius: "8px" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent-blue)", outline: "none", userSelect: "none" }}>📖 编写指南 & 示例代码</summary>
          <div className="indicator-editor-help-content" style={{ marginTop: "16px", color: "var(--text-secondary)", fontSize: "13px", lineHeight: "1.6" }}>
            <p><strong>可用变量（numpy 数组）:</strong></p>
            <ul style={{ paddingLeft: "20px", marginBottom: "12px", color: "var(--text-primary)" }}>
              <li><code>open</code>, <code>high</code>, <code>low</code>, <code>close</code>, <code>volume</code> — OHLCV 数据</li>
              <li><code>time</code> — 时间戳数组</li>
              <li><code>params</code> — 参数字典，对应上方 JSON 解析结果</li>
            </ul>
            <p><strong>输出函数:</strong></p>
            <ul style={{ paddingLeft: "20px", marginBottom: "12px", color: "var(--text-primary)" }}>
              <li><code>add_line(data, color="#f59e0b", title="", line_width=2, overlay=True)</code></li>
            </ul>
            <p><strong>可用内置库:</strong> <code>numpy</code> (as <code>np</code>), <code>math</code></p>

            <p style={{ marginTop: "16px", fontWeight: "600" }}><strong>👉 示例 — 指数移动平均线 (EMA):</strong></p>
            <pre style={{ background: "rgba(0,0,0,0.3)", padding: "12px", borderRadius: "6px", fontFamily: "'JetBrains Mono', monospace", color: "var(--text-primary)", overflowX: "auto", border: "1px solid var(--border-color)" }}>{`period = params.get("period", 12)
ema = np.full(len(close), np.nan)
ema[period-1] = np.mean(close[:period])

k = 2 / (period + 1)
for i in range(period, len(close)):
    ema[i] = close[i] * k + ema[i-1] * (1-k)

add_line(ema, color="#22d3ee", title=f"EMA({period})", line_width=2)`}</pre>
          </div>
        </details>
      </div>
    </div>
  );
}
