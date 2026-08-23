import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { MutableRefObject } from "react";
import { t } from "../../i18n/index.js";

import {
  stripIndicatorRuntimeFields,
  useActiveIndicatorStore,
} from "./activeIndicatorStore.js";
import type {
  ActiveIndicatorPersistence,
} from "./activeIndicatorStore.js";
import { useIndicatorComputeController } from "./indicatorComputeController.js";
import type { IndicatorComputeBatchExecutor } from "./indicatorComputeController.js";
import { resolveLocalIndicatorExecution } from "./indicatorComputeJobRuntime.js";
import {
  createIndicatorOutputState,
  filterIndicatorOutputStateByVisibility,
  indicatorOutputReducer,
} from "./indicatorOutputReducer.js";
import { buildIndicatorPaneData } from "./indicatorPaneProjection.js";
import type { IndicatorRuntime } from "./indicatorRuntimeContract.js";
import type {
  IndicatorAnnotationPoint,
  IndicatorBarColor,
  IndicatorBgColor,
  IndicatorDefinition,
  IndicatorFill,
  IndicatorHLine,
  IndicatorLine,
  IndicatorMarker,
  IndicatorOutputState,
  IndicatorSignal,
} from "./indicatorTypes.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import { MAX_SERIES_BARS } from "../market-data/phase1WindowPolicy.js";

const EMPTY_RANGE_REQUEST = () => false;

export interface ProvidedBarsIndicatorSupport {
  supported: boolean;
  reason: string | null;
}

export interface UseProvidedBarsIndicatorRuntimeOptions {
  bars: KlineBar[];
  candleDownColor?: string;
  candleUpColor?: string;
  chartDataMeta?: ChartDataCommitMeta | null;
  datasetKey: string;
  computeBatch?: IndicatorComputeBatchExecutor;
  exchange: string;
  interval: string;
  marketType: string;
  onIndicatorRemoved?: (indicatorId: string) => void;
  persistence?: ActiveIndicatorPersistence | null;
  seriesReady?: number;
  sourceOrdinal: number;
  sourceScopeKey: string;
  symbol: string;
  visibleThroughSeconds?: number | null;
}

function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

function normalizedScriptLanguage(indicator: IndicatorDefinition): string {
  return String(indicator.language || "pyne").trim().toLowerCase();
}

export function providedBarsIndicatorSupport(
  indicator: IndicatorDefinition,
): ProvidedBarsIndicatorSupport {
  const local = {
    ...stripIndicatorRuntimeFields(indicator),
    executionTarget: "local" as const,
  };
  const resolution = resolveLocalIndicatorExecution(local);
  if (resolution.kind !== "local") {
    return {
      supported: false,
      reason: resolution.kind === "invalid"
        ? resolution.error
        : t("indicator.noLocalBars"),
    };
  }
  if (resolution.execution.mode === "builtin") {
    return { supported: true, reason: null };
  }
  const language = normalizedScriptLanguage(local);
  if (language !== "pyne" && language !== "pine") {
    return {
      supported: false,
      reason: t("indicator.replayUnsafe", { language: language || t("indicator.unknownRuntime") }),
    };
  }
  return { supported: true, reason: null };
}

/**
 * Converts a catalog definition into the only execution shape accepted by a
 * provided-bars runtime. The caller supplies every bar; hosted/range lookup is
 * never an implicit fallback.
 */
export function prepareProvidedBarsIndicator(
  indicator: IndicatorDefinition,
): IndicatorDefinition | null {
  const support = providedBarsIndicatorSupport(indicator);
  if (!support.supported) return null;
  const stripped = stripIndicatorRuntimeFields(indicator);
  const local: IndicatorDefinition = {
    ...stripped,
    executionTarget: "local",
  };
  const resolution = resolveLocalIndicatorExecution(local);
  if (resolution.kind !== "local") return null;
  if (resolution.execution.mode === "builtin") return local;

  const language = normalizedScriptLanguage(local);
  const {
    securityMode: _discardedSecurityMode,
    ...withoutSecurityMode
  } = local;
  return language === "pyne"
    ? {
        ...withoutSecurityMode,
        language,
        securityMode: "safe",
      }
    : {
        ...withoutSecurityMode,
        language,
      };
}

function clampAnnotationPoints(
  points: readonly IndicatorAnnotationPoint[],
  visibleThroughSeconds: number,
): IndicatorAnnotationPoint[] {
  return points.flatMap((point) => {
    if (point.time !== undefined && point.time > visibleThroughSeconds) return [];
    return [{
      ...point,
      ...(point.endTime !== undefined && point.endTime > visibleThroughSeconds
        ? { endTime: visibleThroughSeconds }
        : {}),
    }];
  });
}

