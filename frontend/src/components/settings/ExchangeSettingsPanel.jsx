function formatBoolSupport(value) {
    return value ? '支持' : '不支持';
}

function getWsConnectionLabel(model) {
    if (model === 'shared_multiplex') return '共享复用连接';
    if (model === 'path_per_stream') return '单流独立连接';
    return model || '默认连接';
}

function formatMarketLabels(markets = []) {
    if (!Array.isArray(markets) || markets.length === 0) return '暂无市场配置';
    return markets
        .map((market) => market.label || market.market_type || market.product_type)
        .filter(Boolean)
        .join(' / ');
}

function renderIntervalPreview(intervals = []) {
    if (!Array.isArray(intervals) || intervals.length === 0) {
        return <span className="st-exchange-empty">未声明原生周期</span>;
    }
    const visible = intervals.slice(0, 10);
    const hidden = intervals.length - visible.length;
    return (
        <div className="st-exchange-intervals">
            {visible.map((interval) => (
                <span key={interval} className="st-exchange-chip">{interval}</span>
            ))}
            {hidden > 0 && <span className="st-exchange-chip muted">+{hidden}</span>}
        </div>
    );
}

export default function ExchangeSettingsPanel({
    currentExchange,
    supportedExchanges,
    exchangeListLoading,
    exchangeListError,
    onRefreshExchanges,
}) {
    return (
        <div className="st-group">
            <div className="st-group-title-row">
                <div>
                    <div className="st-group-title" style={{ marginBottom: 0 }}>后端已注册交易所</div>
                    <div className="st-group-desc" style={{ marginBottom: 0 }}>
                        这里直接读取交易所插件注册表；新增交易所插件注册后会自动出现在列表中。
                    </div>
                </div>
                <button
                    className="st-advanced-toggle"
                    onClick={onRefreshExchanges}
                    disabled={exchangeListLoading}
                >
                    {exchangeListLoading ? '刷新中...' : '刷新'}
                </button>
            </div>

            {exchangeListError && (
                <div className="st-result st-result-fail">
                    <div className="st-result-head">交易所列表加载失败</div>
                    <div className="st-result-detail">{exchangeListError}</div>
                </div>
            )}

            {!exchangeListError && exchangeListLoading && supportedExchanges.length === 0 && (
                <div className="st-info-box">正在读取交易所插件注册表...</div>
            )}

            {!exchangeListError && !exchangeListLoading && supportedExchanges.length === 0 && (
                <div className="st-info-box st-info-warn">当前后端没有返回已注册交易所。</div>
            )}

            {supportedExchanges.length > 0 && (
                <div className="st-exchange-grid">
                    {supportedExchanges.map((exchange) => (
                        <div key={exchange.exchange} className="st-exchange-card">
                            <div className="st-exchange-card-head">
                                <div>
                                    <div className="st-exchange-name">{exchange.name || exchange.exchange}</div>
                                    <div className="st-exchange-id">{exchange.exchange}</div>
                                </div>
                                <span className={`st-series-badge ${exchange.exchange === currentExchange ? 'st-badge-ok' : 'st-badge-info'}`}>
                                    {exchange.exchange === currentExchange ? '当前' : '可用'}
                                </span>
                            </div>

                            <div className="st-exchange-market-line">
                                {formatMarketLabels(exchange.markets)}
                            </div>

                            <div className="st-exchange-cap-row">
                                <span>实时模型</span>
                                <strong>{getWsConnectionLabel(exchange.ws_connection_model)}</strong>
                            </div>
                            <div className="st-exchange-cap-row">
                                <span>多品种报价</span>
                                <strong>{formatBoolSupport(exchange.supports_multi_symbol_ticker)}</strong>
                            </div>
                            <div className="st-exchange-cap-row">
                                <span>搜索交易对</span>
                                <strong>{formatBoolSupport(exchange.supports_symbol_search)}</strong>
                            </div>

                            <div className="st-exchange-section-label">原生周期</div>
                            {renderIntervalPreview(exchange.native_intervals)}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
