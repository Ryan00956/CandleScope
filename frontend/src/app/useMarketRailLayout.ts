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
      const openViewIds = normalizeOpenViewIds(ids);
      const next = {
        ...current,
        openViewIds,
      };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const toggleView = useCallback((viewId: string) => {
    setState((current) => {
      // Hidden panel + existing selection: activity click restores the full panel.
      if (current.panelCollapsed) {
        const openViewIds = current.openViewIds.includes(viewId)
          ? [...current.openViewIds]
          : normalizeOpenViewIds([...current.openViewIds, viewId]);
        const next = {
          ...current,
          openViewIds,
          panelCollapsed: false,
        };
        saveMarketRailLayout(next, storage);
        return next;
      }

      const openViewIds = toggleOpenViewId(current.openViewIds, viewId);
      const next = {
        ...current,
        openViewIds,
        panelCollapsed: false,
      };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const openView = useCallback((viewId: string) => {
    setState((current) => {
      if (current.openViewIds.includes(viewId) && !current.panelCollapsed) return current;
      const next = {
        ...current,
        openViewIds: current.openViewIds.includes(viewId)
          ? [...current.openViewIds]
          : normalizeOpenViewIds([...current.openViewIds, viewId]),
        panelCollapsed: false,
      };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const closeView = useCallback((viewId: string) => {
    setState((current) => {
      if (!current.openViewIds.includes(viewId)) return current;
      const openViewIds = current.openViewIds.filter((id) => id !== viewId);
      const next = {
        ...current,
        openViewIds,
      };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const setPanelCollapsed = useCallback((collapsed: boolean) => {
    setState((current) => {
      if (collapsed === current.panelCollapsed) return current;
      const next = { ...current, panelCollapsed: collapsed };
      saveMarketRailLayout(next, storage);
      return next;
    });
  }, [storage]);

  const togglePanelCollapsed = useCallback(() => {
    setState((current) => {
      const next = { ...current, panelCollapsed: !current.panelCollapsed };
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
    setPanelCollapsed,
    togglePanelCollapsed,
    setViewHeight,
    isOpen,
  }), [
    closeView,
    isOpen,
    openView,
    setOpenViewIds,
    setPanelCollapsed,
    setViewHeight,
    togglePanelCollapsed,
    toggleView,
  ]);

  return {
    openViewIds: state.openViewIds,
    panelCollapsed: state.panelCollapsed,
    viewHeights: state.viewHeights,
    actions,
  };
}
