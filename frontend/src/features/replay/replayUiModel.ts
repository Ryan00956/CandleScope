import type {
  ReplayCatalogEntry,
  ReplaySessionState,
} from "./replayTypes.js";
import type { ReplayStoreSnapshot } from "./replayStore.js";
import type { ReplayV2RunState } from "./replayV2Types.js";
import { getLocale } from "../../i18n/index.js";

export const REPLAY_ACTIVITY_VIEW_LIMIT = 20;

export function recentReplayActivity<T>(items: readonly T[]): readonly T[] {
  return items.slice(-REPLAY_ACTIVITY_VIEW_LIMIT).reverse();
}

export function replayCatalogIdentity(entry: ReplayCatalogEntry): string {
  const { exchange, market_type: marketType, symbol } = entry.identity;
  return `${exchange}:${marketType}:${symbol}`;
}

export function replayOwnsController(store: ReplayStoreSnapshot, clientInstanceId: string): boolean {
  return store.controllerClientId === clientInstanceId;
}

export function replayEffectiveTrainingState(
  globalState: ReplayV2RunState | null | undefined,
  adapterState: ReplaySessionState | null,
  controllerClientId: string | null,
): ReplaySessionState | ReplayV2RunState | null {
  if (globalState === "ERROR" || adapterState === "ERROR") return "ERROR";
  if (globalState === "ENDED" || adapterState === "ENDED") return "ENDED";
  if (controllerClientId === null && (globalState === "PLAYING" || globalState === "ADVANCING")) {
    return adapterState === "INITIALIZING" ? "INITIALIZING" : "PAUSED";
  }
  if (controllerClientId === null && adapterState === "PLAYING") return "PAUSED";
  return globalState ?? adapterState;
}

export function replayProgress(store: ReplayStoreSnapshot): number | null {
  const config = store.sessionConfig;
  if (!config || store.virtualTimeMs === null || store.replayStartMs === null || config.horizon_ms <= 0) return null;
  return Math.max(0, Math.min(1, (store.virtualTimeMs - store.replayStartMs) / config.horizon_ms));
}

export function formatReplaySyntheticTime(valueMs: number, originMs: number): string {
  const delta = valueMs - originMs;
  const sign = delta < 0 ? "-" : "+";
  const magnitude = Math.abs(delta);
  const day = Math.floor(magnitude / 86_400_000);
  const withinDay = magnitude % 86_400_000;
  const hours = Math.floor(withinDay / 3_600_000);
  const minutes = Math.floor((withinDay % 3_600_000) / 60_000);
  const seconds = Math.floor((withinDay % 60_000) / 1_000);
  return `D${sign}${day} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatReplayPublicTime(
  valueMs: number | null,
  { blindMode, originMs }: { blindMode: boolean; originMs: number | null },
): string {
  if (valueMs === null) return "--";
  if (blindMode && originMs !== null) return formatReplaySyntheticTime(valueMs, originMs);
  return new Intl.DateTimeFormat(getLocale() === "en" ? "en-GB" : "zh-CN", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(valueMs);
}
