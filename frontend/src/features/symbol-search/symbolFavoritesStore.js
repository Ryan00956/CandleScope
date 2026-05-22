import { useCallback, useMemo, useState } from "react";

const FAVORITES_KEY = "candlescope-favorite-symbols-v2";

export function loadSymbolFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSymbolFavorites(list) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

export function useSymbolFavoritesStore() {
  const [favorites, setFavorites] = useState(loadSymbolFavorites);

  const toggleFavorite = useCallback((symbolKey) => {
    setFavorites((prev) => {
      const next = prev.includes(symbolKey)
        ? prev.filter((key) => key !== symbolKey)
        : [...prev, symbolKey];
      saveSymbolFavorites(next);
      return next;
    });
  }, []);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const actions = useMemo(() => ({
    toggleFavorite,
  }), [toggleFavorite]);

  return {
    favorites,
    favoriteSet,
    actions,
  };
}