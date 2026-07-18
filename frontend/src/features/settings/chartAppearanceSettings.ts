import { useEffect, useState } from "react";
import { normalizeMainChartType } from "../../shared/mainChartTypes.js";
import type { Dispatch, SetStateAction } from "react";
import type { MainChartType } from "../../shared/mainChartTypes.js";

const SETTINGS_STORAGE_KEY = "candlescope-settings";
const PRICE_BOX_SIZE_MODES = new Set(["atr", "traditional"]);
export type ChartTheme = "dark" | "light" | "system" | "custom";
export type PriceBoxSizeMode = "atr" | "traditional";

export interface CacheRowLimits {
  minutes: number;
  hours: number;
  daily: number;
}

export interface ChartSettings extends Record<string, unknown> {
  theme: ChartTheme;
  customBg: string;
  upColor: string;
  downColor: string;
  chartType: MainChartType;
  renkoBoxSizeMode: PriceBoxSizeMode;
  renkoAtrLength: number;
  renkoBoxSize: number;
  pointFigureBoxSizeMode: PriceBoxSizeMode;
  pointFigureAtrLength: number;
  pointFigureBoxSize: number;
  pointFigureReversalAmount: number;
  kagiReversalMode: PriceBoxSizeMode;
  kagiAtrLength: number;
  kagiReversalAmount: number;
  lineBreakNumberOfLines: number;
  cachePreset: string;
  cacheLimits: CacheRowLimits;
  ephemeralCacheBars: number;
  frontendCacheBudgetBytes: number;
  sqliteStorageBudgetBytes: number | null;
  storageRowLimitsEnabled: boolean;
  timezone?: string;
}

