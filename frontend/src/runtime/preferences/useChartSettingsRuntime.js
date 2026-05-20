import { useEffect, useState } from "react";

const SETTINGS_STORAGE_KEY = "candlescope-settings";
const DEFAULT_SETTINGS = {
  theme: "dark",
  customBg: "#0f172a",
  upColor: "#22c55e",
  downColor: "#ef4444",
  cachePreset: "standard",
  cacheLimits: { minutes: 200000, hours: 50000, daily: 0 },
  ephemeralCacheBars: 86400,
};

function getSystemTheme() {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function loadSettings() {
  const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (saved) {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  }
  return DEFAULT_SETTINGS;
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
