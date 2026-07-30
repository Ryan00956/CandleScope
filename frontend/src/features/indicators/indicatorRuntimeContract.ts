import type { IndicatorSubPane } from "./indicatorPaneProjection.js";
import type {
  IndicatorDefinition,
  IndicatorLine,
  IndicatorOutputState,
  IndicatorParams,
} from "./indicatorTypes.js";

export interface IndicatorRangeRequestOptions {
  indicatorIds?: Array<string | number>;
  waitForSubscription?: boolean;
  revision?: unknown;
  onSettled?: (ok: boolean, detail: Record<string, unknown>) => void;
  invalidate?: boolean;
  cascadeRight?: boolean;
}

export type RequestIndicatorRange = (
  start: unknown,
  end: unknown,
  reason?: string,
  options?: IndicatorRangeRequestOptions,
) => boolean;

export interface IndicatorRuntime {
  view: {
    activeIndicators: IndicatorDefinition[];
    mainOverlayLines: IndicatorLine[];
    subPanes: IndicatorSubPane[];
  } & IndicatorOutputState;
  actions: {
    addIndicator(indicator: IndicatorDefinition): void;
    computeAll(force?: boolean): Promise<void>;
    ensureVisibleIndicatorRange(visibleRange: unknown): boolean;
    recompute(force?: boolean): void;
    removeIndicator(indicatorId: string): void;
    requestIndicatorRange: RequestIndicatorRange;
    toggleVisibility(indicatorId: string): void;
    updateIndicatorParams(indicatorId: string, params: IndicatorParams): void;
    updateIndicatorScript(
      indicatorId: string,
      script: string,
      language?: string,
      securityMode?: string,
    ): void;
  };
  status: {
    computing: boolean;
    realtimeMode: IndicatorRealtimeMode;
  };
}

export type IndicatorRealtimeMode = "enabled" | "degraded" | "historical-only";
