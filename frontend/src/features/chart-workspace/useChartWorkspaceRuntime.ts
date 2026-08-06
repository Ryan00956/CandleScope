import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { ChartSettings } from "../settings/chartAppearanceSettings.js";
import type { IndicatorDefinition } from "../indicators/indicatorTypes.js";
import {
  CHART_WORKSPACE_TEMPLATE_NAMES,
  cloneChartWorkspaceDocument,
  createChartWorkspaceId,
  createChartWorkspaceRecord,
  createTemplateChartWorkspaceDocument,
  normalizeChartWorkspaceName,
  removeChartWorkspace,
  summarizeChartWorkspaces,
  uniqueChartWorkspaceName,
} from "./chartWorkspaceLibrary.js";
import {
  createChartWorkspaceRepository,
  type ChartWorkspacePersistenceMode,
  type ChartWorkspaceRepository,
} from "./chartWorkspaceRepository.js";
import {
  CELL_CHART_SETTING_KEYS,
  type ChartCellChartSettings,
  type ChartDrawingLayerSetId,
  type ChartCellId,
  type ChartCellPriceScale,
  type ChartLinkGroupId,
  type ChartLinkGroupSettings,
  type ChartLinkRole,
  type ChartWorkspaceDocument,
  type ChartWorkspaceId,
  type ChartWorkspaceLayout,
  type ChartWorkspaceLibrarySnapshot,
  type ChartWorkspaceSummary,
  type ChartWorkspaceTemplateId,
} from "./chartWorkspaceTypes.js";
import {
  createChartWorkspaceLayoutTree,
  detectChartWorkspaceLayout,
  updateChartWorkspaceSplitRatio,
  visibleCellIds,
} from "./chartWorkspaceLayout.js";
import {
  applyChartLinkSettingsPatch,
  applyLinkedSessionUpdate,
  assignCellLinkGroup,
  assignCellLinkRole,
  preferredChartLinkPublisher,
} from "./chartWorkspaceLinkModel.js";

export type ChartWorkspaceSaveState = "loading" | "saving" | "saved" | "error";

export interface ChartWorkspaceRuntime {
  view: {
    document: ChartWorkspaceDocument;
    activeWorkspaceId: ChartWorkspaceId;
    activeWorkspaceName: string;
    runtimeKey: string;
    workspaces: ChartWorkspaceSummary[];
    layout: ChartWorkspaceLayout;
    activeCellId: ChartCellId;
    activeCell: ChartWorkspaceDocument["cells"][ChartCellId];
    visibleCellIds: ChartCellId[];
    ready: boolean;
  };
  actions: {
    switchWorkspace(workspaceId: ChartWorkspaceId): void;
    createWorkspace(templateId: ChartWorkspaceTemplateId): void;
    duplicateWorkspace(workspaceId?: ChartWorkspaceId): void;
    renameWorkspace(workspaceId: ChartWorkspaceId, name: string): void;
    deleteWorkspace(workspaceId: ChartWorkspaceId): void;
    setLayout(layout: ChartWorkspaceTemplateId): void;
    setActiveCell(cellId: ChartCellId): void;
    toggleMaximize(cellId: ChartCellId): void;
    setCellLinkGroup(cellId: ChartCellId, group: ChartLinkGroupId | null): void;
    setCellLinkRole(cellId: ChartCellId, role: ChartLinkRole): void;
    setCellDrawingLayerSet(cellId: ChartCellId, layerSet: ChartDrawingLayerSetId): void;
    updateLinkGroupSettings(
      group: ChartLinkGroupId,
      patch: Partial<ChartLinkGroupSettings>,
    ): void;
    setLayoutRatio(splitId: string, ratio: number): void;
    updateCellSession(cellId: ChartCellId, session: ChartSession): void;
    updateCellChartSettings(cellId: ChartCellId, settings: ChartSettings | ChartCellChartSettings): void;
    updateCellPriceScale(cellId: ChartCellId, priceScale: ChartCellPriceScale): void;
    updateCellIndicators(cellId: ChartCellId, indicators: IndicatorDefinition[]): void;
  };
  status: {
    saveState: ChartWorkspaceSaveState;
    persistenceMode: ChartWorkspacePersistenceMode | null;
    lastSavedAt: number | null;
    error: string | null;
  };
}

export interface UseChartWorkspaceRuntimeOptions {
  repository?: ChartWorkspaceRepository;
  now?: () => number;
  createId?: () => ChartWorkspaceId;
  autosaveDelayMs?: number;
}

interface PersistenceStatus {
  saveState: ChartWorkspaceSaveState;
  persistenceMode: ChartWorkspacePersistenceMode | null;
  lastSavedAt: number | null;
  error: string | null;
}

