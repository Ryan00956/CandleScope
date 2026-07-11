import { useEffect, useState } from "react";
import { normalizeMainChartType } from "../../shared/mainChartTypes.js";

const SETTINGS_STORAGE_KEY = "candlescope-settings";
const PRICE_BOX_SIZE_MODES = new Set(["atr", "traditional"]);
export const DEFAULT_SETTINGS = {
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
  cachePreset: "standard",
  cacheLimits: { minutes: 200000, hours: 50000, daily: 0 },
  ephemeralCacheBars: 86400,
  frontendCacheBudgetBytes: 64 * 1024 * 1024,
  sqliteStorageBudgetBytes: null,
  storageRowLimitsEnabled: false,
};

export function normalizeSettings(settings = {}) {
  const normalized = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  normalized.chartType = normalizeMainChartType(normalized.chartType);
  normalized.renkoBoxSizeMode = PRICE_BOX_SIZE_MODES.has(normalized.renkoBoxSizeMode)
    ? normalized.renkoBoxSizeMode
    : DEFAULT_SETTINGS.renkoBoxSizeMode;
  const atrLength = Math.trunc(Number(normalized.renkoAtrLength));
  normalized.renkoAtrLength = Number.isFinite(atrLength) && atrLength >= 2 && atrLength <= 500
    ? atrLength
    : DEFAULT_SETTINGS.renkoAtrLength;
  const boxSize = Number(normalized.renkoBoxSize);
  normalized.renkoBoxSize = Number.isFinite(boxSize) && boxSize > 0
    ? boxSize
    : DEFAULT_SETTINGS.renkoBoxSize;
  normalized.pointFigureBoxSizeMode = PRICE_BOX_SIZE_MODES.has(normalized.pointFigureBoxSizeMode)
    ? normalized.pointFigureBoxSizeMode
    : DEFAULT_SETTINGS.pointFigureBoxSizeMode;
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
  return normalized;
}

function getSystemTheme() {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function loadSettings() {
  const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (saved) {
    return normalizeSettings(JSON.parse(saved));
  }
  return normalizeSettings();
}

export function useChartSettingsRuntime() {
  const [settings, setSettings] = useState(loadSettings);
  const [systemTheme, setSystemTheme] = useState(getSystemTheme);
  const resolvedTheme = settings.theme === "system" ? systemTheme : settings.theme;

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleSystemThemeChange = (event) => {
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
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [resolvedTheme, settings]);

  return { settings, setSettings, resolvedTheme };
}
