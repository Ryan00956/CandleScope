import { useCallback, useMemo, useState } from "react";

const FAVORITES_KEY = "candlescope-favorite-symbols-v2";

export function loadSymbolFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function saveSymbolFavorites(list: string[]): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

export function useSymbolFavoritesStore() {
  const [favorites, setFavorites] = useState(loadSymbolFavorites);

  const toggleFavorite = useCallback((symbolKey: string) => {
    setFavorites((prev) => {
      const next = prev.includes(symbolKey)
        ? prev.filter((key) => key !== symbolKey)
        : [...prev, symbolKey];
      saveSymbolFavorites(next);
      return next;
    });
  }, []);

  const favoriteSet = useMemo(() => new Set<string>(favorites), [favorites]);
  const actions = useMemo(() => ({
    toggleFavorite,
  }), [toggleFavorite]);

  return {
    favorites,
    favoriteSet,
    actions,
  };
}
