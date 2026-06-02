import { mergeIndicatorItems } from "./indicatorPayloadRuntime";

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

function mergeParamSchemas(state, schemas) {
  if (!schemas || Object.keys(schemas).length === 0) return state.paramSchemas;
  return { ...state.paramSchemas, ...schemas };
}

export function indicatorOutputReducer(state, action) {
  switch (action.type) {
    case "reset-context":
      return {
        ...createIndicatorOutputState(),
        paramSchemas: state.paramSchemas,
      };
    case "snapshot": {
      const next = replaceIndicatorOutputs(state, action.indicatorId, action.normalized);
      if (action.schema?.length > 0) {
        next.paramSchemas = { ...state.paramSchemas, [action.indicatorId]: action.schema };
      }
      return next;
    }
    case "patch":
      return mergeIndicatorPatchOutputs(state, action.indicatorId, action.normalized);
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
