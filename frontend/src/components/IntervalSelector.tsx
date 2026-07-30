import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canResolveIntervalFromNativeValues,
  canonicalizeIntervalValue,
  formatIntervalDescription,
  formatSecondsCompact,
  getIntervalGroupLabelZh,
  groupIntervalsByDuration,
  INTERVAL_UNITS,
  intervalSemanticSignature,
  intervalsSemanticallyEquivalent,
  parseIntervalSeconds,
} from "../utils/intervals";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type {
  IntervalUnit,
  IntervalString,
} from "../utils/intervals.js";
import type {
  AvailableInterval,
  CreateCustomIntervalResult,
  CustomIntervalRecord,
  GroupedAvailableIntervals,
  IntervalNotice,
  NativeInterval,
} from "../features/chart-session/chartSessionTypes.js";
import { getEffectiveCustomIntervalRecords } from "../features/chart-session/intervalPolicy.js";

type IntervalTab = "common" | "custom" | "all";
type IntervalStatusKind = "invalid" | "native" | "exists" | "new";

interface IntervalStatus {
  ok: boolean;
  kind: IntervalStatusKind;
  text: string;
}

interface IntervalItem extends AvailableInterval {
  record?: CustomIntervalRecord;
}

interface InlineMessage {
  type: "success" | "error";
  text: string;
}

const QUICK_PRESETS = ["7m", "45m", "90m", "2h", "3d", "2w"];
const TAB_OPTIONS: Array<{ key: IntervalTab; label: string }> = [
  { key: "common", label: "常用" },
  { key: "custom", label: "自定义" },
  { key: "all", label: "全部" },
];
const MAX_TOOLBAR_CUSTOMS = 4;

function clsx(...items: Array<string | false | null | undefined>): string {
  return items.filter(Boolean).join(" ");
}

function sortCustomRecords(records: CustomIntervalRecord[]): CustomIntervalRecord[] {
  return [...records].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if ((b.lastUsedAt || 0) !== (a.lastUsedAt || 0)) return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    const secondsA = parseIntervalSeconds(a.value) || 0;
    const secondsB = parseIntervalSeconds(b.value) || 0;
    return secondsA - secondsB || a.value.localeCompare(b.value);
  });
}

function buildToolbarCustomRecords(
  records: CustomIntervalRecord[],
  activeInterval: IntervalString,
): CustomIntervalRecord[] {
  const sorted = sortCustomRecords(records);
  const active = sorted.find((record) => intervalsSemanticallyEquivalent(record.value, activeInterval));
  const preferred = [
    ...(active ? [active] : []),
    ...sorted.filter((record) => record.pinned && !intervalsSemanticallyEquivalent(record.value, activeInterval)),
    ...sorted.filter((record) => !record.pinned && !intervalsSemanticallyEquivalent(record.value, activeInterval)),
  ];

  const seen = new Set<string>();
  return preferred.filter((record) => {
    const signature = intervalSemanticSignature(record.value);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  }).slice(0, MAX_TOOLBAR_CUSTOMS);
}

function buildItemFromRecord(record: CustomIntervalRecord): IntervalItem {
  const seconds = parseIntervalSeconds(record.value) || 0;
  return {
    value: record.value,
    label: record.value,
    seconds,
    isCustom: true,
    record,
  };
}

function matchesSearch(item: IntervalItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    item.value.toLowerCase().includes(q) ||
    String(item.label || item.value).toLowerCase().includes(q) ||
    formatIntervalDescription(item.value).toLowerCase().includes(q)
  );
}

