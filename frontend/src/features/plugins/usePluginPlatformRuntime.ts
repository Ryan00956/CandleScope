import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPluginCatalog,
  fetchPluginManagementDetail,
  fetchPluginUiSnapshot,
  invokePluginCommand,
  installPluginBundle,
  mutatePluginPermission,
  mutatePluginState,
  pluginManagementAvailable,
  readPluginSettings,
  writePluginSettings,
} from "./pluginPlatformApi.js";
import { PluginMarkerSource } from "./pluginMarkerSource.js";
import { buildPluginRegistries } from "./pluginRegistries.js";
import type {
  JsonValue,
  PluginCatalog,
  PluginMarketIdentity,
  PluginPlatformRuntime,
  PluginUiSnapshot,
} from "./pluginPlatformTypes.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin Platform operation failed";
}

export function usePluginPlatformRuntime(identity: PluginMarketIdentity): PluginPlatformRuntime {
  const { exchange, interval, marketType, symbol } = identity;
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [snapshot, setSnapshot] = useState<PluginUiSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openViewId, setOpenViewId] = useState<string | null>(null);
  const [openSettingsId, setOpenSettingsId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const managementAvailable = useMemo(() => pluginManagementAvailable(), []);
  const markerSourceRef = useRef<PluginMarkerSource | null>(null);
  const refreshSequenceRef = useRef(0);
  if (markerSourceRef.current === null) markerSourceRef.current = new PluginMarkerSource();

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const [nextCatalog, initialSnapshot] = await Promise.all([
        fetchPluginCatalog(),
        fetchPluginUiSnapshot(),
      ]);
      const nextSnapshot = initialSnapshot.registryRevision === nextCatalog.platform.registryRevision
        ? initialSnapshot
        : await fetchPluginUiSnapshot();
      if (nextSnapshot.registryRevision !== nextCatalog.platform.registryRevision) {
        throw new Error("Plugin catalog changed during refresh; retrying safely");
      }
      if (sequence !== refreshSequenceRef.current) return;
      setCatalog(nextCatalog);
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (caught) {
      if (sequence !== refreshSequenceRef.current) return;
      setCatalog(null);
      setSnapshot(null);
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

  return useMemo<PluginPlatformRuntime>(() => ({
    view: {
      catalog,
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
      installBundle: (file) => withRefresh(
        () => installPluginBundle(file),
        "Plugin bundle installed",
      ),
      changeState,
      decidePermission,
    },
  }), [
    catalog,
    changeState,
    decidePermission,
    error,
    exchange,
    interval,
    invokeCommand,
    loading,
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
  ]);
}
