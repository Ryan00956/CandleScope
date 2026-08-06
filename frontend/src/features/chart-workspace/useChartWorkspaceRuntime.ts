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
  type ChartCellCreationMode,
  type ChartCellChartSettings,
  type ChartDrawingLayerSetId,
  type ChartCellId,
  type ChartCellPriceScale,
  type ChartLinkGroupId,
  type ChartLinkGroupSettings,
  type ChartLinkRole,
  type ChartWindowId,
  type ChartWindowState,
  type ChartWorkspaceDocument,
  type ChartWorkspaceId,
  type ChartWorkspaceLayout,
  type ChartWorkspaceLibrarySnapshot,
  type ChartWorkspaceSummary,
  type ChartWorkspaceSplitDirection,
  type ChartWorkspaceTemplateId,
} from "./chartWorkspaceTypes.js";
import {
  chartWorkspaceTemplateCellCount,
  detectChartWorkspaceLayout,
  projectChartWorkspaceLayoutTree,
  updateChartWorkspaceSplitRatio,
  visibleCellIds,
} from "./chartWorkspaceLayout.js";
import {
  closeChartWorkspaceDocument,
  createEmptyChartWorkspaceLayoutHistory,
  recordChartWorkspaceLayoutEdit,
  redoChartWorkspaceLayoutEdit,
  resetChartWorkspaceDocumentLayout,
  setChartWorkspaceDocumentLayout,
  splitChartWorkspaceDocument,
  swapChartWorkspaceDocumentCells,
  undoChartWorkspaceLayoutEdit,
  type ChartWorkspaceEditResult,
  type ChartWorkspaceLayoutHistory,
} from "./chartWorkspaceEditing.js";
import {
  applyChartLinkSettingsPatch,
  applyLinkedSessionUpdate,
  assignCellLinkGroup,
  assignCellLinkRole,
  preferredChartLinkPublisher,
} from "./chartWorkspaceLinkModel.js";
import {
  CHART_WORKSPACE_FEATURE_FLAGS,
  CHART_WORKSPACE_RUNTIME_LIMITS,
} from "./chartWorkspaceCapacity.js";
import {
  activeChartWorkspaceWindow,
  advanceChartWorkspaceRevision,
  chartWorkspaceCell,
  chartWorkspaceWindow,
  replaceChartWorkspaceWindow,
} from "./chartWorkspaceDocument.js";
import {
  closeChartWorkspaceWindowCandidate,
  createChartWorkspaceWindowCandidate,
  updateChartWorkspaceWindowPlacementCandidate,
} from "./chartWorkspaceWindows.js";

export type ChartWorkspaceSaveState = "loading" | "saving" | "saved" | "error";

