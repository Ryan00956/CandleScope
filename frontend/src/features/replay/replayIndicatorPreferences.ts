export type ReplayLocalIndicatorId =
  | "sma"
  | "ema"
  | "boll"
  | "rsi"
  | "macd"
  | "atr"
  | "vol"
  | "cvd"
  | "delta";

export interface ReplayLocalIndicatorPreference {
  readonly id: ReplayLocalIndicatorId;
  readonly visible: boolean;
  readonly period: number;
}

export interface ReplayIndicatorPreferenceSnapshot {
  readonly indicators: readonly ReplayLocalIndicatorPreference[];
  readonly inheritedFromLiveWorkspace: boolean;
  readonly unsupportedLiveIndicators: readonly string[];
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const ACTIVE_INDICATORS_KEY = "candlescope-active-indicators";
const TRADE_FLOW_PREFERENCES_KEY = "candlescope-trade-flow-preferences-v1";
const REPLAY_INDICATORS_KEY_PREFIX = "candlescope-replay-local-indicators-v1:";
const REPLAY_INDICATORS_SCHEMA_VERSION = 1;

export const REPLAY_LOCAL_INDICATOR_CATALOG: ReadonlyArray<{
  readonly id: ReplayLocalIndicatorId;
  readonly nameKey: MessageKey;
  readonly descriptionKey: MessageKey;
  readonly pane: "main" | "sub";
  readonly defaultPeriod: number;
}> = Object.freeze([
  { id: "sma", nameKey: "replay.indicator.sma.name", descriptionKey: "replay.indicator.sma.desc", pane: "main", defaultPeriod: 20 },
  { id: "ema", nameKey: "replay.indicator.ema.name", descriptionKey: "replay.indicator.ema.desc", pane: "main", defaultPeriod: 20 },
  { id: "boll", nameKey: "replay.indicator.boll.name", descriptionKey: "replay.indicator.boll.desc", pane: "main", defaultPeriod: 20 },
  { id: "rsi", nameKey: "replay.indicator.rsi.name", descriptionKey: "replay.indicator.rsi.desc", pane: "sub", defaultPeriod: 14 },
  { id: "macd", nameKey: "replay.indicator.macd.name", descriptionKey: "replay.indicator.macd.desc", pane: "sub", defaultPeriod: 12 },
  { id: "atr", nameKey: "replay.indicator.atr.name", descriptionKey: "replay.indicator.atr.desc", pane: "sub", defaultPeriod: 14 },
  { id: "vol", nameKey: "replay.indicator.vol.name", descriptionKey: "replay.indicator.vol.desc", pane: "sub", defaultPeriod: 1 },
  { id: "cvd", nameKey: "replay.indicator.cvd.name", descriptionKey: "replay.indicator.cvd.desc", pane: "sub", defaultPeriod: 1 },
  { id: "delta", nameKey: "replay.indicator.delta.name", descriptionKey: "replay.indicator.delta.desc", pane: "sub", defaultPeriod: 1 },
]);

export function replayLocalIndicatorCatalog(locale: LocaleId = getLocale()) {
  return REPLAY_LOCAL_INDICATOR_CATALOG.map((item) => ({
    ...item,
    name: t(item.nameKey, {}, locale),
    description: t(item.descriptionKey, {}, locale),
  }));
}

const catalogById = new Map(REPLAY_LOCAL_INDICATOR_CATALOG.map((item) => [item.id, item]));

function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeLabel(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim().slice(0, 80) : "";
  return normalized || fallback;
}

function safePeriod(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500
    ? parsed
    : fallback;
}

function liveBuiltinId(value: Record<string, unknown>): ReplayLocalIndicatorId | null {
  const identity = [
    value.id,
    value.engineName,
    value.name,
  ].map((item) => String(item ?? "").trim().toLowerCase()).join(" ");
  if (/(^|\W)vol(?:ume)?(\W|$)|成交量/.test(identity)) return "vol";
  if (/(^|\W)macd(\W|$)/.test(identity)) return "macd";
  if (/(^|\W)rsi(\W|$)|relative strength/.test(identity)) return "rsi";
  if (/(^|\W)atr(\W|$)|average true range/.test(identity)) return "atr";
  if (/(^|\W)boll(?:inger)?(\W|$)|布林/.test(identity)) return "boll";
  if (/(^|\W)ema(\W|$)|exponential moving/.test(identity)) return "ema";
  if (/(^|\W)(?:sma|ma)(\W|$)|simple moving/.test(identity)) return "sma";
  return null;
}

function periodFromLiveIndicator(
  value: Record<string, unknown>,
  id: ReplayLocalIndicatorId,
): number {
  const params = isRecord(value.params) ? value.params : {};
  const fallback = catalogById.get(id)?.defaultPeriod ?? 20;
  return safePeriod(
    params.period
      ?? params.length
      ?? params.window
      ?? (id === "macd" ? params.fast : undefined),
    fallback,
  );
}

function deriveFromLiveWorkspace(storage: StorageLike): ReplayIndicatorPreferenceSnapshot {
  const indicators = new Map<ReplayLocalIndicatorId, ReplayLocalIndicatorPreference>();
  const unsupported: string[] = [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(ACTIVE_INDICATORS_KEY) || "[]");
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!isRecord(item)) continue;
        const id = liveBuiltinId(item);
        if (id === null) {
          unsupported.push(safeLabel(item.name, safeLabel(item.id, t("replay.indicator.unnamed"))));
          continue;
        }
        indicators.set(id, {
          id,
          visible: item.visible !== false,
          period: periodFromLiveIndicator(item, id),
        });
      }
    }
  } catch {
    // A damaged live preference must not make the replay page unavailable.
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(TRADE_FLOW_PREFERENCES_KEY) || "null");
    if (isRecord(parsed) && isRecord(parsed.indicators)) {
      for (const id of ["cvd", "delta"] as const) {
        const candidate = parsed.indicators[id];
        if (!isRecord(candidate) || candidate.added !== true) continue;
        indicators.set(id, {
          id,
          visible: candidate.visible !== false,
          period: 1,
        });
      }
    }
  } catch {
    // Keep the supported builtin snapshot even if trade-flow preferences are damaged.
  }
  return {
    indicators: [...indicators.values()],
    inheritedFromLiveWorkspace: true,
    unsupportedLiveIndicators: unsupported,
  };
}