function clampLine(
  line: IndicatorLine,
  visibleThroughSeconds: number,
): IndicatorLine {
  return {
    ...line,
    data: line.data.filter((point) => point.time <= visibleThroughSeconds),
    ...(line.colorData === undefined || line.colorData === null
      ? {}
      : {
          colorData: line.colorData.filter(
            (point) => point.time <= visibleThroughSeconds,
          ),
        }),
  };
}

function clampMarkers(
  items: readonly IndicatorMarker[],
  visibleThroughSeconds: number,
): IndicatorMarker[] {
  return items.map((item) => ({
    ...item,
    data: clampAnnotationPoints(item.data, visibleThroughSeconds),
  }));
}

function clampFills(
  items: readonly IndicatorFill[],
  visibleThroughSeconds: number,
): IndicatorFill[] {
  return items.map((item) => ({
    ...item,
    ...(item.data === undefined
      ? {}
      : { data: clampAnnotationPoints(item.data, visibleThroughSeconds) }),
  }));
}

function clampHlines(
  items: readonly IndicatorHLine[],
  visibleThroughSeconds: number,
): IndicatorHLine[] {
  return items.map((item) => ({
    ...item,
    ...(item.data === undefined
      ? {}
      : { data: clampAnnotationPoints(item.data, visibleThroughSeconds) }),
  }));
}

function clampBgcolors(
  items: readonly IndicatorBgColor[],
  visibleThroughSeconds: number,
): IndicatorBgColor[] {
  return items.map((item) => ({
    ...item,
    ...(item.regions === undefined
      ? {}
      : { regions: clampAnnotationPoints(item.regions, visibleThroughSeconds) }),
    ...(item.data === undefined
      ? {}
      : { data: clampAnnotationPoints(item.data, visibleThroughSeconds) }),
  }));
}

function clampBarcolors(
  items: readonly IndicatorBarColor[],
  visibleThroughSeconds: number,
): IndicatorBarColor[] {
  return items.map((item) => ({
    ...item,
    data: item.data.filter((point) => point.time <= visibleThroughSeconds),
  }));
}

function clampSignals(
  items: readonly IndicatorSignal[],
  visibleThroughSeconds: number,
): IndicatorSignal[] {
  return items.map((item) => ({
    ...item,
    data: clampAnnotationPoints(item.data, visibleThroughSeconds),
  }));
}

export function clampProvidedBarsIndicatorOutput({
  activeIndicators,
  outputState,
  visibleThroughSeconds,
}: {
  activeIndicators: readonly IndicatorDefinition[];
  outputState: IndicatorOutputState;
  visibleThroughSeconds: number | null;
}): {
  activeIndicators: IndicatorDefinition[];
  outputState: IndicatorOutputState;
} {
  if (visibleThroughSeconds === null || !Number.isFinite(visibleThroughSeconds)) {
    return {
      activeIndicators: activeIndicators.map((indicator) => ({
        ...indicator,
        ...(indicator.lines === undefined ? {} : { lines: [] }),
      })),
      outputState: {
        ...createIndicatorOutputState(),
        paramSchemas: outputState.paramSchemas,
      },
    };
  }
  return {
    activeIndicators: activeIndicators.map((indicator) => ({
      ...indicator,
      ...(indicator.lines === undefined
        ? {}
        : {
            lines: indicator.lines.map(
              (line) => clampLine(line, visibleThroughSeconds),
            ),
          }),
    })),
    outputState: {
      markers: clampMarkers(outputState.markers, visibleThroughSeconds),
      fills: clampFills(outputState.fills, visibleThroughSeconds),
      hlines: clampHlines(outputState.hlines, visibleThroughSeconds),
      bgcolors: clampBgcolors(outputState.bgcolors, visibleThroughSeconds),
      barcolors: clampBarcolors(outputState.barcolors, visibleThroughSeconds),
      signals: clampSignals(outputState.signals, visibleThroughSeconds),
      paramSchemas: outputState.paramSchemas,
    },
  };
}

export function clearProvidedBarsIndicatorRuntimeFields(
  indicator: IndicatorDefinition,
): IndicatorDefinition {
  const cleared: IndicatorDefinition = {
    ...indicator,
    lines: [],
  };
  delete cleared.error;
  delete cleared.paramSchema;
  return cleared;
}

/**
 * Shared indicator product runtime for an explicit, caller-owned bar array.
 * It reuses the live page's compute controller, output reducer and pane
 * projection, while deliberately excluding hosted range, WebSocket and shared
 * result-cache lifecycles.
 */
