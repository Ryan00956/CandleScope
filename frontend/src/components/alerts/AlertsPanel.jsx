import { useCallback, useEffect, useMemo, useState } from "react";
import { parseSymbolKey } from "../../utils/symbolKey";

const MARKET_LABELS = {
  spot: "现货",
  futures: "合约",
};

const TAB_OPTIONS = [
  { key: "add", label: "添加警报" },
  { key: "all", label: "全部警报" },
  { key: "history", label: "触发历史" },
];

const CONDITION_SOURCES = [
  "最新价",
  "收盘价",
  "最高价",
  "最低价",
  "成交量",
  "RSI(14)",
  "MACD Histogram",
  "MA(20)",
];

const CONDITION_OPERATORS = ["上穿", "下穿", "穿过", "大于", "小于", "等于", "介于区间", "离开区间"];
const RIGHT_VALUE_TYPES = ["固定数值", "另一指标", "价格字段", "百分比变化", "区间上下限"];

function formatPrice(value) {
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

function formatMarket(exchange, marketType) {
  const ex = String(exchange || "binance").toUpperCase();
  return `${ex} · ${MARKET_LABELS[marketType] || marketType || "现货"}`;
}

function buildProductKey({ symbol, marketType, exchange }) {
  return `${exchange || "binance"}:${marketType || "spot"}:${symbol || ""}`;
}

function buildWatchlistProducts(watchlists = []) {
  const productMap = new Map();
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

function ContextMetric({ label, value, tone }) {
  return (
    <div className={`alert-context-metric ${tone ? `tone-${tone}` : ""}`}>
      <span className="alert-context-label">{label}</span>
      <span className="alert-context-value">{value}</span>
    </div>
  );
}

function SectionHeader({ kicker, title, desc, action }) {
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

function ProductSummary({ product, fallbackSymbol, fallbackMarketType, fallbackExchange, currentProductMissing }) {
  const symbol = product?.symbol || fallbackSymbol || "--";
  const marketType = product?.marketType || fallbackMarketType || "spot";
  const exchange = product?.exchange || fallbackExchange || "binance";

  return (
    <div className={`alert-selected-product ${currentProductMissing ? "is-missing" : ""}`}>
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
        {currentProductMissing && <span className="alert-mini-tag warn">未在自选</span>}
      </div>
    </div>
  );
}

function ConditionCard({ index, source, operator, rightType, value, not = false, tone = "blue" }) {
  return (
    <div className={`alert-condition-card tone-${tone}`}>
      <div className="alert-condition-topline">
        <span className="alert-condition-index">条件 {index}</span>
        <label className="alert-not-toggle">
          <input type="checkbox" defaultChecked={not} />
          <span>NOT</span>
        </label>
      </div>
      <div className="alert-condition-grid">
        <label className="alert-field compact">
          <span>左值</span>
          <select defaultValue={source}>
            {CONDITION_SOURCES.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="alert-field compact">
          <span>操作符</span>
          <select defaultValue={operator}>
            {CONDITION_OPERATORS.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="alert-field compact">
          <span>右值类型</span>
          <select defaultValue={rightType}>
            {RIGHT_VALUE_TYPES.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="alert-field compact">
          <span>右值</span>
          <input type="text" defaultValue={value} />
        </label>
      </div>
    </div>
  );
}

function LogicConnector({ value }) {
  return (
    <div className="alert-logic-connector">
      <span>{value}</span>
    </div>
  );
}

function NestedLogicBuilder({ formattedPrice }) {
  return (
    <div className="alert-logic-builder">
      <div className="alert-logic-group root">
        <div className="alert-logic-group-header">
          <div>
            <div className="alert-logic-title">根逻辑组</div>
            <div className="alert-logic-desc">当此组为真时触发警报</div>
          </div>
          <div className="alert-logic-actions">
            <label className="alert-not-toggle">
              <input type="checkbox" />
              <span>NOT</span>
            </label>
            <select defaultValue="AND" className="alert-logic-select">
              <option>AND</option>
              <option>OR</option>
            </select>
          </div>
        </div>

        <ConditionCard index="A" source="最新价" operator="上穿" rightType="固定数值" value={formattedPrice} tone="amber" />
        <LogicConnector value="AND" />

        <div className="alert-logic-group nested">
          <div className="alert-logic-group-header compact">
            <div>
              <div className="alert-logic-title">子逻辑组</div>
              <div className="alert-logic-desc">指标条件满足其一即可</div>
            </div>
            <div className="alert-logic-actions">
              <label className="alert-not-toggle">
                <input type="checkbox" />
                <span>NOT</span>
              </label>
              <select defaultValue="OR" className="alert-logic-select">
                <option>AND</option>
                <option>OR</option>
              </select>
            </div>
          </div>
          <ConditionCard index="B1" source="RSI(14)" operator="大于" rightType="固定数值" value="70" tone="purple" />
          <LogicConnector value="OR" />
          <ConditionCard index="B2" source="MACD Histogram" operator="上穿" rightType="固定数值" value="0" tone="blue" />
        </div>

        <div className="alert-logic-footer">
          <button className="alert-btn alert-btn-secondary" type="button" disabled>+ 添加条件</button>
          <button className="alert-btn alert-btn-secondary" type="button" disabled>+ 添加子组</button>
          <button className="alert-btn alert-btn-secondary" type="button" disabled>复制组</button>
          <button className="alert-btn alert-btn-secondary danger" type="button" disabled>删除组</button>
        </div>
      </div>
    </div>
  );
}

function ExpirationAndNotification() {
  return (
    <div className="alert-two-column">
      <section className="alert-settings-card">
        <SectionHeader
          kicker="步骤 4"
          title="到期条件"
          desc="按触发次数或时间自动停用，当前只做版面。"
        />
        <div className="alert-form-grid single">
          <label className="alert-field">
            <span>触发次数</span>
            <select defaultValue="once">
              <option value="once">仅一次</option>
              <option value="3">3 次</option>
              <option value="custom">自定义次数</option>
              <option value="unlimited">无限制</option>
            </select>
          </label>
          <label className="alert-field">
            <span>时间到期</span>
            <select defaultValue="never">
              <option value="1h">1 小时后</option>
              <option value="today">当天结束</option>
              <option value="7d">7 天后</option>
              <option value="custom">自定义日期时间</option>
              <option value="never">永不过期</option>
            </select>
          </label>
          <label className="alert-field">
            <span>触发后行为</span>
            <select defaultValue="auto-disable">
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
          {[
            ["应用内提示", "右上角 Toast"],
            ["浏览器通知", "需要授权后启用"],
            ["声音提醒", "默认关闭"],
            ["触发历史", "始终记录"],
          ].map(([title, desc], index) => (
            <label key={title} className="alert-channel-card">
              <input type="checkbox" defaultChecked={index === 0 || index === 3} />
              <span>
                <strong>{title}</strong>
                <small>{desc}</small>
              </span>
            </label>
          ))}
        </div>
        <label className="alert-field alert-message-template">
          <span>消息模板</span>
          <textarea defaultValue="{{symbol}} {{interval}} 命中警报：{{condition}}，当前值 {{value}}" rows={3} />
        </label>
        <label className="alert-field">
          <span>通知冷却</span>
          <select defaultValue="30s">
            <option value="always">每次触发都通知</option>
            <option value="30s">冷却 30 秒</option>
            <option value="5m">冷却 5 分钟</option>
            <option value="custom">自定义</option>
          </select>
        </label>
      </section>
    </div>
  );
}

function RulePreview({ product, fallbackSymbol, interval, formattedPrice }) {
  const symbol = product?.symbol || fallbackSymbol || "BTCUSDT";
  return (
    <div className="alert-rule-preview-box">
      <div className="alert-preview-label">规则摘要预览</div>
      <div className="alert-preview-text">
        {symbol} {interval}：价格上穿 {formattedPrice} 且 (RSI(14) 大于 70 或 MACD Histogram 上穿 0) 时提醒；仅触发一次，通知到应用内提示与触发历史。
      </div>
    </div>
  );
}

function RuleListCard({ title, symbol, summary, status, expiry, channels }) {
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
        <button type="button" disabled>编辑</button>
        <button type="button" disabled>复制</button>
        <button type="button" disabled>停用</button>
      </div>
    </div>
  );
}

function HistoryItem({ time, symbol, title, value, channels }) {
  return (
    <div className="alert-history-item">
      <div className="alert-timeline-dot" />
      <div className="alert-timeline-card">
        <div className="alert-timeline-title">{title}</div>
        <div className="alert-timeline-desc">{symbol} · 触发值 {value}</div>
        <div className="alert-timeline-time">{time} · {channels}</div>
        <div className="alert-history-actions">
          <button type="button" disabled>确认</button>
          <button type="button" disabled>查看规则</button>
        </div>
      </div>
    </div>
  );
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
}) {
  const [tab, setTab] = useState("add");
  const [panelWidth, setPanelWidth] = useState(520);
  const [isResizing, setIsResizing] = useState(false);
  const [selectedProductKey, setSelectedProductKey] = useState("");

  const marketLabel = MARKET_LABELS[currentMarketType] || currentMarketType || "--";
  const formattedPrice = formatPrice(displayPrice);
  const normalizedExchange = currentExchange || "binance";
  const symbolLabel = currentSymbol || "--";
  const intervalLabel = currentInterval || "--";

  const watchlistProducts = useMemo(() => buildWatchlistProducts(watchlists), [watchlists]);
  const currentProductKey = buildProductKey({
    symbol: currentSymbol,
    marketType: currentMarketType,
    exchange: currentExchange,
  });
  const currentWatchProduct = watchlistProducts.find((item) => item.key === currentProductKey) || null;
  const selectedProduct = watchlistProducts.find((item) => item.key === selectedProductKey) || currentWatchProduct || watchlistProducts[0] || null;
  const currentProductMissing = Boolean(currentSymbol) && !currentWatchProduct;

  useEffect(() => {
    if (!isOpen) return;
    setSelectedProductKey((prev) => {
      if (watchlistProducts.some((item) => item.key === prev)) return prev;
      return currentWatchProduct?.key || watchlistProducts[0]?.key || "";
    });
  }, [currentWatchProduct, isOpen, watchlistProducts]);

  const startResizing = useCallback((event) => {
    setIsResizing(true);
    event.preventDefault();
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback((event) => {
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
              🔔 警报中心
              <span className="alert-layout-pill">页面设计</span>
            </h3>
            <div className="alert-panel-subtitle">基于自选商品构建复杂触发规则；本轮不保存、不触发、不发送通知。</div>
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

        <div className="alert-panel-content">
          {tab === "add" && (
            <div className="alert-section-stack">
              <section className="alert-editor-card alert-product-section">
                <SectionHeader
                  kicker="步骤 1"
                  title="选择自选商品"
                  desc="警报优先只对自选模块里的商品创建。当前商品不在自选时，可使用引导按钮。"
                  action={<span className="alert-chip">自选限定</span>}
                />

                <ProductSummary
                  product={selectedProduct}
                  fallbackSymbol={symbolLabel}
                  fallbackMarketType={currentMarketType}
                  fallbackExchange={normalizedExchange}
                  currentProductMissing={currentProductMissing && !selectedProduct}
                />

                {watchlistProducts.length > 0 ? (
                  <div className="alert-product-picker-row">
                    <label className="alert-field">
                      <span>自选商品</span>
                      <select value={selectedProduct?.key || ""} onChange={(event) => setSelectedProductKey(event.target.value)}>
                        {watchlistProducts.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.symbol} · {formatMarket(item.exchange, item.marketType)} · {item.listNames.join(" / ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="alert-field small">
                      <span>周期</span>
                      <select defaultValue={intervalLabel}>
                        {[intervalLabel, "1m", "5m", "15m", "1h", "4h", "1d"].filter(Boolean).map((item) => (
                          <option key={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : (
                  <div className="alert-empty-state compact">
                    <div className="alert-empty-icon">☆</div>
                    <div className="alert-empty-title">自选列表为空</div>
                    <div className="alert-empty-desc">请先把商品添加到自选模块，然后再为它创建警报。</div>
                  </div>
                )}

                {currentProductMissing && (
                  <div className="alert-guidance-box">
                    <div>
                      <strong>{symbolLabel} 还不在自选列表中</strong>
                      <span>后续会支持一键加入自选并继续创建警报。</span>
                    </div>
                    <button className="alert-btn alert-btn-primary" type="button" disabled>加入自选并继续</button>
                  </div>
                )}
              </section>

              <section className="alert-editor-card">
                <SectionHeader
                  kicker="步骤 2-3"
                  title="触发条件与嵌套逻辑"
                  desc="单个条件使用“左值 + 操作符 + 右值”；多个条件可通过 AND / OR / NOT 组成任意嵌套逻辑树。"
                  action={<span className="alert-chip">规则树</span>}
                />
                <NestedLogicBuilder formattedPrice={formattedPrice} />
              </section>

              <ExpirationAndNotification />

              <RulePreview
                product={selectedProduct}
                fallbackSymbol={symbolLabel}
                interval={intervalLabel}
                formattedPrice={formattedPrice}
              />

              <div className="alert-editor-actions sticky-actions">
                <button className="alert-btn alert-btn-secondary" type="button" disabled>保存草稿（待实现）</button>
                <button className="alert-btn alert-btn-primary" type="button" disabled>创建警报（待实现）</button>
              </div>
            </div>
          )}

          {tab === "all" && (
            <div className="alert-section-stack">
              <div className="alert-toolbar-row no-margin">
                <input className="alert-search" placeholder="搜索商品、条件或通知方式（版面预览）" />
                <select className="alert-filter-select" defaultValue="all">
                  <option value="all">全部状态</option>
                  <option value="enabled">启用</option>
                  <option value="paused">停用</option>
                  <option value="expired">已过期</option>
                </select>
                <button className="alert-btn alert-btn-primary" type="button" disabled>+ 添加警报</button>
              </div>

              <div className="alert-filter-chip-row">
                <span>自选列表</span>
                <span>商品</span>
                <span>条件类型</span>
                <span>到期状态</span>
                <span>通知渠道</span>
              </div>

              <RuleListCard
                title="价格 + 指标组合警报"
                symbol={selectedProduct?.symbol || symbolLabel}
                summary={`价格上穿 ${formattedPrice} 且 (RSI > 70 或 MACD 上穿 0)`}
                status="启用 · 版面示例"
                expiry="仅一次"
                channels="Toast / 历史"
              />
              <RuleListCard
                title="成交量突破"
                symbol="ETHUSDT"
                summary="当前成交量大于 20 根均量的 2 倍"
                status="停用 · 版面示例"
                expiry="7 天后到期"
                channels="浏览器通知 / 声音"
              />

              <div className="alert-empty-state compact">
                <div className="alert-empty-title">真实规则列表尚未接入</div>
                <div className="alert-empty-desc">后续保存逻辑完成后，这里会显示所有警报并支持编辑、复制、停用和删除。</div>
              </div>
            </div>
          )}

          {tab === "history" && (
            <div className="alert-section-stack">
              <div className="alert-toolbar-row no-margin">
                <input className="alert-search" placeholder="筛选商品或规则（版面预览）" />
                <select className="alert-filter-select" defaultValue="7d">
                  <option value="today">今天</option>
                  <option value="7d">最近 7 天</option>
                  <option value="30d">最近 30 天</option>
                </select>
                <select className="alert-filter-select" defaultValue="all">
                  <option value="all">全部记录</option>
                  <option value="unread">未确认</option>
                  <option value="ack">已确认</option>
                </select>
                <button className="alert-btn alert-btn-secondary" type="button" disabled>清空历史</button>
              </div>

              <div className="alert-history-list">
                <HistoryItem
                  time="刚刚 · 示例"
                  symbol={selectedProduct?.symbol || symbolLabel}
                  title="价格 + 指标组合警报命中"
                  value={formattedPrice}
                  channels="Toast / 历史"
                />
                <HistoryItem
                  time="昨日 21:30 · 示例"
                  symbol="ETHUSDT"
                  title="成交量突破警报命中"
                  value="2.4x 均量"
                  channels="浏览器通知 / 声音"
                />
              </div>

              <div className="alert-empty-state compact">
                <div className="alert-empty-title">暂无真实触发历史</div>
                <div className="alert-empty-desc">触发逻辑接入后，这里会展示命中条件、触发值、通知渠道和确认状态。</div>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