function parseStoredSnapshot(raw: string | null): ReplayIndicatorPreferenceSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)
      || parsed.version !== REPLAY_INDICATORS_SCHEMA_VERSION
      || !Array.isArray(parsed.indicators)
      || !Array.isArray(parsed.unsupportedLiveIndicators)) return null;
    const indicators = new Map<ReplayLocalIndicatorId, ReplayLocalIndicatorPreference>();
    for (const value of parsed.indicators) {
      if (!isRecord(value)
        || typeof value.id !== "string"
        || !catalogById.has(value.id as ReplayLocalIndicatorId)
        || typeof value.visible !== "boolean") continue;
      const id = value.id as ReplayLocalIndicatorId;
      indicators.set(id, {
        id,
        visible: value.visible,
        period: safePeriod(value.period, catalogById.get(id)?.defaultPeriod ?? 20),
      });
    }
    return {
      indicators: [...indicators.values()],
      inheritedFromLiveWorkspace: parsed.inheritedFromLiveWorkspace === true,
      unsupportedLiveIndicators: parsed.unsupportedLiveIndicators
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.slice(0, 80))
        .slice(0, 32),
    };
  } catch {
    return null;
  }
}

function storageKey(sessionId: string): string {
  return `${REPLAY_INDICATORS_KEY_PREFIX}${sessionId}`;
}

export function loadReplayIndicatorPreferences(
  sessionId: string,
  storage: StorageLike | null = browserStorage(),
): ReplayIndicatorPreferenceSnapshot {
  if (!storage) {
    return {
      indicators: [],
      inheritedFromLiveWorkspace: false,
      unsupportedLiveIndicators: [],
    };
  }
  const stored = parseStoredSnapshot(storage.getItem(storageKey(sessionId)));
  if (stored !== null) return stored;
  const inherited = deriveFromLiveWorkspace(storage);
  saveReplayIndicatorPreferences(sessionId, inherited, storage);
  return inherited;
}

export function saveReplayIndicatorPreferences(
  sessionId: string,
  snapshot: ReplayIndicatorPreferenceSnapshot,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey(sessionId), JSON.stringify({
      version: REPLAY_INDICATORS_SCHEMA_VERSION,
      indicators: snapshot.indicators,
      inheritedFromLiveWorkspace: snapshot.inheritedFromLiveWorkspace,
      unsupportedLiveIndicators: snapshot.unsupportedLiveIndicators,
    }));
  } catch {
    // Indicator view preferences are best-effort and never affect replay evidence.
  }
}

export function clearReplayIndicatorPreferences(
  sessionIds: readonly string[],
  storage: StorageLike | null = browserStorage(),
): void {
  if (storage?.removeItem === undefined) return;
  for (const sessionId of new Set(sessionIds.map((value) => value.trim()))) {
    if (!sessionId) continue;
    try {
      storage.removeItem(storageKey(sessionId));
    } catch {
      // Archive deletion remains authoritative when browser storage is blocked.
    }
  }
}
import { getLocale, t, type LocaleId, type MessageKey } from "../../i18n/index.js";
