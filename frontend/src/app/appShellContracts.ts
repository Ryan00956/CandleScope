import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ChartSurfaceHandle } from "../chart-adapter/useChartSurfaceRuntime.js";
import type { IntervalSelectorProps } from "../components/IntervalSelector.js";
import type { ChartSessionRuntime } from "../features/chart-session/chartSessionTypes.js";
import type { DrawingRuntime } from "../features/drawings/useDrawingRuntime.js";
import type { ExportRuntime } from "../features/export/useExportRuntime.js";
import type { IndicatorRuntime } from "../features/indicators/useIndicatorRuntime.js";
import type { MarketDataRuntimeContract } from "../features/market-data/marketDataRuntimeContract.js";
import type { AdvancedMarketRuntime } from "../features/advanced-market-data/advancedMarketDataTypes.js";
import type { ChartSettings } from "../features/settings/chartAppearanceSettings.js";
import type { WatchlistRuntime } from "../features/watchlist/useWatchlistRuntime.js";
import type { OrderBookRuntime } from "../features/order-book/orderBookTypes.js";
import type { ChartWorkspaceProps } from "./ChartWorkspace.js";
import type { LazyFeatureSurfaceModels } from "./LazyFeatureSurfaces.js";
import type { StatusBarModel } from "./StatusBar.js";
import type { TopBarProps } from "./TopBar.js";

export interface IndicatorShellRuntime {
  view: IndicatorRuntime["view"] & { isPanelOpen: boolean };
  actions: IndicatorRuntime["actions"] & {
    openPanel(): void;
    closePanel(): void;
    togglePanel(): void;
  };
  status: IndicatorRuntime["status"];
}

export interface SettingsShellRuntime {
  view: {
    settings: ChartSettings;
    resolvedTheme: string;
    isOpen: boolean;
  };
  actions: {
    update: Dispatch<SetStateAction<ChartSettings>>;
    openPanel(): void;
    closePanel(): void;
  };
  status: Record<string, never>;
}

export interface PriceScaleShellRuntime {
  view: {
    invertScale: boolean;
    priceScaleMode: number;
  };
  actions: {
    setInvertScale(value: boolean): void;
    setPriceScaleMode(mode: number): void;
  };
  status: Record<string, never>;
}

export interface AlertsShellRuntime {
  view: { isOpen: boolean };
  actions: {
    openPanel(): void;
    closePanel(): void;
    togglePanel(): void;
  };
  status: Record<string, never>;
}

export interface AppShellRuntimeInputs {
  session: ChartSessionRuntime;
  marketData: MarketDataRuntimeContract;
  advancedMarketData: AdvancedMarketRuntime;
  drawings: DrawingRuntime;
  indicators: IndicatorShellRuntime;
  settings: SettingsShellRuntime;
  priceScale: PriceScaleShellRuntime;
  watchlist: WatchlistRuntime;
  orderBook: OrderBookRuntime;
  exportFlow: ExportRuntime;
  alerts: AlertsShellRuntime;
}

export interface AppShellViewModelContext {
  sessionView: ChartSessionRuntime["view"];
  sessionActions: ChartSessionRuntime["actions"];
  sessionStatus: ChartSessionRuntime["status"];
  marketView: MarketDataRuntimeContract["view"];
  marketActions: MarketDataRuntimeContract["actions"];
  marketStatus: MarketDataRuntimeContract["status"];
  advancedMarketView: AdvancedMarketRuntime["view"];
  advancedMarketActions: AdvancedMarketRuntime["actions"];
  drawingView: DrawingRuntime["view"];
  drawingActions: DrawingRuntime["actions"];
  indicatorView: IndicatorShellRuntime["view"];
  indicatorActions: IndicatorShellRuntime["actions"];
  indicatorComputing: boolean;
  watchlistView: WatchlistRuntime["view"];
  watchlistActions: WatchlistRuntime["actions"];
  orderBookView: OrderBookRuntime["view"];
  orderBookActions: OrderBookRuntime["actions"];
  orderBookStatus: OrderBookRuntime["status"];
  settingsView: SettingsShellRuntime["view"];
  settingsActions: SettingsShellRuntime["actions"];
  chartSettings: ChartSettings;
  resolvedTheme: string;
  exportView: ExportRuntime["view"];
  exportActions: ExportRuntime["actions"];
  exportInProgress: boolean;
  priceScaleView: PriceScaleShellRuntime["view"];
  priceScaleActions: PriceScaleShellRuntime["actions"];
  alertsView: AlertsShellRuntime["view"];
  alertsActions: AlertsShellRuntime["actions"];
  marketDisplay: MarketDataRuntimeContract["view"]["display"];
  displayData: MarketDataRuntimeContract["view"]["display"]["displayData"];
}

export interface AppShellViewModel {
  topBar: TopBarProps;
  intervalSelector: IntervalSelectorProps;
  chartWorkspace: ChartWorkspaceProps;
  lazySurfaces: LazyFeatureSurfaceModels;
  statusBar: StatusBarModel;
}

export interface AppShellRefs {
  pageExportRef: RefObject<HTMLDivElement | null>;
  chartSurfaceRef: RefObject<ChartSurfaceHandle | null>;
}

export type AppShellProps = AppShellRuntimeInputs & AppShellRefs;
