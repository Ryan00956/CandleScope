/**
 * IndicatorPanel — slide-out panel for browsing, adding, and managing indicators.
 *
 * Features:
 * - Browse built-in presets (MA, EMA, BOLL, RSI, MACD, etc.)
 * - View & manage active indicators (toggle visibility, remove, edit params)
 * - Open code editor for custom indicators
 */
import { useCallback, useEffect, useState } from "react";
import {
  deleteCustomIndicator,
  saveCustomIndicator,
} from "../services/indicatorApi";
import { useIndicatorCatalogRuntime } from "../features/indicators/useIndicatorCatalogRuntime";
import IndicatorEditor from "./IndicatorEditor";

const CATEGORY_LABELS = {
  "趋势": "趋势",
  "震荡": "震荡",
  "波动": "波动率",
  "成交量": "成交量",
  "custom": "自定义",
  // English fallbacks (lowercase)
  "trend": "趋势",
  "momentum": "动量",
  "volatility": "波动率",
  "volume": "成交量",
  "oscillator": "震荡",
  // English fallbacks (capitalized — as reported by backend engine)
  "Trend": "趋势",
  "Oscillator": "震荡",
  "Volatility": "波动率",
  "Volume": "成交量",
};

const CATEGORY_ICONS = {
  "趋势": "📈",
  "震荡": "⚡",
  "波动": "📊",
  "成交量": "📦",
  "custom": "✏️",
  // English fallbacks (lowercase)
  "trend": "📈",
  "momentum": "⚡",
  "volatility": "📊",
  "volume": "📦",
  "oscillator": "⚡",
  // English fallbacks (capitalized)
  "Trend": "📈",
  "Oscillator": "⚡",
  "Volatility": "📊",
  "Volume": "📦",
};

const SOURCE_OPTIONS = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"];
const ENGINE_SCRIPT_MARKER = "# __ENGINE__:";

function isBuiltinIndicator(indicator) {
  return Boolean(
    indicator?.engineName ||
    indicator?.kind === "builtin" ||
    indicator?.is_builtin === true ||
    (typeof indicator?.script === "string" && indicator.script.startsWith(ENGINE_SCRIPT_MARKER))
  );
}

function stripEngineMarker(script = "") {
  if (!script.startsWith(ENGINE_SCRIPT_MARKER)) return script;
  return script.split("\n").slice(1).join("\n").replace(/^\s*\n/, "");
}

