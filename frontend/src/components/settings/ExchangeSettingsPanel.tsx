import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type { ExchangeCapabilityPayload } from "../../features/settings/exchangeSettingsRuntime.js";

function formatBoolSupport(value: unknown): string {
    return value ? t("settings.exchange.supported") : t("settings.exchange.unsupported");
}

function getWsConnectionLabel(model: unknown): string {
    if (model === 'shared_multiplex') return t("settings.exchange.wsShared");
    if (model === 'path_per_stream') return t("settings.exchange.wsPath");
    return typeof model === 'string' && model ? model : t("settings.exchange.wsDefault");
}

function formatMarketLabels(markets: ExchangeCapabilityPayload["markets"] = []): string {
    if (!Array.isArray(markets) || markets.length === 0) return t("settings.exchange.noMarkets");
    return markets
        .map((market) => market.label || market.market_type || market.product_type)
        .filter(Boolean)
        .join(' / ');
}

function renderIntervalPreview(intervals: string[] = []): ReactNode {
    if (!Array.isArray(intervals) || intervals.length === 0) {
        return <span className="st-exchange-empty">{t("settings.exchange.noIntervals")}</span>;
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

export interface ExchangeSettingsPanelProps {
    currentExchange: string;
    supportedExchanges: ExchangeCapabilityPayload[];
    exchangeListLoading: boolean;
    exchangeListError: string | null;
    onRefreshExchanges(): void;
}

export default function ExchangeSettingsPanel({
    currentExchange,
    supportedExchanges,
    exchangeListLoading,
    exchangeListError,
    onRefreshExchanges,
}: ExchangeSettingsPanelProps) {
    useLocale();
    return (
        <div className="st-group">
            <div className="st-group-title-row">
                <div>
                    <div className="st-group-title" style={{ marginBottom: 0 }}>{t("settings.exchange.title")}</div>
                    <div className="st-group-desc" style={{ marginBottom: 0 }}>
                        {t("settings.exchange.desc")}
                    </div>
                </div>
                <button
                    className="st-advanced-toggle"
                    onClick={onRefreshExchanges}
                    disabled={exchangeListLoading}
                >
                    {exchangeListLoading ? t("settings.exchange.refreshing") : t("settings.exchange.refresh")}
                </button>
            </div>

            {exchangeListError && (
                <div className="st-result st-result-fail">
                    <div className="st-result-head">{t("settings.exchange.loadFailed")}</div>
                    <div className="st-result-detail">{exchangeListError}</div>
                </div>
            )}

            {!exchangeListError && exchangeListLoading && supportedExchanges.length === 0 && (
                <div className="st-info-box">{t("settings.exchange.loading")}</div>
            )}

            {!exchangeListError && !exchangeListLoading && supportedExchanges.length === 0 && (
                <div className="st-info-box st-info-warn">{t("settings.exchange.empty")}</div>
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
                                    {exchange.exchange === currentExchange ? t("settings.exchange.current") : t("settings.exchange.available")}
                                </span>
                            </div>

                            <div className="st-exchange-market-line">
                                {formatMarketLabels(exchange.markets)}
                            </div>

                            <div className="st-exchange-cap-row">
                                <span>{t("settings.exchange.wsModel")}</span>
                                <strong>{getWsConnectionLabel(exchange.ws_connection_model)}</strong>
                            </div>
                            <div className="st-exchange-cap-row">
                                <span>{t("settings.exchange.multiTicker")}</span>
                                <strong>{formatBoolSupport(exchange.supports_multi_symbol_ticker)}</strong>
                            </div>
                            <div className="st-exchange-cap-row">
                                <span>{t("settings.exchange.symbolSearch")}</span>
                                <strong>{formatBoolSupport(exchange.supports_symbol_search)}</strong>
                            </div>

                            <div className="st-exchange-section-label">{t("settings.exchange.nativeIntervals")}</div>
                            {renderIntervalPreview(exchange.native_intervals)}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
