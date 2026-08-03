import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPluginCatalog,
  fetchPluginLiveControlStatus,
  fetchPluginManagementDetail,
  fetchPluginMarketplaceCatalog,
  fetchPluginMarketplaceStatus,
  fetchPluginUiSnapshot,
  downloadPluginUserFile,
  invokePluginCommand,
  installPluginBundle,
  prepareLocalPluginInstall,
  reviewLocalPluginInstall,
  confirmLocalPluginInstall,
  reviewPluginTrustChange,
  confirmPluginTrustChange,
  activatePluginMarketplaceRelease,
  applyPluginMarketplaceRelease,
  issueLiveConfirmation,
  killLiveControl,
  mutatePluginPermission,
  mutatePluginState,
  pluginManagementAvailable,
  readPluginSettings,
  revokeLiveAuthority,
  revokeLiveConfirmation,
  setPaperKillSwitch,
  setLiveControlMode,
  syncPluginChartContext,
  fetchLiveAuditExport,
  previewLiveConfirmation,
  submitLiveExecution,
  cancelLiveExecution,
  reconcileLiveExecution,
  preparePluginUserFileSave,
  preparePluginMarketplaceRelease,
  previewV1CompatibilityImport,
  applyV1CompatibilityImport,
  previewV1CompatibilityRollback,
  applyV1CompatibilityRollback,
  refreshPluginMarketplace,
  stagePluginUserFile,
  writePluginSettings,
} from "./pluginPlatformApi.js";
import { PluginMarkerSource } from "./pluginMarkerSource.js";
import { PluginChartLayerSource } from "./pluginChartLayerSource.js";
import {
  createDeferredAbortableTask,
  PLUGIN_CATALOG_REVALIDATE_MS,
  PLUGIN_CHART_CONTEXT_HEARTBEAT_MS,
  PLUGIN_UI_ACTIVE_POLL_MS,
  pluginCatalogNeedsChartContextSync,
  pluginCatalogNeedsUiPolling,
  pluginLivePollIntervalMs,
} from "./pluginRefreshRuntime.js";
import { buildPluginRegistries } from "./pluginRegistries.js";
import type {
  JsonValue,
  PluginCatalog,
  PluginMarketIdentity,
  PluginLiveControlStatus,
  PluginMarketplaceCatalog,
  PluginPlatformRuntime,
  PluginUiSnapshot,
} from "./pluginPlatformTypes.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin Platform operation failed";
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function awaitRefreshTasks(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

function useAbortableInterval(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    let running = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (running) return;
      running = true;
      controller = new AbortController();
      try {
        await task(controller.signal);
      } catch {
        // Each refresh publishes its own fail-closed state.
      } finally {
        controller = null;
        running = false;
      }
    };
    const timer = window.setInterval(() => void poll(), intervalMs);
    return () => {
      window.clearInterval(timer);
      controller?.abort();
      controller = null;
    };
  }, [enabled, intervalMs, task]);
}

const DISABLED_LIVE_CONTROL: PluginLiveControlStatus = {
  schemaVersion: "candlescope.live-control-status/1",
  available: false,
  mode: "disabled",
  generation: 0,
  policyEpoch: 0,
  updatedAt: null,
  outstandingConfirmationCount: 0,
  confirmationCounts: { consumed: 0, expired: 0, issued: 0, revoked: 0 },
  eventSequence: 0,
  eventSha256: null,
  liveSubmitAvailable: false,
  liveCancelAvailable: false,
  liveTransferAvailable: false,
};

const UNAVAILABLE_LIVE_CONTROL: PluginLiveControlStatus = {
  ...DISABLED_LIVE_CONTROL,
  mode: "unavailable",
};

