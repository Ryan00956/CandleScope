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
  const managementAvailable = useMemo(() => pluginManagementAvailable(), []);
  const markerSourceRef = useRef<PluginMarkerSource | null>(null);
  const refreshSequenceRef = useRef(0);
  if (markerSourceRef.current === null) markerSourceRef.current = new PluginMarkerSource();

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const [nextCatalog, nextMarketplaceCatalog, initialSnapshot, nextLiveControl] = await Promise.all([
        fetchPluginCatalog(),
        fetchPluginMarketplaceCatalog(),
        fetchPluginUiSnapshot(),
        fetchPluginLiveControlStatus(),
      ]);
      const nextSnapshot = initialSnapshot.registryRevision === nextCatalog.platform.registryRevision
        ? initialSnapshot
        : await fetchPluginUiSnapshot();
      if (nextSnapshot.registryRevision !== nextCatalog.platform.registryRevision) {
        throw new Error("Plugin catalog changed during refresh; retrying safely");
      }
      if (sequence !== refreshSequenceRef.current) return;
      setCatalog(nextCatalog);
      setMarketplaceCatalog(nextMarketplaceCatalog);
      setSnapshot(nextSnapshot);
      setLiveControl(nextLiveControl);
      setError(null);
    } catch (caught) {
      if (sequence !== refreshSequenceRef.current) return;
      setCatalog(null);
      setMarketplaceCatalog(null);
      setSnapshot(null);
      setLiveControl((current) => (
        current.mode === "disabled" ? UNAVAILABLE_LIVE_CONTROL : { ...current, available: false, mode: "unavailable" }
      ));
      setError(errorMessage(caught));
      throw caught;
    } finally {
      if (sequence === refreshSequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        await refresh();
      } catch {
        // The fail-closed state is already published by refresh().
      } finally {
        polling = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    markerSourceRef.current?.update(snapshot?.chartLayers ?? [], { exchange, interval, marketType, symbol });
  }, [exchange, interval, marketType, snapshot?.chartLayers, symbol]);

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
      marketIdentity: { exchange, interval, marketType, symbol },
    },
    actions: {
      refresh,
      openManager: () => setManagerOpen(true),
      closeManager: () => setManagerOpen(false),
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
