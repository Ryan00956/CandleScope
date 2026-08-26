import { useCallback, useEffect, useMemo, useState } from "react";
import { getLocale, t, translateMarketType } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import { useRightDrawerResize } from "../../shared/useRightDrawerResize.js";
import {
  createAlertRule,
  deleteAlertRule,
  evaluateAlertExpression,
  fetchAlertHistory,
  fetchAlertRules,
  fetchAlertStatus,
  setAlertHistoryAcknowledged,
  setAlertRuleEnabled,
  updateAlertRule,
} from "../../features/alerts/alertsClient";
import {
  ALERT_COMPARATOR_OPTIONS,
  ALERT_RIGHT_TYPE_OPTIONS,
  ALERT_SOURCE_OPTIONS,
  buildAlertPayloadFromDraft,
  createDefaultAlertDraft,
  createDraftFromRule,
  describeAlertChannels,
  describeAlertDraftExpression,
  describeAlertDispatch,
  describeAlertRule,
  expressionDraftReducer,
  formatAlertTime,
  labelForComparator,
  labelForRightType,
  labelForSource,
} from "../../features/alerts/alertRuleModel";
import {
  ALERT_RULE_STATE_CHANGED_EVENT,
  primeAlertSound,
  requestBrowserAlertPermission,
} from "../../features/alerts/alertDeliveryClient.js";
import { parseSymbolKey } from "../../utils/symbolKey";
import type {
  Dispatch,
  ReactNode,
  SetStateAction,
} from "react";
import type {
  AlertChannelState,
  AlertComparator,
  AlertConditionDraft,
  AlertDraft,
  AlertEvaluateResult,
  AlertEvaluationContext,
  AlertExpressionDraft,
  AlertExpressionDraftAction,
  AlertGroupDraft,
  AlertHistoryEvent,
  AlertLogicalOperator,
  AlertProductInput,
  AlertRule,
  AlertSystemStatus,
  AlertTraceNode as AlertTraceNodeData,
  AlertTriggerOn,
} from "../../features/alerts/alertTypes.js";
import type { WatchlistGroup } from "../../features/watchlist/watchlistTypes.js";

type AlertTab = "add" | "all" | "history";
type AlertStatusFilter = "all" | "enabled" | "paused" | "expired";
type AlertHistoryRange = "today" | "7d" | "30d";
type AlertAcknowledgementFilter = "all" | "unread" | "ack";
type TestContextBucket = "previous" | "values";
type TestValueField = "close" | "last" | "rsi" | "macdHist" | "ma20" | "volume";

interface AlertTestContext {
  previous: Record<TestValueField, string>;
  values: Record<TestValueField, string>;
}

interface WatchlistAlertProduct extends AlertProductInput {
  symbol: string;
  marketType: string;
  exchange: string;
  key: string;
  listNames: string[];
  color: string;
}

function alertMarketLabel(marketType: string | undefined): string {
  if (marketType === "spot" || marketType === "futures") return translateMarketType(marketType);
  return marketType || t("market.spot");
}

const TAB_OPTIONS: Array<{ key: AlertTab; labelKey: "alert.tab.add" | "alert.tab.all" | "alert.tab.history" }> = [
  { key: "add", labelKey: "alert.tab.add" },
  { key: "all", labelKey: "alert.tab.all" },
  { key: "history", labelKey: "alert.tab.history" },
];

const TRIGGER_OPTIONS: Array<{ value: AlertTriggerOn; labelKey: "alert.trigger.realtime" | "alert.trigger.barUpdate" | "alert.trigger.barClose" }> = [
  { value: "realtime", labelKey: "alert.trigger.realtime" },
  { value: "bar_update", labelKey: "alert.trigger.barUpdate" },
  { value: "bar_close", labelKey: "alert.trigger.barClose" },
];

const CHANNEL_OPTIONS: Array<{
  key: keyof AlertChannelState;
  titleKey: "alert.channel.inApp" | "alert.channel.browser" | "alert.channel.sound" | "alert.channel.webhook" | "alert.channel.history";
  descKey: "alert.channel.inAppDesc" | "alert.channel.browserDesc" | "alert.channel.soundDesc" | "alert.channel.webhookDesc" | "alert.channel.historyDesc";
}> = [
  { key: "in_app", titleKey: "alert.channel.inApp", descKey: "alert.channel.inAppDesc" },
  { key: "browser", titleKey: "alert.channel.browser", descKey: "alert.channel.browserDesc" },
  { key: "sound", titleKey: "alert.channel.sound", descKey: "alert.channel.soundDesc" },
  { key: "webhook", titleKey: "alert.channel.webhook", descKey: "alert.channel.webhookDesc" },
  { key: "history", titleKey: "alert.channel.history", descKey: "alert.channel.historyDesc" },
];

const TEST_VALUE_FIELDS: Array<{ key: TestValueField; label?: string; labelKey?: "alert.field.close" | "alert.field.last" | "alert.field.volume" }> = [
  { key: "close", labelKey: "alert.field.close" },
  { key: "last", labelKey: "alert.field.last" },
  { key: "rsi", label: "RSI(14)" },
  { key: "macdHist", label: "MACD Hist" },
  { key: "ma20", label: "MA(20)" },
  { key: "volume", labelKey: "alert.field.volume" },
];

const RANGE_COMPARATORS = new Set<AlertComparator>(["between", "outsideRange"]);
const PERCENT_CHANGE_COMPARATORS = new Set<AlertComparator>(["percentChangeAbove", "percentChangeBelow"]);

