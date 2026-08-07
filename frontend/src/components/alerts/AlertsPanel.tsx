import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "../../features/alerts/alertRuleModel";
import {
  ALERT_RULE_STATE_CHANGED_EVENT,
  primeAlertSound,
  requestBrowserAlertPermission,
} from "../../features/alerts/alertDeliveryClient.js";
import { parseSymbolKey } from "../../utils/symbolKey";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
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

const MARKET_LABELS: Record<string, string> = {
  spot: "现货",
  futures: "合约",
};

const TAB_OPTIONS: Array<{ key: AlertTab; label: string }> = [
  { key: "add", label: "添加警报" },
  { key: "all", label: "全部警报" },
  { key: "history", label: "触发历史" },
];

const TRIGGER_OPTIONS: Array<{ value: AlertTriggerOn; label: string }> = [
  { value: "realtime", label: "实时更新" },
  { value: "bar_update", label: "K线更新中" },
  { value: "bar_close", label: "K线收盘" },
];

const CHANNEL_OPTIONS: Array<{ key: keyof AlertChannelState; title: string; desc: string }> = [
  { key: "in_app", title: "应用内提示", desc: "右上角 Toast" },
  { key: "browser", title: "浏览器通知", desc: "需要授权后启用" },
  { key: "sound", title: "声音提醒", desc: "默认关闭" },
  { key: "webhook", title: "Webhook", desc: "持久队列与签名投递" },
  { key: "history", title: "触发历史", desc: "始终记录" },
];

const TEST_VALUE_FIELDS: Array<{ key: TestValueField; label: string }> = [
  { key: "close", label: "收盘价" },
  { key: "last", label: "最新价" },
  { key: "rsi", label: "RSI(14)" },
  { key: "macdHist", label: "MACD Hist" },
  { key: "ma20", label: "MA(20)" },
  { key: "volume", label: "成交量" },
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
  return `${ex} · ${MARKET_LABELS[marketType || ""] || marketType || "现货"}`;
}

function buildProductKey({ symbol, marketType, exchange }: AlertProductInput): string {
  return `${exchange || "binance"}:${marketType || "spot"}:${symbol || ""}`;
}

