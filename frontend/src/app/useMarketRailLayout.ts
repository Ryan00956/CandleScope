import { useCallback, useMemo, useState } from "react";
import { getBrowserStorage } from "../shared/browserStorage.js";
import type { MarketRailLayoutActions, MarketRailLayoutState } from "./marketRailTypes.js";
import {
  loadMarketRailLayout,
  normalizeOpenViewIds,
  normalizeViewHeights,
  saveMarketRailLayout,
  toggleOpenViewId,
} from "./marketRailOpenState.js";

export function useMarketRailLayout(): MarketRailLayoutState & {
  actions: MarketRailLayoutActions;
} {
  const [storage] = useState(getBrowserStorage);
  const [state, setState] = useState(() => loadMarketRailLayout(storage));

  const setOpenViewIds = useCallback((ids: readonly string[]) => {
    setState((current) => {
      const next = {
        ...current,
        openViewIds: normalizeOpenViewIds(ids),
      };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const toggleView = useCallback((viewId: string) => {
    setState((current) => {
      const next = {
        ...current,
        openViewIds: toggleOpenViewId(current.openViewIds, viewId),
      };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const openView = useCallback((viewId: string) => {
    setState((current) => {
      if (current.openViewIds.includes(viewId)) return current;
      const next = {
        ...current,
        openViewIds: normalizeOpenViewIds([...current.openViewIds, viewId]),
      };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const closeView = useCallback((viewId: string) => {
    setState((current) => {
      if (!current.openViewIds.includes(viewId)) return current;
      const next = {
        ...current,
        openViewIds: current.openViewIds.filter((id) => id !== viewId),
      };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const setViewHeight = useCallback((viewId: string, height: number) => {
    setState((current) => {
      const viewHeights = normalizeViewHeights({
        ...current.viewHeights,
        [viewId]: height,
      });
      const next = { ...current, viewHeights };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const isOpen = useCallback(
    (viewId: string) => state.openViewIds.includes(viewId),
    [state.openViewIds],
  );

  const actions = useMemo<MarketRailLayoutActions>(() => ({
    setOpenViewIds,
    toggleView,
    openView,
    closeView,
    setViewHeight,
    isOpen,
  }), [closeView, isOpen, openView, setOpenViewIds, setViewHeight, toggleView]);

  return {
    openViewIds: state.openViewIds,
    viewHeights: state.viewHeights,
    actions,
  };
}
