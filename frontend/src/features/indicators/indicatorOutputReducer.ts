import {
  mergeIndicatorItems,
  replaceIndicatorItemsRange,
} from "./indicatorPayloadRuntime.js";
import type {
  IndicatorAuxiliaryItem,
  IndicatorCacheResult,
  IndicatorOutputAction,
  IndicatorOutputState,
  IndicatorParameterSchema,
  IndicatorRange,
  NormalizedIndicatorPayload,
} from "./indicatorTypes.js";

export function createIndicatorOutputState(): IndicatorOutputState {
  return {
    markers: [],
    fills: [],
    hlines: [],
    bgcolors: [],
    barcolors: [],
    signals: [],
    paramSchemas: {},
  };
}

function withoutIndicator<T extends IndicatorAuxiliaryItem>(items: T[], indicatorId: string): T[] {
  return items.filter((item) => item.indicatorId !== indicatorId);
}

function withoutAnyIndicator<T extends IndicatorAuxiliaryItem>(
  items: T[],
  indicatorIds: ReadonlySet<string>,
): T[] {
  return items.filter(
    (item) => item.indicatorId === undefined || !indicatorIds.has(item.indicatorId),
  );
}

function replaceIndicatorOutputs(
  state: IndicatorOutputState,
  indicatorId: string,
  normalized: NormalizedIndicatorPayload,
): IndicatorOutputState {
  return {
    ...state,
    markers: [...withoutIndicator(state.markers, indicatorId), ...normalized.markers],
    fills: [...withoutIndicator(state.fills, indicatorId), ...normalized.fills],
    hlines: [...withoutIndicator(state.hlines, indicatorId), ...normalized.hlines],
    bgcolors: [...withoutIndicator(state.bgcolors, indicatorId), ...normalized.bgcolors],
    barcolors: [...withoutIndicator(state.barcolors, indicatorId), ...normalized.barcolors],
    signals: [...withoutIndicator(state.signals, indicatorId), ...normalized.signals],
  };
}

function mergeIndicatorPatchOutputs(
  state: IndicatorOutputState,
  indicatorId: string,
  normalized: NormalizedIndicatorPayload,
): IndicatorOutputState {
  return {
    ...state,
    markers: mergeIndicatorItems(
      withoutIndicator(state.markers, indicatorId),
      [
        ...state.markers.filter((item) => item.indicatorId === indicatorId),
        ...(normalized.markers || []),
      ],
    ),
    fills: [
      ...withoutIndicator(state.fills, indicatorId),
      ...mergeIndicatorItems(
        state.fills.filter((item) => item.indicatorId === indicatorId),
        normalized.fills || [],
      ),
    ],
    hlines: [
      ...withoutIndicator(state.hlines, indicatorId),
      ...mergeIndicatorItems(
        state.hlines.filter((item) => item.indicatorId === indicatorId),
        normalized.hlines || [],
      ),
    ],
    bgcolors: [
      ...withoutIndicator(state.bgcolors, indicatorId),
      ...mergeIndicatorItems(
        state.bgcolors.filter((item) => item.indicatorId === indicatorId),
        normalized.bgcolors || [],
      ),
    ],
    barcolors: [
      ...withoutIndicator(state.barcolors, indicatorId),
      ...mergeIndicatorItems(
        state.barcolors.filter((item) => item.indicatorId === indicatorId),
        normalized.barcolors || [],
      ),
    ],
    signals: [
      ...withoutIndicator(state.signals, indicatorId),
      ...mergeIndicatorItems(
        state.signals.filter((item) => item.indicatorId === indicatorId),
        normalized.signals || [],
      ),
    ],
  };
}

