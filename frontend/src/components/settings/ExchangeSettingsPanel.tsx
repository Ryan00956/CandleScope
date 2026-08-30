import { useMemo, useState } from "react";
import {
    t,
    type MessageKey,
} from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type {
    CcxtCatalogSummaryPayload,
    ExchangeCapabilityPayload,
    ExchangeChannelCapabilityPayload,
    ExchangeMarketPayload,
} from "../../services/apiPayloadParsers.js";
import {
    exchangeChannelsForMarket,
    exchangeHasDerivatives,
    exchangeIsPollingOnly,
    exchangeIsRoutable,
    exchangeMarketCheckKey,
    exchangeProductSurfaces,
    exchangeProvider,
    filterExchangeCapabilities,
    type ExchangeConnectionCheck,
    type ExchangeSupportFilter,
} from "../../features/exchange-support/exchangeSupportModel.js";

const CHANNEL_ORDER = [
    "kline",
    "trade",
    "agg_trade",
    "ticker",
    "mini_ticker",
    "depth",
    "full_depth",
    "mark_price",
    "index_price",
    "funding_rate",
    "open_interest",
    "basis",
    "liquidation",
];

const CHANNEL_LABELS: Record<string, MessageKey> = {
    kline: "settings.exchange.channel.kline",
    trade: "settings.exchange.channel.trade",
    agg_trade: "settings.exchange.channel.aggTrade",
    ticker: "settings.exchange.channel.ticker",
    mini_ticker: "settings.exchange.channel.miniTicker",
    depth: "settings.exchange.channel.depth",
    full_depth: "settings.exchange.channel.fullDepth",
    mark_price: "settings.exchange.channel.markPrice",
    index_price: "settings.exchange.channel.indexPrice",
    funding_rate: "settings.exchange.channel.fundingRate",
    open_interest: "settings.exchange.channel.openInterest",
    basis: "settings.exchange.channel.basis",
    liquidation: "settings.exchange.channel.liquidation",
};

const FILTERS: Array<{ value: ExchangeSupportFilter; label: MessageKey }> = [
    { value: "all", label: "settings.exchange.filter.all" },
    { value: "primary", label: "settings.exchange.filter.primary" },
    { value: "streaming", label: "settings.exchange.filter.streaming" },
    { value: "polling", label: "settings.exchange.filter.polling" },
    { value: "derivatives", label: "settings.exchange.filter.derivatives" },
    { value: "unroutable", label: "settings.exchange.filter.unroutable" },
];

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
        : [];
}

function channelLabel(channel: string): string {
    const normalized = channel.trim().toLowerCase();
    const key = CHANNEL_LABELS[normalized];
    return key ? t(key) : channel;
}

function providerLabel(provider: string): string {
    if (provider === "ccxt_primary") return t("settings.exchange.provider.primary");
    if (provider === "ccxt_unified") return t("settings.exchange.provider.unified");
    return t("settings.exchange.provider.plugin");
}

function verificationLabel(level: string | undefined): string {
    if (level === "soak") return t("settings.exchange.verification.soak");
    if (level === "shadow") return t("settings.exchange.verification.shadow");
    if (level === "capability_contract") return t("settings.exchange.verification.contract");
    return t("settings.exchange.verification.catalogOnly");
}

function transportLabel(transport: string): string {
    if (transport === "plugin_stream" || transport === "websocket") {
        return t("settings.exchange.transport.ws");
    }
    if (transport === "rest_poll") return t("settings.exchange.transport.poll");
    if (transport === "rest_snapshot") return t("settings.exchange.transport.snapshot");
    if (transport === "rest_history") return t("settings.exchange.transport.history");
    return transport;
}

function formatTransports(value: unknown, supported: boolean): string {
    const transports = stringArray(value);
    if (!supported) return t("settings.exchange.none");
    if (transports.length === 0) return t("settings.exchange.declared");
    return transports.map(transportLabel).join(" + ");
}

