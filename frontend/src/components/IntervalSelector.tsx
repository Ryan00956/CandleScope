import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getLocale, t, type LocaleId } from "../i18n/index.js";
import { useLocale } from "../i18n/useLocale.js";
import {
  canResolveIntervalFromNativeValues,
  canonicalizeIntervalValue,
  formatIntervalDescription,
  formatSecondsCompact,
  groupIntervalsByDuration,
  INTERVAL_UNITS,
  intervalSemanticSignature,
  intervalsSemanticallyEquivalent,
  parseIntervalParts,
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

interface PickerGroup {
  key: string;
  label: string;
  items: IntervalItem[];
  showAdd: boolean;
}

interface InlineMessage {
  type: "success" | "error";
  text: string;
}

const TAB_OPTIONS: Array<{ key: IntervalTab; labelKey: "interval.tab.common" | "interval.tab.custom" | "interval.tab.all" }> = [
  { key: "common", labelKey: "interval.tab.common" },
  { key: "custom", labelKey: "interval.tab.custom" },
  { key: "all", labelKey: "interval.tab.all" },
];
const COMMON_NATIVE_VALUES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
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

function dedupeItems(items: IntervalItem[]): IntervalItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const signature = intervalSemanticSignature(item.value);
    if (!signature || seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
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
  locale: LocaleId = getLocale(),
): IntervalStatus {
  const normalized = canonicalizeIntervalValue(value);
  const seconds = parseIntervalSeconds(normalized);
  const signature = intervalSemanticSignature(normalized);
  if (!normalized || !seconds) {
    return { ok: false, kind: "invalid", text: t("interval.invalidInput", {}, locale) };
  }
  if (capabilityLoading) {
    return { ok: false, kind: "invalid", text: t("interval.capabilityLoading", {}, locale) };
  }
  if (!capabilityReady) {
    return { ok: false, kind: "invalid", text: t("interval.noHistoryCapability", {}, locale) };
  }
  const available = intervalAvailability
    ? intervalAvailability(normalized)
    : canResolveIntervalFromNativeValues(normalized, nativeValues);
  if (!available) {
    return {
      ok: false,
      kind: "invalid",
      text: unavailableIntervalMessage?.(normalized)
        ?? t("interval.cannotCompose", {}, locale),
    };
  }
  if (nativeValueSet.has(signature)) {
    return { ok: false, kind: "native", text: t("interval.nativeHint", {}, locale) };
  }
  if (customValueSet.has(signature)) {
    return { ok: false, kind: "exists", text: t("interval.existsHint", {}, locale) };
  }
  return { ok: true, kind: "new", text: t("interval.willAdd", { desc: formatIntervalDescription(normalized) }, locale) };
}

function chipTitle(
  item: IntervalItem,
  record: CustomIntervalRecord | undefined,
  available: boolean,
  unavailableText: string,
  locale: LocaleId,
): string {
  const seconds = item.seconds || parseIntervalSeconds(item.value) || 0;
  const parts = [
    item.isCustom
      ? t("interval.customNamed", { desc: formatIntervalDescription(item.value) }, locale)
      : formatIntervalDescription(item.value),
    formatSecondsCompact(seconds),
  ];
  if (record?.pinned) parts.push(t("interval.badge.pinned", {}, locale));
  if (record && record.usageCount > 0) {
    parts.push(t("interval.used", { count: record.usageCount }, locale));
  }
  if (!available) parts.push(unavailableText);
  return parts.filter(Boolean).join(" · ");
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
  defaultOpen?: boolean;
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
  defaultOpen = false,
}: IntervalSelectorProps) {
  const locale = useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const [activeTab, setActiveTab] = useState<IntervalTab>("common");
  const [search, setSearch] = useState("");
  const [amount, setAmount] = useState("45");
  const [unit, setUnit] = useState<IntervalUnit>("m");
  const [composerOpen, setComposerOpen] = useState(false);
  const [inlineMessage, setInlineMessage] = useState<InlineMessage | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const amountInputRef = useRef<HTMLInputElement | null>(null);

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
      locale,
    ),
    [
      capabilityLoading,
      capabilityReady,
      customValueSet,
      intervalAvailability,
      nativeValueSet,
      nativeValues,
      locale,
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
      locale,
    ),
    [
      capabilityLoading,
      capabilityReady,
      customValueSet,
      formValue,
      intervalAvailability,
      nativeValueSet,
      locale,
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
      ? t("interval.capabilityLoading", {}, locale)
      : capabilityReady
        ? unavailableIntervalMessageOverride?.(value)
          ?? t("interval.cannotComposeValue", { value }, locale)
        : t("interval.noHistoryCapability", {}, locale)
  ), [capabilityLoading, capabilityReady, locale, unavailableIntervalMessageOverride]);

  const visibleItems = useMemo(() => {
    if (activeTab === "custom") {
      return sortedCustomRecords.map(buildItemFromRecord).filter((item) => matchesSearch(item, search));
    }
    if (activeTab === "all") {
      return dedupeItems([
        ...allItems,
        ...sortedCustomRecords.map(buildItemFromRecord),
      ]).filter((item) => matchesSearch(item, search));
    }
    return dedupeItems([
      ...nativeIntervals
        .filter((item) => COMMON_NATIVE_VALUES.includes(item.value))
        .map((item) => ({ ...item, isCustom: false })),
      ...sortedCustomRecords.map(buildItemFromRecord),
    ]).filter((item) => matchesSearch(item, search));
  }, [activeTab, allItems, nativeIntervals, search, sortedCustomRecords]);

  const pickerGroups = useMemo((): PickerGroup[] => {
    if (activeTab === "custom") {
      const groups = groupIntervalsByDuration(visibleItems).map((group, index, list) => ({
        key: group.label,
        label: group.label,
        items: group.items,
        showAdd: index === list.length - 1,
      }));
      if (groups.length === 0) {
        return [{ key: "mine", label: t("interval.group.mine", {}, locale), items: [], showAdd: true }];
      }
      return groups;
    }
    const natives = visibleItems.filter((item) => !item.isCustom);
    const customs = visibleItems.filter((item) => item.isCustom);
    const groups = groupIntervalsByDuration(natives).map((group) => ({
      key: group.label,
      label: group.label,
      items: group.items,
      showAdd: false,
    }));
    if (customs.length > 0 || !search) {
      groups.push({
        key: "mine",
        label: t("interval.group.mine", {}, locale),
        items: customs,
        showAdd: true,
      });
    }
    return groups;
  }, [activeTab, locale, search, visibleItems]);

  const visibleItemsInRenderOrder = useMemo(
    () => pickerGroups.flatMap((group) => group.items),
    [pickerGroups],
  );
  const clampedHighlightIndex = visibleItemsInRenderOrder.length > 0
    ? Math.min(highlightIndex, visibleItemsInRenderOrder.length - 1)
    : 0;
  const showComposer = composerOpen
    || activeTab === "custom"
    || (Boolean(normalizedSearch) && searchCreateStatus.ok);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const wrap = rootRef.current;
      const button = moreBtnRef.current;
      const panel = panelRef.current;
      if (!wrap || !button || !panel) return;
      const wrapRect = wrap.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const panelWidth = panel.offsetWidth || Math.min(400, window.innerWidth - 32);
      const pad = 8;
      const minLeft = pad - wrapRect.left;
      const maxLeft = window.innerWidth - pad - panelWidth - wrapRect.left;
      let left = buttonRect.left - wrapRect.left;
      left = maxLeft >= minLeft
        ? Math.min(Math.max(left, minLeft), maxLeft)
        : Math.max(0, left);
      panel.style.left = `${Math.round(left)}px`;
    };
    update();
    window.addEventListener("resize", update);
    const toolbar = toolbarRef.current;
    toolbar?.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      toolbar?.removeEventListener("scroll", update);
    };
  }, [open]);

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
      setComposerOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setComposerOpen(false);
    setSearch("");
  }, []);

  const selectInterval = useCallback((value: IntervalString) => {
    const normalized = canonicalizeIntervalValue(value) || value;
    if (!isIntervalAvailable(normalized)) {
      setInlineMessage({ type: "error", text: unavailableMessage(normalized) });
      setOpen(true);
      return;
    }
    onSelectInterval(normalized);
    closePanel();
    setInlineMessage(null);
  }, [closePanel, isIntervalAvailable, onSelectInterval, unavailableMessage]);

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
      locale,
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
      setInlineMessage({ type: "error", text: result.message || t("interval.addFailed", {}, locale) });
      return;
    }
    setInlineMessage({ type: "success", text: t("interval.addedAndSwitched", { value: normalized }, locale) });
    closePanel();
  }, [
    capabilityLoading,
    capabilityReady,
    closePanel,
    customValueSet,
    intervalAvailability,
    locale,
    nativeValueSet,
    nativeValues,
    onCreateCustomInterval,
    selectInterval,
    unavailableIntervalMessageOverride,
  ]);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
      return;
    }
    const lastIndex = Math.max(visibleItemsInRenderOrder.length - 1, 0);
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, lastIndex));
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (normalizedSearch) {
        const match = visibleItemsInRenderOrder.find((item) => (
          intervalsSemanticallyEquivalent(item.value, normalizedSearch)
        ));
        if (match) {
          selectInterval(match.value);
          return;
        }
        createOrSelectInterval(normalizedSearch);
        return;
      }
      const highlighted = visibleItemsInRenderOrder[clampedHighlightIndex];
      if (highlighted) selectInterval(highlighted.value);
    }
  }, [
    clampedHighlightIndex,
    closePanel,
    createOrSelectInterval,
    normalizedSearch,
    selectInterval,
    visibleItemsInRenderOrder,
  ]);

  const handleRemove = useCallback((value: IntervalString) => {
    onRemoveCustomInterval(value);
  }, [onRemoveCustomInterval]);

  const handleClear = useCallback(() => {
    if (customIntervalRecords.length === 0) return;
    if (!window.confirm(t("interval.confirmClear", {}, locale))) return;
    onClearCustomIntervals();
  }, [customIntervalRecords.length, locale, onClearCustomIntervals]);

  const openComposer = useCallback(() => {
    setComposerOpen(true);
    setActiveTab("custom");
    setTimeout(() => amountInputRef.current?.focus(), 30);
  }, []);

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
          : item.isCustom ? t("interval.customNamed", { desc: formatIntervalDescription(item.value) }, locale) : item.value)}
        type="button"
        disabled={!available || readOnlyReason !== null}
        aria-disabled={!available || readOnlyReason !== null}
      >
        {item.isCustom && <span className="interval-custom-dot" />}
        {item.label}
      </button>
    );
  };

  const renderPickerChip = (item: IntervalItem, index: number, manage: boolean): ReactNode => {
    const record = item.record || customIntervalRecords.find((custom) => (
      intervalsSemanticallyEquivalent(custom.value, item.value)
    ));
    const highlighted = index === clampedHighlightIndex;
    const available = isIntervalAvailable(item.value);
    const active = intervalsSemanticallyEquivalent(interval, item.value);
    return (
      <div
        key={item.value}
        className={clsx("interval-chip-wrap", manage && item.isCustom && "manage")}
      >
        <button
          type="button"
          data-interval-chip={item.value}
          className={clsx(
            "interval-chip",
            active && "active",
            item.isCustom && "custom",
            !available && "unavailable",
            highlighted && "highlighted",
          )}
          onClick={() => selectInterval(item.value)}
          disabled={!available}
          aria-disabled={!available}
          title={chipTitle(item, record, available, unavailableMessage(item.value), locale)}
        >
          {item.isCustom && <span className="interval-custom-dot" />}
          {item.label || item.value}
          {record?.pinned && <span className="interval-chip-star" aria-hidden="true">★</span>}
        </button>
        {manage && item.isCustom && (
          <div className="interval-chip-actions">
            <button
              type="button"
              className={clsx("interval-chip-action", record?.pinned && "active")}
              onClick={() => onTogglePinCustomInterval(item.value)}
              title={record?.pinned ? t("interval.unpin", {}, locale) : t("interval.pin", {}, locale)}
              aria-label={record?.pinned ? t("interval.unpin", {}, locale) : t("interval.pin", {}, locale)}
            >
              {record?.pinned ? "★" : "☆"}
            </button>
            <button
              type="button"
              className="interval-chip-action danger"
              onClick={() => handleRemove(item.value)}
              title={t("interval.deleteNamed", { value: item.value }, locale)}
              aria-label={t("interval.deleteNamed", { value: item.value }, locale)}
            >
              ×
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
      <nav ref={toolbarRef} className="toolbar" id="toolbar" aria-label={t("interval.toolbar", {}, locale)}>
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
          ref={moreBtnRef}
          type="button"
          className={clsx("interval-more-btn", open && "active")}
          onClick={() => {
            if (open) {
              closePanel();
              return;
            }
            setOpen(true);
          }}
          disabled={readOnlyReason !== null}
          aria-expanded={open}
          aria-haspopup="dialog"
          title={readOnlyReason ?? t("interval.openPicker", {}, locale)}
        >
          <span className="interval-more-label">{t("interval.label", {}, locale)}</span>
          <span className="interval-more-value">{interval}</span>
          <span className="interval-more-caret">▾</span>
        </button>
      </nav>

      {open && (
        <div ref={panelRef} className="interval-panel" role="dialog" aria-label={t("interval.picker", {}, locale)}>
          <div className="interval-panel-search-row">
            <span className="interval-search-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20L16.5 16.5" />
              </svg>
            </span>
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => {
                const next = event.target.value;
                setSearch(next);
                setHighlightIndex(0);
                const parts = parseIntervalParts(next);
                if (parts) {
                  setAmount(String(parts.amount));
                  setUnit(parts.unit);
                }
              }}
              onKeyDown={handleSearchKeyDown}
              className="interval-panel-search"
              placeholder={t("interval.searchPlaceholder", {}, locale)}
            />
            <button
              type="button"
              className="interval-panel-close"
              onClick={closePanel}
              aria-label={t("interval.closePanel", {}, locale)}
            >
              ×
            </button>
          </div>

          <div className="interval-panel-tabs">
            {TAB_OPTIONS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                data-interval-tab={tab.key}
                className={clsx("interval-panel-tab", activeTab === tab.key && "active")}
                onClick={() => { setActiveTab(tab.key); setHighlightIndex(0); }}
              >
                {t(tab.labelKey, {}, locale)}
                {tab.key === "custom" && <span>{effectiveCustomRecords.length}</span>}
              </button>
            ))}
          </div>

          <div className="interval-panel-body">
            {(inlineMessage || intervalNotice) && (
              <div className={clsx("interval-panel-message", (inlineMessage || intervalNotice)?.type)}>
                <span>{(inlineMessage || intervalNotice)?.text}</span>
                {intervalNotice?.actionLabel && (
                  <button type="button" onClick={onRestoreCustomInterval}>{intervalNotice.actionLabel}</button>
                )}
              </div>
            )}

            {activeTab === "custom" && (
              <div className="interval-manage-head">
                <span>{t("interval.manageHint", {}, locale)}</span>
                {effectiveCustomRecords.length > 0 && (
                  <button type="button" className="interval-clear-all" onClick={handleClear}>
                    {t("interval.clearAll", {}, locale)}
                  </button>
                )}
              </div>
            )}

            {pickerGroups.every((group) => group.items.length === 0) ? (
              <div className="interval-empty-state">{t("interval.empty", {}, locale)}</div>
            ) : (
              <div className="interval-groups">
                {pickerGroups.map((group) => {
                  let baseIndex = 0;
                  for (const previous of pickerGroups) {
                    if (previous === group) break;
                    baseIndex += previous.items.length;
                  }
                  if (group.items.length === 0 && !group.showAdd) return null;
                  return (
                    <div key={group.key} className="interval-picker-group">
                      <div className="interval-group-label">{group.label}</div>
                      <div className="interval-chips">
                        {group.items.map((item, index) => renderPickerChip(item, baseIndex + index, activeTab === "custom"))}
                        {group.showAdd && (
                          <button
                            type="button"
                            className="interval-chip-add"
                            onClick={openComposer}
                            title={t("interval.addCustom", {}, locale)}
                            aria-label={t("interval.addCustom", {}, locale)}
                          >
                            +
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {showComposer && (
              <section className="interval-composer" data-interval-composer="true">
                <div className="interval-split">
                  <input
                    ref={amountInputRef}
                    type="number"
                    min="1"
                    step="1"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        createOrSelectInterval(formValue);
                      }
                    }}
                    className="interval-number-input"
                    aria-label={t("interval.numberAria", {}, locale)}
                  />
                  <div className="interval-unit-tabs" aria-label={t("interval.unitAria", {}, locale)}>
                    {INTERVAL_UNITS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={clsx("interval-unit-tab", unit === item.value && "active")}
                        onClick={() => setUnit(item.value)}
                        title={t(item.labelKey, {}, locale)}
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
                    {formStatus.kind === "native" || formStatus.kind === "exists"
                      ? t("interval.select", {}, locale)
                      : t("interval.addAndSwitch", {}, locale)}
                  </button>
                </div>
                <div className={clsx("interval-create-status", formStatus.ok ? "ok" : formStatus.kind)}>
                  {formStatus.text}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(IntervalSelector);