function createStatusForValue(
  value: unknown,
  nativeValueSet: Set<string>,
  customValueSet: Set<string>,
  nativeValues: readonly IntervalString[],
  capabilityReady: boolean,
  capabilityLoading: boolean,
  intervalAvailability?: (value: IntervalString) => boolean,
  unavailableIntervalMessage?: (value: IntervalString) => string,
): IntervalStatus {
  const normalized = canonicalizeIntervalValue(value);
  const seconds = parseIntervalSeconds(normalized);
  const signature = intervalSemanticSignature(normalized);
  if (!normalized || !seconds) {
    return { ok: false, kind: "invalid", text: "请输入大于 0 的数字，并选择 s/m/h/d/w/M 单位。" };
  }
  if (capabilityLoading) {
    return { ok: false, kind: "invalid", text: "交易所周期能力正在加载，请稍候。" };
  }
  if (!capabilityReady) {
    return { ok: false, kind: "invalid", text: "当前交易所没有可用的历史 K 线能力。" };
  }
  const available = intervalAvailability
    ? intervalAvailability(normalized)
    : canResolveIntervalFromNativeValues(normalized, nativeValues);
  if (!available) {
    return {
      ok: false,
      kind: "invalid",
      text: unavailableIntervalMessage?.(normalized)
        ?? "当前市场没有可精确拼接该周期的历史 K 线基准周期。",
    };
  }
  if (nativeValueSet.has(signature)) {
    return { ok: false, kind: "native", text: "这是交易所原生周期，可直接选择。" };
  }
  if (customValueSet.has(signature)) {
    return { ok: false, kind: "exists", text: "该自定义周期已添加，可直接选择。" };
  }
  return { ok: true, kind: "new", text: `将添加 ${formatIntervalDescription(normalized)} 自定义周期。` };
}

export interface IntervalSelectorProps {
  interval: IntervalString;
  capabilityReady: boolean;
  capabilityLoading: boolean;
  nativeIntervals: NativeInterval[];
  intervalGroups: GroupedAvailableIntervals;
  customIntervalRecords: CustomIntervalRecord[];
  savedCustomIntervals: IntervalString[];
  onSelectInterval(interval: IntervalString): void;
  onCreateCustomInterval(interval: IntervalString): CreateCustomIntervalResult;
  onRemoveCustomInterval(interval: IntervalString): void;
  onRestoreCustomInterval(): void;
  onTogglePinCustomInterval(interval: IntervalString): unknown;
  onClearCustomIntervals(): void;
  intervalNotice: IntervalNotice | null;
  readOnlyReason?: string | null;
  intervalAvailability?: (interval: IntervalString) => boolean;
  unavailableIntervalMessage?: (interval: IntervalString) => string;
}