function qualityLabel(channel: ExchangeChannelCapabilityPayload): string {
    if (channel.delta === true && channel.sequence !== "none") {
        return t("settings.exchange.quality.strictDepth");
    }
    if (channel.snapshot === true) return t("settings.exchange.quality.snapshot");
    if (channel.delivery === "latest") return t("settings.exchange.quality.lossy");
    if (typeof channel.sequence === "string" && channel.sequence !== "none") {
        return t("settings.exchange.quality.sequence", { sequence: channel.sequence });
    }
    return t("settings.exchange.quality.unsequenced");
}

function configuredValues(channel: ExchangeChannelCapabilityPayload): string[] {
    const params = channel.params || {};
    for (const key of ["interval", "period", "depth_levels"]) {
        const values = stringArray(params[key]);
        if (values.length > 0) return values;
        if (Array.isArray(params[key])) return params[key].map(String);
    }
    return [];
}

function capabilitySummary(exchange: ExchangeCapabilityPayload): string {
    const channels = exchange.channels || [];
    const labels = CHANNEL_ORDER
        .filter((channel) => channels.some((item) => item.channel === channel))
        .slice(0, 5)
        .map(channelLabel);
    const remaining = new Set(channels.map((channel) => channel.channel)).size - labels.length;
    return remaining > 0 ? `${labels.join(" · ")} · +${remaining}` : labels.join(" · ");
}

function ProductSurfaceRow({ exchange }: { exchange: ExchangeCapabilityPayload }) {
    const surfaces = exchangeProductSurfaces(exchange);
    const marketProducts = Object.values(exchange.support?.products?.markets || {});
    const strictBook = marketProducts.some((market) => market.order_book.strict_full_depth);
    const liveSnapshotBook = marketProducts.some((market) => (
        market.order_book.snapshot_mode === "live_snapshot"
    ));
    const observationalTrade = marketProducts.some((market) => (
        market.trade_flow.mode === "observational"
    ));
    const pollingTrade = marketProducts.some((market) => (
        market.trade_flow.delivery_mode === "polling_observational"
    ));
    const strictTrade = marketProducts.some((market) => (
        market.trade_flow.mode === "strict_repairable"
    ));
    const advancedByChannel = new Map<string, string>();
    for (const market of marketProducts) {
        for (const [channel, product] of Object.entries(
            market.advanced_market_data.channels,
        )) {
            if (product.supported) advancedByChannel.set(channel, product.delivery_mode || "");
        }
    }
    const advancedModes = [...advancedByChannel.values()];
    const advancedLive = advancedModes.filter((mode) => (
        mode === "live_snapshot"
        || mode === "live_observational"
        || mode === "derived_live"
    )).length;
    const advancedPolling = advancedModes.filter((mode) => (
        mode === "polling_snapshot"
        || mode === "polling_observational"
        || mode === "derived_polling"
    )).length;
    const advancedHistory = advancedModes.filter((mode) => mode === "history_only").length;
    const advancedDetail = advancedByChannel.size > 0
        ? t("settings.exchange.surface.advancedSummary", {
            count: advancedByChannel.size,
            live: advancedLive,
            polling: advancedPolling,
            history: advancedHistory,
        })
        : null;
    const entries = [
        ["chart", "settings.exchange.surface.chart", surfaces.chart ? t("settings.exchange.surface.ready") : null],
        ["advancedMarketData", "settings.exchange.surface.advanced", surfaces.advancedMarketData ? advancedDetail : null],
        ["orderBook", "settings.exchange.surface.orderBook", surfaces.orderBook
            ? t(strictBook
                ? "settings.exchange.surface.strictBook"
                : liveSnapshotBook
                    ? "settings.exchange.surface.liveSnapshotBook"
                    : "settings.exchange.surface.pollingSnapshotBook")
            : null],
        ["tradeFlow", "settings.exchange.surface.tradeFlow", surfaces.tradeFlow
            ? t(strictTrade
                ? "settings.exchange.surface.strictTrade"
                : pollingTrade
                    ? "settings.exchange.surface.pollingObservedTrade"
                : observationalTrade
                    ? "settings.exchange.surface.observedTrade"
                    : "settings.exchange.surface.ready")
            : null],
    ] as const;
    return (
        <div className="st-exchange-surfaces">
            {entries.map(([field, label, detail]) => (
                <div
                    key={field}
                    className={`st-exchange-surface ${surfaces[field] ? "supported" : "pending"}`}
                >
                    <span>{t(label)}</span>
                    <strong>
                        {surfaces[field]
                            ? detail
                            : t("settings.exchange.surface.pending")}
                    </strong>
                </div>
            ))}
        </div>
    );
}