export interface ChartWorkspaceRuntime {
  view: {
    document: ChartWorkspaceDocument;
    window: ChartWindowState;
    activeWorkspaceId: ChartWorkspaceId;
    activeWorkspaceName: string;
    runtimeKey: string;
    workspaces: ChartWorkspaceSummary[];
    layout: ChartWorkspaceLayout;
    activeCellId: ChartCellId;
    activeCell: ChartWorkspaceDocument["cells"][ChartCellId];
    layoutCellIds: ChartCellId[];
    visibleCellIds: ChartCellId[];
    maxCellsPerWindow: number;
    multiChart16Enabled: boolean;
    layoutLocked: boolean;
    canUndoLayout: boolean;
    canRedoLayout: boolean;
    ready: boolean;
  };
  actions: {
    switchWorkspace(workspaceId: ChartWorkspaceId): void;
    createWorkspace(templateId: ChartWorkspaceTemplateId): void;
    duplicateWorkspace(workspaceId?: ChartWorkspaceId): void;
    renameWorkspace(workspaceId: ChartWorkspaceId, name: string): void;
    deleteWorkspace(workspaceId: ChartWorkspaceId): void;
    setLayout(layout: ChartWorkspaceTemplateId): void;
    splitCell(
      cellId: ChartCellId,
      direction: ChartWorkspaceSplitDirection,
      creationMode: ChartCellCreationMode,
    ): void;
    closeCell(cellId: ChartCellId): void;
    swapCells(firstCellId: ChartCellId, secondCellId: ChartCellId): void;
    resetLayout(): void;
    setLayoutLocked(locked: boolean): void;
    undoLayout(): void;
    redoLayout(): void;
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
    createWindow(): void;
    closeWindow(windowId: ChartWindowId): void;
    updateWindowPlacement(
      windowId: ChartWindowId,
      placement: Pick<ChartWindowState, "boundsDip" | "monitorFingerprint" | "dpiScale" | "windowState">,
    ): void;
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
  windowId?: ChartWindowId;
}

interface PersistenceStatus {
  saveState: ChartWorkspaceSaveState;
  persistenceMode: ChartWorkspacePersistenceMode | null;
  lastSavedAt: number | null;
  error: string | null;
}

interface WorkspaceRuntimeState {
  library: ChartWorkspaceLibrarySnapshot;
  layoutHistoryByWorkspace: Partial<Record<ChartWorkspaceId, ChartWorkspaceLayoutHistory>>;
}

type ChartWorkspaceLibraryUpdate = ChartWorkspaceLibrarySnapshot
  | ((current: ChartWorkspaceLibrarySnapshot) => ChartWorkspaceLibrarySnapshot);

function pickCellChartSettings(settings: ChartSettings | ChartCellChartSettings): ChartCellChartSettings {
  return Object.fromEntries(
    CELL_CHART_SETTING_KEYS.map((key) => [key, settings[key]]),
  ) as ChartCellChartSettings;
}

function sameCellChartSettings(
  left: ChartCellChartSettings,
  right: ChartCellChartSettings,
): boolean {
  return CELL_CHART_SETTING_KEYS.every((key) => left[key] === right[key]);
}

function sameCellPriceScale(
  left: ChartCellPriceScale,
  right: ChartCellPriceScale,
): boolean {
  return left.invertScale === right.invertScale
    && left.priceScaleMode === right.priceScaleMode;
}

function sameIndicatorDefinitions(
  left: readonly IndicatorDefinition[],
  right: readonly IndicatorDefinition[],
): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
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
    windowId: options.windowId,
    editOptions: {
      allowDynamicCellIds: CHART_WORKSPACE_FEATURE_FLAGS.multiChart16Enabled,
      maxCellsPerWindow: CHART_WORKSPACE_RUNTIME_LIMITS.maxCellsPerWindow,
      maxCellsPerApp: CHART_WORKSPACE_RUNTIME_LIMITS.maxCellsPerApp,
    },
  }));
  const [runtimeState, setRuntimeState] = useState<WorkspaceRuntimeState>(() => ({
    library: services.repository.loadBootstrapLibrary(),
    layoutHistoryByWorkspace: {},
  }));
  const library = runtimeState.library;
  const setLibrary = useCallback((update: ChartWorkspaceLibraryUpdate) => {
    setRuntimeState((current) => {
      const nextLibrary = typeof update === "function"
        ? update(current.library)
        : update;
      return nextLibrary === current.library
        ? current
        : { ...current, library: nextLibrary };
    });
  }, []);
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
  }, [services, setLibrary]);

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
      const scopedDocument = services.windowId && workspace.document.windows[services.windowId]
        ? { ...workspace.document, activeWindowId: services.windowId }
        : workspace.document;
      const candidate = updater(scopedDocument);
      if (candidate === workspace.document) return current;
      const document = advanceChartWorkspaceRevision(workspace.document, candidate);
      const updated = { ...workspace, document, updatedAt };
      return {
        ...current,
        workspaces: current.workspaces.map((candidate) => (
          candidate.id === updated.id ? updated : candidate
        )),
      };
    });
  }, [services, setLibrary]);

  const updateActiveLayoutDocument = useCallback((
    updater: (document: ChartWorkspaceDocument) => ChartWorkspaceEditResult,
  ) => {
    const updatedAt = services.now();
    setRuntimeState((currentState) => {
      const workspace = activeWorkspace(currentState.library);
      const scopedDocument = services.windowId && workspace.document.windows[services.windowId]
        ? { ...workspace.document, activeWindowId: services.windowId }
        : workspace.document;
      if (activeChartWorkspaceWindow(scopedDocument).layoutLocked) return currentState;
      const result = updater(scopedDocument);
      if (result.document === workspace.document) return currentState;
      const committedResult = {
        ...result,
        document: advanceChartWorkspaceRevision(workspace.document, result.document),
      };
      const updated = { ...workspace, document: committedResult.document, updatedAt };
      const history = currentState.layoutHistoryByWorkspace[workspace.id]
        ?? createEmptyChartWorkspaceLayoutHistory();
      return {
        library: {
          ...currentState.library,
          workspaces: currentState.library.workspaces.map((candidate) => (
            candidate.id === updated.id ? updated : candidate
          )),
        },
        layoutHistoryByWorkspace: {
          ...currentState.layoutHistoryByWorkspace,
          [workspace.id]: recordChartWorkspaceLayoutEdit(
            history,
            workspace.document,
            committedResult,
          ),
        },
      };
    });
  }, [services]);

  const switchWorkspace = useCallback((workspaceId: ChartWorkspaceId) => {
    setLibrary((current) => current.activeWorkspaceId === workspaceId
      || !current.workspaces.some((workspace) => workspace.id === workspaceId)
      ? current
      : { ...current, activeWorkspaceId: workspaceId });
  }, [setLibrary]);

  const createWorkspace = useCallback((templateId: ChartWorkspaceTemplateId) => {
    if (chartWorkspaceTemplateCellCount(templateId) > services.editOptions.maxCellsPerWindow) return;
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
  }, [services, setLibrary]);

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
  }, [services, setLibrary]);

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
          ? {
            ...candidate,
            name,
            updatedAt,
            document: advanceChartWorkspaceRevision(candidate.document, {
              ...candidate.document,
            }),
          }
          : candidate),
      };
    });
  }, [services, setLibrary]);

  const deleteWorkspace = useCallback((workspaceId: ChartWorkspaceId) => {
    setRuntimeState((currentState) => {
      const library = removeChartWorkspace(currentState.library, workspaceId);
      if (library === currentState.library) return currentState;
      const layoutHistoryByWorkspace = { ...currentState.layoutHistoryByWorkspace };
      delete layoutHistoryByWorkspace[workspaceId];
      return { library, layoutHistoryByWorkspace };
    });
  }, []);

  const setLayout = useCallback((layout: ChartWorkspaceTemplateId) => {
    updateActiveLayoutDocument((current) => setChartWorkspaceDocumentLayout(
      current,
      layout,
      services.editOptions,
    ));
  }, [services, updateActiveLayoutDocument]);

  const splitCell = useCallback((
    cellId: ChartCellId,
    direction: ChartWorkspaceSplitDirection,
    creationMode: ChartCellCreationMode,
  ) => {
    updateActiveLayoutDocument((current) => splitChartWorkspaceDocument(
      current,
      cellId,
      direction,
      creationMode,
      services.editOptions,
    ));
  }, [services, updateActiveLayoutDocument]);

  const closeCell = useCallback((cellId: ChartCellId) => {
    updateActiveLayoutDocument((current) => closeChartWorkspaceDocument(
      current,
      cellId,
      services.editOptions,
    ));
  }, [services, updateActiveLayoutDocument]);

  const swapCells = useCallback((firstCellId: ChartCellId, secondCellId: ChartCellId) => {
    updateActiveLayoutDocument((current) => swapChartWorkspaceDocumentCells(
      current,
      firstCellId,
      secondCellId,
      services.editOptions,
    ));
  }, [services, updateActiveLayoutDocument]);

  const resetLayout = useCallback(() => {
    updateActiveLayoutDocument((current) => resetChartWorkspaceDocumentLayout(
      current,
      services.editOptions,
    ));
  }, [services, updateActiveLayoutDocument]);

  const setLayoutLocked = useCallback((locked: boolean) => {
    updateActiveDocument((current) => {
      const window = activeChartWorkspaceWindow(current);
      return window.layoutLocked === locked
        ? current
        : replaceChartWorkspaceWindow(current, { ...window, layoutLocked: locked });
    });
  }, [updateActiveDocument]);

  const undoLayout = useCallback(() => {
    const updatedAt = services.now();
    setRuntimeState((currentState) => {
      const workspace = activeWorkspace(currentState.library);
      const history = currentState.layoutHistoryByWorkspace[workspace.id]
        ?? createEmptyChartWorkspaceLayoutHistory();
      const step = undoChartWorkspaceLayoutEdit(workspace.document, history);
      if (!step) return currentState;
      const document = advanceChartWorkspaceRevision(workspace.document, step.document);
      return {
        library: {
          ...currentState.library,
          workspaces: currentState.library.workspaces.map((candidate) => candidate.id === workspace.id
            ? { ...workspace, document, updatedAt }
            : candidate),
        },
        layoutHistoryByWorkspace: {
          ...currentState.layoutHistoryByWorkspace,
          [workspace.id]: step.history,
        },
      };
    });
  }, [services]);

  const redoLayout = useCallback(() => {
    const updatedAt = services.now();
    setRuntimeState((currentState) => {
      const workspace = activeWorkspace(currentState.library);
      const history = currentState.layoutHistoryByWorkspace[workspace.id]
        ?? createEmptyChartWorkspaceLayoutHistory();
      const step = redoChartWorkspaceLayoutEdit(workspace.document, history);
      if (!step) return currentState;
      const document = advanceChartWorkspaceRevision(workspace.document, step.document);
      return {
        library: {
          ...currentState.library,
          workspaces: currentState.library.workspaces.map((candidate) => candidate.id === workspace.id
            ? { ...workspace, document, updatedAt }
            : candidate),
        },
        layoutHistoryByWorkspace: {
          ...currentState.layoutHistoryByWorkspace,
          [workspace.id]: step.history,
        },
      };
    });
  }, [services]);

  const setActiveCell = useCallback((cellId: ChartCellId) => {
    updateActiveDocument((current) => {
      const window = activeChartWorkspaceWindow(current);
      return window.activeCellId === cellId
        ? current
        : replaceChartWorkspaceWindow(current, { ...window, activeCellId: cellId });
    });
  }, [updateActiveDocument]);

  const toggleMaximize = useCallback((cellId: ChartCellId) => {
    updateActiveDocument((current) => {
      const window = activeChartWorkspaceWindow(current);
      return replaceChartWorkspaceWindow(current, {
        ...window,
        activeCellId: cellId,
        maximizedCellId: window.maximizedCellId === cellId ? null : cellId,
      });
    });
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
      const cell = chartWorkspaceCell(current, cellId);
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
    updateActiveLayoutDocument((current) => {
      const window = activeChartWorkspaceWindow(current);
      const layoutTree = updateChartWorkspaceSplitRatio(window.layoutTree, splitId, ratio);
      return {
        document: layoutTree === window.layoutTree
          ? current
          : replaceChartWorkspaceWindow(current, { ...window, layoutTree }),
        restoreCellIds: [],
      };
    });
  }, [updateActiveLayoutDocument]);

  const updateCellSession = useCallback((cellId: ChartCellId, session: ChartSession) => {
    updateActiveDocument((current) => applyLinkedSessionUpdate(current, cellId, session));
  }, [updateActiveDocument]);

  const updateCellChartSettings = useCallback((
    cellId: ChartCellId,
    settings: ChartSettings | ChartCellChartSettings,
  ) => {
    const chartSettings = pickCellChartSettings(settings);
    updateActiveDocument((current) => {
      const cell = chartWorkspaceCell(current, cellId);
      return sameCellChartSettings(cell.chartSettings, chartSettings)
        ? current
        : {
          ...current,
          cells: { ...current.cells, [cellId]: { ...cell, chartSettings } },
        };
    });
  }, [updateActiveDocument]);

  const updateCellPriceScale = useCallback((
    cellId: ChartCellId,
    priceScale: ChartCellPriceScale,
  ) => {
    updateActiveDocument((current) => {
      const cell = chartWorkspaceCell(current, cellId);
      return sameCellPriceScale(cell.priceScale, priceScale)
        ? current
        : {
          ...current,
          cells: { ...current.cells, [cellId]: { ...cell, priceScale } },
        };
    });
  }, [updateActiveDocument]);

  const updateCellIndicators = useCallback((
    cellId: ChartCellId,
    indicators: IndicatorDefinition[],
  ) => {
    updateActiveDocument((current) => {
      const cell = chartWorkspaceCell(current, cellId);
      return sameIndicatorDefinitions(cell.indicators, indicators)
        ? current
        : {
          ...current,
          cells: { ...current.cells, [cellId]: { ...cell, indicators } },
        };
    });
  }, [updateActiveDocument]);

  const createWindow = useCallback(() => {
    if (!CHART_WORKSPACE_FEATURE_FLAGS.multiWindowEnabled) return;
    updateActiveDocument((current) => createChartWorkspaceWindowCandidate(current, {
      sourceWindowId: services.windowId ?? current.activeWindowId,
    }));
  }, [services.windowId, updateActiveDocument]);

  const closeWindow = useCallback((windowId: ChartWindowId) => {
    if (!CHART_WORKSPACE_FEATURE_FLAGS.multiWindowEnabled) return;
    updateActiveDocument((current) => closeChartWorkspaceWindowCandidate(current, windowId));
  }, [updateActiveDocument]);

  const updateWindowPlacement = useCallback((
    windowId: ChartWindowId,
    placement: Pick<ChartWindowState, "boundsDip" | "monitorFingerprint" | "dpiScale" | "windowState">,
  ) => {
    if (!CHART_WORKSPACE_FEATURE_FLAGS.multiWindowEnabled) return;
    updateActiveDocument((current) => updateChartWorkspaceWindowPlacementCandidate(
      current,
      windowId,
      placement,
    ));
  }, [updateActiveDocument]);

  const workspace = activeWorkspace(library);
  const document = workspace.document;
  const persistedActiveWindow = chartWorkspaceWindow(
    document,
    services.windowId ?? document.activeWindowId,
  );
  const activeWindow = useMemo<ChartWindowState>(() => {
    const layoutTree = projectChartWorkspaceLayoutTree(
      persistedActiveWindow.layoutTree,
      services.editOptions.maxCellsPerWindow,
    );
    if (layoutTree === persistedActiveWindow.layoutTree) return persistedActiveWindow;
    const projectedCellIds = visibleCellIds(layoutTree);
    return {
      ...persistedActiveWindow,
      layoutTree,
      activeCellId: projectedCellIds.includes(persistedActiveWindow.activeCellId)
        ? persistedActiveWindow.activeCellId
        : projectedCellIds[0]!,
      maximizedCellId: persistedActiveWindow.maximizedCellId
        && projectedCellIds.includes(persistedActiveWindow.maximizedCellId)
        ? persistedActiveWindow.maximizedCellId
        : null,
    };
  }, [persistedActiveWindow, services.editOptions.maxCellsPerWindow]);
  const layout = useMemo(
    () => detectChartWorkspaceLayout(activeWindow.layoutTree),
    [activeWindow.layoutTree],
  );
  const activeCell = chartWorkspaceCell(document, activeWindow.activeCellId);
  const layoutCellIds = useMemo(
    () => visibleCellIds(activeWindow.layoutTree),
    [activeWindow.layoutTree],
  );
  const renderedCellIds = useMemo(
    () => visibleCellIds(activeWindow.layoutTree, activeWindow.maximizedCellId),
    [activeWindow.layoutTree, activeWindow.maximizedCellId],
  );
  const workspaceSummaries = useMemo(
    () => summarizeChartWorkspaces(library.workspaces),
    [library.workspaces],
  );
  const layoutHistory = runtimeState.layoutHistoryByWorkspace[workspace.id]
    ?? createEmptyChartWorkspaceLayoutHistory();

  return {
    view: {
      document,
      window: activeWindow,
      activeWorkspaceId: workspace.id,
      activeWorkspaceName: workspace.name,
      // The bootstrap journal and hydrated repository record describe the
      // same Workspace identity. Keep Cell keys stable across hydration so a
      // 16-Cell window does not tear down and recreate every chart, request,
      // and broker consumer as IndexedDB becomes ready.
      runtimeKey: workspace.id,
      workspaces: workspaceSummaries,
      layout,
      activeCellId: activeWindow.activeCellId,
      activeCell,
      layoutCellIds,
      visibleCellIds: renderedCellIds,
      maxCellsPerWindow: services.editOptions.maxCellsPerWindow,
      multiChart16Enabled: CHART_WORKSPACE_FEATURE_FLAGS.multiChart16Enabled,
      layoutLocked: activeWindow.layoutLocked,
      canUndoLayout: layoutHistory.past.length > 0,
      canRedoLayout: layoutHistory.future.length > 0,
      ready,
    },
    actions: {
      switchWorkspace,
      createWorkspace,
      duplicateWorkspace,
      renameWorkspace,
      deleteWorkspace,
      setLayout,
      splitCell,
      closeCell,
      swapCells,
      resetLayout,
      setLayoutLocked,
      undoLayout,
      redoLayout,
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
      createWindow,
      closeWindow,
      updateWindowPlacement,
    },
    status: persistence,
  };
}