function IntervalSelector({
  interval,
  capabilityReady,
  capabilityLoading,
  nativeIntervals,
  intervalGroups,
  customIntervalRecords,
  savedCustomIntervals,
  onSelectInterval,
  onCreateCustomInterval,
  onRemoveCustomInterval,
  onRestoreCustomInterval,
  onTogglePinCustomInterval,
  onClearCustomIntervals,
  intervalNotice,
  readOnlyReason = null,
  intervalAvailability,
  unavailableIntervalMessage: unavailableIntervalMessageOverride,
}: IntervalSelectorProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<IntervalTab>("common");
  const [search, setSearch] = useState("");
  const [amount, setAmount] = useState("45");
  const [unit, setUnit] = useState<IntervalUnit>("m");
  const [inlineMessage, setInlineMessage] = useState<InlineMessage | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const nativeValueSet = useMemo(
    () => new Set(nativeIntervals.map((item) => intervalSemanticSignature(item.value))),
    [nativeIntervals],
  );
  const customValueSet = useMemo(
    () => new Set(savedCustomIntervals.map(intervalSemanticSignature)),
    [savedCustomIntervals],
  );
  const nativeValues = useMemo(
    () => nativeIntervals.map((item) => item.value),
    [nativeIntervals],
  );
  const effectiveCustomRecords = useMemo(
    () => getEffectiveCustomIntervalRecords(customIntervalRecords, nativeIntervals),
    [customIntervalRecords, nativeIntervals],
  );
  const nativeGroups = useMemo(
    () => groupIntervalsByDuration(nativeIntervals.map((item) => ({ ...item, isCustom: false }))),
    [nativeIntervals],
  );
  const toolbarCustomRecords = useMemo(
    () => buildToolbarCustomRecords(effectiveCustomRecords, interval),
    [effectiveCustomRecords, interval],
  );
  const toolbarCustomGroups = useMemo(
    () => groupIntervalsByDuration(toolbarCustomRecords.map(buildItemFromRecord)),
    [toolbarCustomRecords],
  );
  const sortedCustomRecords = useMemo(
    () => sortCustomRecords(effectiveCustomRecords),
    [effectiveCustomRecords],
  );
  const allItems = useMemo(
    () => intervalGroups.flatMap((group) => group.items),
    [intervalGroups],
  );

  const normalizedSearch = canonicalizeIntervalValue(search);
  const searchCreateStatus = useMemo(
    () => createStatusForValue(
      search,
      nativeValueSet,
      customValueSet,
      nativeValues,
      capabilityReady,
      capabilityLoading,
      intervalAvailability,
      unavailableIntervalMessageOverride,
    ),
    [
      capabilityLoading,
      capabilityReady,
      customValueSet,
      intervalAvailability,
      nativeValueSet,
      nativeValues,
      search,
      unavailableIntervalMessageOverride,
    ],
  );

  const formValue = useMemo(() => {
    const numeric = parseInt(amount, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) return "";
    return `${numeric}${unit}`;
  }, [amount, unit]);
  const formStatus = useMemo(
    () => createStatusForValue(
      formValue,
      nativeValueSet,
      customValueSet,
      nativeValues,
      capabilityReady,
      capabilityLoading,
      intervalAvailability,
      unavailableIntervalMessageOverride,
    ),
    [
      capabilityLoading,
      capabilityReady,
      customValueSet,
      formValue,
      intervalAvailability,
      nativeValueSet,
      nativeValues,
      unavailableIntervalMessageOverride,
    ],
  );

  const isIntervalAvailable = useCallback((value: IntervalString): boolean => (
    capabilityReady && (
      intervalAvailability
        ? intervalAvailability(value)
        : canResolveIntervalFromNativeValues(value, nativeValues)
    )
  ), [capabilityReady, intervalAvailability, nativeValues]);

  const unavailableMessage = useCallback((value: IntervalString): string => (
    capabilityLoading
      ? "交易所周期能力正在加载，请稍候。"
      : capabilityReady
        ? unavailableIntervalMessageOverride?.(value)
          ?? `当前市场没有可精确拼接 ${value} 的历史 K 线基准周期。`
        : "当前交易所没有可用的历史 K 线能力。"
  ), [capabilityLoading, capabilityReady, unavailableIntervalMessageOverride]);

  const visibleItems = useMemo(() => {
    if (activeTab === "custom") {
      return sortedCustomRecords.map(buildItemFromRecord).filter((item) => matchesSearch(item, search));
    }
    if (activeTab === "all") {
      return allItems.filter((item) => matchesSearch(item, search));
    }
    const common = [
      ...toolbarCustomRecords.map(buildItemFromRecord),
      ...nativeIntervals
        .filter((item) => ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"].includes(item.value))
        .map((item) => ({ ...item, isCustom: false })),
    ];
    const seen = new Set();
    return common
      .filter((item) => {
        const signature = intervalSemanticSignature(item.value);
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
      })
      .filter((item) => matchesSearch(item, search))
      .sort((a, b) => a.seconds - b.seconds);
  }, [activeTab, allItems, nativeIntervals, search, sortedCustomRecords, toolbarCustomRecords]);

  const visibleGroups = useMemo(
    () => groupIntervalsByDuration(visibleItems),
    [visibleItems],
  );
  const visibleItemsInRenderOrder = useMemo(
    () => visibleGroups.flatMap((group) => group.items),
    [visibleGroups],
  );
  const clampedHighlightIndex = visibleItemsInRenderOrder.length > 0
    ? Math.min(highlightIndex, visibleItemsInRenderOrder.length - 1)
    : 0;
  const visibleAvailableCount = useMemo(
    () => visibleItemsInRenderOrder.filter((item) => isIntervalAvailable(item.value)).length,
    [isIntervalAvailable, visibleItemsInRenderOrder],
  );

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => searchInputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const selectInterval = useCallback((value: IntervalString) => {
    const normalized = canonicalizeIntervalValue(value) || value;
    if (!isIntervalAvailable(normalized)) {
      setInlineMessage({ type: "error", text: unavailableMessage(normalized) });
      setOpen(true);
      return;
    }
    onSelectInterval(normalized);
    setOpen(false);
    setSearch("");
    setInlineMessage(null);
  }, [isIntervalAvailable, onSelectInterval, unavailableMessage]);

  const createOrSelectInterval = useCallback((value: IntervalString) => {
    const normalized = canonicalizeIntervalValue(value);
    const status = createStatusForValue(
      normalized,
      nativeValueSet,
      customValueSet,
      nativeValues,
      capabilityReady,
      capabilityLoading,
      intervalAvailability,
      unavailableIntervalMessageOverride,
    );
    if (status.kind === "native" || status.kind === "exists") {
      selectInterval(normalized);
      return;
    }
    if (!status.ok) {
      setInlineMessage({ type: "error", text: status.text });
      return;
    }

    const result = onCreateCustomInterval(normalized);
    if (result?.ok === false) {
      setInlineMessage({ type: "error", text: result.message || "添加失败" });
      return;
    }
    setInlineMessage({ type: "success", text: `${normalized} 已添加并切换` });
    setOpen(false);
    setSearch("");
  }, [
    capabilityLoading,
    capabilityReady,
    customValueSet,
    intervalAvailability,
    nativeValueSet,
    nativeValues,
    onCreateCustomInterval,
    selectInterval,
    unavailableIntervalMessageOverride,
  ]);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, Math.max(visibleItemsInRenderOrder.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const highlighted = visibleItemsInRenderOrder[clampedHighlightIndex];
      if (highlighted) {
        selectInterval(highlighted.value);
        return;
      }
      if (normalizedSearch) createOrSelectInterval(normalizedSearch);
    }
  }, [clampedHighlightIndex, createOrSelectInterval, normalizedSearch, selectInterval, visibleItemsInRenderOrder]);

  const handleRemove = useCallback((value: IntervalString) => {
    onRemoveCustomInterval(value);
  }, [onRemoveCustomInterval]);

  const handleClear = useCallback(() => {
    if (customIntervalRecords.length === 0) return;
    if (!window.confirm("清空所有自定义周期？此操作可以通过撤销最近删除恢复单项，但不会批量恢复。")) return;
    onClearCustomIntervals();
  }, [customIntervalRecords.length, onClearCustomIntervals]);

  const renderIntervalButton = (item: IntervalItem, extraClass = ""): ReactNode => {
    const available = isIntervalAvailable(item.value);
    return (
      <button
        key={item.value}
        id={`interval-${item.value}`}
        className={clsx("interval-btn", intervalsSemanticallyEquivalent(interval, item.value) && "active", item.isCustom && "custom-interval-btn", !available && "unavailable", extraClass)}
        onClick={() => selectInterval(item.value)}
        title={readOnlyReason ?? (!available
          ? unavailableMessage(item.value)
          : item.isCustom ? `自定义周期：${formatIntervalDescription(item.value)}` : item.value)}
        type="button"
        disabled={!available || readOnlyReason !== null}
        aria-disabled={!available || readOnlyReason !== null}
      >
        {item.isCustom && <span className="interval-custom-dot" />}
        {item.label}
      </button>
    );
  };

  const renderIntervalRow = (item: IntervalItem, index: number): ReactNode => {
    const seconds = item.seconds || parseIntervalSeconds(item.value) || 0;
    const record = item.record || customIntervalRecords.find((custom) => (
      intervalsSemanticallyEquivalent(custom.value, item.value)
    ));
    const highlighted = index === clampedHighlightIndex;
    const available = isIntervalAvailable(item.value);
    return (
      <div
        key={item.value}
        className={clsx("interval-panel-row", intervalsSemanticallyEquivalent(interval, item.value) && "active", highlighted && "highlighted", !available && "unavailable")}
      >
        <button
          type="button"
          className="interval-panel-select"
          onClick={() => selectInterval(item.value)}
          disabled={!available}
          aria-disabled={!available}
          title={!available ? unavailableMessage(item.value) : undefined}
        >
          <span className="interval-panel-main">
            <span className="interval-panel-value">{item.value}</span>
            {item.isCustom && <span className="interval-panel-badge">自定义</span>}
            {record?.pinned && <span className="interval-panel-badge pinned">置顶</span>}
            {intervalsSemanticallyEquivalent(interval, item.value) && <span className="interval-panel-badge active">当前</span>}
            {!available && <span className="interval-panel-badge unavailable">当前市场不可用</span>}
          </span>
          <span className="interval-panel-meta">
            <span>{formatIntervalDescription(item.value)}</span>
            <span>{getIntervalGroupLabelZh(seconds)}</span>
            <span>{formatSecondsCompact(seconds)}</span>
            {record && record.usageCount > 0 && <span>使用 {record.usageCount}</span>}
          </span>
        </button>
        {item.isCustom && (
          <div className="interval-row-actions">
            <button
              type="button"
              className={clsx("interval-row-action", record?.pinned && "active")}
              onClick={() => onTogglePinCustomInterval(item.value)}
              title={record?.pinned ? "取消置顶" : "置顶到工具栏"}
            >
              {record?.pinned ? "★" : "☆"}
            </button>
            <button
              type="button"
              className="interval-row-action danger"
              onClick={() => handleRemove(item.value)}
              title={`删除 ${item.value}`}
            >
              删除
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="interval-toolbar-wrap"
      ref={rootRef}
      data-readonly={readOnlyReason === null ? "false" : "true"}
      title={readOnlyReason ?? undefined}
    >
      <nav className="toolbar" id="toolbar" aria-label="时间周期工具栏">
        {nativeGroups.map((group, gi) => (
          <div key={group.label} className="toolbar-group-wrap">
            {gi > 0 && <div className="toolbar-divider" />}
            <div className="toolbar-group">
              {group.items.map((item) => renderIntervalButton(item))}
            </div>
          </div>
        ))}

        {toolbarCustomGroups.length > 0 && (
          <>
            <div className="toolbar-divider" />
            <div className="toolbar-group custom-toolbar-group">
              {toolbarCustomGroups.flatMap((group) => group.items).map((item) => renderIntervalButton(item, "toolbar-custom-visible"))}
            </div>
          </>
        )}

        <div className="toolbar-divider" />
        <button
          type="button"
          className={clsx("interval-more-btn", open && "active")}
          onClick={() => setOpen((prev) => !prev)}
          disabled={readOnlyReason !== null}
          aria-expanded={open}
          aria-haspopup="dialog"
          title={readOnlyReason ?? "打开周期选择与自定义周期管理"}
        >
          <span className="interval-more-label">周期</span>
          <span className="interval-more-value">{interval}</span>
          <span className="interval-more-caret">▾</span>
        </button>
      </nav>

      {open && (
        <div className="interval-panel" role="dialog" aria-label="周期选择器">
          <div className="interval-panel-header">
            <div>
              <div className="interval-panel-title">周期选择</div>
              <div className="interval-panel-subtitle">选择、添加、置顶或删除自定义 K 线周期</div>
            </div>
            <div className="interval-panel-current">
              当前 <strong>{interval}</strong>
              <button type="button" className="interval-panel-close" onClick={() => setOpen(false)} aria-label="关闭周期面板">×</button>
            </div>
          </div>

          <div className="interval-panel-search-row">
            <span className="interval-search-icon">⌕</span>
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => { setSearch(event.target.value); setHighlightIndex(0); }}
              onKeyDown={handleSearchKeyDown}
              className="interval-panel-search"
              placeholder="搜索周期，或输入 45m 后回车创建"
            />
            {search && (
              <button type="button" className="interval-search-clear" onClick={() => setSearch("")}>清除</button>
            )}
          </div>

          <div className="interval-panel-tabs">
            {TAB_OPTIONS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={clsx("interval-panel-tab", activeTab === tab.key && "active")}
                onClick={() => { setActiveTab(tab.key); setHighlightIndex(0); }}
              >
                {tab.label}
                {tab.key === "custom" && <span>{effectiveCustomRecords.length}</span>}
              </button>
            ))}
          </div>

          <div className="interval-panel-body">
            <section className="interval-create-card">
              <div className="interval-create-header">
                <div>
                  <div className="interval-section-title">新增自定义周期</div>
                  <div className="interval-section-desc">不用记格式，输入数字并选择单位即可。</div>
                </div>
                <div className="interval-preview-pill">{formValue || "--"}</div>
              </div>

              <div className="interval-create-controls">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="interval-number-input"
                  aria-label="周期数字"
                />
                <div className="interval-unit-tabs" aria-label="周期单位">
                  {INTERVAL_UNITS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={clsx("interval-unit-tab", unit === item.value && "active")}
                      onClick={() => setUnit(item.value)}
                      title={item.label}
                    >
                      {item.shortLabel}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="interval-create-btn"
                  onClick={() => createOrSelectInterval(formValue)}
                  disabled={!formStatus.ok && formStatus.kind === "invalid"}
                >
                  {formStatus.kind === "native" || formStatus.kind === "exists" ? "选择" : "添加并切换"}
                </button>
              </div>

              <div className={clsx("interval-create-status", formStatus.ok ? "ok" : formStatus.kind)}>
                {formStatus.text}
              </div>

              <div className="interval-presets">
                <span>快捷：</span>
                {QUICK_PRESETS.map((preset) => {
                  const status = createStatusForValue(
                    preset,
                    nativeValueSet,
                    customValueSet,
                    nativeValues,
                    capabilityReady,
                    capabilityLoading,
                    intervalAvailability,
                    unavailableIntervalMessageOverride,
                  );
                  const disabled = status.kind === "invalid";
                  return (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => createOrSelectInterval(preset)}
                      disabled={disabled}
                      title={disabled ? status.text : undefined}
                    >
                      {preset}
                    </button>
                  );
                })}
              </div>
            </section>

            {search && normalizedSearch && searchCreateStatus.ok && (
              <button type="button" className="interval-create-suggestion" onClick={() => createOrSelectInterval(normalizedSearch)}>
                创建并切换到 <strong>{normalizedSearch}</strong>
                <span>{formatIntervalDescription(normalizedSearch)}</span>
              </button>
            )}

            {(inlineMessage || intervalNotice) && (
              <div className={clsx("interval-panel-message", (inlineMessage || intervalNotice)?.type)}>
                <span>{(inlineMessage || intervalNotice)?.text}</span>
                {intervalNotice?.actionLabel && (
                  <button type="button" onClick={onRestoreCustomInterval}>{intervalNotice.actionLabel}</button>
                )}
              </div>
            )}

            <section className="interval-list-section">
              <div className="interval-list-header">
                <div>
                  <div className="interval-section-title">
                    {activeTab === "custom" ? "自定义周期" : activeTab === "all" ? "全部周期" : "常用周期"}
                  </div>
                  <div className="interval-section-desc">
                    {visibleAvailableCount} 个当前可用周期，{visibleItems.length} 个已显示；Enter 选择，高亮行可用方向键移动。
                  </div>
                </div>
                {activeTab === "custom" && effectiveCustomRecords.length > 0 && (
                  <button type="button" className="interval-clear-all" onClick={handleClear}>清空</button>
                )}
              </div>

              {visibleGroups.length === 0 ? (
                <div className="interval-empty-state">没有匹配的周期。可以在上方创建一个新的自定义周期。</div>
              ) : (
                <div className="interval-groups">
                  {visibleGroups.map((group) => {
                    let baseIndex = 0;
                    for (const previous of visibleGroups) {
                      if (previous === group) break;
                      baseIndex += previous.items.length;
                    }
                    return (
                      <div key={group.label} className="interval-panel-group">
                        <div className="interval-group-label">{group.labelZh}</div>
                        {group.items.map((item, index) => renderIntervalRow(item, baseIndex + index))}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(IntervalSelector);