export function usePluginPlatformRuntime(identity: PluginMarketIdentity): PluginPlatformRuntime {
  const { exchange, interval, marketType, symbol } = identity;
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [marketplaceCatalog, setMarketplaceCatalog] = useState<PluginMarketplaceCatalog | null>(null);
  const [snapshot, setSnapshot] = useState<PluginUiSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openViewId, setOpenViewId] = useState<string | null>(null);
  const [openSettingsId, setOpenSettingsId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [liveControl, setLiveControl] = useState<PluginLiveControlStatus>(DISABLED_LIVE_CONTROL);
  const [liveControlOpen, setLiveControlOpen] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const managementAvailable = useMemo(() => pluginManagementAvailable(), []);
  const markerSourceRef = useRef<PluginMarkerSource | null>(null);
  const chartLayerSourceRef = useRef<PluginChartLayerSource | null>(null);
  const chartContextSyncRef = useRef<Promise<unknown>>(Promise.resolve());
  const catalogRef = useRef<PluginCatalog | null>(null);
  const snapshotRef = useRef<PluginUiSnapshot | null>(null);
  const catalogRefreshSequenceRef = useRef(0);
  const snapshotRefreshSequenceRef = useRef(0);
  const marketplaceRefreshSequenceRef = useRef(0);
  const liveRefreshSequenceRef = useRef(0);
  if (markerSourceRef.current === null) markerSourceRef.current = new PluginMarkerSource();
  if (chartLayerSourceRef.current === null) {
    chartLayerSourceRef.current = new PluginChartLayerSource();
  }
  const openManager = useCallback(() => setManagerOpen(true), []);
  const closeManager = useCallback(() => setManagerOpen(false), []);

  const enqueueChartContextSync = useCallback((
    value: PluginMarketIdentity | null,
  ): Promise<unknown> => {
    const next = chartContextSyncRef.current
      .catch(() => undefined)
      .then(() => syncPluginChartContext(value));
    chartContextSyncRef.current = next;
    return next;
  }, []);

  const refreshCatalogState = useCallback(async (
    options: { signal?: AbortSignal; includeSnapshot?: boolean } = {},
  ): Promise<void> => {
    const { signal, includeSnapshot = false } = options;
    const sequence = ++catalogRefreshSequenceRef.current;
    const snapshotSequence = includeSnapshot
      ? ++snapshotRefreshSequenceRef.current
      : null;
    try {
      const [nextCatalog, initialSnapshot] = await Promise.all([
        fetchPluginCatalog(signal),
        includeSnapshot ? fetchPluginUiSnapshot(signal) : Promise.resolve(null),
      ]);
      let nextSnapshot = initialSnapshot;
      if (
        nextSnapshot !== null
        && nextSnapshot.registryRevision !== nextCatalog.platform.registryRevision
      ) {
        nextSnapshot = await fetchPluginUiSnapshot(signal);
      }
      if (
        nextSnapshot !== null
        && nextSnapshot.registryRevision !== nextCatalog.platform.registryRevision
      ) {
        throw new Error("Plugin catalog changed during refresh; retrying safely");
      }
      if (signal?.aborted || sequence !== catalogRefreshSequenceRef.current) return;

      catalogRef.current = nextCatalog;
      setCatalog(nextCatalog);
      if (
        nextSnapshot !== null
        && snapshotSequence === snapshotRefreshSequenceRef.current
      ) {
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
      } else if (
        snapshotRef.current !== null
        && snapshotRef.current.registryRevision !== nextCatalog.platform.registryRevision
      ) {
        snapshotRef.current = null;
        setSnapshot(null);
      }
      setError(null);
    } catch (caught) {
      if (
        isAbortError(caught, signal)
        || sequence !== catalogRefreshSequenceRef.current
      ) return;
      catalogRef.current = null;
      snapshotRef.current = null;
      snapshotRefreshSequenceRef.current += 1;
      setCatalog(null);
      setSnapshot(null);
      setError(errorMessage(caught));
      throw caught;
    } finally {
      if (
        includeSnapshot
        && !signal?.aborted
        && sequence === catalogRefreshSequenceRef.current
      ) setLoading(false);
    }
  }, []);

  const refreshUiSnapshotState = useCallback(async (
    signal?: AbortSignal,
  ): Promise<void> => {
    const expectedRevision = catalogRef.current?.platform.registryRevision;
    if (expectedRevision === undefined) return;
    const sequence = ++snapshotRefreshSequenceRef.current;
    try {
      const nextSnapshot = await fetchPluginUiSnapshot(signal);
      if (signal?.aborted || sequence !== snapshotRefreshSequenceRef.current) return;
      const currentRevision = catalogRef.current?.platform.registryRevision;
      if (
        currentRevision !== expectedRevision
        || nextSnapshot.registryRevision !== expectedRevision
      ) {
        if (currentRevision === expectedRevision) {
          await refreshCatalogState({
            includeSnapshot: true,
            ...(signal ? { signal } : {}),
          });
        }
        return;
      }
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (caught) {
      if (
        isAbortError(caught, signal)
        || sequence !== snapshotRefreshSequenceRef.current
      ) return;
      snapshotRef.current = null;
      setSnapshot(null);
      setError(errorMessage(caught));
      throw caught;
    }
  }, [refreshCatalogState]);

  const refreshMarketplaceCatalogState = useCallback(async (
    signal?: AbortSignal,
  ): Promise<void> => {
    const sequence = ++marketplaceRefreshSequenceRef.current;
    try {
      const nextMarketplaceCatalog = await fetchPluginMarketplaceCatalog(signal);
      if (signal?.aborted || sequence !== marketplaceRefreshSequenceRef.current) return;
      setMarketplaceCatalog(nextMarketplaceCatalog);
      setError(null);
    } catch (caught) {
      if (
        isAbortError(caught, signal)
        || sequence !== marketplaceRefreshSequenceRef.current
      ) return;
      setMarketplaceCatalog(null);
      setError(errorMessage(caught));
      throw caught;
    }
  }, []);

  const refreshLiveControlState = useCallback(async (
    signal?: AbortSignal,
  ): Promise<void> => {
    const sequence = ++liveRefreshSequenceRef.current;
    try {
      const nextLiveControl = await fetchPluginLiveControlStatus(signal);
      if (signal?.aborted || sequence !== liveRefreshSequenceRef.current) return;
      setLiveControl(nextLiveControl);
    } catch (caught) {
      if (
        isAbortError(caught, signal)
        || sequence !== liveRefreshSequenceRef.current
      ) return;
      setLiveControl((current) => (
        current.mode === "disabled"
          ? UNAVAILABLE_LIVE_CONTROL
          : { ...current, available: false, mode: "unavailable" }
      ));
      throw caught;
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const tasks = [
      refreshCatalogState({ includeSnapshot: true }),
      refreshLiveControlState(),
    ];
    if (managerOpen) tasks.push(refreshMarketplaceCatalogState());
    await awaitRefreshTasks(tasks);
  }, [
    managerOpen,
    refreshCatalogState,
    refreshLiveControlState,
    refreshMarketplaceCatalogState,
  ]);

  useEffect(() => {
    const bootstrap = createDeferredAbortableTask(async (signal) => {
      await awaitRefreshTasks([
        refreshCatalogState({ signal, includeSnapshot: true }),
        refreshLiveControlState(signal),
      ]);
    });
    bootstrap.start();
    return () => bootstrap.stop();
  }, [refreshCatalogState, refreshLiveControlState]);

  const revalidateCatalog = useCallback(
    (signal: AbortSignal) => refreshCatalogState({ signal }),
    [refreshCatalogState],
  );
  useAbortableInterval(
    revalidateCatalog,
    PLUGIN_CATALOG_REVALIDATE_MS,
    pageVisible,
  );

  const uiPollingEnabled = pluginCatalogNeedsUiPolling(catalog, snapshot);
  useAbortableInterval(
    refreshUiSnapshotState,
    PLUGIN_UI_ACTIVE_POLL_MS,
    pageVisible && uiPollingEnabled,
  );

  const livePollIntervalMs = pluginLivePollIntervalMs(liveControl);
  useAbortableInterval(
    refreshLiveControlState,
    livePollIntervalMs,
    pageVisible,
  );

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    let resumeController: AbortController | null = null;
    const onVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden";
      setPageVisible(visible);
      if (!visible) {
        resumeController?.abort();
        resumeController = null;
        return;
      }
      resumeController?.abort();
      resumeController = new AbortController();
      void awaitRefreshTasks([
        refreshCatalogState({
          signal: resumeController.signal,
          includeSnapshot: true,
        }),
        refreshLiveControlState(resumeController.signal),
      ]).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resumeController?.abort();
    };
  }, [refreshCatalogState, refreshLiveControlState]);

  useEffect(() => {
    if (!managerOpen || !pageVisible) return undefined;
    const controller = new AbortController();
    void refreshMarketplaceCatalogState(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [managerOpen, pageVisible, refreshMarketplaceCatalogState]);

  useEffect(() => {
    markerSourceRef.current?.update(snapshot?.chartLayers ?? [], { exchange, interval, marketType, symbol });
    chartLayerSourceRef.current?.update(snapshot?.chartLayers ?? [], {
      exchange,
      interval,
      marketType,
      symbol,
    });
  }, [exchange, interval, marketType, snapshot?.chartLayers, symbol]);

  const chartContextSyncEnabled = (
    pageVisible
    && managementAvailable
    && pluginCatalogNeedsChartContextSync(catalog)
  );
  useEffect(() => {
    if (!chartContextSyncEnabled) return undefined;
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      void enqueueChartContextSync({ exchange, interval, marketType, symbol })
        .catch(() => undefined);
    };
    sync();
    const heartbeat = window.setInterval(sync, PLUGIN_CHART_CONTEXT_HEARTBEAT_MS);
    return () => {
      disposed = true;
      window.clearInterval(heartbeat);
      void enqueueChartContextSync(null).catch(() => undefined);
    };
  }, [
    chartContextSyncEnabled,
    enqueueChartContextSync,
    exchange,
    interval,
    marketType,
    symbol,
  ]);

  const registries = useMemo(() => buildPluginRegistries(catalog), [catalog]);
  useEffect(() => {
    if (openViewId && ![...registries.sidePanel, ...registries.bottomPanel].some((item) => item.id === openViewId)) {
      setOpenViewId(null);
    }
    if (openSettingsId && !registries.settings.some((item) => item.id === openSettingsId)) {
      setOpenSettingsId(null);
    }
  }, [openSettingsId, openViewId, registries]);

  const withRefresh = useCallback(async (operation: () => Promise<void>, success: string) => {
    try {
      await operation();
      await refresh();
      setNotice(success);
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, [refresh]);

  const invokeCommand = useCallback(async (id: string, input: Record<string, JsonValue> = {}) => {
    try {
      const result = await invokePluginCommand(id, input);
      await refresh();
      setNotice("Plugin command completed");
      return result;
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, [refresh]);

  const changeState = useCallback(async (
    pluginId: string,
    action: "enable" | "disable" | "rollback" | "uninstall",
  ) => withRefresh(
    () => mutatePluginState(pluginId, action),
    `Plugin ${action} completed`,
  ), [withRefresh]);

  const decidePermission = useCallback(async (
    pluginId: string,
    permissionId: string,
    decision: "grant" | "deny" | "revoke",
    scope?: Record<string, JsonValue>,
  ) => withRefresh(
    () => mutatePluginPermission(pluginId, permissionId, decision, scope),
    `Permission ${decision} completed`,
  ), [withRefresh]);

  const changePaperKillSwitch = useCallback(async (enabled: boolean) => withRefresh(
    () => setPaperKillSwitch(enabled),
    enabled ? "Paper kill switch enabled" : "Paper order submission resumed",
  ), [withRefresh]);

  const changeLiveControlMode = useCallback(async (
    mode: "armed" | "disarmed",
    reason: string,
    acknowledgeKill: boolean,
  ) => {
    try {
      const status = await setLiveControlMode(mode, reason, acknowledgeKill);
      setLiveControl(status);
      setNotice(
        mode === "armed"
          ? status.liveSubmitAvailable
            ? "Live control armed for pinned OKX Demo execution"
            : "Live control armed; no execution method is installed"
          : "Live control disarmed",
      );
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, []);

  const killLive = useCallback(async (reason: string) => {
    try {
      const status = await killLiveControl(reason);
      setLiveControl(status);
      setNotice("Global Live kill applied; credentials, accounts, and receipts were revoked");
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, []);

  const revokeLive = useCallback(async (
    scopeType: "grant" | "plugin" | "publisher" | "credential",
    subject: string,
    reason: string,
  ) => {
    try {
      const status = await revokeLiveAuthority(scopeType, subject, reason);
      setLiveControl(status);
      setNotice(`Live ${scopeType} authority revoked`);
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, []);

  const downloadLiveAudit = useCallback(async () => {
    try {
      const blob = await fetchLiveAuditExport();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "candlescope-live-audit.json";
        anchor.rel = "noopener";
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setNotice("Redacted Live audit export downloaded");
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, []);

  const submitLive = useCallback(async (
    accountRef: string,
    shadowRef: string,
    receipt: Parameters<typeof submitLiveExecution>[2],
  ) => {
    try {
      const execution = await submitLiveExecution(accountRef, shadowRef, receipt);
      setNotice("OKX Demo submit acknowledged; reconcile before any next action");
      await refresh();
      return execution;
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, [refresh]);

  const cancelLive = useCallback(async (
    accountRef: string,
    shadowRef: string,
    receipt: Parameters<typeof cancelLiveExecution>[2],
  ) => {
    try {
      const execution = await cancelLiveExecution(accountRef, shadowRef, receipt);
      setNotice("OKX Demo cancel acknowledged; reconcile final venue state");
      await refresh();
      return execution;
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, [refresh]);

  const reconcileLive = useCallback(async (
    accountRef: string,
    shadowRef: string,
  ) => {
    try {
      const execution = await reconcileLiveExecution(accountRef, shadowRef);
      setNotice(`OKX Demo execution reconciled: ${execution.state}`);
      return execution;
    } catch (caught) {
      setNotice(errorMessage(caught));
      throw caught;
    }
  }, []);

  return useMemo<PluginPlatformRuntime>(() => ({
    view: {
      catalog,
      marketplaceCatalog,
      snapshot,
      registries,
      loading,
      error,
      managementAvailable,
      managerOpen,
      paletteOpen,
      openViewId,
      openSettingsId,
      notice,
      liveControl,
      liveControlOpen,
      markerSource: markerSourceRef.current!,
      chartLayerSource: chartLayerSourceRef.current!,
      marketIdentity: { exchange, interval, marketType, symbol },
    },
    actions: {
      refresh,
      openManager,
      closeManager,
      openPalette: () => setPaletteOpen(true),
      closePalette: () => setPaletteOpen(false),
      openView: setOpenViewId,
      closeView: () => setOpenViewId(null),
      openSettings: setOpenSettingsId,
      closeSettings: () => setOpenSettingsId(null),
      clearNotice: () => setNotice(null),
      invokeCommand,
      readSettings: readPluginSettings,
      writeSettings: async (id, value) => {
        try {
          const saved = await writePluginSettings(id, value);
          setNotice("Plugin settings saved");
          return saved;
        } catch (caught) {
          setNotice(errorMessage(caught));
          throw caught;
        }
      },
      loadDetail: fetchPluginManagementDetail,
      loadMarketplaceStatus: fetchPluginMarketplaceStatus,
      refreshMarketplace: (marketplaceId) => withRefresh(
        () => refreshPluginMarketplace(marketplaceId),
        "Signed marketplace index refreshed",
      ),
      prepareMarketplaceRelease: (pluginId, version) => withRefresh(
        () => preparePluginMarketplaceRelease(pluginId, version),
        "Marketplace artifact downloaded, verified, and staged",
      ),
      applyMarketplaceRelease: (pluginId) => withRefresh(
        () => applyPluginMarketplaceRelease(pluginId),
        "Marketplace release applied as an inactive staged activation",
      ),
      activateMarketplaceRelease: (pluginId) => withRefresh(
        () => activatePluginMarketplaceRelease(pluginId),
        "Marketplace release activated and passed Host health observation",
      ),
      previewV1CompatibilityImport,
      applyV1CompatibilityImport: (previewSha256) => withRefresh(
        () => applyV1CompatibilityImport(previewSha256),
        "v1 script runtime registry imported into the compatibility catalog",
      ),
      previewV1CompatibilityRollback,
      applyV1CompatibilityRollback: (previewSha256) => withRefresh(
        () => applyV1CompatibilityRollback(previewSha256),
        "v1 compatibility catalog rolled back to the previewed snapshot",
      ),
      installBundle: (file) => withRefresh(
        () => installPluginBundle(file),
        "Plugin bundle installed",
      ),
      prepareLocalInstall: prepareLocalPluginInstall,
      reviewLocalInstall: reviewLocalPluginInstall,
      confirmLocalInstall: (candidateId, previewSha256, confirmationToken) => withRefresh(
        () => confirmLocalPluginInstall(candidateId, previewSha256, confirmationToken),
        "Plugin bundle installed after exact local-code confirmation",
      ),
      reviewTrustChange: reviewPluginTrustChange,
      confirmTrustChange: (pluginId, changeId, previewSha256, confirmationToken) => withRefresh(
        () => confirmPluginTrustChange(pluginId, changeId, previewSha256, confirmationToken),
        "Plugin trust mode changed and the previous runtime generation was revoked",
      ),
      stageUserFile: stagePluginUserFile,
      prepareUserFileSave: preparePluginUserFileSave,
      downloadUserFile: downloadPluginUserFile,
      changeState,
      decidePermission,
      setPaperKillSwitch: changePaperKillSwitch,
      openLiveControl: () => setLiveControlOpen(true),
      closeLiveControl: () => setLiveControlOpen(false),
      setLiveControlMode: changeLiveControlMode,
      killLiveControl: killLive,
      revokeLiveAuthority: revokeLive,
      previewLiveConfirmation: async (accountRef, shadowRef) => {
        try {
          return await previewLiveConfirmation(accountRef, shadowRef);
        } catch (caught) {
          setNotice(errorMessage(caught));
          throw caught;
        }
      },
      issueLiveConfirmation: async (accountRef, shadowRef, preview, ttlSeconds = 60) => {
        try {
          const receipt = await issueLiveConfirmation(accountRef, shadowRef, preview, ttlSeconds);
          setNotice(`Intent confirmation issued until ${receipt.expiresAt}`);
          await refresh();
          return receipt;
        } catch (caught) {
          setNotice(errorMessage(caught));
          throw caught;
        }
      },
      revokeLiveConfirmation: async (receiptRef, reason) => {
        try {
          await revokeLiveConfirmation(receiptRef, reason);
          setNotice("Live confirmation revoked");
          await refresh();
        } catch (caught) {
          setNotice(errorMessage(caught));
          throw caught;
        }
      },
      submitLiveExecution: submitLive,
      cancelLiveExecution: cancelLive,
      reconcileLiveExecution: reconcileLive,
      downloadLiveAudit,
    },
  }), [
    catalog,
    marketplaceCatalog,
    changeState,
    decidePermission,
    changePaperKillSwitch,
    error,
    exchange,
    interval,
    invokeCommand,
    loading,
    liveControl,
    liveControlOpen,
    managementAvailable,
    managerOpen,
    marketType,
    notice,
    openManager,
    closeManager,
    openSettingsId,
    openViewId,
    paletteOpen,
    refresh,
    registries,
    snapshot,
    symbol,
    withRefresh,
    changeLiveControlMode,
    killLive,
    revokeLive,
    submitLive,
    cancelLive,
    reconcileLive,
    downloadLiveAudit,
  ]);
}
