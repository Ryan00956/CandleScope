/**
 * IndicatorPanel — slide-out panel for browsing, adding, and managing indicators.
 *
 * Features:
 * - Browse built-in presets (MA, EMA, BOLL, RSI, MACD, etc.)
 * - View & manage active indicators (toggle visibility, remove, edit params)
 * - Open code editor for custom indicators
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fetchPresets, fetchPreset } from "../services/indicatorApi";
import IndicatorEditor from "./IndicatorEditor";

const CATEGORY_LABELS = {
  "趋势": "趋势",
  "震荡": "震荡",
  "波动": "波动率",
  "成交量": "成交量",
  "custom": "自定义",
  // English fallbacks
  "trend": "趋势",
  "momentum": "动量",
  "volatility": "波动率",
  "volume": "成交量",
};

const CATEGORY_ICONS = {
  "趋势": "📈",
  "震荡": "⚡",
  "波动": "📊",
  "成交量": "📦",
  "custom": "✏️",
  // English fallbacks
  "trend": "📈",
  "momentum": "⚡",
  "volatility": "📊",
  "volume": "📦",
};

export default function IndicatorPanel({
  isOpen,
  onClose,
  activeIndicators,
  onAddIndicator,
  onRemoveIndicator,
  onToggleVisibility,
  onUpdateParams,
  onUpdateScript,
  computing,
  onRecompute,
}) {
  const [tab, setTab] = useState("presets"); // "presets" | "active" | "editor"
  const [presets, setPresets] = useState([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingIndicator, setEditingIndicator] = useState(null);

  const [panelWidth, setPanelWidth] = useState(400);
  const [isResizing, setIsResizing] = useState(false);

  const startResizing = useCallback((e) => {
    setIsResizing(true);
    e.preventDefault();
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback((e) => {
    if (isResizing) {
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth > 350 && newWidth < window.innerWidth - 100) {
        setPanelWidth(newWidth);
      }
    }
  }, [isResizing]);

  useEffect(() => {
    if (isResizing) {
      window.addEventListener("mousemove", resize);
      window.addEventListener("mouseup", stopResizing);
    }
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

  // Load presets on first open
  useEffect(() => {
    if (isOpen && presets.length === 0) {
      setPresetsLoading(true);
      fetchPresets()
        .then((data) => setPresets(data))
        .catch((err) => console.error("Failed to load presets:", err))
        .finally(() => setPresetsLoading(false));
    }
  }, [isOpen]);

  const handleAddPreset = useCallback(async (preset) => {
    try {
      // Fetch full preset with script
      const full = await fetchPreset(preset.id);
      onAddIndicator({
        id: full.id,
        name: full.name,
        engineName: full.engineName || null,  // registry key for compute API
        script: full.script,
        params: full.params || {},
        description: full.description || "",
        category: full.category || "",
        isPreset: true,
      });
      setTab("active");
    } catch (err) {
      console.error("Failed to add preset:", err);
    }
  }, [onAddIndicator]);

  const handleCreateCustom = useCallback(() => {
    setEditingIndicator({
      id: null,
      name: "My Indicator",
      script: `# Custom Indicator
# Available variables: open, high, low, close, volume, time (numpy arrays)
# Use add_line(data, color, title) to output lines

# Example: Simple Moving Average
period = params.get("period", 20)
sma = []
for i in range(len(close)):
    if i < period - 1:
        sma.append(None)
    else:
        sma.append(sum(close[i-period+1:i+1]) / period)

add_line(sma, color="#f59e0b", title=f"SMA({period})")
`,
      params: { period: 20 },
      description: "",
      isPreset: false,
    });
    setTab("editor");
  }, []);

  const handleEditIndicator = useCallback((indicator) => {
    setEditingIndicator({ ...indicator });
    setTab("editor");
  }, []);

  const handleEditorPreview = useCallback((updated) => {
    if (updated.id && activeIndicators.some((i) => i.id === updated.id)) {
      onUpdateScript(updated.id, updated.script);
      if (updated.params) onUpdateParams(updated.id, updated.params);
      setEditingIndicator(prev => ({ ...prev, ...updated }));
    } else {
      const id = updated.id || `custom-${Date.now()}`;
      onAddIndicator({
        ...updated,
        id,
        isPreset: false,
      });
      setEditingIndicator(prev => ({ ...prev, ...updated, id }));
    }
  }, [activeIndicators, onAddIndicator, onUpdateScript, onUpdateParams]);

  const handleEditorSave = useCallback((updated) => {
    if (updated.id && activeIndicators.some((i) => i.id === updated.id)) {
      // Update existing — these already trigger pendingForceCompute in useIndicators
      onUpdateScript(updated.id, updated.script);
      if (updated.params) onUpdateParams(updated.id, updated.params);
    } else {
      // Add new — addIndicator already triggers pendingForceCompute
      const id = updated.id || `custom-${Date.now()}`;
      onAddIndicator({
        ...updated,
        id,
        isPreset: false,
      });
    }
    setEditingIndicator(null);
    setTab("active");
    // No need to manually call onRecompute — the state changes above
    // already set pendingForceComputeRef which triggers automatic recompute
  }, [activeIndicators, onAddIndicator, onUpdateScript, onUpdateParams]);

  const handleEditorBack = useCallback(() => {
    setEditingIndicator(null);
    setTab(activeIndicators.length > 0 ? "active" : "presets");
  }, [activeIndicators.length]);

  // Calculate previewState
  const previewedActiveIndicator = editingIndicator?.id ? activeIndicators.find(i => i.id === editingIndicator.id) : null;
  const previewState = editingIndicator ? {
    id: previewedActiveIndicator?.id || null,
    error: previewedActiveIndicator?.error || null,
    visible: previewedActiveIndicator ? previewedActiveIndicator.visible : true,
    isComputing: computing
  } : null;

  // Filter presets by search
  const filteredPresets = presets.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      (p.description || "").toLowerCase().includes(q) ||
      (p.category || "").toLowerCase().includes(q)
    );
  });

  // Group presets by category
  const groupedPresets = {};
  for (const p of filteredPresets) {
    const cat = p.category || "custom";
    if (!groupedPresets[cat]) groupedPresets[cat] = [];
    groupedPresets[cat].push(p);
  }

  const isActive = (presetId) => activeIndicators.some((i) => i.id === presetId);

  if (!isOpen) return null;

  return (
    <div className="indicator-panel-overlay" onClick={onClose}>
      <div
        className="indicator-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ width: `${panelWidth}px` }}
      >
        {/* Resize Handle */}
        <div
          onMouseDown={startResizing}
          style={{
            position: 'absolute',
            left: '-2px',
            top: 0,
            bottom: 0,
            width: '6px',
            cursor: 'col-resize',
            zIndex: 100,
            backgroundColor: isResizing ? 'var(--accent-blue)' : 'transparent',
            transition: 'background-color 0.2s',
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = 'var(--accent-blue)'}
          onMouseLeave={(e) => { if (!isResizing) e.target.style.backgroundColor = 'transparent' }}
        />

        {tab === "editor" && editingIndicator ? (
          <IndicatorEditor
            indicator={editingIndicator}
            onSave={handleEditorSave}
            onBack={handleEditorBack}
            onPreview={handleEditorPreview}
            previewState={previewState}
            onToggleVisibility={onToggleVisibility}
          />
        ) : (
          <>
            {/* Header */}
            <div className="indicator-panel-header">
              <h3 className="indicator-panel-title">
                📊 指标
                {computing && <span className="indicator-computing-badge">计算中...</span>}
              </h3>
              <button className="indicator-panel-close" onClick={onClose}>✕</button>
            </div>

            {/* Tab bar */}
            <div className="indicator-tab-bar">
              <button
                className={`indicator-tab ${tab === "presets" ? "active" : ""}`}
                onClick={() => setTab("presets")}
              >
                内置指标
              </button>
              <button
                className={`indicator-tab ${tab === "active" ? "active" : ""}`}
                onClick={() => setTab("active")}
              >
                已添加 {activeIndicators.length > 0 && `(${activeIndicators.length})`}
              </button>
              <button
                className="indicator-tab indicator-tab-create"
                onClick={handleCreateCustom}
                title="创建自定义指标"
              >
                + 自定义
              </button>
            </div>

            {/* Content */}
            <div className="indicator-panel-content">
              {/* ── Presets tab ── */}
              {tab === "presets" && (
                <div className="indicator-presets">
                  <div className="indicator-search-wrapper">
                    <input
                      className="indicator-search"
                      type="text"
                      placeholder="搜索指标..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>

                  {presetsLoading ? (
                    <div className="indicator-loading">加载中...</div>
                  ) : (
                    Object.entries(groupedPresets).map(([cat, items]) => (
                      <div key={cat} className="indicator-category-group">
                        <div className="indicator-category-label">
                          <span>{CATEGORY_ICONS[cat] || "📌"}</span>
                          <span>{CATEGORY_LABELS[cat] || cat}</span>
                        </div>
                        {items.map((preset) => (
                          <div
                            key={preset.id}
                            className={`indicator-preset-item ${isActive(preset.id) ? "is-active" : ""}`}
                          >
                            <div className="indicator-preset-info">
                              <span className="indicator-preset-name">
                                {preset.name}
                                {preset.defaultEnabled && (
                                  <span style={{
                                    fontSize: 9,
                                    marginLeft: 6,
                                    padding: "1px 5px",
                                    borderRadius: 3,
                                    background: "rgba(59, 130, 246, 0.15)",
                                    color: "#3b82f6",
                                    fontWeight: 600,
                                    verticalAlign: "middle",
                                  }}>默认</span>
                                )}
                              </span>
                              <span className="indicator-preset-desc">{preset.description}</span>
                            </div>
                            <button
                              className={`indicator-add-btn ${isActive(preset.id) ? "added" : ""}`}
                              onClick={() => isActive(preset.id) ? onRemoveIndicator(preset.id) : handleAddPreset(preset)}
                            >
                              {isActive(preset.id) ? "✓" : "+"}
                            </button>
                          </div>
                        ))}
                      </div>
                    ))
                  )}

                  {!presetsLoading && filteredPresets.length === 0 && (
                    <div className="indicator-empty">未找到匹配的指标</div>
                  )}
                </div>
              )}

              {/* ── Active tab ── */}
              {tab === "active" && (
                <div className="indicator-active-list">
                  {activeIndicators.length === 0 ? (
                    <div className="indicator-empty">
                      <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                      <div>暂未添加指标</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                        从"内置指标"选择或创建自定义指标
                      </div>
                    </div>
                  ) : (
                    activeIndicators.map((ind) => (
                      <div key={ind.id} className="indicator-active-item">
                        <div className="indicator-active-header">
                          <button
                            className={`indicator-visibility-btn ${ind.visible ? "" : "hidden"}`}
                            onClick={() => onToggleVisibility(ind.id)}
                            title={ind.visible ? "隐藏" : "显示"}
                          >
                            {ind.visible ? "👁" : "👁‍🗨"}
                          </button>
                          <span className="indicator-active-name">{ind.name}</span>
                          {ind.error && (
                            <span className="indicator-error-badge" title={ind.error}>⚠️</span>
                          )}
                          <div className="indicator-active-actions">
                            <button
                              className="indicator-action-btn"
                              onClick={() => handleEditIndicator(ind)}
                              title="编辑代码"
                            >
                              ✏️
                            </button>
                            <button
                              className="indicator-action-btn indicator-remove-btn"
                              onClick={() => onRemoveIndicator(ind.id)}
                              title="移除"
                            >
                              🗑
                            </button>
                          </div>
                        </div>

                        {/* Param editors */}
                        {ind.params && Object.keys(ind.params).length > 0 && (
                          <div className="indicator-params">
                            {Object.entries(ind.params).map(([key, value]) => {
                              // Detect param type: color (#hex), number, or text
                              const isColor = typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value);
                              const isNumber = typeof value === "number";
                              const inputType = isColor ? "color" : isNumber ? "number" : "text";

                              return (
                                <div key={key} className="indicator-param-row">
                                  <label className="indicator-param-label">{key}</label>
                                  <input
                                    className="indicator-param-input"
                                    type={inputType}
                                    value={value}
                                    step={isNumber && !Number.isInteger(value) ? "0.1" : undefined}
                                    onChange={(e) => {
                                      const newVal = isNumber
                                        ? Number(e.target.value)
                                        : e.target.value;
                                      onUpdateParams(ind.id, { ...ind.params, [key]: newVal });
                                    }}
                                    onBlur={() => onRecompute?.(true)}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {ind.error && (
                          <div className="indicator-error-msg">{ind.error}</div>
                        )}

                        {/* Line legend */}
                        {ind.lines && ind.lines.length > 0 && (
                          <div className="indicator-lines-legend">
                            {ind.lines.map((line, idx) => (
                              <span key={idx} className="indicator-line-badge">
                                <span
                                  className="indicator-line-dot"
                                  style={{ background: line.color || "#f59e0b" }}
                                />
                                {line.title || `Line ${idx + 1}`}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}

                  {activeIndicators.length > 0 && (
                    <button
                      className="indicator-recompute-btn"
                      onClick={() => onRecompute?.(true)}
                      disabled={computing}
                    >
                      {computing ? "计算中..." : "🔄 重新计算全部"}
                    </button>
                  )}
                </div>
              )}

            </div>
          </>
        )}
      </div>
    </div>
  );
}