export function useProvidedBarsIndicatorRuntime({
  bars,
  candleDownColor = "#ef4444",
  candleUpColor = "#22c55e",
  chartDataMeta = null,
  datasetKey,
  computeBatch,
  exchange,
  interval,
  marketType,
  onIndicatorRemoved,
  persistence = null,
  seriesReady = 0,
  sourceOrdinal,
  sourceScopeKey,
  symbol,
  visibleThroughSeconds = null,
}: UseProvidedBarsIndicatorRuntimeOptions): IndicatorRuntime {
  const pendingForceComputeRef = useRef(false);
  const requireIndicatorCompute = useCallback(() => {
    pendingForceComputeRef.current = true;
  }, []);
  const {
    activeIndicators,
    setActiveIndicators,
    addIndicator,
    removeIndicator: removeActiveIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  } = useActiveIndicatorStore({
    autoAddVolume: false,
    normalizeIndicator: prepareProvidedBarsIndicator,
    onRequireCompute: requireIndicatorCompute,
    persistence,
  });
  const [outputState, outputDispatch] = useReducer(
    indicatorOutputReducer,
    undefined,
    createIndicatorOutputState,
  );
  const activeIndicatorsRef = useLatestRef(activeIndicators);
  const barsRef = useLatestRef(bars);
  const chartDataMetaRef = useLatestRef(chartDataMeta);
  const candleUpColorRef = useLatestRef(candleUpColor);
  const candleDownColorRef = useLatestRef(candleDownColor);
  const previousSourceRef = useRef<{
    ordinal: number;
    scopeKey: string;
  } | null>(null);

  useLayoutEffect(() => {
    const previous = previousSourceRef.current;
    previousSourceRef.current = {
      ordinal: sourceOrdinal,
      scopeKey: sourceScopeKey,
    };
    if (previous === null || (
      previous.scopeKey === sourceScopeKey
      && sourceOrdinal >= previous.ordinal
    )) return;

    pendingForceComputeRef.current = true;
    outputDispatch({
      type: "reset-context",
      preserveParamSchemas: false,
    });
    setActiveIndicators((current) => (
      current.map(clearProvidedBarsIndicatorRuntimeFields)
    ));
  }, [
    pendingForceComputeRef,
    setActiveIndicators,
    sourceOrdinal,
    sourceScopeKey,
  ]);

  const {
    computeAll,
    computing,
    recompute,
  } = useIndicatorComputeController({
    activeIndicators,
    activeIndicatorsRef,
    candleDownColor,
    candleDownColorRef,
    candleUpColor,
    candleUpColorRef,
    chartData: bars,
    chartDataMeta,
    chartDataMetaRef,
    chartDataRef: barsRef,
    datasetKey,
    ...(computeBatch === undefined ? {} : { computeBatch }),
    exchange,
    forceHostedSubscriptions: () => undefined,
    historyLimit: MAX_SERIES_BARS,
    interval,
    marketType,
    outputDispatch,
    pendingForceComputeRef,
    resultCacheMode: "disabled",
    seriesReady,
    setActiveIndicators,
    symbol,
  });

  const removeIndicator = useCallback((indicatorId: string) => {
    removeActiveIndicator(indicatorId);
    outputDispatch({ type: "remove-indicator", indicatorId });
    onIndicatorRemoved?.(indicatorId);
  }, [onIndicatorRemoved, removeActiveIndicator]);

  const clamped = useMemo(() => clampProvidedBarsIndicatorOutput({
    activeIndicators,
    outputState,
    visibleThroughSeconds,
  }), [activeIndicators, outputState, visibleThroughSeconds]);
  const visibleOutputState = useMemo(
    () => filterIndicatorOutputStateByVisibility(
      clamped.outputState,
      clamped.activeIndicators,
    ),
    [clamped.activeIndicators, clamped.outputState],
  );
  const paneData = useMemo(() => buildIndicatorPaneData(
    clamped.activeIndicators,
    {
      markers: visibleOutputState.markers,
      fills: visibleOutputState.fills,
      hlines: visibleOutputState.hlines,
      bgcolors: visibleOutputState.bgcolors,
    },
  ), [clamped.activeIndicators, visibleOutputState]);
  const view = useMemo(() => ({
    activeIndicators: clamped.activeIndicators,
    mainOverlayLines: paneData.mainOverlayLines,
    subPanes: paneData.subPanes,
    markers: visibleOutputState.markers,
    fills: visibleOutputState.fills,
    hlines: visibleOutputState.hlines,
    bgcolors: visibleOutputState.bgcolors,
    barcolors: visibleOutputState.barcolors,
    signals: visibleOutputState.signals,
    paramSchemas: visibleOutputState.paramSchemas,
  }), [
    clamped,
    paneData,
    visibleOutputState,
  ]);
  const actions = useMemo(() => ({
    addIndicator,
    computeAll,
    ensureVisibleIndicatorRange: EMPTY_RANGE_REQUEST,
    recompute,
    removeIndicator,
    requestIndicatorRange: EMPTY_RANGE_REQUEST,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  }), [
    addIndicator,
    computeAll,
    recompute,
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  ]);

  return {
    view,
    actions,
    status: {
      computing,
      realtimeMode: "historical-only",
    },
  };
}
