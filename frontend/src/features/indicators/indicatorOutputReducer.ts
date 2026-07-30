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

function reuseArrayReference<T>(previous: T[], next: T[]): T[] {
  if (previous === next) return previous;
  if (previous.length !== next.length) return next;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return next;
  }
  return previous;
}

function reuseUnchangedOutputLanes(
  previous: IndicatorOutputState,
  next: IndicatorOutputState,
): IndicatorOutputState {
  const markers = reuseArrayReference(previous.markers, next.markers);
  const fills = reuseArrayReference(previous.fills, next.fills);
  const hlines = reuseArrayReference(previous.hlines, next.hlines);
  const bgcolors = reuseArrayReference(previous.bgcolors, next.bgcolors);
  const barcolors = reuseArrayReference(previous.barcolors, next.barcolors);
  const signals = reuseArrayReference(previous.signals, next.signals);
  if (markers === previous.markers
    && fills === previous.fills
    && hlines === previous.hlines
    && bgcolors === previous.bgcolors
    && barcolors === previous.barcolors
    && signals === previous.signals
    && next.paramSchemas === previous.paramSchemas) {
    return previous;
  }
  return {
    ...next,
    markers,
    fills,
    hlines,
    bgcolors,
    barcolors,
    signals,
  };
}

function mergeIndicatorPatchOutputs(
  state: IndicatorOutputState,
  indicatorId: string,
  normalized: NormalizedIndicatorPayload,
): IndicatorOutputState {
  return {
    ...state,
    markers: [
      ...withoutIndicator(state.markers, indicatorId),
      ...mergeIndicatorItems(
        state.markers.filter((item) => item.indicatorId === indicatorId),
        normalized.markers || [],
      ),
    ],
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
  let paramSchemas = state.paramSchemas;
  if (Object.prototype.hasOwnProperty.call(paramSchemas, indicatorId)) {
    const { [indicatorId]: _removed, ...remainingParamSchemas } = paramSchemas;
    paramSchemas = remainingParamSchemas;
  }
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
  let hasChangedSchema = false;
  for (const [indicatorId, schema] of Object.entries(schemas)) {
    if (state.paramSchemas[indicatorId] !== schema) {
      hasChangedSchema = true;
      break;
    }
  }
  if (!hasChangedSchema) return state.paramSchemas;
  return { ...state.paramSchemas, ...schemas };
}

function hydrateCachedOutputs(
  state: IndicatorOutputState,
  entries: IndicatorCacheResult[] = [],
): IndicatorOutputState {
  const latestEntryByIndicator = new Map<string, IndicatorCacheResult>();
  const schemas: Record<string, IndicatorParameterSchema[]> = {};
  for (const entry of entries) {
    if (!entry?.indicatorId || !entry.normalized) continue;
    // Replacing an indicator used to move its outputs to the end of every lane.
    // Delete before set so Map iteration preserves that last-occurrence ordering.
    latestEntryByIndicator.delete(entry.indicatorId);
    latestEntryByIndicator.set(entry.indicatorId, entry);
    if (entry.schema?.length > 0) {
      schemas[entry.indicatorId] = entry.schema;
    }
  }

  const next = {
    ...createIndicatorOutputState(),
    paramSchemas: mergeParamSchemas(state, schemas),
  };
  for (const entry of latestEntryByIndicator.values()) {
    next.markers.push(...entry.normalized.markers);
    next.fills.push(...entry.normalized.fills);
    next.hlines.push(...entry.normalized.hlines);
    next.bgcolors.push(...entry.normalized.bgcolors);
    next.barcolors.push(...entry.normalized.barcolors);
    next.signals.push(...entry.normalized.signals);
  }
  return next;
}

export function indicatorOutputReducer(
  state: IndicatorOutputState,
  action: IndicatorOutputAction,
): IndicatorOutputState {
  switch (action.type) {
    case "reset-context":
      return reuseUnchangedOutputLanes(state, {
        ...createIndicatorOutputState(),
        paramSchemas: state.paramSchemas,
      });
    case "hydrate-cache":
      return reuseUnchangedOutputLanes(state, hydrateCachedOutputs(state, action.entries));
    case "snapshot": {
      let next = replaceIndicatorOutputs(state, action.indicatorId, action.normalized);
      const schema = action.schema;
      if (schema && schema.length > 0) {
        next = {
          ...next,
          paramSchemas: { ...state.paramSchemas, [action.indicatorId]: schema },
        };
      }
      return reuseUnchangedOutputLanes(state, next);
    }
    case "patch":
      return reuseUnchangedOutputLanes(
        state,
        mergeIndicatorPatchOutputs(state, action.indicatorId, action.normalized),
      );
    case "replace-range":
      return reuseUnchangedOutputLanes(
        state,
        replaceIndicatorRangeOutputs(
          state,
          action.indicatorId,
          action.normalized,
          action.range,
        ),
      );
    case "remove-indicator":
      return reuseUnchangedOutputLanes(state, removeIndicatorOutputs(state, action.indicatorId));
    case "compute-results": {
      const processedIds = new Set<string>(action.processedIds || []);
      return reuseUnchangedOutputLanes(state, {
        ...state,
        markers: [...withoutAnyIndicator(state.markers, processedIds), ...(action.markers || [])],
        fills: [...withoutAnyIndicator(state.fills, processedIds), ...(action.fills || [])],
        hlines: [...withoutAnyIndicator(state.hlines, processedIds), ...(action.hlines || [])],
        bgcolors: [...withoutAnyIndicator(state.bgcolors, processedIds), ...(action.bgcolors || [])],
        barcolors: [...withoutAnyIndicator(state.barcolors, processedIds), ...(action.barcolors || [])],
        signals: [...withoutAnyIndicator(state.signals, processedIds), ...(action.signals || [])],
        paramSchemas: mergeParamSchemas(state, action.paramSchemas),
      });
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