function replaceIndicatorRangeOutputs(
  state: IndicatorOutputState,
  indicatorId: string,
  normalized: NormalizedIndicatorPayload,
  range: IndicatorRange,
): IndicatorOutputState {
  return {
    ...state,
    markers: [
      ...withoutIndicator(state.markers, indicatorId),
      ...replaceIndicatorItemsRange(state.markers.filter((item) => item.indicatorId === indicatorId), normalized.markers, range),
    ],
    fills: [
      ...withoutIndicator(state.fills, indicatorId),
      ...replaceIndicatorItemsRange(state.fills.filter((item) => item.indicatorId === indicatorId), normalized.fills, range),
    ],
    hlines: [
      ...withoutIndicator(state.hlines, indicatorId),
      ...replaceIndicatorItemsRange(state.hlines.filter((item) => item.indicatorId === indicatorId), normalized.hlines, range),
    ],
    bgcolors: [
      ...withoutIndicator(state.bgcolors, indicatorId),
      ...replaceIndicatorItemsRange(state.bgcolors.filter((item) => item.indicatorId === indicatorId), normalized.bgcolors, range),
    ],
    barcolors: [
      ...withoutIndicator(state.barcolors, indicatorId),
      ...replaceIndicatorItemsRange(state.barcolors.filter((item) => item.indicatorId === indicatorId), normalized.barcolors, range),
    ],
    signals: [
      ...withoutIndicator(state.signals, indicatorId),
      ...replaceIndicatorItemsRange(state.signals.filter((item) => item.indicatorId === indicatorId), normalized.signals, range),
    ],
  };
}

function removeIndicatorOutputs(
  state: IndicatorOutputState,
  indicatorId: string,
): IndicatorOutputState {
  const { [indicatorId]: _removed, ...paramSchemas } = state.paramSchemas || {};
  return {
    markers: withoutIndicator(state.markers, indicatorId),
    fills: withoutIndicator(state.fills, indicatorId),
    hlines: withoutIndicator(state.hlines, indicatorId),
    bgcolors: withoutIndicator(state.bgcolors, indicatorId),
    barcolors: withoutIndicator(state.barcolors, indicatorId),
    signals: withoutIndicator(state.signals, indicatorId),
    paramSchemas,
  };
}

function mergeParamSchemas(
  state: IndicatorOutputState,
  schemas?: Record<string, IndicatorParameterSchema[]>,
): Record<string, IndicatorParameterSchema[]> {
  if (!schemas || Object.keys(schemas).length === 0) return state.paramSchemas;
  return { ...state.paramSchemas, ...schemas };
}

function hydrateCachedOutputs(
  state: IndicatorOutputState,
  entries: IndicatorCacheResult[] = [],
): IndicatorOutputState {
  let next = {
    ...createIndicatorOutputState(),
    paramSchemas: state.paramSchemas,
  };
  const schemas: Record<string, IndicatorParameterSchema[]> = {};
  for (const entry of entries) {
    if (!entry?.indicatorId || !entry.normalized) continue;
    next = replaceIndicatorOutputs(next, entry.indicatorId, entry.normalized);
    if (entry.schema?.length > 0) {
      schemas[entry.indicatorId] = entry.schema;
    }
  }
  next.paramSchemas = mergeParamSchemas(next, schemas);
  return next;
}

export function indicatorOutputReducer(
  state: IndicatorOutputState,
  action: IndicatorOutputAction,
): IndicatorOutputState {
  switch (action.type) {
    case "reset-context":
      return {
        ...createIndicatorOutputState(),
        paramSchemas: state.paramSchemas,
      };
    case "hydrate-cache":
      return hydrateCachedOutputs(state, action.entries);
    case "snapshot": {
      const next = replaceIndicatorOutputs(state, action.indicatorId, action.normalized);
      const schema = action.schema;
      if (schema && schema.length > 0) {
        next.paramSchemas = { ...state.paramSchemas, [action.indicatorId]: schema };
      }
      return next;
    }
    case "patch":
      return mergeIndicatorPatchOutputs(state, action.indicatorId, action.normalized);
    case "replace-range":
      return replaceIndicatorRangeOutputs(
        state,
        action.indicatorId,
        action.normalized,
        action.range,
      );
    case "remove-indicator":
      return removeIndicatorOutputs(state, action.indicatorId);
    case "compute-results": {
      const processedIds = new Set<string>(action.processedIds || []);
      return {
        ...state,
        markers: [...withoutAnyIndicator(state.markers, processedIds), ...(action.markers || [])],
        fills: [...withoutAnyIndicator(state.fills, processedIds), ...(action.fills || [])],
        hlines: [...withoutAnyIndicator(state.hlines, processedIds), ...(action.hlines || [])],
        bgcolors: [...withoutAnyIndicator(state.bgcolors, processedIds), ...(action.bgcolors || [])],
        barcolors: [...withoutAnyIndicator(state.barcolors, processedIds), ...(action.barcolors || [])],
        signals: [...withoutAnyIndicator(state.signals, processedIds), ...(action.signals || [])],
        paramSchemas: mergeParamSchemas(state, action.paramSchemas),
      };
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