function buildWatchlistProducts(watchlists: WatchlistGroup[] = []): WatchlistAlertProduct[] {
  const productMap = new Map<string, WatchlistAlertProduct>();
  for (const list of watchlists) {
    const symbols = Array.isArray(list?.symbols) ? list.symbols : [];
    for (const rawKey of symbols) {
      const parsed = parseSymbolKey(rawKey);
      if (!parsed.symbol) continue;
      const key = buildProductKey(parsed);
      const existing = productMap.get(key);
      if (existing) {
        existing.listNames.push(list.name || "自选列表");
        continue;
      }
      productMap.set(key, {
        ...parsed,
        key,
        listNames: [list.name || "自选列表"],
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
  const labels: Record<string, string> = {
    ready: "就绪",
    warming: "指标预热中",
    recovering: "连接恢复中",
    degraded: "运行异常",
    disabled: "已停用",
    expired: "已过期",
    exhausted: "已达到触发上限",
  };
  if (state && labels[state]) return labels[state];
  return enabled ? "等待运行状态" : "已停用";
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
        <span className="alert-condition-index">条件 {index}</span>
        <div className="alert-inline-actions">
          <label className="alert-not-toggle">
            <input type="checkbox" checked={Boolean(node.not)} onChange={(event) => update({ not: event.target.checked })} />
            <span>NOT</span>
          </label>
          <button type="button" onClick={() => onAction({ type: "duplicate-node", nodeId: node.id })}>复制</button>
          <button type="button" onClick={() => onAction({ type: "delete-node", nodeId: node.id })} disabled={!canDelete}>删除</button>
        </div>
      </div>
      <div className="alert-condition-grid">
        <label className="alert-field compact">
          <span>左值</span>
          <select value={node.left} onChange={(event) => update({ left: event.target.value })}>
            {ALERT_SOURCE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="alert-field compact">
          <span>操作符</span>
          <select value={node.comparator} onChange={(event) => updateComparator(event.target.value as AlertComparator)}>
            {ALERT_COMPARATOR_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {isRangeComparator ? (
          <>
            <label className="alert-field compact">
              <span>区间下限</span>
              <input type="number" value={node.rangeMin} onChange={(event) => update({ rangeMin: event.target.value })} />
            </label>
            <label className="alert-field compact">
              <span>区间上限</span>
              <input type="number" value={node.rangeMax} onChange={(event) => update({ rangeMax: event.target.value })} />
            </label>
          </>
        ) : isPercentComparator ? (
          <label className="alert-field compact alert-field-wide">
            <span>变化阈值（%）</span>
            <input type="number" value={node.percentValue} onChange={(event) => update({ percentValue: event.target.value })} />
          </label>
        ) : (
          <>
            <label className="alert-field compact">
              <span>右值类型</span>
              <select value={node.rightType} onChange={(event) => update({ rightType: event.target.value as AlertConditionDraft["rightType"], rightValue: event.target.value === "number" ? node.rightValue : "close" })}>
                {ALERT_RIGHT_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="alert-field compact">
              <span>右值</span>
              {node.rightType === "number" ? (
                <input type="number" value={node.rightValue} onChange={(event) => update({ rightValue: event.target.value })} />
              ) : (
                <select value={node.rightValue || "close"} onChange={(event) => update({ rightValue: event.target.value })}>
                  {sourceChoices.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
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

function LogicGroupEditor({ node, onAction, depth = 0, path = "根", canDelete = false }: LogicGroupEditorProps) {
  const update = (patch: Partial<AlertGroupDraft>) => onAction({ type: "update-node", nodeId: node.id, patch });
  const children = Array.isArray(node.children) ? node.children : [];

  return (
    <div className={`alert-logic-group ${depth === 0 ? "root" : "nested"}`}>
      <div className={`alert-logic-group-header ${depth > 0 ? "compact" : ""}`}>
        <div>
          <div className="alert-logic-title">{path}逻辑组</div>
          <div className="alert-logic-desc">{children.length} 个子节点，组内按 {node.op || "AND"} 判断</div>
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
          <button type="button" onClick={() => onAction({ type: "duplicate-node", nodeId: node.id })} disabled={depth === 0}>复制组</button>
          <button type="button" onClick={() => onAction({ type: "delete-node", nodeId: node.id })} disabled={!canDelete}>删除组</button>
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
              path={`${path}.${index + 1}`}
              canDelete={children.length > 1}
            />
          ) : (
            <ConditionCard
              node={child}
              index={`${path}.${index + 1}`}
              onAction={onAction}
              canDelete={children.length > 1}
            />
          )}
        </div>
      ))}

      <div className="alert-logic-footer">
        <button className="alert-btn alert-btn-secondary" type="button" onClick={() => onAction({ type: "add-condition", nodeId: node.id })}>+ 添加条件</button>
        <button className="alert-btn alert-btn-secondary" type="button" onClick={() => onAction({ type: "add-group", nodeId: node.id })}>+ 添加子组</button>
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
        <ConditionCard node={expression} index="根.1" onAction={onAction} canDelete={false} />
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
        setChannelSetupMessage(enabled ? "浏览器通知权限已授权。" : `浏览器通知未启用：${permission}。`);
      } else if (checked && key === "sound") {
        enabled = await primeAlertSound();
        setChannelSetupMessage(enabled ? "声音提醒已解锁。" : "当前浏览器无法启用声音提醒。");
      } else if (checked && key === "webhook" && !webhookAvailable) {
        enabled = false;
        setChannelSetupMessage("Webhook 尚未在后端启用或签名密钥未配置。");
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
          kicker="步骤 4"
          title="到期条件"
          desc="按触发次数或时间自动停用。"
        />
        <div className="alert-form-grid single">
          <label className="alert-field">
            <span>触发时机</span>
            <select value={draft.triggerOn} onChange={(event) => update({ triggerOn: event.target.value as AlertTriggerOn })}>
              {TRIGGER_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="alert-field">
            <span>触发次数</span>
            <select value={draft.maxTriggerMode} disabled={draft.afterTrigger !== "auto-disable"} onChange={(event) => update({ maxTriggerMode: event.target.value as AlertDraft["maxTriggerMode"] })}>
              <option value="once">仅一次</option>
              <option value="3">3 次</option>
              <option value="custom">自定义次数</option>
              <option value="unlimited">无限制</option>
            </select>
          </label>
          {draft.maxTriggerMode === "custom" && (
            <label className="alert-field">
              <span>自定义次数</span>
              <input type="number" min="1" step="1" value={draft.customMaxTriggers} onChange={(event) => update({ customMaxTriggers: event.target.value })} />
            </label>
          )}
          <label className="alert-field">
            <span>时间到期</span>
            <select value={draft.expiresMode} onChange={(event) => update({ expiresMode: event.target.value as AlertDraft["expiresMode"] })}>
              <option value="1h">1 小时后</option>
              <option value="today">当天结束</option>
              <option value="7d">7 天后</option>
              <option value="custom">自定义日期时间</option>
              <option value="never">永不过期</option>
            </select>
          </label>
          {draft.expiresMode === "custom" && (
            <label className="alert-field">
              <span>到期时间</span>
              <input type="datetime-local" value={draft.customExpiresAt} onChange={(event) => update({ customExpiresAt: event.target.value })} />
            </label>
          )}
          <label className="alert-field">
            <span>触发后行为</span>
            <select value={draft.afterTrigger} onChange={(event) => updateAfterTrigger(event.target.value as AlertDraft["afterTrigger"])}>
              <option value="auto-disable">达到限制后自动停用</option>
              <option value="keep">始终保持启用</option>
              <option value="pause">触发后暂停</option>
            </select>
          </label>
        </div>
      </section>

      <section className="alert-settings-card">
        <SectionHeader
          kicker="步骤 5"
          title="通知方式"
          desc="选择发送什么通知，以及如何发送。"
        />
        <div className="alert-channel-grid">
          {CHANNEL_OPTIONS.map(({ key, title, desc }) => (
            <label key={key} className="alert-channel-card">
              <input
                type="checkbox"
                checked={Boolean(draft.channels?.[key])}
                disabled={key === "history" || (key === "webhook" && !webhookAvailable)}
                onChange={(event) => updateChannel(key, event.target.checked)}
              />
              <span>
                <strong>{title}</strong>
                <small>{key === "webhook" && !webhookAvailable ? "后端功能开关关闭" : desc}</small>
              </span>
            </label>
          ))}
        </div>
        {draft.channels.webhook && (
          <label className="alert-field alert-message-template">
            <span>Webhook HTTPS 地址</span>
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
          <span>消息模板</span>
          <textarea value={draft.messageTemplate} onChange={(event) => update({ messageTemplate: event.target.value })} rows={3} />
        </label>
        <label className="alert-field">
          <span>通知冷却</span>
          <select value={draft.cooldownMode} onChange={(event) => update({ cooldownMode: event.target.value as AlertDraft["cooldownMode"] })}>
            <option value="always">每次触发都通知</option>
            <option value="30s">冷却 30 秒</option>
            <option value="5m">冷却 5 分钟</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        {draft.cooldownMode === "custom" && (
          <label className="alert-field">
            <span>冷却秒数</span>
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
    ? "无限制触发"
    : `最多触发 ${draft.maxTriggerMode === "custom" ? draft.customMaxTriggers : (draft.maxTriggerMode === "3" ? 3 : 1)} 次`;
  return (
    <div className="alert-rule-preview-box">
      <div className="alert-preview-label">规则摘要预览</div>
      <div className="alert-preview-text">
        {symbol} {interval}：当 {describeAlertDraftExpression(draft.expression)} 时提醒；{maxTriggers}，冷却策略 {draft.cooldownMode}。
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
  const statusLabel = {
    matched: "命中",
    not_matched: "未命中",
    missing_value: "缺少当前值",
    missing_previous: "缺少上一值",
    unsupported_comparator: "暂不支持",
    invalid: "无效",
  }[node.status] || node.status || "--";
  const details = node.details || {};
  const hasDetails = Object.keys(details).length > 0;
  return (
    <div className={`alert-test-trace-node depth-${Math.min(depth, 3)} ${node.result ? "is-true" : "is-false"}`}>
      <div className="alert-test-trace-main">
        <span className="alert-test-result-dot" />
        <div>
          <div className="alert-test-trace-title">{node.summary || "条件"}</div>
          {hasDetails && (
            <div className="alert-test-trace-details">
              当前 {String(details.left ?? "--")} / 右值 {String(details.right ?? "--")}
              {details.previousLeft !== undefined && ` · 上一 ${details.previousLeft ?? "--"}`}
              {details.previousRight !== undefined && ` / 上一右值 ${details.previousRight ?? "--"}`}
              {details.rangeMin !== undefined && ` · 区间 ${details.rangeMin} 到 ${details.rangeMax}`}
              {details.percentChange !== undefined && ` · 涨跌幅 ${Number(details.percentChange).toFixed(2)}%`}
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
        kicker="步骤 6"
        title="测试规则"
        desc="用一组可调整的当前/上一根样本值 dry-run 规则，保存前确认每个条件的真假。"
        action={<span className={`alert-chip ${testResult?.result ? "success" : ""}`}>{testResult ? (testResult.result ? "整体命中" : "整体未命中") : "未测试"}</span>}
      />
      <div className="alert-test-grid">
        <div className="alert-test-column">
          <div className="alert-test-column-title">上一根样本</div>
          {TEST_VALUE_FIELDS.map((field) => (
            <label key={`previous-${field.key}`} className="alert-field compact">
              <span>{field.label}</span>
              <input
                type="number"
                value={testContext.previous[field.key] ?? ""}
                onChange={(event) => onContextChange("previous", field.key, event.target.value)}
              />
            </label>
          ))}
        </div>
        <div className="alert-test-column">
          <div className="alert-test-column-title">当前样本</div>
          {TEST_VALUE_FIELDS.map((field) => (
            <label key={`values-${field.key}`} className="alert-field compact">
              <span>{field.label}</span>
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
        <button className="alert-btn alert-btn-secondary" type="button" onClick={onResetContext} disabled={testLoading}>重置为图表价</button>
        <button className="alert-btn alert-btn-primary" type="button" onClick={onRunTest} disabled={testLoading}>
          {testLoading ? "测试中..." : "测试规则"}
        </button>
      </div>
      {testResult && (
        <div className="alert-test-result">
          <div className="alert-test-summary">
            <strong>{testResult.result ? "这组样本会触发警报" : "这组样本不会触发警报"}</strong>
            <span>结果由后端 evaluator 返回，和实时触发判断共用同一套逻辑。</span>
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
        <button type="button" onClick={onEdit} disabled={busy}>编辑</button>
        <button type="button" onClick={onDuplicate} disabled={busy}>复制</button>
        <button type="button" onClick={onToggle} disabled={busy}>{enabled ? "停用" : "启用"}</button>
        <button type="button" onClick={onDelete} disabled={busy}>删除</button>
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
        <div className="alert-timeline-desc">{symbol} · 触发值 {value}</div>
        <div className="alert-timeline-time">{time} · {channels}</div>
        <div className="alert-history-actions">
          <button type="button" onClick={onAcknowledge} disabled={busy}>
            {acknowledged ? "取消确认" : "确认"}
          </button>
          <button type="button" onClick={onViewRule} disabled={!onViewRule}>查看规则</button>
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
  const [tab, setTab] = useState<AlertTab>("add");
  const [panelWidth, setPanelWidth] = useState(520);
  const [isResizing, setIsResizing] = useState(false);
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

  const marketLabel = MARKET_LABELS[currentMarketType || ""] || currentMarketType || "--";
  const formattedPrice = formatPrice(displayPrice);
  const normalizedExchange = currentExchange || "binance";
  const symbolLabel = currentSymbol || "--";
  const intervalLabel = currentInterval || "--";

  const watchlistProducts = useMemo(() => buildWatchlistProducts(watchlists), [watchlists]);
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
        listNames: Array.from(new Set(["当前图表", ...(existing?.listNames || [])])),
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
        listNames: ["已有规则"],
        color: "#64748b",
      });
    }

    return [
      ...(currentChartProduct ? [currentChartProduct] : []),
      ...Array.from(products.values()).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    ];
  }, [currentMarketType, currentProductKey, currentSymbol, normalizedExchange, rules, watchlistProducts]);
  const selectedProductExists = alertProducts.some((item) => item.key === selectedProductKey);
  const defaultProductKey = currentSymbol ? currentProductKey : (alertProducts[0]?.key || "");
  const effectiveSelectedProductKey = selectedProductExists ? selectedProductKey : defaultProductKey;
  const selectedProduct = alertProducts.find((item) => item.key === effectiveSelectedProductKey) || null;
  const effectiveInterval = selectedInterval || (intervalLabel !== "--" ? intervalLabel : "1m");
  const canCreateAlert = Boolean(selectedProduct?.symbol || currentSymbol) && !alertSaving;
  const editorModeLabel = editingRuleId ? "更新警报" : "创建警报";
  const runtimeRuleStates = useMemo(() => systemStatus?.runtime.rules || [], [systemStatus]);
  const runtimeRuleStateById = useMemo(
    () => new Map(runtimeRuleStates.map((item) => [item.ruleId, item])),
    [runtimeRuleStates],
  );
  const warmingRuleCount = runtimeRuleStates.filter((item) => item.state === "warming").length;
  const degradedRuleCount = runtimeRuleStates.filter((item) => ["degraded", "recovering"].includes(item.state)).length;
  const runtimeStatusLabel = systemStatus?.runtime.status === "running"
    ? `运行中 · ${systemStatus.runtime.subscriptions.length} 个订阅${warmingRuleCount ? ` · ${warmingRuleCount} 条预热中` : ""}`
    : (systemStatus?.runtime.status === "error"
      ? `运行异常${degradedRuleCount ? ` · ${degradedRuleCount} 条恢复中` : ""}`
      : "运行状态不可用");
  const deliveryStatusLabel = systemStatus?.webhook.enabled
    ? (systemStatus.webhook.ready
      ? `Webhook 队列 ${systemStatus.outbox.queued} · 重试 ${systemStatus.outbox.retrying} · 死信 ${systemStatus.outbox.deadLetter}`
      : `Webhook 配置未就绪：${systemStatus.webhook.configurationError || "未知错误"}`)
    : "Webhook 默认关闭";

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
        console.warn("警报运行状态读取失败", statusError);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAlertError(errorMessage(err, "警报数据加载失败"));
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
      setAlertError(errorMessage(err, "测试规则失败"));
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
      setAlertError(errorMessage(err, `${editorModeLabel}失败`));
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
      setAlertError(errorMessage(err, "更新警报状态失败"));
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
      setAlertError(errorMessage(err, "删除警报失败"));
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
      setAlertError(errorMessage(err, "更新确认状态失败"));
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
        name: `${rule.name || "警报"} 副本`,
        enabled: false,
      });
      await loadAlerts();
    } catch (err: unknown) {
      setAlertError(errorMessage(err, "复制警报失败"));
    } finally {
      setAlertSaving(false);
    }
  }, [loadAlerts]);

  const startResizing = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    setIsResizing(true);
    event.preventDefault();
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback((event: MouseEvent) => {
    if (!isResizing) return;
    const nextWidth = window.innerWidth - event.clientX;
    if (nextWidth >= 430 && nextWidth <= Math.min(window.innerWidth - 80, 780)) {
      setPanelWidth(nextWidth);
    }
  }, [isResizing]);

  useEffect(() => {
    if (!isResizing) return undefined;
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

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
    <div className="alert-panel-overlay" onClick={onClose}>
      <aside
        className="alert-panel"
        style={{ width: `${panelWidth}px` }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className={`alert-resize-handle ${isResizing ? "active" : ""}`}
          onMouseDown={startResizing}
        />

        <div className="alert-panel-header">
          <div>
            <h3 className="alert-panel-title">
              警报中心
              <span className="alert-layout-pill">{rules.length} 条规则</span>
            </h3>
            <div className="alert-panel-subtitle">规则保存 · 触发历史 · 当前图表上下文</div>
            <div className={`alert-runtime-status status-${systemStatus?.runtime.status || "unknown"}`}>
              {runtimeStatusLabel}
            </div>
            <div className="alert-panel-subtitle">{deliveryStatusLabel}</div>
          </div>
          <button className="alert-panel-close" onClick={onClose} type="button">✕</button>
        </div>

        <div className="alert-context-card">
          <div className="alert-context-heading">
            <span>{symbolLabel}</span>
            <span className="alert-context-market">{marketLabel}</span>
          </div>
          <div className="alert-context-grid">
            <ContextMetric label="交易所" value={normalizedExchange.toUpperCase()} />
            <ContextMetric label="周期" value={intervalLabel} />
            <ContextMetric label="当前价" value={formattedPrice} tone="price" />
            <ContextMetric label="实时状态" value={wsStatus || "idle"} />
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
              {item.label}
            </button>
          ))}
        </div>

        {(alertError || alertLoading) && (
          <div className="alert-guidance-box">
            <div>
              <strong>{alertError ? "警报系统提示" : "正在同步警报数据"}</strong>
              <span>{alertError || "正在从后端读取规则和触发历史。"}</span>
            </div>
            <button className="alert-btn alert-btn-secondary" type="button" onClick={() => loadAlerts()} disabled={alertLoading}>
              刷新
            </button>
          </div>
        )}

        <div className="alert-panel-content">
          {tab === "add" && (
            <div className="alert-section-stack">
              <section className="alert-editor-card alert-product-section">
                <SectionHeader
                  kicker="步骤 1"
                  title="选择警报商品"
                  desc="可直接使用当前图表商品，也可切换到自选列表或已有规则中的商品。"
                  action={<span className="alert-chip">当前图表 / 自选</span>}
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
                      <span>警报商品</span>
                      <select value={effectiveSelectedProductKey} onChange={(event) => setSelectedProductKey(event.target.value)}>
                        {alertProducts.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.symbol} · {formatMarket(item.exchange, item.marketType)} · {item.listNames.join(" / ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="alert-field small">
                      <span>周期</span>
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
                    <div className="alert-empty-title">没有可用商品</div>
                    <div className="alert-empty-desc">请先打开一个有效商品图表，或把商品加入自选列表。</div>
                  </div>
                )}

                <div className="alert-form-grid single alert-draft-meta">
                  <label className="alert-field">
                    <span>规则名称</span>
                    <input value={draft.name} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} />
                  </label>
                  <label className="alert-field">
                    <span>规则说明</span>
                    <textarea value={draft.description} onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))} rows={2} />
                  </label>
                </div>
              </section>

              <section className="alert-editor-card">
                <SectionHeader
                  kicker="步骤 2-3"
                  title="触发条件与嵌套逻辑"
                  desc="单个条件使用“左值 + 操作符 + 右值”；多个条件可通过 AND / OR / NOT 组成任意嵌套逻辑树。"
                  action={<span className="alert-chip">规则树</span>}
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
                <button className="alert-btn alert-btn-secondary" type="button" onClick={resetDraft} disabled={alertSaving}>新建草稿</button>
                <button className="alert-btn alert-btn-secondary" type="button" onClick={() => loadAlerts()} disabled={alertLoading || alertSaving}>刷新规则</button>
                <button className="alert-btn alert-btn-primary" type="button" onClick={createCurrentAlert} disabled={!canCreateAlert}>
                  {alertSaving ? "保存中..." : editorModeLabel}
                </button>
              </div>
            </div>
          )}

          {tab === "all" && (
            <div className="alert-section-stack">
              <div className="alert-toolbar-row no-margin">
                <input
                  className="alert-search"
                  placeholder="搜索商品、条件或通知方式"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
                <select className="alert-filter-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AlertStatusFilter)}>
                  <option value="all">全部状态</option>
                  <option value="enabled">启用</option>
                  <option value="paused">停用</option>
                  <option value="expired">已过期</option>
                </select>
                <button className="alert-btn alert-btn-secondary" type="button" onClick={() => loadAlerts()} disabled={alertLoading}>刷新</button>
                <button className="alert-btn alert-btn-primary" type="button" onClick={resetDraft}>+ 添加警报</button>
              </div>

              <div className="alert-filter-chip-row">
                <span>自选列表</span>
                <span>商品</span>
                <span>条件类型</span>
                <span>到期状态</span>
                <span>通知渠道</span>
              </div>

              {filteredRules.map((rule) => (
                <RuleListCard
                  key={rule.id}
                  title={rule.name}
                  symbol={rule.target?.symbol || "--"}
                  summary={describeAlertRule(rule)}
                  status={`${alertRuntimeRuleStateLabel(runtimeRuleStateById.get(rule.id)?.state, rule.enabled)} · 已触发 ${rule.triggerCount || 0} 次`}
                  expiry={rule.maxTriggers ? `最多 ${rule.maxTriggers} 次` : "无限制"}
                  channels={describeAlertChannels(rule)}
                  enabled={rule.enabled}
                  busy={alertSaving}
                  onEdit={() => editRule(rule)}
                  onToggle={() => toggleRule(rule)}
                  onDuplicate={() => duplicateRule(rule)}
                  onDelete={() => {
                    if (window.confirm(`删除警报“${rule.name}”？`)) void removeRule(rule);
                  }}
                />
              ))}

              {filteredRules.length === 0 && (
                <div className="alert-empty-state compact">
                  <div className="alert-empty-title">{rules.length === 0 ? "暂无警报规则" : "没有匹配的警报"}</div>
                  <div className="alert-empty-desc">可以从当前商品快速创建第一条规则；运行状态正常时会自动求值并记录命中历史。</div>
                </div>
              )}
            </div>
          )}

          {tab === "history" && (
            <div className="alert-section-stack">
              <div className="alert-toolbar-row no-margin">
                <input
                  className="alert-search"
                  placeholder="筛选商品或规则"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
                <select className="alert-filter-select" value={historyRange} onChange={(event) => setHistoryRange(event.target.value as AlertHistoryRange)}>
                  <option value="today">今天</option>
                  <option value="7d">最近 7 天</option>
                  <option value="30d">最近 30 天</option>
                </select>
                <select className="alert-filter-select" value={acknowledgementFilter} onChange={(event) => setAcknowledgementFilter(event.target.value as AlertAcknowledgementFilter)}>
                  <option value="all">全部记录</option>
                  <option value="unread">未确认</option>
                  <option value="ack">已确认</option>
                </select>
                <button className="alert-btn alert-btn-secondary" type="button" onClick={() => loadAlerts()} disabled={alertLoading}>刷新历史</button>
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
                      title={event.message || `${rule?.name || "警报"} 命中`}
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
                  <div className="alert-empty-title">暂无触发历史</div>
                  <div className="alert-empty-desc">当前筛选范围内没有命中记录。</div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
