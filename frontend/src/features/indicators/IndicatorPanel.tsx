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
  shouldShowIndicatorCatalogLoading,
  useIndicatorCatalogRuntime,
} from "./useIndicatorCatalogRuntime";
import IndicatorEditor from "./IndicatorEditor";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { CatalogIndicator } from "./useIndicatorCatalogRuntime.js";
import type {
  CustomIndicatorRecord,
  IndicatorDefinition,
  IndicatorParameterSchema,
  IndicatorParams,
} from "./indicatorTypes.js";
import type {
  IndicatorEditorSource,
  IndicatorEditorValue,
} from "./IndicatorEditor.js";

const CATEGORY_LABELS: Record<string, string> = {
  "趋势": "趋势",
  "震荡": "震荡",
  "波动": "波动率",
  "成交量": "成交量",
  "contract-data": "合约数据",
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

const CATEGORY_ICONS: Record<string, string> = {
  "趋势": "📈",
  "震荡": "⚡",
  "波动": "📊",
  "成交量": "📦",
  "contract-data": "⛓️",
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

const CATEGORY_GROUP_KEYS: Record<string, string> = {
  "趋势": "trend",
  "动量": "momentum",
  "震荡": "oscillator",
  "波动率": "volatility",
  "成交量": "volume",
  "合约数据": "contract-data",
  "自定义": "custom",
};

function categoryGroupKey(category: string | null | undefined, fallback: string): string {
  const raw = category || fallback;
  return CATEGORY_GROUP_KEYS[CATEGORY_LABELS[raw] || raw] || raw;
}

const SOURCE_OPTIONS = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"];
const ENGINE_SCRIPT_MARKER = "# __ENGINE__:";

type IndicatorPanelTab = "presets" | "active" | "editor";
type IndicatorBadgeTone = "builtin" | "custom" | "main" | "sub" | "neutral";
export type IndicatorPanelMarketStudyStatus =
  | "idle"
  | "loading"
  | "ready"
  | "dormant"
  | "error";

export interface IndicatorPanelMarketStudy {
  id: string;
  name: string;
  description?: string;
  category?: string;
  added: boolean;
  visible: boolean;
  supported: boolean;
  unsupportedReason?: string | null;
  status?: IndicatorPanelMarketStudyStatus;
  statusText?: string | null;
  error?: string | null;
}

type UiParamSchema = IndicatorParameterSchema & {
  key: string;
  title?: string;
  tooltip?: string;
};

interface IndicatorBadgeProps {
  children: ReactNode;
  tone?: IndicatorBadgeTone;
}

interface CustomIndicatorDraft extends IndicatorDefinition {
  id: string;
  name: string;
  script: string;
  params: IndicatorParams;
  securityMode?: string;
  kind: "script";
}

export interface IndicatorPanelProps {
  allowedScriptLanguages?: readonly string[];
  allowedSecurityModes?: readonly string[];
  isOpen: boolean;
  onClose(): void;
  activeIndicators: IndicatorDefinition[];
  paramSchemas?: Record<string, IndicatorParameterSchema[]>;
  onAddIndicator(indicator: IndicatorDefinition): void;
  onRemoveIndicator(indicatorId: string): void;
  onToggleVisibility(indicatorId: string): void;
  onUpdateParams(indicatorId: string, params: IndicatorParams): void;
  onUpdateScript(
    indicatorId: string,
    script: string,
    language?: string,
    securityMode?: string,
  ): void;
  computing: boolean;
  realtimeMode?: "enabled" | "degraded" | "historical-only";
  onRecompute?: (force?: boolean) => void;
  marketStudies?: readonly IndicatorPanelMarketStudy[];
  onAddMarketStudy?: (studyId: string) => void;
  onRemoveMarketStudy?: (studyId: string) => void;
  onToggleMarketStudyVisibility?: (studyId: string) => void;
  modeNotice?: {
    label: string;
    description: string;
  } | null;
  resolveIndicatorSupport?: (
    indicator: IndicatorDefinition,
  ) => {
    supported: boolean;
    reason: string | null;
  };
}

type IndicatorBuiltinLike = Partial<Pick<
  IndicatorDefinition,
  "engineName" | "kind" | "is_builtin" | "script"
>>;

function isBuiltinIndicator(indicator: IndicatorBuiltinLike | null | undefined): boolean {
  return Boolean(
    indicator?.engineName ||
    indicator?.kind === "builtin" ||
    indicator?.is_builtin === true ||
    (typeof indicator?.script === "string" && indicator.script.startsWith(ENGINE_SCRIPT_MARKER))
  );
}

function stripEngineMarker(script = ""): string {
  if (!script.startsWith(ENGINE_SCRIPT_MARKER)) return script;
  return script.split("\n").slice(1).join("\n").replace(/^\s*\n/, "");
}

function IndicatorBadge({ children, tone = "neutral" }: IndicatorBadgeProps) {
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

function normalizeParamSchema(schema: IndicatorParameterSchema[] | null | undefined): UiParamSchema[] {
  return Array.isArray(schema)
    ? schema.filter((item): item is UiParamSchema => Boolean(item && item.key))
    : [];
}

function getParamValue(params: IndicatorParams, schema: UiParamSchema): unknown {
  if (params && Object.prototype.hasOwnProperty.call(params, schema.key)) {
    return params[schema.key];
  }
  return schema.default ?? "";
}

function parseParamValue(rawValue: string | boolean, type: string): unknown {
  if (type === "int") return Number.parseInt(String(rawValue), 10) || 0;
  if (type === "float") return Number.parseFloat(String(rawValue)) || 0;
  if (type === "bool") return Boolean(rawValue);
  return rawValue;
}

function renderInputValue(value: unknown): string | number {
  return typeof value === "string" || typeof value === "number"
    ? value
    : String(value ?? "");
}

function renderHintPaneTarget(renderHints: Record<string, unknown> | undefined): string | null {
  return typeof renderHints?.paneTarget === "string" ? renderHints.paneTarget : null;
}

function marketStudyStatusLabel(study: IndicatorPanelMarketStudy): string | null {
  if (!study.supported || study.status === "dormant") return "休眠";
  if (study.error || study.status === "error") return "错误";
  if (study.status === "loading") return "加载中";
  return null;
}

function marketStudyStatusMessage(study: IndicatorPanelMarketStudy): string | null {
  if (!study.supported) return study.unsupportedReason || "当前品种不支持";
  if (study.error) return study.error;
  return study.statusText || null;
}

function marketStudyMatchesSearch(
  study: IndicatorPanelMarketStudy,
  searchQuery: string,
): boolean {
  if (!searchQuery) return true;
  const query = searchQuery.toLowerCase();
  return [
    study.name,
    study.id,
    study.description,
    study.category,
    CATEGORY_LABELS[study.category || "contract-data"],
    study.unsupportedReason,
    study.statusText,
  ].some((value) => String(value || "").toLowerCase().includes(query));
}

export default function IndicatorPanel({
  allowedScriptLanguages,
  allowedSecurityModes,
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
  realtimeMode = "enabled",
  onRecompute,
  marketStudies = [],
  onAddMarketStudy,
  onRemoveMarketStudy,
  onToggleMarketStudyVisibility,
  modeNotice = null,
  resolveIndicatorSupport,
}: IndicatorPanelProps) {
  const [tab, setTab] = useState<IndicatorPanelTab>("presets");
  const {
    customIndicators,
    deleteCustomIndicator,
    presets,
    presetsLoading,
    resolvePresetForChart,
    saveCustomIndicator,
  } = useIndicatorCatalogRuntime({ isOpen });
  const [searchQuery, setSearchQuery] = useState("");
  const [editingIndicator, setEditingIndicator] = useState<IndicatorEditorSource | null>(null);
  const activeMarketStudies = marketStudies.filter((study) => study.added);
  const activeItemCount = activeIndicators.length + activeMarketStudies.length;

  const [panelWidth, setPanelWidth] = useState(400);
  const [isResizing, setIsResizing] = useState(false);

  const getSchemaForIndicator = useCallback((indicator: IndicatorDefinition): UiParamSchema[] => {
    const liveSchema = normalizeParamSchema(paramSchemas[indicator.id]);
    if (liveSchema.length > 0) return liveSchema;
    return normalizeParamSchema(indicator.paramSchema);
  }, [paramSchemas]);

  const handleParamChange = useCallback((
    indicator: IndicatorDefinition,
    key: string,
    value: unknown,
    shouldRecompute = false,
  ) => {
    onUpdateParams(indicator.id, {
      ...(indicator.params || {}),
      [key]: value,
    });
    if (shouldRecompute) onRecompute?.(true);
  }, [onRecompute, onUpdateParams]);

  const renderParamControl = useCallback((indicator: IndicatorDefinition, schema: UiParamSchema) => {
    const type = schema.type || "string";
    const value = getParamValue(indicator.params || {}, schema);
    const common = {
      className: "indicator-param-input",
      title: schema.tooltip || "",
    };

    if (type === "bool") {
      return (
        <input
          {...common}
          type="checkbox"
          checked={Boolean(value)}
          onBlur={() => onRecompute?.(true)}
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
          onBlur={() => onRecompute?.(true)}
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
        value={renderInputValue(value)}
        onBlur={() => onRecompute?.(true)}
        min={schema.min}
        max={schema.max}
        step={schema.step ?? (type === "float" ? 0.1 : type === "int" ? 1 : undefined)}
        onChange={(e) => {
          handleParamChange(indicator, schema.key, parseParamValue(e.target.value, type));
        }}
      />
    );
  }, [handleParamChange, onRecompute]);

  const startResizing = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    setIsResizing(true);
    e.preventDefault();
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback((e: MouseEvent) => {
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

  const handleAddPreset = useCallback(async (preset: CatalogIndicator) => {
    try {
      const resolved = await resolvePresetForChart(preset);
      if (resolveIndicatorSupport?.(resolved).supported === false) return;
      onAddIndicator(resolved);
    } catch (err) {
      console.error("Failed to add preset:", err);
    }
  }, [onAddIndicator, resolveIndicatorSupport, resolvePresetForChart]);

  const handleDeleteCustomPreset = useCallback(async (preset: CatalogIndicator) => {
    if (isBuiltinIndicator(preset)) return;
    const confirmed = window.confirm(`删除自定义指标 "${preset.name}"？如果它已添加到图表，也会一并移除。`);
    if (!confirmed) return;

    try {
      await deleteCustomIndicator(preset.id);
      if (activeIndicators.some((item) => item.id === preset.id)) {
        onRemoveIndicator(preset.id);
      }
    } catch (err: unknown) {
      console.error("Failed to delete custom indicator:", err);
      window.alert(`删除自定义指标失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeIndicators, deleteCustomIndicator, onRemoveIndicator]);

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

  const handleEditIndicator = useCallback((indicator: IndicatorDefinition) => {
    setEditingIndicator({ ...indicator });
    setTab("editor");
  }, []);

  const toCustomDraft = useCallback((updated: IndicatorEditorSource): CustomIndicatorDraft => ({
    ...updated,
    id: updated.id || `custom-${Date.now()}`,
    name: updated.name || "My Indicator",
    script: updated.script || "",
    params: updated.params || {},
    kind: "script",
    engineName: null,
    isPreset: false,
    is_builtin: false,
    category: updated.category || "custom",
  }), []);

  const handleForkBuiltin = useCallback((indicator: IndicatorEditorValue) => {
    const draft = toCustomDraft({
      ...indicator,
      id: null,
      name: `${indicator.name || "Builtin Indicator"} Custom`,
      script: stripEngineMarker(indicator.script || ""),
      params: indicator.params || {},
      description: indicator.description || "",
      paneTarget: indicator.paneTarget || renderHintPaneTarget(indicator.renderHints) || "sub",
      securityMode: "safe",
    });
    setEditingIndicator(draft);
  }, [toCustomDraft]);

  const handleEditorPreview = useCallback((updated: IndicatorEditorValue) => {
    const active = updated.id ? activeIndicators.find((i) => i.id === updated.id) : null;
    if (updated.id && active && !active.isPreset && !active.engineName) {
      onUpdateScript(
        updated.id,
        updated.script,
        updated.language,
        updated.securityMode,
      );
      if (updated.params) onUpdateParams(updated.id, updated.params);
      setEditingIndicator((prev) => prev ? { ...prev, ...updated } : updated);
    } else {
      const draft = toCustomDraft({ ...updated, id: null });
      onAddIndicator(draft);
      setEditingIndicator((prev) => prev ? { ...prev, ...draft } : draft);
    }
  }, [activeIndicators, onAddIndicator, onUpdateScript, onUpdateParams, toCustomDraft]);

  const handleEditorSave = useCallback(async (updated: IndicatorEditorValue) => {
    const active = updated.id ? activeIndicators.find((i) => i.id === updated.id) : null;
    const shouldFork = !active || active.isPreset || active.engineName;
    const indicatorToSave = shouldFork ? toCustomDraft({ ...updated, id: null }) : toCustomDraft(updated);

    let saved = indicatorToSave;
    try {
      const persisted = await saveCustomIndicator({
        id: indicatorToSave.id,
        kind: "script",
        ...(indicatorToSave.language ? { language: indicatorToSave.language } : {}),
        name: indicatorToSave.name,
        script: indicatorToSave.script,
        description: indicatorToSave.description || "",
        params: indicatorToSave.params || {},
        paramSchema: indicatorToSave.paramSchema || [],
        renderHints: { paneTarget: indicatorToSave.paneTarget || "sub" },
        ...(indicatorToSave.securityMode
          ? { securityMode: indicatorToSave.securityMode }
          : {}),
      });
      const {
        securityMode: persistedSecurityModeValue,
        ...persistedFields
      }: CustomIndicatorRecord = persisted;
      const persistedLanguage = persisted.language || indicatorToSave.language;
      const persistedSecurityMode = persistedSecurityModeValue || indicatorToSave.securityMode;
      saved = toCustomDraft({
        ...persistedFields,
        ...(persistedLanguage ? { language: persistedLanguage } : {}),
        ...(persistedSecurityMode ? { securityMode: persistedSecurityMode } : {}),
      });
    } catch (err) {
      console.error("Failed to save custom indicator:", err);
    }

    if (!shouldFork && activeIndicators.some((i) => i.id === saved.id)) {
      // Update existing — these already trigger pendingForceCompute in the indicators runtime
      onUpdateScript(
        saved.id,
        saved.script,
        saved.language,
        saved.securityMode || indicatorToSave.securityMode,
      );
      if (saved.params) onUpdateParams(saved.id, saved.params);
    } else {
      // Add new — addIndicator already triggers pendingForceCompute
      const savedLanguage = saved.language || indicatorToSave.language;
      const savedSecurityMode = saved.securityMode || indicatorToSave.securityMode;
      onAddIndicator({
        ...saved,
        kind: "script",
        engineName: null,
        category: "custom",
        paneTarget: renderHintPaneTarget(saved.renderHints) || indicatorToSave.paneTarget || "sub",
        ...(savedLanguage ? { language: savedLanguage } : {}),
        ...(savedSecurityMode ? { securityMode: savedSecurityMode } : {}),
        isPreset: false,
      });
    }
    setEditingIndicator(null);
    setTab("active");
    // No need to manually call onRecompute — the state changes above
    // already set pendingForceComputeRef which triggers automatic recompute
  }, [activeIndicators, onAddIndicator, onUpdateScript, onUpdateParams, saveCustomIndicator, toCustomDraft]);

  const handleEditorBack = useCallback(() => {
    setEditingIndicator(null);
    setTab(activeItemCount > 0 ? "active" : "presets");
  }, [activeItemCount]);

  // Calculate previewState
  const previewedActiveIndicator = editingIndicator?.id ? activeIndicators.find(i => i.id === editingIndicator.id) : null;
  const previewState = editingIndicator ? {
    id: previewedActiveIndicator?.id || null,
    error: previewedActiveIndicator?.error || null,
    visible: previewedActiveIndicator ? previewedActiveIndicator.visible !== false : true,
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
  const filteredMarketStudies = marketStudies.filter((study) => (
    marketStudyMatchesSearch(study, searchQuery)
  ));
  const catalogLoading = shouldShowIndicatorCatalogLoading(
    presetsLoading,
    presets,
    customIndicators,
  );

  // Group presets by category
  const groupedPresets: Record<string, CatalogIndicator[]> = {};
  for (const p of filteredPresets) {
    const cat = categoryGroupKey(p.category, "custom");
    if (!groupedPresets[cat]) groupedPresets[cat] = [];
    groupedPresets[cat].push(p);
  }
  const groupedMarketStudies: Record<string, IndicatorPanelMarketStudy[]> = {};
  for (const study of filteredMarketStudies) {
    const cat = categoryGroupKey(study.category, "contract-data");
    if (!groupedMarketStudies[cat]) groupedMarketStudies[cat] = [];
    groupedMarketStudies[cat].push(study);
  }
  const groupedCategoryOrder = Array.from(new Set([
    ...(catalogLoading ? [] : Object.keys(groupedPresets)),
    ...Object.keys(groupedMarketStudies),
  ]));

  const isActive = (presetId: string): boolean => activeIndicators.some((i) => i.id === presetId);

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
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent-blue)'; }}
          onMouseLeave={(e) => { if (!isResizing) e.currentTarget.style.backgroundColor = 'transparent'; }}
        />

        {tab === "editor" && editingIndicator ? (
          <IndicatorEditor
            {...(allowedScriptLanguages === undefined
              ? {}
              : { allowedScriptLanguages })}
            {...(allowedSecurityModes === undefined
              ? {}
              : { allowedSecurityModes })}
            key={`${editingIndicator.id || "new"}:${isBuiltinIndicator(editingIndicator) ? "builtin" : editingIndicator.language || "descriptor-default"}`}
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
                {realtimeMode === "historical-only" && (
                  <span
                    className="indicator-computing-badge"
                    title="指标实时订阅已停用；当前通过 HTTP 补齐已收盘 K 线的指标值。"
                  >
                    仅已收盘值
                  </span>
                )}
                {realtimeMode === "degraded" && (
                  <span
                    className="indicator-computing-badge"
                    title="至少一个指标的实时订阅不可用；受影响指标通过 HTTP 补齐已收盘值。"
                  >
                    部分仅已收盘值
                  </span>
                )}
                {modeNotice && (
                  <span
                    className="indicator-computing-badge"
                    title={modeNotice.description}
                  >
                    {modeNotice.label}
                  </span>
                )}
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
                已添加 {activeItemCount > 0 && `(${activeItemCount})`}
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

                  {catalogLoading && (
                    <div className="indicator-loading">加载中...</div>
                  )}

                  {groupedCategoryOrder.map((cat) => {
                    const items = groupedPresets[cat] || [];
                    const studies = groupedMarketStudies[cat] || [];
                    return (
                      <div key={cat} className="indicator-category-group">
                        <div className="indicator-category-label">
                          <span>{CATEGORY_ICONS[cat] || "📌"}</span>
                          <span>{CATEGORY_LABELS[cat] || cat}</span>
                        </div>
                        {items.map((preset) => {
                          const support = resolveIndicatorSupport?.(preset) ?? {
                            supported: true,
                            reason: null,
                          };
                          const addDisabled = !isActive(preset.id) && !support.supported;
                          return (
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
                                {("defaultEnabled" in preset && preset.defaultEnabled) && (
                                  <IndicatorBadge tone="neutral">默认</IndicatorBadge>
                                )}
                                <IndicatorBadge tone={preset.paneTarget === "main" ? "main" : "sub"}>
                                  {preset.paneTarget === "main" ? "主图" : "副图"}
                                </IndicatorBadge>
                                {!support.supported && (
                                  <IndicatorBadge tone="neutral">回放不可用</IndicatorBadge>
                                )}
                              </span>
                              <span className="indicator-preset-desc">
                                {preset.description}
                                {!support.supported && support.reason && (
                                  <span style={{ display: "block", color: "#f59e0b", marginTop: 3 }}>
                                    {support.reason}
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="indicator-preset-actions">
                              <button
                                className={`indicator-add-btn ${isActive(preset.id) ? "added" : ""}`}
                                onClick={() => isActive(preset.id) ? onRemoveIndicator(preset.id) : handleAddPreset(preset)}
                                disabled={addDisabled}
                                title={isActive(preset.id)
                                  ? "从图表移除"
                                  : support.reason || "添加到图表"}
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
                          );
                        })}
                        {studies.map((study) => {
                          const callback = study.added ? onRemoveMarketStudy : onAddMarketStudy;
                          const disabled = !study.supported || !callback;
                          const disabledReason = study.supported
                            ? "操作暂不可用"
                            : study.unsupportedReason || "当前品种不支持";
                          return (
                            <div
                              key={study.id}
                              className={`indicator-preset-item ${study.added ? "is-active" : ""}`}
                            >
                              <div className="indicator-preset-info">
                                <span className="indicator-preset-name">
                                  {study.name}
                                  <IndicatorBadge tone="neutral">market-data</IndicatorBadge>
                                  <IndicatorBadge tone="sub">副图</IndicatorBadge>
                                  {!study.supported && (
                                    <IndicatorBadge tone="neutral">不可用</IndicatorBadge>
                                  )}
                                </span>
                                <span className="indicator-preset-desc">
                                  {study.description}
                                  {!study.supported && (
                                    <span style={{ display: "block", color: "#f59e0b", marginTop: 3 }}>
                                      {disabledReason}
                                    </span>
                                  )}
                                </span>
                              </div>
                              <div className="indicator-preset-actions">
                                <button
                                  className={`indicator-add-btn ${study.added ? "added" : ""}`}
                                  onClick={() => callback?.(study.id)}
                                  disabled={disabled}
                                  title={disabled
                                    ? disabledReason
                                    : study.added ? "从图表移除" : "添加到图表"}
                                  style={disabled ? { cursor: "not-allowed", opacity: 0.45 } : undefined}
                                >
                                  {study.added ? "✓" : "+"}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}

                  {!catalogLoading
                    && filteredPresets.length === 0
                    && filteredMarketStudies.length === 0 && (
                    <div className="indicator-empty">未找到匹配的指标</div>
                  )}
                </div>
              )}

              {/* ── Active tab ── */}
              {tab === "active" && (
                <div className="indicator-active-list">
                  {activeItemCount === 0 ? (
                    <div className="indicator-empty">
                      <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                      <div>暂未添加指标</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                        从指标库选择或创建自定义指标
                      </div>
                    </div>
                  ) : (
                    <>
                      {activeIndicators.map((ind) => (
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
                                      value={renderInputValue(value)}
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
                      ))}

                      {activeMarketStudies.map((study) => {
                        const statusLabel = marketStudyStatusLabel(study);
                        const statusMessage = marketStudyStatusMessage(study);
                        const hasError = study.supported
                          && Boolean(study.error || study.status === "error");
                        return (
                          <div key={study.id} className="indicator-active-item">
                            <div className="indicator-active-header">
                              <button
                                className={`indicator-visibility-btn ${study.visible ? "" : "hidden"}`}
                                onClick={() => onToggleMarketStudyVisibility?.(study.id)}
                                disabled={!onToggleMarketStudyVisibility}
                                title={study.visible ? "隐藏" : "显示"}
                              >
                                {study.visible ? "👁" : "👁‍🗨"}
                              </button>
                              <span className="indicator-active-name">
                                {study.name}
                                <IndicatorBadge tone="neutral">market-data</IndicatorBadge>
                                <IndicatorBadge tone="sub">副图</IndicatorBadge>
                                {statusLabel && (
                                  <IndicatorBadge tone="neutral">{statusLabel}</IndicatorBadge>
                                )}
                              </span>
                              {hasError && (
                                <span className="indicator-error-badge" title={statusMessage || "市场指标错误"}>
                                  ⚠️
                                </span>
                              )}
                              <div className="indicator-active-actions">
                                <button
                                  className="indicator-action-btn indicator-remove-btn"
                                  onClick={() => onRemoveMarketStudy?.(study.id)}
                                  disabled={!onRemoveMarketStudy}
                                  title="移除"
                                >
                                  🗑
                                </button>
                              </div>
                            </div>

                            {statusMessage && (
                              <div
                                className={hasError ? "indicator-error-msg" : undefined}
                                style={hasError ? undefined : {
                                  color: "var(--text-muted)",
                                  fontSize: 11,
                                  margin: "4px 10px 8px 38px",
                                }}
                              >
                                {statusMessage}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
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
