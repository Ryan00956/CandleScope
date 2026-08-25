export const STRATEGY_RESEARCH_COMPAT_NOTICE_KEY = "candlescope:strategy-research:compat-notice:v1";

export const STRATEGY_RESEARCH_LEGACY_STORAGE_KEYS = [
  "candlescope-strategy-drafts-v1",
  "candlescope.python-studio.v1",
  "candlescope:strategy-research:v1",
] as const;

export const STRATEGY_RESEARCH_LEGACY_STORAGE_PREFIXES = [
  "candlescope:local-interval:v1:",
  "candlescope:local-analysis:v1:",
  "candlescope:local-indicators:v1:",
] as const;

type NoticeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function isLegacyResearchStorageKey(key: string): boolean {
  if ((STRATEGY_RESEARCH_LEGACY_STORAGE_KEYS as readonly string[]).includes(key)) return true;
  return STRATEGY_RESEARCH_LEGACY_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function listLegacyResearchStorageKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => isLegacyResearchStorageKey(key));
}

export function isCompatNoticeDismissed(storage?: NoticeStorage | null): boolean {
  const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
  if (target === null) return false;
  try {
    const raw = target.getItem(STRATEGY_RESEARCH_COMPAT_NOTICE_KEY);
    if (raw == null) return false;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && (parsed as { dismissed?: unknown }).dismissed === true;
  } catch {
    return false;
  }
}

export function dismissCompatNotice(storage?: NoticeStorage | null): void {
  const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
  if (target === null) return;
  target.setItem(STRATEGY_RESEARCH_COMPAT_NOTICE_KEY, JSON.stringify({
    schemaVersion: 1,
    dismissed: true,
  }));
}
