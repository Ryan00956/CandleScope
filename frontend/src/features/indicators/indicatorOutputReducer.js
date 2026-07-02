import {
  mergeIndicatorItems,
  replaceIndicatorItemsRange,
} from "./indicatorPayloadRuntime.js";

const OUTPUT_KEYS = ["markers", "fills", "hlines", "bgcolors", "barcolors", "signals"];

export function createIndicatorOutputState() {
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

function withoutIndicator(items = [], indicatorId) {
  return items.filter((item) => item.indicatorId !== indicatorId);
}

function withoutAnyIndicator(items = [], indicatorIds = new Set()) {
  return items.filter((item) => !indicatorIds.has(item.indicatorId));
}

function replaceIndicatorOutputs(state, indicatorId, normalized) {
  const next = { ...state };
  for (const key of OUTPUT_KEYS) {
    next[key] = [
      ...withoutIndicator(state[key], indicatorId),
      ...(normalized[key] || []),
    ];
  }
  return next;
}

function mergeIndicatorPatchOutputs(state, indicatorId, normalized) {
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

function replaceIndicatorRangeOutputs(state, indicatorId, normalized, range) {
  const next = { ...state };
  for (const key of OUTPUT_KEYS) {
    next[key] = [
      ...withoutIndicator(state[key], indicatorId),
      ...replaceIndicatorItemsRange(
        state[key].filter((item) => item.indicatorId === indicatorId),
        normalized[key] || [],
        range,
      ),
    ];
  }
  return next;
}

function removeIndicatorOutputs(state, indicatorId) {
  const next = { ...state };
  for (const key of OUTPUT_KEYS) {
    next[key] = withoutIndicator(state[key], indicatorId);
  }
  const { [indicatorId]: _removed, ...paramSchemas } = state.paramSchemas || {};
  next.paramSchemas = paramSchemas;
  return next;
}

function mergeParamSchemas(state, schemas) {
  if (!schemas || Object.keys(schemas).length === 0) return state.paramSchemas;
  return { ...state.paramSchemas, ...schemas };
}

function hydrateCachedOutputs(state, entries = []) {
  let next = {
    ...createIndicatorOutputState(),
    paramSchemas: state.paramSchemas,
  };
  const schemas = {};
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

export function indicatorOutputReducer(state, action) {
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
      if (action.schema?.length > 0) {
        next.paramSchemas = { ...state.paramSchemas, [action.indicatorId]: action.schema };
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
      const processedIds = new Set(action.processedIds || []);
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
    default:
      return state;
  }
}