function IndicatorBadge({ children, tone = "neutral" }) {
  const palette = {
    builtin: {
      background: "rgba(59, 130, 246, 0.15)",
      color: "#3b82f6",
    },
    custom: {
      background: "rgba(20, 184, 166, 0.14)",
      color: "#14b8a6",
    },
    main: {
      background: "rgba(34, 197, 94, 0.15)",
      color: "#22c55e",
    },
    sub: {
      background: "rgba(168, 85, 247, 0.15)",
      color: "#a855f7",
    },
    neutral: {
      background: "rgba(148, 163, 184, 0.15)",
      color: "#94a3b8",
    },
  };
  return (
    <span style={{
      fontSize: 9,
      marginLeft: 6,
      padding: "1px 5px",
      borderRadius: 3,
      background: palette[tone]?.background || palette.neutral.background,
      color: palette[tone]?.color || palette.neutral.color,
      fontWeight: 600,
      verticalAlign: "middle",
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function normalizeParamSchema(schema) {
  return Array.isArray(schema) ? schema.filter((item) => item && item.key) : [];
}

function getParamValue(params, schema) {
  if (params && Object.prototype.hasOwnProperty.call(params, schema.key)) {
    return params[schema.key];
  }
  return schema.default ?? "";
}

function parseParamValue(rawValue, type) {
  if (type === "int") return Number.parseInt(rawValue, 10) || 0;
  if (type === "float") return Number.parseFloat(rawValue) || 0;
  if (type === "bool") return Boolean(rawValue);
  return rawValue;
}

export default function IndicatorPanel({
  isOpen,
  onClose,
  activeIndicators,
  paramSchemas = {},
  onAddIndicator,
  onRemoveIndicator,
  onToggleVisibility,
  onUpdateParams,
  onUpdateScript,
  computing,
  onRecompute,
}) {
  const [tab, setTab] = useState("presets"); // "presets" | "active" | "editor"
  const {
    customIndicators,
    presets,
    presetsLoading,
    removeCustomIndicator,
    resolvePresetForChart,
    upsertCustomIndicator,
  } = useIndicatorCatalogRuntime({ isOpen });
  const [searchQuery, setSearchQuery] = useState("");
  const [editingIndicator, setEditingIndicator] = useState(null);

  const [panelWidth, setPanelWidth] = useState(400);
  const [isResizing, setIsResizing] = useState(false);

  const getSchemaForIndicator = useCallback((indicator) => {
    const liveSchema = normalizeParamSchema(paramSchemas[indicator.id]);
    if (liveSchema.length > 0) return liveSchema;
    return normalizeParamSchema(indicator.paramSchema);
  }, [paramSchemas]);

  const handleParamChange = useCallback((indicator, key, value, shouldRecompute = false) => {
    onUpdateParams(indicator.id, {
      ...(indicator.params || {}),
      [key]: value,
    });
    if (shouldRecompute) onRecompute?.(true);
  }, [onRecompute, onUpdateParams]);

  const renderParamControl = useCallback((indicator, schema) => {
    const type = schema.type || "string";
    const value = getParamValue(indicator.params || {}, schema);
    const common = {
      className: "indicator-param-input",
      title: schema.tooltip || "",
      onBlur: () => onRecompute?.(true),
    };

    if (type === "bool") {
      return (
        <input
          {...common}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => handleParamChange(indicator, schema.key, e.target.checked, true)}
        />
      );
    }

    const options = type === "source"
      ? (schema.options || SOURCE_OPTIONS)
      : schema.options;
    if (Array.isArray(options) && options.length > 0) {
      return (
        <select
          {...common}
          value={String(value)}
          onChange={(e) => {
            handleParamChange(indicator, schema.key, parseParamValue(e.target.value, type), true);
          }}
        >
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      );
    }

    return (
      <input
        {...common}
        type={type === "color" ? "color" : type === "int" || type === "float" ? "number" : "text"}
        value={value}
        min={schema.min}
        max={schema.max}
        step={schema.step ?? (type === "float" ? 0.1 : type === "int" ? 1 : undefined)}
        onChange={(e) => {
          handleParamChange(indicator, schema.key, parseParamValue(e.target.value, type));
        }}
      />
    );
  }, [handleParamChange, onRecompute]);

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

  const handleAddPreset = useCallback(async (preset) => {
    try {
      onAddIndicator(await resolvePresetForChart(preset));
      setTab("active");
    } catch (err) {
      console.error("Failed to add preset:", err);
    }
  }, [onAddIndicator, resolvePresetForChart]);

  const handleDeleteCustomPreset = useCallback(async (preset) => {
    if (isBuiltinIndicator(preset)) return;
    const confirmed = window.confirm(`删除自定义指标 "${preset.name}"？如果它已添加到图表，也会一并移除。`);
    if (!confirmed) return;

    try {
      await deleteCustomIndicator(preset.id);
      removeCustomIndicator(preset.id);
      if (activeIndicators.some((item) => item.id === preset.id)) {
        onRemoveIndicator(preset.id);
      }
    } catch (err) {
      console.error("Failed to delete custom indicator:", err);
      window.alert(`删除自定义指标失败：${err.message || err}`);
    }
  }, [activeIndicators, onRemoveIndicator, removeCustomIndicator]);

  const handleCreateCustom = useCallback(() => {
    setEditingIndicator({
      id: null,
      name: "My Indicator",
      script: `indicator("My Indicator", overlay=True)

length = input.int(20, "Length", minval=1)
src = input.source(close, "Source")
line_color = input.color(color.orange, "Color")

ma = ta.sma(src, length)
plot(ma, "MA", color=line_color)
`,
      params: {},
      description: "",
      securityMode: "safe",
      kind: "script",
      isPreset: false,
    });
    setTab("editor");
  }, []);

  const handleEditIndicator = useCallback((indicator) => {
    setEditingIndicator({ ...indicator });
    setTab("editor");
  }, []);

  const toCustomDraft = useCallback((updated) => ({
    ...updated,
    id: updated.id || `custom-${Date.now()}`,
    kind: "script",
    engineName: null,
    isPreset: false,
    is_builtin: false,
    category: updated.category || "custom",
    securityMode: updated.securityMode || "safe",
  }), []);

  const handleForkBuiltin = useCallback((indicator) => {
    const draft = toCustomDraft({
      ...indicator,
      id: null,
      name: `${indicator.name || "Builtin Indicator"} Custom`,
      script: stripEngineMarker(indicator.script || ""),
      params: indicator.params || {},
      description: indicator.description || "",
      paneTarget: indicator.paneTarget || indicator.renderHints?.paneTarget || "sub",
      securityMode: "safe",
    });
    setEditingIndicator(draft);
  }, [toCustomDraft]);

  const handleEditorPreview = useCallback((updated) => {
    const active = updated.id ? activeIndicators.find((i) => i.id === updated.id) : null;
    if (updated.id && active && !active.isPreset && !active.engineName) {
      onUpdateScript(updated.id, updated.script);
      if (updated.params) onUpdateParams(updated.id, updated.params);
      setEditingIndicator(prev => ({ ...prev, ...updated }));
    } else {
      const draft = toCustomDraft({ ...updated, id: null });
      onAddIndicator(draft);
      setEditingIndicator(prev => ({ ...prev, ...draft }));
    }
  }, [activeIndicators, onAddIndicator, onUpdateScript, onUpdateParams, toCustomDraft]);

  const handleEditorSave = useCallback(async (updated) => {
    const active = updated.id ? activeIndicators.find((i) => i.id === updated.id) : null;
    const shouldFork = !active || active.isPreset || active.engineName;
    const indicatorToSave = shouldFork ? toCustomDraft({ ...updated, id: null }) : toCustomDraft(updated);

    let saved = indicatorToSave;
    try {
      saved = await saveCustomIndicator({
        id: indicatorToSave.id,
        kind: "script",
        name: indicatorToSave.name,
        script: indicatorToSave.script,
        description: indicatorToSave.description || "",
        params: indicatorToSave.params || {},
        paramSchema: indicatorToSave.paramSchema || [],
        renderHints: { paneTarget: indicatorToSave.paneTarget || "sub" },
        securityMode: indicatorToSave.securityMode || "safe",
      });
      upsertCustomIndicator(saved, indicatorToSave);
    } catch (err) {
      console.error("Failed to save custom indicator:", err);
    }

    if (!shouldFork && activeIndicators.some((i) => i.id === saved.id)) {
      // Update existing — these already trigger pendingForceCompute in the indicators runtime
      onUpdateScript(saved.id, saved.script);
      if (saved.params) onUpdateParams(saved.id, saved.params);
    } else {
      // Add new — addIndicator already triggers pendingForceCompute
      onAddIndicator({
        ...saved,
        kind: "script",
        engineName: null,
        category: "custom",
        paneTarget: saved.renderHints?.paneTarget || indicatorToSave.paneTarget || "sub",
        securityMode: saved.securityMode || indicatorToSave.securityMode || "safe",
        isPreset: false,
      });
    }
    setEditingIndicator(null);
    setTab("active");
    // No need to manually call onRecompute — the state changes above
    // already set pendingForceComputeRef which triggers automatic recompute
  }, [activeIndicators, onAddIndicator, onUpdateScript, onUpdateParams, toCustomDraft, upsertCustomIndicator]);

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
  const allPresets = [...presets, ...customIndicators];
  const filteredPresets = allPresets.filter((p) => {
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
            key={`${editingIndicator.id || "new"}:${isBuiltinIndicator(editingIndicator) ? "builtin" : "script"}`}
            indicator={editingIndicator}
            onSave={handleEditorSave}
            onBack={handleEditorBack}
            onPreview={handleEditorPreview}
            onForkBuiltin={handleForkBuiltin}
            readOnly={isBuiltinIndicator(editingIndicator)}
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
                指标库
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
                                <IndicatorBadge tone={isBuiltinIndicator(preset) ? "builtin" : "custom"}>
                                  {isBuiltinIndicator(preset) ? "内置" : "自定义"}
                                </IndicatorBadge>
                                {preset.defaultEnabled && (
                                  <IndicatorBadge tone="neutral">默认</IndicatorBadge>
                                )}
                                <IndicatorBadge tone={preset.paneTarget === "main" ? "main" : "sub"}>
                                  {preset.paneTarget === "main" ? "主图" : "副图"}
                                </IndicatorBadge>
                              </span>
                              <span className="indicator-preset-desc">{preset.description}</span>
                            </div>
                            <div className="indicator-preset-actions">
                              <button
                                className={`indicator-add-btn ${isActive(preset.id) ? "added" : ""}`}
                                onClick={() => isActive(preset.id) ? onRemoveIndicator(preset.id) : handleAddPreset(preset)}
                                title={isActive(preset.id) ? "从图表移除" : "添加到图表"}
                              >
                                {isActive(preset.id) ? "✓" : "+"}
                              </button>
                              {!isBuiltinIndicator(preset) && (
                                <button
                                  className="indicator-preset-delete-btn"
                                  onClick={() => handleDeleteCustomPreset(preset)}
                                  title="永久删除自定义指标"
                                >
                                  🗑
                                </button>
                              )}
                            </div>
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
                          <span className="indicator-active-name">
                            {ind.name}
                            <IndicatorBadge tone={isBuiltinIndicator(ind) ? "builtin" : "custom"}>
                              {isBuiltinIndicator(ind) ? "内置" : "自定义"}
                            </IndicatorBadge>
                            <IndicatorBadge tone={ind.paneTarget === "main" ? "main" : "sub"}>
                              {ind.paneTarget === "main" ? "主图" : "副图"}
                            </IndicatorBadge>
                          </span>
                          {ind.error && (
                            <span className="indicator-error-badge" title={ind.error}>⚠️</span>
                          )}
                          <div className="indicator-active-actions">
                            <button
                              className="indicator-action-btn"
                              onClick={() => handleEditIndicator(ind)}
                              title={isBuiltinIndicator(ind) ? "查看参考实现" : "编辑代码"}
                            >
                              {isBuiltinIndicator(ind) ? "📖" : "✏️"}
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
                        {(getSchemaForIndicator(ind).length > 0 || (ind.params && Object.keys(ind.params).length > 0)) && (
                          <div className="indicator-params">
                            {(() => {
                              const schema = getSchemaForIndicator(ind);
                              if (schema.length > 0) {
                                return schema.map((item) => (
                                  <div key={item.key} className="indicator-param-row">
                                    <label className="indicator-param-label">
                                      {item.label || item.title || item.key}
                                    </label>
                                    {renderParamControl(ind, item)}
                                  </div>
                                ));
                              }

                              return Object.entries(ind.params || {}).map(([key, value]) => {
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
                              });
                            })()}
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