function formatPrice(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  if (num >= 1000) {
    return num.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(8);
}

function formatMarket(exchange: string | undefined, marketType: string | undefined): string {
  const ex = String(exchange || "binance").toUpperCase();
  return `${ex} · ${alertMarketLabel(marketType)}`;
}

function buildProductKey({ symbol, marketType, exchange }: AlertProductInput): string {
  return `${exchange || "binance"}:${marketType || "spot"}:${symbol || ""}`;
}

function buildWatchlistProducts(watchlists: WatchlistGroup[] = [], locale = getLocale()): WatchlistAlertProduct[] {
  const productMap = new Map<string, WatchlistAlertProduct>();
  for (const list of watchlists) {
    const symbols = Array.isArray(list?.symbols) ? list.symbols : [];
    for (const rawKey of symbols) {
      const parsed = parseSymbolKey(rawKey);
      if (!parsed.symbol) continue;
      const key = buildProductKey(parsed);
      const existing = productMap.get(key);
      if (existing) {
        existing.listNames.push(list.name || t("alert.watchlistFallback", {}, locale));
        continue;
      }
      productMap.set(key, {
        ...parsed,
        key,
        listNames: [list.name || t("alert.watchlistFallback", {}, locale)],
        color: list.color || "#3b82f6",
      });
    }
  }
  return Array.from(productMap.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

interface ContextMetricProps {
  label: string;
  value: ReactNode;
  tone?: string;
}

function ContextMetric({ label, value, tone }: ContextMetricProps) {
  return (
    <div className={`alert-context-metric ${tone ? `tone-${tone}` : ""}`}>
      <span className="alert-context-label">{label}</span>
      <span className="alert-context-value">{value}</span>
    </div>
  );
}

interface SectionHeaderProps {
  kicker?: string;
  title: string;
  desc?: string;
  action?: ReactNode;
}

function SectionHeader({ kicker, title, desc, action }: SectionHeaderProps) {
  return (
    <div className="alert-section-header">
      <div>
        {kicker && <div className="alert-section-kicker">{kicker}</div>}
        <div className="alert-section-title">{title}</div>
        {desc && <div className="alert-section-desc">{desc}</div>}
      </div>
      {action}
    </div>
  );
}

interface ProductSummaryProps {
  product: WatchlistAlertProduct | null;
  fallbackSymbol?: string;
  fallbackMarketType?: string;
  fallbackExchange?: string;
}

function alertRuntimeRuleStateLabel(state: string | undefined, enabled: boolean): string {
  const labels: Record<string, "alert.state.ready" | "alert.state.warming" | "alert.state.recovering" | "alert.state.degraded" | "alert.state.disabled" | "alert.state.expired" | "alert.state.exhausted"> = {
    ready: "alert.state.ready",
    warming: "alert.state.warming",
    recovering: "alert.state.recovering",
    degraded: "alert.state.degraded",
    disabled: "alert.state.disabled",
    expired: "alert.state.expired",
    exhausted: "alert.state.exhausted",
  };
  if (state && labels[state]) return t(labels[state]);
  return enabled ? t("alert.state.waiting") : t("alert.state.disabled");
}

function ProductSummary({ product, fallbackSymbol, fallbackMarketType, fallbackExchange }: ProductSummaryProps) {
  const symbol = product?.symbol || fallbackSymbol || "--";
  const marketType = product?.marketType || fallbackMarketType || "spot";
  const exchange = product?.exchange || fallbackExchange || "binance";

  return (
    <div className="alert-selected-product">
      <div className="alert-selected-product-main">
        <span className="alert-product-avatar">{symbol.slice(0, 1) || "?"}</span>
        <div>
          <div className="alert-product-symbol">{symbol}</div>
          <div className="alert-product-meta">{formatMarket(exchange, marketType)}</div>
        </div>
      </div>
      <div className="alert-product-tags">
        {product?.listNames?.slice(0, 2).map((name) => (
          <span key={name} className="alert-mini-tag">{name}</span>
        ))}
      </div>
    </div>
  );
}

interface ConditionCardProps {
  node: AlertConditionDraft;
  index: string | number;
  onAction(action: AlertExpressionDraftAction): void;
  canDelete: boolean;
}

function ConditionCard({ node, index, onAction, canDelete }: ConditionCardProps) {
  const update = (patch: Partial<AlertConditionDraft>) => onAction({ type: "update-node", nodeId: node.id, patch });
  const isRangeComparator = RANGE_COMPARATORS.has(node.comparator);
  const isPercentComparator = PERCENT_CHANGE_COMPARATORS.has(node.comparator);
  const sourceChoices = node.rightType === "indicator"
    ? ALERT_SOURCE_OPTIONS.filter((item) => ["rsi", "macdHist", "ma20"].includes(item.value))
    : ALERT_SOURCE_OPTIONS;
  const updateComparator = (value: AlertComparator) => {
    const patch: Partial<AlertConditionDraft> = { comparator: value };
    if (RANGE_COMPARATORS.has(value)) {
      patch.rangeMin = node.rangeMin || "30";
      patch.rangeMax = node.rangeMax || "70";
    }
    if (PERCENT_CHANGE_COMPARATORS.has(value)) {
      patch.percentValue = node.percentValue || "2";
    }
    update(patch);
  };

  return (
    <div className="alert-condition-card tone-blue">
      <div className="alert-condition-topline">
        <span className="alert-condition-index">{t("alert.condition", { index: String(index) })}</span>
        <div className="alert-inline-actions">
          <label className="alert-not-toggle">
            <input type="checkbox" checked={Boolean(node.not)} onChange={(event) => update({ not: event.target.checked })} />
            <span>NOT</span>
          </label>
          <button type="button" onClick={() => onAction({ type: "duplicate-node", nodeId: node.id })}>{t("alert.copy")}</button>
          <button type="button" onClick={() => onAction({ type: "delete-node", nodeId: node.id })} disabled={!canDelete}>{t("alert.delete")}</button>
        </div>
      </div>
      <div className="alert-condition-grid">
        <label className="alert-field compact">
          <span>{t("alert.left")}</span>
          <select value={node.left} onChange={(event) => update({ left: event.target.value })}>
            {ALERT_SOURCE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{labelForSource(item.value)}</option>)}
          </select>
        </label>
        <label className="alert-field compact">
          <span>{t("alert.operator")}</span>
          <select value={node.comparator} onChange={(event) => updateComparator(event.target.value as AlertComparator)}>
            {ALERT_COMPARATOR_OPTIONS.map((item) => <option key={item.value} value={item.value}>{labelForComparator(item.value)}</option>)}
          </select>
        </label>
        {isRangeComparator ? (
          <>
            <label className="alert-field compact">
              <span>{t("alert.rangeMin")}</span>
              <input type="number" value={node.rangeMin} onChange={(event) => update({ rangeMin: event.target.value })} />
            </label>
            <label className="alert-field compact">
              <span>{t("alert.rangeMax")}</span>
              <input type="number" value={node.rangeMax} onChange={(event) => update({ rangeMax: event.target.value })} />
            </label>
          </>
        ) : isPercentComparator ? (
          <label className="alert-field compact alert-field-wide">
            <span>{t("alert.changePct")}</span>
            <input type="number" value={node.percentValue} onChange={(event) => update({ percentValue: event.target.value })} />
          </label>
        ) : (
          <>
            <label className="alert-field compact">
              <span>{t("alert.rightType")}</span>
              <select value={node.rightType} onChange={(event) => update({ rightType: event.target.value as AlertConditionDraft["rightType"], rightValue: event.target.value === "number" ? node.rightValue : "close" })}>
                {ALERT_RIGHT_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{labelForRightType(item.value)}</option>)}
              </select>
            </label>
            <label className="alert-field compact">
              <span>{t("alert.right")}</span>
              {node.rightType === "number" ? (
                <input type="number" value={node.rightValue} onChange={(event) => update({ rightValue: event.target.value })} />
              ) : (
                <select value={node.rightValue || "close"} onChange={(event) => update({ rightValue: event.target.value })}>
                  {sourceChoices.map((item) => <option key={item.value} value={item.value}>{labelForSource(item.value)}</option>)}
                </select>
              )}
            </label>
          </>
        )}
      </div>
    </div>
  );
}

function numericInputValue(value: unknown): string {
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : "";
}

function createDefaultTestContext(price: unknown): AlertTestContext {
  const current = Number(price);
  const safePrice = Number.isFinite(current) && current > 0 ? current : 0;
  return {
    previous: {
      close: numericInputValue(safePrice ? safePrice * 0.995 : 0),
      last: numericInputValue(safePrice ? safePrice * 0.995 : 0),
      rsi: "68",
      macdHist: "-0.1",
      ma20: numericInputValue(safePrice ? safePrice * 0.99 : 0),
      volume: "900",
    },
    values: {
      close: numericInputValue(safePrice),
      last: numericInputValue(safePrice),
      rsi: "72",
      macdHist: "0.1",
      ma20: numericInputValue(safePrice ? safePrice * 0.99 : 0),
      volume: "1200",
    },
  };
}

function normalizeTestContext(context: AlertTestContext): AlertEvaluationContext {
  const normalizeBucket = (bucket: Record<TestValueField, string>): Record<string, number> => {
    const normalized: Record<string, number> = {};
    for (const { key } of TEST_VALUE_FIELDS) {
      const value = Number(bucket[key]);
      if (Number.isFinite(value)) normalized[key] = value;
    }
    return normalized;
  };
  return {
    previous: normalizeBucket(context.previous),
    values: normalizeBucket(context.values),
  };
}

interface LogicConnectorProps {
  value: AlertLogicalOperator;
}

function LogicConnector({ value }: LogicConnectorProps) {
  return (
    <div className="alert-logic-connector">
      <span>{value}</span>
    </div>
  );
}

interface LogicGroupEditorProps {
  node: AlertGroupDraft;
  onAction(action: AlertExpressionDraftAction): void;
  depth?: number;
  path?: string;
  canDelete?: boolean;
}

function LogicGroupEditor({ node, onAction, depth = 0, path, canDelete = false }: LogicGroupEditorProps) {
  const update = (patch: Partial<AlertGroupDraft>) => onAction({ type: "update-node", nodeId: node.id, patch });
  const children = Array.isArray(node.children) ? node.children : [];
  const displayPath = path || t("alert.root");

  return (
    <div className={`alert-logic-group ${depth === 0 ? "root" : "nested"}`}>
      <div className={`alert-logic-group-header ${depth > 0 ? "compact" : ""}`}>
        <div>
          <div className="alert-logic-title">{t("alert.logicTitle", { path: displayPath })}</div>
          <div className="alert-logic-desc">{t("alert.logicDesc", { count: children.length, op: node.op || "AND" })}</div>
        </div>
        <div className="alert-logic-actions">
          <label className="alert-not-toggle">
            <input type="checkbox" checked={Boolean(node.not)} onChange={(event) => update({ not: event.target.checked })} />
            <span>NOT</span>
          </label>
          <select value={node.op || "AND"} onChange={(event) => update({ op: event.target.value as AlertLogicalOperator })} className="alert-logic-select">
            <option value="AND">AND</option>
            <option value="OR">OR</option>
          </select>
          <button type="button" onClick={() => onAction({ type: "duplicate-node", nodeId: node.id })} disabled={depth === 0}>{t("alert.copyGroup")}</button>
          <button type="button" onClick={() => onAction({ type: "delete-node", nodeId: node.id })} disabled={!canDelete}>{t("alert.deleteGroup")}</button>
        </div>
      </div>

      {children.map((child, index) => (
        <div key={child.id} className="alert-logic-node">
          {index > 0 && <LogicConnector value={node.op || "AND"} />}
          {child.type === "group" ? (
            <LogicGroupEditor
              node={child}
              onAction={onAction}
              depth={depth + 1}
              path={`${displayPath}.${index + 1}`}
              canDelete={children.length > 1}
            />
          ) : (
            <ConditionCard
              node={child}
              index={`${displayPath}.${index + 1}`}
              onAction={onAction}
              canDelete={children.length > 1}
            />
          )}
        </div>
      ))}

      <div className="alert-logic-footer">
        <button className="alert-btn alert-btn-secondary" type="button" onClick={() => onAction({ type: "add-condition", nodeId: node.id })}>{t("alert.addCondition")}</button>
        <button className="alert-btn alert-btn-secondary" type="button" onClick={() => onAction({ type: "add-group", nodeId: node.id })}>{t("alert.addGroup")}</button>
      </div>
    </div>
  );
}

interface NestedLogicBuilderProps {
  expression: AlertExpressionDraft;
  onAction(action: AlertExpressionDraftAction): void;
}

function NestedLogicBuilder({ expression, onAction }: NestedLogicBuilderProps) {
  return (
    <div className="alert-logic-builder">
      {expression.type === "group" ? (
        <LogicGroupEditor node={expression} onAction={onAction} />
      ) : (
        <ConditionCard node={expression} index={`${t("alert.root")}.1`} onAction={onAction} canDelete={false} />
      )}
    </div>
  );
}

interface ExpirationAndNotificationProps {
  draft: AlertDraft;
  onDraftChange: Dispatch<SetStateAction<AlertDraft>>;
  availableChannels: string[];
}

function ExpirationAndNotification({ draft, onDraftChange, availableChannels }: ExpirationAndNotificationProps) {
  const [channelSetupMessage, setChannelSetupMessage] = useState("");
  const webhookAvailable = availableChannels.includes("webhook");
  const update = (patch: Partial<AlertDraft>) => onDraftChange((prev) => ({ ...prev, ...patch }));
  const updateChannel = (key: keyof AlertChannelState, checked: boolean) => {
    void (async () => {
      let enabled = checked;
      if (checked && key === "browser") {
        const permission = await requestBrowserAlertPermission();
        enabled = permission === "granted";
        setChannelSetupMessage(enabled ? t("alert.browserGranted") : t("alert.browserDenied", { permission }));
      } else if (checked && key === "sound") {
        enabled = await primeAlertSound();
        setChannelSetupMessage(enabled ? t("alert.soundOn") : t("alert.soundOff"));
      } else if (checked && key === "webhook" && !webhookAvailable) {
        enabled = false;
        setChannelSetupMessage(t("alert.webhookOff"));
      }
      onDraftChange((prev) => ({
        ...prev,
        channels: { ...prev.channels, [key]: enabled },
      }));
    })();
  };
  const updateAfterTrigger = (value: AlertDraft["afterTrigger"]) => {
    update({
      afterTrigger: value,
      ...(value === "keep" ? { maxTriggerMode: "unlimited" as const } : {}),
      ...(value === "pause" ? { maxTriggerMode: "once" as const } : {}),
    });
  };

  return (
    <div className="alert-two-column">
      <section className="alert-settings-card">
        <SectionHeader
          kicker={t("alert.step", { n: 4 })}
          title={t("alert.stepExpiry")}
          desc={t("alert.stepExpiryDesc")}
        />
        <div className="alert-form-grid single">
          <label className="alert-field">
            <span>{t("alert.when")}</span>
            <select value={draft.triggerOn} onChange={(event) => update({ triggerOn: event.target.value as AlertTriggerOn })}>
              {TRIGGER_OPTIONS.map((item) => <option key={item.value} value={item.value}>{t(item.labelKey)}</option>)}
            </select>
          </label>
          <label className="alert-field">
            <span>{t("alert.triggerCount")}</span>
            <select value={draft.maxTriggerMode} disabled={draft.afterTrigger !== "auto-disable"} onChange={(event) => update({ maxTriggerMode: event.target.value as AlertDraft["maxTriggerMode"] })}>
              <option value="once">{t("alert.once")}</option>
              <option value="3">{t("alert.threeTimes")}</option>
              <option value="custom">{t("alert.customCount")}</option>
              <option value="unlimited">{t("alert.unlimited")}</option>
            </select>
          </label>
          {draft.maxTriggerMode === "custom" && (
            <label className="alert-field">
              <span>{t("alert.customTimes")}</span>
              <input type="number" min="1" step="1" value={draft.customMaxTriggers} onChange={(event) => update({ customMaxTriggers: event.target.value })} />
            </label>
          )}
          <label className="alert-field">
            <span>{t("alert.timeExpiry")}</span>
            <select value={draft.expiresMode} onChange={(event) => update({ expiresMode: event.target.value as AlertDraft["expiresMode"] })}>
              <option value="1h">{t("alert.in1h")}</option>
              <option value="today">{t("alert.endOfDay")}</option>
              <option value="7d">{t("alert.in7d")}</option>
              <option value="custom">{t("alert.customDatetime")}</option>
              <option value="never">{t("alert.never")}</option>
            </select>
          </label>
          {draft.expiresMode === "custom" && (
            <label className="alert-field">
              <span>{t("alert.expiryTime")}</span>
              <input type="datetime-local" value={draft.customExpiresAt} onChange={(event) => update({ customExpiresAt: event.target.value })} />
            </label>
          )}
          <label className="alert-field">
            <span>{t("alert.afterTrigger")}</span>
            <select value={draft.afterTrigger} onChange={(event) => updateAfterTrigger(event.target.value as AlertDraft["afterTrigger"])}>
              <option value="auto-disable">{t("alert.autoDisable")}</option>
              <option value="keep">{t("alert.keepEnabled")}</option>
              <option value="pause">{t("alert.pauseAfter")}</option>
            </select>
          </label>
        </div>
      </section>

      <section className="alert-settings-card">
        <SectionHeader
          kicker={t("alert.step", { n: 5 })}
          title={t("alert.stepNotify")}
          desc={t("alert.stepNotifyDesc")}
        />
        <div className="alert-channel-grid">
          {CHANNEL_OPTIONS.map(({ key, titleKey, descKey }) => (
            <label key={key} className="alert-channel-card">
              <input
                type="checkbox"
                checked={Boolean(draft.channels?.[key])}
                disabled={key === "history" || (key === "webhook" && !webhookAvailable)}
                onChange={(event) => updateChannel(key, event.target.checked)}
              />
              <span>
                <strong>{t(titleKey)}</strong>
                <small>{key === "webhook" && !webhookAvailable ? t("alert.webhookDisabled") : t(descKey)}</small>
              </span>
            </label>
          ))}
        </div>
        {draft.channels.webhook && (
          <label className="alert-field alert-message-template">
            <span>{t("alert.webhookUrl")}</span>
            <input
              type="url"
              value={draft.webhookUrl}
              disabled={!webhookAvailable}
              placeholder="https://example.com/candlescope-alerts"
              onChange={(event) => update({ webhookUrl: event.target.value })}
            />
          </label>
        )}
        {channelSetupMessage && <div className="alert-channel-setup-message">{channelSetupMessage}</div>}
        <label className="alert-field alert-message-template">
          <span>{t("alert.messageTemplate")}</span>
          <textarea value={draft.messageTemplate} onChange={(event) => update({ messageTemplate: event.target.value })} rows={3} />
        </label>
        <label className="alert-field">
          <span>{t("alert.cooldown")}</span>
          <select value={draft.cooldownMode} onChange={(event) => update({ cooldownMode: event.target.value as AlertDraft["cooldownMode"] })}>
            <option value="always">{t("alert.notifyAlways")}</option>
            <option value="30s">{t("alert.cooldown30s")}</option>
            <option value="5m">{t("alert.cooldown5m")}</option>
            <option value="custom">{t("alert.custom")}</option>
          </select>
        </label>
        {draft.cooldownMode === "custom" && (
          <label className="alert-field">
            <span>{t("alert.cooldownSeconds")}</span>
            <input type="number" min="0" step="1" value={draft.customCooldownSeconds} onChange={(event) => update({ customCooldownSeconds: event.target.value })} />
          </label>
        )}
      </section>
    </div>
  );
}

interface RulePreviewProps {
  draft: AlertDraft;
  product: WatchlistAlertProduct | null;
  fallbackSymbol?: string;
  interval: string;
}

function RulePreview({ draft, product, fallbackSymbol, interval }: RulePreviewProps) {
  const symbol = product?.symbol || fallbackSymbol || "BTCUSDT";
  const maxTriggers = draft.maxTriggerMode === "unlimited"
    ? t("alert.unlimitedTriggers")
    : t("alert.maxTriggers", { count: draft.maxTriggerMode === "custom" ? draft.customMaxTriggers : (draft.maxTriggerMode === "3" ? 3 : 1) });
  return (
    <div className="alert-rule-preview-box">
      <div className="alert-preview-label">{t("alert.preview")}</div>
      <div className="alert-preview-text">
        {t("alert.previewBody", {
          symbol,
          interval,
          expression: describeAlertDraftExpression(draft.expression),
          maxTriggers,
          cooldown: draft.cooldownMode,
        })}
      </div>
    </div>
  );
}

interface AlertTraceNodeProps {
  node: AlertTraceNodeData | null;
  depth?: number;
}

function AlertTraceNode({ node, depth = 0 }: AlertTraceNodeProps) {
  if (!node) return null;
  const statusKeys = {
    matched: "alert.trace.matched",
    not_matched: "alert.trace.notMatched",
    missing_value: "alert.trace.missingValue",
    missing_previous: "alert.trace.missingPrevious",
    unsupported_comparator: "alert.trace.unsupported",
    invalid: "alert.trace.invalid",
  } as const;
  const statusKey = Object.prototype.hasOwnProperty.call(statusKeys, node.status)
    ? statusKeys[node.status as keyof typeof statusKeys]
    : null;
  const statusLabel = statusKey ? t(statusKey) : (node.status || "--");
  const details = node.details || {};
  const hasDetails = Object.keys(details).length > 0;
  return (
    <div className={`alert-test-trace-node depth-${Math.min(depth, 3)} ${node.result ? "is-true" : "is-false"}`}>
      <div className="alert-test-trace-main">
        <span className="alert-test-result-dot" />
        <div>
          <div className="alert-test-trace-title">{node.summary || t("alert.trace.condition")}</div>
          {hasDetails && (
            <div className="alert-test-trace-details">
              {t("alert.trace.details", { left: String(details.left ?? "--"), right: String(details.right ?? "--") })}
              {details.previousLeft !== undefined && t("alert.trace.prevLeft", { value: String(details.previousLeft ?? "--") })}
              {details.previousRight !== undefined && t("alert.trace.prevRight", { value: String(details.previousRight ?? "--") })}
              {details.rangeMin !== undefined && t("alert.trace.range", { min: String(details.rangeMin), max: String(details.rangeMax ?? "--") })}
              {details.percentChange !== undefined && t("alert.trace.pct", { pct: Number(details.percentChange).toFixed(2) })}
            </div>
          )}
        </div>
        <span className="alert-test-status">{statusLabel}</span>
      </div>
      {Array.isArray(node.children) && node.children.length > 0 && (
        <div className="alert-test-trace-children">
          {node.children.map((child) => (
            <AlertTraceNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

interface RuleTestPanelProps {
  testContext: AlertTestContext;
  testResult: AlertEvaluateResult | null;
  testLoading: boolean;
  onContextChange(bucket: TestContextBucket, key: TestValueField, value: string): void;
  onResetContext(): void;
  onRunTest(): void;
}

function RuleTestPanel({
  testContext,
  testResult,
  testLoading,
  onContextChange,
  onResetContext,
  onRunTest,
}: RuleTestPanelProps) {
  return (
    <section className="alert-editor-card alert-test-card">
      <SectionHeader
        kicker={t("alert.step", { n: 6 })}
        title={t("alert.stepTest")}
        desc={t("alert.stepTestDesc")}
        action={<span className={`alert-chip ${testResult?.result ? "success" : ""}`}>{testResult ? (testResult.result ? t("alert.testHit") : t("alert.testMiss")) : t("alert.untested")}</span>}
      />
      <div className="alert-test-grid">
        <div className="alert-test-column">
          <div className="alert-test-column-title">{t("alert.prevSample")}</div>
          {TEST_VALUE_FIELDS.map((field) => (
            <label key={`previous-${field.key}`} className="alert-field compact">
              <span>{field.labelKey ? t(field.labelKey) : field.label}</span>
              <input
                type="number"
                value={testContext.previous[field.key] ?? ""}
                onChange={(event) => onContextChange("previous", field.key, event.target.value)}
              />
            </label>
          ))}
        </div>
        <div className="alert-test-column">
          <div className="alert-test-column-title">{t("alert.currSample")}</div>
          {TEST_VALUE_FIELDS.map((field) => (
            <label key={`values-${field.key}`} className="alert-field compact">
              <span>{field.labelKey ? t(field.labelKey) : field.label}</span>
              <input
                type="number"
                value={testContext.values[field.key] ?? ""}
                onChange={(event) => onContextChange("values", field.key, event.target.value)}
              />
            </label>
          ))}
        </div>
      </div>
      <div className="alert-test-actions">
        <button className="alert-btn alert-btn-secondary" type="button" onClick={onResetContext} disabled={testLoading}>{t("alert.resetChart")}</button>
        <button className="alert-btn alert-btn-primary" type="button" onClick={onRunTest} disabled={testLoading}>
          {testLoading ? t("alert.testing") : t("alert.testRule")}
        </button>
      </div>
      {testResult && (
        <div className="alert-test-result">
          <div className="alert-test-summary">
            <strong>{testResult.result ? t("alert.testWouldFire") : t("alert.testWouldNotFire")}</strong>
            <span>{t("alert.testShared")}</span>
          </div>
          <AlertTraceNode node={testResult.trace} />
        </div>
      )}
    </section>
  );
}

interface RuleListCardProps {
  title: string;
  symbol: string;
  summary: string;
  status: string;
  expiry: string;
  channels: string;
  enabled: boolean;
  onToggle(): void;
  onDelete(): void;
  onDuplicate(): void;
  onEdit(): void;
  busy: boolean;
}

function RuleListCard({ title, symbol, summary, status, expiry, channels, enabled, onToggle, onDelete, onDuplicate, onEdit, busy }: RuleListCardProps) {
  return (
    <div className="alert-rule-card detailed">
      <div className="alert-rule-main">
        <span className="alert-rule-icon">🔔</span>
        <div className="alert-rule-copy">
          <div className="alert-rule-title">{title}</div>
          <div className="alert-rule-desc">{symbol} · {summary}</div>
          <div className="alert-rule-meta-row">
            <span>{status}</span>
            <span>{expiry}</span>
            <span>{channels}</span>
          </div>
        </div>
      </div>
      <div className="alert-card-actions">
        <button type="button" onClick={onEdit} disabled={busy}>{t("alert.edit")}</button>
        <button type="button" onClick={onDuplicate} disabled={busy}>{t("alert.duplicate")}</button>
        <button type="button" onClick={onToggle} disabled={busy}>{enabled ? t("alert.disable") : t("alert.enable")}</button>
        <button type="button" onClick={onDelete} disabled={busy}>{t("alert.delete")}</button>
      </div>
    </div>
  );
}

interface HistoryItemProps {
  time: string;
  symbol: string;
  title: string;
  value: string;
  channels: string;
  acknowledged: boolean;
  busy: boolean;
  onAcknowledge(): void;
  onViewRule?: () => void;
}

function HistoryItem({
  time,
  symbol,
  title,
  value,
  channels,
  acknowledged,
  busy,
  onAcknowledge,
  onViewRule,
}: HistoryItemProps) {
  return (
    <div className="alert-history-item">
      <div className="alert-timeline-dot" />
      <div className="alert-timeline-card">
        <div className="alert-timeline-title">{title}</div>
        <div className="alert-timeline-desc">{t("alert.firedValue", { symbol, value })}</div>
        <div className="alert-timeline-time">{time} · {channels}</div>
        <div className="alert-history-actions">
          <button type="button" onClick={onAcknowledge} disabled={busy}>
            {acknowledged ? t("alert.unack") : t("alert.ack")}
          </button>
          <button type="button" onClick={onViewRule} disabled={!onViewRule}>{t("alert.viewRule")}</button>
        </div>
      </div>
    </div>
  );
}

export interface AlertsPanelProps {
  isOpen: boolean;
  onClose(): void;
  currentSymbol?: string;
  currentMarketType?: string;
  currentExchange?: string;
  currentInterval?: string;
  displayPrice?: number | null;
  wsStatus?: string;
  watchlists?: WatchlistGroup[];
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.detail === "string" && record.detail) return record.detail;
    if (typeof record.message === "string" && record.message) return record.message;
  }
  return fallback;
}

export default function AlertsPanel({
  isOpen,
  onClose,
  currentSymbol,
  currentMarketType,
  currentExchange,
  currentInterval,
  displayPrice,
  wsStatus,
  watchlists = [],
}: AlertsPanelProps) {
  const locale = useLocale();
  const [tab, setTab] = useState<AlertTab>("add");
  const {
    width: panelWidth,
    isResizing,
    resizeHandleProps,
  } = useRightDrawerResize({
    initialWidth: 520,
    minWidth: 430,
    maxWidth: 780,
  });
  const [selectedProductKey, setSelectedProductKey] = useState("");
  const [selectedInterval, setSelectedInterval] = useState("");
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [history, setHistory] = useState<AlertHistoryEvent[]>([]);
  const [systemStatus, setSystemStatus] = useState<AlertSystemStatus | null>(null);
  const [alertLoading, setAlertLoading] = useState(false);
  const [alertSaving, setAlertSaving] = useState(false);
  const [alertError, setAlertError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<AlertStatusFilter>("all");
  const [historyRange, setHistoryRange] = useState<AlertHistoryRange>("7d");
  const [acknowledgementFilter, setAcknowledgementFilter] = useState<AlertAcknowledgementFilter>("all");
  const [editingRuleId, setEditingRuleId] = useState("");
  const [draft, setDraft] = useState(() => createDefaultAlertDraft({
    ...(currentSymbol === undefined ? {} : { symbol: currentSymbol }),
    interval: currentInterval || "1m",
    price: displayPrice,
  }));
  const [testContext, setTestContext] = useState(() => createDefaultTestContext(displayPrice));
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<AlertEvaluateResult | null>(null);

  const marketLabel = alertMarketLabel(currentMarketType) || "--";
  const formattedPrice = formatPrice(displayPrice);
  const normalizedExchange = currentExchange || "binance";
  const symbolLabel = currentSymbol || "--";
  const intervalLabel = currentInterval || "--";

  const watchlistProducts = useMemo(() => buildWatchlistProducts(watchlists, locale), [locale, watchlists]);
  const currentProductKey = buildProductKey({
    ...(currentSymbol === undefined ? {} : { symbol: currentSymbol }),
    ...(currentMarketType === undefined ? {} : { marketType: currentMarketType }),
    ...(currentExchange === undefined ? {} : { exchange: currentExchange }),
  });
  const alertProducts = useMemo(() => {
    const products = new Map<string, WatchlistAlertProduct>();
    for (const item of watchlistProducts) products.set(item.key, { ...item, listNames: [...item.listNames] });

    let currentChartProduct: WatchlistAlertProduct | null = null;
    if (currentSymbol) {
      const existing = products.get(currentProductKey);
      currentChartProduct = {
        symbol: currentSymbol.toUpperCase(),
        marketType: currentMarketType || "spot",
        exchange: normalizedExchange,
        key: currentProductKey,
        listNames: Array.from(new Set([t("alert.currentChart", {}, locale), ...(existing?.listNames || [])])),
        color: existing?.color || "#3b82f6",
      };
      products.delete(currentProductKey);
    }

    for (const rule of rules) {
      const target = rule.target;
      if (!target?.symbol) continue;
      const key = buildProductKey(target);
      if (key === currentProductKey || products.has(key)) continue;
      products.set(key, {
        symbol: target.symbol,
        marketType: target.marketType || "spot",
        exchange: target.exchange || "binance",
        key,
        listNames: [t("alert.existingRules", {}, locale)],
        color: "#64748b",
      });
    }

    return [
      ...(currentChartProduct ? [currentChartProduct] : []),
      ...Array.from(products.values()).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    ];
  }, [currentMarketType, currentProductKey, currentSymbol, locale, normalizedExchange, rules, watchlistProducts]);
  const selectedProductExists = alertProducts.some((item) => item.key === selectedProductKey);
  const defaultProductKey = currentSymbol ? currentProductKey : (alertProducts[0]?.key || "");
  const effectiveSelectedProductKey = selectedProductExists ? selectedProductKey : defaultProductKey;
  const selectedProduct = alertProducts.find((item) => item.key === effectiveSelectedProductKey) || null;
  const effectiveInterval = selectedInterval || (intervalLabel !== "--" ? intervalLabel : "1m");
  const canCreateAlert = Boolean(selectedProduct?.symbol || currentSymbol) && !alertSaving;
  const editorModeLabel = editingRuleId ? t("alert.update") : t("alert.create");
  const runtimeRuleStates = useMemo(() => systemStatus?.runtime.rules || [], [systemStatus]);
  const runtimeRuleStateById = useMemo(
    () => new Map(runtimeRuleStates.map((item) => [item.ruleId, item])),
    [runtimeRuleStates],
  );
  const warmingRuleCount = runtimeRuleStates.filter((item) => item.state === "warming").length;
  const degradedRuleCount = runtimeRuleStates.filter((item) => ["degraded", "recovering"].includes(item.state)).length;
  const runtimeStatusLabel = systemStatus?.runtime.status === "running"
    ? `${t("alert.runtimeOk", { count: systemStatus.runtime.subscriptions.length })}${warmingRuleCount ? t("alert.runtimeWarming", { count: warmingRuleCount }) : ""}`
    : (systemStatus?.runtime.status === "error"
      ? `${t("alert.runtimeBad")}${degradedRuleCount ? t("alert.runtimeRecovering", { count: degradedRuleCount }) : ""}`
      : t("alert.runtimeUnavailable"));
  const deliveryStatusLabel = systemStatus?.webhook.enabled
    ? (systemStatus.webhook.ready
      ? t("alert.webhookQueue", {
          queued: systemStatus.outbox.queued,
          retrying: systemStatus.outbox.retrying,
          dead: systemStatus.outbox.deadLetter,
        })
      : t("alert.webhookConfig", { error: systemStatus.webhook.configurationError || t("alert.unknownError") }))
    : t("alert.webhookDefaultOff");

  const historySinceMs = useMemo(() => {
    const now = new Date();
    if (historyRange === "today") {
      now.setHours(0, 0, 0, 0);
      return now.getTime();
    }
    const days = historyRange === "30d" ? 30 : 7;
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }, [historyRange]);

  const loadAlerts = useCallback(async (signal?: AbortSignal) => {
    setAlertLoading(true);
    setAlertError("");
    try {
      const requestOptions = signal === undefined ? {} : { signal };
      const [nextRules, nextHistory] = await Promise.all([
        fetchAlertRules(requestOptions),
        fetchAlertHistory({
          limit: 100,
          sinceMs: historySinceMs,
          ...(acknowledgementFilter === "all"
            ? {}
            : { acknowledged: acknowledgementFilter === "ack" }),
        }, requestOptions),
      ]);
      setRules(Array.isArray(nextRules) ? nextRules : []);
      setHistory(Array.isArray(nextHistory) ? nextHistory : []);
      try {
        setSystemStatus(await fetchAlertStatus(requestOptions));
      } catch (statusError: unknown) {
        setSystemStatus(null);
        console.warn(t("alert.statusReadFailed"), statusError);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAlertError(errorMessage(err, t("alert.loadFailed")));
    } finally {
      setAlertLoading(false);
    }
  }, [acknowledgementFilter, historySinceMs]);

  const filteredRules = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return rules.filter((rule) => {
      if (statusFilter === "enabled" && !rule.enabled) return false;
      if (statusFilter === "paused" && rule.enabled) return false;
      if (statusFilter === "expired") {
        const expiresAt = Number(rule.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) return false;
      }
      if (!needle) return true;
      const target = rule.target || {};
      return [
        rule.name,
        rule.description,
        target.symbol,
        target.exchange,
        target.marketType,
        describeAlertRule(rule),
        describeAlertChannels(rule),
      ].some((value) => String(value || "").toLowerCase().includes(needle));
    });
  }, [rules, searchTerm, statusFilter]);

  const ruleById = useMemo(() => new Map(rules.map((rule) => [rule.id, rule])), [rules]);

  const filteredHistory = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) return history;
    return history.filter((event) => {
      const rule = ruleById.get(event.ruleId);
      const target = event.target || rule?.target || {};
      return [
        event.message,
        event.ruleId,
        target.symbol,
        rule?.name,
        JSON.stringify(event.values || {}),
      ].some((value) => String(value || "").toLowerCase().includes(needle));
    });
  }, [history, ruleById, searchTerm]);

  const resetDraft = useCallback(() => {
    setEditingRuleId("");
    setDraft(createDefaultAlertDraft({
      ...((selectedProduct?.symbol || currentSymbol) === undefined
        ? {}
        : { symbol: selectedProduct?.symbol || currentSymbol }),
      interval: effectiveInterval,
      price: displayPrice,
    }));
    setTestResult(null);
    setTab("add");
  }, [currentSymbol, displayPrice, effectiveInterval, selectedProduct]);

  const applyExpressionAction = useCallback((action: AlertExpressionDraftAction) => {
    setDraft((prev) => ({
      ...prev,
      expression: expressionDraftReducer(prev.expression, action),
    }));
    setTestResult(null);
  }, []);

  const updateTestContext = useCallback((bucket: TestContextBucket, key: TestValueField, value: string) => {
    setTestContext((prev) => ({
      ...prev,
      [bucket]: {
        ...(prev[bucket] || {}),
        [key]: value,
      },
    }));
    setTestResult(null);
  }, []);

  const resetTestContext = useCallback(() => {
    setTestContext(createDefaultTestContext(displayPrice));
    setTestResult(null);
  }, [displayPrice]);

  const runRuleTest = useCallback(async () => {
    if (!canCreateAlert) return;
    setTestLoading(true);
    setAlertError("");
    try {
      const payload = buildAlertPayloadFromDraft({
        draft,
        product: selectedProduct,
        ...(currentSymbol === undefined ? {} : { fallbackSymbol: currentSymbol }),
        ...(currentMarketType === undefined ? {} : { fallbackMarketType: currentMarketType }),
        fallbackExchange: normalizedExchange,
        interval: effectiveInterval,
      });
      const result = await evaluateAlertExpression({
        expression: payload.expression,
        context: normalizeTestContext(testContext),
      });
      setTestResult(result);
    } catch (err: unknown) {
      setAlertError(errorMessage(err, t("alert.testFailed")));
    } finally {
      setTestLoading(false);
    }
  }, [
    canCreateAlert,
    currentMarketType,
    currentSymbol,
    draft,
    effectiveInterval,
    normalizedExchange,
    selectedProduct,
    testContext,
  ]);

  const createCurrentAlert = useCallback(async () => {
    if (!canCreateAlert) return;
    setAlertSaving(true);
    setAlertError("");
    try {
      const payload = buildAlertPayloadFromDraft({
        draft,
        product: selectedProduct,
        ...(currentSymbol === undefined ? {} : { fallbackSymbol: currentSymbol }),
        ...(currentMarketType === undefined ? {} : { fallbackMarketType: currentMarketType }),
        fallbackExchange: normalizedExchange,
        interval: effectiveInterval,
      });
      if (editingRuleId) {
        await updateAlertRule(editingRuleId, payload);
      } else {
        await createAlertRule(payload);
      }
      await loadAlerts();
      setEditingRuleId("");
      setTab("all");
    } catch (err: unknown) {
      setAlertError(errorMessage(err, t("alert.saveFailed", { action: editorModeLabel })));
    } finally {
      setAlertSaving(false);
    }
  }, [
    canCreateAlert,
    currentMarketType,
    currentSymbol,
    draft,
    editingRuleId,
    editorModeLabel,
    effectiveInterval,
    loadAlerts,
    normalizedExchange,
    selectedProduct,
  ]);

  const editRule = useCallback((rule: AlertRule) => {
    if (!rule?.id) return;
    const target = rule.target || {};
    setEditingRuleId(rule.id);
    setDraft(createDraftFromRule(rule));
    setTestResult(null);
    setSelectedInterval(target.interval || "");
    const nextProductKey = buildProductKey({
      symbol: target.symbol,
      marketType: target.marketType,
      exchange: target.exchange,
    });
    if (alertProducts.some((item) => item.key === nextProductKey)) {
      setSelectedProductKey(nextProductKey);
    }
    setTab("add");
  }, [alertProducts]);

  const toggleRule = useCallback(async (rule: AlertRule) => {
    if (!rule?.id) return;
    setAlertSaving(true);
    setAlertError("");
    try {
      const updated = await setAlertRuleEnabled(rule.id, !rule.enabled);
      setRules((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      await loadAlerts();
    } catch (err: unknown) {
      setAlertError(errorMessage(err, t("alert.statusFailed")));
    } finally {
      setAlertSaving(false);
    }
  }, [loadAlerts]);

  const removeRule = useCallback(async (rule: AlertRule) => {
    if (!rule?.id) return;
    setAlertSaving(true);
    setAlertError("");
    try {
      await deleteAlertRule(rule.id);
      setRules((prev) => prev.filter((item) => item.id !== rule.id));
    } catch (err: unknown) {
      setAlertError(errorMessage(err, t("alert.deleteFailed")));
    } finally {
      setAlertSaving(false);
    }
  }, []);

  const acknowledgeEvent = useCallback(async (event: AlertHistoryEvent) => {
    setAlertSaving(true);
    setAlertError("");
    try {
      const updated = await setAlertHistoryAcknowledged(event.id, event.acknowledgedAt === null);
      setHistory((current) => {
        if (acknowledgementFilter === "unread" && updated.acknowledgedAt !== null) {
          return current.filter((item) => item.id !== updated.id);
        }
        if (acknowledgementFilter === "ack" && updated.acknowledgedAt === null) {
          return current.filter((item) => item.id !== updated.id);
        }
        return current.map((item) => (item.id === updated.id ? updated : item));
      });
    } catch (err: unknown) {
      setAlertError(errorMessage(err, t("alert.ackFailed")));
    } finally {
      setAlertSaving(false);
    }
  }, [acknowledgementFilter]);

  const duplicateRule = useCallback(async (rule: AlertRule) => {
    if (!rule) return;
    setAlertSaving(true);
    setAlertError("");
    try {
      const { id, createdAt, updatedAt, triggerCount, lastTriggeredAt, ...payload } = rule;
      void id;
      void createdAt;
      void updatedAt;
      void triggerCount;
      void lastTriggeredAt;
      await createAlertRule({
        ...payload,
        name: t("alert.copyName", { name: rule.name || t("alert.fallbackName") }),
        enabled: false,
      });
      await loadAlerts();
    } catch (err: unknown) {
      setAlertError(errorMessage(err, t("alert.copyFailed")));
    } finally {
      setAlertSaving(false);
    }
  }, [loadAlerts]);

  useEffect(() => {
    if (intervalLabel && intervalLabel !== "--") {
      setSelectedInterval((prev) => prev || intervalLabel);
    }
  }, [intervalLabel]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const controller = new AbortController();
    void loadAlerts(controller.signal);
    return () => controller.abort();
  }, [isOpen, loadAlerts]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const refreshTriggeredRule = () => {
      void loadAlerts();
    };
    window.addEventListener(ALERT_RULE_STATE_CHANGED_EVENT, refreshTriggeredRule);
    return () => {
      window.removeEventListener(ALERT_RULE_STATE_CHANGED_EVENT, refreshTriggeredRule);
    };
  }, [isOpen, loadAlerts]);

  if (!isOpen) return null;

  return (
    <div className={`alert-panel-overlay right-drawer-overlay ${isResizing ? "is-resizing" : ""}`}>
      <aside
        className="alert-panel"
        style={{ width: `${panelWidth}px` }}
      >
        <div
          {...resizeHandleProps}
          className="right-drawer-resize-handle"
          aria-label={t("rail.resizeWidth")}
        />

        <div className="alert-panel-header">
          <div>
            <h3 className="alert-panel-title">
              {t("alert.center")}
              <span className="alert-layout-pill">{t("alert.ruleCount", { count: rules.length })}</span>
            </h3>
            <div className="alert-panel-subtitle">{t("alert.subtitle")}</div>
            <div className={`alert-runtime-status status-${systemStatus?.runtime.status || "unknown"}`}>
              {runtimeStatusLabel}
            </div>
            <div className="alert-panel-subtitle">{deliveryStatusLabel}</div>
          </div>
          <button
            className="alert-panel-close"
            onClick={onClose}
            type="button"
            aria-label={t("alert.closePanel")}
          >
            ✕
          </button>
        </div>

        <div className="alert-context-card">
          <div className="alert-context-heading">
            <span>{symbolLabel}</span>
            <span className="alert-context-market">{marketLabel}</span>
          </div>
          <div className="alert-context-grid">
            <ContextMetric label={t("alert.exchange")} value={normalizedExchange.toUpperCase()} />
            <ContextMetric label={t("alert.interval")} value={intervalLabel} />
            <ContextMetric label={t("alert.price")} value={formattedPrice} tone="price" />
            <ContextMetric label={t("alert.realtime")} value={wsStatus || "idle"} />
          </div>
        </div>

        <div className="alert-tab-bar">
          {TAB_OPTIONS.map((item) => (
            <button
              key={item.key}
              className={`alert-tab ${tab === item.key ? "active" : ""}`}
              onClick={() => setTab(item.key)}
              type="button"
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        {(alertError || alertLoading) && (
          <div className="alert-guidance-box">
            <div>
              <strong>{alertError ? t("alert.systemHint") : t("alert.syncing")}</strong>
              <span>{alertError || t("alert.syncingDesc")}</span>
            </div>
            <button className="alert-btn alert-btn-secondary" type="button" onClick={() => loadAlerts()} disabled={alertLoading}>
              {t("alert.refresh")}
            </button>
          </div>
        )}

        <div className="alert-panel-content">
          {tab === "add" && (
            <div className="alert-section-stack">
              <section className="alert-editor-card alert-product-section">
                <SectionHeader
                  kicker={t("alert.step", { n: 1 })}
                  title={t("alert.stepSymbol")}
                  desc={t("alert.stepSymbolDesc")}
                  action={<span className="alert-chip">{t("alert.currentOrWatchlist")}</span>}
                />

                <ProductSummary
                  product={selectedProduct}
                  fallbackSymbol={symbolLabel}
                  {...(currentMarketType === undefined ? {} : { fallbackMarketType: currentMarketType })}
                  fallbackExchange={normalizedExchange}
                />

                {alertProducts.length > 0 ? (
                  <div className="alert-product-picker-row">
                    <label className="alert-field">
                      <span>{t("alert.product")}</span>
                      <select value={effectiveSelectedProductKey} onChange={(event) => setSelectedProductKey(event.target.value)}>
                        {alertProducts.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.symbol} · {formatMarket(item.exchange, item.marketType)} · {item.listNames.join(" / ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="alert-field small">
                      <span>{t("alert.interval")}</span>
                      <select value={effectiveInterval} onChange={(event) => setSelectedInterval(event.target.value)}>
                        {Array.from(new Set([intervalLabel, "1m", "5m", "15m", "1h", "4h", "1d"].filter(Boolean))).map((item) => (
                          <option key={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : (
                  <div className="alert-empty-state compact">
                    <div className="alert-empty-icon">☆</div>
                    <div className="alert-empty-title">{t("alert.noProducts")}</div>
                    <div className="alert-empty-desc">{t("alert.noProductsDesc")}</div>
                  </div>
                )}

                <div className="alert-form-grid single alert-draft-meta">
                  <label className="alert-field">
                    <span>{t("alert.ruleName")}</span>
                    <input value={draft.name} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} />
                  </label>
                  <label className="alert-field">
                    <span>{t("alert.ruleDesc")}</span>
                    <textarea value={draft.description} onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))} rows={2} />
                  </label>
                </div>
              </section>

              <section className="alert-editor-card">
                <SectionHeader
                  kicker={t("alert.step", { n: "2-3" })}
                  title={t("alert.stepLogic")}
                  desc={t("alert.stepLogicDesc")}
                  action={<span className="alert-chip">{t("alert.tree")}</span>}
                />
                <NestedLogicBuilder expression={draft.expression} onAction={applyExpressionAction} />
              </section>

              <ExpirationAndNotification
                draft={draft}
                onDraftChange={setDraft}
                availableChannels={systemStatus?.registeredChannels || []}
              />

              <RulePreview
                draft={draft}
                product={selectedProduct}
                fallbackSymbol={symbolLabel}
                interval={intervalLabel}
              />

              <RuleTestPanel
                testContext={testContext}
                testResult={testResult}
                testLoading={testLoading}
                onContextChange={updateTestContext}
                onResetContext={resetTestContext}
                onRunTest={runRuleTest}
              />

              <div className="alert-editor-actions sticky-actions">
                <button className="alert-btn alert-btn-secondary" type="button" onClick={resetDraft} disabled={alertSaving}>{t("alert.newDraft")}</button>
                <button className="alert-btn alert-btn-secondary" type="button" onClick={() => loadAlerts()} disabled={alertLoading || alertSaving}>{t("alert.refreshRules")}</button>
                <button className="alert-btn alert-btn-primary" type="button" onClick={createCurrentAlert} disabled={!canCreateAlert}>
                  {alertSaving ? t("alert.saving") : editorModeLabel}
                </button>
              </div>
            </div>
          )}

          {tab === "all" && (
            <div className="alert-section-stack">
              <div className="alert-toolbar-row no-margin">
                <input
                  className="alert-search"
                  placeholder={t("alert.searchPlaceholder")}
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
                <select className="alert-filter-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AlertStatusFilter)}>
                  <option value="all">{t("alert.statusAll")}</option>
                  <option value="enabled">{t("alert.statusEnabled")}</option>
                  <option value="paused">{t("alert.statusPaused")}</option>
                  <option value="expired">{t("alert.statusExpired")}</option>
                </select>
                <button className="alert-btn alert-btn-secondary" type="button" onClick={() => loadAlerts()} disabled={alertLoading}>{t("alert.refresh")}</button>
                <button className="alert-btn alert-btn-primary" type="button" onClick={resetDraft}>{t("alert.addAlert")}</button>
              </div>

              <div className="alert-filter-chip-row">
                <span>{t("alert.colWatchlist")}</span>
                <span>{t("alert.colSymbol")}</span>
                <span>{t("alert.colCondition")}</span>
                <span>{t("alert.colExpiry")}</span>
                <span>{t("alert.colChannel")}</span>
              </div>

              {filteredRules.map((rule) => (
                <RuleListCard
                  key={rule.id}
                  title={rule.name}
                  symbol={rule.target?.symbol || "--"}
                  summary={describeAlertRule(rule)}
                  status={`${alertRuntimeRuleStateLabel(runtimeRuleStateById.get(rule.id)?.state, rule.enabled)} · ${t("alert.triggeredTimes", { count: rule.triggerCount || 0 })}`}
                  expiry={rule.maxTriggers ? t("alert.maxN", { count: rule.maxTriggers }) : t("alert.noLimit")}
                  channels={describeAlertChannels(rule)}
                  enabled={rule.enabled}
                  busy={alertSaving}
                  onEdit={() => editRule(rule)}
                  onToggle={() => toggleRule(rule)}
                  onDuplicate={() => duplicateRule(rule)}
                  onDelete={() => {
                    if (window.confirm(t("alert.deleteConfirm", { name: rule.name }))) void removeRule(rule);
                  }}
                />
              ))}

              {filteredRules.length === 0 && (
                <div className="alert-empty-state compact">
                  <div className="alert-empty-title">{rules.length === 0 ? t("alert.empty") : t("alert.noMatch")}</div>
                  <div className="alert-empty-desc">{t("alert.emptyDesc")}</div>
                </div>
              )}
            </div>
          )}

          {tab === "history" && (
            <div className="alert-section-stack">
              <div className="alert-toolbar-row no-margin">
                <input
                  className="alert-search"
                  placeholder={t("alert.filterPlaceholder")}
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
                <select className="alert-filter-select" value={historyRange} onChange={(event) => setHistoryRange(event.target.value as AlertHistoryRange)}>
                  <option value="today">{t("alert.today")}</option>
                  <option value="7d">{t("alert.last7d")}</option>
                  <option value="30d">{t("alert.last30d")}</option>
                </select>
                <select className="alert-filter-select" value={acknowledgementFilter} onChange={(event) => setAcknowledgementFilter(event.target.value as AlertAcknowledgementFilter)}>
                  <option value="all">{t("alert.allRecords")}</option>
                  <option value="unread">{t("alert.unread")}</option>
                  <option value="ack">{t("alert.acked")}</option>
                </select>
                <button className="alert-btn alert-btn-secondary" type="button" onClick={() => loadAlerts()} disabled={alertLoading}>{t("alert.refreshHistory")}</button>
              </div>

              <div className="alert-history-list">
                {filteredHistory.map((event) => {
                  const rule = ruleById.get(event.ruleId);
                  const target = event.target || rule?.target || {};
                  const values = event.values || {};
                  const valueText = values.close ?? values.value ?? Object.values(values)[0] ?? "--";
                  return (
                    <HistoryItem
                      key={event.id}
                      time={formatAlertTime(event.createdAt)}
                      symbol={target.symbol || rule?.target?.symbol || "--"}
                      title={event.message || t("alert.hitTitle", { name: rule?.name || t("alert.fallbackName") })}
                      value={String(valueText)}
                      channels={describeAlertDispatch(event)}
                      acknowledged={event.acknowledgedAt !== null}
                      busy={alertSaving}
                      onAcknowledge={() => { void acknowledgeEvent(event); }}
                      {...(rule
                        ? {
                            onViewRule: () => {
                              setSearchTerm(rule.name || rule.id);
                              setTab("all");
                            },
                          }
                        : {})}
                    />
                  );
                })}
              </div>

              {filteredHistory.length === 0 && (
                <div className="alert-empty-state compact">
                  <div className="alert-empty-title">{t("alert.noHistory")}</div>
                  <div className="alert-empty-desc">{t("alert.noHistoryDesc")}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