function pickCellChartSettings(settings: ChartSettings | ChartCellChartSettings): ChartCellChartSettings {
  return Object.fromEntries(
    CELL_CHART_SETTING_KEYS.map((key) => [key, settings[key]]),
  ) as ChartCellChartSettings;
}

function activeWorkspace(snapshot: ChartWorkspaceLibrarySnapshot) {
  return snapshot.workspaces.find((workspace) => workspace.id === snapshot.activeWorkspaceId)
    ?? snapshot.workspaces[0]!;
}

export function useChartWorkspaceRuntime(
  options: UseChartWorkspaceRuntimeOptions = {},
): ChartWorkspaceRuntime {
  const [services] = useState(() => ({
    repository: options.repository ?? createChartWorkspaceRepository(),
    now: options.now ?? Date.now,
    createId: options.createId ?? createChartWorkspaceId,
    autosaveDelayMs: options.autosaveDelayMs ?? 350,
  }));
  const [library, setLibrary] = useState<ChartWorkspaceLibrarySnapshot>(
    () => services.repository.loadBootstrapLibrary(),
  );
  const [ready, setReady] = useState(false);
  const [persistence, setPersistence] = useState<PersistenceStatus>({
    saveState: "loading",
    persistenceMode: null,
    lastSavedAt: null,
    error: null,
  });
  const libraryRef = useRef(library);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSequenceRef = useRef(0);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    libraryRef.current = library;
  }, [library]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    services.repository.loadLibrary().then((result) => {
      if (cancelled) return;
      const { persistenceMode, ...snapshot } = result;
      setLibrary(snapshot);
      setReady(true);
      setPersistence({
        saveState: "saved",
        persistenceMode,
        lastSavedAt: services.now(),
        error: null,
      });
    }).catch((error: unknown) => {
      if (cancelled) return;
      setReady(true);
      setPersistence({
        saveState: "error",
        persistenceMode: null,
        lastSavedAt: null,
        error: error instanceof Error ? error.message : "工作区恢复失败",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  const persistSnapshot = useCallback(async (snapshot: ChartWorkspaceLibrarySnapshot) => {
    const sequence = ++saveSequenceRef.current;
    setPersistence((current) => ({ ...current, saveState: "saving", error: null }));
    try {
      const persistenceMode = await services.repository.saveLibrary(snapshot);
      if (!mountedRef.current || sequence !== saveSequenceRef.current) return;
      setPersistence({
        saveState: "saved",
        persistenceMode,
        lastSavedAt: services.now(),
        error: null,
      });
    } catch (error: unknown) {
      if (!mountedRef.current || sequence !== saveSequenceRef.current) return;
      setPersistence((current) => ({
        ...current,
        saveState: "error",
        error: error instanceof Error ? error.message : "工作区保存失败",
      }));
    }
  }, [services]);

  useEffect(() => {
    if (!ready) return undefined;
    services.repository.writeBootstrap(library);
    setPersistence((current) => ({ ...current, saveState: "saving", error: null }));
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistSnapshot(libraryRef.current);
    }, services.autosaveDelayMs);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [library, persistSnapshot, ready, services]);

  useEffect(() => {
    if (!ready) return undefined;
    const flushForPageTransition = () => {
      services.repository.writeBootstrap(libraryRef.current);
      if (globalThis.document.visibilityState === "hidden") {
        if (saveTimerRef.current !== null) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        void persistSnapshot(libraryRef.current);
      }
    };
    window.addEventListener("beforeunload", flushForPageTransition);
    globalThis.document.addEventListener("visibilitychange", flushForPageTransition);
    return () => {
      window.removeEventListener("beforeunload", flushForPageTransition);
      globalThis.document.removeEventListener("visibilitychange", flushForPageTransition);
    };
  }, [persistSnapshot, ready, services]);

  const updateActiveDocument = useCallback((
    updater: (document: ChartWorkspaceDocument) => ChartWorkspaceDocument,
  ) => {
    const updatedAt = services.now();
    setLibrary((current) => {
      const workspace = activeWorkspace(current);
      const document = updater(workspace.document);
      if (document === workspace.document) return current;
      const updated = { ...workspace, document, updatedAt };
      return {
        ...current,
        workspaces: current.workspaces.map((candidate) => (
          candidate.id === updated.id ? updated : candidate
        )),
      };
    });
  }, [services]);

  const switchWorkspace = useCallback((workspaceId: ChartWorkspaceId) => {
    setLibrary((current) => current.activeWorkspaceId === workspaceId
      || !current.workspaces.some((workspace) => workspace.id === workspaceId)
      ? current
      : { ...current, activeWorkspaceId: workspaceId });
  }, []);

  const createWorkspace = useCallback((templateId: ChartWorkspaceTemplateId) => {
    const snapshot = libraryRef.current;
    const source = activeWorkspace(snapshot);
    const createdAt = services.now();
    const record = createChartWorkspaceRecord({
      id: services.createId(),
      name: uniqueChartWorkspaceName(
        CHART_WORKSPACE_TEMPLATE_NAMES[templateId],
        snapshot.workspaces,
      ),
      document: createTemplateChartWorkspaceDocument(templateId, source.document),
      createdAt,
      updatedAt: createdAt,
    });
    setLibrary((current) => {
      if (current.workspaces.some((workspace) => workspace.id === record.id)) return current;
      const name = uniqueChartWorkspaceName(record.name, current.workspaces);
      return {
        activeWorkspaceId: record.id,
        workspaces: [...current.workspaces, { ...record, name }],
      };
    });
  }, [services]);

  const duplicateWorkspace = useCallback((workspaceId?: ChartWorkspaceId) => {
    const snapshot = libraryRef.current;
    const source = snapshot.workspaces.find((workspace) => workspace.id === workspaceId)
      ?? activeWorkspace(snapshot);
    const createdAt = services.now();
    const record = createChartWorkspaceRecord({
      id: services.createId(),
      name: uniqueChartWorkspaceName(`${source.name} 副本`, snapshot.workspaces),
      document: cloneChartWorkspaceDocument(source.document),
      createdAt,
      updatedAt: createdAt,
    });
    setLibrary((current) => {
      if (current.workspaces.some((workspace) => workspace.id === record.id)) return current;
      const name = uniqueChartWorkspaceName(record.name, current.workspaces);
      return {
        activeWorkspaceId: record.id,
        workspaces: [...current.workspaces, { ...record, name }],
      };
    });
  }, [services]);

  const renameWorkspace = useCallback((workspaceId: ChartWorkspaceId, requestedName: string) => {
    if (!requestedName.trim()) return;
    const updatedAt = services.now();
    setLibrary((current) => {
      const workspace = current.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) return current;
      const name = uniqueChartWorkspaceName(
        normalizeChartWorkspaceName(requestedName, workspace.name),
        current.workspaces,
        workspaceId,
      );
      if (name === workspace.name) return current;
      return {
        ...current,
        workspaces: current.workspaces.map((candidate) => candidate.id === workspaceId
          ? { ...candidate, name, updatedAt }
          : candidate),
      };
    });
  }, [services]);

  const deleteWorkspace = useCallback((workspaceId: ChartWorkspaceId) => {
    setLibrary((current) => removeChartWorkspace(current, workspaceId));
  }, []);

  const setLayout = useCallback((layout: ChartWorkspaceTemplateId) => {
    updateActiveDocument((current) => {
      const currentLayout = detectChartWorkspaceLayout(current.layoutTree);
      const nextTree = currentLayout === layout
        ? current.layoutTree
        : createChartWorkspaceLayoutTree(layout);
      const nextVisible = visibleCellIds(nextTree);
      return current.layoutTree === nextTree && current.maximizedCellId === null
        ? current
        : {
            ...current,
            layoutTree: nextTree,
            maximizedCellId: null,
            activeCellId: nextVisible.includes(current.activeCellId)
              ? current.activeCellId
              : nextVisible[0] ?? "cell-1",
          };
    });
  }, [updateActiveDocument]);

  const setActiveCell = useCallback((cellId: ChartCellId) => {
    updateActiveDocument((current) => current.activeCellId === cellId
      ? current
      : { ...current, activeCellId: cellId });
  }, [updateActiveDocument]);

  const toggleMaximize = useCallback((cellId: ChartCellId) => {
    updateActiveDocument((current) => ({
      ...current,
      activeCellId: cellId,
      maximizedCellId: current.maximizedCellId === cellId ? null : cellId,
    }));
  }, [updateActiveDocument]);

  const setCellLinkGroup = useCallback((
    cellId: ChartCellId,
    group: ChartLinkGroupId | null,
  ) => {
    updateActiveDocument((current) => assignCellLinkGroup(current, cellId, group));
  }, [updateActiveDocument]);

  const setCellLinkRole = useCallback((cellId: ChartCellId, role: ChartLinkRole) => {
    updateActiveDocument((current) => assignCellLinkRole(current, cellId, role));
  }, [updateActiveDocument]);

  const setCellDrawingLayerSet = useCallback((
    cellId: ChartCellId,
    drawingLayerSet: ChartDrawingLayerSetId,
  ) => {
    updateActiveDocument((current) => {
      const cell = current.cells[cellId];
      if (cell.drawingLayerSet === drawingLayerSet) return current;
      return {
        ...current,
        cells: {
          ...current.cells,
          [cellId]: { ...cell, drawingLayerSet },
        },
      };
    });
  }, [updateActiveDocument]);

  const updateLinkGroupSettings = useCallback((
    group: ChartLinkGroupId,
    patch: Partial<ChartLinkGroupSettings>,
  ) => {
    updateActiveDocument((current) => {
      const previous = current.linkGroups[group];
      const nextSettings = applyChartLinkSettingsPatch(previous, patch);
      if ((Object.keys(nextSettings) as Array<keyof ChartLinkGroupSettings>).every((key) => (
        nextSettings[key] === previous[key]
      ))) return current;
      let next: ChartWorkspaceDocument = {
        ...current,
        linkGroups: { ...current.linkGroups, [group]: nextSettings },
      };
      const enablesSessionLink = (patch.market === true && !previous.market)
        || (patch.interval === true && !previous.interval);
      const anchor = preferredChartLinkPublisher(next, group);
      if (enablesSessionLink && anchor) {
        next = applyLinkedSessionUpdate(next, anchor.id, anchor.session);
      }
      return next;
    });
  }, [updateActiveDocument]);

  const setLayoutRatio = useCallback((
    splitId: string,
    ratio: number,
  ) => {
    updateActiveDocument((current) => {
      const layoutTree = updateChartWorkspaceSplitRatio(current.layoutTree, splitId, ratio);
      if (layoutTree === current.layoutTree) return current;
      return {
        ...current,
        layoutTree,
      };
    });
  }, [updateActiveDocument]);

  const updateCellSession = useCallback((cellId: ChartCellId, session: ChartSession) => {
    updateActiveDocument((current) => applyLinkedSessionUpdate(current, cellId, session));
  }, [updateActiveDocument]);

  const updateCellChartSettings = useCallback((
    cellId: ChartCellId,
    settings: ChartSettings | ChartCellChartSettings,
  ) => {
    const chartSettings = pickCellChartSettings(settings);
    updateActiveDocument((current) => ({
      ...current,
      cells: {
        ...current.cells,
        [cellId]: { ...current.cells[cellId], chartSettings },
      },
    }));
  }, [updateActiveDocument]);

  const updateCellPriceScale = useCallback((
    cellId: ChartCellId,
    priceScale: ChartCellPriceScale,
  ) => {
    updateActiveDocument((current) => ({
      ...current,
      cells: {
        ...current.cells,
        [cellId]: { ...current.cells[cellId], priceScale },
      },
    }));
  }, [updateActiveDocument]);

  const updateCellIndicators = useCallback((
    cellId: ChartCellId,
    indicators: IndicatorDefinition[],
  ) => {
    updateActiveDocument((current) => ({
      ...current,
      cells: {
        ...current.cells,
        [cellId]: { ...current.cells[cellId], indicators },
      },
    }));
  }, [updateActiveDocument]);

  const workspace = activeWorkspace(library);
  const document = workspace.document;
  const layout = useMemo(
    () => detectChartWorkspaceLayout(document.layoutTree),
    [document.layoutTree],
  );
  const activeCell = document.cells[document.activeCellId];
  const renderedCellIds = useMemo(
    () => visibleCellIds(document.layoutTree, document.maximizedCellId),
    [document.layoutTree, document.maximizedCellId],
  );
  const workspaceSummaries = useMemo(
    () => summarizeChartWorkspaces(library.workspaces),
    [library.workspaces],
  );

  return {
    view: {
      document,
      activeWorkspaceId: workspace.id,
      activeWorkspaceName: workspace.name,
      runtimeKey: `${workspace.id}:${ready ? "ready" : "bootstrap"}`,
      workspaces: workspaceSummaries,
      layout,
      activeCellId: document.activeCellId,
      activeCell,
      visibleCellIds: renderedCellIds,
      ready,
    },
    actions: {
      switchWorkspace,
      createWorkspace,
      duplicateWorkspace,
      renameWorkspace,
      deleteWorkspace,
      setLayout,
      setActiveCell,
      toggleMaximize,
      setCellLinkGroup,
      setCellLinkRole,
      setCellDrawingLayerSet,
      updateLinkGroupSettings,
      setLayoutRatio,
      updateCellSession,
      updateCellChartSettings,
      updateCellPriceScale,
      updateCellIndicators,
    },
    status: persistence,
  };
}