function MarketCapabilityDetail({
    exchange,
    market,
    connectionCheck,
    onTest,
}: {
    exchange: ExchangeCapabilityPayload;
    market: ExchangeMarketPayload;
    connectionCheck: ExchangeConnectionCheck | undefined;
    onTest(): void;
}) {
    const channels = exchangeChannelsForMarket(exchange, market.market_type)
        .sort((left, right) => {
            const leftIndex = CHANNEL_ORDER.indexOf(left.channel);
            const rightIndex = CHANNEL_ORDER.indexOf(right.channel);
            return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
        });

    return (
        <div className="st-exchange-market-detail">
            <div className="st-exchange-market-detail-head">
                <div>
                    <strong>{market.label || market.market_type}</strong>
                    <span>{market.market_type}</span>
                </div>
                <button
                    className="st-exchange-test-button"
                    type="button"
                    onClick={onTest}
                    disabled={connectionCheck?.status === "running" || !exchangeIsRoutable(exchange)}
                >
                    {connectionCheck?.status === "running"
                        ? t("settings.exchange.testing")
                        : t("settings.exchange.testMarket")}
                </button>
            </div>

            {connectionCheck?.status === "success" && (
                <div className="st-exchange-check-result success">
                    {t("settings.exchange.testSuccess", {
                        count: connectionCheck.symbolCount ?? 0,
                    })}
                </div>
            )}
            {connectionCheck?.status === "error" && (
                <div className="st-exchange-check-result error">{connectionCheck.error}</div>
            )}

            {channels.length === 0 ? (
                <div className="st-exchange-empty">{t("settings.exchange.noChannels")}</div>
            ) : (
                <div className="st-exchange-capability-table">
                    <div className="st-exchange-capability-header">
                        <span>{t("settings.exchange.dataChannel")}</span>
                        <span>{t("settings.exchange.realtime")}</span>
                        <span>{t("settings.exchange.history")}</span>
                        <span>{t("settings.exchange.dataQuality")}</span>
                    </div>
                    {channels.map((channel) => {
                        const values = configuredValues(channel);
                        const fields = stringArray(channel.available_fields);
                        const unavailableFields = stringArray(channel.unavailable_fields);
                        const limitations = stringArray(channel.known_limitations);
                        return (
                            <div key={channel.channel} className="st-exchange-capability-row">
                                <div>
                                    <strong>{channelLabel(channel.channel)}</strong>
                                    {values.length > 0 && (
                                        <div className="st-exchange-inline-chips">
                                            {values.slice(0, 8).map((value) => <span key={value}>{value}</span>)}
                                            {values.length > 8 && <span>+{values.length - 8}</span>}
                                        </div>
                                    )}
                                </div>
                                <span>{formatTransports(channel.realtime_transports, channel.realtime)}</span>
                                <span>{formatTransports(channel.history_transports, channel.history)}</span>
                                <div className="st-exchange-quality">
                                    <strong>{qualityLabel(channel)}</strong>
                                    {fields.length > 0 && (
                                        <span>{t("settings.exchange.fields")}: {fields.join(", ")}</span>
                                    )}
                                    {unavailableFields.length > 0 && (
                                        <span>{t("settings.exchange.unavailableFields")}: {unavailableFields.join(", ")}</span>
                                    )}
                                    {limitations.map((limitation) => <span key={limitation}>{limitation}</span>)}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export interface ExchangeSettingsPanelProps {
    currentExchange: string;
    supportedExchanges: ExchangeCapabilityPayload[];
    exchangeCatalogSummary: CcxtCatalogSummaryPayload | null;
    exchangeConnectionChecks: Record<string, ExchangeConnectionCheck>;
    exchangeListLoading: boolean;
    exchangeListError: string | null;
    onRefreshExchanges(): void;
    onTestExchangeMarket(exchange: string, marketType: string): void;
}

export default function ExchangeSettingsPanel({
    currentExchange,
    supportedExchanges,
    exchangeCatalogSummary,
    exchangeConnectionChecks,
    exchangeListLoading,
    exchangeListError,
    onRefreshExchanges,
    onTestExchangeMarket,
}: ExchangeSettingsPanelProps) {
    const locale = useLocale();
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<ExchangeSupportFilter>("all");
    const [expandedExchange, setExpandedExchange] = useState(currentExchange);
    const filteredExchanges = useMemo(
        () => filterExchangeCapabilities(supportedExchanges, search, filter, currentExchange),
        [currentExchange, filter, search, supportedExchanges],
    );
    const routableCount = supportedExchanges.filter(exchangeIsRoutable).length;
    const streamCount = supportedExchanges.filter((exchange) => (
        (exchange.channels || []).some((channel) => (
            channel.channel === "kline"
            && channel.realtime === true
            && stringArray(channel.realtime_transports).includes("plugin_stream")
        ))
    )).length;

    return (
        <div className="st-group st-exchange-directory">
            <div className="st-group-title-row">
                <div>
                    <div className="st-group-title">{t("settings.exchange.title")}</div>
                    <div className="st-group-desc">{t("settings.exchange.desc")}</div>
                </div>
                <button
                    className="st-exchange-refresh"
                    type="button"
                    onClick={onRefreshExchanges}
                    disabled={exchangeListLoading}
                >
                    {exchangeListLoading ? t("settings.exchange.refreshing") : t("settings.exchange.refresh")}
                </button>
            </div>

            {exchangeCatalogSummary && (
                <div className="st-exchange-summary">
                    <div className="st-exchange-stat">
                        <span>{t("settings.exchange.kernelVersion")}</span>
                        <strong>CCXT {exchangeCatalogSummary.version}</strong>
                    </div>
                    <div className="st-exchange-stat">
                        <span>{t("settings.exchange.adapterIds")}</span>
                        <strong>{exchangeCatalogSummary.rest_exchange_ids}</strong>
                    </div>
                    <div className="st-exchange-stat">
                        <span>{t("settings.exchange.routable")}</span>
                        <strong>{routableCount}</strong>
                    </div>
                    <div className="st-exchange-stat">
                        <span>{t("settings.exchange.proIds")}</span>
                        <strong>{exchangeCatalogSummary.pro_exchange_ids}</strong>
                    </div>
                    <div className="st-exchange-stat">
                        <span>{t("settings.exchange.wsKline")}</span>
                        <strong>{streamCount}</strong>
                    </div>
                </div>
            )}

            <div className="st-exchange-toolbar">
                <label className="st-exchange-search">
                    <span>{t("settings.exchange.search")}</span>
                    <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={t("settings.exchange.searchPlaceholder")}
                    />
                </label>
                <div className="st-exchange-filters" role="group" aria-label={t("settings.exchange.filter")}>
                    {FILTERS.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            className={`st-exchange-filter${filter === option.value ? " active" : ""}`}
                            aria-pressed={filter === option.value}
                            onClick={() => setFilter(option.value)}
                        >
                            {t(option.label)}
                        </button>
                    ))}
                </div>
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
            {supportedExchanges.length > 0 && filteredExchanges.length === 0 && (
                <div className="st-exchange-empty">{t("settings.exchange.noMatches")}</div>
            )}

            <div className="st-exchange-list">
                {filteredExchanges.map((exchange) => {
                    const isExpanded = expandedExchange === exchange.exchange;
                    const isCurrent = exchange.exchange === currentExchange;
                    const isRoutable = exchangeIsRoutable(exchange);
                    const provider = exchangeProvider(exchange);
                    const qualifications = exchange.support?.qualifications
                        || (exchange.support?.qualification ? [exchange.support.qualification] : []);
                    return (
                        <section
                            key={exchange.exchange}
                            className={[
                                "st-exchange-card",
                                isExpanded ? "expanded" : "",
                                isCurrent ? "current" : "",
                                isRoutable ? "" : "unroutable",
                            ].filter(Boolean).join(" ")}
                        >
                            <button
                                type="button"
                                className="st-exchange-card-head"
                                onClick={() => setExpandedExchange(isExpanded ? "" : exchange.exchange)}
                                aria-expanded={isExpanded}
                            >
                                <span className="st-exchange-disclosure" aria-hidden="true">
                                    <span className="st-exchange-chevron">▸</span>
                                </span>
                                <span className="st-exchange-identity">
                                    <strong>{exchange.name || exchange.exchange}</strong>
                                    <small>{exchange.exchange}</small>
                                </span>
                                <span className="st-exchange-row-badges">
                                    {isCurrent && <span className="st-series-badge st-badge-ok">{t("settings.exchange.current")}</span>}
                                    <span className="st-series-badge st-badge-info">{providerLabel(provider)}</span>
                                    <span className={`st-series-badge ${isRoutable ? "st-badge-ok" : "st-badge-fail"}`}>
                                        {isRoutable
                                            ? verificationLabel(exchange.support?.verification_level || "capability_contract")
                                            : t("settings.exchange.unroutable")}
                                    </span>
                                    {exchangeIsPollingOnly(exchange) && (
                                        <span className="st-series-badge st-badge-info">{t("settings.exchange.pollingOnly")}</span>
                                    )}
                                    {exchangeHasDerivatives(exchange) && (
                                        <span className="st-series-badge st-badge-info">{t("settings.exchange.derivatives")}</span>
                                    )}
                                </span>
                                <span className="st-exchange-row-meta">
                                    <span className="st-exchange-row-markets">
                                        {exchange.markets.length > 0
                                            ? exchange.markets.map((market) => (
                                                <span key={market.market_type} className="st-exchange-chip">
                                                    {market.label || market.market_type}
                                                </span>
                                            ))
                                            : <span className="st-exchange-chip muted">{t("settings.exchange.noMarkets")}</span>}
                                    </span>
                                    <span className="st-exchange-row-capabilities">
                                        {capabilitySummary(exchange) || t("settings.exchange.noChannels")}
                                    </span>
                                </span>
                            </button>

                            {isExpanded && (
                                <div className="st-exchange-card-detail">
                                    <div className="st-exchange-detail-section">
                                        <h4>{t("settings.exchange.productSurfaces")}</h4>
                                        <ProductSurfaceRow exchange={exchange} />
                                    </div>

                                    {qualifications.map((qualification) => (
                                        <div key={qualification.evidence_id} className="st-exchange-qualification">
                                            <strong>{verificationLabel(qualification.level)}</strong>
                                            <span>CCXT {qualification.ccxt_version}</span>
                                            <span>{qualification.market_types.join(" / ")}</span>
                                            <span>{qualification.channels.map(channelLabel).join(" · ")}</span>
                                            {qualification.event_count != null && (
                                                <span>{t("settings.exchange.verification.events", { count: qualification.event_count })}</span>
                                            )}
                                            {qualification.duration_seconds != null && (
                                                <span>{t("settings.exchange.verification.durationHours", {
                                                    hours: qualification.duration_seconds / 3600,
                                                })}</span>
                                            )}
                                            <span>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(qualification.verified_at))}</span>
                                        </div>
                                    ))}

                                    {exchange.markets.map((market) => (
                                        <MarketCapabilityDetail
                                            key={market.market_type}
                                            exchange={exchange}
                                            market={market}
                                            connectionCheck={exchangeConnectionChecks[
                                                exchangeMarketCheckKey(exchange.exchange, market.market_type)
                                            ]}
                                            onTest={() => onTestExchangeMarket(exchange.exchange, market.market_type)}
                                        />
                                    ))}

                                    {exchange.known_limitations.length > 0 && (
                                        <div className="st-exchange-limitations">
                                            <strong>{t("settings.exchange.knownLimitations")}</strong>
                                            <ul>
                                                {exchange.known_limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