export const DEFAULT_SETTINGS: ChartSettings = {
  theme: "dark",
  customBg: "#0f172a",
  upColor: "#22c55e",
  downColor: "#ef4444",
  chartType: "candlestick",
  renkoBoxSizeMode: "atr",
  renkoAtrLength: 14,
  renkoBoxSize: 1,
  pointFigureBoxSizeMode: "atr",
  pointFigureAtrLength: 14,
  pointFigureBoxSize: 1,
  pointFigureReversalAmount: 3,
  kagiReversalMode: "atr",
  kagiAtrLength: 14,
  kagiReversalAmount: 1,
  lineBreakNumberOfLines: 3,
  cachePreset: "standard",
  cacheLimits: { minutes: 200000, hours: 50000, daily: 0 },
  ephemeralCacheBars: 86400,
  frontendCacheBudgetBytes: 64 * 1024 * 1024,
  sqliteStorageBudgetBytes: null,
  storageRowLimitsEnabled: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoxSizeMode(value: unknown, fallback: PriceBoxSizeMode): PriceBoxSizeMode {
  return typeof value === "string" && PRICE_BOX_SIZE_MODES.has(value) ? value as PriceBoxSizeMode : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (
    value == null
    || typeof value === "boolean"
    || (typeof value === "string" && value.trim() === "")
  ) return fallback;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function normalizeSettings(settings: unknown = {}): ChartSettings {
  const source = isRecord(settings) ? settings : {};
  const normalized = { ...DEFAULT_SETTINGS, ...source };
  normalized.chartType = normalizeMainChartType(source.chartType ?? normalized.chartType);
  normalized.renkoBoxSizeMode = normalizeBoxSizeMode(
    source.renkoBoxSizeMode,
    DEFAULT_SETTINGS.renkoBoxSizeMode,
  );
  const atrLength = Math.trunc(Number(normalized.renkoAtrLength));
  normalized.renkoAtrLength = Number.isFinite(atrLength) && atrLength >= 2 && atrLength <= 500
    ? atrLength
    : DEFAULT_SETTINGS.renkoAtrLength;
  const boxSize = Number(normalized.renkoBoxSize);
  normalized.renkoBoxSize = Number.isFinite(boxSize) && boxSize > 0
    ? boxSize
    : DEFAULT_SETTINGS.renkoBoxSize;
  normalized.pointFigureBoxSizeMode = normalizeBoxSizeMode(
    source.pointFigureBoxSizeMode,
    DEFAULT_SETTINGS.pointFigureBoxSizeMode,
  );
  const pointFigureAtrLength = Math.trunc(Number(normalized.pointFigureAtrLength));
  normalized.pointFigureAtrLength = Number.isFinite(pointFigureAtrLength)
    && pointFigureAtrLength >= 2
    && pointFigureAtrLength <= 500
    ? pointFigureAtrLength
    : DEFAULT_SETTINGS.pointFigureAtrLength;
  const pointFigureBoxSize = Number(normalized.pointFigureBoxSize);
  normalized.pointFigureBoxSize = Number.isFinite(pointFigureBoxSize) && pointFigureBoxSize > 0
    ? pointFigureBoxSize
    : DEFAULT_SETTINGS.pointFigureBoxSize;
  const pointFigureReversalAmount = Math.trunc(Number(normalized.pointFigureReversalAmount));
  normalized.pointFigureReversalAmount = Number.isFinite(pointFigureReversalAmount)
    && pointFigureReversalAmount >= 1
    && pointFigureReversalAmount <= 100
    ? pointFigureReversalAmount
    : DEFAULT_SETTINGS.pointFigureReversalAmount;
  normalized.kagiReversalMode = normalizeBoxSizeMode(
    source.kagiReversalMode,
    DEFAULT_SETTINGS.kagiReversalMode,
  );
  const kagiAtrLength = Math.trunc(Number(normalized.kagiAtrLength));
  normalized.kagiAtrLength = Number.isFinite(kagiAtrLength)
    && kagiAtrLength >= 2
    && kagiAtrLength <= 500
    ? kagiAtrLength
    : DEFAULT_SETTINGS.kagiAtrLength;
  const kagiReversalAmount = Number(normalized.kagiReversalAmount);
  normalized.kagiReversalAmount = Number.isFinite(kagiReversalAmount)
    && kagiReversalAmount > 0
    ? kagiReversalAmount
    : DEFAULT_SETTINGS.kagiReversalAmount;
  const lineBreakNumberOfLines = Math.trunc(Number(normalized.lineBreakNumberOfLines));
  normalized.lineBreakNumberOfLines = Number.isFinite(lineBreakNumberOfLines)
    && lineBreakNumberOfLines >= 1
    && lineBreakNumberOfLines <= 50
    ? lineBreakNumberOfLines
    : DEFAULT_SETTINGS.lineBreakNumberOfLines;
  const cacheLimits = isRecord(source.cacheLimits) ? source.cacheLimits : {};
  normalized.cacheLimits = {
    minutes: boundedInteger(cacheLimits.minutes, DEFAULT_SETTINGS.cacheLimits.minutes, 0, 100_000_000),
    hours: boundedInteger(cacheLimits.hours, DEFAULT_SETTINGS.cacheLimits.hours, 0, 100_000_000),
    daily: boundedInteger(cacheLimits.daily, DEFAULT_SETTINGS.cacheLimits.daily, 0, 100_000_000),
  };
  normalized.ephemeralCacheBars = boundedInteger(
    source.ephemeralCacheBars,
    DEFAULT_SETTINGS.ephemeralCacheBars,
    1,
    1_000_000,
  );
  normalized.frontendCacheBudgetBytes = boundedInteger(
    source.frontendCacheBudgetBytes,
    DEFAULT_SETTINGS.frontendCacheBudgetBytes,
    16 * 1024 * 1024,
    4 * 1024 * 1024 * 1024,
  );
  normalized.sqliteStorageBudgetBytes = source.sqliteStorageBudgetBytes === null
    ? null
    : boundedInteger(
      source.sqliteStorageBudgetBytes,
      DEFAULT_SETTINGS.sqliteStorageBudgetBytes ?? 0,
      1,
      16 * 1024 * 1024 * 1024 * 1024,
    ) || null;
  normalized.storageRowLimitsEnabled = typeof source.storageRowLimitsEnabled === "boolean"
    ? source.storageRowLimitsEnabled
    : DEFAULT_SETTINGS.storageRowLimitsEnabled;
  return normalized;
}

function getSystemTheme(): "dark" | "light" {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function parseStoredSettings(saved: string | null | undefined): ChartSettings {
  if (!saved) return normalizeSettings();
  try {
    return normalizeSettings(JSON.parse(saved));
  } catch {
    return normalizeSettings();
  }
}

function loadSettings(): ChartSettings {
  if (typeof localStorage === "undefined") return normalizeSettings();
  try {
    return parseStoredSettings(localStorage.getItem(SETTINGS_STORAGE_KEY));
  } catch {
    return normalizeSettings();
  }
}

export interface ChartSettingsRuntime {
  settings: ChartSettings;
  setSettings: Dispatch<SetStateAction<ChartSettings>>;
  resolvedTheme: string;
}

export function useChartSettingsRuntime(): ChartSettingsRuntime {
  const [settings, setSettings] = useState<ChartSettings>(loadSettings);
  const [systemTheme, setSystemTheme] = useState(getSystemTheme);
  const resolvedTheme = settings.theme === "system" ? systemTheme : settings.theme;

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "light" : "dark");
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
    }

    mediaQuery.addListener(handleSystemThemeChange);
    return () => mediaQuery.removeListener(handleSystemThemeChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolvedTheme);
    if (settings.theme === "custom") {
      root.style.setProperty("--bg-primary", settings.customBg);
      root.style.setProperty("--bg-secondary", settings.customBg);
    } else {
      root.style.removeProperty("--bg-primary");
      root.style.removeProperty("--bg-secondary");
    }
    root.style.setProperty("--candle-up", settings.upColor);
    root.style.setProperty("--candle-down", settings.downColor);
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Settings persistence failures must not interrupt chart rendering.
    }
  }, [resolvedTheme, settings]);

  return { settings, setSettings, resolvedTheme };
}
